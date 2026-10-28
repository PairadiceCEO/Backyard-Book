// npm run test:casino  (or: node --experimental-test-module-mocks --test test/casino/casino10.test.mjs)
// 0.25.0: the craps / crapless "working" action at the real engine against the in-memory Firestore. Switching moves no money,
// writes no ledger entry and never touches the clock; a duplicate requestId is harmless; it's refused with a point on; an ON
// Place bet is paid by a come-out roll and the payout is in the roll's one ledger entry; the flags reset after a point is
// made, after a seven-out and when the dice go to a new shooter.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFakeDb } from './fakeFirestore.mjs';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;
const fake = makeFakeDb();
mock.module(url('server/firebaseAdmin.js'), {
  namedExports: { adminDb: () => fake.db, adminAuth: () => ({}), normalizePrivateKey: (k) => k },
});

const { handleTableAction } = await import(url('server/casino/tables.js'));
const D = await import(url('shared/casino/dice.js'));

const T0 = 1_800_000_000_000;
const UIDS = ['p1', 'p2'];
const START = 100_000;
function seed() {
  fake.reset();
  for (const uid of UIDS) fake.write(`users/${uid}`, { username: uid, displayName: uid.toUpperCase(), balanceCents: START, stats: { won: 0, lost: 0 }, disabled: false });
}
const callerOf = (uid) => ({ uid, token: {}, user: fake.get(`users/${uid}`) });
let dice = [];
const rng = (max) => (max === 6 && dice.length ? dice.shift() - 1 : Math.floor(Math.random() * max));
const act = (game, uid, action, fields = {}, now = T0) => handleTableAction(callerOf(uid), { game, action, ...fields }, { now, randomInt: (m) => rng(m) });
let n = 0;
const rid = () => `c10-req-${String(++n).padStart(6, '0')}`;
const wallet = (uid) => fake.get(`users/${uid}`).balanceCents;
const table = (game) => fake.get(`casinoTables/${game}`);
const ledger = () => [...fake.store].filter(([k]) => k.startsWith('ledger/')).map(([k, v]) => ({ id: k.slice(7), ...v }));
const seatOf = (game, uid) => table(game).seats.find((s) => s?.uid === uid);
const chips = (game, uid, changes, now = T0) => act(game, uid, 'bets', { changes, requestId: rid() }, now);
const roll = (game, uid, d1, d2, now = T0) => {
  dice = [d1, d2];
  return act(game, uid, 'roll', { rollSeq: table(game).rollSeq }, now);
};
const working = (game, uid, fields, now = T0) => act(game, uid, 'working', { requestId: rid(), ...fields }, now);
const err = async (p, code, message) => {
  await assert.rejects(p, (e) => {
    assert.equal(e.code, code, e.message);
    if (message) assert.match(e.message, message);
    return true;
  });
};
function moneyAddsUp() {
  for (const uid of UIDS) {
    const total = ledger().filter((e) => e.uid === uid).reduce((s, e) => s + e.amountCents, 0);
    assert.equal(START + total, wallet(uid), `${uid}: wallet = start + ledger`);
  }
}

