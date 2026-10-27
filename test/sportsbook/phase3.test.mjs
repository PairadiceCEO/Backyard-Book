// Run: node --experimental-test-module-mocks phase3-test.mjs <project root>
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;

// ---------- Fake Firestore (enough for transactions, batches, gets, updates) ----------
const store = new Map(); // path -> data
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
function alreadyExists(path) {
  const e = new Error(`ALREADY_EXISTS: ${path}`);
  e.code = 6;
  return e;
}
function makeRef(path) {
  return {
    path,
    async get() { return snap(path); },
    async update(data) {
      if (!store.has(path)) throw new Error(`NOT_FOUND ${path}`);
      store.set(path, { ...store.get(path), ...clone(data) });
    },
    async delete() { store.delete(path); },
  };
}
function snap(path) {
  const data = store.get(path);
  return { exists: data !== undefined, id: path.split('/').pop(), data: () => clone(data) };
}
function applyOps(ops) {
  for (const op of ops) if (op.kind === 'create' && store.has(op.path)) throw alreadyExists(op.path);
  for (const op of ops) {
    if (op.kind === 'update') store.set(op.path, { ...store.get(op.path), ...op.data });
    else store.set(op.path, op.data);
  }
}
function writer() {
  const ops = [];
  return {
    ops,
    create(ref, data) { ops.push({ kind: 'create', path: ref.path, data: clone(data) }); return this; },
    set(ref, data) { ops.push({ kind: 'set', path: ref.path, data: clone(data) }); return this; },
    update(ref, data) { ops.push({ kind: 'update', path: ref.path, data: clone(data) }); return this; },
  };
}
const fakeDb = {
  collection(name) {
    return {
      doc: (id) => makeRef(`${name}/${id}`),
      where: (field, _op, value) => ({
        limit: () => ({
          async get() {
            const hits = [...store.entries()].filter(([p, d]) => p.startsWith(`${name}/`) && d[field] === value);
            return { empty: hits.length === 0 };
          },
        }),
      }),
    };
  },
  doc: (path) => makeRef(path),
  batch() {
    const w = writer();
    return { ...w, create: w.create, set: w.set, update: w.update, async commit() { applyOps(w.ops); } };
  },
  async runTransaction(fn) {
    const w = writer();
    const tx = { get: async (ref) => snap(ref.path), create: w.create, set: w.set, update: w.update };
    const result = await fn(tx);
    applyOps(w.ops);
    return result;
  },
};

// ---------- Fake Auth ----------
const authCalls = [];
let nextUid = 1;
const fakeAuth = {
  async createUser(props) {
    authCalls.push(['createUser', props.email]);
    if ([...store.values()].some((d) => d.__email === props.email)) {
      const e = new Error('exists'); e.code = 'auth/email-already-exists'; throw e;
    }
    return { uid: `u${nextUid++}` };
  },
  async updateUser(uid, props) { authCalls.push(['updateUser', uid, props]); },
  async revokeRefreshTokens(uid) { authCalls.push(['revoke', uid]); },
  async deleteUser(uid) { authCalls.push(['deleteUser', uid]); },
  async setCustomUserClaims() {},
};

mock.module(url('server/firebaseAdmin.js'), {
  namedExports: { adminDb: () => fakeDb, adminAuth: () => fakeAuth, normalizePrivateKey: (k) => k },
});

// Signed-in caller identity is controlled per test.
let caller = null;
mock.module(url('server/auth.js'), {
  namedExports: {
    requireUser: async () => {
      if (!caller) { const { HttpError } = await import(url('server/http.js')); throw new HttpError(401, 'NOT_SIGNED_IN', 'x'); }
      return caller;
    },
    requireAdmin: async () => {
      const { HttpError } = await import(url('server/http.js'));
      if (!caller) throw new HttpError(401, 'NOT_SIGNED_IN', 'x');
      if (caller.token.admin !== true) throw new HttpError(403, 'NOT_ADMIN', 'x');
      return caller;
    },
  },
});

