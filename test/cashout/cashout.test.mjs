// npm run test:cashout  (or: node --experimental-test-module-mocks --test test/cashout/cashout.test.mjs)
// Sportsbook cash out: values (pre-game, live, parlays, DraftKings lines matched to Kalshi strikes),
// when it's unavailable, the confirm flow (fresh prices, CASHOUT_CHANGED), pay-once, and the
// cash out vs settlement race. Firestore is in memory; ESPN and Kalshi are served by a fake fetch.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFakeDb } from '../casino/fakeFirestore.mjs';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;

const fake = makeFakeDb();
const TOKENS = { 'mike-token': { uid: 'u1' }, 'ann-token': { uid: 'u2' }, 'admin-token': { uid: 'admin' } };
mock.module(url('server/firebaseAdmin.js'), {
  namedExports: {
    adminDb: () => fake.db,
    adminAuth: () => ({ async verifyIdToken(t) { if (!TOKENS[t]) throw new Error('bad'); return { ...TOKENS[t] }; } }),
    normalizePrivateKey: (k) => k,
  },
});

const cashout = await import(url('server/cashout.js'));
const { settleBet } = await import(url('server/settlement.js'));
const adminBets = await import(url('server/admin/bets.js'));
const { normalizeEspnEvent } = await import(url('server/sources/espn.js'));
const { combinedDecimal, payoutCents } = await import(url('shared/betRules.js'));
const { groupShopPurchases } = await import(url('src/lib/shopHistory.js'));
const betsHandler = (await import(url('api/bets.js'))).default;

const NOW = new Date('2026-10-18T18:00:00.000Z');

// ---------- the fake world: ESPN games and Kalshi markets ----------
const GAMES = {
  g1: { home: 'HOU', away: 'JAX', date: '2026-10-18T17:00:00Z', ev: '26OCT18JAXHOU' }, // live
  g2: { home: 'CLE', away: 'BAL', date: '2026-10-18T13:00:00Z', ev: '26OCT18BALCLE' }, // final 24–17
  g3: { home: 'PHI', away: 'DAL', date: '2026-10-18T20:25:00Z', ev: '26OCT18DALPHI' }, // not started
  g4: { home: 'SEA', away: 'ARI', date: '2026-10-19T00:20:00Z', ev: null }, // not started, no Kalshi
};
let world;

function market(eventTicker, suffix, strike, yesBid, noBid, status = 'active') {
  const fmt = (v) => (v === null ? null : v.toFixed(4));
  return {
    ticker: `${eventTicker}-${suffix}`,
    event_ticker: eventTicker,
    status,
    floor_strike: strike,
    yes_bid_dollars: fmt(yesBid),
    no_bid_dollars: fmt(noBid),
    yes_ask_dollars: fmt(yesBid === null ? null : Math.min(0.99, yesBid + 0.02)),
    no_ask_dollars: fmt(noBid === null ? null : Math.min(0.99, noBid + 0.02)),
  };
}

function resetWorld() {
  const events = {};
  const add = (eventTicker, markets) => { events[eventTicker] = { event_ticker: eventTicker, markets }; };
  // g1 JAX @ HOU (live)
  add('KXNFLGAME-26OCT18JAXHOU', [market('KXNFLGAME-26OCT18JAXHOU', 'HOU', null, 0.64, 0.34), market('KXNFLGAME-26OCT18JAXHOU', 'JAX', null, 0.35, 0.63)]);
  add('KXNFLSPREAD-26OCT18JAXHOU', [
    market('KXNFLSPREAD-26OCT18JAXHOU', 'HOU3', 3.5, 0.48, 0.5),
    market('KXNFLSPREAD-26OCT18JAXHOU', 'HOU6', 6.5, 0.3, 0.68),
    market('KXNFLSPREAD-26OCT18JAXHOU', 'JAX3', 3.5, 0.2, 0.78),
  ]);
  add('KXNFLTOTAL-26OCT18JAXHOU', [market('KXNFLTOTAL-26OCT18JAXHOU', '44', 44.5, 0.51, 0.47), market('KXNFLTOTAL-26OCT18JAXHOU', '47', 47.5, 0.4, 0.58)]);
  // g3 DAL @ PHI (not started)
  add('KXNFLGAME-26OCT18DALPHI', [market('KXNFLGAME-26OCT18DALPHI', 'PHI', null, 0.4, 0.58), market('KXNFLGAME-26OCT18DALPHI', 'DAL', null, 0.58, 0.4)]);
  add('KXNFLSPREAD-26OCT18DALPHI', [market('KXNFLSPREAD-26OCT18DALPHI', 'DAL3', 3.5, 0.45, 0.53)]);
  add('KXNFLTOTAL-26OCT18DALPHI', [market('KXNFLTOTAL-26OCT18DALPHI', '48', 48.5, 0.5, 0.48)]);
  // g2 BAL @ CLE (final): Kalshi markets settled
  add('KXNFLGAME-26OCT18BALCLE', [market('KXNFLGAME-26OCT18BALCLE', 'CLE', null, null, null, 'finalized'), market('KXNFLGAME-26OCT18BALCLE', 'BAL', null, null, null, 'finalized')]);

  world = {
    states: { g1: { state: 'in', home: 17, away: 10 }, g2: { state: 'post', home: 24, away: 17 }, g3: { state: 'pre' }, g4: { state: 'pre' } },
    events,
    fetches: { espn: 0, kalshi: 0 },
    onKalshi: null, // optional hook run before Kalshi answers (race tests)
  };
}

