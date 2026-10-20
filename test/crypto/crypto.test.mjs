// npm run test:crypto  (or: node --experimental-test-module-mocks --test test/crypto/crypto.test.mjs)
// 0.12.0 crypto markets: the series config, the board and coin page (memory-only cache), pricing at bet time
// (configured series, open, opened, target set, > 60 s before close, price checks), singles only, settlement from
// Kalshi's own result, cash out from the fresh Kalshi bid (0.14.0).
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFakeDb } from '../casino/fakeFirestore.mjs';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;

const fake = makeFakeDb();
mock.module(url('server/firebaseAdmin.js'), {
  namedExports: { adminDb: () => fake.db, adminAuth: () => ({}), normalizePrivateKey: (k) => k },
});

const coins = await import(url('shared/crypto/coins.js'));
const rules = await import(url('shared/betRules.js'));
const crypto = await import(url('server/crypto.js'));
const { placeBets } = await import(url('server/placeBet.js'));
const { settleOpenBets } = await import(url('server/settlement.js'));
const { gradeLeg } = await import(url('server/grading.js'));
const cashout = await import(url('server/cashout.js'));
const { probabilityToAmerican } = await import(url('shared/oddsMath.js'));

// 7:20 PM CDT Oct 17 (= 00:20 UTC Oct 18). The 15-min window 7:15–7:30 PM is open; the hourly closes 8:00 PM.
const NOW = new Date('2026-10-18T00:20:00.000Z');
const nowMs = NOW.getTime();
const iso = (msOffset) => new Date(nowMs + msOffset).toISOString();
const MIN = 60e3;

function m15(eventTicker, { strike = 81931.55, open = -5 * MIN, close = 10 * MIN, yesAsk = 0.52, status = 'active', extra = {} } = {}) {
  return {
    ticker: `${eventTicker}-30`, event_ticker: eventTicker, status, strike_type: 'greater_or_equal', floor_strike: strike,
    yes_sub_title: strike === null ? 'Target price: TBD' : `Target Price: $${strike}`,
    open_time: iso(open), close_time: iso(close),
    yes_ask_dollars: yesAsk.toFixed(4), yes_bid_dollars: (yesAsk - 0.01).toFixed(4),
    no_ask_dollars: (1.01 - yesAsk).toFixed(4), no_bid_dollars: (1 - yesAsk).toFixed(4), ...extra,
  };
}
function mHourly(eventTicker, strike, yesAsk, { open = -20 * MIN, close = 40 * MIN, extra = {} } = {}) {
  return {
    ticker: `${eventTicker}-T${strike}`, event_ticker: eventTicker, status: 'active', strike_type: 'greater', floor_strike: strike,
    open_time: iso(open), close_time: iso(close),
    yes_ask_dollars: yesAsk.toFixed(4), yes_bid_dollars: Math.max(0, yesAsk - 0.01).toFixed(4),
    no_ask_dollars: Math.min(1, 1.01 - yesAsk).toFixed(4), no_bid_dollars: Math.max(0, 1 - yesAsk).toFixed(4), ...extra,
  };
}

// The Kalshi + Coinbase world for one test.
let world;
function resetWorld() {
  const btc15 = 'KXBTC15M-26OCT172030';
  const btcNext = 'KXBTC15M-26OCT172045';
  const btcH = 'KXBTCD-26OCT1720';
  const btcH2 = 'KXBTCD-26OCT1721';
  world = {
    events: {
      KXBTC15M: [
        { event_ticker: btcNext, markets: [m15(btcNext, { strike: null, open: 10 * MIN, close: 25 * MIN })] }, // TBD, not open
        { event_ticker: btc15, markets: [m15(btc15)] },
      ],
      KXBTCD: [
        { event_ticker: btcH2, markets: [mHourly(btcH2, 80999.99, 0.5, { open: 40 * MIN, close: 100 * MIN })] }, // next hour, not open
        { event_ticker: btcH, markets: [mHourly(btcH, 80999.99, 0.99), mHourly(btcH, 81499.99, 0.7), mHourly(btcH, 81999.99, 0.46), mHourly(btcH, 82499.99, 0.2), mHourly(btcH, 83999.99, 0.01)] },
      ],
    },
    markets: {},
    calls: [],
    price: { 'BTC-USD': '81950.12' },
  };
  for (const list of Object.values(world.events)) for (const e of list) for (const m of e.markets) world.markets[m.ticker] = m;
}

