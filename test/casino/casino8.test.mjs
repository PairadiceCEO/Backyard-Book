// npm run test:casino  (or: node --experimental-test-module-mocks --test test/casino/casino8.test.mjs)
// 0.23.0: Craps / Crapless Place bets before the point (off on the come-out roll), the Come rules kept as they were, every
// chip tap counting on the server (ten $5 chips, each its own request, end at exactly $50 with one ledger entry each).
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
const { spinSlots } = await import(url('server/casino/slots.js'));
const D = await import(url('shared/casino/dice.js'));
const { DICE_VARIANTS } = await import(url('shared/casino/diceVariants.js'));

const T0 = 1_800_000_000_000;
const UIDS = ['p1', 'p2', 'p3'];
function seed(balanceCents = 100_000) {
  fake.reset();
  for (const uid of UIDS) fake.write(`users/${uid}`, { username: uid, displayName: uid.toUpperCase(), balanceCents, stats: { won: 0, lost: 0 }, disabled: false });
}
const callerOf = (uid) => ({ uid, token: {}, user: fake.get(`users/${uid}`) });
let dice = [];
const rng = (max) => (max === 6 && dice.length ? dice.shift() - 1 : Math.floor(Math.random() * max));
const act = (game, uid, action, fields = {}, now = T0) => handleTableAction(callerOf(uid), { game, action, ...fields }, { now, randomInt: (m) => rng(m) });
let n = 0;
const rid = () => `c8-req-${String(++n).padStart(6, '0')}`;
const wallet = (uid) => fake.get(`users/${uid}`).balanceCents;
const table = (game) => fake.get(`casinoTables/${game}`);
const ledger = () => [...fake.store].filter(([k]) => k.startsWith('ledger/')).map(([k, v]) => ({ id: k.slice(7), ...v }));
function moneyAddsUp(start) {
  for (const uid of UIDS) {
    const total = ledger().filter((e) => e.uid === uid).reduce((s, e) => s + e.amountCents, 0);
    assert.equal(start + total, wallet(uid), `${uid}: wallet = start + ledger`);
  }
}
const seatOf = (game, uid) => table(game).seats.find((s) => s?.uid === uid);
const chips = (game, uid, changes) => act(game, uid, 'bets', { changes, requestId: rid() });
const roll = (game, uid, d1, d2) => {
  dice = [d1, d2];
  return act(game, uid, 'roll', { rollSeq: table(game).rollSeq });
};

// ================= 1. Place bets before the point =================
for (const game of ['craps', 'crapless']) {
  test(`${game}: a Place bet goes up on a come-out; a come-out 7 and a come-out 6 leave it untouched; the next point-phase 6 pays it`, async () => {
    seed();
    await act(game, 'p1', 'sit', { seat: 0 });
    // Come-out: Place 6 and Place 8 go down before any point (refused before 0.23.0).
    await chips(game, 'p1', [{ kind: 'pass', cents: 500 }, { kind: 'place', number: 6, cents: 600 }, { kind: 'place', number: 8, cents: 600 }]);
    assert.equal(table(game).point, null, 'still the come-out');
    assert.deepEqual(seatOf(game, 'p1').bets.place, { 6: 600, 8: 600 });
    // It can come down before any roll.
    await act(game, 'p1', 'removeBet', { kind: 'place', number: 8 });
    assert.deepEqual(seatOf(game, 'p1').bets.place, { 6: 600 });
    assert.equal(wallet('p1'), 100_000 - 500 - 600);

    // A come-out 7: Pass wins; Place 6 is off: not lost.
    let w = wallet('p1');
    await roll(game, 'p1', 3, 4);
    assert.equal(table(game).lastRoll.kind, 'natural');
    assert.equal(wallet('p1'), w + 1000, 'Pass $5 → $10 back, nothing for or against Place 6');
    assert.deepEqual(seatOf(game, 'p1').bets.place, { 6: 600 }, 'Place 6 untouched by the come-out 7');

    // A come-out 6: it becomes the point; Place 6 is off on that roll: not paid.
    await chips(game, 'p1', [{ kind: 'pass', cents: 500 }]);
    w = wallet('p1');
    await roll(game, 'p1', 2, 4);
    assert.equal(table(game).point, 6);
    assert.equal(wallet('p1'), w, 'no payout on the come-out 6');
    assert.deepEqual(seatOf(game, 'p1').bets.place, { 6: 600 }, 'Place 6 untouched by the come-out 6');

    // The next 6 (point phase): point made, and Place 6 pays 7:6 and stays up.
    w = wallet('p1');
    await roll(game, 'p1', 5, 1);
    assert.equal(table(game).lastRoll.kind, 'pointMade');
    assert.equal(wallet('p1'), w + 1000 + 700, 'Pass $5 → $10; Place $6 at 7:6 wins $7 and stays up');
    assert.deepEqual(seatOf(game, 'p1').bets.place, { 6: 600 });
    moneyAddsUp(100_000);
  });
}

