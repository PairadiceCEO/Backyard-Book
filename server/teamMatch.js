// Matches outside events (Kalshi, later SharpAPI) to ESPN games by date + team names,
// with team codes as a tie-breaker. Never relies on which team is listed first.

import { TEAM_ALIASES } from './teamAliases.js';

export function normalizeName(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => (w === 'st' ? 'state' : w));
  return words.join(' ');
}

function normalizeCode(code) {
  return String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function containsPhrase(haystack, needle) {
  if (!haystack || !needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

// How well a Kalshi label (and optional team code) fits an ESPN team. 0 = no match.
export function scoreTeam(label, code, team, league) {
  const n = normalizeName(label);
  let score = 0;

  const alias = TEAM_ALIASES[league]?.[n];
  if (alias && team.abbr && normalizeCode(alias) === normalizeCode(team.abbr)) score += 5;

  const display = normalizeName(team.name);
  const nickname = normalizeName(team.nickname);
  const location = normalizeName(team.location);
  const short = normalizeName(team.shortName);

  if (n && n === display) score += 4;
  else if (n && (n === location || n === short)) score += 3;
  else if (nickname.length >= 3 && containsPhrase(n, nickname)) score += 3;
  else if (location.length >= 4 && (containsPhrase(n, location) || containsPhrase(location, n))) score += 2;
  else if (short.length >= 4 && (containsPhrase(n, short) || containsPhrase(short, n))) score += 2;

  if (code && team.abbr && normalizeCode(code) === normalizeCode(team.abbr)) score += 1;
  return score;
}

// ---------- Dates ----------
// An outside event's ticker carries a calendar date (and, for MLB, an Eastern start time).
// The provider may date a late game by its own clock, so a ticker date is accepted when it equals the
// game's local date in any US time zone (or UTC). That covers late games that cross midnight somewhere,
// but never reaches back a whole day: yesterday's game in a series can't match tonight's.
const MATCH_TIME_ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Pacific/Honolulu', 'UTC'];
const EXACT_TIME_ZONES = new Set(['America/New_York', 'America/Chicago']);
const MINUTE_MS = 60 * 1000;
const FALLBACK_PENALTY = 100000; // any exact-date event beats any fallback-date event

const formatters = new Map();
function zoneParts(instantMs, timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, fmt);
  }
  const parts = {};
  for (const p of fmt.formatToParts(new Date(instantMs))) parts[p.type] = p.value;
  return parts;
}

function zoneDateKey(instantMs, timeZone) {
  const p = zoneParts(instantMs, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

// "2026-10-16" + "1810" read as Eastern Time → UTC milliseconds.
export function easternInstant(dateKey, hhmm) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const hh = Number(hhmm.slice(0, 2));
  const mm = Number(hhmm.slice(2, 4));
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const p = zoneParts(guess, 'America/New_York');
  const asIfUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return guess - (asIfUtc - guess);
}

// How far an outside event (ticker date + optional HHMM) is from an ESPN game's start. Lower is closer.
// null = the dates can't be the same game. Exact date (Eastern or Central) always beats the fallback;
// the HHMM, when present, breaks ties by start-time difference in minutes.
export function eventDistance(when, startTime) {
  const dateKey = typeof when === 'string' ? when : when?.dateKey;
  const hhmm = typeof when === 'string' ? null : when?.hhmm ?? null;
  const start = new Date(startTime).getTime();
  if (!dateKey || !Number.isFinite(start)) return null;

  let exact = false;
  let compatible = false;
  for (const zone of MATCH_TIME_ZONES) {
    if (zoneDateKey(start, zone) === dateKey) {
      compatible = true;
      if (EXACT_TIME_ZONES.has(zone)) exact = true;
    }
  }
  if (!compatible) return null;

  const minutes = hhmm && /^\d{4}$/.test(hhmm) ? Math.round(Math.abs(easternInstant(dateKey, hhmm) - start) / MINUTE_MS) : 0;
  return (exact ? 0 : FALLBACK_PENALTY) + Math.min(minutes, FALLBACK_PENALTY - 1);
}

// ---------- Teams ----------

// How two outside sides line up with one ESPN game. null when either team doesn't fit or it can't tell
// which team is which. sideOf[i] is 'home' | 'away' for sides[i].
export function pairTeams(sides, game, league) {
  if (!Array.isArray(sides) || sides.length !== 2) return null;
  const [a, b] = sides;
  const aHome = scoreTeam(a.label, a.code, game.home, league);
  const bAway = scoreTeam(b.label, b.code, game.away, league);
  const aAway = scoreTeam(a.label, a.code, game.away, league);
  const bHome = scoreTeam(b.label, b.code, game.home, league);

  const straight = aHome > 0 && bAway > 0 ? aHome + bAway : 0;
  const swapped = aAway > 0 && bHome > 0 ? aAway + bHome : 0;
  if (straight === 0 && swapped === 0) return null;
  if (straight === swapped) return null; // can't tell which team is which
  return {
    score: Math.max(straight, swapped),
    sideOf: straight > swapped ? ['home', 'away'] : ['away', 'home'],
  };
}

// sides: [{ label, code }, { label, code }] from the outside event.
// when: "YYYY-MM-DD" or { dateKey, hhmm } from the event ticker.
// Picks the game whose teams fit best; among equally good fits (the same two teams on different days,
// a doubleheader) the closest one by date, then start time. Returns { game, sideOf, distance } or null
// when nothing fits or two games are exactly as close.
export function matchTeamsToGame(sides, when, games, league) {
  if (!Array.isArray(sides) || sides.length !== 2) return null;

  let best = null;
  let tie = false;
  for (const game of games) {
    const distance = eventDistance(when, game.startTime);
    if (distance === null) continue;
    const pair = pairTeams(sides, game, league);
    if (!pair) continue;
    const candidate = { game, sideOf: pair.sideOf, score: pair.score, distance };
    if (!best || candidate.score > best.score || (candidate.score === best.score && candidate.distance < best.distance)) {
      best = candidate;
      tie = false;
    } else if (candidate.score === best.score && candidate.distance === best.distance) {
      tie = true;
    }
  }
  if (!best || tie) return null;
  return { game: best.game, sideOf: best.sideOf, distance: best.distance };
}
