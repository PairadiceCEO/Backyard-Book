// npm run test:casino  (or: node --experimental-test-module-mocks test/casino/casino1.test.mjs)
// Casino phase 1: the slot's exact RTP, spins (money, ledger, idempotency, limits), and /api/casino.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;

// ---------- fake Firestore with optimistic transactions (interleaving + retry on conflict) ----------
const store = new Map();
const versions = new Map();
let clock = 0;
const clone = (v) => {
  if (v === null || typeof v !== 'object') return v;
  if (typeof v.toMillis === 'function') return v;
  if (Array.isArray(v)) return v.map(clone);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
};
const tick = () => new Promise((r) => setImmediate(r));
function write(path, data) { store.set(path, clone(data)); versions.set(path, ++clock); }
function snap(path) { const d = store.get(path); return { exists: d !== undefined, id: path.split('/').pop(), data: () => clone(d) }; }
const ref = (path) => ({ path, id: path.split('/').pop(), async get() { await tick(); return snap(path); } });
class AlreadyExists extends Error { constructor() { super('ALREADY_EXISTS'); this.code = 6; } }
let commits = 0;
const fakeDb = {
  collection: (name) => ({ doc: (id) => ref(`${name}/${id}`) }),
  async runTransaction(fn) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const reads = new Map();
      const ops = [];
      const tx = {
        get: async (r) => { reads.set(r.path, versions.get(r.path) ?? 0); await tick(); return snap(r.path); },
        getAll: async (...rs) => { for (const r of rs) reads.set(r.path, versions.get(r.path) ?? 0); await tick(); return rs.map((r) => snap(r.path)); },
        create: (r, d) => ops.push(['create', r.path, d]),
        update: (r, d) => ops.push(['update', r.path, d]),
        set: (r, d) => ops.push(['set', r.path, d]),
      };
      const result = await fn(tx);
      await tick();
      if ([...reads].some(([p, v]) => (versions.get(p) ?? 0) !== v)) continue;
      for (const [k, p] of ops) if (k === 'create' && store.has(p)) throw new AlreadyExists();
      for (const [k, p, d] of ops) write(p, k === 'update' ? { ...store.get(p), ...d } : d);
      commits += 1;
      return result;
    }
    throw new Error('contention');
  },
};
const TOKENS = { 'mike-token': { uid: 'u1' }, 'gone-token': { uid: 'u9' } };
mock.module(url('server/firebaseAdmin.js'), {
  namedExports: {
    adminDb: () => fakeDb,
    adminAuth: () => ({ async verifyIdToken(t) { if (!TOKENS[t]) throw new Error('bad'); return { ...TOKENS[t] }; } }),
    normalizePrivateKey: (k) => k,
  },
});

const slot = await import(url('shared/casino/slotMachine.js'));
const { spinSlots } = await import(url('server/casino/slots.js'));
const { applyCasinoEntries } = await import(url('server/casino/money.js'));
const { groupShopPurchases } = await import(url('src/lib/shopHistory.js'));
const handler = (await import(url('api/casino.js'))).default;

function seed(balanceCents = 10000) {
  store.clear(); versions.clear();
  write('users/u1', { username: 'mike', balanceCents, stats: { won: 3, lost: 2 }, disabled: false });
  write('users/u9', { username: 'gone', balanceCents: 5000, disabled: true });
}
const ledger = () => [...store].filter(([k]) => k.startsWith('ledger/')).map(([k, v]) => ({ id: k.slice(7), ...v }));
const stopOf = (reel, symbol) => slot.REELS[reel].indexOf(symbol);
const fixed = (stops) => { let i = 0; const calls = []; const fn = (max) => { calls.push(max); return stops[i++ % stops.length]; }; fn.calls = calls; return fn; };
const caller = { uid: 'u1', token: {}, user: { username: 'mike' } };

