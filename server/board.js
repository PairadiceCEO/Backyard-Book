// Builds one league's board: ESPN games priced from ESPN and Kalshi, sorted by start time.
// The admin's custom games (every league) have their own board, the Sportsbook's "Custom" tab:
// buildCustomBoard(), cached as CUSTOM_BOARD_KEY.
//
// Price order per market:
//   pre-game → ESPN line, else Kalshi main strike
//   live     → Kalshi only (never ESPN's stale pre-game line)
//   final    → none

import { adminDb } from './firebaseAdmin.js';
import { getOrRefresh } from './cache.js';
import { getLeague } from './leagues.js';
import { LEAGUES } from '../shared/constants.js';
import { emptyMarkets, fetchLeagueGames } from './sources/espn.js';
import {
  buildKalshiMarkets,
  compactAlternates,
  fetchLeagueKalshi,
  kalshiMapping,
  matchKalshiEntries,
} from './sources/kalshi.js';

// The board cache document must stay well under Firestore's 1 MiB limit. If the alternate-line
// copy would push it past this, it is left out and the game page fetches per game instead.
export const MAX_BOARD_DOC_BYTES = 800 * 1024;
import { makeQuote } from '../shared/oddsMath.js';

const MARKET_KEYS = ['moneyline', 'spread', 'total'];

function marketHasQuote(sides) {
  return Object.values(sides).some((q) => q !== null);
}

function anyQuote(markets) {
  return MARKET_KEYS.some((key) => marketHasQuote(markets[key]));
}

// Applies the price order to one ESPN game. kalshiMarkets may be undefined. For a game in progress they were
// built with the stale-market guard (buildKalshiMarkets: no market older than the start).
export function mergeGameMarkets(game, kalshiMarkets) {
  if (game.source !== 'espn') return game;
  if (game.state === 'post' || game.canceled) {
    return { ...game, markets: emptyMarkets(), oddsNote: null };
  }

  const markets = emptyMarkets();
  if (game.state === 'pre') {
    for (const key of MARKET_KEYS) {
      if (marketHasQuote(game.markets[key])) markets[key] = game.markets[key];
      else if (kalshiMarkets && marketHasQuote(kalshiMarkets[key])) markets[key] = kalshiMarkets[key];
    }
  } else if (kalshiMarkets) {
    for (const key of MARKET_KEYS) markets[key] = kalshiMarkets[key];
  }

  let oddsNote = null;
  if (!anyQuote(markets)) oddsNote = game.state === 'in' ? 'Live prices unavailable' : 'Odds unavailable';
  // Live game with some markets priced and others not (e.g. a market that hasn't updated since the start).
  const someMissing = MARKET_KEYS.some((key) => Object.values(markets[key]).some((q) => q === null));
  const partialNote = game.state === 'in' && !oddsNote && someMissing ? 'Some live prices unavailable' : null;

  return { ...game, markets, oddsNote, partialNote };
}

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

// A blank line (null / '') means the market isn't offered; Number(null) would wrongly be 0.
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function customMarkets(odds) {
  const markets = emptyMarkets();
  const ref = { provider: 'Custom' };
  markets.moneyline.home = makeQuote(odds?.moneyline?.home, { source: 'custom', ref });
  markets.moneyline.away = makeQuote(odds?.moneyline?.away, { source: 'custom', ref });
  const homeLine = numberOrNull(odds?.spread?.homeLine);
  if (homeLine !== null) {
    markets.spread.home = makeQuote(odds.spread.home, { line: homeLine, source: 'custom', ref });
    markets.spread.away = makeQuote(odds.spread.away, { line: -homeLine, source: 'custom', ref });
  }
  const totalLine = numberOrNull(odds?.total?.line);
  if (totalLine !== null && totalLine > 0) {
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
    // The admin's change log (who, what, when), shown on the game's page.
    edits: (Array.isArray(data.edits) ? data.edits : []).map((e) => ({ byName: e.byName ?? 'Admin', what: e.what ?? '', at: toDate(e.at)?.toISOString() ?? null })),
  };
}

export const CUSTOM_BOARD_ID = 'custom';
export const CUSTOM_BOARD_KEY = 'board_custom';

