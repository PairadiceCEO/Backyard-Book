// npm run test:casino  (or: node --experimental-test-module-mocks test/casino/casino4.test.mjs)
// Casino phase 4: Craps and Crapless Craps at the shared table (one engine, two variants).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFakeDb } from './fakeFirestore.mjs';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;
const fake = makeFakeDb();
const TOKENS = { 'p1-token': { uid: 'p1' } };
mock.module(url('server/firebaseAdmin.js'), {
  namedExports: {
    adminDb: () => fake.db,
    adminAuth: () => ({ async verifyIdToken(t) { if (!TOKENS[t]) throw new Error('bad'); return { ...TOKENS[t] }; } }),
    normalizePrivateKey: (k) => k,
  },
});

const { handleTableAction } = await import(url('server/casino/tables.js'));
const { DICE_ANIMATION_MS } = await import(url('server/casino/crapsTable.js'));
const { groupShopPurchases } = await import(url('src/lib/shopHistory.js'));
const handler = (await import(url('api/casino.js'))).default;

const UIDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
const T0 = 1_800_000_000_000;
function seed(balanceCents = 10000) {
  fake.reset();
  for (const uid of UIDS) fake.write(`users/${uid}`, { username: uid, displayName: `P${uid.slice(1)}`, balanceCents, stats: { won: 4, lost: 1 }, disabled: false });
}
const callerOf = (uid) => ({ uid, token: {}, user: fake.get(`users/${uid}`) });
let dice = [];
const scriptedRng = (max) => {
  if (max === 6 && dice.length) return dice.shift() - 1;
  return Math.floor(Math.random() * max);
};
let rng = scriptedRng;
const rollAs = (...d) => { dice = [...d]; };
let GAME = 'craps';
const act = (uid, action, fields = {}, now = T0) => handleTableAction(callerOf(uid), { game: GAME, action, ...fields }, { now, randomInt: (m) => rng(m) });
let reqNo = 0;
// Puts `amount` dollars on one spot. A chip amount goes through `bet` (one chip, 0.16.0 chip check); any other whole
// amount (e.g. $6 on Place 6, built from $5 + $1 chips) goes through `bets` as one change, the way the phone sends it.
const CHIPS = [1, 2, 5, 10, 25, 100];
const bet = (uid, kind, amount, extra = {}, now = T0) => {
  const requestId = `cr-req-${String(++reqNo).padStart(6, '0')}`;
  if (CHIPS.includes(amount) || !Number.isInteger(amount) || amount <= 0) return act(uid, 'bet', { kind, amount, requestId, ...extra }, now);
  const { number, ...rest } = extra;
  return act(uid, 'bets', { changes: [{ kind, ...(number === undefined ? {} : { number }), cents: amount * 100 }], requestId, ...rest }, now);
};
const table = () => fake.get(`casinoTables/${GAME}`);
const wallet = (uid) => fake.get(`users/${uid}`).balanceCents;
const ledger = () => [...fake.store].filter(([k]) => k.startsWith('ledger/')).map(([k, v]) => ({ id: k.slice(7), ...v }));
const err = async (p, code) => { await assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return true; }); };
const seatOf = (uid) => table().seats.findIndex((s) => s && s.uid === uid);
const betsOf = (uid) => table().seats[seatOf(uid)].bets;
const roll = (uid, now = T0, seq = table().rollSeq) => act(uid, 'roll', { rollSeq: seq }, now);
async function sitAll(uids) {
  for (const [i, uid] of uids.entries()) await act(uid, 'sit', { seat: i });
}
function moneyAddsUp(start) {
  for (const uid of UIDS) {
    const sum = ledger().filter((e) => e.uid === uid).reduce((s, e) => s + e.amountCents, 0);
    assert.equal(start + sum, wallet(uid), `${uid}: wallet = start + ledger`);
    assert.ok(wallet(uid) >= 0);
  }
}

