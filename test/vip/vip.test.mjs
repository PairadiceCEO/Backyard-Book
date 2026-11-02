// npm run test:vip  (or: node --experimental-test-module-mocks --test test/vip/vip.test.mjs)
// 0.28.0: the VIP slot's lock and spins on the server, against the in-memory Firestore. No password set → locked for everyone;
// setting and changing the password (admin only; only a salted scrypt hash is stored); unlocking (right, wrong, 5 wrong tries per
// 15 minutes); the pass on every spin (missing, expired, another player's, from before a password change → VIP_LOCKED); a spin and
// its whole bonus in one transaction with deterministic ledger ids; a duplicate requestId pays once; 2 s between paid spins; cents
// round down; disabled players refused. The passwords here are test values only.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFakeDb } from '../casino/fakeFirestore.mjs';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;
const fake = makeFakeDb();
const TOKENS = { 'admin-token': { uid: 'admin', admin: true }, 'player-token': { uid: 'p1' } };
mock.module(url('server/firebaseAdmin.js'), {
  namedExports: {
    adminDb: () => fake.db,
    adminAuth: () => ({ async verifyIdToken(t) { if (!TOKENS[t]) throw new Error('bad'); return { ...TOKENS[t] }; } }),
    normalizePrivateKey: (k) => k,
  },
});

const lock = await import(url('server/vipLock.js'));
const { spinVip, vipUnlock } = await import(url('server/casino/vipSlots.js'));
const { handleCasinoAction } = await import(url('server/casino/router.js'));
const adminHandler = (await import(url('api/admin.js'))).default;
const V = await import(url('shared/casino/vipSlots.js'));

const TEST_PASSWORD = 'test-only-vip-1';
const OTHER_PASSWORD = 'test-only-vip-2';
const T0 = 1_800_000_000_000;
const START = 100_000;
const at = (ms) => new Date(T0 + ms);
function seed() {
  fake.reset();
  for (const uid of ['admin', 'p1', 'p2']) {
    fake.write(`users/${uid}`, { username: uid, displayName: uid, balanceCents: START, stats: { won: 0, lost: 0 }, disabled: false, role: uid === 'admin' ? 'admin' : 'player' });
  }
}
const caller = (uid) => ({ uid, token: {}, user: fake.get(`users/${uid}`) });
let n = 0;
const rid = () => `vip-req-${String(++n).padStart(6, '0')}`;
const wallet = (uid) => fake.get(`users/${uid}`).balanceCents;
const ledger = (uid) => [...fake.store].filter(([k, v]) => k.startsWith('ledger/') && v.uid === uid).map(([k, v]) => ({ id: k.slice(7), ...v }));
const rejects = async (p, code, status) => {
  await assert.rejects(p, (e) => {
    assert.equal(e.code, code, e.message);
    if (status) assert.equal(e.status, status);
    return true;
  });
};

async function admin(body, token = 'admin-token') {
  let status = 200;
  let payload = null;
  const res = {
    headersSent: false,
    setHeader() {},
    status(s) { status = s; return this; },
    json(p) { payload = p; return this; },
  };
  await adminHandler({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body }, res);
  return { status, payload };
}

async function setPassword(password, now = at(0)) {
  return lock.setVipPassword({ password, repeat: password }, caller('admin'), { now });
}
async function unlock(uid, password, now = at(0)) {
  return vipUnlock(caller(uid), { password }, { now });
}
// scripted reel stops (then zeros)
function scripted(values) {
  let i = 0;
  return (max) => {
    const v = i < values.length ? values[i] : 0;
    i += 1;
    return v % max;
  };
}
const dieStops = (reels, wanted) => reels.map((strip) => strip.findIndex((_, s) => [s - 1, s, s + 1].some((x) => strip[(x + 40) % 40] === 'GD') === wanted));
const spin = (uid, pass, amount, now, randomInt = Math.random ? (m) => Math.floor(Math.random() * m) : undefined, requestId = rid()) =>
  spinVip(caller(uid), { amount, requestId, pass }, { now, randomInt });

test('no password set: VIP is locked for everyone ("VIP isn\'t set up yet"); a spin with any pass is VIP_LOCKED', async () => {
  seed();
  assert.deepEqual(await lock.vipPlayerStatus(), { ok: true, setUp: false });
  await rejects(unlock('p1', 'anything at all'), 'VIP_NOT_SET_UP', 409);
  await rejects(spin('p1', 'x.y', 1, at(0)), 'VIP_LOCKED', 403);
  assert.equal(wallet('p1'), START);
  assert.equal(ledger('p1').length, 0);
});