function marketByTicker(ticker) {
  for (const event of Object.values(world.events)) {
    const found = event.markets.find((m) => m.ticker === ticker);
    if (found) return found;
  }
  return null;
}

function setBid(ticker, side, bid) {
  const m = marketByTicker(ticker);
  m[`${side}_bid_dollars`] = bid === null ? null : bid.toFixed(4);
}

function rawEspnEvent(id) {
  const g = GAMES[id];
  const s = world.states[id];
  const name = s.name ?? (s.state === 'post' ? 'STATUS_FINAL' : s.state === 'in' ? 'STATUS_IN_PROGRESS' : 'STATUS_SCHEDULED');
  const competitor = (homeAway, abbr, score) => ({
    homeAway,
    score: score === undefined ? '' : String(score),
    team: { id: abbr, displayName: abbr, shortDisplayName: abbr, abbreviation: abbr, name: abbr },
  });
  return {
    id,
    date: g.date,
    status: { type: { state: s.state, name, completed: s.state === 'post' && name === 'STATUS_FINAL', shortDetail: s.state } },
    competitions: [{ competitors: [competitor('home', g.home, s.home), competitor('away', g.away, s.away)], odds: [] }],
  };
}

function mapping(id) {
  const g = GAMES[id];
  if (!g.ev) return null;
  return {
    gameEvent: `KXNFLGAME-${g.ev}`,
    spreadEvent: `KXNFLSPREAD-${g.ev}`,
    totalEvent: `KXNFLTOTAL-${g.ev}`,
    sideByCode: { [g.home]: 'home', [g.away]: 'away' },
  };
}

// The 30-second board as the estimates see it (yesterday's finals could be missing; here all are present).
function board() {
  return { games: Object.keys(GAMES).map((id) => ({ ...normalizeEspnEvent(rawEspnEvent(id), 'nfl'), kalshi: mapping(id) })) };
}

const json = (body) => ({ ok: true, status: 200, json: async () => body });
async function fakeFetch(href) {
  const u = new URL(href);
  if (u.hostname === 'site.api.espn.com') {
    world.fetches.espn += 1;
    return json({ events: Object.keys(GAMES).map(rawEspnEvent) });
  }
  if (u.pathname.includes('/trade-api/v2/')) {
    world.fetches.kalshi += 1;
    if (world.onKalshi) await world.onKalshi();
    const m = /\/(markets|events)\/([^/]+)$/.exec(u.pathname);
    if (m?.[1] === 'markets') {
      const found = marketByTicker(decodeURIComponent(m[2]));
      return found ? json({ market: structuredClone(found) }) : { ok: false, status: 404, json: async () => ({}) };
    }
    if (m?.[1] === 'events') {
      const found = world.events[decodeURIComponent(m[2])];
      return found ? json({ event: structuredClone(found) }) : { ok: false, status: 404, json: async () => ({}) };
    }
  }
  throw new Error(`unexpected fetch ${href}`);
}

const makeContext = (opts) => cashout.createCashoutContext({ ...opts, getBoard: async () => board() });
const deps = { now: NOW, fetchImpl: fakeFetch, makeContext };
const mike = { uid: 'u1', user: { username: 'mike' } };
const ann = { uid: 'u2', user: { username: 'ann' } };

// ---------- bets ----------
function leg(gameId, marketType, selection, line, decimalOdds, extra = {}) {
  const g = GAMES[gameId] ?? { home: 'H', away: 'A', date: '2026-10-18T19:00:00Z' };
  return {
    legId: `nfl:${gameId}:${marketType}:${selection}:${line}`,
    league: 'nfl',
    gameId,
    gameLabel: `${g.away} @ ${g.home}`,
    startTime: g.date,
    marketType,
    selection,
    label: `${selection} ${marketType} ${line ?? ''}`.trim(),
    line,
    americanOdds: 100,
    decimalOdds,
    source: 'espn',
    sourceRef: { provider: 'DraftKings' },
    result: 'pending',
    ...extra,
  };
}
const kalshiRef = (ticker, side, price = 0.5) => ({ source: 'kalshi', sourceRef: { provider: 'Kalshi', ticker, side, price } });

