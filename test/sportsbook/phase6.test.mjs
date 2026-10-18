// npm run test:sportsbook  (or: node --experimental-test-module-mocks test/sportsbook/phase6.test.mjs)
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;

// ---------- fake Firestore with transactions ----------
const store = new Map();
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
function snap(path) {
  const d = store.get(path);
  return { exists: d !== undefined, id: path.split('/').pop(), data: () => clone(d) };
}
function ref(path) {
  return { path, async get() { return snap(path); }, async set(v) { store.set(path, clone(v)); } };
}
function applyOps(ops) {
  for (const op of ops) if (op.kind === 'create' && store.has(op.path)) { const e = new Error('exists'); e.code = 6; throw e; }
  for (const op of ops) store.set(op.path, op.kind === 'update' ? { ...store.get(op.path), ...op.data } : op.data);
}
const fakeDb = {
  collection: (name) => ({ doc: (id) => ref(`${name}/${id}`), where: () => ({ async get() { return { forEach() {} }; } }) }),
  doc: (path) => ref(path),
  async runTransaction(fn) {
    const ops = [];
    const tx = {
      get: async (r) => snap(r.path),
      create: (r, d) => ops.push({ kind: 'create', path: r.path, data: clone(d) }),
      set: (r, d) => ops.push({ kind: 'set', path: r.path, data: clone(d) }),
      update: (r, d) => ops.push({ kind: 'update', path: r.path, data: clone(d) }),
    };
    const result = await fn(tx);
    applyOps(ops);
    return result;
  },
};
mock.module(url('server/firebaseAdmin.js'), { namedExports: { adminDb: () => fakeDb, adminAuth: () => ({}), normalizePrivateKey: (k) => k } });
let caller = { uid: 'u1', token: {}, user: { username: 'mike' } };
mock.module(url('server/auth.js'), {
  namedExports: {
    requireUser: async () => {
      if (!caller) { const { HttpError } = await import(url('server/http.js')); throw new HttpError(401, 'NOT_SIGNED_IN', 'x'); }
      return caller;
    },
    requireAdmin: async () => caller,
  },
});

const rules = await import(url('shared/betRules.js'));
const { priceLeg, sameLine } = await import(url('server/pricing.js'));
const { placeBets } = await import(url('server/placeBet.js'));
const { quoteFromMarket } = await import(url('server/sources/kalshi.js'));
const { makeQuote } = await import(url('shared/oddsMath.js'));
const { emptyMarkets } = await import(url('server/sources/espn.js'));
const red = await import(url('src/lib/betSlipReducer.js'));

// ---------- fixtures ----------
const team = (abbr, short) => ({ id: abbr, name: short, shortName: short, nickname: short, location: short, abbr, logo: null, logoDark: null, score: null });
const espnQ = (am, line = null) => makeQuote(am, { line, source: 'espn', ref: { provider: 'DraftKings' } });
const kalQ = (am, line, ticker, side) => makeQuote(am, { line, source: 'kalshi', ref: { provider: 'Kalshi', ticker, side, price: 0.5 } });
function game(id, state, markets = emptyMarkets(), extra = {}) {
  return { id, league: 'nfl', source: 'espn', startTime: '2026-10-18T17:00:00.000Z', state, statusText: '', canceled: false, home: team('HOU', 'Texans'), away: team('JAX', 'Jaguars'), markets, oddsNote: null, ...extra };
}
function marketsWith(fn) { const m = emptyMarkets(); fn(m); return m; }
function kalshiMarket(ticker, strike, yesAsk, noAsk, status = 'active') {
  // updated_time after the games' 17:00Z start: a live market (stale-market guard)
  return { ticker, status, floor_strike: strike, yes_ask_dollars: yesAsk.toFixed(4), no_ask_dollars: noAsk.toFixed(4), yes_bid_dollars: (yesAsk - 0.01).toFixed(4), no_bid_dollars: (noAsk - 0.01).toFixed(4), updated_time: '2026-10-18T17:30:00Z' };
}
function fakeCtx({ fresh = [], board = [], kalshiForGames = new Map(), markets = {}, custom = {}, now = new Date('2026-10-16T20:00:00Z') } = {}) {
  return {
    now,
    board: async () => ({ games: board }),
    freshEspnGames: async () => fresh,
    freshKalshiForGames: async () => kalshiForGames,
    market: async (t) => markets[t] ?? null,
    customGame: async (id) => custom[id] ?? null,
  };
}
const leg = (o) => ({ league: 'nfl', gameId: 'g1', marketType: 'spread', selection: 'away', line: -2.5, quotedAmerican: -110, ...o });

