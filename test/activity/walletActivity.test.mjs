// npm run test:activity  (or: node --experimental-test-module-mocks --test test/activity/walletActivity.test.mjs)
// 0.17.0 Admin → Wallet activity: the 24 h window, pages of 50, admin only, the aggregation summary, the balance
// chain check (good chain, a jump, same-transaction groups, the current wallet), and a missing index reported
// instead of crashing. The ledger is only read.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Timestamp } from 'firebase-admin/firestore';
import { makeFakeDb } from '../casino/fakeFirestore.mjs';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;
const fake = makeFakeDb();
mock.module(url('server/firebaseAdmin.js'), { namedExports: { adminDb: () => fake.db, adminAuth: () => ({}), normalizePrivateKey: (k) => k } });
const { HttpError } = await import(url('server/http.js'));
mock.module(url('server/auth.js'), {
  namedExports: {
    requireToken: async (req) => ({ uid: req.headers.uid, token: {}, user: null }),
    requireUser: async (req) => ({ uid: req.headers.uid, token: {}, user: fake.get(`users/${req.headers.uid}`) }),
    requireAdmin: async (req) => {
      if (req.headers.uid !== 'admin') throw new HttpError(403, 'NOT_ADMIN', 'Only the admin can do that.');
      return { uid: 'admin', token: { admin: true }, user: fake.get('users/admin') };
    },
    checkProfile: (snap) => snap.data(),
  },
});

const { walletActivity, ACTIVITY_INDEXES } = await import(url('server/admin/walletActivity.js'));
const A = await import(url('shared/walletActivity.js'));
const adminHandler = (await import(url('api/admin.js'))).default;

const NOW = new Date('2026-10-20T21:00:00Z');
const NOW_MS = NOW.getTime();
const H = 3600e3;
const DAY = 24 * H;

// Writes a chain of ledger entries for `uid`, oldest first; each balanceAfter = previous + amount unless overridden.
// group: entries with the same `at` share one Timestamp (one transaction).
function seed(uid, start, rows) {
  let bal = start;
  const out = [];
  rows.forEach((r, i) => {
    bal = r.balanceAfterCents ?? bal + r.amountCents;
    const id = r.id ?? `${uid}-e${String(i).padStart(4, '0')}`;
    const data = {
      uid,
      type: r.type,
      amountCents: r.amountCents,
      balanceAfterCents: bal,
      betId: r.betId ?? null,
      note: r.note ?? r.type,
      by: 'test',
      createdAt: r.ts ?? Timestamp.fromMillis(NOW_MS - r.ago),
      ...(r.game ? { game: r.game, roundId: r.roundId ?? null } : {}),
    };
    fake.write(`ledger/${id}`, data);
    out.push({ id, ...data });
  });
  return { entries: out, balance: bal };
}
const call = (uid, cursor) => walletActivity({ uid, ...(cursor ? { cursor } : {}) }, { uid: 'admin' }, { now: NOW, db: fake.db });
// What the screen does: load every page, then check the chain.
async function loadAll(uid) {
  const first = await call(uid);
  let entries = first.entries;
  let cursor = first.nextCursor;
  let pages = 1;
  while (cursor) {
    const next = await call(uid, cursor);
    entries = [...entries, ...next.entries];
    cursor = next.nextCursor;
    pages += 1;
  }
  return { first, entries, pages };
}

beforeEach(() => {
  fake.reset();
  fake.write('users/admin', { username: 'will', displayName: 'Will', balanceCents: 0, role: 'admin' });
  fake.write('users/mike', { username: 'mike', displayName: 'Mike', balanceCents: 0 });
  fake.write('users/dan', { username: 'dan', displayName: 'Dan', balanceCents: 0 });
});

