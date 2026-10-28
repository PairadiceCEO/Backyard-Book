// npm run test:casino  (or: node --experimental-test-module-mocks --test test/casino/casino7.test.mjs)
// 0.16.0: no maximum bets. Big bets are accepted whenever the wallet covers them and refused with INSUFFICIENT_BALANCE
// (nothing written, no wallet change) when it doesn't; double and split need the extra stake; craps Odds stay at 2×
// the line bet; one bet above $1,000,000 is refused by the sanity ceiling; $25 and $100 chips; a "$3 chip" is refused
// as a chip while a $3 total built from $1 + $2 is fine.
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
const K = await import(url('shared/casino/constants.js'));
const C = await import(url('shared/casino/cards.js'));
const { STOPS_PER_REEL, lineSymbols, lineWin } = await import(url('shared/casino/slotMachine.js'));

const T0 = 1_800_000_000_000;
const CEILING = 'That bet is larger than the table allows.';
function seed(balances) {
  fake.reset();
  for (const [uid, balanceCents] of Object.entries(balances)) {
    fake.write(`users/${uid}`, { username: uid, displayName: uid.toUpperCase(), balanceCents, stats: { won: 0, lost: 0 }, disabled: false });
  }
}
const callerOf = (uid) => ({ uid, token: {}, user: fake.get(`users/${uid}`) });
let dice = [];
let rng = (max) => (max === 6 && dice.length ? dice.shift() - 1 : Math.floor(Math.random() * max));
const act = (game, uid, action, fields = {}, now = T0) => handleTableAction(callerOf(uid), { game, action, ...fields }, { now, randomInt: (m) => rng(m) });
let n = 0;
const rid = () => `c7-req-${String(++n).padStart(6, '0')}`;
const wallet = (uid) => fake.get(`users/${uid}`).balanceCents;
const table = (game) => fake.get(`casinoTables/${game}`);
const ledgerCount = () => [...fake.store.keys()].filter((k) => k.startsWith('ledger/')).length;
const err = async (p, code, message) => {
  await assert.rejects(p, (e) => {
    assert.equal(e.code, code, e.message);
    if (message) assert.equal(e.message, message);
    return true;
  });
};
// A refused request changes nothing: same wallet, same ledger, same table doc.
async function refusedWithoutChange(game, uid, promise, code, message) {
  const before = { wallet: wallet(uid), ledger: ledgerCount(), table: game ? JSON.stringify(table(game)) : null };
  await err(promise, code, message);
  assert.equal(wallet(uid), before.wallet, 'no wallet change');
  assert.equal(ledgerCount(), before.ledger, 'no ledger entry');
  if (game) assert.equal(JSON.stringify(table(game)), before.table, 'table unchanged');
}

// Blackjack shoe: these cards on top, in order (deck digits added).
function stackBlackjack(cards) {
  const used = {};
  const ids = cards.map((c) => {
    used[c] = (used[c] ?? -1) + 1;
    return `${c}${used[c]}`;
  });
  fake.write('casinoTables/blackjack/private/shoe', { cards: [...ids, ...C.buildShoe(6).filter((c) => !ids.includes(c))], dealt: 0, shuffles: 0, holeCard: null });
  rng = () => 0;
}

// ---------- shared rules: chip check vs amount check, the ceiling ----------

test('rules: chips are $1, $2, $5, $10, $25, $100, $1,000, $10,000 (0.23.0); an amount is whole dollars ≥ $1 with no maximum except the $1,000,000 ceiling', () => {
  assert.deepEqual(K.CHIP_VALUES, [1, 2, 5, 10, 25, 100, 1000, 10000]);
  for (const d of [25, 100, 1000, 10000]) assert.equal(K.isChip(d), true, `$${d} chip`);
  for (const d of [3, 0, 50, 2.5, '5', 500, 100000]) assert.equal(K.isChip(d), false, `${d} is not a chip`);
  for (const d of [3, 11, 500, 1_000_000]) assert.equal(K.betAmountProblem(d), '', `$${d} is a valid amount`);
  assert.equal(K.isValidBetAmount(Number.MAX_SAFE_INTEGER + 1), false, 'safe integers only');
  for (const d of [0, -1, 2.5, '5', null, NaN]) assert.equal(K.betAmountProblem(d), K.BET_AMOUNT_MESSAGE, `${d}`);
  for (const d of [1_000_001, Number.MAX_SAFE_INTEGER, 1e300]) assert.equal(K.betAmountProblem(d), CEILING, `${d}`);
  assert.equal(K.betCeilingProblem(100_000_000), '', 'exactly $1,000,000');
  assert.equal(K.betCeilingProblem(100_000_100), CEILING);
  assert.equal(K.BET_CEILING_CENTS, 100_000_000);
  assert.equal('CASINO_MAX_BET_DOLLARS' in K, false, 'the $10 maximum is gone');
  assert.equal('isValidCasinoBet' in K, false, 'split into isChip + isValidBetAmount');
});

