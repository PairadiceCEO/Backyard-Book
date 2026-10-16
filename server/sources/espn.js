// ESPN public scoreboard: fetch and normalize games, scores and pre-game odds.

import { DAILY_OFFSETS } from '../leagues.js';
import { centralYmd } from '../../shared/time.js';
import { makeQuote, parseAmerican, parseLine } from '../../shared/oddsMath.js';

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const FETCH_TIMEOUT_MS = 8000;
const DEFAULT_PRICE = -110; // used when ESPN gives a spread/total line without a price

const CANCELED_STATUSES = new Set(['STATUS_POSTPONED', 'STATUS_CANCELED', 'STATUS_CANCELLED', 'STATUS_FORFEIT']);

export async function fetchEspnScoreboard(path, params = {}, fetchImpl = fetch) {
  const url = new URL(`${ESPN_BASE}/${path}/scoreboard`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const response = await fetchImpl(url.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`ESPN ${path} answered ${response.status}`);
  }
  return response.json();
}

// One game by id (settlement fallback when a game is missing from its date's scoreboard).
// Returns a scoreboard-shaped event { id, date, status, competitions } or null.
export async function fetchEspnSummaryEvent(path, eventId, fetchImpl = fetch) {
  const url = new URL(`${ESPN_BASE}/${path}/summary`);
  url.searchParams.set('event', String(eventId));
  const response = await fetchImpl(url.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`ESPN ${path} summary answered ${response.status}`);
  const data = await response.json();
  const competition = data?.header?.competitions?.[0];
  if (!competition) return null;
  const id = String(data.header.id ?? competition.id ?? '');
  if (id !== String(eventId)) return null; // only ever the exact event asked for
  return { id, date: competition.date, status: competition.status, competitions: [competition] };
}

export function emptyMarkets() {
  return {
    moneyline: { home: null, away: null },
    spread: { home: null, away: null },
    total: { over: null, under: null },
  };
}

// ESPN's nested odds give open / close (sometimes current) per side. "close" is the current line.
function latest(side) {
  if (!side || typeof side !== 'object') return null;
  return side.close ?? side.current ?? side.open ?? null;
}

function withDefaultPrice(price, line) {
  if (price !== null) return price;
  return line !== null ? DEFAULT_PRICE : null;
}

// Returns normalized pre-game markets from competitions[0].odds[0], or null if it has none.
export function normalizeEspnOdds(odds) {
  if (!odds || typeof odds !== 'object') return null;
  const provider = odds.provider?.name || 'ESPN';
  const ref = { provider };
  const markets = emptyMarkets();

  // Moneyline: nested first, then flat fields.
  const mlHome = parseAmerican(latest(odds.moneyline?.home)?.odds) ?? parseAmerican(odds.homeTeamOdds?.moneyLine);
  const mlAway = parseAmerican(latest(odds.moneyline?.away)?.odds) ?? parseAmerican(odds.awayTeamOdds?.moneyLine);
  markets.moneyline.home = makeQuote(mlHome, { source: 'espn', ref });
  markets.moneyline.away = makeQuote(mlAway, { source: 'espn', ref });

  // Spread: lines are from each team's own point of view (home -2.5 / away +2.5).
  const spHome = latest(odds.pointSpread?.home);
  const spAway = latest(odds.pointSpread?.away);
  let homeLine = parseLine(spHome?.line);
  let awayLine = parseLine(spAway?.line);
  let homeSpreadPrice = parseAmerican(spHome?.odds);
  let awaySpreadPrice = parseAmerican(spAway?.odds);
  if (homeLine === null && awayLine === null) {
    // Flat fallback: "spread" is home-relative.
    homeLine = parseLine(odds.spread);
    homeSpreadPrice = parseAmerican(odds.homeTeamOdds?.spreadOdds);
    awaySpreadPrice = parseAmerican(odds.awayTeamOdds?.spreadOdds);
  }
  if (homeLine === null && awayLine !== null) homeLine = -awayLine;
  if (awayLine === null && homeLine !== null) awayLine = -homeLine;
  if (homeLine !== null) {
    markets.spread.home = makeQuote(withDefaultPrice(homeSpreadPrice, homeLine), { line: homeLine, source: 'espn', ref });
    markets.spread.away = makeQuote(withDefaultPrice(awaySpreadPrice, awayLine), { line: awayLine, source: 'espn', ref });
  }

  // Total: nested over/under first, then flat overUnder.
  const over = latest(odds.total?.over);
  const under = latest(odds.total?.under);
  let totalLine = parseLine(over?.line) ?? parseLine(under?.line);
  let overPrice = parseAmerican(over?.odds);
  let underPrice = parseAmerican(under?.odds);
  if (totalLine === null) {
    totalLine = parseLine(odds.overUnder);
    overPrice = parseAmerican(odds.overOdds);
    underPrice = parseAmerican(odds.underOdds);
  }
  if (totalLine !== null && totalLine > 0) {
    markets.total.over = makeQuote(withDefaultPrice(overPrice, totalLine), { line: totalLine, source: 'espn', ref });
    markets.total.under = makeQuote(withDefaultPrice(underPrice, totalLine), { line: totalLine, source: 'espn', ref });
  }

  return { provider, markets };
}