test('Place bets: off on the come-out in settleRoll for every come-out total, both games; they still lose on a seven-out', () => {
  for (const variant of Object.values(DICE_VARIANTS)) {
    for (let a = 1; a <= 6; a += 1) {
      for (let b = 1; b <= 6; b += 1) {
        const r = D.settleRoll(variant, null, { ...D.emptyDiceBets(), place: { 6: 600, 8: 600 } }, a + b, [a, b]);
        assert.deepEqual([r.returnCents, r.lostCents, r.bets.place], [0, 0, { 6: 600, 8: 600 }], `${variant.id} come-out ${a}+${b}`);
      }
    }
    const out = D.settleRoll(variant, 8, { ...D.emptyDiceBets(), place: { 6: 600 } }, 7, [3, 4]);
    assert.deepEqual([out.lostCents, out.bets.place], [600, {}], `${variant.id}: a seven-out takes it`);
    assert.equal(D.placeBlocker(variant, null, D.emptyDiceBets(), 'place', 6), null, `${variant.id}: allowed on a come-out`);
  }
});

// ================= Come bets: kept exactly as they were =================
for (const game of ['craps', 'crapless']) {
  test(`${game}: a 7 loses every Come bet on a number (point on or off); a come-out 7 returns their Odds; a fresh Come wins on 7`, async () => {
    seed();
    await act(game, 'p1', 'sit', { seat: 0 });
    await act(game, 'p2', 'sit', { seat: 1 });
    await chips(game, 'p1', [{ kind: 'pass', cents: 500 }]);
    await roll(game, 'p1', 4, 4); // point 8
    // p2: Come → 5, Come → 10, both with Odds; then a fresh Come in the Come box.
    await chips(game, 'p2', [{ kind: 'come', cents: 500 }]);
    await roll(game, 'p1', 2, 3);
    await chips(game, 'p2', [{ kind: 'come', cents: 500 }, { kind: 'comeOdds', number: 5, cents: 1000 }]);
    await roll(game, 'p1', 4, 6);
    await chips(game, 'p2', [{ kind: 'comeOdds', number: 10, cents: 1000 }, { kind: 'come', cents: 300 }]);
    assert.deepEqual(seatOf(game, 'p2').bets.comeOn, { 5: { bet: 500, odds: 1000 }, 10: { bet: 500, odds: 1000 } });
    // Point on, a 7 (seven-out): both Come bets and their Odds lose; the fresh $3 Come wins 1:1.
    let w = wallet('p2');
    await roll(game, 'p1', 3, 4);
    assert.equal(table(game).lastRoll.kind, 'sevenOut');
    assert.equal(wallet('p2'), w + 600, 'only the fresh Come pays ($3 → $6)');
    assert.deepEqual(seatOf(game, 'p2').bets.comeOn, {});

    // Point off: Come bets left on numbers from the last point lose to a come-out 7; their Odds are off and come back.
    const shooter = table(game).shooter;
    const shooterUid = table(game).seats[shooter].uid;
    await chips(game, shooterUid, [{ kind: 'pass', cents: 500 }]);
    await roll(game, shooterUid, 3, 3); // point 6
    await chips(game, 'p2', [{ kind: 'come', cents: 500 }]);
    await roll(game, shooterUid, 4, 5); // Come → 9
    await chips(game, 'p2', [{ kind: 'comeOdds', number: 9, cents: 1000 }]);
    await roll(game, shooterUid, 2, 4); // point made: the table is on a come-out, Come 9 still up
    assert.equal(table(game).point, null);
    await chips(game, shooterUid, [{ kind: 'pass', cents: 500 }]);
    w = wallet('p2');
    await roll(game, shooterUid, 5, 2); // come-out 7
    // (After the seven-out the dice went to p2, so p2's own $5 Pass also wins on the 7: $10 back.)
    assert.equal(shooterUid, 'p2', 'the dice moved clockwise to p2');
    assert.equal(wallet('p2'), w + 1000 + 1000, 'Come 9 ($5) lost, its $10 Odds returned; Pass $5 → $10');
    assert.deepEqual(seatOf(game, 'p2').bets.comeOn, {});
    moneyAddsUp(100_000);
  });
}