const shopHandler = (await import(url('api/shop.js'))).default;
const adminHandler = (await import(url('api/admin.js'))).default;

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined, headersSent: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
  };
}
async function call(handler, body) {
  const res = mockRes();
  await handler({ method: 'POST', body, headers: {} }, res);
  return res;
}
const admin = (body) => call(adminHandler, body);
const shop = (body) => call(shopHandler, body);
const balance = (uid) => store.get(`users/${uid}`).balanceCents;
const ledgerFor = (uid) => [...store.entries()].filter(([p, d]) => p.startsWith('ledger/') && d.uid === uid).map(([, d]) => d);

// Seed: admin + one player.
store.set('users/admin1', { username: 'will', displayName: 'Will', role: 'admin', disabled: false, balanceCents: 0, stats: { won: 0, lost: 0 } });
const asAdmin = () => { caller = { uid: 'admin1', token: { admin: true }, user: store.get('users/admin1') }; };
const asPlayer = (uid) => { caller = { uid, token: {}, user: store.get(`users/${uid}`) }; };

// The record (won / lost) only; 0.21.0's totals are checked in test/agents.
const wl = (st) => ({ won: st?.won ?? 0, lost: st?.lost ?? 0 });

test('admin: non-admin is refused, unknown and prototype actions rejected', async () => {
  caller = { uid: 'x', token: {}, user: {} };
  let r = await admin({ action: 'createUser' });
  assert.equal(r.statusCode, 403);
  asAdmin();
  for (const action of ['nope', '__proto__', 'constructor', 'toString']) {
    r = await admin({ action });
    assert.equal(r.statusCode, 400, action);
    assert.equal(r.body.error.code, 'UNKNOWN_ACTION');
  }
});

test('createUser: validation, success with starting balance ledger, duplicate username', async () => {
  asAdmin();
  let r = await admin({ action: 'createUser', username: 'Bad Name', password: 'longenough' });
  assert.equal(r.body.error.code, 'BAD_USERNAME');
  r = await admin({ action: 'createUser', username: 'mike', password: 'short' });
  assert.equal(r.body.error.code, 'BAD_PASSWORD');
  r = await admin({ action: 'createUser', username: 'mike', password: 'longenough', startingBalanceCents: -5 });
  assert.equal(r.body.error.code, 'BAD_AMOUNT');
  r = await admin({ action: 'createUser', username: 'mike', password: 'longenough', startingBalanceCents: 12.5 });
  assert.equal(r.body.error.code, 'BAD_AMOUNT');

  r = await admin({ action: 'createUser', username: 'Mike', displayName: 'Mikey', password: 'longenough', startingBalanceCents: 10000 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const uid = r.body.uid;
  assert.equal(r.body.username, 'mike');
  assert.deepEqual(store.get('usernames/mike'), { uid });
  const user = store.get(`users/${uid}`);
  assert.equal(user.role, 'player');
  assert.equal(user.balanceCents, 10000);
  assert.deepEqual(wl(user.stats), { won: 0, lost: 0 });
  const start = store.get(`ledger/start_${uid}`);
  assert.equal(start.amountCents, 10000);
  assert.equal(start.balanceAfterCents, 10000);
  assert.equal(start.by, 'admin1');

  r = await admin({ action: 'createUser', username: 'mike', password: 'longenough' });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error.code, 'USERNAME_TAKEN');

  r = await admin({ action: 'createUser', username: 'zero', password: 'longenough' });
  assert.equal(r.statusCode, 200);
  assert.equal(store.get(`users/${r.body.uid}`).balanceCents, 0);
  assert.equal(store.get(`ledger/start_${r.body.uid}`), undefined, 'no ledger entry for $0 start');
});

test('shop: amounts, balance + ledger, double-click protection', async () => {
  const uid = store.get('usernames/mike').uid;
  asPlayer(uid);
  let r = await shop({ amount: 30 });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error.code, 'BAD_AMOUNT');
  r = await shop({ amount: 25, clientRequestId: 'bad id!' });
  assert.equal(r.body.error.code, 'BAD_REQUEST_ID');

  const before = balance(uid);
  r = await shop({ amount: 25, clientRequestId: 'req-12345678' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.balanceCents, before + 2500);
  assert.equal(balance(uid), before + 2500);

  r = await shop({ amount: 25, clientRequestId: 'req-12345678' });
  assert.equal(r.body.duplicate, true);
  assert.equal(balance(uid), before + 2500, 'repeat request must not add again');

  r = await shop({ amount: 100 });
  assert.equal(balance(uid), before + 2500 + 10000);
  const shopEntries = ledgerFor(uid).filter((e) => e.type === 'shop');
  assert.equal(shopEntries.length, 2);
  assert.ok(shopEntries.every((e) => e.by === uid));

  caller = null;
  r = await shop({ amount: 5 });
  assert.equal(r.statusCode, 401);
});

test('adjustWallet: add, remove, block going below zero, reject bad amounts', async () => {
  asAdmin();
  const uid = store.get('usernames/mike').uid;
  const start = balance(uid);
  let r = await admin({ action: 'adjustWallet', uid, deltaCents: 0 });
  assert.equal(r.body.error.code, 'BAD_AMOUNT');
  r = await admin({ action: 'adjustWallet', uid, deltaCents: 1.5 });
  assert.equal(r.body.error.code, 'BAD_AMOUNT');
  r = await admin({ action: 'adjustWallet', uid, deltaCents: 200_000_000 });
  assert.equal(r.body.error.code, 'BAD_AMOUNT');
  r = await admin({ action: 'adjustWallet', uid: 'ghost', deltaCents: 100 });
  assert.equal(r.statusCode, 404);

  r = await admin({ action: 'adjustWallet', uid, deltaCents: -(start + 1) });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error.code, 'INSUFFICIENT_BALANCE');
  assert.equal(balance(uid), start);

  r = await admin({ action: 'adjustWallet', uid, deltaCents: -start, note: 'reset' });
  assert.equal(r.body.balanceCents, 0);
  r = await admin({ action: 'adjustWallet', uid, deltaCents: 5050 });
  assert.equal(balance(uid), 5050);
  const adjust = ledgerFor(uid).filter((e) => e.type === 'admin_adjust' && e.note !== 'Starting balance');
  assert.equal(adjust.length, 2);
  assert.equal(adjust.find((e) => e.amountCents === -start).note, 'reset');
});