async function loadCustomGames(now) {
  const snap = await adminDb().collection('customGames').get();
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

  const [espn, kalshi] = await Promise.all([
    fetchLeagueGames(league, { now, fetchImpl }),
    fetchLeagueKalshi(league, { now, fetchImpl }).catch((err) => {
      console.error(`Kalshi for ${leagueId} failed:`, err.message);
      return { gameEvents: [], spreadEvents: [], totalEvents: [], status: 'failed' };
    }),
  ]);

  const entries = matchKalshiEntries({
    league: leagueId,
    games: espn.games,
    gameEvents: kalshi.gameEvents,
    spreadEvents: kalshi.spreadEvents,
    totalEvents: kalshi.totalEvents,
  });

  const alts = {};
  const espnGames = espn.games.map((game) => {
    const entry = entries.get(game.id);
    const merged = mergeGameMarkets(game, entry ? buildKalshiMarkets(entry) : undefined);
    if (!entry) return { ...merged, kalshi: null };
    const compact = compactAlternates(entry);
    if (compact) alts[game.id] = compact;
    return { ...merged, kalshi: kalshiMapping(entry) };
  });

  const board = {
    games: sortGames(espnGames),
    partial: espn.partial,
    kalshiStatus: kalshi.status,
    alts,
    altsDropped: false,
  };

  // Size guard: drop the alternate-line copy rather than risk a Firestore write failure.
  if (Buffer.byteLength(JSON.stringify(board)) > MAX_BOARD_DOC_BYTES) {
    console.error(`board ${leagueId}: alternates left out of the cache (too large); game pages will fetch per game`);
    board.alts = {};
    board.altsDropped = true;
  }

  return board;
}

const BOARD_TTL_MS = 30 * 1000;
// The Live tab re-reads a league whose cached board shows nothing live or about to start at most every 5 minutes,
// so an open Live tab doesn't rebuild (and rewrite to Firestore) five boards every 30 seconds (Spark quota).
const LIVE_IDLE_TTL_MS = 5 * 60 * 1000;

// ---------- What the board tabs list ----------
// The cache keeps every game (settlement, pricing and game pages need finished ones too); the board tabs
// list only games that haven't finished: no ESPN game that is final, canceled or postponed, and no custom game
// that is final or canceled.
export function isListedGame(game) {
  if (!game) return false;
  if (game.state === 'post' || game.canceled) return false;
  return true;
}

export function listedGames(games) {
  return (games ?? []).filter(isListedGame);
}

export const LIVE_BOARD_ID = 'live';

// The Live tab: every ESPN game in progress across the leagues, in the app's league order, each league by start
// time. Built from the leagues' cached boards (getBoardResult(leagueId) → getOrRefresh result), so it adds no
// ESPN or Kalshi requests of its own. A league that can't be loaded is skipped and the board marked partial.
export async function buildLiveBoard(leagueIds, getBoardResult) {
  const results = await Promise.allSettled(leagueIds.map((id) => getBoardResult(id)));
  const games = [];
  let fetchedAtMs = null;
  let stale = false;
  let partial = false;
  let kalshiFailed = false;
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value?.value) {
      partial = true;
      if (r.status === 'rejected') console.error(`live board: ${leagueIds[i]} failed:`, r.reason?.message);
      return;
    }
    const { value, fetchedAtMs: at, stale: wasStale } = r.value;
    if (wasStale) stale = true;
    if (value.partial) partial = true;
    if (value.kalshiStatus === 'failed') kalshiFailed = true;
    if (Number.isFinite(at)) fetchedAtMs = fetchedAtMs === null ? at : Math.min(fetchedAtMs, at);
    const live = (value.games ?? []).filter((g) => g.source === 'espn' && g.state === 'in' && !g.canceled);
    for (const g of sortGames(live)) games.push({ ...g, league: g.league || leagueIds[i] });
  });
  return { games, fetchedAtMs: fetchedAtMs ?? Date.now(), stale, partial, kalshiStatus: kalshiFailed ? 'failed' : 'ok' };
}

function hasLiveOrStarting(board, nowMs) {
  return (board?.games ?? []).some(
    (g) => g.source === 'espn' && !g.canceled && (g.state === 'in' || (g.state === 'pre' && Date.parse(g.startTime) <= nowMs + BOARD_TTL_MS)),
  );
}

// One league's cached board for the Live tab: the 30-second board when it has a game in progress or starting now,
// otherwise any copy up to 5 minutes old. Same cache key as the league tab, so it never fetches anything extra.
export async function liveLeagueBoard(leagueId, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const build = () => buildBoard(leagueId, { now: new Date(nowMs), fetchImpl });
  const relaxed = await getOrRefresh(`board_${leagueId}`, LIVE_IDLE_TTL_MS, build, { now: () => nowMs });
  if (!hasLiveOrStarting(relaxed.value, nowMs)) return relaxed;
  return getOrRefresh(`board_${leagueId}`, BOARD_TTL_MS, build, { now: () => nowMs });
}

export async function getLiveBoard({ nowMs = Date.now(), fetchImpl = fetch } = {}) {
  return buildLiveBoard(
    LEAGUES.map((l) => l.id),
    (id) => liveLeagueBoard(id, { nowMs, fetchImpl }),
  );
}

// The Custom tab: every league's custom games (finished ones stay a day), priced from their docs.
export async function buildCustomBoard({ now = new Date() } = {}) {
  const games = await loadCustomGames(now);
  return { games: sortGames(games), partial: false, kalshiStatus: 'ok', alts: {}, altsDropped: false };
}