function putBet(id, legs, { stakeCents = 1000, uid = 'u1', status = 'open' } = {}) {
  const decimal = combinedDecimal(legs.map((l) => l.decimalOdds));
  fake.write(`bets/${id}`, {
    uid,
    username: uid === 'u1' ? 'mike' : 'ann',
    status,
    payoutCents: 0,
    settledBy: null,
    settledAt: null,
    version: 0,
    placedAt: '2026-10-18T12:00:00.000Z',
    requestId: 'req',
    type: legs.length > 1 ? 'parlay' : 'single',
    stakeCents,
    legs,
    combinedDecimal: decimal,
    combinedAmerican: 100,
    potentialPayoutCents: payoutCents(stakeCents, decimal),
  });
  return fake.get(`bets/${id}`);
}

async function quote(betId) {
  const res = await cashout.quoteBets(mike, { betIds: [betId] }, deps);
  return res.quotes[betId];
}

async function expectHttp(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return true;
  });
}

const balance = (uid = 'u1') => fake.get(`users/${uid}`).balanceCents;

beforeEach(() => {
  fake.reset();
  resetWorld();
  cashout.clearEstimateCache();
  fake.write('users/u1', { username: 'mike', balanceCents: 5000, stats: { won: 2, lost: 1 } });
  fake.write('users/u2', { username: 'ann', balanceCents: 5000, stats: { won: 0, lost: 0 } });
  fake.write('users/admin', { username: 'boss', role: 'admin', balanceCents: 0 });
});

// ---------- pure value rules ----------

test('pure: pre-game = floor(stake × 0.9); live = floor(payout × Π bids × 0.9), exact to the cent', () => {
  assert.equal(cashout.pregameValueCents(1000), 900);
  assert.equal(cashout.pregameValueCents(1001), 900); // 900.9 → down
  assert.equal(cashout.pregameValueCents(119), 107); // 107.1 → down
  assert.equal(cashout.liveValueCents(1900, [0.62]), 1060); // 1060.2
  assert.equal(cashout.liveValueCents(1000, [0.5]), 450);
  // 0.1 + 0.2 style float noise can't round a whole cent the wrong way: 1000 × 0.7 × 0.9 = 630 exactly
  assert.equal(cashout.liveValueCents(1000, [0.7]), 630);
  assert.equal(cashout.liveValueCents(3333, [0.33, 0.67]), Math.floor((3333 * 3300 * 6700 * 9) / (10000 * 10000 * 10)));
  assert.equal(cashout.bidFromMarket({ status: 'active', yes_bid_dollars: '0.4500' }, 'yes'), 0.45);
  assert.equal(cashout.bidFromMarket({ status: 'active', yes_bid_dollars: '0.0000', no_ask_dollars: '0.40' }, 'yes'), null, 'no bid → none (never derived)');
  assert.equal(cashout.bidFromMarket({ status: 'paused', yes_bid_dollars: '0.45' }, 'yes'), null, 'paused market → none');
});

// ---------- 1. pre-game ----------

test('pre-game single: stake × 0.9, estimate then cash out pays it once with a cashout ledger entry', async () => {
  putBet('b1', [leg('g3', 'moneyline', 'home', null, 2.5)], { stakeCents: 1000 });
  const q = await quote('b1');
  assert.deepEqual(q, { available: true, valueCents: 900, mode: 'pregame' });
  assert.equal(world.fetches.kalshi, 0, 'pre-game needs no Kalshi price');

  const res = await cashout.cashOutBet(mike, { betId: 'b1', expectedCents: 900 }, deps);
  assert.equal(res.ok, true);
  assert.equal(res.duplicate, false);
  assert.equal(res.cashoutCents, 900);
  assert.equal(res.balanceCents, 5900);
  assert.equal(balance(), 5900);
  const bet = fake.get('bets/b1');
  assert.equal(bet.status, 'cashed_out');
  assert.equal(bet.cashoutCents, 900);
  assert.equal(bet.payoutCents, 900);
  assert.ok(bet.cashedOutAt, 'cashedOutAt set');
  assert.equal(bet.version, 1);
  const ledger = fake.get('ledger/cashout_b1');
  assert.equal(ledger.type, 'cashout');
  assert.equal(ledger.amountCents, 900);
  assert.equal(ledger.balanceAfterCents, 5900);
  assert.equal(ledger.betId, 'b1');
  assert.deepEqual(fake.get('users/u1').stats, { won: 2, lost: 1 }, 'win rate untouched (neither won nor lost)');
});

test('pre-game parlay: stake × 0.9 rounded down, whatever the odds', async () => {
  putBet('p1', [leg('g3', 'moneyline', 'home', null, 2.5), leg('g4', 'total', 'over', 44.5, 1.91)], { stakeCents: 1001 });
  assert.deepEqual(await quote('p1'), { available: true, valueCents: 900, mode: 'pregame' });
  const res = await cashout.cashOutBet(mike, { betId: 'p1', expectedCents: 900 }, deps);
  assert.equal(res.cashoutCents, 900);
  assert.equal(balance(), 5900);
});