// ================= 2. Every chip tap counts (server side) =================
// The phone sends taps in batches; however they are batched, ten $5 chips end at $50. Each request here is one tap.
test('every chip counts on the server: ten $5 chips, one request each, end at $50 on every game', async () => {
  seed();
  // Blackjack and Baccarat send the seat's new total each time: $5, $10, … $50.
  await act('blackjack', 'p1', 'sit', { seat: 2 });
  for (let i = 1; i <= 10; i += 1) await act('blackjack', 'p1', 'bet', { seat: 2, amount: 5 * i, requestId: rid() });
  assert.equal(table('blackjack').seats[2].betCents, 5000);
  await act('baccarat', 'p1', 'sit', { seat: 0 });
  for (let i = 1; i <= 10; i += 1) await act('baccarat', 'p1', 'bet', { seat: 0, player: 5 * i, banker: 0, tie: 0, requestId: rid() });
  assert.equal(table('baccarat').seats[0].bets.player, 5000);
  // Craps and Crapless send each chip as a change.
  for (const game of ['craps', 'crapless']) {
    await act(game, 'p1', 'sit', { seat: 0 });
    for (let i = 0; i < 10; i += 1) await chips(game, 'p1', [{ kind: 'field', cents: 500 }]);
    assert.equal(seatOf(game, 'p1').bets.field, 5000, `${game}: $50 on the Field`);
  }
  assert.equal(wallet('p1'), 100_000 - 4 * 5000, 'the wallet paid exactly $200');
  moneyAddsUp(100_000);
  // A $50 spin (the Slots bet picker sends the bet with Spin).
  const spin = await spinSlots(callerOf('p2'), { amount: 50, requestId: 'c8-spin-0001' }, { randomInt: () => 0 });
  assert.equal(spin.betCents, 5000);
});

test('a retried tap (same requestId) is applied once; a different requestId with the same chip is a new chip', async () => {
  seed();
  await act('craps', 'p1', 'sit', { seat: 0 });
  await act('craps', 'p1', 'bets', { changes: [{ kind: 'field', cents: 500 }], requestId: 'c8-same-0001' });
  const again = await act('craps', 'p1', 'bets', { changes: [{ kind: 'field', cents: 500 }], requestId: 'c8-same-0001' });
  assert.equal(again.duplicate, true);
  await act('craps', 'p1', 'bets', { changes: [{ kind: 'field', cents: 500 }], requestId: 'c8-same-0002' });
  assert.equal(seatOf('craps', 'p1').bets.field, 1000, 'two taps, two chips; the retry added nothing');
  moneyAddsUp(100_000);
});

// ================= 3. The chips: $1,000, $10,000 and (0.28.2) $100,000; no $2 =================
test('$1,000, $10,000 and $100,000 chips: real chips on every game; $2 is not a chip any more; a spot breaks into them; the message names them', async () => {
  const K = await import(url('shared/casino/constants.js'));
  assert.deepEqual(K.CHIP_VALUES, [1, 5, 10, 25, 100, 1000, 10000, 100000]);
  assert.equal(K.CHIP_MESSAGE, 'A chip is $1, $5, $10, $25, $100, $1,000, $10,000 or $100,000.');
  assert.deepEqual([1, 1000, 10000, 100000].map(K.chipName), ['$1', '$1,000', '$10,000', '$100,000']);
  assert.equal(K.isChip(2), false, '$2 is gone');
  assert.equal(K.isChip(100000), true);
  seed(30_000_000); // $300,000
  await act('craps', 'p1', 'sit', { seat: 0 });
  await assert.rejects(act('craps', 'p1', 'bet', { kind: 'field', amount: 2, requestId: rid() }), (e) => e.code === 'BAD_CHIP' && e.message === K.CHIP_MESSAGE);
  await act('craps', 'p1', 'bet', { kind: 'field', amount: 100000, requestId: rid() });
  await act('craps', 'p1', 'bet', { kind: 'field', amount: 10000, requestId: rid() });
  await act('craps', 'p1', 'bet', { kind: 'field', amount: 1000, requestId: rid() });
  assert.equal(seatOf('craps', 'p1').bets.field, 11_100_000, '$111,000 on the Field from three chips');
  await act('blackjack', 'p2', 'sit', { seat: 0 });
  await act('blackjack', 'p2', 'bet', { seat: 0, amount: 111000, requestId: rid() });
  assert.equal(seatOf('blackjack', 'p2').betCents, 11_100_000);
  moneyAddsUp(30_000_000);
});

