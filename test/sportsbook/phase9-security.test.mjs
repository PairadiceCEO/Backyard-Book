// npm run test:sportsbook  (or: node --experimental-test-module-mocks test/sportsbook/phase9-security.test.mjs)
// Uses the REAL server/auth.js: tokens are checked, admin claim required, disabled players refused.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;

// ---------- fake Firestore + Auth ----------
const store = new Map();
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const snap = (path) => ({ exists: store.has(path), id: path.split('/').pop(), data: () => clone(store.get(path)) });
const ref = (path) => ({
  path, id: path.split('/').pop(),
  async get() { return snap(path); },
  async set(v) { store.set(path, clone(v)); },
  async update(v) { store.set(path, { ...store.get(path), ...clone(v) }); },
  async delete() { store.delete(path); },
});
const query = (name) => ({
  where: () => query(name), limit: () => query(name), orderBy: () => query(name),
  async get() { const docs = [...store.keys()].filter((k) => k.startsWith(`${name}/`)).map(snap); return { docs, empty: docs.length === 0, size: docs.length, forEach: (f) => docs.forEach(f) }; },
});
const fakeDb = {
  collection: (name) => ({ doc: (id) => ref(`${name}/${id ?? 'auto'}`), where: () => query(name), limit: () => query(name), orderBy: () => query(name) }),
  doc: (path) => ref(path),
  batch() { const ops = []; return { create: (r, d) => ops.push([r, d]), set: (r, d) => ops.push([r, d]), async commit() { ops.forEach(([r, d]) => store.set(r.path, clone(d))); } }; },
  async runTransaction(fn) {
    const ops = [];
    const tx = { get: async (r) => snap(r.path), create: (r, d) => ops.push([r, d]), set: (r, d) => ops.push([r, d]), update: (r, d) => ops.push([r, { ...store.get(r.path), ...d }]), delete: (r) => ops.push([r, undefined]) };
    const out = await fn(tx);
    ops.forEach(([r, d]) => (d === undefined ? store.delete(r.path) : store.set(r.path, clone(d))));
    return out;
  },
};
const TOKENS = {
  'player-token': { uid: 'u1' },
  'admin-token': { uid: 'u0', admin: true },
  'disabled-token': { uid: 'u2' },
  'forged-admin': { uid: 'u1', admin: 'true' }, // claim must be boolean true
};
const fakeAuth = {
  async verifyIdToken(token) {
    if (!TOKENS[token]) throw Object.assign(new Error('bad'), { code: 'auth/argument-error' });
    return { ...TOKENS[token] };
  },
  async updateUser() { throw new Error('auth write should never be reached by a player'); },
  async createUser() { throw new Error('auth write should never be reached by a player'); },
  async revokeRefreshTokens() {},
};
mock.module(url('server/firebaseAdmin.js'), { namedExports: { adminDb: () => fakeDb, adminAuth: () => fakeAuth, normalizePrivateKey: (k) => k } });

function seed() {
  store.clear();
  store.set('users/u0', { username: 'will', role: 'admin', balanceCents: 1000, stats: { won: 0, lost: 0 }, disabled: false });
  store.set('users/u1', { username: 'mike', role: 'player', balanceCents: 500, stats: { won: 0, lost: 0 }, disabled: false });
  store.set('users/u2', { username: 'gone', role: 'player', balanceCents: 500, stats: { won: 0, lost: 0 }, disabled: true });
  store.set('bets/b0', { uid: 'u0', status: 'lost', type: 'single', stakeCents: 100, payoutCents: 0, version: 1, legs: [{ label: 'x', result: 'loss', decimalOdds: 2 }] });
  store.set('customGames/g1', { league: 'nfl', status: 'scheduled', betCount: 0, home: { name: 'A', abbr: 'A' }, away: { name: 'B', abbr: 'B' } });
  store.set('meta/setup', { status: 'done' });
}
const dump = () => JSON.stringify([...store].filter(([k]) => !k.startsWith('cache/') && !k.startsWith('meta/settlement')).sort());

const handlers = {
  admin: (await import(url('api/admin.js'))).default,
  bets: (await import(url('api/bets.js'))).default,
  shop: (await import(url('api/shop.js'))).default,
  board: (await import(url('api/board.js'))).default,
  settle: (await import(url('api/settle.js'))).default,
};
const res = () => ({ statusCode: 200, headers: {}, body: null, headersSent: false, setHeader(a, b) { this.headers[a] = b; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } });
async function call(name, { method = 'POST', token = null, body = {}, query = {} } = {}) {
  const r = res();
  await handlers[name]({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, body, query, url: `/api/${name}` }, r);
  return r;
}

const ADMIN_ACTIONS = [
  ['ping', {}],
  ['createUser', { username: 'evil', password: 'password1', startingBalanceCents: 100000000 }],
  ['updateUser', { uid: 'u0', displayName: 'pwned' }],
  ['setDisabled', { uid: 'u0', disabled: true }],
  ['resetPassword', { uid: 'u0', newPassword: 'password1' }],
  ['adjustWallet', { uid: 'u1', deltaCents: 1000000 }],
  ['gradeBet', { betId: 'b0', outcome: 'win', confirm: true, expectedVersion: 1 }],
  ['setLegResult', { betId: 'b0', legIndex: 0, result: 'win', confirm: true, expectedVersion: 1 }],
  ['createCustomGame', { league: 'nfl' }],
  ['updateCustomGame', { gameId: 'custom:g1' }],
  ['finalizeCustomGame', { gameId: 'custom:g1', homeScore: 1, awayScore: 0, confirm: true }],
  ['cancelCustomGame', { gameId: 'custom:g1', confirm: true }],
  ['deleteCustomGame', { gameId: 'custom:g1' }],
];