// ---------- 2. live ----------

test('live single: potential payout × Kalshi YES bid × 0.9 (stored Kalshi ticker/side)', async () => {
  putBet('s1', [leg('g1', 'spread', 'home', -3.5, 1.9, kalshiRef('KXNFLSPREAD-26OCT18JAXHOU-HOU3', 'yes'))], { stakeCents: 1000 });
  // potential 1900 × 0.48 × 0.9 = 820.8 → 820
  assert.deepEqual(await quote('s1'), { available: true, valueCents: 820, mode: 'live' });
  // NO side uses no_bid_dollars: JAX +3.5 = NO on HOU3 (0.50) → 1900 × 0.5 × 0.9 = 855
  putBet('s2', [leg('g1', 'spread', 'away', 3.5, 1.9, kalshiRef('KXNFLSPREAD-26OCT18JAXHOU-HOU3', 'no'))], { stakeCents: 1000 });
  assert.equal((await quote('s2')).valueCents, 855);

  const res = await cashout.cashOutBet(mike, { betId: 's1', expectedCents: 820 }, deps);
  assert.equal(res.cashoutCents, 820);
  assert.equal(balance(), 5820);
});

test('live parlay: one leg won (×1), one live and one not started (both at their Kalshi bid)', async () => {
  const legs = [
    leg('g2', 'moneyline', 'home', null, 1.5), // CLE won 24–17 (final)
    leg('g1', 'total', 'over', 44.5, 1.95, kalshiRef('KXNFLTOTAL-26OCT18JAXHOU-44', 'yes')), // live: YES bid 0.51
    leg('g3', 'moneyline', 'away', null, 1.7), // DraftKings, not started: DAL winner YES bid 0.58
  ];
  const bet = putBet('p2', legs, { stakeCents: 1000 });
  const payout = bet.potentialPayoutCents; // floor(1000 × 1.5 × 1.95 × 1.7) = 4972
  assert.equal(payout, 4972);
  const expected = Math.floor((payout * 5100 * 5800 * 9) / (10000 * 10000 * 10)); // 1323.5… → 1323
  const q = await quote('p2');
  assert.deepEqual(q, { available: true, valueCents: expected, mode: 'live' });
  assert.equal(expected, 1323);
  const res = await cashout.cashOutBet(mike, { betId: 'p2', expectedCents: expected }, deps);
  assert.equal(res.cashoutCents, 1323);
});

test('live parlay with a pushed leg: the push drops out and the payout is recalculated', async () => {
  world.states.g2 = { state: 'post', home: 24, away: 17 };
  const legs = [
    leg('g2', 'spread', 'home', -7, 1.9), // 24 − 7 = 17 → push
    leg('g1', 'moneyline', 'home', null, 1.6, kalshiRef('KXNFLGAME-26OCT18JAXHOU-HOU', 'yes')), // bid 0.64
  ];
  putBet('p3', legs, { stakeCents: 1000 });
  const potential = payoutCents(1000, 1.6); // 1600, the pushed leg removed
  const expected = Math.floor((potential * 6400 * 9) / (10000 * 10)); // 921.6 → 921
  assert.deepEqual(await quote('p3'), { available: true, valueCents: expected, mode: 'live' });
});

// ---------- 3. DraftKings lines matched to Kalshi strikes ----------