test('the 24 h window: an entry 24 h + 1 s old is left out; exactly 24 h is in; other players never show', async () => {
  seed('mike', 10_000, [
    { id: 'too-old', type: 'shop', amountCents: 500, ago: DAY + 1000 },
    { id: 'edge', type: 'shop', amountCents: 500, ago: DAY },
    { id: 'recent', type: 'stake', amountCents: -300, betId: 'b1', ago: 60e3 },
  ]);
  seed('dan', 0, [{ id: 'dans', type: 'shop', amountCents: 2500, ago: 1000 }]);
  fake.write('users/mike', { username: 'mike', displayName: 'Mike', balanceCents: 10_700 });
  const r = await call('mike');
  assert.deepEqual(r.entries.map((e) => e.id), ['recent', 'edge'], 'newest first; too-old and Dan excluded');
  assert.equal(r.nextCursor, null);
  assert.equal(r.since, new Date(NOW_MS - DAY).toISOString());
  assert.deepEqual(r.missingIndexes, []);
  assert.equal(r.player.balanceCents, 10_700);
  assert.equal(r.entries[0].betId, 'b1');
  await assert.rejects(call('nobody'), (e) => e.code === 'USER_NOT_FOUND');
  await assert.rejects(walletActivity({ uid: '../x' }, {}, { now: NOW, db: fake.db }), (e) => e.code === 'BAD_UID');
});

test('pagination: 50 a page with a cursor, newest first, no gaps or repeats; nothing is written', async () => {
  const rows = Array.from({ length: 123 }, (_, i) => ({ type: i % 2 ? 'casino_payout' : 'casino_bet', amountCents: i % 2 ? 150 : -100, game: 'slots', ago: (123 - i) * 60e3 }));
  const { entries: seeded, balance } = seed('mike', 50_000, rows);
  fake.write('users/mike', { username: 'mike', displayName: 'Mike', balanceCents: balance });
  const before = fake.counts.writes;
  const p1 = await call('mike');
  assert.equal(p1.entries.length, 50);
  assert.ok(p1.nextCursor);
  assert.ok(p1.summary, 'summary on the first page');
  const p2 = await call('mike', p1.nextCursor);
  assert.equal(p2.entries.length, 50);
  assert.equal(p2.summary, null, 'no summary on later pages');
  const p3 = await call('mike', p2.nextCursor);
  assert.equal(p3.entries.length, 23);
  assert.equal(p3.nextCursor, null);
  const ids = [...p1.entries, ...p2.entries, ...p3.entries].map((e) => e.id);
  assert.deepEqual(ids, seeded.map((e) => e.id).reverse());
  assert.equal(fake.counts.writes, before, 'read only');
  await assert.rejects(call('mike', 'dan-e0000'), (e) => e.code === 'BAD_CURSOR');
});

test('admin only: /api/admin walletActivity refuses a player and answers the admin', async () => {
  // The handler goes through the real clock (no `now` to pass), so this entry is stamped with real time, not NOW: with NOW
  // it fell out of the 24 h window once the calendar passed 2026-10-21.
  seed('mike', 0, [{ type: 'shop', amountCents: 500, ts: Timestamp.fromMillis(Date.now() - 1000) }]);
  fake.write('users/mike', { username: 'mike', displayName: 'Mike', balanceCents: 500 });
  const res = () => ({ statusCode: 200, headers: {}, body: null, headersSent: false, setHeader(a, b) { this.headers[a] = b; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } });
  let r = res();
  await adminHandler({ method: 'POST', headers: { uid: 'mike' }, body: { action: 'walletActivity', uid: 'mike' } }, r);
  assert.equal(r.statusCode, 403);
  assert.equal(r.body?.entries, undefined);
  r = res();
  await adminHandler({ method: 'POST', headers: { uid: 'admin' }, body: { action: 'walletActivity', uid: 'mike' } }, r);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.entries.length, 1);
});