// ---------- the slot itself ----------
test('RTP is exactly 29,493 / 32,768 (90.0055%) over every stop combination, inside 89.5–90.5%', () => {
  const { returned, combos, hits } = slot.computeRtp();
  assert.equal(combos, 32 ** 3);
  assert.equal(returned, 29493);
  const rtp = returned / combos;
  assert.ok(rtp >= 0.895 && rtp <= 0.905, `RTP ${rtp} out of range`);
  assert.deepEqual(hits, { red7x3: 4, blue7x3: 18, bar3x3: 27, bar2x3: 32, any7: 58, cherryx3: 10, bar1x3: 72, anybar: 1013, cherry2: 514, cherry1: 7134 });
});

test('reel strips match the plan: 32 stops, symbol counts per reel', () => {
  const count = (reel) => slot.REELS[reel].reduce((m, s) => ({ ...m, [s]: (m[s] ?? 0) + 1 }), {});
  assert.deepEqual(count(0), { R7: 1, B7: 3, BAR3: 3, BAR2: 4, BAR1: 4, CH: 5, BL: 12 });
  assert.deepEqual(count(1), { R7: 2, B7: 2, BAR3: 3, BAR2: 4, BAR1: 6, CH: 2, BL: 13 });
  assert.deepEqual(count(2), { R7: 2, B7: 3, BAR3: 3, BAR2: 2, BAR1: 3, CH: 1, BL: 18 });
  slot.REELS.forEach((r) => assert.equal(r.length, 32));
});

test('paytable precedence: only the highest line pays', () => {
  const w = (a, b, c) => slot.lineWin([a, b, c])?.id ?? null;
  assert.equal(w('R7', 'R7', 'R7'), 'red7x3');
  assert.equal(w('B7', 'B7', 'B7'), 'blue7x3');
  assert.equal(w('R7', 'B7', 'R7'), 'any7');
  assert.equal(w('BAR3', 'BAR3', 'BAR3'), 'bar3x3');
  assert.equal(w('BAR1', 'BAR1', 'BAR1'), 'bar1x3');
  assert.equal(w('BAR3', 'BAR1', 'BAR2'), 'anybar');
  assert.equal(w('CH', 'CH', 'CH'), 'cherryx3');
  assert.equal(w('CH', 'BL', 'CH'), 'cherry2');
  assert.equal(w('BL', 'BL', 'CH'), 'cherry1');
  assert.equal(w('BAR3', 'BAR3', 'CH'), 'cherry1');
  assert.equal(w('R7', 'R7', 'BL'), null);
  assert.equal(w('BL', 'BL', 'BL'), null);
  assert.equal(slot.symbolAt(0, -1), slot.REELS[0][31], 'wraps');
});

// ---------- spins ----------
test('a winning spin: one transaction debits the bet, credits bet × pays, writes both ledger entries', async () => {
  seed(10000);
  const rng = fixed([stopOf(0, 'R7'), stopOf(1, 'R7'), stopOf(2, 'R7')]);
  const r = await spinSlots(caller, { amount: 2, requestId: 'spin-0000001' }, { randomInt: rng });
  assert.deepEqual(rng.calls, [32, 32, 32], 'one crypto draw per reel, 0–31');
  assert.deepEqual(r.symbols, ['R7', 'R7', 'R7']);
  assert.equal(r.winCents, 60000, '$2 × 300');
  assert.equal(r.balanceCents, 10000 - 200 + 60000);
  assert.equal(store.get('users/u1').balanceCents, 69800);
  assert.deepEqual(store.get('users/u1').stats, { won: 3, lost: 2 }, 'win rate stays sportsbook-only');
  const bet = store.get('ledger/cbet_u1_spin-0000001');
  const pay = store.get('ledger/cpay_slots_u1_spin-0000001');
  assert.deepEqual([bet.type, bet.amountCents, bet.balanceAfterCents, bet.game], ['casino_bet', -200, 9800, 'slots']);
  assert.deepEqual(bet.spin.stops, r.stops);
  assert.deepEqual([pay.type, pay.amountCents, pay.balanceAfterCents], ['casino_payout', 60000, 69800]);
});

