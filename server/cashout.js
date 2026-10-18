// Sportsbook cash out: the server-side value of an open bet, and paying it.
//
// Value (cents, always rounded DOWN):
//   pre-game (no leg's game has started) → stake × 0.90
//   live     (any leg's game has started) → potential payout × P × 0.90
//   never    a bet with any custom-game, Challenge or crypto leg (shared/betRules.js cashoutEligible)
//     potential payout = stake × product of the decimals of every leg that hasn't pushed/voided
//     P = product of the Kalshi BID of every undecided leg (won legs count as 1)
// Unavailable when a leg lost, when every leg is decided (settlement pays it), when a leg's game
// ended without a gradable result, when an undecided leg of a live bet has no exact Kalshi market
// with a bid, when a custom-game leg has started, or when the bet isn't open.
// A live leg's bid only counts from a Kalshi market of the event the board maps to that game (playoff games
// by series game number) that has updated since the game started (stale-market guard).
//
// Quotes shown on My Bets may reuse ESPN/Kalshi answers for a few seconds; the confirmation
// (cashOutBet) always re-prices with fresh ESPN and Kalshi data, and pays in one transaction with a
// deterministic ledger id (cashout_{betId}) so a double-tap or retry can only pay once.

import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from './firebaseAdmin.js';
import { HttpError } from './http.js';
import { getLeague } from './leagues.js';
import { getOrRefresh } from './cache.js';
import { buildBoard, normalizeCustomGame } from './board.js';
import { gameKey, loadGameResults } from './gameResults.js';
import { decideBet, gradeLeg, resultFromCustomGame, resultFromEspnGame } from './grading.js';
import { fetchLeagueGames } from './sources/espn.js';
import { fetchEvent, fetchMarket, freshForLive, liveSinceMs, mappedEventTicker } from './sources/kalshi.js';
import { NO_CASHOUT_REASON, cashoutEligible, combinedDecimal, payoutCents } from '../shared/betRules.js';
import { challengeDocId, isChallengeLeg } from '../shared/challenges.js';
import { resultFromChallenge } from './challenges.js';

export const CASHOUT_NUMERATOR = 9n; // 0.90 = 9 / 10
export const CASHOUT_DENOMINATOR = 10n;
const BID_SCALE = 10000; // Kalshi dollar prices have at most 4 decimals ("0.4500")
const BOARD_TTL_MS = 30 * 1000;
const ESTIMATE_TTL_MS = 15 * 1000; // Kalshi answers reused by estimates (never by a confirmation)
const RESULT_TTL_MS = 60 * 1000; // ESPN scoreboard results reused by estimates
export const MAX_QUOTE_BETS = 50;

export const UNAVAILABLE_NOW = 'Cash out unavailable right now';
export const STALE_LIVE = 'Live prices unavailable, so cash out is closed for now.';

// ---------- pure helpers ----------

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isActive(market) {
  return market?.status === 'active' || market?.status === 'open';
}

// Kalshi's bid for one side of a market (yes_bid_dollars / no_bid_dollars), or null when the market
// isn't trading or nobody is bidding. Never derived from the other side's ask.
export function bidFromMarket(market, side) {
  if (!market || !isActive(market) || (side !== 'yes' && side !== 'no')) return null;
  const bid = num(side === 'yes' ? market.yes_bid_dollars : market.no_bid_dollars);
  if (bid === null || bid <= 0 || bid >= 1) return null;
  return bid;
}

function sameNumber(a, b) {
  return a !== null && b !== null && Math.abs(Number(a) - Number(b)) < 1e-9;
}

// Team code at the end of a market ticker: "KXNFLSPREAD-26OCT18HOUJAC-JAC3" → "JAC"
function codeOf(market, eventTicker) {
  return String(market?.ticker ?? '').slice(String(eventTicker).length + 1).replace(/\d+$/, '');
}

