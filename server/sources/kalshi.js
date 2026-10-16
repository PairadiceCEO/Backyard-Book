// Kalshi public market data: fetch GAME / SPREAD / TOTAL events, match them to ESPN games,
// and turn prices (dollars = implied probability) into board quotes.

import { centralDateKey } from '../../shared/time.js';
import { makeQuote, probabilityToAmerican } from '../../shared/oddsMath.js';
import { matchTeamsToGame, scoreTeam } from '../teamMatch.js';

export const KALSHI_BASES = [
  'https://external-api.kalshi.com/trade-api/v2',
  'https://api.elections.kalshi.com/trade-api/v2',
];

const FETCH_TIMEOUT_MS = 8000;
const PAGE_LIMIT = 200;
const MAX_PAGES = 10;
const WINDOW_PAST_DAYS = 1;
const WINDOW_FUTURE_DAYS = 7;

// A Kalshi price is offered on the board only if it passes all three checks.
export const MIN_PRICE = 0.03;
export const MAX_PRICE = 0.97;
export const MAX_BID_ASK_GAP = 0.15;

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

async function kalshiGet(path, params, fetchImpl) {
  let lastError = null;
  for (const base of KALSHI_BASES) {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    try {
      const response = await fetchImpl(url.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.ok) return response.json();
      lastError = new Error(`Kalshi ${path} answered ${response.status}`);
      if (response.status < 500 && response.status !== 429) break; // a 4xx won't improve on the other host
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error(`Kalshi ${path} failed`);
}

// "KXNBAGAME-26OCT16BOSPHI" → { series, dateKey: "2026-10-16", hhmm: null, suffix: "26OCT16BOSPHI" }
// "KXMLBGAME-26OCT161800TBCLE" → { ..., hhmm: "1800", suffix: "26OCT161800TBCLE" }
export function parseEventTicker(eventTicker) {
  const match = /^([A-Z0-9]+)-((\d{2})([A-Z]{3})(\d{2})(\d{4})?([A-Z0-9]*))$/.exec(String(eventTicker ?? ''));
  if (!match) return null;
  const [, series, suffix, yy, mon, dd, hhmm] = match;
  const month = MONTHS[mon];
  if (!month) return null;
  const dateKey = `20${yy}-${String(month).padStart(2, '0')}-${dd}`;
  return { series, suffix, dateKey, hhmm: hhmm ?? null };
}

function dayNumber(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

function inWindow(dateKey, now) {
  const today = dayNumber(centralDateKey(now));
  const day = dayNumber(dateKey);
  return day >= today - WINDOW_PAST_DAYS && day <= today + WINDOW_FUTURE_DAYS;
}

// Fetches open events for one series and keeps current ones.
// min_close_ts makes Kalshi skip events whose markets have all closed. Game markets close about
// two days after the game, so this drops the old backlog while keeping live and upcoming games;
// in practice one page is enough. The cursor loop and date window stay as a safety net.
export async function fetchSeriesEvents(seriesTicker, { now = new Date(), fetchImpl = fetch } = {}) {
  const kept = [];
  const minCloseTs = Math.floor(now.getTime() / 1000);
  let cursor = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await kalshiGet(
      '/events',
      {
        series_ticker: seriesTicker,
        status: 'open',
        with_nested_markets: 'true',
        min_close_ts: minCloseTs,
        limit: PAGE_LIMIT,
        cursor,
      },
      fetchImpl,
    );
    for (const event of data.events ?? []) {
      const parsed = parseEventTicker(event.event_ticker);
      if (parsed && inWindow(parsed.dateKey, now)) kept.push({ ...event, parsed });
    }
    cursor = data.cursor || '';
    if (!cursor || (data.events ?? []).length === 0) break;
  }
  return kept;
}

export async function fetchMarket(ticker, fetchImpl = fetch) {
  const data = await kalshiGet(`/markets/${encodeURIComponent(ticker)}`, {}, fetchImpl);
  return data.market ?? null;
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isActive(market) {
  return market?.status === 'active' || market?.status === 'open';
}

// Price to buy `side` ('yes' | 'no') of a market, or null if it fails the board's checks.
export function tradablePrice(market, side) {
  if (!isActive(market)) return null;
  const ask = num(side === 'yes' ? market.yes_ask_dollars : market.no_ask_dollars);
  // A YES bid is the same order as a NO ask at (1 − price), so a missing bid can be derived.
  const otherAsk = num(side === 'yes' ? market.no_ask_dollars : market.yes_ask_dollars);
  const bid =
    num(side === 'yes' ? market.yes_bid_dollars : market.no_bid_dollars) ??
    (otherAsk !== null ? Math.max(0, 1 - otherAsk) : 0);
  if (ask === null || ask < MIN_PRICE || ask > MAX_PRICE) return null;
  if (ask - bid > MAX_BID_ASK_GAP) return null;
  return ask;
}

function kalshiQuote(market, side, line) {
  const price = tradablePrice(market, side);
  if (price === null) return null;
  return makeQuote(probabilityToAmerican(price), {
    line,
    source: 'kalshi',
    ref: { provider: 'Kalshi', ticker: market.ticker, side, price },
  });
}

// Fresh quote for a stored leg (ticker + side), as placed at bet time. Line comes from the market itself:
// spread YES = favorite −strike, spread NO = underdog +strike; total = strike; moneyline = none.
export function quoteFromMarket(market, side, marketType) {
  if (!market) return null;
  const strike = num(market.floor_strike);
  let line = null;
  if (marketType === 'spread') {
    if (strike === null) return null;
    line = side === 'yes' ? -strike : strike;
  } else if (marketType === 'total') {
    if (strike === null) return null;
    line = strike;
  }
  return kalshiQuote(market, side, line);
}

// Team code at the end of a market ticker: "KXNFLSPREAD-26OCT18HOUJAC-JAC3" → "JAC"
function marketCode(market, eventTicker) {
  const tail = String(market.ticker ?? '').slice(String(eventTicker).length + 1);
  return tail.replace(/\d+$/, '');
}

function spreadLabel(market) {
  return String(market.yes_sub_title ?? '').replace(/\s+wins by over.*$/i, '').trim();
}

// Quotes for one matched game. sideByCode maps Kalshi team codes to 'home' / 'away'.
export function buildKalshiMarkets({ gameEvent, spreadEvent, totalEvent, sideByCode }) {
  const markets = {
    moneyline: { home: null, away: null },
    spread: { home: null, away: null },
    total: { over: null, under: null },
  };

  // Moneyline: YES on each team's winner market; NO on the other team's market as a fallback.
  const winner = { home: null, away: null };
  for (const market of gameEvent?.markets ?? []) {
    const side = sideByCode[marketCode(market, gameEvent.event_ticker)];
    if (side) winner[side] = market;
  }
  for (const side of ['home', 'away']) {
    const other = side === 'home' ? 'away' : 'home';
    markets.moneyline[side] =
      (winner[side] && kalshiQuote(winner[side], 'yes', null)) ||
      (winner[other] && kalshiQuote(winner[other], 'no', null)) ||
      null;
  }

  // Spread: use the favorite's "wins by over N.5" markets; strike with YES ask closest to $0.50.
  if (spreadEvent) {
    const bySide = { home: [], away: [] };
    for (const market of spreadEvent.markets ?? []) {
      const side = sideByCode[marketCode(market, spreadEvent.event_ticker)];
      const strike = num(market.floor_strike);
      if (side && strike !== null && strike > 0) bySide[side].push({ market, strike });
    }

    const homeWin = winner.home ? tradablePrice(winner.home, 'yes') : null;
    const awayWin = winner.away ? tradablePrice(winner.away, 'yes') : null;
    let favorite = null;
    if (homeWin !== null && awayWin !== null && homeWin !== awayWin) favorite = homeWin > awayWin ? 'home' : 'away';

    const closest = (entries) => {
      let best = null;
      for (const entry of entries) {
        const ask = tradablePrice(entry.market, 'yes');
        if (ask === null) continue;
        const distance = Math.abs(ask - 0.5);
        if (!best || distance < best.distance) best = { ...entry, distance };
      }
      return best;
    };

    let pick = null;
    if (favorite) {
      pick = closest(bySide[favorite]);
      if (pick) pick.side = favorite;
    } else {
      const h = closest(bySide.home);
      const a = closest(bySide.away);
      if (h && (!a || h.distance <= a.distance)) pick = { ...h, side: 'home' };
      else if (a) pick = { ...a, side: 'away' };
    }

    if (pick) {
      const dog = pick.side === 'home' ? 'away' : 'home';
      markets.spread[pick.side] = kalshiQuote(pick.market, 'yes', -pick.strike);
      markets.spread[dog] = kalshiQuote(pick.market, 'no', pick.strike);
    }
  }

  // Total: "Over N.5" markets; strike with YES ask closest to $0.50. Over = YES, Under = NO.
  if (totalEvent) {
    let best = null;
    for (const market of totalEvent.markets ?? []) {
      const strike = num(market.floor_strike);
      const ask = tradablePrice(market, 'yes');
      if (strike === null || strike <= 0 || ask === null) continue;
      const distance = Math.abs(ask - 0.5);
      if (!best || distance < best.distance) best = { market, strike, distance };
    }
    if (best) {
      markets.total.over = kalshiQuote(best.market, 'yes', best.strike);
      markets.total.under = kalshiQuote(best.market, 'no', best.strike);
    }
  }

  return markets;
}

// Two team sides (label + code) for an event, from its markets or, failing that, its title.
function eventSides(event, kind) {
  if (kind === 'game') {
    const markets = event.markets ?? [];
    if (markets.length !== 2) return null;
    return markets.map((m) => ({ label: m.yes_sub_title, code: marketCode(m, event.event_ticker) }));
  }
  if (kind === 'spread') {
    const byCode = new Map();
    for (const m of event.markets ?? []) {
      const code = marketCode(m, event.event_ticker);
      if (code && !byCode.has(code)) byCode.set(code, { label: spreadLabel(m), code });
    }
    return byCode.size === 2 ? [...byCode.values()] : null;
  }
  // Totals: "CAR Panthers vs CLE Browns: Total Points"
  const title = String(event.title ?? '').split(':')[0];
  const parts = title.split(/\s+(?:vs\.?|at|@)\s+/i);
  if (parts.length !== 2) return null;
  return parts.map((label) => ({ label: label.trim(), code: label.trim().split(' ')[0] }));
}

// Matches every fetched event to an ESPN game and returns Map(gameId → Kalshi markets).
export function attachKalshiToGames(params) {
  const result = new Map();
  for (const [gameId, entry] of matchKalshiEntries(params)) {
    result.set(gameId, buildKalshiMarkets(entry));
  }
  return result;
}

// Matches every fetched event to an ESPN game. Returns Map(gameId → { game, sideByCode, gameEvent, spreadEvent, totalEvent }).
export function matchKalshiEntries({ league, games, gameEvents, spreadEvents, totalEvents }) {
  const espnGames = games.filter((g) => g.source === 'espn');
  const bySuffix = new Map(); // ticker suffix → { game, sideByCode, gameEvent, spreadEvent, totalEvent }

  const register = (event, kind) => {
    const suffix = event.parsed.suffix;
    let entry = bySuffix.get(suffix);
    if (!entry) {
      const sides = eventSides(event, kind);
      if (!sides) return;
      const match = matchTeamsToGame(sides, event.parsed.dateKey, espnGames, league);
      if (!match) return; // not an FBS / board game (e.g. FCS), or names didn't line up
      const sideByCode = {};
      sides.forEach((s, i) => {
        if (s.code) sideByCode[s.code] = match.sideOf[i];
      });
      entry = { game: match.game, sideByCode, gameEvent: null, spreadEvent: null, totalEvent: null };
      bySuffix.set(suffix, entry);
    } else if (kind !== 'total') {
      // Learn any team codes this event uses that the first event didn't.
      const sides = eventSides(event, kind) ?? [];
      for (const s of sides) {
        if (s.code && !entry.sideByCode[s.code]) {
          const home = scoreSide(s, entry.game.home, league);
          const away = scoreSide(s, entry.game.away, league);
          if (home !== away) entry.sideByCode[s.code] = home > away ? 'home' : 'away';
        }
      }
    }
    entry[`${kind}Event`] = event;
  };

  // Winner events first: their two clean team labels give the most reliable match.
  gameEvents.forEach((e) => register(e, 'game'));
  spreadEvents.forEach((e) => register(e, 'spread'));
  totalEvents.forEach((e) => register(e, 'total'));

  const result = new Map();
  for (const entry of bySuffix.values()) {
    if (result.has(entry.game.id)) continue; // two events for one game: keep the first
    result.set(entry.game.id, entry);
  }
  return result;
}

function scoreSide(side, team, league) {
  return scoreTeam(side.label, side.code, team, league);
}

// ---------- Alternate lines ----------

// Small per-game mapping kept on the board game: which Kalshi events belong to it and which team each code is.
// Used at bet time to confirm a submitted ticker really belongs to this game and side.
export function kalshiMapping(entry) {
  return {
    gameEvent: entry.gameEvent?.event_ticker ?? null,
    spreadEvent: entry.spreadEvent?.event_ticker ?? null,
    totalEvent: entry.totalEvent?.event_ticker ?? null,
    sideByCode: { ...entry.sideByCode },
  };
}

// Compact copy of one event's active markets: [tickerSuffix, strike, yesAsk, yesBid, noAsk, noBid].
function compactEvent(event) {
  if (!event) return null;
  const rows = [];
  for (const m of event.markets ?? []) {
    if (!isActive(m)) continue;
    const strike = num(m.floor_strike);
    if (strike === null || strike <= 0) continue;
    const suffix = String(m.ticker ?? '').slice(String(event.event_ticker).length + 1);
    if (!suffix) continue;
    rows.push([suffix, strike, num(m.yes_ask_dollars), num(m.yes_bid_dollars), num(m.no_ask_dollars), num(m.no_bid_dollars)]);
  }
  return { e: event.event_ticker, m: rows };
}

// Compact alternate-line data for one game (spread + total events). Kept in the board cache, never sent with the board.
export function compactAlternates(entry) {
  const s = compactEvent(entry.spreadEvent);
  const t = compactEvent(entry.totalEvent);
  if (!s && !t) return null;
  return { s, t };
}

// Same shape from full events fetched one game at a time (fallback when the board copy was dropped for size).
export function compactFromEvents(spreadEvent, totalEvent) {
  return { s: compactEvent(spreadEvent), t: compactEvent(totalEvent) };
}

function expandRow(eventTicker, row) {
  const [suffix, strike, yesAsk, yesBid, noAsk, noBid] = row;
  return {
    ticker: `${eventTicker}-${suffix}`,
    status: 'active',
    floor_strike: strike,
    yes_ask_dollars: yesAsk,
    yes_bid_dollars: yesBid,
    no_ask_dollars: noAsk,
    no_bid_dollars: noBid,
    suffix,
  };
}

// Every posted, tradable spread and total line for a game. Never computes a line Kalshi didn't post.
// Spreads: team X at −N = YES on "X wins by over N"; X's opponent at +N = NO on that same market.
// Totals: over = YES on "Over N", under = NO.
export function buildLadders(compact, sideByCode) {
  const ladders = { spreads: { home: [], away: [] }, totals: [] };
  if (!compact) return ladders;

  if (compact.s) {
    for (const row of compact.s.m) {
      const market = expandRow(compact.s.e, row);
      const side = sideByCode?.[market.suffix.replace(/\d+$/, '')];
      if (side !== 'home' && side !== 'away') continue;
      const other = side === 'home' ? 'away' : 'home';
      const fav = quoteFromMarket(market, 'yes', 'spread');
      const dog = quoteFromMarket(market, 'no', 'spread');
      if (fav) ladders.spreads[side].push(fav);
      if (dog) ladders.spreads[other].push(dog);
    }
    for (const key of ['home', 'away']) ladders.spreads[key].sort((a, b) => a.line - b.line);
  }

  if (compact.t) {
    const byLine = new Map();
    for (const row of compact.t.m) {
      const market = expandRow(compact.t.e, row);
      const over = quoteFromMarket(market, 'yes', 'total');
      const under = quoteFromMarket(market, 'no', 'total');
      if (!over && !under) continue;
      byLine.set(market.floor_strike, { line: market.floor_strike, over, under });
    }
    ladders.totals = [...byLine.values()].sort((a, b) => a.line - b.line);
  }

  return ladders;
}

// Confirms a submitted Kalshi ticker/side belongs to this game, market type and selection.
export function marketMatchesLeg(mapping, { marketType, selection }, ticker, side) {
  if (!mapping || typeof ticker !== 'string' || (side !== 'yes' && side !== 'no')) return false;
  const eventTicker = marketType === 'moneyline' ? mapping.gameEvent : marketType === 'spread' ? mapping.spreadEvent : mapping.totalEvent;
  if (!eventTicker || !ticker.startsWith(`${eventTicker}-`)) return false;
  if (marketType === 'total') return (side === 'yes') === (selection === 'over');

  const code = ticker.slice(eventTicker.length + 1).replace(/\d+$/, '');
  const teamSide = mapping.sideByCode?.[code];
  if (teamSide !== 'home' && teamSide !== 'away') return false;
  // YES backs the market's team; NO backs its opponent.
  return side === 'yes' ? teamSide === selection : teamSide !== selection;
}

export async function fetchEvent(eventTicker, fetchImpl = fetch) {
  const data = await kalshiGet(`/events/${encodeURIComponent(eventTicker)}`, { with_nested_markets: 'true' }, fetchImpl);
  const event = data.event ?? null;
  if (!event) return null;
  return { ...event, markets: event.markets ?? data.markets ?? [] };
}

// Fetches all three series for a league. Each series fails independently.
export async function fetchLeagueKalshi(league, { now = new Date(), fetchImpl = fetch } = {}) {
  const series = league.kalshi;
  const [game, spread, total] = await Promise.allSettled([
    fetchSeriesEvents(series.game, { now, fetchImpl }),
    fetchSeriesEvents(series.spread, { now, fetchImpl }),
    fetchSeriesEvents(series.total, { now, fetchImpl }),
  ]);
  const failed = [game, spread, total].filter((r) => r.status === 'rejected');
  failed.forEach((r) => console.error(`Kalshi ${league.id} fetch failed:`, r.reason?.message));
  return {
    gameEvents: game.status === 'fulfilled' ? game.value : [],
    spreadEvents: spread.status === 'fulfilled' ? spread.value : [],
    totalEvents: total.status === 'fulfilled' ? total.value : [],
    status: failed.length === 0 ? 'ok' : failed.length === 3 ? 'failed' : 'partial',
  };
}