test('DraftKings leg: matched to the Kalshi market at the same line, game and side', async () => {
  const map = mapping('g1');
  const EVENT_KEY = { moneyline: 'gameEvent', spread: 'spreadEvent', total: 'totalEvent' };
  const match = (l) => {
    const found = cashout.findKalshiMatch(world.events[map[EVENT_KEY[l.marketType]]], map, l);
    return found ? `${found.market.ticker}:${found.side}` : null;
  };
  // spread −3.5 on HOU = YES "HOU wins by over 3.5"
  assert.equal(match(leg('g1', 'spread', 'home', -3.5, 1.9)), 'KXNFLSPREAD-26OCT18JAXHOU-HOU3:yes');
  // spread +3.5 on JAX = NO on "HOU wins by over 3.5" (not JAX3, which is "JAX wins by over 3.5")
  assert.equal(match(leg('g1', 'spread', 'away', 3.5, 1.9)), 'KXNFLSPREAD-26OCT18JAXHOU-HOU3:no');
  // spread −3.5 on JAX = YES on JAX3
  assert.equal(match(leg('g1', 'spread', 'away', -3.5, 1.9)), 'KXNFLSPREAD-26OCT18JAXHOU-JAX3:yes');
  // spread +6.5 on JAX = NO on HOU6
  assert.equal(match(leg('g1', 'spread', 'away', 6.5, 1.9)), 'KXNFLSPREAD-26OCT18JAXHOU-HOU6:no');
  // totals: over = YES, under = NO at the same strike
  assert.equal(match(leg('g1', 'total', 'over', 47.5, 1.9)), 'KXNFLTOTAL-26OCT18JAXHOU-47:yes');
  assert.equal(match(leg('g1', 'total', 'under', 44.5, 1.9)), 'KXNFLTOTAL-26OCT18JAXHOU-44:no');
  // moneyline: the team's winner market YES
  assert.equal(match(leg('g1', 'moneyline', 'away', null, 2.6)), 'KXNFLGAME-26OCT18JAXHOU-JAX:yes');
  // no exact strike → no match
  assert.equal(match(leg('g1', 'spread', 'home', -2.5, 1.9)), null);
  assert.equal(match(leg('g1', 'total', 'over', 45.5, 1.9)), null);
  assert.equal(match(leg('g1', 'spread', 'home', 0, 1.9)), null, "pick'em has no Kalshi strike");

  // Moneyline falls back to NO on the opponent's market when the team's own market has no bid.
  setBid('KXNFLGAME-26OCT18JAXHOU-JAX', 'yes', null);
  assert.equal(match(leg('g1', 'moneyline', 'away', null, 2.6)), 'KXNFLGAME-26OCT18JAXHOU-HOU:no');

  // End to end: DraftKings JAX +3.5 at 1.91, live → NO bid on HOU3 (0.50): floor(1910 × 0.5 × 0.9) = 859
  putBet('dk1', [leg('g1', 'spread', 'away', 3.5, 1.91)], { stakeCents: 1000 });
  assert.deepEqual(await quote('dk1'), { available: true, valueCents: 859, mode: 'live' });
  const res = await cashout.cashOutBet(mike, { betId: 'dk1', expectedCents: 859 }, deps);
  assert.equal(res.cashoutCents, 859);
});

// ---------- 4. unavailable ----------

test('no matching Kalshi market (or no bid, or trading paused) → unavailable', async () => {
  // DraftKings −2.5: Kalshi only posts 3.5 and 6.5
  putBet('n1', [leg('g1', 'spread', 'home', -2.5, 1.9)]);
  assert.deepEqual(await quote('n1'), { available: false, valueCents: null, reason: 'No matching Kalshi market for this line.' });
  await expectHttp(cashout.cashOutBet(mike, { betId: 'n1', expectedCents: 900 }, deps), 'CASHOUT_UNAVAILABLE');

  // A not-started leg in a live parlay with no Kalshi event at all → unavailable
  putBet('n2', [leg('g1', 'moneyline', 'home', null, 1.6, kalshiRef('KXNFLGAME-26OCT18JAXHOU-HOU', 'yes')), leg('g4', 'moneyline', 'home', null, 1.8)]);
  assert.equal((await quote('n2')).reason, 'No matching Kalshi market for this line.');

  // No bid right now (e.g. right after a score)
  setBid('KXNFLSPREAD-26OCT18JAXHOU-HOU3', 'yes', null);
  putBet('n3', [leg('g1', 'spread', 'home', -3.5, 1.9, kalshiRef('KXNFLSPREAD-26OCT18JAXHOU-HOU3', 'yes'))]);
  assert.deepEqual(await quote('n3'), { available: false, valueCents: null, reason: 'Cash out unavailable right now' });

  // Trading paused
  cashout.clearEstimateCache();
  marketByTicker('KXNFLTOTAL-26OCT18JAXHOU-44').status = 'paused';
  putBet('n4', [leg('g1', 'total', 'over', 44.5, 1.9, kalshiRef('KXNFLTOTAL-26OCT18JAXHOU-44', 'yes'))]);
  assert.equal((await quote('n4')).reason, 'Cash out unavailable right now');

  assert.equal(balance(), 5000, 'nothing paid');
  assert.equal(fake.get('ledger/cashout_n1'), undefined);
});

test('a lost leg → unavailable; a bet whose games are all final → unavailable (settlement pays it)', async () => {
  // BAL lost at CLE 24–17
  putBet('l1', [leg('g2', 'moneyline', 'away', null, 2.2), leg('g1', 'moneyline', 'home', null, 1.6, kalshiRef('KXNFLGAME-26OCT18JAXHOU-HOU', 'yes'))]);
  assert.deepEqual(await quote('l1'), { available: false, valueCents: null, reason: 'A leg of this bet lost.' });
  await expectHttp(cashout.cashOutBet(mike, { betId: 'l1', expectedCents: 100 }, deps), 'CASHOUT_UNAVAILABLE');

  // Single on a final game (won): settlement will handle it
  putBet('l2', [leg('g2', 'moneyline', 'home', null, 1.5)]);
  assert.equal((await quote('l2')).reason, 'This bet is settling now.');

  // A leg whose game is final but ESPN shows no score yet
  world.states.g2 = { state: 'post', home: undefined, away: undefined };
  cashout.clearEstimateCache();
  putBet('l3', [leg('g2', 'moneyline', 'home', null, 1.5), leg('g3', 'moneyline', 'home', null, 2.5)]);
  assert.equal((await quote('l3')).available, false);
  assert.equal(balance(), 5000);
});