// ---------- Blackjack ----------

test('Blackjack: a $500 bet is accepted when the wallet covers it; refused with INSUFFICIENT_BALANCE and no change when it does not', async () => {
  seed({ rich: 60_000, poor: 49_999 });
  await act('blackjack', 'rich', 'sit', { seat: 0 });
  await act('blackjack', 'poor', 'sit', { seat: 1 });
  await act('blackjack', 'rich', 'bet', { amount: 500, requestId: rid() });
  assert.equal(table('blackjack').seats[0].betCents, 50_000);
  assert.equal(wallet('rich'), 10_000);
  await refusedWithoutChange('blackjack', 'poor', act('blackjack', 'poor', 'bet', { amount: 500, requestId: rid() }), 'INSUFFICIENT_BALANCE');
  // Raising an existing bet charges only the difference, still checked against the wallet.
  await act('blackjack', 'poor', 'bet', { amount: 400, requestId: rid() });
  await refusedWithoutChange('blackjack', 'poor', act('blackjack', 'poor', 'bet', { amount: 500, requestId: rid() }), 'INSUFFICIENT_BALANCE');
  await act('blackjack', 'poor', 'bet', { amount: 499, requestId: rid() });
  assert.equal(wallet('poor'), 99);
  // $3 is a fine total (built from $1 + $2 chips); the ceiling still applies.
  await act('blackjack', 'poor', 'bet', { amount: 3, requestId: rid() });
  assert.equal(table('blackjack').seats[1].betCents, 300);
  await refusedWithoutChange('blackjack', 'rich', act('blackjack', 'rich', 'bet', { amount: 1_000_001, requestId: rid() }), 'BET_TOO_LARGE', CEILING);
});

test('Blackjack: double and split are refused when the wallet cannot cover the extra stake, and work when it can', async () => {
  // rich: 8 8 then 5 6 · dealer 9 up. Each player bets $500 and keeps less than another $500.
  seed({ p1: 99_999, p2: 200_000 });
  await act('blackjack', 'p1', 'sit', { seat: 0 });
  await act('blackjack', 'p2', 'sit', { seat: 1 });
  stackBlackjack(['8S', '5C', '9D', '8H', '6C', '7D', 'TH', 'TS', '9C', '2H']); // p1 8 8 · p2 5 6 · dealer 9 up, 7 hole
  await act('blackjack', 'p1', 'bet', { amount: 500, requestId: rid() });
  await act('blackjack', 'p2', 'bet', { amount: 500, requestId: rid() });
  await act('blackjack', 'p1', 'confirm');
  await act('blackjack', 'p2', 'confirm');
  const t = table('blackjack');
  assert.equal(t.phase, 'playing');
  assert.deepEqual(t.turn, { seat: 0, hand: 0 });
  const hand = (uid, seat, h = 0) => table('blackjack').seats[seat].hands[h];
  const move = (uid, seat, action, h = 0) => act('blackjack', uid, action, { hand: h, actionSeq: hand(uid, seat, h).seq });
  assert.equal(wallet('p1'), 49_999, '$499.99 left: not enough to split or double a $500 hand');
  await refusedWithoutChange('blackjack', 'p1', move('p1', 0, 'split'), 'INSUFFICIENT_BALANCE');
  await refusedWithoutChange('blackjack', 'p1', move('p1', 0, 'double'), 'INSUFFICIENT_BALANCE');
  await move('p1', 0, 'stand');
  // p2 has $1,500 left: the $500 double goes through (5 6 + T = 21). The dealer's 9 7 draws T and busts.
  await move('p2', 1, 'double');
  const doubleDebit = [...fake.store].find(([k, v]) => k.startsWith('ledger/') && v.uid === 'p2' && /_dbl0_/.test(k))?.[1];
  assert.equal(doubleDebit?.amountCents, -50_000, 'the double charged another $500');
  assert.equal(hand('p2', 1).betCents, 100_000);
  assert.equal(hand('p2', 1).doubled, true);
  assert.equal(table('blackjack').phase, 'results');
  assert.equal(wallet('p2'), 200_000 - 100_000 + 200_000, '$1,000 doubled hand wins 1:1');
  assert.equal(wallet('p1'), 49_999 + 100_000, 'p1 stood on 16 and won $500 when the dealer bust');
});