test('setting the password: admin only; only a salted scrypt hash and a version are stored, never the password', async () => {
  seed();
  const refused = await admin({ action: 'vipSetPassword', password: TEST_PASSWORD, repeat: TEST_PASSWORD }, 'player-token');
  assert.equal(refused.status, 403);
  assert.equal(fake.get('meta/vipSlots'), undefined);
  const differ = await admin({ action: 'vipSetPassword', password: TEST_PASSWORD, repeat: `${TEST_PASSWORD}x` });
  assert.equal(differ.payload.error.code, 'PASSWORDS_DIFFER');
  const short = await admin({ action: 'vipSetPassword', password: 'abc', repeat: 'abc' });
  assert.equal(short.payload.error.code, 'BAD_PASSWORD');
  const ok = await admin({ action: 'vipSetPassword', password: TEST_PASSWORD, repeat: TEST_PASSWORD });
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.version, 1);
  const meta = fake.get('meta/vipSlots');
  assert.deepEqual(Object.keys(meta).sort(), ['hash', 'salt', 'updatedAt', 'version']);
  assert.match(meta.hash, /^[0-9a-f]{128}$/);
  assert.match(meta.salt, /^[0-9a-f]{32}$/);
  const everything = JSON.stringify([...fake.store]);
  assert.ok(!everything.includes(TEST_PASSWORD), 'the password is nowhere in the database');
  assert.ok(!JSON.stringify(ok.payload).includes(TEST_PASSWORD));
  const status = await admin({ action: 'vipStatus' });
  assert.equal(status.payload.setUp, true);
  assert.ok(!('hash' in status.payload) && !('salt' in status.payload));
  // a second password: a new salt and version
  await setPassword(OTHER_PASSWORD);
  const meta2 = fake.get('meta/vipSlots');
  assert.equal(meta2.version, 2);
  assert.notEqual(meta2.salt, meta.salt);
});

