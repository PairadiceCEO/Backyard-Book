// Re-prices bet legs at their source at bet time (never from the 30-second cache).
//
// Which market a leg refers to is decided by the server, not the browser: the server's own cached
// board says which Kalshi ticker/side backs a leg. Prices and lines are then fetched fresh:
//   custom game → its Firestore doc, closed once the server clock reaches the start time
//   Challenge   → its Firestore doc: open (admin-approved) and before its close time on the server clock
//   crypto      → the Kalshi market itself, fetched fresh (server/crypto.js priceCryptoLeg)
//   pre-game    → fresh ESPN odds; if ESPN doesn't price it, the board's Kalshi market, re-fetched
//   live        → the Kalshi market (re-fetched); if the board still held ESPN's pre-game line,
//                 the game's live Kalshi market is looked up fresh
//   final       → closed
// Which Kalshi events belong to a game comes from the board's mapping (playoff games by series game number).

import { adminDb } from './firebaseAdmin.js';
import { getLeague } from './leagues.js';
import { getOrRefresh } from './cache.js';
import { buildBoard, normalizeCustomGame } from './board.js';
import { fetchLeagueGames } from './sources/espn.js';
import {
  attachKalshiToGames,
  fetchLeagueKalshi,
  fetchMarket,
  mappedEventTicker,
  marketMatchesLeg,
  quoteFromMarket,
} from './sources/kalshi.js';
import { marketHasLine } from '../shared/betRules.js';
import { makeQuote } from '../shared/oddsMath.js';
import { CHALLENGE_LEAGUE, CHALLENGE_MARKET, challengeDocId, isChallengeLeg } from '../shared/challenges.js';
import { isCryptoLeg } from '../shared/crypto/coins.js';
import { priceCryptoLeg } from './crypto.js';

const BOARD_TTL_MS = 30 * 1000;

export function sameLine(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a === null || a === undefined) && (b === null || b === undefined);
  }
  return Math.abs(Number(a) - Number(b)) < 1e-9;
}

// Per-request memo so several legs on the same league or market share one fetch.
export function createPricingContext({ now = new Date(), fetchImpl = fetch, getBoard } = {}) {
  const memo = new Map();
  const once = (key, fn) => {
    if (!memo.has(key)) memo.set(key, fn());
    return memo.get(key);
  };

  const ctx = {
    now,
    board(leagueId) {
      return once(`board:${leagueId}`, async () => {
        if (getBoard) return getBoard(leagueId);
        const result = await getOrRefresh(`board_${leagueId}`, BOARD_TTL_MS, () => buildBoard(leagueId, { now, fetchImpl }));
        return result.value;
      });
    },
    freshEspnGames(leagueId) {
      return once(`espn:${leagueId}`, async () => {
        const league = getLeague(leagueId);
        const { games } = await fetchLeagueGames(league, { now, fetchImpl });
        return games;
      });
    },
    freshKalshiForGames(leagueId) {
      return once(`kalshiLeague:${leagueId}`, async () => {
        const league = getLeague(leagueId);
        const [games, kalshi] = await Promise.all([ctx.freshEspnGames(leagueId), fetchLeagueKalshi(league, { now, fetchImpl })]);
        return attachKalshiToGames({ league: leagueId, games, ...kalshi });
      });
    },
    market(ticker) {
      return once(`market:${ticker}`, () => fetchMarket(ticker, fetchImpl));
    },
    customGame(docId) {
      return once(`custom:${docId}`, async () => {
        const snap = await adminDb().collection('customGames').doc(docId).get();
        return snap.exists ? snap.data() : null;
      });
    },
    challenge(docId) {
      return once(`challenge:${docId}`, async () => {
        const snap = await adminDb().collection('challenges').doc(docId).get();
        return snap.exists ? snap.data() : null;
      });
    },
  };
  return ctx;
}

function closed(reason) {
  return { status: 'closed', reason };
}

function compare(leg, quote, game) {
  if (!quote) return closed('This market is no longer available.');
  if (marketHasLine(leg.marketType) && !sameLine(leg.line, quote.line)) {
    return { status: 'lineChanged', quote, game };
  }
  return { status: 'ok', quote, game };
}

async function kalshiFromBoardQuote(ctx, boardQuote, marketType) {
  const ref = boardQuote?.ref;
  if (!ref?.ticker || (ref.side !== 'yes' && ref.side !== 'no')) return null;
  const market = await ctx.market(ref.ticker);
  return quoteFromMarket(market, ref.side, marketType);
}