async function fetchImpl(u) {
  const p = new URL(u);
  world.calls.push(p.host + p.pathname);
  const ok = (body) => ({ ok: true, status: 200, json: async () => structuredClone(body) });
  if (p.host === 'api.exchange.coinbase.com') {
    const product = decodeURIComponent(p.pathname.split('/')[2]);
    if (p.pathname.endsWith('/ticker')) return world.price[product] ? ok({ price: world.price[product], time: iso(0) }) : { ok: false, status: 404, json: async () => ({}) };
    if (p.pathname.endsWith('/candles')) {
      world.candleQuery = { start: p.searchParams.get('start'), end: p.searchParams.get('end'), granularity: p.searchParams.get('granularity') };
      const from = Date.parse(p.searchParams.get('start'));
      const rows = [];
      for (let t = from; t <= nowMs; t += MIN) rows.unshift([t / 1000, 81000, 82000, 81500, 81500 + (t - from) / MIN, 1.2]);
      return ok(rows);
    }
  }
  if (p.pathname.endsWith('/events')) return ok({ events: world.events[p.searchParams.get('series_ticker')] ?? [], cursor: '' });
  const one = /\/markets\/([^/]+)$/.exec(p.pathname);
  if (one) {
    const m = world.markets[decodeURIComponent(one[1])];
    return m ? ok({ market: m }) : { ok: false, status: 404, json: async () => ({}) };
  }
  throw new Error(`unexpected ${u}`);
}

const UIDS = ['mike', 'dan'];
beforeEach(() => {
  fake.reset();
  crypto.clearCryptoCache();
  cashout.clearEstimateCache();
  resetWorld();
  for (const uid of UIDS) fake.write(`users/${uid}`, { username: uid, displayName: uid, balanceCents: 10_000, stats: { won: 0, lost: 0 } });
});

const caller = (uid) => ({ uid, token: {}, user: fake.get(`users/${uid}`) });
let n = 0;
const rid = () => `cryp-req-${String(++n).padStart(6, '0')}`;
const leg15 = (selection = 'yes', extra = {}) => ({
  league: 'crypto', gameId: 'crypto:KXBTC15M-26OCT172030', marketType: 'crypto', selection, line: 81931.55,
  kalshiTicker: 'KXBTC15M-26OCT172030-30', kalshiSide: selection, quotedAmerican: -108, ...extra,
});
const ctx = (at = NOW) => ({ now: at, market: async (t) => (await (await fetchImpl(`https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(t)}`)).json()).market ?? null });

// ---------- config ----------

test('config: every configured series maps to exactly one coin and its Coinbase product', () => {
  const seen = new Map();
  for (const coin of coins.CRYPTO_COINS) {
    assert.equal(coin.product, `${coin.symbol}-USD`, coin.id);
    assert.ok(Object.keys(coin.series).length >= 1, `${coin.id} has at least one kind`);
    for (const [kind, series] of Object.entries(coin.series)) {
      assert.ok(coins.CRYPTO_KINDS.includes(kind), `${series}: kind`);
      assert.ok(!seen.has(series), `${series} belongs to one coin only`);
      seen.set(series, coin.id);
      assert.equal(coins.CRYPTO_SERIES[series].coin, coin.id);
      assert.equal(coins.CRYPTO_SERIES[series].product, coin.product);
      assert.equal(coins.CRYPTO_SERIES[series].kind, kind);
      if (kind === '15m') assert.match(series, /^KX[A-Z]+15M$/);
    }
  }
  assert.equal(Object.keys(coins.CRYPTO_SERIES).length, seen.size);
  assert.equal(coins.seriesOfEventTicker('KXBTC-26OCT1720'), null, 'range series are not configured');
  assert.equal(coins.seriesOfEventTicker('KXBTCD-26OCT1720').coin, 'btc');
});