// ---------- seats, shooter, the clock ----------
test('the first player to sit gets the dice; rolling needs the dice and a line bet', async () => {
  seed();
  GAME = 'craps';
  await sitAll(['p1', 'p2']);
  let t = table();
  assert.deepEqual([t.shooter, t.point, t.rollSeq, t.deadline], [0, null, 0, null], 'an empty felt never ticks');
  await err(roll('p1'), 'NEED_LINE_BET');
  await err(roll('p2'), 'NOT_SHOOTER');
  await bet('p2', 'field', 1, {}, T0 + 1000);
  assert.equal(table().deadline, T0 + 1000 + 30_000, 'the first bet after the last roll starts the (30 s, two players) clock');
  await bet('p1', 'pass', 5, {}, T0 + 3000);
  assert.equal(table().deadline, T0 + 31_000, 'later bets do not move it');
  rollAs(3, 3);
  await roll('p1', T0 + 4000);
  t = table();
  assert.deepEqual([t.point, t.rollSeq, t.lastRoll.dice, t.lastRoll.kind], [6, 1, [3, 3], 'point']);
  assert.equal(t.deadline, T0 + 4000 + DICE_ANIMATION_MS + 30_000, 'with a point on, the clock restarts right after each roll');
  assert.equal(wallet('p2'), 10000 - 100, 'Field lost on a 6');
});

test('a full Craps hand: point, Odds, Place 6 at 7:6 ($5 wins $5.83), Field, point made, one payout per player per roll', async () => {
  seed();
  GAME = 'craps';
  await sitAll(['p1', 'p2']);
  await bet('p1', 'pass', 5);
  await err(bet('p1', 'odds', 5), 'BET_NOT_ALLOWED');
  await err(bet('p2', 'place', 5, { number: 6 }), 'BET_NOT_ALLOWED');
  rollAs(4, 2);
  await roll('p1');
  assert.equal(table().point, 6);
  await err(bet('p1', 'pass', 1), 'BET_NOT_ALLOWED');
  await err(bet('p2', 'odds', 5), 'BET_NOT_ALLOWED', 'odds need a Pass bet');
  await bet('p1', 'odds', 10);
  await err(bet('p1', 'odds', 1), 'SPOT_LIMIT');
  await bet('p2', 'place', 5, { number: 6 });
  await bet('p2', 'field', 1);
  await err(act('p1', 'removeBet', { kind: 'pass' }), 'BET_LOCKED');
  // A 6 by way of 5+1: point made. Pass 1:1, Odds 6:5, Place 6 7:6 (stays up), Field loses on 6.
  rollAs(5, 1);
  await roll('p1');
  const t = table();
  assert.deepEqual([t.point, t.lastRoll.kind, t.deadline], [null, 'pointMade', null]);
  assert.equal(wallet('p1'), 10000 - 500 - 1000 + 1000 + 1000 + 1200);
  assert.equal(wallet('p2'), 10000 - 500 - 100 + 583, 'Place 6 pays $5.83; its $5 stays up');
  assert.deepEqual(betsOf('p2').place, { 6: 500 });
  assert.deepEqual(betsOf('p1'), { pass: 0, dontPass: 0, odds: 0, dontOdds: 0, come: 0, field: 0, place: {}, hard: {}, comeOn: {} });
  const pays = ledger().filter((e) => e.type === 'casino_payout');
  assert.deepEqual(pays.map((e) => e.id).sort(), [`cpay_craps_${t.epoch}-2_p1`, `cpay_craps_${t.epoch}-2_p2`].sort());
  assert.deepEqual(t.seats[1].lastRoll, { seq: 2, netCents: 583 - 100, profitCents: 583, lostCents: 100, returnCents: 583 });
  assert.equal(t.shooter, 0, 'point made: same shooter');
  assert.deepEqual(fake.get('users/p1').stats, { won: 4, lost: 1 }, 'win rate stays sportsbook-only');
  moneyAddsUp(10000);
});