// ---------- Baccarat ----------

test('Baccarat: $500 on Banker is accepted when the wallet covers it; refused with INSUFFICIENT_BALANCE and no change when it does not', async () => {
  seed({ rich: 50_000, poor: 49_999 });
  await act('baccarat', 'rich', 'sit', { seat: 0 });
  await act('baccarat', 'poor', 'sit', { seat: 1 });
  await act('baccarat', 'rich', 'bet', { seat: 0, player: 0, banker: 500, tie: 0, requestId: rid() });
  assert.deepEqual(table('baccarat').seats[0].bets, { player: 0, banker: 50_000, tie: 0 });
  assert.equal(wallet('rich'), 0, 'the whole wallet on Banker');
  await refusedWithoutChange('baccarat', 'poor', act('baccarat', 'poor', 'bet', { seat: 1, player: 0, banker: 500, tie: 0, requestId: rid() }), 'INSUFFICIENT_BALANCE');
  await refusedWithoutChange('baccarat', 'poor', act('baccarat', 'poor', 'bet', { seat: 1, player: 0, banker: 1_000_001, tie: 0, requestId: rid() }), 'BET_TOO_LARGE', CEILING);
  await act('baccarat', 'poor', 'bet', { seat: 1, player: 3, banker: 25, tie: 100, requestId: rid() });
  assert.deepEqual(table('baccarat').seats[1].bets, { player: 300, banker: 2500, tie: 10_000 });
});

// ---------- Craps / Crapless ----------

for (const game of ['craps', 'crapless']) {
  test(`${game}: $500 Pass plus $1,000 Odds accepted when the wallet covers them; refused with no change when not; Odds above 2× still refused`, async () => {
    seed({ rich: 150_000, poor: 149_999 });
    rng = (max) => (max === 6 && dice.length ? dice.shift() - 1 : Math.floor(Math.random() * max));
    await act(game, 'rich', 'sit', { seat: 0 });
    await act(game, 'poor', 'sit', { seat: 1 });
    await act(game, 'rich', 'bets', { changes: [{ kind: 'pass', cents: 50_000 }], requestId: rid() });
    await act(game, 'poor', 'bets', { changes: [{ kind: 'pass', cents: 50_000 }], requestId: rid() });
    dice = [3, 3]; // point 6
    await act(game, 'rich', 'roll', { rollSeq: table(game).rollSeq });
    assert.equal(table(game).point, 6);
    // Odds above 2× the line bet: refused (a game rule), with no change.
    await refusedWithoutChange(game, 'rich', act(game, 'rich', 'bets', { changes: [{ kind: 'odds', cents: 100_100 }], requestId: rid() }), 'SPOT_LIMIT');
    await act(game, 'rich', 'bets', { changes: [{ kind: 'odds', cents: 100_000 }], requestId: rid() });
    assert.deepEqual([table(game).seats[0].bets.pass, table(game).seats[0].bets.odds, wallet('rich')], [50_000, 100_000, 0]);
    // The same $1,000 Odds with $999.99 in the wallet.
    await refusedWithoutChange(game, 'poor', act(game, 'poor', 'bets', { changes: [{ kind: 'odds', cents: 100_000 }], requestId: rid() }), 'INSUFFICIENT_BALANCE');
    // The point is made: Pass 1:1 + Odds on 6 at 6:5.
    dice = [4, 2];
    await act(game, 'rich', 'roll', { rollSeq: table(game).rollSeq });
    assert.equal(wallet('rich'), 50_000 * 2 + 100_000 + 120_000);
  });
}

