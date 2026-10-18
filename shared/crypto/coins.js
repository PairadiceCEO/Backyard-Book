// Kalshi crypto markets offered on the Sportsbook's Crypto tab, and the Coinbase product that charts each coin.
// Shared by the server (authoritative: only these series can be bet) and the phone (display).
//
// Two kinds of Kalshi series are kept (verified against the live APIs on 2026-10-18; see PROGRESS.md):
//   '15m'    — 15-minute "Up or Down" (frequency fifteen_min). Each event has one market: YES = the price at
//              close is at or above the target (floor_strike, strike_type greater_or_equal), NO = below. The
//              target is set when the 15-minute window opens.
//   'hourly' — hourly above/below (frequency hourly, strike_type greater, floor_strike only, no cap_strike).
//              Each event is a ladder of "above $X" strikes closing on the hour.
// Left out: range/bracket series (markets with a cap_strike: KXBTC, KXETH, KXSOL, KXSOLE, KXXRP, KXRIPPLE,
// KXDOGE, KXZEC, KXTON, KXNEAR, KXHYPE), daily-or-longer series, coin-vs-coin series (KXCRYPTOCOMP15M,
// KXCRYPTOLEAD15M) and series with no open market when checked (KXBCH15M, KXADA15M, KXTON15M, KXTONH, KXTOND,
// KXNEARH, KXZECD, KXZECH). Adding one is one line below once Kalshi trades it.

export const CRYPTO_LEAGUE = 'crypto';
export const CRYPTO_MARKET = 'crypto';
export const CRYPTO_PREFIX = 'crypto:';
export const CRYPTO_KINDS = ['15m', 'hourly'];

// Coins in display order. product = the Coinbase Exchange product id ("{SYMBOL}-USD"), checked online.
export const CRYPTO_COINS = [
  { id: 'btc', name: 'Bitcoin', symbol: 'BTC', product: 'BTC-USD', series: { '15m': 'KXBTC15M', hourly: 'KXBTCD' } },
  { id: 'eth', name: 'Ethereum', symbol: 'ETH', product: 'ETH-USD', series: { '15m': 'KXETH15M', hourly: 'KXETHD' } },
  { id: 'sol', name: 'Solana', symbol: 'SOL', product: 'SOL-USD', series: { '15m': 'KXSOL15M', hourly: 'KXSOLD' } },
  { id: 'xrp', name: 'XRP', symbol: 'XRP', product: 'XRP-USD', series: { '15m': 'KXXRP15M', hourly: 'KXXRPD' } },
  { id: 'doge', name: 'Dogecoin', symbol: 'DOGE', product: 'DOGE-USD', series: { '15m': 'KXDOGE15M', hourly: 'KXDOGED' } },
  { id: 'bnb', name: 'BNB', symbol: 'BNB', product: 'BNB-USD', series: { '15m': 'KXBNB15M', hourly: 'KXBNBD' } },
  { id: 'hype', name: 'Hyperliquid', symbol: 'HYPE', product: 'HYPE-USD', series: { '15m': 'KXHYPE15M', hourly: 'KXHYPED' } },
  { id: 'near', name: 'NEAR', symbol: 'NEAR', product: 'NEAR-USD', series: { '15m': 'KXNEAR15M' } },
  { id: 'zec', name: 'Zcash', symbol: 'ZEC', product: 'ZEC-USD', series: { '15m': 'KXZEC15M' } },
];

// Series ticker → { series, kind, coin, name, symbol, product }.
export const CRYPTO_SERIES = Object.fromEntries(
  CRYPTO_COINS.flatMap((coin) =>
    Object.entries(coin.series).map(([kind, series]) => [
      series,
      { series, kind, coin: coin.id, name: coin.name, symbol: coin.symbol, product: coin.product },
    ]),
  ),
);

// Which strike types each kind may have (anything else is refused, at bet time too).
export const STRIKE_TYPES = { '15m': ['greater_or_equal'], hourly: ['greater', 'greater_or_equal'] };

export function cryptoCoin(id) {
  return CRYPTO_COINS.find((c) => c.id === String(id ?? '').toLowerCase()) ?? null;
}

// "KXBTC15M-26OCT180115" → its configured series, or null.
export function seriesOfEventTicker(eventTicker) {
  const series = String(eventTicker ?? '').split('-')[0];
  return Object.prototype.hasOwnProperty.call(CRYPTO_SERIES, series) ? CRYPTO_SERIES[series] : null;
}

export function isCryptoLeg(leg) {
  return String(leg?.gameId ?? '').startsWith(CRYPTO_PREFIX) || leg?.league === CRYPTO_LEAGUE || leg?.marketType === CRYPTO_MARKET;
}

export function cryptoGameId(eventTicker) {
  return `${CRYPTO_PREFIX}${eventTicker}`;
}

export function eventTickerOf(gameId) {
  const id = String(gameId ?? '');
  return id.startsWith(CRYPTO_PREFIX) ? id.slice(CRYPTO_PREFIX.length) : null;
}

// Betting on a crypto market closes this long before its close time (server clock).
export const CRYPTO_CUTOFF_MS = 60 * 1000;

// ---------- display ----------

const CENTRAL_CLOCK = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });

export function formatCloseClock(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : CENTRAL_CLOCK.format(date);
}

// A price in dollars with commas, at least 2 decimals and no more than it needs (up to 6): 81931.55 → "$81,931.55",
// 1.2915 → "$1.2915", 0.069891 → "$0.069891".
export function formatCryptoPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  let decimals = 2;
  while (decimals < 6 && Math.abs(Number(n.toFixed(decimals)) - n) > 1e-9) decimals += 1;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

// An hourly strike as Kalshi words it: strike_type "greater" posts "$62.5 or above" as 62.4999, so show the
// round number it stands for (the smallest number of decimals within 0.001% of it).
export function hourlyStrikeValue(strike) {
  const n = Number(strike);
  if (!Number.isFinite(n)) return null;
  for (let d = 0; d <= 6; d += 1) {
    const rounded = Number(n.toFixed(d));
    if (Math.abs(rounded - n) <= Math.abs(n) * 1e-5) return rounded;
  }
  return n;
}

export function formatStrike(kind, strike) {
  return formatCryptoPrice(kind === 'hourly' ? hourlyStrikeValue(strike) : strike);
}

// "BTC Up (≥ $81,931.55, 7:30 PM)" / "BTC Down (< $81,931.55, 7:30 PM)"; "SOL above $62.50 (2:00 AM)" / "… below …".
export function cryptoPickLabel({ symbol, kind, selection, line, closeTime }) {
  const clock = formatCloseClock(closeTime);
  const price = formatStrike(kind, line);
  if (kind === '15m') return `${symbol} ${selection === 'yes' ? `Up (≥ ${price}` : `Down (< ${price}`}, ${clock})`;
  return `${symbol} ${selection === 'yes' ? 'above' : 'below'} ${price} (${clock})`;
}

export function cryptoGameLabel({ name, kind, closeTime }) {
  return `${name} · ${kind === '15m' ? '15 min' : 'hourly'} · closes ${formatCloseClock(closeTime)}`;
}