test('custom games: pre-game cash out works; once the custom game starts, no cash out', async () => {
  fake.write('customGames/c1', { league: 'nfl', startTime: '2026-10-18T22:00:00.000Z', status: 'scheduled', home: { name: 'Hawks' }, away: { name: 'Owls' } });
  fake.write('customGames/c2', { league: 'nfl', startTime: '2026-10-18T17:30:00.000Z', status: 'scheduled', home: { name: 'Bears' }, away: { name: 'Cats' } });
  putBet('c1', [leg('custom:c1', 'moneyline', 'home', null, 1.9, { source: 'custom', sourceRef: { provider: 'Custom' }, startTime: '2026-10-18T22:00:00.000Z' })]);
  assert.deepEqual(await quote('c1'), { available: true, valueCents: 900, mode: 'pregame' });

  putBet('c2', [leg('custom:c2', 'moneyline', 'home', null, 1.9, { source: 'custom', sourceRef: { provider: 'Custom' }, startTime: '2026-10-18T17:30:00.000Z' })]);
  assert.deepEqual(await quote('c2'), { available: false, valueCents: null, reason: 'Cash out closes once a custom game starts.' });

  // A not-started custom leg inside a live parlay has no Kalshi price → unavailable
  putBet('c3', [leg('custom:c1', 'moneyline', 'home', null, 1.9, { source: 'custom', sourceRef: { provider: 'Custom' } }), leg('g1', 'moneyline', 'home', null, 1.6, kalshiRef('KXNFLGAME-26OCT18JAXHOU-HOU', 'yes'))]);
  assert.equal((await quote('c3')).available, false);

  const res = await cashout.cashOutBet(mike, { betId: 'c1', expectedCents: 900 }, deps);
  assert.equal(res.cashoutCents, 900);
  await expectHttp(cashout.cashOutBet(mike, { betId: 'c2', expectedCents: 900 }, deps), 'CASHOUT_UNAVAILABLE');
});

test('bets that are not open, or not yours, are never quoted or paid', async () => {
  putBet('x1', [leg('g3', 'moneyline', 'home', null, 2.5)], { status: 'won' });
  putBet('x2', [leg('g3', 'moneyline', 'home', null, 2.5)], { uid: 'u2' });
  const res = await cashout.quoteBets(mike, { betIds: ['x1', 'x2', 'nope', '../users/u1'] }, deps);
  assert.deepEqual(res.quotes, {});
  await expectHttp(cashout.cashOutBet(mike, { betId: 'x1', expectedCents: 900 }, deps), 'CASHOUT_UNAVAILABLE');
  await expectHttp(cashout.cashOutBet(mike, { betId: 'x2', expectedCents: 900 }, deps), 'BET_NOT_FOUND');
  assert.equal(balance('u2'), 5000);
  // Ann can cash out her own
  const ok = await cashout.cashOutBet(ann, { betId: 'x2', expectedCents: 900 }, deps);
  assert.equal(ok.cashoutCents, 900);
});

// ---------- 5. safety ----------

test('value changes between estimate and confirm → CASHOUT_CHANGED with the new value; never pays a different amount', async () => {
  putBet('v1', [leg('g1', 'spread', 'home', -3.5, 1.9, kalshiRef('KXNFLSPREAD-26OCT18JAXHOU-HOU3', 'yes'))]);
  assert.equal((await quote('v1')).valueCents, 820); // bid 0.48

  setBid('KXNFLSPREAD-26OCT18JAXHOU-HOU3', 'yes', 0.45); // market moves
  // The estimate may still show the cached price for a few seconds…
  assert.equal((await quote('v1')).valueCents, 820);
  // …but the confirmation re-prices fresh and refuses to pay 820.
  await assert.rejects(cashout.cashOutBet(mike, { betId: 'v1', expectedCents: 820 }, deps), (err) => {
    assert.equal(err.code, 'CASHOUT_CHANGED');
    assert.equal(err.status, 409);
    assert.equal(err.extra.valueCents, 769); // 1900 × 0.45 × 0.9 = 769.5
    return true;
  });
  assert.equal(balance(), 5000);
  assert.equal(fake.get('bets/v1').status, 'open');

  // The browser can't name its own price: a made-up higher value is refused the same way.
  await expectHttp(cashout.cashOutBet(mike, { betId: 'v1', expectedCents: 1900 }, deps), 'CASHOUT_CHANGED');

  // Confirming the new value pays exactly that.
  const res = await cashout.cashOutBet(mike, { betId: 'v1', expectedCents: 769 }, deps);
  assert.equal(res.cashoutCents, 769);
  assert.equal(balance(), 5769);
});