test('craps: switching moves no money, no ledger entry, no clock change; a duplicate requestId is harmless', async () => {
  seed();
  await act('craps', 'p1', 'sit', { seat: 0 });
  await act('craps', 'p2', 'sit', { seat: 1 });
  await chips('craps', 'p1', [{ kind: 'pass', cents: 500 }, { kind: 'place', number: 4, cents: 1000 }, { kind: 'hard', number: 8, cents: 500 }]);
  const before = { wallet: wallet('p1'), ledger: ledger().length, deadline: table('craps').deadline };
  assert.ok(before.deadline, 'two players: the come-out clock is running');
  assert.equal(D.workingState(seatOf('craps', 'p1').bets), 'off', 'OFF by default');
  const same = rid();
  await act('craps', 'p1', 'working', { all: true, on: true, requestId: same }, T0 + 5000);
  const again = await act('craps', 'p1', 'working', { all: true, on: false, requestId: same }, T0 + 6000);
  assert.equal(again.duplicate, true, 'the same requestId again changes nothing');
  assert.deepEqual(seatOf('craps', 'p1').bets.working, { place: { 4: true }, hard: { 8: true } });
  assert.deepEqual([wallet('p1'), ledger().length, table('craps').deadline], [before.wallet, before.ledger, before.deadline]);
  await working('craps', 'p1', { kind: 'place', number: 4, on: false });
  assert.deepEqual(seatOf('craps', 'p1').bets.working, { place: {}, hard: { 8: true } });
  await err(working('craps', 'p1', { kind: 'place', number: 5, on: true }), 'WORKING_NOT_ALLOWED', /No Place 5 bet to switch on/);
  await err(working('craps', 'p2', { all: true, on: true }), 'WORKING_NOT_ALLOWED', /no Place bets or Hard ways/);
  await err(act('craps', 'p1', 'working', { all: true, on: true }), 'BAD_REQUEST_ID');
  await err(working('craps', 'p1', { all: true }), 'BAD_WORKING');
  moneyAddsUp();
});

test('craps: ON Place 4 is paid by a come-out 4 (in the roll\'s one payout) and stays; switching is refused with a point on; a point made resets it', async () => {
  seed();
  await act('craps', 'p1', 'sit', { seat: 0 });
  await chips('craps', 'p1', [{ kind: 'pass', cents: 500 }, { kind: 'place', number: 4, cents: 1000 }, { kind: 'hard', number: 8, cents: 500 }]);
  await working('craps', 'p1', { all: true, on: true });
  await roll('craps', 'p1', 1, 3); // come-out 4: Place 4 ON wins 9:5 = $18, the point is 4
  const t = table('craps');
  assert.equal(t.point, 4);
  const pay = ledger().find((e) => e.id === `cpay_craps_${t.epoch}-${t.rollSeq}_p1`);
  assert.equal(pay?.amountCents, 1800, 'one payout entry for the roll: the Place 4 winnings');
  assert.equal(seatOf('craps', 'p1').bets.place[4], 1000, 'Place 4 stays up');
  await err(working('craps', 'p1', { all: true, on: false }), 'WORKING_NOT_ALLOWED', /Bets always work once a Point is set/);
  await roll('craps', 'p1', 2, 2); // a hard 4: the point is made (Pass wins, Place 4 wins again)
  const seat = seatOf('craps', 'p1');
  assert.deepEqual([table('craps').point, seat.bets.place[4], seat.bets.hard[8], seat.bets.working], [null, 1000, 500, undefined], 'next come-out: OFF again');
  await err(roll('craps', 'p1', 3, 4), 'NEED_LINE_BET'); // Pass was paid: no line bet now, so bet Pass and roll a 7
  await chips('craps', 'p1', [{ kind: 'pass', cents: 500 }]);
  await roll('craps', 'p1', 3, 4); // come-out 7: Place 4 and Hard 8 are OFF, untouched
  assert.deepEqual([seatOf('craps', 'p1').bets.place[4], seatOf('craps', 'p1').bets.hard[8]], [1000, 500]);
  moneyAddsUp();
});