// ================= 5. One ceiling, $10,000,000 per bet, for the casino and the sportsbook (0.28.2) =================
test('0.28.2: the casino per-bet ceiling is the sportsbook\'s, $10,000,000 (one constant, no longer tied to the admin wallet maximum)', async () => {
  const K = await import(url('shared/casino/constants.js'));
  const R = await import(url('shared/betRules.js'));
  const S = await import(url('shared/constants.js'));
  assert.equal(S.BET_CEILING_CENTS, 1_000_000_000);
  assert.equal(S.SPORTSBOOK_BET_CEILING_CENTS, S.BET_CEILING_CENTS);
  assert.equal(S.MAX_WALLET_CHANGE_CENTS, 10_000_000_000, 'the admin maximum is its own number, $100,000,000');
  assert.equal(K.BET_CEILING_CENTS, S.BET_CEILING_CENTS);
  assert.equal(K.BET_CEILING_MESSAGE, 'That bet is over the limit of $10,000,000 per bet.');
  assert.equal(R.MAX_STAKE_CENTS, 1_000_000_000);
  assert.equal(R.stakeCeilingProblem(1_000_000_000), '');
  assert.equal(R.stakeCeilingProblem(1_000_000_001), 'That bet is over the sportsbook limit of $10,000,000 per bet.');
  seed(5_000_000_000);
  await act('blackjack', 'p1', 'sit', { seat: 0 });
  await assert.rejects(act('blackjack', 'p1', 'bet', { seat: 0, amount: 10_000_001, requestId: rid() }), (e) => e.code === 'BET_TOO_LARGE' && e.message === K.BET_CEILING_MESSAGE);
  await act('blackjack', 'p1', 'bet', { seat: 0, amount: 10_000_000, requestId: rid() });
  assert.equal(seatOf('blackjack', 'p1').betCents, 1_000_000_000);
});

test('0.28.2: exactly $10,000,000 is accepted and $10,000,001 refused on every table (Blackjack + 21+3, Baccarat + its side bets, Craps, Crapless)', async () => {
  const K = await import(url('shared/casino/constants.js'));
  const tooBig = (e) => e.code === 'BET_TOO_LARGE' && e.message === K.BET_CEILING_MESSAGE;
  seed(10_000_000_000); // $100,000,000 each
  // Blackjack: the main bet, then 21+3 (a side bet needs the main bet; the ceiling is per bet)
  await act('blackjack', 'p1', 'sit', { seat: 0 });
  await assert.rejects(act('blackjack', 'p1', 'bet', { seat: 0, amount: 10_000_001, requestId: rid() }), tooBig);
  await act('blackjack', 'p1', 'bet', { seat: 0, amount: 10_000_000, requestId: rid() });
  await assert.rejects(act('blackjack', 'p1', 'bet', { seat: 0, amount: 10_000_000, side: 10_000_001, requestId: rid() }), tooBig);
  await act('blackjack', 'p1', 'bet', { seat: 0, amount: 10_000_000, side: 10_000_000, requestId: rid() });
  assert.deepEqual([seatOf('blackjack', 'p1').betCents, seatOf('blackjack', 'p1').sideCents], [1_000_000_000, 1_000_000_000]);
  // Baccarat: every main spot and every side bet
  await act('baccarat', 'p2', 'sit', { seat: 0 });
  for (const spot of ['player', 'banker', 'tie']) {
    const base = { player: 0, banker: 0, tie: 0 };
    await assert.rejects(act('baccarat', 'p2', 'bet', { seat: 0, ...base, [spot]: 10_000_001, requestId: rid() }), tooBig, spot);
  }
  await act('baccarat', 'p2', 'bet', { seat: 0, player: 10_000_000, banker: 0, tie: 0, requestId: rid() });
  for (const side of ['dragonPlayer', 'dragonBanker', 'fortune7', 'heavenly9', 'golden8', 'blazing7']) {
    await assert.rejects(act('baccarat', 'p2', 'bet', { seat: 0, player: 10_000_000, banker: 0, tie: 0, [side]: 10_000_001, requestId: rid() }), tooBig, side);
  }
  await act('baccarat', 'p2', 'bet', { seat: 0, player: 10_000_000, banker: 0, tie: 0, blazing7: 10_000_000, requestId: rid() });
  assert.equal(seatOf('baccarat', 'p2').bets.player, 1_000_000_000);
  assert.equal(seatOf('baccarat', 'p2').bets.blazing7, 1_000_000_000);
  // Craps and Crapless: one spot at exactly the ceiling; one dollar more is refused
  for (const game of ['craps', 'crapless']) {
    await act(game, 'p3', 'sit', { seat: 0 });
    await assert.rejects(act(game, 'p3', 'bets', { changes: [{ kind: 'field', cents: 1_000_000_100 }], requestId: rid() }), tooBig, game);
    await act(game, 'p3', 'bets', { changes: [{ kind: 'field', cents: 1_000_000_000 }], requestId: rid() });
    assert.equal(seatOf(game, 'p3').bets.field, 1_000_000_000, game);
  }
});

