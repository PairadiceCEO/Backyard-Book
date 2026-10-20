// Crypto markets: Kalshi's 15-minute "Up or Down" and hourly above/below series for the coins in
// shared/crypto/coins.js, with Coinbase prices for the cards and the chart.
//
//   /api/board?league=crypto            → getCryptoBoard(): one card per coin (price, 15-min market, hourly main strike)
//   /api/board?league=crypto&game={id}  → getCryptoCoin(): the same plus the full hourly ladder and 1-minute candles
//
// Spark quota: none of this touches Firestore. Kalshi and Coinbase answers are kept in this function instance's
// memory for 10 seconds and nowhere else.
//
// Betting (priceCryptoLeg, server authoritative): the leg's market is fetched fresh from Kalshi at bet time and must
// belong to a configured series and event, be active, have opened, have its target set, and be more than 60 s
// from its close on the server clock; the price is the ask of the chosen side and must pass the board's checks
// (MIN_PRICE, MAX_PRICE, MAX_BID_ASK_GAP). Another strike is another bet (LINE_CHANGED); a new price on the same
// strike is taken automatically. Settlement uses Kalshi's own result (resultFromCryptoMarket), never our chart.

import { HttpError } from './http.js';
import { fetchMarket, isActive, kalshiGet, tradablePrice } from './sources/kalshi.js';
import { makeQuote, probabilityToAmerican } from '../shared/oddsMath.js';
import {
  CRYPTO_COINS,
  CRYPTO_CUTOFF_MS,
  CRYPTO_LEAGUE,
  CRYPTO_MARKET,
  STRIKE_TYPES,
  cryptoCoin,
  cryptoGameId,
  cryptoGameLabel,
  eventTickerOf,
  formatCryptoPrice,
  seriesOfEventTicker,
} from '../shared/crypto/coins.js';

export const CRYPTO_TTL_MS = 10 * 1000;
const COINBASE_BASE = 'https://api.exchange.coinbase.com';
const FETCH_TIMEOUT_MS = 8000;
const MAX_EVENT_PAGES = 3;

// ---------- memory-only cache (10 s) ----------
const memo = new Map(); // key → { at, promise }

// Failures are kept for the 10 s too, so a source that is down isn't asked again by every request.
function cached(key, nowMs, fn) {
  const hit = memo.get(key);
  if (hit && nowMs - hit.at < CRYPTO_TTL_MS) return hit.promise;
  const promise = Promise.resolve().then(fn);
  promise.catch(() => {}); // callers handle the error; this keeps an unhandled rejection out of the logs
  memo.set(key, { at: nowMs, promise });
  if (memo.size > 200) for (const [k, v] of memo) if (nowMs - v.at >= CRYPTO_TTL_MS) memo.delete(k);
  return promise;
}

export function clearCryptoCache() {
  memo.clear();
}

// ---------- sources ----------

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ms(value) {
  const t = Date.parse(value ?? '');
  return Number.isFinite(t) ? t : null;
}

// Open events of one series whose markets haven't all closed (newest Kalshi answer, at most 10 s old).
export function fetchOpenCryptoEvents(series, { nowMs, fetchImpl }) {
  return cached(`events:${series}`, nowMs, async () => {
    const events = [];
    let cursor = '';
    for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
      const data = await kalshiGet(
        '/events',
        { series_ticker: series, status: 'open', with_nested_markets: 'true', min_close_ts: Math.floor(nowMs / 1000), limit: 100, cursor },
        fetchImpl,
      );
      events.push(...(data.events ?? []));
      cursor = data.cursor || '';
      if (!cursor || (data.events ?? []).length === 0) break;
    }
    return events;
  });
}

async function coinbaseGet(path, params, fetchImpl) {
  const url = new URL(`${COINBASE_BASE}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
  const response = await fetchImpl(url.toString(), {
    headers: { Accept: 'application/json', 'User-Agent': 'BackyardBook/1.0' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Coinbase ${path} answered ${response.status}`);
  return response.json();
}