test('Place bets are off on a come-out; a seven-out loses Pass, Odds and Place and passes the dice clockwise', async () => {
  seed();
  GAME = 'craps';
  await sitAll(['p1', 'p2', 'p3']);
  await bet('p1', 'pass', 5);
  await bet('p3', 'dontPass', 4);
  rollAs(4, 4); // point 8
  await roll('p1');
  await bet('p1', 'odds', 5);
  await bet('p2', 'place', 6, { number: 6 });
  await bet('p2', 'place', 5, { number: 5 });
  rollAs(3, 4); // seven out
  await roll('p1');
  let t = table();
  assert.deepEqual([t.point, t.lastRoll.kind, t.shooter], [null, 'sevenOut', 1], 'dice to seat 2');
  assert.equal(wallet('p1'), 10000 - 1000);
  assert.equal(wallet('p2'), 10000 - 1100);
  assert.equal(wallet('p3'), 10000 - 400 + 800, "Don't Pass wins on the seven-out");
  assert.deepEqual(betsOf('p2').place, {});
  // Place up, point made, then a come-out 7: the Place bet is off, so it survives.
  await bet('p2', 'pass', 2);
  rollAs(2, 2); // point 4
  await roll('p2');
  await bet('p1', 'place', 6, { number: 6 });
  rollAs(1, 3); // point made
  await roll('p2');
  assert.equal(table().point, null);
  await bet('p2', 'pass', 1);
  rollAs(6, 1); // come-out 7: Pass wins, Place 6 is off
  await roll('p2');
  t = table();
  assert.equal(t.lastRoll.kind, 'natural');
  assert.deepEqual(betsOf('p1').place, { 6: 600 }, 'off on the come-out: still up');
  assert.equal(t.shooter, 1, 'a come-out 7 is a winner, not a seven-out: same shooter');
  moneyAddsUp(10000);
});

test("Don't Pass is barred on 12 (push) and wins on 2 or 3; taken down only before the come-out", async () => {
  seed();
  GAME = 'craps';
  await sitAll(['p1']);
  await bet('p1', 'dontPass', 5);
  rollAs(6, 6);
  await roll('p1');
  assert.deepEqual([betsOf('p1').dontPass, wallet('p1')], [500, 9500], '12: push, the bet stays');
  rollAs(1, 2);
  await roll('p1');
  assert.deepEqual([betsOf('p1').dontPass, wallet('p1')], [0, 10500]);
  await bet('p1', 'dontPass', 3);
  const r = await act('p1', 'removeBet', { kind: 'dontPass' });
  assert.equal(r.refundedCents, 300);
  assert.equal(wallet('p1'), 10500);
  assert.ok(ledger().some((e) => e.type === 'casino_refund' && e.amountCents === 300));
});

test('taking bets down: Odds, Place and Field any time before the roll; Pass only before a point; nothing twice', async () => {
  seed();
  GAME = 'craps';
  await sitAll(['p1']);
  await bet('p1', 'pass', 5);
  await bet('p1', 'field', 2);
  await act('p1', 'removeBet', { kind: 'field' });
  await err(act('p1', 'removeBet', { kind: 'field' }), 'NO_BET');
  rollAs(5, 5); // point 10
  await roll('p1');
  await bet('p1', 'odds', 4);
  await bet('p1', 'place', 3, { number: 9 });
  await act('p1', 'removeBet', { kind: 'odds' });
  await act('p1', 'removeBet', { kind: 'place', number: 9 });
  await err(act('p1', 'removeBet', { kind: 'pass' }), 'BET_LOCKED');
  assert.deepEqual(betsOf('p1'), { pass: 500, dontPass: 0, odds: 0, dontOdds: 0, come: 0, field: 0, place: {}, hard: {}, comeOn: {} });
  assert.equal(wallet('p1'), 9500);
  assert.equal(new Set(ledger().map((e) => e.id)).size, ledger().length);
  moneyAddsUp(10000);
});

test('chips and amounts: a chip is $1–$100 in denominations, a spot has no maximum (the wallet is the cap), leaving players, unknown bets', async () => {
  seed(2200);
  GAME = 'craps';
  await sitAll(['p1', 'p2']);
  await err(act('p1', 'bet', { kind: 'pass', amount: 11, requestId: 'cr-chip-0011' }), 'BAD_CHIP');
  await err(bet('p1', 'pass', 0), 'BAD_CHIP');
  await err(bet('p1', 'pass', 2.5), 'BAD_CHIP');
  await err(bet('p1', 'hardways', 1), 'BAD_BET');
  await err(bet('p1', 'place', 1), 'BAD_BET');
  await err(bet('p1', 'hard', 1), 'BAD_BET', 'a Hard way needs its number');
  await bet('p1', 'pass', 10);
  await bet('p1', 'pass', 10);
  await bet('p1', 'pass', 1); // $21 on Pass: no line limit any more
  await err(bet('p1', 'field', 2), 'INSUFFICIENT_BALANCE');
  assert.equal(wallet('p1'), 100);
  assert.equal(betsOf('p1').pass, 2100);
  await act('p2', 'leave');
  assert.equal(table().seats[1], null, 'nothing riding: freed at once');
  await bet('p1', 'field', 1);
  const r = await act('p1', 'leave');
  assert.equal(r.leaving, true, 'a Pass bet must play out');
  await err(bet('p1', 'field', 1), 'LEAVING');
});