test('craps: ON bets lose on a come-out 7; ON Hard 8 loses easy and pays on 4-4; a seven-out resets the flags; take down clears one', async () => {
  seed();
  await act('craps', 'p1', 'sit', { seat: 0 });
  await chips('craps', 'p1', [{ kind: 'pass', cents: 500 }, { kind: 'place', number: 6, cents: 600 }, { kind: 'hard', number: 8, cents: 500 }]);
  await working('craps', 'p1', { all: true, on: true });
  const w = wallet('p1');
  await roll('craps', 'p1', 2, 5); // come-out 7: Pass wins $5; Place 6 and Hard 8 (ON) lose
  assert.deepEqual([seatOf('craps', 'p1').bets.place, seatOf('craps', 'p1').bets.hard], [{}, {}]);
  assert.equal(wallet('p1'), w + 1000, 'Pass returned $10; the $11 of ON bets was already charged and is gone');
  // Hard 8 ON: an easy 8 on the come-out loses it, a 4-4 pays.
  await chips('craps', 'p1', [{ kind: 'pass', cents: 500 }, { kind: 'hard', number: 8, cents: 500 }]);
  await working('craps', 'p1', { kind: 'hard', number: 8, on: true });
  await roll('craps', 'p1', 4, 4); // come-out 8 the hard way: Hard 8 pays 8:1 = $40, stays up; point 8
  assert.equal(seatOf('craps', 'p1').bets.hard[8], 500);
  assert.equal(ledger().find((e) => e.id === `cpay_craps_${table('craps').epoch}-${table('craps').rollSeq}_p1`)?.amountCents, 4000);
  await roll('craps', 'p1', 3, 4); // seven-out: everything goes, flags reset
  assert.equal(seatOf('craps', 'p1').bets.working, undefined);
  // Take down clears the flag.
  await chips('craps', 'p1', [{ kind: 'pass', cents: 500 }, { kind: 'place', number: 5, cents: 500 }, { kind: 'place', number: 9, cents: 500 }]);
  await working('craps', 'p1', { all: true, on: true });
  await act('craps', 'p1', 'removeBet', { kind: 'place', number: 5 });
  assert.deepEqual(seatOf('craps', 'p1').bets.working, { place: { 9: true }, hard: {} });
  // Chips added to an ON spot stay ON.
  await chips('craps', 'p1', [{ kind: 'place', number: 9, cents: 500 }]);
  assert.deepEqual([seatOf('craps', 'p1').bets.place[9], seatOf('craps', 'p1').bets.working.place[9]], [1000, true]);
  moneyAddsUp();
});

test('craps: the dice going to a new shooter on the come-out reset every seat\'s flags', async () => {
  seed();
  await act('craps', 'p1', 'sit', { seat: 0 });
  await act('craps', 'p2', 'sit', { seat: 1 });
  await chips('craps', 'p2', [{ kind: 'place', number: 6, cents: 600 }]);
  assert.equal(table('craps').shooter, 0, 'p1 has the dice (no line bet)');
  await working('craps', 'p2', { kind: 'place', number: 6, on: true });
  await act('craps', 'p1', 'tick', {}, table('craps').deadline + 1); // p1 never bets a line: the dice move on
  assert.equal(table('craps').shooter, 1);
  assert.equal(seatOf('craps', 'p2').bets.working, undefined, 'a new shooter\'s come-out: OFF');
  moneyAddsUp();
});

test('crapless: ON Place 2 and Place 11 pay on come-out rolls; OFF Place 12 is untouched', async () => {
  seed();
  await act('crapless', 'p1', 'sit', { seat: 0 });
  await chips('crapless', 'p1', [{ kind: 'pass', cents: 500 }, { kind: 'place', number: 2, cents: 200 }, { kind: 'place', number: 11, cents: 400 }, { kind: 'place', number: 12, cents: 200 }]);
  await working('crapless', 'p1', { kind: 'place', number: 2, on: true });
  await working('crapless', 'p1', { kind: 'place', number: 11, on: true });
  await roll('crapless', 'p1', 5, 6); // come-out 11: Place 11 ON pays 11:4 = $11; the point is 11
  const t = table('crapless');
  assert.equal(t.point, 11);
  assert.equal(ledger().find((e) => e.id === `cpay_crapless_${t.epoch}-${t.rollSeq}_p1`)?.amountCents, 1100);
  assert.deepEqual(seatOf('crapless', 'p1').bets.place, { 2: 200, 11: 400, 12: 200 });
  moneyAddsUp();
});