// The Kalshi market (and side) at exactly a DraftKings leg's game, market type, side and line.
//   moneyline  → the team's winner market YES, else the opponent's winner market NO
//   spread −N  → the team's "wins by over N" market YES
//   spread +N  → the opponent's "wins by over N" market NO
//   total N    → the "over N" market: over = YES, under = NO
// event: a Kalshi event with nested markets (fetchEvent); mapping: the board game's `kalshi` field.
// Returns { market, side } or null when Kalshi has no exact match.
export function findKalshiMatch(event, mapping, leg) {
  if (!event || !mapping) return null;
  const eventTicker = mappedEventTicker(mapping, leg.marketType);
  if (!eventTicker || event.event_ticker !== eventTicker) return null;
  const markets = (event.markets ?? []).filter((m) => String(m.ticker ?? '').startsWith(`${eventTicker}-`));
  const sideOf = (m) => mapping.sideByCode?.[codeOf(m, eventTicker)] ?? null;
  const line = leg.line === null || leg.line === undefined ? null : Number(leg.line);

  if (leg.marketType === 'moneyline') {
    const team = leg.selection;
    const other = team === 'home' ? 'away' : 'home';
    if (team !== 'home' && team !== 'away') return null;
    const own = markets.find((m) => sideOf(m) === team);
    if (own && bidFromMarket(own, 'yes') !== null) return { market: own, side: 'yes' };
    const opp = markets.find((m) => sideOf(m) === other);
    if (opp && bidFromMarket(opp, 'no') !== null) return { market: opp, side: 'no' };
    if (own) return { market: own, side: 'yes' };
    if (opp) return { market: opp, side: 'no' };
    return null;
  }

  if (leg.marketType === 'spread') {
    if (line === null || !Number.isFinite(line) || line === 0) return null;
    const team = leg.selection;
    if (team !== 'home' && team !== 'away') return null;
    const other = team === 'home' ? 'away' : 'home';
    const wantSide = line < 0 ? team : other; // whose "wins by over N" market this is
    const found = markets.find((m) => sideOf(m) === wantSide && sameNumber(num(m.floor_strike), Math.abs(line)));
    return found ? { market: found, side: line < 0 ? 'yes' : 'no' } : null;
  }

  if (leg.marketType === 'total') {
    if (line === null || !Number.isFinite(line)) return null;
    if (leg.selection !== 'over' && leg.selection !== 'under') return null;
    const found = markets.find((m) => sameNumber(num(m.floor_strike), line));
    return found ? { market: found, side: leg.selection === 'over' ? 'yes' : 'no' } : null;
  }

  return null;
}

// floor(cents × Π bids × 9/10), exact (BigInt), bids in dollars with up to 4 decimals.
export function liveValueCents(potentialCents, bids) {
  let numerator = BigInt(potentialCents) * CASHOUT_NUMERATOR;
  let denominator = CASHOUT_DENOMINATOR;
  for (const bid of bids) {
    numerator *= BigInt(Math.round(bid * BID_SCALE));
    denominator *= BigInt(BID_SCALE);
  }
  return Number(numerator / denominator);
}

export function pregameValueCents(stakeCents) {
  return Number((BigInt(stakeCents) * CASHOUT_NUMERATOR) / CASHOUT_DENOMINATOR);
}

function unavailable(reason, extra = {}) {
  return { available: false, valueCents: null, reason, ...extra };
}