test('slip rules: singles, parlays, conflicts, minimum stake, balance', () => {
  const L = (gameId, marketType, selection, stakeCents) => ({ gameId, marketType, selection, stakeCents });
  assert.deepEqual(rules.slipProblems({ mode: 'singles', legs: [L('g1', 'moneyline', 'home', 100)] }), []);
  assert.match(rules.slipProblems({ mode: 'singles', legs: [L('g1', 'moneyline', 'home', 99)] })[0], /\$1\.00/);
  assert.match(rules.slipProblems({ mode: 'parlay', legs: [L('g1', 'moneyline', 'home')], stakeCents: 500 })[0], /at least 2/);
  assert.deepEqual(rules.slipProblems({ mode: 'parlay', legs: [L('g1', 'moneyline', 'home'), L('g1', 'total', 'over')], stakeCents: 500 }), [], 'same-game parlay ML + over allowed');
  assert.match(rules.slipProblems({ mode: 'parlay', legs: [L('g1', 'moneyline', 'home'), L('g1', 'moneyline', 'away')], stakeCents: 500 })[0], /one pick per game/);
  assert.match(rules.slipProblems({ mode: 'singles', legs: [L('g1', 'total', 'over', 100), L('g1', 'total', 'under', 100)] })[0], /one pick per game/);
  assert.match(rules.slipProblems({ mode: 'singles', legs: Array.from({ length: 11 }, (_, i) => L(`g${i}`, 'moneyline', 'home', 100)) })[0], /at most 10/);
  assert.match(rules.slipProblems({ mode: 'singles', legs: [L('g1', 'moneyline', 'home', 600)] }, { balanceCents: 500 }).at(-1), /more than your wallet/);
  assert.equal(rules.payoutCents(1000, 1.9091), 1909);
  assert.equal(rules.payoutCents(500, 2.5 * 1.9091), 2386);
  assert.equal(rules.pickLabel({ marketType: 'spread', selection: 'away', line: -2.5, homeName: 'Texans', awayName: 'Jaguars' }), 'Jaguars -2.5');
  assert.equal(rules.pickLabel({ marketType: 'total', selection: 'under', line: 42.5 }), 'Under 42.5');
  assert.ok(sameLine(-2.5, -2.5) && !sameLine(-2.5, -3) && sameLine(null, undefined));
});

test('Kalshi re-price quote: spread YES = favorite -strike, NO = underdog +strike', () => {
  const m = kalshiMarket('KXNFLSPREAD-26OCT18HOUJAC-JAC3', 2.5, 0.52, 0.49);
  assert.equal(quoteFromMarket(m, 'yes', 'spread').line, -2.5);
  assert.equal(quoteFromMarket(m, 'no', 'spread').line, 2.5);
  assert.equal(quoteFromMarket(m, 'yes', 'spread').american, -108);
  assert.equal(quoteFromMarket({ ...m, status: 'closed' }, 'yes', 'spread'), null);
});

