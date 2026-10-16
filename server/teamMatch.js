// Matches outside events (Kalshi, later SharpAPI) to ESPN games by date + team names,
// with team codes as a tie-breaker. Never relies on which team is listed first.

import { TEAM_ALIASES } from './teamAliases.js';
import { centralDateKey } from '../shared/time.js';

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

function dayNumber(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

// sides: [{ label, code }, { label, code }] from the outside event.
// Returns { game, sideOf: [ 'home'|'away', 'home'|'away' ] } or null if no confident match.
export function matchTeamsToGame(sides, dateKey, games, league) {
  if (!Array.isArray(sides) || sides.length !== 2) return null;
  const targetDay = dateKey ? dayNumber(dateKey) : null;

  let best = null;
  let bestScore = 0;
  let tie = false;

  for (const game of games) {
    if (targetDay !== null) {
      const gameDay = dayNumber(centralDateKey(game.startTime));
      if (Math.abs(gameDay - targetDay) > 1) continue;
    }
    const [a, b] = sides;
    const aHome = scoreTeam(a.label, a.code, game.home, league);
    const bAway = scoreTeam(b.label, b.code, game.away, league);
    const aAway = scoreTeam(a.label, a.code, game.away, league);
    const bHome = scoreTeam(b.label, b.code, game.home, league);

    const straight = aHome > 0 && bAway > 0 ? aHome + bAway : 0;
    const swapped = aAway > 0 && bHome > 0 ? aAway + bHome : 0;
    if (straight === 0 && swapped === 0) continue;
    if (straight === swapped) continue; // can't tell which team is which

    const score = Math.max(straight, swapped);
    const sideOf = straight > swapped ? ['home', 'away'] : ['away', 'home'];
    if (score > bestScore) {
      best = { game, sideOf };
      bestScore = score;
      tie = false;
    } else if (score === bestScore) {
      tie = true;
    }
  }

  return best && !tie ? best : null;
}