test('a losing spin only debits; no payout entry', async () => {
  seed(10000);
  const r = await spinSlots(caller, { amount: 10, requestId: 'spin-0000002' }, { randomInt: fixed([stopOf(0, 'BL'), stopOf(1, 'BL'), stopOf(2, 'BL')]) });
  assert.equal(r.winCents, 0);
  assert.equal(store.get('users/u1').balanceCents, 9000);
  assert.equal(ledger().length, 1);
});

test('the same request twice (double tap / retry) replays the first result and charges once', async () => {
  seed(10000);
  const rng = fixed([stopOf(0, 'CH'), stopOf(1, 'BL'), stopOf(2, 'BL')]);
  const a = await spinSlots(caller, { amount: 1, requestId: 'spin-dup-0001' }, { randomInt: rng });
  const b = await spinSlots(caller, { amount: 1, requestId: 'spin-dup-0001' }, { randomInt: fixed([0, 0, 0]) });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.deepEqual(b.stops, a.stops, 'same reels shown');
  assert.equal(store.get('users/u1').balanceCents, 10000 - 100 + 200, 'charged and paid once');
  assert.equal(ledger().length, 2);
  // Two simultaneous taps with the same id: still one spin.
  const [c, d] = await Promise.all([
    spinSlots(caller, { amount: 1, requestId: 'spin-dup-0002' }, { randomInt: fixed([3, 3, 3]) }),
    spinSlots(caller, { amount: 1, requestId: 'spin-dup-0002' }, { randomInt: fixed([4, 4, 4]) }),
  ].map((p) => p.catch((e) => e)));
  const ok = [c, d].filter((x) => x && x.ok);
  assert.ok(ok.length >= 1);
  assert.equal(ledger().filter((e) => e.id.includes('spin-dup-0002')).length >= 1, true);
  assert.equal(ledger().filter((e) => e.id === 'cbet_u1_spin-dup-0002').length, 1, 'one bet entry');
});

test('limits and wallet checks: $1–$10 whole dollars; never below $0; concurrent spins can\'t overdraw', async () => {
  seed(10000);
  for (const amount of [0, 11, 2.5, '5', -1, null]) {
    await assert.rejects(spinSlots(caller, { amount, requestId: 'spin-bad-001' }), (e) => e.code === 'BAD_BET', `amount ${amount}`);
  }
  await assert.rejects(spinSlots(caller, { amount: 1 }), (e) => e.code === 'BAD_REQUEST_ID');
  seed(150);
  await assert.rejects(spinSlots(caller, { amount: 2, requestId: 'spin-poor-01' }), (e) => e.code === 'INSUFFICIENT_BALANCE');
  assert.equal(store.get('users/u1').balanceCents, 150);
  assert.equal(ledger().length, 0, 'nothing written');
  // $1.50 in the wallet, two $1 losing spins at once: only one can be paid for.
  const lose = () => fixed([stopOf(0, 'BL'), stopOf(1, 'BL'), stopOf(2, 'BL')]);
  const results = await Promise.all([
    spinSlots(caller, { amount: 1, requestId: 'spin-race-01' }, { randomInt: lose() }).catch((e) => e),
    spinSlots(caller, { amount: 1, requestId: 'spin-race-02' }, { randomInt: lose() }).catch((e) => e),
  ]);
  assert.equal(results.filter((x) => x.ok).length, 1);
  assert.equal(results.filter((x) => x.code === 'INSUFFICIENT_BALANCE').length, 1);
  assert.equal(store.get('users/u1').balanceCents, 50);
});

