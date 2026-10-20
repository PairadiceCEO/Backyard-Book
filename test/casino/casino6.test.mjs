// npm run test:casino  (or: node --experimental-test-module-mocks test/casino/casino6.test.mjs)
// 0.11.0: Craps and Crapless shooter clocks. 1 player at the table → no clock at all (no auto-roll, no
// passing the dice); 2 or more → every craps clock is 30 s. Blackjack and Baccarat keep 15 s.
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
const { DICE_ANIMATION_MS } = await import(url('server/casino/crapsTable.js'));
const timing = await import(url('shared/casino/timing.js'));

const UIDS = ['p1', 'p2', 'p3'];
const T0 = 1_800_000_000_000;
const CLOCK = 30_000;
function seed() {
  fake.reset();
  for (const uid of UIDS) fake.write(`users/${uid}`, { username: uid, displayName: `P${uid.slice(1)}`, balanceCents: 10000, stats: { won: 0, lost: 0 }, disabled: false });
}
const callerOf = (uid) => ({ uid, token: {}, user: fake.get(`users/${uid}`) });
let dice = [];
const rng = (max) => (max === 6 && dice.length ? dice.shift() - 1 : Math.floor(Math.random() * max));
const rollAs = (...d) => { dice = [...d]; };
let GAME = 'craps';
const act = (uid, action, fields = {}, now = T0) => handleTableAction(callerOf(uid), { game: GAME, action, ...fields }, { now, randomInt: rng });
let reqNo = 0;
// Puts `amount` dollars on one spot. A chip amount goes through `bet` (one chip, 0.16.0 chip check); any other whole
// amount (e.g. $6 on Place 6, built from $5 + $1 chips) goes through `bets` as one change, the way the phone sends it.
const CHIPS = [1, 2, 5, 10, 25, 100];
const bet = (uid, kind, amount, extra = {}, now = T0) => {
  const requestId = `c6-req-${String(++reqNo).padStart(6, '0')}`;
  if (CHIPS.includes(amount) || !Number.isInteger(amount) || amount <= 0) return act(uid, 'bet', { kind, amount, requestId, ...extra }, now);
  const { number, ...rest } = extra;
  return act(uid, 'bets', { changes: [{ kind, ...(number === undefined ? {} : { number }), cents: amount * 100 }], requestId, ...rest }, now);
};
const table = () => fake.get(`casinoTables/${GAME}`);
const roll = (uid, now = T0, seq = table().rollSeq) => act(uid, 'roll', { rollSeq: seq }, now);

for (const variant of ['craps', 'crapless']) {
  test(`${variant}: a player alone has no clock: none after a bet, a point, or a roll; ticks do nothing; Roll works`, async () => {
    seed();
    GAME = variant;
    await act('p1', 'sit', { seat: 0 });
    await bet('p1', 'field', 1, {}, T0 + 1000);
    assert.equal(table().deadline, null, 'no come-out clock after a bet');
    await bet('p1', 'pass', 5, {}, T0 + 2000);
    assert.equal(table().deadline, null);
    rollAs(3, 3);
    await roll('p1', T0 + 3000);
    assert.deepEqual([table().point, table().deadline], [6, null], 'point set, still no clock');
    const tick = await act('p1', 'tick', {}, T0 + 10 * 60_000);
    assert.equal(tick.applied, false, 'nothing to tick: no auto-roll, no passing the dice');
    assert.deepEqual([table().rollSeq, table().shooter], [1, 0]);
    rollAs(2, 3);
    await roll('p1', T0 + 11 * 60_000);
    assert.deepEqual([table().rollSeq, table().deadline], [2, null], 'after a roll: no clock');
    rollAs(4, 3); // seven out: the dice stay with the only player
    await roll('p1', T0 + 12 * 60_000);
    assert.deepEqual([table().point, table().shooter, table().deadline], [null, 0, null]);
  });
}

test('two players: the come-out clock, the point-phase auto-roll and the clock after the dice pass are all 30 s', async () => {
  seed();
  GAME = 'craps';
  await act('p1', 'sit', { seat: 0 });
  await act('p2', 'sit', { seat: 1 });
  await bet('p2', 'field', 1, {}, T0 + 1000);
  assert.equal(table().deadline, T0 + 1000 + CLOCK, 'come-out: from the first bet');
  // The shooter (p1) has no line bet: at zero the dice pass to p2, with a fresh 30 s.
  await act('p2', 'tick', {}, T0 + 1000 + CLOCK);
  assert.deepEqual([table().shooter, table().rollSeq], [1, 0]);
  assert.equal(table().deadline, T0 + 1000 + CLOCK + CLOCK, 'after the dice pass');
  await bet('p2', 'pass', 5, {}, T0 + 40_000);
  rollAs(4, 4);
  await roll('p2', T0 + 41_000);
  assert.equal(table().deadline, T0 + 41_000 + DICE_ANIMATION_MS + CLOCK, 'point phase: after the dice animation');
  await act('p1', 'tick', {}, table().deadline);
  assert.equal(table().rollSeq, 2, 'the server rolled for the shooter');
});

test('2 → 1 players (a leave) clears the clock; the player left alone rolls by tapping', async () => {
  seed();
  GAME = 'craps';
  await act('p1', 'sit', { seat: 0 });
  await act('p2', 'sit', { seat: 1 });
  await bet('p1', 'pass', 5, {}, T0);
  rollAs(5, 5);
  await roll('p1', T0 + 1000);
  assert.ok(table().deadline, 'two players, point on: clock running');
  await act('p2', 'leave', {}, T0 + 2000); // nothing in play: the seat frees
  assert.equal(table().seats[1], null);
  assert.equal(table().deadline, null, 'one player left: no clock');
  assert.equal((await act('p1', 'tick', {}, T0 + 5 * 60_000)).applied, false);
});