// ---------- the rollSeq guard ----------
test('another seat bets between the shooter loading the table and tapping Roll: the roll still goes through', async () => {
  seed();
  GAME = 'craps';
  await sitAll(['p1', 'p2', 'p3']);
  await bet('p1', 'pass', 5);
  const loaded = table(); // the shooter's phone loads the table here
  // In between: two other seats bet (the table doc is rewritten, version bumped).
  await bet('p2', 'field', 3, {}, T0 + 200);
  await bet('p3', 'pass', 2, {}, T0 + 300);
  assert.ok(table().version > loaded.version);
  rollAs(2, 5);
  const r = await act('p1', 'roll', { rollSeq: loaded.rollSeq }, T0 + 400);
  assert.equal(r.ok, true, 'the roll went through');
  assert.equal(table().rollSeq, loaded.rollSeq + 1);
  // A second Roll with the same rollSeq (a double tap) is refused and changes nothing.
  const before = table();
  await err(act('p1', 'roll', { rollSeq: loaded.rollSeq }, T0 + 500), 'STALE');
  assert.deepEqual(table(), before);
});

test('double-tapping Roll at the same instant rolls once', async () => {
  seed();
  GAME = 'craps';
  await sitAll(['p1']);
  await bet('p1', 'pass', 5);
  rollAs(3, 3, 4, 4);
  const seq = table().rollSeq;
  const results = await Promise.allSettled([roll('p1', T0, seq), roll('p1', T0, seq)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'STALE');
  assert.equal(table().rollSeq, seq + 1);
  assert.deepEqual(table().lastRoll.dice, [3, 3]);
});

// ---------- timers ----------
test('auto-roll: at zero the server rolls for the shooter, exactly once when five phones tick', async () => {
  seed();
  GAME = 'craps';
  await sitAll(['p1', 'p2']);
  await bet('p1', 'pass', 5);
  const deadline = table().deadline;
  assert.equal((await act('p2', 'tick', {}, deadline - 1)).applied, false);
  rollAs(2, 2, 6, 6);
  const ticks = await Promise.all(['p1', 'p2', 'p3', 'p4', 'p5'].map((u) => act(u, 'tick', {}, deadline + 100)));
  assert.equal(ticks.filter((r) => r.applied).length, 1);
  assert.deepEqual([table().rollSeq, table().point], [1, 4]);
  // Point phase: the clock restarted after the roll; at zero, another auto-roll.
  const d2 = table().deadline;
  await act('p2', 'tick', {}, d2);
  assert.equal(table().rollSeq, 2);
});

test('come-out with no line bet from the shooter: the dice pass on; after a full lap the table waits for a line bet', async () => {
  seed();
  GAME = 'craps';
  await sitAll(['p1', 'p2', 'p3']);
  await bet('p2', 'field', 1, {}, T0); // starts the clock; the shooter (seat 1) has no line bet
  let t = table();
  await act('p3', 'tick', {}, t.deadline);
  t = table();
  assert.deepEqual([t.shooter, t.rollSeq, t.waiting], [1, 0, false], 'dice to seat 2, no roll');
  assert.ok(t.deadline > T0 + 30_000, 'the clock restarted');
  await act('p3', 'tick', {}, t.deadline);
  await act('p3', 'tick', {}, table().deadline);
  t = table();
  assert.deepEqual([t.waiting, t.deadline], [true, null], 'a full lap: waiting, no clock');
  assert.equal((await act('p3', 'tick', {}, t.updatedAt + 60_000)).applied, false, 'nothing to tick');
  await bet('p3', 'pass', 2, {}, t.updatedAt + 1000);
  t = table();
  assert.deepEqual([t.shooter, t.waiting], [2, false], 'whoever bets a line gets the dice');
  assert.ok(t.deadline);
});

// ---------- leaving and gone players ----------
test('a player gone 60 s: Pass keeps working until decided, then the seat frees and Place/Field are refunded', async () => {
  seed();
  GAME = 'craps';
  await sitAll(['p1', 'p2']);
  await bet('p2', 'pass', 5, {}, T0);
  await bet('p1', 'pass', 1, {}, T0);
  rollAs(4, 5); // point 9
  await roll('p1', T0 + 1000);
  await bet('p2', 'place', 5, { number: 6 }, T0 + 2000); // p2's last action
  await bet('p2', 'field', 2, {}, T0 + 2000);
  // p1 keeps playing; p2 goes quiet. 70 s later a roll that decides nothing for Pass.
  rollAs(2, 2);
  await act('p1', 'heartbeat', {}, T0 + 69_000);
  await roll('p1', T0 + 70_000);
  let t = table();
  assert.ok(t.seats[1], 'still seated: Pass is in play');
  assert.equal(t.seats[1].leaving, true);
  assert.equal(t.seats[1].bets.field, 0, 'the Field was decided by that roll');
  // Point made: p2's Pass is paid, then the seat frees and the Place 6 comes back.
  const before = wallet('p2');
  rollAs(3, 6);
  await roll('p1', T0 + 71_000);
  t = table();
  assert.equal(t.seats[1], null, 'freed once Pass was decided');
  assert.equal(wallet('p2'), before + 1000 + 500, 'Pass paid $10, Place 6 refunded $5');
  assert.ok(ledger().some((e) => e.uid === 'p2' && e.type === 'casino_refund' && e.amountCents === 500));
  moneyAddsUp(10000);
});

test('the shooter leaves with nothing in play: the dice move to the next seat', async () => {
  seed();
  GAME = 'craps';
  await sitAll(['p1', 'p2', 'p3']);
  await act('p1', 'leave');
  assert.equal(table().shooter, 1);
  await act('p2', 'leave');
  await act('p3', 'leave');
  const t = table();
  assert.deepEqual([t.shooter, t.deadline], [null, null], 'empty table: no shooter, no clock');
  await act('p4', 'sit', { seat: 3 });
  assert.equal(table().shooter, 3);
});

// ---------- Crapless ----------
test('Crapless: 2, 3, 11, 12 are points; Odds 2/12 at 5:1; Place 11 at 11:4; no Don’t Pass; same engine', async () => {
  seed();
  GAME = 'crapless';
  await sitAll(['p1', 'p2']);
  await err(bet('p1', 'dontPass', 5), 'BET_NOT_ALLOWED');
  await bet('p1', 'pass', 5);
  rollAs(1, 1); // 2 is the point
  await roll('p1');
  assert.deepEqual([table().point, table().lastRoll.kind], [2, 'point']);
  await bet('p1', 'odds', 2);
  await bet('p2', 'place', 4, { number: 11 });
  rollAs(5, 6); // 11: Place 11 wins 11:4
  await roll('p1');
  assert.equal(wallet('p2'), 10000 - 400 + 1100);
  rollAs(1, 1); // point made: Pass 1:1, Odds 5:1
  await roll('p1');
  assert.equal(wallet('p1'), 10000 - 700 + 1000 + 1200);
  rollAs(6, 5); // come-out 11 in Crapless: a point, not a winner
  await bet('p1', 'pass', 1);
  await roll('p1');
  assert.deepEqual([table().point, table().lastRoll.kind], [11, 'point']);
  moneyAddsUp(10000);
  assert.equal(fake.get('casinoTables/craps'), undefined, 'separate tables');
});

// ---------- many real rolls ----------
for (const variant of ['craps', 'crapless']) {
  test(`${variant}: 600 real crypto rolls with random bets, both variants through one engine; money adds up`, async () => {
    seed(1_000_000);
    GAME = variant;
    dice = [];
    rng = (await import(url('server/casino/rng.js'))).randomInt;
    await sitAll(['p1', 'p2', 'p3']);
    let now = T0;
    const kinds = {};
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    for (let i = 0; i < 600; i += 1) {
      now += 3000;
      for (const uid of ['p1', 'p2', 'p3']) {
        await act(uid, 'heartbeat', {}, now);
        const t = table();
        const choice = pick(['pass', 'dontPass', 'odds', 'place', 'field', 'none', 'none', 'remove']);
        const number = pick(Object.keys(t.point === null ? { 6: 1 } : { 4: 1, 5: 1, 6: 1, 8: 1, 9: 1, 10: 1, 2: 1, 12: 1 })).valueOf();
        try {
          if (choice === 'remove') await act(uid, 'removeBet', { kind: pick(['odds', 'place', 'field', 'pass']), number: Number(number) }, now);
          else if (choice !== 'none') await bet(uid, choice, 1 + Math.floor(Math.random() * 3), choice === 'place' ? { number: Number(number) } : {}, now);
        } catch (e) {
          assert.ok(['BET_NOT_ALLOWED', 'SPOT_LIMIT', 'BET_LOCKED', 'NO_BET'].includes(e.code), `${choice}: ${e.code} ${e.message}`);
        }
      }
      const t = table();
      const shooter = t.seats[t.shooter];
      if (shooter && (shooter.bets.pass || shooter.bets.dontPass)) await act(shooter.uid, 'roll', { rollSeq: t.rollSeq }, now);
      else if (t.deadline) await act('p1', 'tick', {}, t.deadline);
      const after = table();
      if (after.lastRoll) kinds[after.lastRoll.kind] = (kinds[after.lastRoll.kind] ?? 0) + 1;
      for (const seat of after.seats.filter(Boolean)) {
        assert.ok(after.point !== null || seat.bets.odds === 0, 'no Odds without a point');
        for (const v of Object.values(seat.bets.place)) assert.ok(v > 0 && v <= 1000);
      }
    }
    assert.ok(table().rollSeq > 100, `rolled ${table().rollSeq} times`);
    for (const k of ['natural', 'point', 'pointMade', 'sevenOut', 'roll']) assert.ok(kinds[k] > 0, `saw ${k}: ${JSON.stringify(kinds)}`);
    if (variant === 'craps') assert.ok(kinds.craps > 0);
    else assert.equal(kinds.craps ?? 0, 0, 'Crapless has no craps');
    moneyAddsUp(1_000_000);
    assert.ok(ledger().every((e) => e.game === variant));
    assert.equal(groupShopPurchases(ledger(), []).totalCount, 0);
  });
}

test('/api/casino: every table is open now; game errors are clear', async () => {
  seed();
  const call = async (body) => {
    const res = { headers: {}, statusCode: 0, body: null, headersSent: false, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } };
    await handler({ method: 'POST', headers: { authorization: 'Bearer p1-token' }, body }, res);
    return res;
  };
  for (const game of ['craps', 'crapless', 'blackjack', 'baccarat']) {
    const r = await call({ action: 'sit', game });
    assert.equal(r.statusCode, 200, `${game}: ${JSON.stringify(r.body)}`);
  }
  const r = await call({ action: 'hit', game: 'craps' });
  assert.deepEqual([r.statusCode, r.body.error.code], [400, 'UNKNOWN_ACTION']);
  const roll2 = await call({ action: 'roll', game: 'craps', rollSeq: 0 });
  assert.equal(roll2.body.error.code, 'NEED_LINE_BET');
});