test('summary: aggregation per type and per casino game; wagered, won/returned, admin net and net add up', async () => {
  const { balance } = seed('mike', 100_000, [
    { type: 'admin_adjust', amountCents: 5_000, ago: 20 * H },
    { type: 'stake', amountCents: -2_000, betId: 'b1', ago: 19 * H },
    { type: 'stake', amountCents: -1_000, betId: 'b2', ago: 19 * H },
    { type: 'payout', amountCents: 3_800, betId: 'b1', ago: 10 * H },
    { type: 'cashout', amountCents: 900, betId: 'b2', ago: 9 * H },
    { type: 'casino_bet', amountCents: -10_000, game: 'blackjack', note: 'Blackjack hand 4, seat 3: bet now $100.00', ago: 5 * H },
    { type: 'casino_payout', amountCents: 20_000, game: 'blackjack', note: 'Blackjack hand 4, seat 3: win', ago: 5 * H - 1000 },
    { type: 'casino_bet', amountCents: -500, game: 'craps', ago: 4 * H },
    { type: 'casino_refund', amountCents: 200, game: 'craps', ago: 4 * H - 1000 },
    { type: 'casino_bet', amountCents: -100, game: 'slots', ago: 3 * H },
    { type: 'battle_stake', amountCents: -5_000, ago: 2 * H },
    { type: 'battle_payout', amountCents: 10_000, ago: H },
    { type: 'shop', amountCents: 2_500, ago: 30 * 60e3 },
    { type: 'admin_regrade', amountCents: -1_300, betId: 'b1', ago: 10 * 60e3 },
    { type: 'stake', amountCents: -777, betId: 'old', ago: DAY + 5000 }, // outside the window: not counted
  ]);
  fake.write('users/mike', { username: 'mike', displayName: 'Mike', balanceCents: balance });
  fake.resetCounts();
  const { summary } = await call('mike');
  assert.deepEqual(summary.sportsbook, { count: 4, wageredCents: 3_000, wonCents: 4_700, adjustedCents: 0, netCents: 1_700 });
  assert.deepEqual(summary.casino.games.blackjack, { count: 2, wageredCents: 10_000, wonCents: 20_000, adjustedCents: 0, netCents: 10_000 });
  assert.deepEqual(summary.casino.games.craps, { count: 2, wageredCents: 500, wonCents: 200, adjustedCents: 0, netCents: -300 });
  assert.deepEqual(summary.casino.games.slots, { count: 1, wageredCents: 100, wonCents: 0, adjustedCents: 0, netCents: -100 });
  assert.deepEqual(summary.casino.games.baccarat, A.emptyBucket());
  assert.equal(summary.casino.count, 5);
  assert.equal(summary.casino.netCents, 9_600);
  assert.deepEqual(summary.other.parts.battles, { count: 2, wageredCents: 5_000, wonCents: 10_000, adjustedCents: 0, netCents: 5_000 });
  assert.deepEqual(summary.other.parts.shop, { count: 1, wageredCents: 0, wonCents: 2_500, adjustedCents: 0, netCents: 2_500 });
  assert.deepEqual(summary.other.parts.admin, { count: 2, wageredCents: 0, wonCents: 0, adjustedCents: 3_700, netCents: 3_700 });
  // Credits: 3,800 + 900 + 20,000 + 200 + 10,000 + 2,500; debits: 3,000 + 10,000 + 500 + 100 + 5,000; admin 5,000 − 1,300.
  assert.deepEqual(summary.all, { count: 14, wageredCents: 18_600, wonCents: 37_400, adjustedCents: 3_700, netCents: 22_500 });
  assert.deepEqual(summary.unclassified, { count: 0, netCents: 0 });
  // Aggregation queries, not reading every entry: 1 total + 9 types + 15 per game, one read each.
  assert.equal(fake.counts.aggregations, 1 + A.NON_CASINO_TYPES.length + A.CASINO_GAME_IDS.length * A.CASINO_TYPES.length);
  // A type the screen doesn't know still shows up in the total.
  seed('mike', balance, [{ id: 'mystery', type: 'mystery_bonus', amountCents: 42, ago: 1000 }]);
  assert.deepEqual((await call('mike')).summary.unclassified, { count: 1, netCents: 42 });
});