export function hasAnyQuote(markets) {
  return Object.values(markets).some((sides) => Object.values(sides).some((q) => q !== null));
}

function normalizeTeam(competitor, state) {
  const team = competitor?.team ?? {};
  const rawScore = competitor?.score;
  const score = state === 'pre' || rawScore === undefined || rawScore === null || rawScore === '' ? null : Number(rawScore);
  return {
    id: team.id ? String(team.id) : null,
    name: team.displayName || team.name || 'TBD',
    shortName: team.shortDisplayName || team.displayName || team.name || 'TBD',
    nickname: team.name || null,
    location: team.location || null,
    abbr: team.abbreviation || null,
    logo: team.logo || null,
    logoDark: team.logoDark || null,
    score: Number.isFinite(score) ? score : null,
  };
}

export function normalizeEspnEvent(event, leagueId) {
  const competition = event?.competitions?.[0];
  if (!competition) return null;
  const competitors = competition.competitors ?? [];
  const homeC = competitors.find((c) => c.homeAway === 'home');
  const awayC = competitors.find((c) => c.homeAway === 'away');
  if (!homeC || !awayC) return null;

  const statusType = event.status?.type ?? competition.status?.type ?? {};
  const state = ['pre', 'in', 'post'].includes(statusType.state) ? statusType.state : 'pre';
  const statusName = statusType.name || null;
  const canceled = CANCELED_STATUSES.has(statusName);
  const start = new Date(event.date ?? competition.date);
  if (Number.isNaN(start.getTime())) return null;

  let markets = emptyMarkets();
  let oddsProvider = null;
  let oddsNote = null;
  if (state === 'pre' && !canceled) {
    const parsed = normalizeEspnOdds(competition.odds?.[0]);
    if (parsed && hasAnyQuote(parsed.markets)) {
      markets = parsed.markets;
      oddsProvider = parsed.provider;
    } else {
      oddsNote = 'Odds unavailable';
    }
  } else if (state === 'in') {
    oddsNote = 'Live prices unavailable'; // board.js replaces this when Kalshi has live prices
  }

  return {
    id: String(event.id),
    league: leagueId,
    source: 'espn',
    startTime: start.toISOString(),
    state,
    statusText: statusType.shortDetail || statusType.detail || statusType.description || '',
    statusName,
    completed: statusType.completed === true,
    canceled,
    bettingClosed: state !== 'pre' || canceled,
    home: normalizeTeam(homeC, state),
    away: normalizeTeam(awayC, state),
    markets,
    oddsProvider,
    oddsNote,
  };
}

// All games for a league's board. Daily leagues merge yesterday (unfinished games only) through +2 days.
export async function fetchLeagueGames(league, { now = new Date(), fetchImpl = fetch } = {}) {
  if (league.schedule !== 'daily') {
    const data = await fetchEspnScoreboard(league.espnPath, league.espnParams, fetchImpl);
    const games = (data.events ?? []).map((e) => normalizeEspnEvent(e, league.id)).filter(Boolean);
    return { games, partial: false };
  }

  const requests = DAILY_OFFSETS.map((offset) => ({ offset, dates: centralYmd(offset, now) }));
  const results = await Promise.allSettled(
    requests.map((r) => fetchEspnScoreboard(league.espnPath, { ...league.espnParams, dates: r.dates }, fetchImpl)),
  );

  if (results.every((r) => r.status === 'rejected')) {
    throw results[0].reason;
  }

  const byId = new Map();
  results.forEach((result, i) => {
    if (result.status !== 'fulfilled') {
      console.error(`ESPN ${league.id} dates=${requests[i].dates} failed:`, result.reason?.message);
      return;
    }
    const isYesterday = requests[i].offset < 0;
    for (const event of result.value.events ?? []) {
      const game = normalizeEspnEvent(event, league.id);
      if (!game) continue;
      if (isYesterday && game.state === 'post') continue; // yesterday's finished games drop off
      if (!byId.has(game.id)) byId.set(game.id, game);
    }
  });

  return {
    games: [...byId.values()],
    partial: results.some((r) => r.status === 'rejected'),
  };
}