// ---------- chips in one request, Odds up to 2× Pass ----------
const chipsDown = (uid, changes, now = T0, requestId = `cr-chips-${String(++reqNo).padStart(6, '0')}`) => act(uid, 'bets', { changes, requestId }, now);

test('chips tapped together arrive as one request: all applied with one charge, or none', async () => {
  rng = scriptedRng;
  dice = [];
  seed();
  GAME = 'craps';
  await sitAll(['p1', 'p2']);
  await chipsDown('p1', [{ kind: 'pass', cents: 500 }, { kind: 'pass', cents: 200 }, { kind: 'field', cents: 100 }]);
  assert.deepEqual([betsOf('p1').pass, betsOf('p1').field, wallet('p1')], [700, 100, 10000 - 800]);
  assert.equal(ledger().filter((e) => e.uid === 'p1' && e.type === 'casino_bet').length, 1, 'one charge for the batch');
  // One bad chip refuses the whole batch and changes nothing.
  const before = table();
  await err(chipsDown('p1', [{ kind: 'field', cents: 100 }, { kind: 'odds', cents: 100 }]), 'BET_NOT_ALLOWED', 'Odds before a point');
  await err(chipsDown('p1', [{ kind: 'field', cents: 100 }, { kind: 'pass', cents: 100_000_100 }]), 'BET_TOO_LARGE');
  await err(chipsDown('p1', [{ kind: 'place', number: 6, cents: 100 }]), 'BET_NOT_ALLOWED');
  await err(chipsDown('p1', [{ kind: 'field', cents: 150 }]), 'BAD_BET');
  await err(chipsDown('p1', [{ kind: 'field', cents: -300 }]), 'NO_BET');
  assert.deepEqual(table(), before);
  // Undo = take a chip back (refund); mixed batches net out as one charge + one refund.
  await chipsDown('p1', [{ kind: 'pass', cents: -200 }]);
  assert.deepEqual([betsOf('p1').pass, wallet('p1')], [500, 10000 - 600]);
  await chipsDown('p1', [{ kind: 'field', cents: -100 }, { kind: 'dontPass', cents: 300 }]);
  assert.deepEqual([betsOf('p1').field, betsOf('p1').dontPass, wallet('p1')], [0, 300, 10000 - 800]);
  // A retried request is applied once.
  await chipsDown('p2', [{ kind: 'field', cents: 200 }], T0, 'cr-chips-replay-1');
  assert.equal((await chipsDown('p2', [{ kind: 'field', cents: 200 }], T0, 'cr-chips-replay-1')).duplicate, true);
  assert.equal(wallet('p2'), 9800);
  // Wallet: refunds in the same batch count toward the new chips.
  seed(300);
  await sitAll(['p1']);
  await chipsDown('p1', [{ kind: 'pass', cents: 300 }]);
  await chipsDown('p1', [{ kind: 'pass', cents: -300 }, { kind: 'dontPass', cents: 300 }]);
  assert.deepEqual([betsOf('p1').pass, betsOf('p1').dontPass, wallet('p1')], [0, 300, 0]);
  await err(chipsDown('p1', [{ kind: 'field', cents: 100 }]), 'INSUFFICIENT_BALANCE');
  moneyAddsUp(300);
});