test('pricing: pre-game ESPN — same line new price is ok, moved line is LINE_CHANGED', async () => {
  const fresh = game('g1', 'pre', marketsWith((m) => { m.spread.away = espnQ(-120, -2.5); m.spread.home = espnQ(100, 2.5); }));
  let r = await priceLeg(leg(), fakeCtx({ fresh: [fresh], board: [fresh] }));
  assert.equal(r.status, 'ok');
  assert.equal(r.quote.american, -120);
  const moved = game('g1', 'pre', marketsWith((m) => { m.spread.away = espnQ(-110, -3); }));
  r = await priceLeg(leg(), fakeCtx({ fresh: [moved], board: [moved] }));
  assert.equal(r.status, 'lineChanged');
  assert.equal(r.quote.line, -3);
  r = await priceLeg(leg({ marketType: 'moneyline', line: null, quotedAmerican: -140 }), fakeCtx({
    fresh: [game('g1', 'pre', marketsWith((m) => { m.moneyline.away = espnQ(-150); }))], board: [],
  }));
  assert.equal(r.status, 'ok', 'moneyline has no line to change');
  assert.equal(r.quote.american, -150);
});

test('pricing: pre-game Kalshi-filled market re-fetches the stored ticker', async () => {
  const boardGame = game('g1', 'pre', marketsWith((m) => { m.spread.away = kalQ(-108, -2.5, 'KXNFLSPREAD-26OCT18HOUJAC-JAC3', 'yes'); }));
  const fresh = game('g1', 'pre');
  const markets = { 'KXNFLSPREAD-26OCT18HOUJAC-JAC3': kalshiMarket('KXNFLSPREAD-26OCT18HOUJAC-JAC3', 2.5, 0.55, 0.46) };
  const r = await priceLeg(leg({ quotedAmerican: -108 }), fakeCtx({ fresh: [fresh], board: [boardGame], markets }));
  assert.equal(r.status, 'ok');
  assert.equal(r.quote.american, -122, 'fresh 0.55 ask');
  assert.equal(r.quote.ref.ticker, 'KXNFLSPREAD-26OCT18HOUJAC-JAC3');
});

test('pricing: ESPN leg whose game has started → Kalshi live line (different = LINE_CHANGED, none = MARKET_CLOSED)', async () => {
  const boardGame = game('g1', 'pre', marketsWith((m) => { m.spread.away = espnQ(-110, -2.5); })); // board still pre-game
  const fresh = game('g1', 'in');
  const liveDiff = new Map([['g1', marketsWith((m) => { m.spread.away = kalQ(-105, -6.5, 'T6', 'yes'); })]]);
  let r = await priceLeg(leg(), fakeCtx({ fresh: [fresh], board: [boardGame], kalshiForGames: liveDiff }));
  assert.equal(r.status, 'lineChanged');
  assert.equal(r.quote.line, -6.5);
  assert.equal(r.quote.source, 'kalshi');

  const liveSame = new Map([['g1', marketsWith((m) => { m.spread.away = kalQ(-130, -2.5, 'T3', 'yes'); })]]);
  r = await priceLeg(leg(), fakeCtx({ fresh: [fresh], board: [boardGame], kalshiForGames: liveSame }));
  assert.equal(r.status, 'ok');
  assert.equal(r.quote.american, -130);

  r = await priceLeg(leg(), fakeCtx({ fresh: [fresh], board: [boardGame], kalshiForGames: new Map() }));
  assert.equal(r.status, 'closed');
  assert.match(r.reason, /No live price/);
});