// The cashout decision for one bet, given what is known about each leg (same order as bet.legs):
//   { grade: 'win' | 'loss' | 'push' | 'void' | 'pending', started: boolean,
//     blocked: string | null   — the leg's state couldn't be established (always unavailable)
//     bid: number | null       — Kalshi bid for an undecided leg (needed only once the bet is live)
//     noBid: string | null     — why there is no bid }
// Returns { available: true, valueCents, mode: 'pregame' | 'live', potentialCents, probability }
//      or { available: false, valueCents: null, reason }.
export function computeCashout(bet, states) {
  if (!bet || bet.status !== 'open') return unavailable('This bet is no longer open.');
  const legs = Array.isArray(bet.legs) ? bet.legs : [];
  if (legs.length === 0 || states.length !== legs.length) return unavailable(UNAVAILABLE_NOW);

  if (states.some((s) => s.grade === 'loss')) return unavailable('A leg of this bet lost.');
  const decision = decideBet(bet, states.map((s) => ({ result: s.grade })));
  if (decision.status !== 'open') return unavailable('This bet is settling now.');
  const blocked = states.find((s) => s.blocked);
  if (blocked) return unavailable(blocked.blocked);

  const stake = Number(bet.stakeCents) || 0;
  if (stake <= 0) return unavailable(UNAVAILABLE_NOW);

  // Pre-game: no leg's game has started (a postponed/canceled game never started).
  const live = states.some((s) => s.started && s.grade !== 'void');
  if (!live) {
    const valueCents = pregameValueCents(stake);
    if (valueCents < 1) return unavailable(UNAVAILABLE_NOW);
    return { available: true, valueCents, mode: 'pregame', potentialCents: Number(bet.potentialPayoutCents) || null, probability: null, reason: null };
  }

  const kept = legs.filter((_, i) => states[i].grade !== 'push' && states[i].grade !== 'void');
  const dropped = kept.length !== legs.length;
  const potentialCents =
    !dropped && Number.isInteger(bet.potentialPayoutCents)
      ? bet.potentialPayoutCents
      : payoutCents(stake, combinedDecimal(kept.map((l) => Number(l.decimalOdds))));

  const bids = [];
  for (const s of states) {
    if (s.grade !== 'pending') continue; // won = 1; push/void dropped above
    if (s.bid === null || s.bid === undefined) return unavailable(s.noBid || UNAVAILABLE_NOW);
    bids.push(s.bid);
  }

  const valueCents = liveValueCents(potentialCents, bids);
  if (valueCents < 1) return unavailable(UNAVAILABLE_NOW);
  const probability = bids.reduce((p, b) => p * b, 1);
  return { available: true, valueCents, mode: 'live', potentialCents, probability, reason: null };
}

// ---------- gathering leg states ----------