test('2 → 1 players (the 60 s heartbeat frees a seat) clears the clock', async () => {
  seed();
  GAME = 'craps';
  await act('p1', 'sit', { seat: 0 }, T0);
  await act('p2', 'sit', { seat: 1 }, T0);
  await bet('p1', 'field', 1, {}, T0 + 1000); // starts the come-out clock…
  await act('p1', 'removeBet', { kind: 'field' }, T0 + 2000); // …and the felt is empty again (idle table)
  assert.ok(table().deadline);
  await act('p1', 'heartbeat', {}, T0 + 62_000); // p2 has been gone 60 s
  assert.equal(table().seats[1], null, 'the heartbeat freed the gone seat');
  assert.equal(table().deadline, null);
});

test('2 → 1 players after a roll (a gone player is marked leaving at the sweep): no new clock', async () => {
  seed();
  GAME = 'craps';
  await act('p1', 'sit', { seat: 0 }, T0);
  await act('p2', 'sit', { seat: 1 }, T0);
  await bet('p2', 'pass', 5, {}, T0);
  await bet('p1', 'pass', 5, {}, T0);
  rollAs(4, 5); // point 9
  await roll('p1', T0 + 1000);
  await act('p1', 'heartbeat', {}, T0 + 69_000);
  rollAs(2, 2);
  await roll('p1', T0 + 70_000); // p2 gone 60 s: leaving, Pass still in play
  const t = table();
  assert.equal(t.seats[1].leaving, true);
  assert.deepEqual([t.point, t.deadline], [9, null], 'one player at the table: no clock');
});

test('1 → 2 players with a point on: a 30 s clock from that moment; on a come-out it waits for the next bet', async () => {
  seed();
  GAME = 'craps';
  await act('p1', 'sit', { seat: 0 });
  await bet('p1', 'pass', 5, {}, T0);
  rollAs(2, 4);
  await roll('p1', T0 + 1000);
  assert.deepEqual([table().point, table().deadline], [6, null]);
  await act('p2', 'sit', { seat: 1 }, T0 + 50_000);
  assert.equal(table().deadline, T0 + 50_000 + CLOCK, 'point on: clock starts when the second player sits');

  // Come-out: the second player sitting starts nothing; the next bet does.
  seed();
  await act('p1', 'sit', { seat: 0 });
  await bet('p1', 'pass', 5, {}, T0);
  assert.equal(table().deadline, null);
  await act('p2', 'sit', { seat: 1 }, T0 + 5000);
  assert.equal(table().deadline, null, 'come-out: no clock yet');
  await bet('p2', 'field', 1, {}, T0 + 6000);
  assert.equal(table().deadline, T0 + 6000 + CLOCK);
});

test('onDeadline re-checks the player count before rolling or passing the dice', async () => {
  seed();
  GAME = 'craps';
  await act('p1', 'sit', { seat: 0 });
  await act('p2', 'sit', { seat: 1 });
  await bet('p1', 'pass', 5, {}, T0);
  rollAs(3, 5);
  await roll('p1', T0 + 1000);
  const deadline = table().deadline;
  assert.ok(deadline);
  // The count drops without a seat change reaching the clock (e.g. a table doc from before this rule).
  const doc = table();
  doc.seats[1].leaving = true;
  doc.clocksOn = true;
  fake.write(`casinoTables/${GAME}`, doc);
  const r = await act('p1', 'tick', {}, deadline);
  assert.equal(r.applied, true);
  assert.deepEqual([table().rollSeq, table().deadline], [1, null], 'no auto-roll for a player alone');
});

test('a shooter who left with bets in play still gets the auto-roll (nobody can tap Roll for them)', async () => {
  seed();
  GAME = 'craps';
  await act('p1', 'sit', { seat: 0 });
  await act('p2', 'sit', { seat: 1 });
  await bet('p1', 'pass', 5, {}, T0);
  rollAs(1, 3); // point 4
  await roll('p1', T0 + 1000);
  await act('p1', 'leave', {}, T0 + 2000); // Pass in play: leaving, keeps the dice
  const t = table();
  assert.deepEqual([t.seats[0].leaving, t.shooter], [true, 0]);
  assert.ok(t.deadline, 'clock still running for the departed shooter');
  rollAs(3, 4); // seven out: dice to p2, who is now alone → no clock
  await act('p2', 'tick', {}, t.deadline);
  assert.deepEqual([table().rollSeq, table().shooter, table().deadline], [2, 1, null]);
});

test('Blackjack and Baccarat keep their 15 s clocks, even with one player', async () => {
  assert.equal(timing.TURN_SECONDS, 15);
  assert.equal(timing.CRAPS_TURN_SECONDS, 30);
  seed();
  GAME = 'blackjack';
  await act('p1', 'sit', { seat: 0 });
  await act('p1', 'bet', { amount: 5, requestId: 'c6-bj-000001' }, T0);
  assert.equal(table().deadline, T0 + 15_000);
  GAME = 'baccarat';
  await act('p1', 'sit', { seat: 0 });
  await act('p1', 'bet', { player: 5, requestId: 'c6-bc-000001' }, T0);
  assert.equal(table().deadline, T0 + 15_000);
});