test('pricing: live Kalshi leg, finished game, missing game', async () => {
  const boardGame = game('g1', 'in', marketsWith((m) => { m.total.over = kalQ(-104, 42.5, 'KXNFLTOTAL-26OCT18HOUJAC-43', 'yes'); }));
  const t = 'KXNFLTOTAL-26OCT18HOUJAC-43';
  let r = await priceLeg(leg({ marketType: 'total', selection: 'over', line: 42.5 }), fakeCtx({ fresh: [game('g1', 'in')], board: [boardGame], markets: { [t]: kalshiMarket(t, 42.5, 0.6, 0.41) } }));
  assert.equal(r.status, 'ok');
  assert.equal(r.quote.line, 42.5);
  r = await priceLeg(leg({ marketType: 'total', selection: 'over', line: 42.5 }), fakeCtx({ fresh: [game('g1', 'in')], board: [boardGame], markets: { [t]: kalshiMarket(t, 42.5, 0.99, 0.02) } }));
  assert.equal(r.status, 'closed', 'untradable price');
  r = await priceLeg(leg(), fakeCtx({ fresh: [game('g1', 'post')], board: [] }));
  assert.equal(r.status, 'closed');
  assert.match(r.reason, /over/);
  r = await priceLeg(leg(), fakeCtx({ fresh: [], board: [] }));
  assert.equal(r.status, 'closed');
});

test('pricing: custom games close at the start time by the server clock', async () => {
  const start = new Date('2026-10-16T22:00:00Z');
  const doc = {
    league: 'nfl', startTime: { toDate: () => start }, status: 'scheduled',
    home: { name: 'Bears' }, away: { name: 'Pirates' },
    odds: { moneyline: { home: -150, away: 130 }, spread: { homeLine: -3.5, home: -110, away: -110 }, total: { line: 44.5, over: -110, under: -110 } },
  };
  const cLeg = leg({ gameId: 'custom:abc', marketType: 'spread', selection: 'home', line: -3.5 });
  let r = await priceLeg(cLeg, fakeCtx({ custom: { abc: doc }, now: new Date(start.getTime() - 60000) }));
  assert.equal(r.status, 'ok');
  r = await priceLeg(cLeg, fakeCtx({ custom: { abc: doc }, now: start }));
  assert.equal(r.status, 'closed');
  assert.match(r.reason, /start time/);
  r = await priceLeg(cLeg, fakeCtx({ custom: { abc: { ...doc, odds: { ...doc.odds, spread: { homeLine: -4.5, home: -110, away: -110 } } } }, now: new Date(start.getTime() - 60000) }));
  assert.equal(r.status, 'lineChanged', 'admin edited the line');
  r = await priceLeg(cLeg, fakeCtx({ custom: {}, now: new Date(start.getTime() - 60000) }));
  assert.equal(r.status, 'closed');
});

// ---------- placement ----------
function resetWallet(cents) {
  store.clear();
  store.set('users/u1', { username: 'mike', balanceCents: cents, disabled: false });
}
const twoGames = [
  game('g1', 'pre', marketsWith((m) => { m.spread.away = espnQ(-110, -2.5); m.moneyline.home = espnQ(150); m.total.over = espnQ(-110, 42.5); })),
  game('g2', 'pre', marketsWith((m) => { m.moneyline.away = espnQ(-200); })),
];
const ctxFor = (fresh = twoGames) => fakeCtx({ fresh, board: fresh });
const body = (o) => ({ mode: 'singles', clientRequestId: 'req-00000001', ...o });