test('craps: $25 and $100 chips accepted; a "$3 chip" is refused as a chip, but $3 built from $1 + $2 is fine; the ceiling', async () => {
  seed({ p1: 1_000_000 });
  await act('craps', 'p1', 'sit', { seat: 0 });
  await act('craps', 'p1', 'bet', { kind: 'field', amount: 25, requestId: rid() });
  await act('craps', 'p1', 'bet', { kind: 'field', amount: 100, requestId: rid() });
  assert.equal(table('craps').seats[0].bets.field, 12_500);
  await refusedWithoutChange('craps', 'p1', act('craps', 'p1', 'bet', { kind: 'pass', amount: 3, requestId: rid() }), 'BAD_CHIP', 'A chip is $1, $2, $5, $10, $25, $100, $1,000 or $10,000.');
  await act('craps', 'p1', 'bet', { kind: 'pass', amount: 1, requestId: rid() });
  await act('craps', 'p1', 'bet', { kind: 'pass', amount: 2, requestId: rid() });
  assert.equal(table('craps').seats[0].bets.pass, 300, '$1 + $2 chips = $3 Pass');
  await act('craps', 'p1', 'bets', { changes: [{ kind: 'dontPass', cents: 300 }], requestId: rid() });
  assert.equal(table('craps').seats[0].bets.dontPass, 300, 'a $3 batch (the phone merges $1 + $2 taps)');
  // The ceiling: one change above it, or a spot pushed above it.
  fake.write('users/p1', { ...fake.get('users/p1'), balanceCents: 300_000_000 });
  await refusedWithoutChange('craps', 'p1', act('craps', 'p1', 'bets', { changes: [{ kind: 'field', cents: 100_000_100 }], requestId: rid() }), 'BET_TOO_LARGE', CEILING);
  await refusedWithoutChange('craps', 'p1', act('craps', 'p1', 'bets', { changes: [{ kind: 'field', cents: 99_990_000 }], requestId: rid() }), 'BET_TOO_LARGE', CEILING);
  await act('craps', 'p1', 'bets', { changes: [{ kind: 'field', cents: 99_987_500 }], requestId: rid() }); // exactly $1,000,000 on Field
  assert.equal(table('craps').seats[0].bets.field, 100_000_000);
});

test('$25 and $100 chips at Blackjack and Baccarat build any total (no per-seat or per-spot maximum)', async () => {
  seed({ p1: 1_000_000 });
  await act('blackjack', 'p1', 'sit', { seat: 2 });
  await act('blackjack', 'p1', 'bet', { amount: 225, requestId: rid() }); // $100 + $100 + $25
  assert.equal(table('blackjack').seats[2].betCents, 22_500);
  await act('baccarat', 'p1', 'sit', { seat: 4 });
  await act('baccarat', 'p1', 'bet', { seat: 4, player: 125, banker: 0, tie: 25, requestId: rid() });
  assert.deepEqual(table('baccarat').seats[4].bets, { player: 12_500, banker: 0, tie: 2500 });
  assert.equal(wallet('p1'), 1_000_000 - 22_500 - 15_000);
});

// ---------- Slots ----------

test('Slots: a $250 spin is accepted when the wallet covers it; refused with INSUFFICIENT_BALANCE and no change when not; the ceiling', async () => {
  // Three blanks never pay: a losing spin keeps the arithmetic simple.
  const blankStops = [];
  for (let reel = 0; reel < 3 && blankStops.length < 3; reel += 1) {
    for (let stop = 0; stop < STOPS_PER_REEL; stop += 1) {
      const probe = [0, 0, 0];
      probe[reel] = stop;
      if (lineSymbols(probe)[reel] === 'BL') {
        blankStops.push(stop);
        break;
      }
    }
  }
  assert.equal(blankStops.length, 3);
  assert.equal(lineWin(lineSymbols(blankStops)), null, 'three blanks lose');
  const stops = [...blankStops];
  const fixed = () => stops.shift();
  seed({ u1: 25_000, u2: 24_999 });
  const res = await spinSlots(callerOf('u1'), { amount: 250, requestId: 'spin-big-0001' }, { randomInt: fixed });
  assert.deepEqual([res.ok, res.betCents, res.winCents, res.balanceCents], [true, 25_000, 0, 0]);
  assert.equal(wallet('u1'), 0);
  await refusedWithoutChange(null, 'u2', spinSlots(callerOf('u2'), { amount: 250, requestId: 'spin-big-0002' }), 'INSUFFICIENT_BALANCE');
  await refusedWithoutChange(null, 'u2', spinSlots(callerOf('u2'), { amount: 1_000_001, requestId: 'spin-big-0003' }), 'BET_TOO_LARGE', CEILING);
  // A Slots bet is a total built from chips: $3 is fine.
  const three = await spinSlots(callerOf('u2'), { amount: 3, requestId: 'spin-big-0004' }, { randomInt: () => blankStops[0] });
  assert.equal(three.betCents, 300);
});