test('confirmation always fetches fresh ESPN and Kalshi data (never the board cache)', async () => {
  putBet('f1', [leg('g1', 'moneyline', 'home', null, 1.6, kalshiRef('KXNFLGAME-26OCT18JAXHOU-HOU', 'yes'))]);
  await quote('f1');
  const before = { ...world.fetches };
  assert.equal(before.espn, 0, 'estimates read game states from the board');
  await cashout.cashOutBet(mike, { betId: 'f1', expectedCents: Math.floor((1600 * 6400 * 9) / 100000) }, deps);
  assert.ok(world.fetches.espn > before.espn, 'fresh ESPN scoreboard at confirm');
  assert.ok(world.fetches.kalshi > before.kalshi, 'fresh Kalshi market at confirm');

  // Game went final between the estimate and the confirmation: fresh ESPN catches it.
  putBet('f2', [leg('g1', 'moneyline', 'home', null, 1.6, kalshiRef('KXNFLGAME-26OCT18JAXHOU-HOU', 'yes'))]);
  const est = (await quote('f2')).valueCents;
  world.states.g1 = { state: 'post', home: 27, away: 20 };
  await expectHttp(cashout.cashOutBet(mike, { betId: 'f2', expectedCents: est }, deps), 'CASHOUT_UNAVAILABLE');
});

test('double-tap / retry pays once (deterministic ledger id cashout_{betId})', async () => {
  putBet('d1', [leg('g3', 'moneyline', 'home', null, 2.5)]);
  const [a, b] = await Promise.all([
    cashout.cashOutBet(mike, { betId: 'd1', expectedCents: 900 }, deps),
    cashout.cashOutBet(mike, { betId: 'd1', expectedCents: 900 }, deps),
  ]);
  assert.deepEqual([a.duplicate, b.duplicate].sort(), [false, true]);
  assert.equal(a.cashoutCents, 900);
  assert.equal(b.cashoutCents, 900);
  const again = await cashout.cashOutBet(mike, { betId: 'd1', expectedCents: 900 }, deps);
  assert.equal(again.duplicate, true);
  assert.equal(balance(), 5900, 'paid exactly once');
  const cashoutEntries = [...fake.store.keys()].filter((k) => k.startsWith('ledger/cashout_'));
  assert.deepEqual(cashoutEntries, ['ledger/cashout_d1']);
});

const finalWin = { status: 'final', homeScore: 27, awayScore: 20, homeName: 'HOU', awayName: 'JAX', statusText: 'Final', reason: '' };

test('settlement first: the cash out transaction sees the settled bet and pays nothing', async () => {
  putBet('r1', [leg('g1', 'moneyline', 'home', null, 1.6, kalshiRef('KXNFLGAME-26OCT18JAXHOU-HOU', 'yes'))]);
  const value = (await quote('r1')).valueCents;
  // Settlement commits after the cash out's checks but before its transaction.
  world.onKalshi = async () => {
    world.onKalshi = null;
    assert.equal(await settleBet(fake.db, 'r1', () => finalWin, NOW), 'settled');
  };
  await expectHttp(cashout.cashOutBet(mike, { betId: 'r1', expectedCents: value }, deps), 'CASHOUT_UNAVAILABLE');
  const bet = fake.get('bets/r1');
  assert.equal(bet.status, 'won');
  assert.equal(balance(), 5000 + 1600, 'only the settlement payout');
  assert.equal(fake.get('ledger/cashout_r1'), undefined);
});

test('cash out first: settlement skips the cashed-out bet', async () => {
  putBet('r2', [leg('g1', 'moneyline', 'home', null, 1.6, kalshiRef('KXNFLGAME-26OCT18JAXHOU-HOU', 'yes'))]);
  const value = (await quote('r2')).valueCents;
  await cashout.cashOutBet(mike, { betId: 'r2', expectedCents: value }, deps);
  assert.equal(await settleBet(fake.db, 'r2', () => finalWin, NOW), 'already');
  assert.equal(fake.get('bets/r2').status, 'cashed_out');
  assert.equal(fake.get('ledger/payout_r2'), undefined);
  assert.equal(balance(), 5000 + value);
  assert.deepEqual(fake.get('users/u1').stats, { won: 2, lost: 1 });
});