test('money helper refuses unknown types and overdrafts without writing anything', () => {
  const ops = [];
  const tx = { create: (r, d) => ops.push(r.path), update: (r) => ops.push(r.path) };
  assert.throws(() => applyCasinoEntries(tx, fakeDb, { uid: 'u1', balanceCents: 100, entries: [{ id: 'x', type: 'shop', amountCents: 5 }] }), /unknown casino ledger type/);
  assert.throws(() => applyCasinoEntries(tx, fakeDb, { uid: 'u1', balanceCents: 100, entries: [{ id: 'x', type: 'casino_bet', amountCents: -200, game: 'slots' }] }), (e) => e.code === 'INSUFFICIENT_BALANCE');
  assert.equal(ops.length, 0);
});

test('casino ledger entries never show in Admin → Shop purchases', () => {
  const entries = [
    { id: 'shop_1', uid: 'u1', type: 'shop', amountCents: 2500, createdAt: '2026-10-16T20:00:00Z' },
    { id: 'cbet_u1_x', uid: 'u1', type: 'casino_bet', amountCents: -200, createdAt: '2026-10-16T20:01:00Z' },
    { id: 'cpay_slots_u1_x', uid: 'u1', type: 'casino_payout', amountCents: 60000, createdAt: '2026-10-16T20:01:00Z' },
    { id: 'cref_x', uid: 'u1', type: 'casino_refund', amountCents: 500, createdAt: '2026-10-16T20:02:00Z' },
  ];
  const g = groupShopPurchases(entries, [{ id: 'u1', username: 'mike' }]);
  assert.equal(g.totalCount, 1);
  assert.equal(g.totalCents, 2500);
});

// ---------- /api/casino ----------
const res = () => ({ statusCode: 200, headers: {}, body: null, headersSent: false, setHeader(a, b) { this.headers[a] = b; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } });
const call = async (token, body, method = 'POST') => { const r = res(); await handler({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, body }, r); return r; };

test('/api/casino: sign-in required, disabled refused, spin works, tables not open yet', async () => {
  seed(10000);
  assert.equal((await call(null, { action: 'spin', amount: 1, requestId: 'api-spin-0001' })).statusCode, 401);
  assert.equal((await call('gone-token', { action: 'spin', amount: 1, requestId: 'api-spin-0001' })).statusCode, 403);
  assert.equal((await call('mike-token', { action: 'spin' }, 'GET')).statusCode, 405);
  const r = await call('mike-token', { action: 'spin', amount: 1, requestId: 'api-spin-0001' });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.stops.length, 3);
  r.body.stops.forEach((s) => assert.ok(Number.isInteger(s) && s >= 0 && s < 32));
  assert.ok(Number.isFinite(r.body.serverNow));
  assert.equal(store.get('users/u1').balanceCents, 10000 - 100 + r.body.winCents);
  const sit = await call('mike-token', { action: 'sit', game: 'roulette', seat: 0 });
  assert.equal(sit.statusCode, 400);
  assert.equal(sit.body.error.code, 'BAD_GAME', 'every table is open; unknown games are refused');
  const unknown = await call('mike-token', { action: 'cheat' });
  assert.equal(unknown.body.error.code, 'UNKNOWN_ACTION');
});

test('real crypto draws: 3,000 spins land on every stop and keep money consistent', async () => {
  seed(10_000_000);
  const seen = [new Set(), new Set(), new Set()];
  let paid = 0;
  for (let i = 0; i < 3000; i += 1) {
    const r = await spinSlots(caller, { amount: 1, requestId: `spin-many-${String(i).padStart(5, '0')}` });
    r.stops.forEach((s, j) => seen[j].add(s));
    paid += r.winCents;
  }
  seen.forEach((s) => assert.equal(s.size, 32, 'all 32 stops reachable'));
  assert.equal(store.get('users/u1').balanceCents, 10_000_000 - 300000 + paid);
  const sum = ledger().reduce((s, e) => s + e.amountCents, 0);
  assert.equal(sum, paid - 300000, 'ledger adds up');
});