// Latest Coinbase price: { price, at } or null.
export function fetchCoinbasePrice(product, { nowMs, fetchImpl }) {
  return cached(`ticker:${product}`, nowMs, async () => {
    const data = await coinbaseGet(`/products/${encodeURIComponent(product)}/ticker`, {}, fetchImpl);
    const price = num(data?.price);
    return price === null ? null : { price, at: data.time ?? null };
  });
}

// The coin page's chart window: the last 60 minutes, ending now.
export const CHART_WINDOW_MS = 60 * 60 * 1000;

// 1-minute candles for the last 60 minutes (now − 60 min → now), oldest first: { from, to, points: [{ t (ms), c }] }.
// Coinbase is asked for exactly that window and answers [time (s), low, high, open, close, volume], newest first.
// Cached per product for 10 s; the window is taken when the request is made, so it rolls forward with every refresh.
export function fetchCoinbaseCandles(product, { nowMs, fetchImpl }) {
  return cached(`candles:${product}`, nowMs, async () => {
    const toMs = nowMs;
    const fromMs = nowMs - CHART_WINDOW_MS;
    const rows = await coinbaseGet(
      `/products/${encodeURIComponent(product)}/candles`,
      { granularity: 60, start: new Date(fromMs).toISOString(), end: new Date(toMs).toISOString() },
      fetchImpl,
    );
    const points = Array.isArray(rows)
      ? rows
          .filter((r) => Array.isArray(r) && Number.isFinite(Number(r[0])) && Number.isFinite(Number(r[4])))
          .map((r) => ({ t: Number(r[0]) * 1000, c: Number(r[4]) }))
          .filter((p) => p.t >= fromMs - 60 * 1000 && p.t <= toMs)
          .sort((a, b) => a.t - b.t)
      : [];
    return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), points };
  });
}

// ---------- market rules ----------

// Why a market can't be bet right now (or null when it can). kind: '15m' | 'hourly'.
export function cryptoMarketProblem(market, kind, nowMs) {
  if (!market) return 'This crypto market is no longer offered.';
  if (num(market.cap_strike) !== null) return 'This crypto market is not offered.';
  if (!(STRIKE_TYPES[kind] ?? []).includes(market.strike_type)) return 'This crypto market is not offered.';
  if (!isActive(market)) return 'This crypto market is closed.';
  if (num(market.floor_strike) === null) return "This market's target isn't set yet.";
  const openMs = ms(market.open_time);
  const closeMs = ms(market.close_time);
  if (openMs === null || closeMs === null) return 'This crypto market is closed.';
  if (openMs > nowMs) return "This market hasn't opened yet.";
  if (closeMs - nowMs <= CRYPTO_CUTOFF_MS) return 'Betting closes 60 seconds before the market closes.';
  return null;
}

function quoteOf(market, side) {
  const price = tradablePrice(market, side);
  if (price === null) return null;
  return makeQuote(probabilityToAmerican(price), {
    line: num(market.floor_strike),
    source: 'kalshi',
    ref: { provider: 'Kalshi', ticker: market.ticker, side, price },
  });
}

// Both sides of one market as the phone shows them; quotes are null once betting is closed.
function marketRow(market, kind, nowMs) {
  const open = cryptoMarketProblem(market, kind, nowMs) === null;
  return {
    ticker: market.ticker,
    strike: num(market.floor_strike),
    yes: open ? quoteOf(market, 'yes') : null,
    no: open ? quoteOf(market, 'no') : null,
  };
}

// Markets of an event that have the right shape for their kind (no ranges, a set target).
function shapedMarkets(event, kind) {
  return (event?.markets ?? []).filter(
    (m) => num(m.cap_strike) === null && (STRIKE_TYPES[kind] ?? []).includes(m.strike_type) && num(m.floor_strike) !== null,
  );
}

function eventTimes(markets) {
  const m = markets[0];
  return { openMs: ms(m?.open_time), closeMs: ms(m?.close_time) };
}

// The event to show: soonest-closing open event that has opened, whose markets have a target (15-min: skips
// "Target price: TBD"), and that hasn't closed yet.
export function pickCryptoEvent(events, kind, nowMs) {
  let best = null;
  for (const event of events ?? []) {
    const markets = shapedMarkets(event, kind).filter(isActive);
    if (markets.length === 0) continue;
    const { openMs, closeMs } = eventTimes(markets);
    if (openMs === null || closeMs === null || openMs > nowMs || closeMs <= nowMs) continue;
    if (!best || closeMs < best.closeMs) best = { event, markets, openMs, closeMs };
  }
  return best;
}