test('unlocking: the right password gives a 2-hour pass; a wrong one is refused; 5 wrong tries in 15 minutes → 429', async () => {
  seed();
  await setPassword(TEST_PASSWORD);
  const good = await unlock('p1', TEST_PASSWORD);
  assert.equal(good.expiresAt, T0 + 2 * 60 * 60 * 1000);
  assert.match(good.pass, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  // right passwords never count as tries
  for (let i = 0; i < 8; i += 1) await unlock('p1', TEST_PASSWORD, at(i));
  for (let i = 0; i < 5; i += 1) await rejects(unlock('p1', `nope-${i}`, at(1000 + i)), 'VIP_WRONG_PASSWORD', 403);
  await rejects(unlock('p1', 'nope-6', at(2000)), 'VIP_TOO_MANY_TRIES', 429);
  await rejects(unlock('p1', TEST_PASSWORD, at(3000)), 'VIP_TOO_MANY_TRIES', 429); // even the right one, until the window passes
  assert.equal(fake.get('vipRate/p1').fails.length, 5);
  // another player is not affected
  await unlock('p2', TEST_PASSWORD, at(3000));
  // 15 minutes after the first wrong try, one try is free again
  const later = await unlock('p1', TEST_PASSWORD, at(1000 + 15 * 60 * 1000));
  assert.ok(later.pass);
  // through the router (the /api/casino action) too
  const routed = await handleCasinoAction(caller('p2'), { action: 'vipUnlock', password: TEST_PASSWORD }, { now: at(0) });
  assert.ok(routed.pass && routed.serverNow);
});

test('the pass on every spin: missing, garbled, expired, another player\'s, or from before a password change → VIP_LOCKED', async () => {
  seed();
  await setPassword(TEST_PASSWORD);
  const { pass } = await unlock('p1', TEST_PASSWORD);
  await rejects(spin('p1', undefined, 1, at(10)), 'VIP_LOCKED', 403);
  await rejects(spin('p1', `${pass}x`, 1, at(10)), 'VIP_LOCKED', 403);
  await rejects(spin('p1', pass.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')), 1, at(10)), 'VIP_LOCKED', 403);
  await rejects(spin('p2', pass, 1, at(10)), 'VIP_LOCKED', 403); // p1's pass, sent by p2
  await rejects(spin('p1', pass, 1, at(2 * 60 * 60 * 1000)), 'VIP_LOCKED', 403); // expired
  const ok = await spin('p1', pass, 1, at(10));
  assert.equal(ok.ok, true);
  await setPassword(OTHER_PASSWORD, at(20));
  await rejects(spin('p1', pass, 1, at(5000)), 'VIP_LOCKED', 403); // the old pass stopped working
  await rejects(unlock('p1', TEST_PASSWORD, at(5000)), 'VIP_WRONG_PASSWORD', 403); // and so did the old password
  const fresh = await unlock('p1', OTHER_PASSWORD, at(5000));
  assert.equal((await spin('p1', fresh.pass, 1, at(5000))).ok, true);
  assert.equal(ledger('p2').length, 0);
});

test('a spin and its whole bonus happen in one transaction: bet, base and bonus entries with deterministic ids', async () => {
  seed();
  await setPassword(TEST_PASSWORD);
  const { pass } = await unlock('p1', TEST_PASSWORD);
  const trigger = dieStops(V.VIP_REELS, true);
  const plainBonus = dieStops(V.VIP_BONUS_REELS, false);
  // a bonus spin that wins: find one
  let winning = null;
  for (let a = 0; a < 40 && !winning; a += 1) {
    const s = [a, a, a];
    const r = V.evaluateVipWindow(V.vipWindow(s, V.VIP_BONUS_REELS));
    if (r.tenths > 0 && r.dice < 3) winning = s;
  }
  const bonusStops = [...winning, ...Array(9).fill(plainBonus).flat()];
  fake.resetCounts();
  const requestId = rid();
  const result = await spin('p1', pass, 5, at(10), scripted([...trigger, ...bonusStops]), requestId);
  assert.equal(fake.counts.commits, 1, 'one transaction');
  assert.ok(result.spin.dice >= 3);
  assert.equal(result.spin.bonus.spins.length, 10);
  assert.ok(result.spin.bonus.cents > 0);
  const ids = ledger('p1').map((e) => e.id).sort();
  const expected = [`cbet_vip_p1_${requestId}`, `cpay_vip_p1_${requestId}_bonus`];
  if (result.spin.baseCents > 0) expected.push(`cpay_vip_p1_${requestId}_base`);
  assert.deepEqual(ids, expected.sort());
  const byId = Object.fromEntries(ledger('p1').map((e) => [e.id, e]));
  assert.equal(byId[`cbet_vip_p1_${requestId}`].amountCents, -500);
  assert.equal(byId[`cpay_vip_p1_${requestId}_bonus`].amountCents, result.spin.bonus.cents);
  assert.equal(byId[`cbet_vip_p1_${requestId}`].game, 'vip');
  assert.equal(wallet('p1'), START - 500 + result.spin.winCents);
  assert.equal(result.balanceCents, wallet('p1'));
  // every bonus spin's win is its lines × 3 × the bet, rounded down
  for (const s of result.spin.bonus.spins) {
    const r = V.evaluateVipWindow(V.vipWindow(s.stops, V.VIP_BONUS_REELS));
    assert.equal(s.cents, Math.floor((500 * r.tenths * 3) / 10));
  }
  // the money adds up
  assert.equal(START + ledger('p1').reduce((sum, e) => sum + e.amountCents, 0), wallet('p1'));
});

test('a duplicate requestId pays once and replays the same spin; 2 s between paid spins; the wallet is checked', async () => {
  seed();
  await setPassword(TEST_PASSWORD);
  const { pass } = await unlock('p1', TEST_PASSWORD);
  const requestId = rid();
  const first = await spin('p1', pass, 2, at(10), undefined, requestId);
  const again = await spin('p1', pass, 2, at(20), undefined, requestId);
  assert.equal(again.duplicate, true);
  assert.deepEqual(again.spin, first.spin);
  assert.equal(ledger('p1').filter((e) => e.type === 'casino_bet').length, 1);
  await rejects(spin('p1', pass, 2, at(1500)), 'VIP_TOO_FAST', 429);
  assert.equal((await spin('p1', pass, 2, at(2010))).ok, true);
  fake.write('users/p1', { ...fake.get('users/p1'), balanceCents: 300 });
  await rejects(spin('p1', pass, 5, at(5000)), 'INSUFFICIENT_BALANCE', 409);
  await rejects(spin('p1', pass, 0, at(9000)), 'BAD_BET', 400);
  await rejects(spin('p1', pass, 1.5, at(9000)), 'BAD_BET', 400);
});

test('cents round down; one Cherry on one line at $1 returns 50¢; wins on several lines add up', async () => {
  seed();
  await setPassword(TEST_PASSWORD);
  const { pass } = await unlock('p1', TEST_PASSWORD);
  let found = null;
  for (let a = 0; a < 40 && !found; a += 1) {
    for (let b = 0; b < 40 && !found; b += 1) {
      for (let c = 0; c < 40 && !found; c += 1) {
        const r = V.evaluateVipWindow(V.vipWindow([a, b, c]));
        if (r.tenths === 5 && r.dice < 3) found = [a, b, c];
      }
    }
  }
  const r = await spin('p1', pass, 1, at(10), scripted(found));
  assert.equal(r.spin.baseCents, 50);
  assert.equal(r.winCents, 50);
  assert.equal(wallet('p1'), START - 100 + 50);
  let multi = null;
  for (let a = 0; a < 40 && !multi; a += 1) {
    for (let b = 0; b < 40 && !multi; b += 1) {
      for (let c = 0; c < 40 && !multi; c += 1) {
        const w = V.evaluateVipWindow(V.vipWindow([a, b, c]));
        if (w.lines.length >= 2 && w.dice < 3) multi = [a, b, c];
      }
    }
  }
  const m = await spin('p1', pass, 3, at(3000), scripted(multi));
  assert.ok(m.spin.lines.length >= 2);
  assert.equal(m.spin.baseCents, m.spin.lines.reduce((s, l) => s + Math.floor((300 * l.tenths) / 10), 0));
});

test('disabled players are refused (unlock and spin)', async () => {
  seed();
  await setPassword(TEST_PASSWORD);
  const { pass } = await unlock('p1', TEST_PASSWORD);
  fake.write('users/p1', { ...fake.get('users/p1'), disabled: true });
  await rejects(unlock('p1', TEST_PASSWORD, at(10)), 'ACCOUNT_DISABLED', 403);
  await rejects(spin('p1', pass, 1, at(10)), 'ACCOUNT_DISABLED', 403);
  assert.equal(ledger('p1').length, 0);
});