test('setDisabled, resetPassword, updateUser', async () => {
  asAdmin();
  const uid = store.get('usernames/mike').uid;
  authCalls.length = 0;

  let r = await admin({ action: 'setDisabled', uid: 'admin1', disabled: true });
  assert.equal(r.body.error.code, 'CANNOT_DISABLE_SELF');
  r = await admin({ action: 'setDisabled', uid, disabled: 'yes' });
  assert.equal(r.body.error.code, 'MISSING_FIELD');
  r = await admin({ action: 'setDisabled', uid, disabled: true });
  assert.equal(r.statusCode, 200);
  assert.equal(store.get(`users/${uid}`).disabled, true);
  assert.ok(authCalls.some((c) => c[0] === 'revoke' && c[1] === uid));
  r = await admin({ action: 'setDisabled', uid, disabled: false });
  assert.equal(store.get(`users/${uid}`).disabled, false);

  authCalls.length = 0;
  r = await admin({ action: 'resetPassword', uid, newPassword: 'short' });
  assert.equal(r.body.error.code, 'BAD_PASSWORD');
  r = await admin({ action: 'resetPassword', uid, newPassword: 'newpassword1' });
  assert.equal(r.statusCode, 200);
  assert.ok(authCalls.some((c) => c[0] === 'revoke' && c[1] === uid), 'player signed out after reset');
  authCalls.length = 0;
  r = await admin({ action: 'resetPassword', uid: 'admin1', newPassword: 'newpassword1' });
  assert.equal(r.statusCode, 200);
  assert.ok(!authCalls.some((c) => c[0] === 'revoke'), 'admin stays signed in after resetting own password');

  r = await admin({ action: 'updateUser', uid, displayName: 'x'.repeat(31) });
  assert.equal(r.body.error.code, 'BAD_DISPLAY_NAME');
  r = await admin({ action: 'updateUser', uid, displayName: 'Big Mike' });
  assert.equal(store.get(`users/${uid}`).displayName, 'Big Mike');
  r = await admin({ action: 'updateUser', uid, displayName: '' });
  assert.equal(store.get(`users/${uid}`).displayName, 'mike', 'blank name falls back to username');
});