test('placement: singles — fresh prices, stakes leave wallet, ledger entries, potential payouts', async () => {
  resetWallet(10000);
  const res = await placeBets(caller, body({
    legs: [
      { league: 'nfl', gameId: 'g1', marketType: 'spread', selection: 'away', line: -2.5, quotedAmerican: -105, stakeCents: 1000 },
      { league: 'nfl', gameId: 'g2', marketType: 'moneyline', selection: 'away', line: null, quotedAmerican: -200, stakeCents: 2000 },
    ],
  }), { ctx: ctxFor(), now: new Date('2026-10-16T20:00:00Z') });
  assert.equal(res.bets.length, 2);
  assert.equal(res.balanceCents, 7000);
  assert.equal(store.get('users/u1').balanceCents, 7000);
  const [b1, b2] = res.bets;
  assert.equal(b1.id, 'u1_req-00000001_1');
  assert.equal(b1.type, 'single');
  assert.equal(b1.status, 'open');
  assert.equal(b1.legs[0].label, 'Jaguars -2.5');
  assert.equal(b1.legs[0].gameLabel, 'Jaguars @ Texans');
  assert.equal(b1.legs[0].americanOdds, -110, 'placed at the fresh price');
  assert.equal(b1.potentialPayoutCents, 1909);
  assert.equal(b2.potentialPayoutCents, 3000);
  assert.deepEqual(res.priceChanges, [{ legId: 'nfl:g1:spread:away:-2.5:espn', from: -105, to: -110 }]);
  const stake1 = store.get('ledger/stake_u1_req-00000001_1');
  assert.equal(stake1.type, 'stake');
  assert.equal(stake1.amountCents, -1000);
  assert.equal(stake1.balanceAfterCents, 9000);
  assert.equal(store.get('ledger/stake_u1_req-00000001_2').balanceAfterCents, 7000);
  assert.equal(store.get('bets/u1_req-00000001_1').uid, 'u1');
});

test('placement: double submit with the same clientRequestId charges once', async () => {
  resetWallet(10000);
  const b = body({ clientRequestId: 'req-dup-0001', legs: [{ league: 'nfl', gameId: 'g2', marketType: 'moneyline', selection: 'away', line: null, quotedAmerican: -200, stakeCents: 1000 }] });
  const first = await placeBets(caller, b, { ctx: ctxFor() });
  const second = await placeBets(caller, b, { ctx: ctxFor() });
  assert.equal(second.duplicate, true);
  assert.equal(second.bets[0].id, first.bets[0].id);
  assert.equal(store.get('users/u1').balanceCents, 9000);
});

test('placement: same-game parlay pays at combined odds', async () => {
  resetWallet(5000);
  const res = await placeBets(caller, {
    mode: 'parlay', clientRequestId: 'req-parlay-01', stakeCents: 1000,
    legs: [
      { league: 'nfl', gameId: 'g1', marketType: 'moneyline', selection: 'home', line: null, quotedAmerican: 150 },
      { league: 'nfl', gameId: 'g1', marketType: 'total', selection: 'over', line: 42.5, quotedAmerican: -110 },
    ],
  }, { ctx: ctxFor() });
  assert.equal(res.bets.length, 1);
  const bet = res.bets[0];
  assert.equal(bet.id, 'u1_req-parlay-01');
  assert.equal(bet.type, 'parlay');
  assert.equal(bet.legs.length, 2);
  assert.equal(bet.potentialPayoutCents, Math.floor(1000 * 2.5 * 1.9091));
  assert.equal(bet.combinedAmerican, 377);
  assert.equal(store.get('users/u1').balanceCents, 4000);
  assert.equal(store.get('ledger/stake_u1_req-parlay-01').note, 'Parlay (2 legs)');
});

test('placement: LINE_CHANGED and MARKET_CLOSED place nothing and charge nothing', async () => {
  resetWallet(5000);
  const moved = [game('g1', 'pre', marketsWith((m) => { m.spread.away = espnQ(-110, -3); }))];
  await assert.rejects(
    placeBets(caller, body({ clientRequestId: 'req-line-0001', legs: [{ league: 'nfl', gameId: 'g1', marketType: 'spread', selection: 'away', line: -2.5, quotedAmerican: -110, stakeCents: 500 }] }), { ctx: ctxFor(moved) }),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'LINE_CHANGED');
      assert.deepEqual(err.extra.lineChanges.map((c) => [c.legId, c.oldLine, c.newLine, c.newAmerican]), [['nfl:g1:spread:away:-2.5', -2.5, -3, -110]]);
      assert.ok(err.extra.lineChanges[0].quote, 'new quote included so the slip can accept it');
      return true;
    },
  );
  assert.equal(store.get('users/u1').balanceCents, 5000);
  assert.equal(store.get('bets/u1_req-line-0001_1'), undefined);

  await assert.rejects(
    placeBets(caller, body({ clientRequestId: 'req-closed-01', legs: [{ league: 'nfl', gameId: 'g1', marketType: 'spread', selection: 'away', line: -2.5, quotedAmerican: -110, stakeCents: 500 }] }), { ctx: ctxFor([game('g1', 'post')]) }),
    (err) => err.code === 'MARKET_CLOSED' && err.extra.closedLegs.length === 1,
  );
  assert.equal(store.get('users/u1').balanceCents, 5000);
});

