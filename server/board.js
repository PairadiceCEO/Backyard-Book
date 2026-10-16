// Builds one league's board: ESPN games + the admin's custom games, sorted by start time.

import { adminDb } from './firebaseAdmin.js';
import { getLeague } from './leagues.js';
import { emptyMarkets, fetchLeagueGames } from './sources/espn.js';
import { makeQuote } from '../shared/oddsMath.js';

const CUSTOM_FINAL_VISIBLE_MS = 24 * 60 * 60 * 1000; // finished custom games stay on the board for a day

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function customTeam(team, score) {
  return {
    id: null,
    name: team?.name || 'TBD',
    shortName: team?.name || 'TBD',
    location: null,
    abbr: team?.abbr || null,
    logo: team?.logoUrl || null,
    logoDark: null,
    score: Number.isFinite(score) ? score : null,
  };
}

function customMarkets(odds) {
  const markets = emptyMarkets();
  const ref = { provider: 'Custom' };
  markets.moneyline.home = makeQuote(odds?.moneyline?.home, { source: 'custom', ref });
  markets.moneyline.away = makeQuote(odds?.moneyline?.away, { source: 'custom', ref });
  const homeLine = Number(odds?.spread?.homeLine);
  if (Number.isFinite(homeLine)) {
    markets.spread.home = makeQuote(odds.spread.home, { line: homeLine, source: 'custom', ref });
    markets.spread.away = makeQuote(odds.spread.away, { line: -homeLine, source: 'custom', ref });
  }
  const totalLine = Number(odds?.total?.line);
  if (Number.isFinite(totalLine) && totalLine > 0) {
    markets.total.over = makeQuote(odds.total.over, { line: totalLine, source: 'custom', ref });
    markets.total.under = makeQuote(odds.total.under, { line: totalLine, source: 'custom', ref });
  }
  return markets;
}

// Betting on a custom game closes at its start time (server clock). No live betting.
export function normalizeCustomGame(id, data, now) {
  const start = toDate(data.startTime);
  if (!start) return null;
  const started = now.getTime() >= start.getTime();
  const status = data.status || 'scheduled';
  const isFinal = status === 'final';
  const isCanceled = status === 'canceled';

  let state = 'pre';
  let statusText = '';
  let markets = emptyMarkets();
  let oddsNote = null;

  if (isFinal) {
    state = 'post';
    statusText = 'Final';
  } else if (isCanceled) {
    state = 'post';
    statusText = 'Canceled';
  } else if (started) {
    state = 'in';
    statusText = 'In progress';
    oddsNote = 'Closed';
  } else {
    markets = customMarkets(data.odds);
    const anyQuote = Object.values(markets).some((sides) => Object.values(sides).some(Boolean));
    if (!anyQuote) oddsNote = 'Odds unavailable';
  }

  return {
    id: `custom:${id}`,
    league: data.league,
    source: 'custom',
    startTime: start.toISOString(),
    state,
    statusText,
    statusName: null,
    completed: isFinal,
    canceled: isCanceled,
    bettingClosed: state !== 'pre',
    home: customTeam(data.home, isFinal ? Number(data.finalScore?.home) : null),
    away: customTeam(data.away, isFinal ? Number(data.finalScore?.away) : null),
    markets,
    oddsProvider: state === 'pre' ? 'Custom' : null,
    oddsNote,
  };
}

async function loadCustomGames(leagueId, now) {
  const snap = await adminDb().collection('customGames').where('league', '==', leagueId).get();
  const games = [];
  snap.forEach((doc) => {
    const game = normalizeCustomGame(doc.id, doc.data(), now);
    if (!game) return;
    if (game.state === 'post' && now.getTime() - new Date(game.startTime).getTime() > CUSTOM_FINAL_VISIBLE_MS) return;
    games.push(game);
  });
  return games;
}

export function sortGames(games) {
  return [...games].sort((a, b) => {
    const diff = new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });
}

export async function buildBoard(leagueId, { now = new Date(), fetchImpl = fetch } = {}) {
  const league = getLeague(leagueId);
  if (!league) throw new Error(`Unknown league ${leagueId}`);

  const [espn, custom] = await Promise.all([
    fetchLeagueGames(league, { now, fetchImpl }),
    loadCustomGames(leagueId, now).catch((err) => {
      console.error(`custom games for ${leagueId} failed:`, err.message);
      return [];
    }),
  ]);

  return {
    games: sortGames([...espn.games, ...custom]),
    partial: espn.partial,
  };
}