function toMs(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function graded(leg, result) {
  return gradeLeg(leg, result).result;
}

// Where a leg's game stands: { grade, started, blocked, custom }.
async function legGameState(leg, ctx) {
  if (leg.result && leg.result !== 'pending') {
    return { grade: leg.result, started: leg.result !== 'void', blocked: null };
  }

  const gameId = String(leg.gameId);
  // A Challenge: before its close time it's "pre-game"; after that there's no market price, so no cash out
  // until the admin settles it.
  if (isChallengeLeg(leg)) {
    const data = await ctx.challenge(challengeDocId(gameId));
    if (!data) return { grade: 'pending', started: false, blocked: 'This Challenge no longer exists.', custom: true, challenge: true };
    const result = resultFromChallenge(data);
    if (result.status === 'void') return { grade: 'void', started: false, blocked: null, custom: true, challenge: true };
    if (result.status === 'final') {
      const grade = graded(leg, result);
      return { grade, started: true, blocked: null, custom: true, challenge: true };
    }
    const closeMs = toMs(data.closeTime);
    const started = data.status !== 'open' || closeMs === null || ctx.now.getTime() >= closeMs;
    return { grade: 'pending', started, blocked: null, custom: true, challenge: true };
  }
  if (gameId.startsWith('custom:')) {
    const docId = gameId.slice('custom:'.length);
    const data = await ctx.customGame(docId);
    const game = data ? normalizeCustomGame(docId, data, ctx.now) : null;
    if (!game) return { grade: 'pending', started: false, blocked: 'This game no longer exists.', custom: true };
    if (game.state === 'pre') return { grade: 'pending', started: false, blocked: null, custom: true };
    if (game.state === 'in') return { grade: 'pending', started: true, blocked: null, custom: true };
    const grade = graded(leg, resultFromCustomGame(game));
    return { grade, started: grade !== 'void', blocked: grade === 'pending' ? 'Waiting for the final score.' : null, custom: true };
  }

  const game = await ctx.espnGame(leg.league, gameId);
  if (game) {
    const result = resultFromEspnGame(game);
    if (result.status === 'void') return { grade: 'void', started: false, blocked: null };
    if (game.state === 'pre') return { grade: 'pending', started: false, blocked: null };
    if (game.state === 'in') return { grade: 'pending', started: true, blocked: null, liveSince: liveSinceMs(game) };
    const grade = graded(leg, result);
    return { grade, started: true, blocked: grade === 'pending' ? 'Waiting for the final score.' : null };
  }

  // Not on the board / scoreboard window (e.g. yesterday's finished game): look the result up.
  const start = toMs(leg.startTime);
  if (start !== null && start > ctx.now.getTime()) return { grade: 'pending', started: false, blocked: null };
  const result = await ctx.gameResult(leg);
  if (result?.status === 'final' || result?.status === 'void') {
    const grade = graded(leg, result);
    return { grade, started: grade !== 'void', blocked: grade === 'pending' ? UNAVAILABLE_NOW : null };
  }
  return { grade: 'pending', started: true, blocked: UNAVAILABLE_NOW };
}

// Kalshi bid for an undecided leg: { bid, noBid }.
async function legBid(leg, state, ctx) {
  if (state.challenge) {
    return { bid: null, noBid: state.started ? 'Cash out closes when the Challenge closes.' : 'No live price for a Challenge in this bet.' };
  }
  if (state.custom) {
    return { bid: null, noBid: state.started ? 'Cash out closes once a custom game starts.' : 'No live price for a custom game in this bet.' };
  }

  const liveSince = state.liveSince ?? null;
  const mapping = await ctx.kalshiMapping(leg.league, String(leg.gameId));
  const eventTicker = mappedEventTicker(mapping, leg.marketType);
  if (!eventTicker) return { bid: null, noBid: 'No matching Kalshi market for this line.' };

  const ref = leg.sourceRef;
  if (ref?.ticker && (ref.side === 'yes' || ref.side === 'no')) {
    // Only a market of the event this game is mapped to now (never another game's event).
    if (!String(ref.ticker).startsWith(`${eventTicker}-`)) return { bid: null, noBid: 'No matching Kalshi market for this line.' };
    const market = await ctx.kalshiMarket(ref.ticker);
    if (market && !freshForLive(market, liveSince)) return { bid: null, noBid: STALE_LIVE };
    const bid = bidFromMarket(market, ref.side);
    return bid === null ? { bid: null, noBid: UNAVAILABLE_NOW } : { bid, noBid: null };
  }

  // A DraftKings line: the Kalshi market at the same line.
  const event = await ctx.kalshiEvent(eventTicker);
  const match = findKalshiMatch(event, mapping, leg);
  if (!match) return { bid: null, noBid: 'No matching Kalshi market for this line.' };
  if (!freshForLive(match.market, liveSince)) return { bid: null, noBid: STALE_LIVE };
  const bid = bidFromMarket(match.market, match.side);
  return bid === null ? { bid: null, noBid: UNAVAILABLE_NOW } : { bid, noBid: null };
}

// Full quote for a stored bet. ctx: see createCashoutContext.
// A bet with a custom-game, Challenge or crypto leg is never cashable: refused before anything is fetched.
export async function quoteCashout(bet, ctx) {
  if (!bet || bet.status !== 'open') return unavailable('This bet is no longer open.');
  if (!cashoutEligible(bet)) return unavailable(NO_CASHOUT_REASON);
  const legs = Array.isArray(bet.legs) ? bet.legs : [];
  let states;
  try {
    states = await Promise.all(legs.map((leg) => legGameState(leg, ctx)));
  } catch (err) {
    console.error('cashout: game state lookup failed:', err.message);
    return unavailable(UNAVAILABLE_NOW);
  }

  // Bids are only needed once the bet is live and nothing already rules cash out out.
  const live = states.some((s) => s.started && s.grade !== 'void');
  const ruledOut =
    states.some((s) => s.grade === 'loss' || s.blocked) || decideBet(bet, states.map((s) => ({ result: s.grade }))).status !== 'open';
  if (!live || ruledOut) return computeCashout(bet, states.map((s) => ({ ...s, bid: null, noBid: null })));

  try {
    const withBids = await Promise.all(
      states.map(async (s, i) => (s.grade === 'pending' ? { ...s, ...(await legBid(legs[i], s, ctx)) } : { ...s, bid: null, noBid: null })),
    );
    return computeCashout(bet, withBids);
  } catch (err) {
    console.error('cashout: Kalshi lookup failed:', err.message);
    return unavailable(UNAVAILABLE_NOW);
  }
}

// ---------- data access ----------

// Short-lived per-instance cache for estimates only.
const estimateCache = new Map(); // key → { at, promise }
function cached(key, ttlMs, nowMs, fn) {
  const hit = estimateCache.get(key);
  if (hit && nowMs - hit.at < ttlMs) return hit.promise;
  const promise = Promise.resolve()
    .then(fn)
    .catch((err) => {
      estimateCache.delete(key);
      throw err;
    });
  estimateCache.set(key, { at: nowMs, promise });
  if (estimateCache.size > 500) {
    for (const [k, v] of estimateCache) if (nowMs - v.at >= RESULT_TTL_MS) estimateCache.delete(k);
  }
  return promise;
}

export function clearEstimateCache() {
  estimateCache.clear();
}

// fresh=false (My Bets estimates): game states from the 30-second board, Kalshi answers reused for 15 s.
// fresh=true (confirmation): fresh ESPN scoreboards and fresh Kalshi markets, like bet placement.
// The board is still where a DraftKings leg's game → Kalshi event mapping comes from (which events
// belong to which game does not change); the prices in those events are always fetched.
export function createCashoutContext({ now = new Date(), fetchImpl = fetch, fresh = false, db = null, getBoard = null } = {}) {
  const memo = new Map();
  const once = (key, fn) => {
    if (!memo.has(key)) memo.set(key, Promise.resolve().then(fn));
    return memo.get(key);
  };
  const nowMs = now.getTime();
  const database = () => db ?? adminDb();

  const ctx = {
    now,
    fresh,
    board(leagueId) {
      return once(`board:${leagueId}`, async () => {
        if (getBoard) return getBoard(leagueId);
        if (!getLeague(leagueId)) return null;
        const result = await getOrRefresh(`board_${leagueId}`, BOARD_TTL_MS, () => buildBoard(leagueId, { now, fetchImpl }));
        return result.value;
      });
    },
    espnGames(leagueId) {
      return once(`espn:${leagueId}`, async () => {
        const league = getLeague(leagueId);
        if (!league) return [];
        if (!fresh) return (await ctx.board(leagueId))?.games?.filter((g) => g.source === 'espn') ?? [];
        const { games } = await fetchLeagueGames(league, { now, fetchImpl });
        return games;
      });
    },
    async espnGame(leagueId, gameId) {
      const games = await ctx.espnGames(leagueId);
      return games.find((g) => g.id === String(gameId)) ?? null;
    },
    gameResult(leg) {
      const key = gameKey(leg);
      const load = async () => (await loadGameResults([leg], { now, fetchImpl, db: database() })).get(key) ?? null;
      return once(`result:${key}`, () => (fresh ? load() : cached(`result:${key}`, RESULT_TTL_MS, nowMs, load)));
    },
    customGame(docId) {
      return once(`custom:${docId}`, async () => {
        const snap = await database().collection('customGames').doc(docId).get();
        return snap.exists ? snap.data() : null;
      });
    },
    challenge(docId) {
      return once(`challenge:${docId}`, async () => {
        const snap = await database().collection('challenges').doc(docId).get();
        return snap.exists ? snap.data() : null;
      });
    },
    async kalshiMapping(leagueId, gameId) {
      const board = await ctx.board(leagueId);
      return board?.games?.find((g) => g.id === String(gameId))?.kalshi ?? null;
    },
    kalshiMarket(ticker) {
      const load = () => fetchMarket(ticker, fetchImpl);
      return once(`market:${ticker}`, () => (fresh ? load() : cached(`market:${ticker}`, ESTIMATE_TTL_MS, nowMs, load)));
    },
    kalshiEvent(eventTicker) {
      const load = () => fetchEvent(eventTicker, fetchImpl);
      return once(`event:${eventTicker}`, () => (fresh ? load() : cached(`event:${eventTicker}`, ESTIMATE_TTL_MS, nowMs, load)));
    },
  };
  return ctx;
}

// ---------- API actions ----------

function publicQuote(quote) {
  return quote.available
    ? { available: true, valueCents: quote.valueCents, mode: quote.mode }
    : { available: false, valueCents: null, reason: quote.reason };
}

// action 'cashoutQuote' { betIds } → { quotes: { [betId]: { available, valueCents, mode | reason } } }
// Only the caller's own open bets are quoted; other ids are left out.
export async function quoteBets(caller, body, { now = new Date(), fetchImpl = fetch, makeContext = createCashoutContext } = {}) {
  const raw = Array.isArray(body.betIds) ? body.betIds : [];
  const ids = [...new Set(raw.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 200 && !id.includes('/')))].slice(0, MAX_QUOTE_BETS);
  if (ids.length === 0) return { ok: true, quotes: {} };

  const db = adminDb();
  const refs = ids.map((id) => db.collection('bets').doc(id));
  const snaps = typeof db.getAll === 'function' ? await db.getAll(...refs) : await Promise.all(refs.map((r) => r.get()));
  const ctx = makeContext({ now, fetchImpl, fresh: false, db });

  const quotes = {};
  await Promise.all(
    snaps.map(async (snap, i) => {
      if (!snap.exists) return;
      const bet = snap.data();
      if (bet.uid !== caller.uid || bet.status !== 'open') return;
      quotes[ids[i]] = publicQuote(await quoteCashout(bet, ctx));
    }),
  );
  return { ok: true, quotes };
}