// leg: { league, gameId, marketType, selection, line }
// Returns { status: 'ok' | 'lineChanged', quote, game } or { status: 'closed', reason }.
function toMs(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// A Challenge outcome, priced from the Challenge doc. game carries what the stored leg needs.
async function priceChallengeLeg(leg, ctx) {
  const { league, gameId, marketType, selection } = leg;
  const data = await ctx.challenge(challengeDocId(gameId));
  if (!data || league !== CHALLENGE_LEAGUE || marketType !== CHALLENGE_MARKET) return closed('This Challenge no longer exists.');
  if (data.status === 'pending') return closed("This Challenge hasn't been approved yet.");
  if (data.status !== 'open') return closed('This Challenge is closed.');
  const closeMs = toMs(data.closeTime);
  if (closeMs === null || ctx.now.getTime() >= closeMs) return closed('Betting on this Challenge closed at its close time.');
  const outcome = (data.outcomes ?? []).find((o) => o.id === selection);
  if (!outcome) return closed('That outcome is no longer offered.');
  const quote = makeQuote(outcome.american, { source: 'challenge', ref: { provider: 'Challenge' } });
  if (!quote) return closed('That outcome has no price.');
  return {
    status: 'ok',
    quote,
    game: { kind: 'challenge', id: String(gameId), title: data.title, startTime: new Date(closeMs).toISOString(), outcomeLabel: outcome.label, posterUid: data.posterUid },
  };
}

export async function priceLeg(leg, ctx) {
  const { league, gameId, marketType, selection } = leg;
  if (isChallengeLeg(leg)) return priceChallengeLeg(leg, ctx);
  if (isCryptoLeg(leg)) return priceCryptoLeg(leg, ctx);

  if (String(gameId).startsWith('custom:')) {
    const docId = String(gameId).slice('custom:'.length);
    const data = await ctx.customGame(docId);
    if (!data || data.league !== league) return closed('This game no longer exists.');
    const game = normalizeCustomGame(docId, data, ctx.now);
    if (!game || game.bettingClosed) return closed('Betting on this game closed at its start time.');
    return compare(leg, game.markets[marketType]?.[selection] ?? null, game);
  }

  const fresh = (await ctx.freshEspnGames(league)).find((g) => g.id === String(gameId));
  if (!fresh) return closed('This game is no longer on the board.');
  if (fresh.state === 'post' || fresh.canceled) return closed('This game is over.');

  const board = await ctx.board(league);
  const boardGame = board?.games?.find((g) => g.id === String(gameId)) ?? null;
  const boardQuote = boardGame?.markets?.[marketType]?.[selection] ?? null;

  // Exact Kalshi market chosen by the player (main or alternate line). The server confirms the
  // ticker belongs to this game and side, then prices that market fresh.
  if (leg.kalshiTicker) {
    if (!marketMatchesLeg(boardGame?.kalshi, leg, leg.kalshiTicker, leg.kalshiSide)) {
      return closed('This line is not offered for this game.');
    }
    const market = await ctx.market(leg.kalshiTicker);
    // Belt and braces: the fresh market must report the same event the board mapped to this game.
    const expectedEvent = mappedEventTicker(boardGame.kalshi, marketType);
    if (market?.event_ticker && market.event_ticker !== expectedEvent) {
      return closed('This line is not offered for this game.');
    }
    const quote = quoteFromMarket(market, leg.kalshiSide, marketType);
    if (!quote) return closed('This line is no longer posted.');
    return compare(leg, quote, fresh);
  }

  if (fresh.state === 'pre') {
    const espnQuote = fresh.markets[marketType]?.[selection] ?? null;
    if (espnQuote) return compare(leg, espnQuote, fresh);
    if (boardQuote?.source === 'kalshi') {
      return compare(leg, await kalshiFromBoardQuote(ctx, boardQuote, marketType), fresh);
    }
    return closed('This market is no longer available.');
  }

  // Live game: Kalshi only.
  if (boardQuote?.source === 'kalshi') {
    return compare(leg, await kalshiFromBoardQuote(ctx, boardQuote, marketType), fresh);
  }
  const live = (await ctx.freshKalshiForGames(league)).get(fresh.id);
  const liveQuote = live?.[marketType]?.[selection] ?? null;
  if (!liveQuote) return closed('No live price for this market right now.');
  return compare(leg, liveQuote, fresh);
}
