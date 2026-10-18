// Player props (Kalshi only, pre-game only). See shared/props.js for the series and the naming rules.
//
//   loadGameProps   the props page (/api/board?league=…&game={id}&props=1): one request per configured series for the
//                   game's league, for the event whose ticker suffix is the game's mapped winner event, kept in this
//                   function instance's memory for 30 s (never Firestore).
//   pricePropLeg    bet time: the exact market fetched fresh; the server confirms the series is configured, the market
//                   belongs to the event mapped to this game, it is active, the game is still pre-game (ESPN 'pre' and
//                   the server clock before the start) and the price passes MIN/MAX/gap. Price = the side's ask.
//   resultFromPropMarket   settlement: Kalshi's own result (finalized yes/no → graded; voided or any other final
//                   result, e.g. a scratched player settled at a "fair price" → void).
//
// Matching is only by ticker suffix: a game with no mapped winner event has no props. Never names or dates alone.

import { fetchEvent, isActive, tradablePrice } from './sources/kalshi.js';
import { makeQuote, probabilityToAmerican } from '../shared/oddsMath.js';
import {
  PROP_CLOSED_MESSAGE,
  PROP_MARKET,
  parsePropTicker,
  playerNameOf,
  propBelongsToGame,
  propButtonLabels,
  propEventTickerFor,
  propSeries,
  propSeriesForLeague,
  propsOpen,
  teamCodeOf,
  thresholdOf,
} from '../shared/props.js';

export const PROPS_TTL_MS = 30 * 1000;

const memo = new Map(); // key → { at, promise } (failures kept for the TTL too)
function cached(key, nowMs, fn) {
  const hit = memo.get(key);
  if (hit && nowMs - hit.at < PROPS_TTL_MS) return hit.promise;
  const promise = Promise.resolve().then(fn);
  promise.catch(() => {});
  memo.set(key, { at: nowMs, promise });
  if (memo.size > 300) for (const [k, v] of memo) if (nowMs - v.at >= PROPS_TTL_MS) memo.delete(k);
  return promise;
}

export function clearPropsCache() {
  memo.clear();
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// A market has the prop shape: "greater" with a floor_strike and no cap.
function propShaped(market) {
  return market?.strike_type === 'greater' && num(market.floor_strike) !== null && num(market.cap_strike) === null;
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

// What a stored prop leg says about its market (label pieces), from the market and its ticker.
export function propInfo(market, sideByCode, game) {
  const parsed = parsePropTicker(market?.ticker);
  const config = parsed ? propSeries(parsed.series) : null;
  if (!parsed || !config) return null;
  const code = teamCodeOf(parsed.playerCode, sideByCode);
  const side = code ? sideByCode[code] : null;
  return {
    series: parsed.series,
    stat: config.stat,
    anytime: Boolean(config.anytime),
    player: playerNameOf(market.yes_sub_title) || parsed.playerCode,
    threshold: thresholdOf(market) ?? parsed.threshold,
    playerKey: parsed.playerKey,
    team: side && game ? game[side]?.shortName ?? null : null,
    teamSide: side,
  };
}

// ---------- the props page ----------

function fetchPropEvent(eventTicker, { nowMs, fetchImpl }) {
  return cached(`event:${eventTicker}`, nowMs, async () => {
    try {
      return await fetchEvent(eventTicker, fetchImpl);
    } catch (err) {
      if (/answered 404/.test(err.message)) return null; // no prop event for this game in this series
      throw err;
    }
  });
}

// One stat tab: players with their tradable thresholds (both sides pass the price checks), sorted by team (away
// first) and then by the player's most-traded market; each player starts on the threshold whose YES ask is nearest
// $0.50.
export function buildPropTab(series, event, { game, sideByCode }) {
  const config = propSeries(series);
  const players = new Map();
  for (const market of event?.markets ?? []) {
    if (!isActive(market) || !propShaped(market)) continue;
    if (!String(market.ticker ?? '').startsWith(`${event.event_ticker}-`)) continue;
    const info = propInfo(market, sideByCode, game);
    if (!info) continue;
    const yes = quoteOf(market, 'yes');
    const no = quoteOf(market, 'no');
    let player = players.get(info.playerKey);
    if (!player) {
      player = { key: info.playerKey, name: info.player, team: info.team, teamSide: info.teamSide, volume: 0, rows: [] };
      players.set(info.playerKey, player);
    }
    player.volume = Math.max(player.volume, num(market.volume_fp ?? market.volume) ?? 0);
    if (!yes || !no) continue; // a threshold whose price fails the checks isn't offered
    player.rows.push({ ticker: market.ticker, threshold: info.threshold, strike: num(market.floor_strike), yes, no, labels: propButtonLabels({ stat: config.stat, threshold: info.threshold, anytime: config.anytime }) });
  }
  const teamOrder = (p) => (p.teamSide === 'away' ? 0 : p.teamSide === 'home' ? 1 : 2);
  const list = [...players.values()]
    .filter((p) => p.rows.length > 0)
    .map((p) => {
      const rows = p.rows.sort((a, b) => a.strike - b.strike);
      let main = 0;
      rows.forEach((r, i) => {
        if (Math.abs(r.yes.ref.price - 0.5) < Math.abs(rows[main].yes.ref.price - 0.5)) main = i;
      });
      return { key: p.key, name: p.name, team: p.team, teamSide: p.teamSide, volume: p.volume, rows, mainTicker: rows[main].ticker };
    })
    .sort((a, b) => teamOrder(a) - teamOrder(b) || b.volume - a.volume || a.name.localeCompare(b.name));
  return { series, stat: config.stat, anytime: Boolean(config.anytime), eventTicker: event?.event_ticker ?? null, players: list };
}

// Props for one board game: { open, reason, tabs }. game is the board game (with its Kalshi mapping).
export async function loadGameProps(game, { nowMs = Date.now(), fetchImpl = fetch } = {}) {
  if (!game || game.source !== 'espn') return { open: false, reason: 'Player props are only on league games.', tabs: [] };
  if (!propsOpen(game, nowMs)) return { open: false, reason: PROP_CLOSED_MESSAGE, tabs: [] };
  const gameEventTicker = game.kalshi?.gameEvent ?? null;
  if (!gameEventTicker) return { open: true, reason: 'No player props for this game.', tabs: [] };
  const seriesList = propSeriesForLeague(game.league);
  const results = await Promise.allSettled(
    seriesList.map(async (series) => {
      const eventTicker = propEventTickerFor(series, gameEventTicker);
      const event = await fetchPropEvent(eventTicker, { nowMs, fetchImpl });
      // Only the exact event of this game (same suffix as its winner event) is used.
      if (!event || event.event_ticker !== eventTicker || !propBelongsToGame(eventTicker, { league: game.league, gameEventTicker })) return null;
      return buildPropTab(series, event, { game, sideByCode: game.kalshi?.sideByCode ?? {} });
    }),
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`props ${seriesList[i]} for ${game.id} failed:`, r.reason?.message);
  });
  const tabs = results.filter((r) => r.status === 'fulfilled' && r.value && r.value.players.length > 0).map((r) => r.value);
  return { open: true, reason: tabs.length ? null : 'No player props for this game.', tabs };
}

