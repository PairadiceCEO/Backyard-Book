// npm run test:vip: the server's 10,000 × B cap per paid spin (0.28.0). The real machine can't get there (its best is 7,700 × B,
// test/vipSlots.test.js), so this file swaps in a machine whose bonus would pay far more and checks the server pays exactly
// 10,000 × B in all, marks the bonus capped, and that the ledger and wallet agree. Test password values only.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFakeDb } from '../casino/fakeFirestore.mjs';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;
const fake = makeFakeDb();
mock.module(url('server/firebaseAdmin.js'), {
  namedExports: { adminDb: () => fake.db, adminAuth: () => ({}), normalizePrivateKey: (k) => k },
});
const real = await import(url('shared/casino/vipSlots.js'));
mock.module(url('shared/casino/vipSlots.js'), {
  namedExports: {
    ...real,
    // line wins 40 × B and a bonus of 20,000 × B (uncapped)
    playVipSpin: (_rnd, betCents) => ({
      stops: [0, 0, 0],
      lines: [{ line: 'middle', row: 1, id: 'bar3', label: 'Gold Bar × 3', tenths: 400 }],
      dice: 3,
      baseCents: 40 * betCents,
      bonus: { spins: [{ stops: [1, 1, 1], lines: [], dice: 0, cents: 20000 * betCents, added: 0 }], awarded: 10, cents: 20000 * betCents, capped: false },
      winCents: 20040 * betCents,
    }),
  },
});
const lock = await import(url('server/vipLock.js'));
const { spinVip, vipUnlock } = await import(url('server/casino/vipSlots.js'));

test('the server caps a paid spin at 10,000 × B in all (line wins + bonus) and says so', async () => {
  fake.reset();
  fake.write('users/p1', { username: 'p1', balanceCents: 1_000_000, disabled: false });
  const caller = { uid: 'p1', token: {}, user: null };
  await lock.setVipPassword({ password: 'test-only-cap-1', repeat: 'test-only-cap-1' }, caller, { now: new Date(1e12) });
  const { pass } = await vipUnlock(caller, { password: 'test-only-cap-1' }, { now: new Date(1e12) });
  const r = await spinVip(caller, { amount: 2, requestId: 'cap-req-000001', pass }, { now: new Date(1e12 + 10) });
  assert.equal(r.spin.baseCents, 8000);
  assert.equal(r.spin.bonus.cents, 10000 * 200 - 8000);
  assert.equal(r.spin.bonus.capped, true);
  assert.equal(r.winCents, 10000 * 200);
  assert.equal(fake.get('users/p1').balanceCents, 1_000_000 - 200 + 10000 * 200);
  assert.ok(Number.isSafeInteger(r.winCents));
  assert.match(fake.get('ledger/cpay_vip_p1_cap-req-000001_bonus').note, /capped/);
});