test('balance check: a good chain is all ✓ and matches the wallet; the window start is not a jump', async () => {
  const { balance } = seed('mike', 7_000, [
    { type: 'shop', amountCents: 2_500, ago: DAY + 10e3 }, // before the window
    { type: 'stake', amountCents: -1_000, betId: 'b1', ago: 20 * H },
    { type: 'payout', amountCents: 1_910, betId: 'b1', ago: 10 * H },
    { type: 'casino_bet', amountCents: -500, game: 'slots', ago: 2 * H },
  ]);
  fake.write('users/mike', { username: 'mike', displayName: 'Mike', balanceCents: balance });
  const { first, entries } = await loadAll('mike');
  const check = A.checkBalances(entries, { complete: true, currentBalanceCents: first.player.balanceCents });
  assert.equal(check.jumps, 0);
  assert.equal(check.walletMismatch, null);
  assert.deepEqual(entries.map((e) => check.rows.get(e.id).status), ['ok', 'ok', 'first']);
  // With more pages still to load, the oldest loaded entry is "unchecked", not a jump.
  const partial = A.checkBalances(entries, { complete: false, currentBalanceCents: first.player.balanceCents });
  assert.deepEqual(entries.map((e) => partial.rows.get(e.id).status), ['ok', 'ok', 'unchecked']);
});

test('balance check: a broken chain is flagged with expected vs ledger; only once; the chain resumes from the ledger', async () => {
  const { balance } = seed('mike', 10_000, [
    { type: 'shop', amountCents: 500, ago: 20 * H }, // 10,500
    { type: 'stake', amountCents: -1_000, betId: 'b1', ago: 19 * H }, // 9,500
    { id: 'bad', type: 'payout', amountCents: 2_000, betId: 'b1', balanceAfterCents: 12_000, ago: 10 * H }, // should be 11,500
    { type: 'casino_bet', amountCents: -1_000, game: 'craps', ago: 9 * H }, // 11,000: chains from 12,000
  ]);
  fake.write('users/mike', { username: 'mike', displayName: 'Mike', balanceCents: balance });
  const { first, entries } = await loadAll('mike');
  const check = A.checkBalances(entries, { complete: true, currentBalanceCents: first.player.balanceCents });
  assert.equal(check.jumps, 1);
  assert.deepEqual(check.rows.get('bad'), { status: 'jump', expectedCents: 11_500, ledgerCents: 12_000 });
  assert.equal(check.rows.get(entries[0].id).status, 'ok', 'the next entry is judged from what the ledger says');
});

test('balance check: entries written in one transaction (same timestamp) are checked as a group, in any order', async () => {
  const ts = Timestamp.fromMillis(NOW_MS - 3 * H);
  // A craps roll: the stake comes down and the winnings go up in one transaction. The ledger ids sort the payout
  // first, so a strict one-by-one walk in id order would see a false jump.
  const { balance } = seed('mike', 5_000, [
    { type: 'shop', amountCents: 500, ago: 5 * H }, // 5,500
    { id: 'a-pay', type: 'casino_payout', amountCents: 1_200, game: 'craps', ts, balanceAfterCents: 5_700 },
    { id: 'z-bet', type: 'casino_bet', amountCents: -1_000, game: 'craps', ts, balanceAfterCents: 4_500 },
    { type: 'casino_bet', amountCents: -200, game: 'craps', ago: 2 * H, balanceAfterCents: 5_500 }, // the group ended at 5,700
  ]);
  fake.write('users/mike', { username: 'mike', displayName: 'Mike', balanceCents: balance });
  const { first, entries } = await loadAll('mike');
  assert.equal(entries.find((e) => e.id === 'a-pay').createdKey, entries.find((e) => e.id === 'z-bet').createdKey);
  const check = A.checkBalances(entries, { complete: true, currentBalanceCents: first.player.balanceCents });
  assert.equal(check.jumps, 0, JSON.stringify([...check.rows]));
  assert.equal(check.rows.get('a-pay').status, 'ok');
  assert.equal(check.rows.get('z-bet').status, 'ok');
  // The same group with a wrong number in it is flagged.
  fake.write('ledger/a-pay', { ...fake.get('ledger/a-pay'), balanceAfterCents: 5_800 });
  const bad = A.checkBalances((await loadAll('mike')).entries, { complete: true, currentBalanceCents: balance });
  assert.deepEqual(bad.rows.get('a-pay'), { status: 'jump', expectedCents: 5_700, ledgerCents: 5_800 }, 'the bet chains; the payout is wrong');
  assert.equal(bad.rows.get('z-bet').status, 'ok');
  // One wrong "balance after" breaks the link into it and the link out of it: the next entry is flagged too.
  assert.equal(bad.jumps, 2);
});