test('placement: insufficient balance, bad slips, source errors', async () => {
  resetWallet(500);
  await assert.rejects(
    placeBets(caller, body({ clientRequestId: 'req-broke-001', legs: [{ league: 'nfl', gameId: 'g2', marketType: 'moneyline', selection: 'away', line: null, quotedAmerican: -200, stakeCents: 600 }] }), { ctx: ctxFor() }),
    (err) => err.code === 'INSUFFICIENT_BALANCE',
  );
  assert.equal(store.get('users/u1').balanceCents, 500);

  const bad = (b) => assert.rejects(placeBets(caller, b, { ctx: ctxFor() }), (err) => err.status === 400);
  await bad({ mode: 'parlay', clientRequestId: 'req-bad-00001', stakeCents: 100, legs: [{ league: 'nfl', gameId: 'g1', marketType: 'moneyline', selection: 'home', line: null, quotedAmerican: 150 }] });
  await bad(body({ legs: [{ league: 'nfl', gameId: 'g1', marketType: 'moneyline', selection: 'home', line: null, quotedAmerican: 150, stakeCents: 50 }] }));
  await bad(body({ legs: [
    { league: 'nfl', gameId: 'g1', marketType: 'moneyline', selection: 'home', line: null, quotedAmerican: 150, stakeCents: 100 },
    { league: 'nfl', gameId: 'g1', marketType: 'moneyline', selection: 'away', line: null, quotedAmerican: -170, stakeCents: 100 },
  ] }));
  await bad(body({ clientRequestId: 'x', legs: [{ league: 'nfl', gameId: 'g1', marketType: 'moneyline', selection: 'home', line: null, quotedAmerican: 150, stakeCents: 100 }] }));
  await bad(body({ legs: [{ league: 'xfl', gameId: 'g1', marketType: 'moneyline', selection: 'home', line: null, quotedAmerican: 150, stakeCents: 100 }] }));
  await bad(body({ legs: [{ league: 'nfl', gameId: 'g1', marketType: 'total', selection: 'home', line: 40, quotedAmerican: 150, stakeCents: 100 }] }));

  resetWallet(5000);
  const failingCtx = { ...ctxFor(), freshEspnGames: async () => { throw new Error('ESPN down'); } };
  await assert.rejects(
    placeBets(caller, body({ clientRequestId: 'req-down-0001', legs: [{ league: 'nfl', gameId: 'g2', marketType: 'moneyline', selection: 'away', line: null, quotedAmerican: -200, stakeCents: 100 }] }), { ctx: failingCtx }),
    (err) => err.code === 'MARKET_CLOSED' && /odds source/.test(err.message),
  );
  assert.equal(store.get('users/u1').balanceCents, 5000);
});

test('/api/bets: POST only, sign-in required', async () => {
  const handler = (await import(url('api/bets.js'))).default;
  const res = () => ({ statusCode: 200, headers: {}, body: null, headersSent: false, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } });
  let r = res(); await handler({ method: 'GET', headers: {} }, r);
  assert.equal(r.statusCode, 405);
  const saved = caller; caller = null;
  r = res(); await handler({ method: 'POST', body: {}, headers: {} }, r);
  assert.equal(r.statusCode, 401);
  caller = saved;
  r = res(); await handler({ method: 'POST', body: { mode: 'singles', legs: [] }, headers: {} }, r);
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error.code, 'BAD_SLIP');
});