test('Odds behind Pass: up to 2× the Pass bet (a game rule, kept with no other maximum); Crapless the same', async () => {
  rng = scriptedRng;
  dice = [];
  for (const variant of ['craps', 'crapless']) {
    seed();
    GAME = variant;
    await sitAll(['p1', 'p2']);
    await bet('p1', 'pass', 10);
    await bet('p2', 'pass', 3);
    rollAs(3, 3); // point 6
    await roll('p1');
    await chipsDown('p1', [{ kind: 'odds', cents: 1000 }, { kind: 'odds', cents: 1000 }]);
    assert.equal(betsOf('p1').odds, 2000, '$10 Pass allows $20 Odds');
    await err(chipsDown('p1', [{ kind: 'odds', cents: 100 }]), 'SPOT_LIMIT');
    await chipsDown('p2', [{ kind: 'odds', cents: 500 }, { kind: 'odds', cents: 100 }]);
    await err(chipsDown('p2', [{ kind: 'odds', cents: 100 }]), 'SPOT_LIMIT', '$3 Pass allows $6 Odds');
    await err(act('p2', 'bet', { kind: 'place', number: 6, amount: 11, requestId: `cr-chip-11-${variant}` }), 'BAD_CHIP', '$11 is not one chip');
    // Point made: $20 Odds on 6 pay 6:5.
    rollAs(4, 2);
    await roll('p1');
    assert.equal(wallet('p1'), 10000 - 3000 + 2000 + 2000 + 2400);
    moneyAddsUp(10000);
  }
});

test('the roll reply carries the dice and the table, so the shooter sees it at once', async () => {
  rng = scriptedRng;
  dice = [];
  seed();
  GAME = 'craps';
  await sitAll(['p1']);
  await bet('p1', 'pass', 5);
  rollAs(2, 6);
  const r = await roll('p1');
  assert.deepEqual([r.dice, r.total, r.kind], [[2, 6], 8, 'point']);
  assert.deepEqual(r.table.lastRoll.dice, [2, 6]);
  assert.equal(r.table.version, table().version);
  assert.equal(r.balanceCents, wallet('p1'));
});