test('labels: "BTC Up (≥ $81,931.55, 7:30 PM)", "SOL above $62.50 (2:00 AM)"', () => {
  const close15 = '2026-10-18T00:30:00Z';
  assert.equal(rules.pickLabel({ marketType: 'crypto', selection: 'yes', line: 81931.55, crypto: { symbol: 'BTC', kind: '15m', closeTime: close15 } }), 'BTC Up (≥ $81,931.55, 7:30 PM)');
  assert.equal(rules.pickLabel({ marketType: 'crypto', selection: 'no', line: 81931.55, crypto: { symbol: 'BTC', kind: '15m', closeTime: close15 } }), 'BTC Down (< $81,931.55, 7:30 PM)');
  const closeH = '2026-10-18T07:00:00Z';
  assert.equal(rules.pickLabel({ marketType: 'crypto', selection: 'yes', line: 62.4999, crypto: { symbol: 'SOL', kind: 'hourly', closeTime: closeH } }), 'SOL above $62.50 (2:00 AM)');
  assert.equal(rules.pickLabel({ marketType: 'crypto', selection: 'no', line: 62.4999, crypto: { symbol: 'SOL', kind: 'hourly', closeTime: closeH } }), 'SOL below $62.50 (2:00 AM)');
  assert.equal(coins.formatCryptoPrice(0.069891), '$0.069891');
  assert.equal(coins.formatStrike('hourly', 0.0849999), '$0.085');
});

// ---------- board and coin page ----------

test('board: soonest open 15-min market with a target, hourly main strike (YES ask nearest $0.50); nothing written to Firestore', async () => {
  const board = await crypto.getCryptoBoard({ nowMs, fetchImpl });
  const btc = board.coins.find((c) => c.id === 'btc');
  assert.equal(btc.price, 81950.12);
  assert.equal(btc.fifteen.eventTicker, 'KXBTC15M-26OCT172030', 'TBD / not-yet-open window skipped');
  assert.equal(btc.fifteen.market.strike, 81931.55);
  assert.equal(btc.fifteen.market.yes.american, -108);
  assert.ok(btc.fifteen.market.no);
  assert.equal(btc.hourly.eventTicker, 'KXBTCD-26OCT1720');
  assert.equal(btc.hourly.main.strike, 81999.99);
  assert.equal(btc.hourly.ladder, undefined, 'the card has no ladder');
  assert.equal(board.coins.find((c) => c.id === 'near').hourly, null, 'NEAR has the 15-min kind only');
  assert.equal(fake.counts.writes, 0, 'no Firestore writes');
  assert.equal(fake.counts.reads, 0, 'no Firestore reads');

  // A second look within 10 s is answered from memory.
  const before = world.calls.length;
  await crypto.getCryptoBoard({ nowMs: nowMs + 5000, fetchImpl });
  assert.equal(world.calls.length, before);
  await crypto.getCryptoBoard({ nowMs: nowMs + 11000, fetchImpl });
  assert.ok(world.calls.length > before, 'refreshed after 10 s');
});

test('coin page: full tradable hourly ladder and the last 60 minutes of 1-minute candles (rolling); betting closed in the last 60 s', async () => {
  const page = await crypto.getCryptoCoin('btc', { nowMs, fetchImpl });
  assert.deepEqual(page.coin.hourly.ladder.map((r) => r.strike), [81499.99, 81999.99, 82499.99], 'strikes priced $0.99 / $0.01 are left out');
  assert.equal(page.chart.from, '2026-10-17T23:20:00.000Z', 'now − 60 min');
  assert.equal(page.chart.to, '2026-10-18T00:20:00.000Z', 'ends at now');
  assert.deepEqual(world.candleQuery, { start: '2026-10-17T23:20:00.000Z', end: '2026-10-18T00:20:00.000Z', granularity: '60' }, 'Coinbase asked for exactly that window');
  assert.equal(page.chart.points.length, 61);
  assert.ok(page.chart.points.every((p, i, a) => i === 0 || p.t > a[i - 1].t), 'oldest first');
  assert.ok(page.chart.points.every((p) => p.t >= Date.parse(page.chart.from) && p.t <= Date.parse(page.chart.to)));
  // Within 10 s: the same answer from memory. After that it rolls forward.
  const calls = world.calls.length;
  assert.equal((await crypto.getCryptoCoin('btc', { nowMs: nowMs + 5000, fetchImpl })).chart.from, page.chart.from);
  assert.equal(world.calls.length, calls);
  const later = await crypto.getCryptoCoin('btc', { nowMs: nowMs + 3 * MIN, fetchImpl });
  assert.equal(later.chart.from, '2026-10-17T23:23:00.000Z');
  assert.equal(later.chart.to, '2026-10-18T00:23:00.000Z');
  await assert.rejects(crypto.getCryptoCoin('ltc', { nowMs, fetchImpl }), (e) => e.status === 404);

  crypto.clearCryptoCache();
  const late = await crypto.getCryptoCoin('btc', { nowMs: nowMs + 9.5 * MIN, fetchImpl }); // 30 s before the 15-min close
  assert.equal(late.coin.fifteen.bettingOpen, false);
  assert.equal(late.coin.fifteen.market.yes, null, 'Closed');
  assert.ok(late.coin.hourly.main.yes, 'the hourly is still open');

  // Coinbase down: the page still works with no chart.
  crypto.clearCryptoCache();
  world.price = {};
  const original = fetchImpl;
  const noCandles = async (u) => (String(u).includes('/candles') ? { ok: false, status: 500, json: async () => ({}) } : original(u));
  const p2 = await crypto.getCryptoCoin('btc', { nowMs, fetchImpl: noCandles });
  assert.equal(p2.chart, null);
  assert.equal(p2.coin.price, null);
  assert.ok(p2.coin.fifteen);
});