function sectionBase(picked, kind, nowMs) {
  return {
    kind,
    eventTicker: picked.event.event_ticker,
    gameId: cryptoGameId(picked.event.event_ticker),
    openTime: new Date(picked.openMs).toISOString(),
    closeTime: new Date(picked.closeMs).toISOString(),
    bettingClosesAt: new Date(picked.closeMs - CRYPTO_CUTOFF_MS).toISOString(),
    bettingOpen: picked.closeMs - nowMs > CRYPTO_CUTOFF_MS,
  };
}

export function fifteenSection(events, nowMs) {
  const picked = pickCryptoEvent(events, '15m', nowMs);
  if (!picked) return null;
  const market = picked.markets[0];
  return { ...sectionBase(picked, '15m', nowMs), market: marketRow(market, '15m', nowMs) };
}

// The main strike: the one whose YES ask is closest to $0.50 (only strikes that can be bet).
export function hourlySection(events, nowMs, { ladder = false } = {}) {
  const picked = pickCryptoEvent(events, 'hourly', nowMs);
  if (!picked) return null;
  const rows = picked.markets
    .map((m) => ({ row: marketRow(m, 'hourly', nowMs), yesAsk: tradablePrice(m, 'yes') }))
    .filter(({ row }) => row.strike !== null)
    .sort((a, b) => a.row.strike - b.row.strike);
  let main = null;
  for (const r of rows) {
    if (r.yesAsk === null || (!r.row.yes && !r.row.no)) continue;
    if (!main || Math.abs(r.yesAsk - 0.5) < Math.abs(main.yesAsk - 0.5)) main = r;
  }
  const section = { ...sectionBase(picked, 'hourly', nowMs), main: main ? main.row : null };
  if (ladder) section.ladder = rows.filter(({ row }) => row.yes || row.no).map(({ row }) => row);
  return section;
}

// ---------- board and coin page ----------

async function coinSummary(coin, { nowMs, fetchImpl, ladder = false }) {
  const settle = (p) => p.then((value) => ({ ok: true, value })).catch((err) => ({ ok: false, err }));
  const [price, fifteen, hourly] = await Promise.all([
    settle(fetchCoinbasePrice(coin.product, { nowMs, fetchImpl })),
    coin.series['15m'] ? settle(fetchOpenCryptoEvents(coin.series['15m'], { nowMs, fetchImpl })) : null,
    coin.series.hourly ? settle(fetchOpenCryptoEvents(coin.series.hourly, { nowMs, fetchImpl })) : null,
  ]);
  for (const [what, r] of [['Coinbase price', price], ['15-min', fifteen], ['hourly', hourly]]) {
    if (r && !r.ok) console.error(`crypto ${coin.id} ${what} failed:`, r.err?.message);
  }
  return {
    id: coin.id,
    name: coin.name,
    symbol: coin.symbol,
    product: coin.product,
    kinds: Object.keys(coin.series),
    price: price.ok ? price.value?.price ?? null : null,
    fifteen: fifteen?.ok ? fifteenSection(fifteen.value, nowMs) : null,
    hourly: hourly?.ok ? hourlySection(hourly.value, nowMs, { ladder }) : null,
    kalshiError: Boolean((fifteen && !fifteen.ok) || (hourly && !hourly.ok)),
  };
}