function cashoutNote(bet) {
  if (bet.type === 'parlay') return `Cashed out: Parlay (${bet.legs.length} legs)`;
  return `Cashed out: ${bet.legs?.[0]?.label ?? 'bet'}`.slice(0, 200);
}

function serializeBet(id, data) {
  const iso = (v) => (v?.toDate ? v.toDate().toISOString() : v ?? null);
  return { id, ...data, placedAt: iso(data.placedAt), settledAt: iso(data.settledAt), cashedOutAt: iso(data.cashedOutAt) };
}

export function cashoutLedgerId(betId) {
  return `cashout_${betId}`;
}

// action 'cashout' { betId, expectedCents } → { ok, duplicate, cashoutCents, balanceCents, bet }
// 409 CASHOUT_CHANGED { valueCents } when the fresh value isn't the one the player confirmed;
// 409 CASHOUT_UNAVAILABLE { reason } when cash out isn't possible (lost, settling, no Kalshi bid, settled first…).
export async function cashOutBet(caller, body, { now = new Date(), fetchImpl = fetch, makeContext = createCashoutContext } = {}) {
  const betId = typeof body.betId === 'string' ? body.betId : '';
  if (!betId || betId.length > 200 || betId.includes('/')) throw new HttpError(400, 'BAD_REQUEST', 'Missing bet id.');
  const expectedCents = Number(body.expectedCents);
  if (!Number.isInteger(expectedCents) || expectedCents < 1) throw new HttpError(400, 'BAD_REQUEST', 'Missing the amount you confirmed.');

  const db = adminDb();
  const betRef = db.collection('bets').doc(betId);
  const userRef = db.collection('users').doc(caller.uid);
  const ledgerRef = db.collection('ledger').doc(cashoutLedgerId(betId));

  const alreadyDone = async (bet) => {
    const userSnap = await userRef.get();
    return { ok: true, duplicate: true, cashoutCents: Number(bet.cashoutCents) || 0, balanceCents: Number(userSnap.data()?.balanceCents) || 0, bet: serializeBet(betId, bet) };
  };

  const betSnap = await betRef.get();
  if (!betSnap.exists || betSnap.data().uid !== caller.uid) throw new HttpError(404, 'BET_NOT_FOUND', 'That bet does not exist.');
  const bet = betSnap.data();
  if (bet.status === 'cashed_out') return alreadyDone(bet);
  if (bet.status !== 'open') throw new HttpError(409, 'CASHOUT_UNAVAILABLE', 'This bet has already been settled.', { reason: 'This bet has already been settled.' });
  // Custom-game, Challenge and crypto legs: never, and nothing is fetched to say so.
  if (!cashoutEligible(bet)) throw new HttpError(409, 'CASHOUT_UNAVAILABLE', NO_CASHOUT_REASON, { reason: NO_CASHOUT_REASON });

  // Fresh prices, never the board cache.
  const quote = await quoteCashout(bet, makeContext({ now, fetchImpl, fresh: true, db }));
  if (!quote.available) throw new HttpError(409, 'CASHOUT_UNAVAILABLE', quote.reason, { reason: quote.reason });
  if (quote.valueCents !== expectedCents) {
    throw new HttpError(409, 'CASHOUT_CHANGED', `The cash out value changed to $${(quote.valueCents / 100).toFixed(2)}.`, {
      valueCents: quote.valueCents,
    });
  }
  const valueCents = quote.valueCents;
  const version = Number(bet.version) || 0;

  const outcome = await db.runTransaction(async (tx) => {
    const [fresh, userSnap, ledgerSnap] = await tx.getAll(betRef, userRef, ledgerRef);
    if (!fresh.exists) throw new HttpError(404, 'BET_NOT_FOUND', 'That bet does not exist.');
    const current = fresh.data();
    if (ledgerSnap.exists || current.status === 'cashed_out') return { duplicate: true, bet: current };
    if (current.status !== 'open') {
      throw new HttpError(409, 'CASHOUT_UNAVAILABLE', 'This bet was settled before the cash out went through.', {
        reason: 'This bet was settled before the cash out went through.',
      });
    }
    if ((Number(current.version) || 0) !== version) {
      throw new HttpError(409, 'CASHOUT_UNAVAILABLE', 'This bet just changed. Check it and try again.', { reason: 'This bet just changed. Check it and try again.' });
    }
    if (!userSnap.exists) throw new HttpError(403, 'NO_PROFILE', 'No player profile exists for this login.');

    const alreadyPaid = Number(current.payoutCents) || 0; // 0 for an open bet; kept for the shared money rule
    const delta = valueCents - alreadyPaid;
    const balanceAfter = (Number(userSnap.data().balanceCents) || 0) + delta;
    const at = Timestamp.fromDate(now);
    const update = {
      status: 'cashed_out',
      cashoutCents: valueCents,
      cashedOutAt: at,
      payoutCents: valueCents,
      settledAt: at,
      settledBy: 'cashout',
      version: version + 1,
      needsReview: false,
      reviewReason: null,
    };
    tx.update(betRef, update);
    tx.update(userRef, { balanceCents: balanceAfter });
    tx.create(ledgerRef, {
      uid: caller.uid,
      type: 'cashout',
      amountCents: delta,
      balanceAfterCents: balanceAfter,
      betId,
      note: cashoutNote(current),
      by: caller.uid,
      createdAt: at,
    });
    return { duplicate: false, balanceCents: balanceAfter, bet: { ...current, ...update } };
  });

  if (outcome.duplicate) return alreadyDone(outcome.bet);
  return { ok: true, duplicate: false, cashoutCents: valueCents, balanceCents: outcome.balanceCents, bet: serializeBet(betId, outcome.bet) };
}