// ---------- pricing ----------

test('pricing: a valid 15-min and hourly pick price at the ask; refusals for every rule', async () => {
  let r = await crypto.priceCryptoLeg(leg15('yes'), ctx());
  assert.equal(r.status, 'ok');
  assert.equal(r.quote.ref.price, 0.52);
  assert.equal(r.quote.line, 81931.55);
  r = await crypto.priceCryptoLeg(leg15('no'), ctx());
  assert.equal(r.quote.ref.price, 0.49);
  const hourlyLeg = { league: 'crypto', gameId: 'crypto:KXBTCD-26OCT1720', marketType: 'crypto', selection: 'no', line: 81999.99, kalshiTicker: 'KXBTCD-26OCT1720-T81999.99', kalshiSide: 'no' };
  assert.equal((await crypto.priceCryptoLeg(hourlyLeg, ctx())).status, 'ok');

  // Unknown ticker: a series that isn't configured, or a ticker from another event.
  world.markets['KXBTC-26OCT1720-B81950'] = { ...world.markets['KXBTC15M-26OCT172030-30'], ticker: 'KXBTC-26OCT1720-B81950', event_ticker: 'KXBTC-26OCT1720', strike_type: 'between', cap_strike: 81999.99 };
  r = await crypto.priceCryptoLeg({ ...leg15(), gameId: 'crypto:KXBTC-26OCT1720', kalshiTicker: 'KXBTC-26OCT1720-B81950' }, ctx());
  assert.equal(r.status, 'closed');
  assert.match(r.reason, /not offered/);
  r = await crypto.priceCryptoLeg({ ...leg15(), kalshiTicker: 'KXBTCD-26OCT1720-T81999.99' }, ctx());
  assert.equal(r.status, 'closed', 'ticker not of this event');

  // Not open yet (the next 15-min window), or no target yet.
  r = await crypto.priceCryptoLeg({ ...leg15(), gameId: 'crypto:KXBTC15M-26OCT172045', kalshiTicker: 'KXBTC15M-26OCT172045-30' }, ctx());
  assert.equal(r.status, 'closed');
  world.markets['KXBTC15M-26OCT172045-30'].open_time = iso(-MIN);
  r = await crypto.priceCryptoLeg({ ...leg15(), gameId: 'crypto:KXBTC15M-26OCT172045', kalshiTicker: 'KXBTC15M-26OCT172045-30' }, ctx());
  assert.equal(r.status, 'closed');
  assert.match(r.reason, /target/);
  world.markets['KXBTC15M-26OCT172045-30'].open_time = iso(5 * MIN);
  world.markets['KXBTC15M-26OCT172045-30'].floor_strike = 81000;
  r = await crypto.priceCryptoLeg({ ...leg15(), line: 81000, gameId: 'crypto:KXBTC15M-26OCT172045', kalshiTicker: 'KXBTC15M-26OCT172045-30' }, ctx());
  assert.match(r.reason, /hasn't opened/);

  // The 60-second cutoff (the 15-min window closes 10 minutes after NOW).
  assert.equal((await crypto.priceCryptoLeg(leg15(), ctx(new Date(nowMs + 10 * MIN - 61e3)))).status, 'ok', '61 s before close');
  for (const s of [60, 30, 0]) {
    r = await crypto.priceCryptoLeg(leg15(), ctx(new Date(nowMs + 10 * MIN - s * 1000)));
    assert.equal(r.status, 'closed', `${s} s before close`);
    assert.match(r.reason, /60 seconds/);
  }

  // Price checks: ask above MAX_PRICE, below MIN_PRICE, gap too wide.
  const t = 'KXBTC15M-26OCT172030-30';
  const base = { ...world.markets[t] };
  world.markets[t] = { ...base, yes_ask_dollars: '0.9800', yes_bid_dollars: '0.9700' };
  assert.equal((await crypto.priceCryptoLeg(leg15('yes'), ctx())).status, 'closed');
  world.markets[t] = { ...base, no_ask_dollars: '0.0200', no_bid_dollars: '0.0100' };
  assert.equal((await crypto.priceCryptoLeg(leg15('no'), ctx())).status, 'closed');
  world.markets[t] = { ...base, yes_bid_dollars: '0.3000' };
  assert.equal((await crypto.priceCryptoLeg(leg15('yes'), ctx())).status, 'closed', 'bid-ask gap over 0.15');
  world.markets[t] = { ...base, status: 'closed' };
  assert.equal((await crypto.priceCryptoLeg(leg15('yes'), ctx())).status, 'closed', 'not active');
  world.markets[t] = base;

  // Another strike is another bet; a new price on the same strike is fine.
  r = await crypto.priceCryptoLeg(leg15('yes', { line: 81900 }), ctx());
  assert.equal(r.status, 'lineChanged');
  world.markets[t] = { ...base, yes_ask_dollars: '0.6000', yes_bid_dollars: '0.5900' };
  r = await crypto.priceCryptoLeg(leg15('yes'), ctx());
  assert.equal(r.status, 'ok');
  assert.equal(r.quote.ref.price, 0.6);
});

// ---------- placing and settling ----------

test('placing a crypto single stores the label, strike and close time; a crypto leg in a parlay is refused', async () => {
  const res = await placeBets(caller('mike'), { mode: 'singles', clientRequestId: rid(), legs: [{ ...leg15('yes'), stakeCents: 1000 }] }, { now: NOW, fetchImpl });
  const b = res.bets[0];
  assert.equal(b.legs[0].label, 'BTC Up (≥ $81,931.55, 7:30 PM)');
  assert.equal(b.legs[0].line, 81931.55);
  assert.equal(b.legs[0].startTime, '2026-10-18T00:30:00.000Z');
  assert.equal(b.legs[0].sourceRef.ticker, 'KXBTC15M-26OCT172030-30');
  assert.equal(b.potentialPayoutCents, rules.payoutCents(1000, b.legs[0].decimalOdds));
  assert.equal(b.legs[0].americanOdds, -108, 'priced at the YES ask $0.52');
  assert.equal(fake.get('users/mike').balanceCents, 9000);
  assert.ok(fake.get(`ledger/stake_${b.id}`));

  // Parlay with a crypto leg: refused before anything is priced.
  const ml = { league: 'mlb', gameId: '401', marketType: 'moneyline', selection: 'home', line: null, quotedAmerican: -110 };
  await assert.rejects(
    placeBets(caller('mike'), { mode: 'parlay', clientRequestId: rid(), stakeCents: 500, legs: [leg15('yes'), ml] }, { now: NOW, fetchImpl }),
    (e) => e.code === 'BAD_SLIP' && e.message === rules.CRYPTO_PARLAY_MESSAGE,
  );
  assert.deepEqual(rules.slipProblems({ mode: 'parlay', stakeCents: 500, legs: [{ ...leg15(), gameId: 'crypto:A' }, { ...leg15(), gameId: 'crypto:B' }] }), [rules.CRYPTO_PARLAY_MESSAGE]);
  assert.equal(fake.get('users/mike').balanceCents, 9000, 'nothing more charged');

  // A pick refused at bet time (too close to the close) charges nothing.
  await assert.rejects(
    placeBets(caller('dan'), { mode: 'singles', clientRequestId: rid(), legs: [{ ...leg15('no'), stakeCents: 1000 }] }, { now: new Date(nowMs + 9.5 * MIN), fetchImpl }),
    (e) => e.code === 'MARKET_CLOSED',
  );
  assert.equal(fake.get('users/dan').balanceCents, 10_000);
});

test('grading from Kalshi\'s result: yes → YES wins / NO loses, no → the reverse, voided → void, unsettled → pending', () => {
  const L = (selection) => ({ marketType: 'crypto', selection });
  const res = (market) => crypto.resultFromCryptoMarket(market);
  const yes = res({ status: 'finalized', result: 'yes', expiration_value: '81950.12' });
  assert.equal(gradeLeg(L('yes'), yes).result, 'win');
  assert.equal(gradeLeg(L('no'), yes).result, 'loss');
  assert.equal(gradeLeg(L('yes'), yes).scoreText, 'Kalshi settled YES at $81,950.12');
  const no = res({ status: 'settled', result: 'no' });
  assert.equal(gradeLeg(L('yes'), no).result, 'loss');
  assert.equal(gradeLeg(L('no'), no).result, 'win');
  assert.equal(gradeLeg(L('yes'), res({ status: 'voided', result: '' })).result, 'void');
  assert.equal(gradeLeg(L('no'), res({ status: 'finalized', result: 'void' })).result, 'void');
  assert.equal(gradeLeg(L('yes'), res({ status: 'active', result: '' })).result, 'pending');
  assert.equal(gradeLeg(L('yes'), res({ status: 'determined', result: 'yes' })).result, 'pending', 'determined but not yet settled');
  assert.equal(gradeLeg(L('yes'), res(null)).result, 'pending');
});

test('settlement runs settle crypto bets from Kalshi (each strike its own market), with the usual ledger ids', async () => {
  const at = (ms) => new Date(nowMs + ms);
  const place = (uid, legSpec) => placeBets(caller(uid), { mode: 'singles', clientRequestId: rid(), legs: [{ ...legSpec, stakeCents: 1000 }] }, { now: NOW, fetchImpl });
  const up = (await place('mike', leg15('yes'))).bets[0];
  const down = (await place('dan', leg15('no'))).bets[0];
  // quotedAmerican = what the board showed (the ask), so no odds-change confirmation is needed.
  const hLeg = (strike, side) => ({ league: 'crypto', gameId: 'crypto:KXBTCD-26OCT1720', marketType: 'crypto', selection: side, line: strike, kalshiTicker: `KXBTCD-26OCT1720-T${strike}`, kalshiSide: side, quotedAmerican: probabilityToAmerican(Number(world.markets[`KXBTCD-26OCT1720-T${strike}`][`${side}_ask_dollars`])) });
  const above = (await place('mike', hLeg(81499.99, 'yes'))).bets[0];
  const above82 = (await place('dan', hLeg(81999.99, 'yes'))).bets[0];

  // Before Kalshi settles: nothing.
  let run = await settleOpenBets({ trigger: 'admin', force: true, now: at(11 * MIN), fetchImpl });
  assert.equal(run.settled, 0);

  // 15-min settles YES; hourly: 81,500 YES, 82,000 NO.
  Object.assign(world.markets['KXBTC15M-26OCT172030-30'], { status: 'finalized', result: 'yes' });
  Object.assign(world.markets['KXBTCD-26OCT1720-T81499.99'], { status: 'finalized', result: 'yes' });
  Object.assign(world.markets['KXBTCD-26OCT1720-T81999.99'], { status: 'finalized', result: 'no' });
  run = await settleOpenBets({ trigger: 'cron', force: true, now: at(45 * MIN), fetchImpl });
  assert.equal(run.settled, 4);
  const bet = (id) => fake.get(`bets/${id}`);
  assert.deepEqual([bet(up.id).status, bet(down.id).status, bet(above.id).status, bet(above82.id).status], ['won', 'lost', 'won', 'lost']);
  assert.equal(fake.get(`ledger/payout_${up.id}`).amountCents, bet(up.id).potentialPayoutCents);
  assert.equal(bet(up.id).payoutCents, Math.floor(1000 * bet(up.id).legs[0].decimalOdds + 1e-9), 'payout rounds down to the cent');
  assert.equal(fake.get('users/mike').stats.won, 2, 'counts toward win rate');
  assert.equal(fake.get('users/dan').stats.lost, 2);

  // Voided by Kalshi: stake back.
  crypto.clearCryptoCache();
  world.markets['KXBTC15M-26OCT172030-30'] = m15('KXBTC15M-26OCT172030');
  const v = (await placeBets(caller('mike'), { mode: 'singles', clientRequestId: rid(), legs: [{ ...leg15('no'), stakeCents: 700 }] }, { now: NOW, fetchImpl })).bets[0];
  Object.assign(world.markets['KXBTC15M-26OCT172030-30'], { status: 'voided', result: '' });
  const balance = fake.get('users/mike').balanceCents;
  await settleOpenBets({ trigger: 'player', force: true, now: at(50 * MIN), fetchImpl });
  assert.equal(bet(v.id).status, 'void');
  assert.equal(fake.get('users/mike').balanceCents, balance + 700);
});

// A $10 crypto single at +100 (potential $20) on the open 15-min market, written straight into Firestore.
function putCryptoBet(id, side, { ticker = 'KXBTC15M-26OCT172030-30', gameId = 'crypto:KXBTC15M-26OCT172030', status = 'open', result = 'pending' } = {}) {
  fake.write(`bets/${id}`, {
    uid: 'mike', username: 'mike', status, type: 'single', stakeCents: 1000, potentialPayoutCents: 2000, payoutCents: 0, version: 0,
    placedAt: iso(-MIN), requestId: id, combinedDecimal: 2, combinedAmerican: 100,
    legs: [{ legId: `l-${id}`, league: 'crypto', gameId, marketType: 'crypto', selection: side, line: 81931.55, americanOdds: 100, decimalOdds: 2,
      startTime: iso(10 * MIN), source: 'kalshi', sourceRef: { provider: 'Kalshi', ticker, side, price: 0.5 }, result }],
  });
}
const T15 = 'KXBTC15M-26OCT172030-30';
const setBook = (fields) => Object.assign(world.markets[T15], fields);
const quoteOf = async (id, at = NOW) => (await cashout.quoteBets(caller('mike'), { betIds: [id] }, { now: at, fetchImpl })).quotes[id];

test('crypto cash out: potential × fresh bid for the bet\'s side × 0.90, floored; always live (no pre-game mode)', async () => {
  setBook({ yes_bid_dollars: '0.6200', yes_ask_dollars: '0.6400', no_bid_dollars: '0.3600', no_ask_dollars: '0.3800' });
  putCryptoBet('cy', 'yes');
  putCryptoBet('cn', 'no');
  assert.equal(rules.cashoutEligible(fake.get('bets/cy')), true, 'crypto bets can be cashed out now');
  assert.deepEqual(await quoteOf('cy'), { available: true, valueCents: 1116, mode: 'live' }, '$20 × 0.62 × 0.9 = $11.16');
  assert.deepEqual(await quoteOf('cn'), { available: true, valueCents: 648, mode: 'live' }, '$20 × 0.36 × 0.9 = $6.48');

  // Every quote reads the market fresh (never a cached bid): the bid moves, the next quote follows at once.
  setBook({ yes_bid_dollars: '0.7000', yes_ask_dollars: '0.7100' });
  assert.equal((await quoteOf('cy')).valueCents, 1260);

  // Confirm pays exactly once: same transaction and cashout_{betId} ledger id as every cash out.
  const before = fake.get('users/mike').balanceCents;
  const paid = await cashout.cashOutBet(caller('mike'), { betId: 'cy', expectedCents: 1260 }, { now: NOW, fetchImpl });
  assert.equal(paid.cashoutCents, 1260);
  const again = await cashout.cashOutBet(caller('mike'), { betId: 'cy', expectedCents: 1260 }, { now: NOW, fetchImpl });
  assert.equal(again.duplicate, true);
  assert.equal(fake.get('users/mike').balanceCents, before + 1260, 'paid once');
  assert.equal(fake.get('ledger/cashout_cy').amountCents, 1260);
  assert.equal(fake.get('bets/cy').status, 'cashed_out');

  // A value that moved before the confirm is refused with the new value (never paid silently).
  setBook({ no_bid_dollars: '0.3000', no_ask_dollars: '0.3100' });
  await assert.rejects(cashout.cashOutBet(caller('mike'), { betId: 'cn', expectedCents: 648 }, { now: NOW, fetchImpl }), (e) => e.code === 'CASHOUT_CHANGED' && e.extra.valueCents === 540);
});

test('crypto cash out refusals: last 60 s, no bid, wide gap, not active, settled, ticker not on the leg / not configured', async () => {
  const base = { ...world.markets[T15], yes_bid_dollars: '0.6200', yes_ask_dollars: '0.6400' };
  const reset = () => { world.markets[T15] = { ...base }; };
  putCryptoBet('r1', 'yes');
  const refused = async (re, at = NOW, id = 'r1') => {
    const q = await quoteOf(id, at);
    assert.equal(q.available, false, JSON.stringify(q));
    assert.match(q.reason, re);
  };
  reset();
  assert.equal((await quoteOf('r1', new Date(nowMs + 10 * MIN - 61e3))).available, true, '61 s before close: still open');
  for (const s of [60, 30, 0]) await refused(/last 60 seconds|closed/, new Date(nowMs + 10 * MIN - s * 1000));
  setBook({ yes_bid_dollars: '0.0000' });
  await refused(/Nobody is bidding/);
  reset();
  setBook({ yes_bid_dollars: null });
  await refused(/Nobody is bidding/);
  reset();
  setBook({ yes_bid_dollars: '0.4000', yes_ask_dollars: '0.6400' });
  await refused(/too wide/);
  reset();
  setBook({ status: 'closed' });
  await refused(/closed/);
  reset();
  setBook({ status: 'finalized', result: 'yes' });
  await refused(/settled/);
  reset();
  setBook({ status: 'active', result: 'no' });
  await refused(/settled/, NOW);
  reset();
  // Settled on our side already (leg graded) → nothing to cash out.
  putCryptoBet('r2', 'yes', { result: 'win' });
  await refused(/settling/, NOW, 'r2');
  // The ticker must be the one on the leg, of this event, of a configured series.
  putCryptoBet('r3', 'yes', { ticker: 'KXBTCD-26OCT1720-T81999.99' }); // another event's market
  await refused(/not offered/, NOW, 'r3');
  world.markets['KXBTC-26OCT1720-B81950'] = { ...base, ticker: 'KXBTC-26OCT1720-B81950', event_ticker: 'KXBTC-26OCT1720' };
  putCryptoBet('r4', 'yes', { ticker: 'KXBTC-26OCT1720-B81950', gameId: 'crypto:KXBTC-26OCT1720' }); // range series, not configured
  await refused(/not offered/, NOW, 'r4');
  // A ticker of another event, even when Kalshi's answer doesn't say which event it belongs to.
  world.markets['KXBTC15M-26OCT172045-30'] = { ...base, ticker: 'KXBTC15M-26OCT172045-30', event_ticker: undefined };
  putCryptoBet('r5', 'yes', { ticker: 'KXBTC15M-26OCT172045-30' });
  await refused(/not offered/, NOW, 'r5');
  // Kalshi answers with a different market than the stored ticker → refused.
  world.markets[T15] = { ...base, ticker: 'KXBTC15M-26OCT172030-99' };
  await refused(/not offered/);
  reset();
  await assert.rejects(cashout.cashOutBet(caller('mike'), { betId: 'r3', expectedCents: 100 }, { now: NOW, fetchImpl }), (e) => e.code === 'CASHOUT_UNAVAILABLE');
});

test('custom-game and Challenge bets still never cash out', () => {
  assert.equal(rules.cashoutEligible({ legs: [{ gameId: 'custom:x' }] }), false);
  assert.equal(rules.cashoutEligible({ legs: [{ gameId: 'challenge:x' }] }), false);
  assert.equal(rules.cashoutEligible({ legs: [{ gameId: 'crypto:KXBTC15M-26OCT172030' }] }), true);
});