test('cash out vs settlement at the same moment, many times: exactly one wins, never both', async () => {
  const wins = { cashout: 0, settlement: 0 };
  for (let i = 0; i < 26; i += 1) {
    fake.write('users/u1', { username: 'mike', balanceCents: 5000, stats: { won: 0, lost: 0 } });
    const id = `race${i}`;
    putBet(id, [leg('g1', 'moneyline', 'home', null, 1.6, kalshiRef('KXNFLGAME-26OCT18JAXHOU-HOU', 'yes'))]);
    const value = Math.floor((1600 * 6400 * 9) / 100000); // 921
    const delay = (n) => new Promise((r) => { let k = 0; const step = () => (k++ >= n ? r() : setImmediate(step)); step(); });
    // Each side starts 0–12 event-loop turns after the other, so the two transactions overlap at every offset.
    const lead = i % 13;
    const [c, s] = await Promise.allSettled([
      delay(i < 13 ? 0 : lead).then(() => cashout.cashOutBet(mike, { betId: id, expectedCents: value }, deps)),
      delay(i < 13 ? lead : 0).then(() => settleBet(fake.db, id, () => finalWin, NOW)),
    ]);
    const bet = fake.get(`bets/${id}`);
    const cashed = fake.get(`ledger/cashout_${id}`) !== undefined;
    const paid = fake.get(`ledger/payout_${id}`) !== undefined;
    assert.equal(cashed !== paid, true, `run ${i}: exactly one of cash out / settlement paid`);
    wins[cashed ? 'cashout' : 'settlement'] += 1;
    if (cashed) {
      assert.equal(c.status, 'fulfilled');
      assert.equal(s.value, 'already');
      assert.equal(bet.status, 'cashed_out');
      assert.equal(balance(), 5000 + value);
    } else {
      assert.equal(c.status, 'rejected');
      assert.equal(c.reason.code, 'CASHOUT_UNAVAILABLE');
      assert.equal(s.value, 'settled');
      assert.equal(bet.status, 'won');
      assert.equal(balance(), 5000 + 1600);
    }
  }
  console.log(`race outcomes: ${JSON.stringify(wins)}`);
  assert.ok(wins.cashout > 0 && wins.settlement > 0, 'the timings cover both winners');
});

// ---------- display / admin rules ----------

test('admin force-grade and leg override refuse cashed-out bets (preview and confirm)', async () => {
  putBet('a1', [leg('g3', 'moneyline', 'home', null, 2.5)]);
  await cashout.cashOutBet(mike, { betId: 'a1', expectedCents: 900 }, deps);
  const admin = { uid: 'admin' };
  await expectHttp(adminBets.gradeBet({ betId: 'a1', outcome: 'win' }, admin), 'CASHED_OUT');
  await expectHttp(adminBets.gradeBet({ betId: 'a1', outcome: 'void', confirm: true, expectedVersion: 1 }, admin), 'CASHED_OUT');
  await expectHttp(adminBets.setLegResult({ betId: 'a1', legIndex: 0, result: 'loss' }, admin), 'CASHED_OUT');
  await expectHttp(adminBets.setLegResult({ betId: 'a1', legIndex: 0, result: 'loss', confirm: true, expectedVersion: 1 }, admin), 'CASHED_OUT');
  assert.equal(fake.get('bets/a1').status, 'cashed_out');
  assert.equal(balance(), 5900);
});

test('a leg the admin already graded counts: won leg = 1 in a live parlay', async () => {
  putBet('a2', [
    leg('g3', 'moneyline', 'home', null, 2.0, { result: 'win', overriddenBy: 'admin' }),
    leg('g1', 'moneyline', 'home', null, 1.6, kalshiRef('KXNFLGAME-26OCT18JAXHOU-HOU', 'yes')),
  ]);
  assert.equal((await quote('a2')).valueCents, Math.floor((3200 * 6400 * 9) / 100000));
});

test('Shop purchases ignore cashout ledger entries', () => {
  const grouped = groupShopPurchases(
    [
      { id: 'shop_1', uid: 'u1', type: 'shop', amountCents: 500, createdAt: '2026-10-18T10:00:00Z', note: 'Shop' },
      { id: 'cashout_b1', uid: 'u1', type: 'cashout', amountCents: 900, createdAt: '2026-10-18T11:00:00Z', note: 'Cashed out' },
    ],
    [{ id: 'u1', username: 'mike' }],
  );
  assert.equal(grouped.totalCount, 1);
  assert.equal(JSON.stringify(grouped).includes('cashout_b1'), false);
});

test('/api/bets routes cashoutQuote and cashout; estimates never pay', async () => {
  putBet('h1', [leg('g3', 'moneyline', 'home', null, 2.5)]);
  const call = async (body, token = 'mike-token') => {
    const res = { code: 0, body: null, headers: {}, headersSent: false, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } };
    await betsHandler({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body }, res);
    return res;
  };
  // The handler uses the real fetch, so prices are covered by the tests above; this checks routing and auth.
  const bad = await call({ action: 'nope' });
  assert.equal(bad.code, 400);
  assert.equal(bad.body.error.code, 'BAD_ACTION');
  const noAuth = await call({ action: 'cashoutQuote', betIds: ['h1'] }, 'wrong');
  assert.equal(noAuth.code, 401);
  const missing = await call({ action: 'cashout', betId: 'h1' });
  assert.equal(missing.code, 400, 'expectedCents is required');
  const empty = await call({ action: 'cashoutQuote', betIds: [] });
  assert.equal(empty.code, 200);
  assert.deepEqual(empty.body.quotes, {});
  assert.equal(balance(), 5000);
});