test('balance check: the newest balance after vs the current wallet', async () => {
  seed('mike', 1_000, [{ type: 'shop', amountCents: 500, ago: 1000 }]);
  fake.write('users/mike', { username: 'mike', displayName: 'Mike', balanceCents: 1_400 });
  const { first, entries } = await loadAll('mike');
  const check = A.checkBalances(entries, { complete: true, currentBalanceCents: first.player.balanceCents });
  assert.deepEqual(check.walletMismatch, { expectedCents: 1_500, walletCents: 1_400 });
  fake.write('users/mike', { username: 'mike', displayName: 'Mike', balanceCents: 1_500 });
  assert.equal(A.checkBalances(entries, { complete: true, currentBalanceCents: 1_500 }).walletMismatch, null);
});

test('a missing index is named instead of crashing; whatever does not need it still loads', async () => {
  // The handler goes through the real clock (no `now` to pass), so this entry is stamped with real time, not NOW: with NOW
  // it fell out of the 24 h window once the calendar passed 2026-10-21.
  seed('mike', 0, [{ type: 'shop', amountCents: 500, ts: Timestamp.fromMillis(Date.now() - 1000) }]);
  fake.write('users/mike', { username: 'mike', displayName: 'Mike', balanceCents: 500 });
  const failing = (pred) => {
    const err = Object.assign(new Error('9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/x/firestore/indexes?create_composite=abc'), { code: 9 });
    const wrap = (q, filters = []) => ({
      where: (f, op, v) => wrap(q.where(f, op, v), [...filters, f]),
      orderBy: (...a) => wrap(q.orderBy(...a), filters),
      limit: (n) => wrap(q.limit(n), filters),
      startAfter: (s) => wrap(q.startAfter(s), filters),
      get: async () => { if (pred(filters, 'get')) throw err; return q.get(); },
      aggregate: (spec) => ({ get: async () => { if (pred(filters, 'aggregate')) throw err; return q.aggregate(spec).get(); } }),
    });
    return { ...fake.db, collection: (name) => (name === 'ledger' ? { ...fake.db.collection(name), where: (f, op, v) => wrap(fake.db.collection(name).where(f, op, v), [f]) } : fake.db.collection(name)) };
  };
  // The per-game index is missing: entries load, the summary says which index.
  let r = await walletActivity({ uid: 'mike' }, {}, { now: NOW, db: failing((f) => f.includes('game')) });
  assert.equal(r.entries.length, 1);
  assert.equal(r.summary, null);
  assert.deepEqual(r.missingIndexes.map((m) => m.id), ['BY_GAME']);
  assert.deepEqual(r.missingIndexes[0].fields, ACTIVITY_INDEXES.BY_GAME.fields);
  assert.match(r.missingIndexes[0].link, /^https:\/\/console\.firebase\.google\.com\//);
  // The main index is missing: no entries, and it is named.
  r = await walletActivity({ uid: 'mike' }, {}, { now: NOW, db: failing((f, kind) => kind === 'get' || !f.includes('type')) });
  assert.equal(r.entries, null);
  assert.ok(r.missingIndexes.some((m) => m.id === 'ENTRIES'));
  // Any other error is still an error.
  const broken = { ...fake.db, collection: (name) => (name === 'ledger' ? { where: () => { throw new Error('boom'); } } : fake.db.collection(name)) };
  await assert.rejects(walletActivity({ uid: 'mike' }, {}, { now: NOW, db: broken }), /boom/);
});