test('players cannot call any admin action (and a forged claim fails too); nothing changes', async () => {
  seed();
  const before = dump();
  for (const token of ['player-token', 'forged-admin']) {
    for (const [action, fields] of ADMIN_ACTIONS) {
      const r = await call('admin', { token, body: { action, ...fields } });
      assert.equal(r.statusCode, 403, `${token} ${action}`);
      assert.equal(r.body.error.code, 'NOT_ADMIN');
    }
  }
  for (const [action, fields] of ADMIN_ACTIONS) {
    const r = await call('admin', { body: { action, ...fields } });
    assert.equal(r.statusCode, 401, `no token ${action}`);
  }
  assert.equal(dump(), before, 'no document changed');
  const ok = await call('admin', { token: 'admin-token', body: { action: 'ping' } });
  assert.equal(ok.statusCode, 200, 'the real admin still gets in');
});

test('setup cannot be re-run to mint a second admin', async () => {
  seed();
  process.env.SETUP_SECRET = 'right-secret';
  let r = await call('admin', { body: { action: 'bootstrap', setupSecret: 'wrong', username: 'evil', password: 'password1' } });
  assert.equal(r.statusCode, 401);
  r = await call('admin', { body: { action: 'bootstrap', setupSecret: 'right-secret', username: 'evil', password: 'password1' } });
  assert.equal(r.statusCode, 409, 'already set up');
  assert.equal(r.body.error.code, 'ALREADY_SET_UP');
  delete process.env.SETUP_SECRET;
});

test('every endpoint needs a valid sign-in; disabled players are refused', async () => {
  seed();
  for (const [name, method, body, query] of [
    ['bets', 'POST', { mode: 'singles', legs: [] }, {}],
    ['shop', 'POST', { amount: 5 }, {}],
    ['board', 'GET', {}, { league: 'nfl' }],
    ['settle', 'POST', {}, {}],
  ]) {
    let r = await call(name, { method, body, query });
    assert.equal(r.statusCode, 401, `${name} without token`);
    r = await call(name, { method, body, query, token: 'garbage' });
    assert.equal(r.statusCode, 401, `${name} with a bad token`);
    r = await call(name, { method, body, query, token: 'disabled-token' });
    assert.equal(r.statusCode, 403, `${name} disabled`);
    assert.equal(r.body.error.code, 'ACCOUNT_DISABLED');
  }
});

test('players can only add the fixed shop amounts, only to their own wallet', async () => {
  seed();
  for (const amount of [1000, -5, 0, '5; drop', 4.99]) {
    const r = await call('shop', { token: 'player-token', body: { amount } });
    assert.equal(r.statusCode, 400, `amount ${amount}`);
  }
  const r = await call('shop', { token: 'player-token', body: { amount: 25, uid: 'u0', clientRequestId: 'abcdefgh1' } });
  assert.equal(r.statusCode, 200);
  assert.equal(store.get('users/u1').balanceCents, 3000, 'own wallet');
  assert.equal(store.get('users/u0').balanceCents, 1000, 'a uid in the body is ignored');
  const again = await call('shop', { token: 'player-token', body: { amount: 25, clientRequestId: 'abcdefgh1' } });
  assert.equal(again.body.duplicate, true);
  assert.equal(store.get('users/u1').balanceCents, 3000, 'double tap counted once');
});

test('settle: players get the normal run only; force/preview need admin; cron needs its secret', async () => {
  seed();
  for (const body of [{ force: true }, { preview: true }]) {
    const r = await call('settle', { token: 'player-token', body });
    assert.equal(r.statusCode, 403, JSON.stringify(body));
  }
  process.env.CRON_SECRET = 'cron-123';
  assert.equal((await call('settle', { method: 'GET' })).statusCode, 401);
  assert.equal((await call('settle', { method: 'GET', token: 'player-token' })).statusCode, 401, "a player's token isn't the cron secret");
  delete process.env.CRON_SECRET;
});

test('placing a bet always uses the signed-in player, never one named in the request', async () => {
  seed();
  const r = await call('bets', { token: 'player-token', body: { uid: 'u0', mode: 'singles', clientRequestId: 'req-xyz-000001', legs: [{ league: 'nfl', gameId: 'custom:g1', marketType: 'moneyline', selection: 'home', line: null, quotedAmerican: -150, stakeCents: 100 }] } });
  // The game has no odds, so it's refused — but nothing may touch anyone else's wallet or bets either way.
  assert.ok(r.statusCode >= 400);
  assert.equal(store.get('users/u0').balanceCents, 1000);
  assert.ok(![...store.keys()].some((k) => k.startsWith('bets/u0_')), 'no bet created for another player');
});