// ---------- betting ----------

function closed(reason) {
  return { status: 'closed', reason };
}

// leg: { league, gameId (ESPN id), marketType 'prop', selection 'yes' | 'no', kalshiTicker, line }.
// fresh: the game from a fresh ESPN fetch; boardGame: the board's copy (its Kalshi mapping says which winner event is
// this game's). Returns { status: 'ok' | 'lineChanged', quote, game } or closed.
export async function pricePropLeg(leg, ctx, { fresh, boardGame }) {
  if (leg.marketType !== PROP_MARKET) return closed('This prop is not offered.');
  if (!propsOpen(fresh, ctx.now.getTime())) return closed(PROP_CLOSED_MESSAGE);
  const side = leg.selection;
  if (side !== 'yes' && side !== 'no') return closed('This prop is not offered.');
  const ticker = leg.kalshiTicker;
  const parsed = parsePropTicker(ticker);
  const config = parsed ? propSeries(parsed.series) : null;
  if (!parsed || !config || config.league !== leg.league) return closed('This prop is not offered.');
  const gameEventTicker = boardGame?.kalshi?.gameEvent ?? null;
  if (!gameEventTicker || !propBelongsToGame(ticker, { league: leg.league, gameEventTicker })) {
    return closed('This prop is not offered for this game.');
  }
  if (leg.kalshiSide && leg.kalshiSide !== side) return closed('This prop is not offered.');

  const market = await ctx.market(ticker);
  if (!market || market.ticker !== ticker || (market.event_ticker && market.event_ticker !== parsed.eventTicker)) {
    return closed('This prop is no longer offered.');
  }
  if (!isActive(market) || !propShaped(market)) return closed('This prop is closed.');
  const quote = quoteOf(market, side);
  if (!quote) return closed('No price for this prop right now. Try again in a moment.');

  const info = propInfo(market, boardGame?.kalshi?.sideByCode ?? {}, fresh);
  const game = { ...fresh, prop: info };
  const same = leg.line !== null && leg.line !== undefined && Math.abs(Number(leg.line) - quote.line) < 1e-9;
  return { status: same ? 'ok' : 'lineChanged', quote, game };
}

// ---------- settlement ----------

const FINAL = new Set(['settled', 'finalized']);
const VOIDED = new Set(['voided', 'void', 'canceled', 'cancelled']);

export function resultFromPropMarket(market) {
  const base = { homeScore: null, awayScore: null, homeName: null, awayName: null };
  if (!market) return { ...base, status: 'pending', statusText: '', reason: 'Kalshi market not found.' };
  const status = String(market.status ?? '').toLowerCase();
  const result = String(market.result ?? '').toLowerCase();
  if (VOIDED.has(status) || result === 'void') {
    return { ...base, status: 'void', statusText: 'Voided by Kalshi', reason: 'Kalshi voided the market.' };
  }
  if (FINAL.has(status)) {
    if (result === 'yes' || result === 'no') {
      return { ...base, status: 'final', kalshiResult: result, statusText: `Kalshi settled ${result.toUpperCase()}`, reason: '' };
    }
    // Scratched / non-playing players are settled at a "fair market price": not a yes/no answer, so the leg is void.
    return { ...base, status: 'void', statusText: 'Settled without a yes/no result (player did not play)', reason: `Kalshi result "${result || 'none'}"` };
  }
  return { ...base, status: 'pending', statusText: '', reason: 'Waiting for Kalshi to settle the prop.' };
}