test('bet slip reducer: toggle, switch side, limits, parlay mode, server flags, accept', () => {
  const g = (id) => ({ id, league: 'nfl', home: { shortName: 'Texans' }, away: { shortName: 'Jaguars' } });
  const q = (am, line = null) => ({ american: am, decimal: am > 0 ? 1 + am / 100 : 1 + 100 / -am, line, source: 'espn' });
  let s = red.initialSlipState;
  const awaySpread = red.makePick(g('g1'), 'spread', 'away', q(-110, -2.5));
  s = red.betSlipReducer(s, { type: 'toggle', pick: awaySpread });
  assert.equal(s.legs.length, 1);
  assert.equal(s.legs[0].label, 'Jaguars -2.5');
  s = red.betSlipReducer(s, { type: 'setStake', legId: awaySpread.legId, value: '10' });
  const homeSpread = red.makePick(g('g1'), 'spread', 'home', q(-110, 2.5));
  s = red.betSlipReducer(s, { type: 'toggle', pick: homeSpread });
  assert.deepEqual(s.legs.map((l) => l.legId), [homeSpread.legId], 'other side replaces the pick');
  assert.equal(s.legs[0].stake, '10', 'stake carried over');
  s = red.betSlipReducer(s, { type: 'toggle', pick: homeSpread });
  assert.equal(s.legs.length, 0, 'tapping again removes');

  for (let i = 0; i < 10; i += 1) s = red.betSlipReducer(s, { type: 'toggle', pick: red.makePick(g(`g${i}`), 'moneyline', 'home', q(120)) });
  assert.equal(s.legs.length, 10);
  s = red.betSlipReducer(s, { type: 'toggle', pick: red.makePick(g('g99'), 'moneyline', 'home', q(120)) });
  assert.equal(s.legs.length, 10);
  assert.match(s.notice, /at most 10/);

  s = red.betSlipReducer(red.initialSlipState, { type: 'toggle', pick: awaySpread });
  s = red.betSlipReducer(s, { type: 'setMode', mode: 'parlay' });
  assert.equal(s.mode, 'singles', 'parlay needs 2 picks');
  const over = red.makePick(g('g1'), 'total', 'over', q(-110, 42.5));
  s = red.betSlipReducer(s, { type: 'toggle', pick: over });
  s = red.betSlipReducer(s, { type: 'setMode', mode: 'parlay' });
  assert.equal(s.mode, 'parlay');

  s = red.betSlipReducer(s, {
    type: 'serverRejected',
    lineChanges: [{ legId: awaySpread.legId, oldLine: -2.5, newLine: -3, newAmerican: -105, quote: q(-105, -3) }],
    closedLegs: [{ legId: over.legId, reason: 'This game is over.' }],
  });
  assert.equal(s.legs.find((l) => l.legId === awaySpread.legId).flag.type, 'lineChanged');
  assert.equal(s.legs.find((l) => l.legId === over.legId).flag.type, 'closed');
  s = red.betSlipReducer(s, { type: 'accept', legId: awaySpread.legId });
  const accepted = s.legs.find((l) => l.marketType === 'spread');
  assert.equal(accepted.legId, 'nfl:g1:spread:away:-3:espn', 'accepting a new line gives the pick a new id');
  assert.equal(accepted.flag, null);
  assert.equal(accepted.line, -3);
  assert.equal(accepted.american, -105);
  assert.equal(accepted.label, 'Jaguars -3');
  s = red.betSlipReducer(s, { type: 'remove', legId: over.legId });
  assert.equal(s.mode, 'singles', 'dropping below 2 picks leaves parlay mode');
  assert.equal(red.betSlipReducer(s, { type: 'clear' }).legs.length, 0);
  assert.equal(red.betSlipReducer(s, { type: 'nonsense' }), s);
});