// ================= 4. Max bet (the plan; the button is checked in tools/phone-check/interact.mjs) =================
test('Max bet: the whole wallet left (whole dollars) on the spot; capped at the $10,000,000 ceiling; nothing when the wallet is empty', async () => {
  const { maxBetPlan } = await import(url('shared/casino/maxBet.js'));
  assert.deepEqual(maxBetPlan(0, 12_345), { addCents: 12_300, totalCents: 12_300, capped: false }, '$123.45 → $123');
  assert.deepEqual(maxBetPlan(500, 9_500), { addCents: 9_500, totalCents: 10_000, capped: false }, '$5 already on it + $95');
  assert.deepEqual(maxBetPlan(0, 250_000_000), { addCents: 250_000_000, totalCents: 250_000_000, capped: false }, '$2.5M wallet → all of it (under the ceiling now)');
  assert.deepEqual(maxBetPlan(0, 2_500_000_000), { addCents: 1_000_000_000, totalCents: 1_000_000_000, capped: true }, '$25M wallet → $10M');
  assert.deepEqual(maxBetPlan(0, 1_000_000_000), { addCents: 1_000_000_000, totalCents: 1_000_000_000, capped: false }, 'a $10M wallet: exactly the ceiling');
  assert.deepEqual(maxBetPlan(400_000_000, 2_500_000_000), { addCents: 600_000_000, totalCents: 1_000_000_000, capped: true });
  assert.deepEqual(maxBetPlan(1_000_000_000, 5_000), { refuse: 'ceiling' });
  assert.deepEqual(maxBetPlan(0, 99), { refuse: 'wallet' });
  assert.deepEqual(maxBetPlan(0, -500), { refuse: 'wallet' }, 'pending chips past the balance');
  // Through the chip path at the table: the Max amount is an ordinary bet; the server takes exactly the wallet.
  seed(12_345);
  await act('blackjack', 'p1', 'sit', { seat: 0 });
  const plan = maxBetPlan(0, wallet('p1'));
  await act('blackjack', 'p1', 'bet', { seat: 0, amount: plan.totalCents / 100, requestId: rid() });
  assert.deepEqual([seatOf('blackjack', 'p1').betCents, wallet('p1')], [12_300, 45]);
  await act('baccarat', 'p2', 'sit', { seat: 0 });
  await act('baccarat', 'p2', 'bet', { seat: 0, player: 10, banker: 0, tie: 0, requestId: rid() });
  const bank = maxBetPlan(0, wallet('p2'));
  await act('baccarat', 'p2', 'bet', { seat: 0, player: 10, banker: bank.totalCents / 100, tie: 0, requestId: rid() });
  assert.deepEqual(seatOf('baccarat', 'p2').bets, { player: 1000, banker: 11_300, tie: 0 });
  moneyAddsUp(12_345);
});