export async function getCryptoBoard({ nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const coins = await Promise.all(CRYPTO_COINS.map((coin) => coinSummary(coin, { nowMs, fetchImpl })));
  return { league: CRYPTO_LEAGUE, fetchedAt: new Date(nowMs).toISOString(), serverNow: nowMs, coins };
}

// One coin: its card plus the full hourly ladder and the last 60 minutes of 1-minute candles (the chart's x-axis
// ends at now; the 15-min and hourly close times are shown as text above the chart, not drawn on it).
export async function getCryptoCoin(coinId, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  const coin = cryptoCoin(coinId);
  if (!coin) throw new HttpError(404, 'GAME_NOT_FOUND', 'That coin is not offered.');
  const [summary, chart] = await Promise.all([
    coinSummary(coin, { nowMs, fetchImpl, ladder: true }),
    fetchCoinbaseCandles(coin.product, { nowMs, fetchImpl }).catch((err) => {
      console.error(`crypto ${coin.id} candles failed:`, err.message);
      return null;
    }),
  ]);
  return {
    league: CRYPTO_LEAGUE,
    fetchedAt: new Date(nowMs).toISOString(),
    serverNow: nowMs,
    coin: summary,
    chart: chart && chart.points.length ? chart : null,
  };
}

// ---------- betting ----------

function closed(reason) {
  return { status: 'closed', reason };
}

// leg: { league 'crypto', gameId 'crypto:{eventTicker}', marketType 'crypto', selection 'yes' | 'no', kalshiTicker, line }.
// ctx.market(ticker) fetches the market fresh. Returns { status: 'ok' | 'lineChanged', quote, game } or closed.
export async function priceCryptoLeg(leg, ctx) {
  const eventTicker = eventTickerOf(leg.gameId);
  const series = seriesOfEventTicker(eventTicker);
  if (leg.league !== CRYPTO_LEAGUE || leg.marketType !== CRYPTO_MARKET || !eventTicker || !series) {
    return closed('This crypto market is not offered.');
  }
  const side = leg.selection;
  if (side !== 'yes' && side !== 'no') return closed('Pick Up / Above or Down / Below.');
  const ticker = leg.kalshiTicker;
  if (typeof ticker !== 'string' || !ticker.startsWith(`${eventTicker}-`)) return closed('This crypto market is not offered.');
  if (leg.kalshiSide && leg.kalshiSide !== side) return closed('This crypto market is not offered.');

  const market = await ctx.market(ticker);
  if (!market || market.ticker !== ticker || (market.event_ticker && market.event_ticker !== eventTicker)) {
    return closed('This crypto market is no longer offered.');
  }
  const problem = cryptoMarketProblem(market, series.kind, ctx.now.getTime());
  if (problem) return closed(problem);
  const quote = quoteOf(market, side);
  if (!quote) return closed('No price for this side right now. Try again in a moment.');

  const closeTime = new Date(ms(market.close_time)).toISOString();
  const game = {
    kind: 'crypto',
    id: leg.gameId,
    startTime: closeTime,
    crypto: { symbol: series.symbol, name: series.name, coin: series.coin, kind: series.kind, closeTime },
    gameLabel: cryptoGameLabel({ name: series.name, kind: series.kind, closeTime }),
  };
  const same = leg.line !== null && leg.line !== undefined && Math.abs(Number(leg.line) - quote.line) < 1e-9;
  if (!same) return { status: 'lineChanged', quote, game };
  return { status: 'ok', quote, game };
}

// ---------- settlement ----------

const SETTLED = new Set(['settled', 'finalized']);
const VOIDED = new Set(['voided', 'void', 'canceled', 'cancelled']);

// Kalshi's own result for a crypto market: final (yes / no), void, or pending.
export function resultFromCryptoMarket(market) {
  const base = { homeScore: null, awayScore: null, homeName: null, awayName: null };
  if (!market) return { ...base, status: 'pending', statusText: '', reason: 'Kalshi market not found.' };
  const result = String(market.result ?? '').toLowerCase();
  if (result === 'void' || VOIDED.has(String(market.status ?? '').toLowerCase())) {
    return { ...base, status: 'void', statusText: 'Voided by Kalshi', reason: 'Kalshi voided the market.' };
  }
  if (SETTLED.has(String(market.status ?? '').toLowerCase()) && (result === 'yes' || result === 'no')) {
    const value = num(market.expiration_value);
    return {
      ...base,
      status: 'final',
      cryptoResult: result,
      statusText: `Kalshi settled ${result.toUpperCase()}${value !== null ? ` at ${formatCryptoPrice(value)}` : ''}`,
      reason: '',
    };
  }
  return { ...base, status: 'pending', statusText: '', reason: 'Waiting for Kalshi to settle the market.' };
}

export { fetchMarket };
