// npm run test:casino  (or: node --experimental-test-module-mocks test/casino/casino5.test.mjs)
// Casino batch A: several seats per player at Blackjack and Baccarat (one at Craps), leaving one seat
// or all of them, and the Craps / Crapless additions: limits, Hard ways, Come bets, Come Odds,
// Don't Pass Odds.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFakeDb } from './fakeFirestore.mjs';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;
const fake = makeFakeDb();
mock.module(url('server/firebaseAdmin.js'), {
  namedExports: {
    adminDb: () => fake.db,
    adminAuth: () => ({ async verifyIdToken() { throw new Error('not used'); } }),
    normalizePrivateKey: (k) => k,
  },
});

const C = await import(url('shared/casino/cards.js'));
const { DICE_VARIANTS } = await import(url('shared/casino/diceVariants.js'));
const D = await import(url('shared/casino/dice.js'));
const { handleTableAction } = await import(url('server/casino/tables.js'));

const UIDS = ['p1', 'p2', 'p3'];
const T0 = 1_800_000_000_000;
function seed(balanceCents = 10000) {
  fake.reset();
  for (const uid of UIDS) fake.write(`users/${uid}`, { username: uid, displayName: `P${uid.slice(1)}`, balanceCents, stats: { won: 3, lost: 2 }, disabled: false });
}
const callerOf = (uid) => ({ uid, token: {}, user: fake.get(`users/${uid}`) });
let rng = (max) => Math.floor(Math.random() * max);
let dice = [];
const act = (game, uid, action, fields = {}, now = T0) =>
  handleTableAction(callerOf(uid), { game, action, ...fields }, { now, randomInt: (m) => (m === 6 && dice.length ? dice.shift() - 1 : rng(m)) });
let reqNo = 0;
const rid = () => `b5-req-${String(++reqNo).padStart(6, '0')}`;
const table = (game) => fake.get(`casinoTables/${game}`);
const wallet = (uid) => fake.get(`users/${uid}`).balanceCents;
const ledger = () => [...fake.store].filter(([k]) => k.startsWith('ledger/')).map(([k, v]) => ({ id: k.slice(7), ...v }));
const err = async (p, code, re) => {
  await assert.rejects(p, (e) => {
    assert.equal(e.code, code, e.message);
    if (re instanceof RegExp) assert.match(e.message, re);
    return true;
  });
};
function moneyAddsUp(start) {
  for (const uid of UIDS) {
    const total = ledger().filter((e) => e.uid === uid).reduce((s, e) => s + e.amountCents, 0);
    assert.equal(start + total, wallet(uid), `${uid}: wallet = start + ledger`);
  }
  assert.equal(new Set(ledger().map((e) => e.id)).size, ledger().length, 'every ledger id is unique');
}
// Cards on top of the shoe, drawn in this order ("TS", …; deck digits added).
function stackShoe(game, cards, decks) {
  const used = {};
  const ids = cards.map((c) => { used[c] = (used[c] ?? -1) + 1; return `${c}${used[c]}`; });
  const rest = C.buildShoe(decks).filter((c) => !ids.includes(c));
  fake.write(`casinoTables/${game}/private/shoe`, { cards: [...ids, ...rest], dealt: 0, shuffles: 0, holeCard: null });
  rng = () => 0;
  return ids;
}

// ================= Blackjack: several seats per player =================
const BJ = 'blackjack';
const bj = (uid, action, fields, now) => act(BJ, uid, action, fields, now);
const bjHand = (seat, h = 0) => table(BJ).seats[seat].hands[h];
const move = (uid, action, seat, h = 0, now = T0) => {
  const fields = { hand: h, actionSeq: bjHand(seat ?? table(BJ).turn.seat, h).seq };
  if (seat !== null) fields.seat = seat;
  return bj(uid, action, fields, now);
};

test('Blackjack: one player in seats 2 and 4 plays each like a separate player, in seat order', async () => {
  seed();
  await bj('p1', 'sit', { seat: 1 });
  await bj('p2', 'sit', { seat: 2 });
  const second = await bj('p1', 'sit', { seat: 3 });
  assert.deepEqual(second.mySeats, [1, 3]);
  assert.deepEqual(table(BJ).seats.map((s) => s?.uid ?? null), [null, 'p1', 'p2', 'p1', null]);
  // Seat 2: 8 8 (split → 8 3, 8 2) · seat 3: T 7 · seat 4: 5 6 (doubles a 9) · dealer 9 up, 7 hole, draws K.
  stackShoe(BJ, ['8S', 'TS', '5C', '9D', '8H', '7S', '6C', '7D', '3H', '2H', '9C', 'KD'], 6);

  // Each seat has its own bet and its own $10 limit; an action must say which seat.
  await err(bj('p1', 'bet', { amount: 5, requestId: rid() }), 'PICK_SEAT', /2, 4/);
  await err(bj('p1', 'bet', { seat: 2, amount: 5, requestId: rid() }), 'NOT_YOUR_SEAT');
  await err(bj('p1', 'bet', { seat: 1, amount: 11, requestId: rid() }), 'BAD_BET');
  await bj('p1', 'bet', { seat: 1, amount: 10, requestId: rid() });
  await bj('p1', 'bet', { seat: 3, amount: 10, requestId: rid() });
  assert.equal(wallet('p1'), 10000 - 2000, '$10 on each seat: each seat is limited on its own');
  await bj('p1', 'bet', { seat: 1, amount: 5, requestId: rid() });
  await bj('p1', 'bet', { seat: 3, amount: 5, requestId: rid() });
  await bj('p2', 'bet', { amount: 5, requestId: rid() });
  await bj('p1', 'confirm', { seat: 1 });
  await bj('p2', 'confirm', {});
  assert.equal(table(BJ).phase, 'betting', 'seat 4 has not confirmed yet');
  await bj('p1', 'confirm', { seat: 3 });

  let t = table(BJ);
  assert.equal(t.phase, 'playing');
  assert.deepEqual(t.lastDeal.cards.map((c) => [c.to, c.i]), [
    ['1-0', 0], ['2-0', 0], ['3-0', 0], ['d', 0], ['1-0', 1], ['2-0', 1], ['3-0', 1], ['d', 1],
  ], 'one card at a time, seat 2 → 3 → 4 → dealer, twice');
  assert.deepEqual(t.turn, { seat: 1, hand: 0 }, 'seat 2 plays first');

  await err(move('p1', 'hit', 3), 'NOT_YOUR_TURN', /seat 4/);
  await move('p1', 'split', 1);
  assert.deepEqual([bjHand(1, 0).cards.length, bjHand(1, 1).cards.length], [2, 2]);
  await move('p1', 'stand', null, 0); // no seat given: the seat whose turn it is (mine)
  await move('p1', 'stand', 1, 1);
  t = table(BJ);
  assert.deepEqual(t.turn, { seat: 2, hand: 0 }, 'then seat 3 (the other player)');
  await err(move('p1', 'hit', 3), 'NOT_YOUR_TURN', 'seat 4 waits for seat 3');
  await err(bj('p1', 'hit', { hand: 0, actionSeq: bjHand(2).seq }), 'PICK_SEAT', 'not my turn and two seats: no guessing');
  await move('p2', 'stand', null);
  assert.deepEqual(table(BJ).turn, { seat: 3, hand: 0 }, 'then seat 4');
  await move('p1', 'double', null); // 5 6 + 9 = 20

  t = table(BJ);
  assert.equal(t.phase, 'results');
  assert.equal(B_handTotal(t.dealer.cards), 26, 'dealer drew to 26 and busted');
  assert.deepEqual(t.seats[1].result, { stakeCents: 1000, returnCents: 2000, netCents: 1000 }, 'seat 2: two split hands');
  assert.deepEqual(t.seats[3].result, { stakeCents: 1000, returnCents: 2000, netCents: 1000 }, 'seat 4: the double');
  assert.deepEqual(t.seats[2].result, { stakeCents: 500, returnCents: 1000, netCents: 500 });
  assert.equal(wallet('p1'), 10000 - 2000 + 2000 + 2000);
  assert.equal(wallet('p2'), 10500);
  const ids = ledger().map((e) => e.id);
  for (const id of [`cpay_blackjack_${t.roundId}_p1_s1_end`, `cpay_blackjack_${t.roundId}_p1_s3_end`, `cpay_blackjack_${t.roundId}_p2_s2_end`, `cbet_p1_s1_split_${t.roundId}`, `cbet_p1_s3_dbl0_${t.roundId}`]) {
    assert.ok(ids.includes(id), `ledger has ${id}`);
  }
  assert.ok(ledger().filter((e) => e.uid === 'p1').every((e) => /seat [24]/.test(e.note)), 'notes name the seat');
  moneyAddsUp(10000);
});

function B_handTotal(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    const r = c[0];
    total += r === 'A' ? 11 : 'TJQK'.includes(r) ? 10 : Number(r);
    if (r === 'A') aces += 1;
  }
  while (total > 21 && aces) { total -= 10; aces -= 1; }
  return total;
}

test('Blackjack: insurance is decided seat by seat', async () => {
  seed();
  await bj('p1', 'sit', { seat: 0 });
  await bj('p1', 'sit', { seat: 1 });
  stackShoe(BJ, ['TS', '5H', 'AD', '9S', '6H', 'KC'], 6); // dealer A up, K hole: blackjack
  await bj('p1', 'bet', { seat: 0, amount: 5, requestId: rid() });
  await bj('p1', 'bet', { seat: 1, amount: 5, requestId: rid() });
  await bj('p1', 'confirm', { seat: 0 });
  await bj('p1', 'confirm', { seat: 1 });
  assert.equal(table(BJ).phase, 'insurance');
  await err(bj('p1', 'insurance', { amountCents: 0 }), 'PICK_SEAT');
  await bj('p1', 'insurance', { seat: 0, amountCents: 250 });
  assert.equal(table(BJ).phase, 'insurance', 'seat 2 still has to decide');
  await bj('p1', 'insurance', { seat: 1, amountCents: 0 });
  const t = table(BJ);
  assert.equal(t.phase, 'results', 'dealer blackjack once both seats decided');
  assert.deepEqual([t.seats[0].insurance, t.seats[1].insurance], [250, 0]);
  assert.equal(wallet('p1'), 10000 - 1000 - 250 + 750, 'seat 1 insured (pays 2:1), seat 2 did not');
  moneyAddsUp(10000);
});

test('leaving: one seat (keep the rest), all seats (the page closed), bets in play play out', async () => {
  seed();
  await bj('p1', 'sit', { seat: 0 });
  await bj('p1', 'sit', { seat: 2 });
  await bj('p2', 'sit', { seat: 1 });
  await bj('p1', 'bet', { seat: 0, amount: 4, requestId: rid() });
  let r = await bj('p1', 'leave', { seat: 2 });
  assert.deepEqual([r.freedSeats, r.leavingSeats], [[2], []]);
  assert.deepEqual(table(BJ).seats.map((s) => s?.uid ?? null), ['p1', 'p2', null, null, null], 'seat 1 kept');
  await bj('p1', 'sit', { seat: 4 });
  r = await bj('p1', 'leave', {}); // leaving the table page
  assert.deepEqual([r.freedSeats, r.leavingSeats], [[4], [0]], 'the seat with a bet plays out; the empty one frees now');
  assert.equal(table(BJ).seats[0].leaving, true);
  await err(bj('p1', 'bet', { seat: 0, amount: 5, requestId: rid() }), 'LEAVING');
  // The round plays out; the leaving seat frees when the next one opens.
  stackShoe(BJ, ['TS', '9H', '8D', '7C', '9S', '6D'], 6);
  await bj('p2', 'bet', { amount: 5, requestId: rid() });
  await bj('p2', 'confirm', {});
  let t = table(BJ);
  assert.equal(t.phase, 'playing', 'dealt: p1 (leaving) counts as done');
  while (table(BJ).phase === 'playing') await bj('p2', 'tick', {}, table(BJ).deadline); // hands stand on their timer
  t = table(BJ);
  assert.equal(t.phase, 'results');
  await bj('p2', 'tick', {}, t.deadline);
  assert.deepEqual(table(BJ).seats.map((s) => s?.uid ?? null), [null, 'p2', null, null, null]);
  moneyAddsUp(10000);
});

test('one heartbeat covers every seat; a player gone 60 s loses all their seats at once', async () => {
  seed();
  await bj('p1', 'sit', { seat: 0 });
  await bj('p1', 'sit', { seat: 3 });
  await bj('p2', 'sit', { seat: 1 });
  fake.resetCounts();
  const hb = await bj('p1', 'heartbeat', {}, T0 + 31_000);
  assert.deepEqual([hb.seated, hb.wrote], [true, true]);
  assert.equal(fake.counts.byPrefix['writes:casinoTables/blackjack/presence'], 1, 'one presence write for both seats');
  // p1 goes quiet; p2's heartbeat on the idle table frees both of p1's seats.
  await bj('p2', 'heartbeat', {}, T0 + 31_000 + 61_000);
  assert.deepEqual(table(BJ).seats.map((s) => s?.uid ?? null), [null, 'p2', null, null, null]);
});

// ================= Baccarat =================
const BAC = 'baccarat';
const bac = (uid, action, fields, now) => act(BAC, uid, action, fields, now);
const bacBet = (uid, seat, bets) => bac(uid, 'bet', { seat, player: 0, banker: 0, tie: 0, ...bets, requestId: rid() });

test('Baccarat: each of my seats has its own Player / Banker / Tie bets and limits, and its own payout', async () => {
  seed();
  await bac('p1', 'sit', { seat: 0 });
  await bac('p1', 'sit', { seat: 3 });
  await err(bacBet('p1', 0, { player: 11 }), 'BAD_BET');
  await bacBet('p1', 0, { player: 10, banker: 10, tie: 10 });
  await bacBet('p1', 3, { banker: 5 });
  await err(bac('p1', 'confirm', {}), 'PICK_SEAT');
  await bac('p1', 'confirm', { seat: 0 });
  assert.equal(table(BAC).phase, 'betting', 'seat 4 still to confirm');
  stackShoe(BAC, ['4S', '2H', '3D', '3C', '3S'], 8); // P 7, B 5 draws 3 → Banker 8
  await bac('p1', 'confirm', { seat: 3 });
  const t = table(BAC);
  assert.equal(t.coup.winner, 'banker');
  assert.deepEqual(t.seats[0].result, { stakeCents: 3000, returnCents: 1950, netCents: -1050 });
  assert.deepEqual(t.seats[3].result, { stakeCents: 500, returnCents: 975, netCents: 475 });
  assert.equal(wallet('p1'), 10000 - 3500 + 1950 + 975);
  const pays = ledger().filter((e) => e.type === 'casino_payout').map((e) => e.id).sort();
  assert.deepEqual(pays, [`cpay_baccarat_${t.roundId}_p1_s0_end`, `cpay_baccarat_${t.roundId}_p1_s3_end`]);
  moneyAddsUp(10000);
});

test('Craps and Crapless: one seat per player, refused with a clear message', async () => {
  for (const game of ['craps', 'crapless']) {
    seed();
    await act(game, 'p1', 'sit', { seat: 0 });
    await err(act(game, 'p1', 'sit', { seat: 2 }), 'ONE_SEAT', /one seat per player/);
    assert.equal((await act(game, 'p1', 'sit', {})).already, true);
    assert.deepEqual(table(game).seats.map((s) => s?.uid ?? null), ['p1', null, null, null, null]);
  }
});

// ================= Craps rules (pure) =================
const CR = DICE_VARIANTS.craps;
const CL = DICE_VARIANTS.crapless;
const bets = (b) => ({ ...D.emptyDiceBets(), ...b });
const roll = (variant, point, b, d1, d2) => D.settleRoll(variant, point, bets(b), d1 + d2, [d1, d2]);
const HARD = { 4: 500, 6: 500, 8: 500, 10: 500 };

test('Hard ways: win the hard way (stays up), lose the easy way or on a 7, off on a come-out', () => {
  for (const variant of [CR, CL]) {
    const point = 5;
    const cases = [
      [[2, 2], 4, 3000], [[5, 5], 10, 3000], [[3, 3], 6, 4000], [[4, 4], 8, 4000],
    ];
    for (const [[a, b], n, pay] of cases) {
      const r = roll(variant, point, { hard: { ...HARD } }, a, b);
      assert.equal(r.returnCents, pay, `${variant.id} hard ${n}: ${pay / 500}:1`);
      assert.deepEqual(r.bets.hard, HARD, `${variant.id} hard ${n} stays up after it wins`);
      assert.deepEqual(r.lines.map((l) => [l.bet, l.number, l.result]), [['hard', n, 'win']]);
    }
    for (const [[a, b], n] of [[[1, 3], 4], [[4, 6], 10], [[2, 4], 6], [[1, 5], 6], [[2, 6], 8], [[3, 5], 8]]) {
      const r = roll(variant, point, { hard: { ...HARD } }, a, b);
      assert.equal(r.lostCents, 500, `${variant.id} easy ${n} (${a}+${b}) loses Hard ${n}`);
      assert.equal(r.bets.hard[n], undefined);
      assert.equal(Object.keys(r.bets.hard).length, 3);
    }
    const seven = roll(variant, point, { hard: { ...HARD } }, 3, 4);
    assert.equal(seven.lostCents, 2000, `${variant.id}: a 7 takes every Hard way`);
    assert.deepEqual(seven.bets.hard, {});
    for (const [a, b] of [[2, 3], [4, 5], [5, 6]]) {
      const r = roll(variant, 6, { hard: { ...HARD } }, a, b);
      assert.deepEqual([r.returnCents, r.lostCents, r.bets.hard], [0, 0, HARD], `${variant.id} ${a + b} leaves Hard ways alone`);
    }
    // Off on the come-out: hard numbers, easy numbers and a 7 do nothing to them.
    for (const [a, b] of [[2, 2], [1, 3], [3, 4], [3, 3], [5, 5], [6, 4]]) {
      const r = roll(variant, null, { hard: { ...HARD } }, a, b);
      assert.deepEqual([r.returnCents, r.lostCents, r.bets.hard], [0, 0, HARD], `${variant.id} come-out ${a}+${b}: Hard ways off`);
    }
    // The point being made the hard way pays the Hard way too.
    const made = roll(variant, 6, { pass: 500, hard: { 6: 500 } }, 3, 3);
    assert.equal(made.kind, 'pointMade');
    assert.equal(made.returnCents, 1000 + 4000);
  }
});

test('Craps Come: 7/11 win, 2/3/12 lose, other numbers move; then the number wins 1:1 before a 7', () => {
  for (const [a, b] of [[3, 4], [5, 6]]) {
    const r = roll(CR, 6, { come: 500 }, a, b);
    assert.deepEqual([r.returnCents, r.bets.come, r.bets.comeOn], [1000, 0, {}], `Come wins on ${a + b}`);
  }
  for (const [a, b] of [[1, 1], [1, 2], [6, 6]]) {
    const r = roll(CR, 6, { come: 500 }, a, b);
    assert.deepEqual([r.returnCents, r.lostCents, r.bets.comeOn], [0, 500, {}], `Come loses on ${a + b}`);
  }
  for (const n of [4, 5, 6, 8, 9, 10]) {
    const a = Math.min(6, n - 1);
    const r = roll(CR, n === 6 ? 8 : 6, { come: 500 }, a, n - a);
    assert.deepEqual([r.returnCents, r.bets.come, r.bets.comeOn], [0, 0, { [n]: { bet: 500, odds: 0 } }], `Come moves to ${n}`);
  }
  // On its number: the number wins 1:1 (Odds at true odds), a 7 loses both.
  const wins = roll(CR, 6, { comeOn: { 4: { bet: 500, odds: 1000 } } }, 1, 3);
  assert.deepEqual([wins.returnCents, wins.bets.comeOn], [500 + 500 + 1000 + 2000, {}], 'Come 4 wins 1:1, its Odds 2:1');
  const loses = roll(CR, 6, { comeOn: { 4: { bet: 500, odds: 1000 } } }, 3, 4);
  assert.deepEqual([loses.returnCents, loses.lostCents, loses.bets.comeOn], [0, 1500, {}], 'seven-out: Come bet and its Odds lose');
  // Several Come bets at once; a seven-out takes every one, a fresh Come in the Come spot wins on it.
  const out = roll(CR, 8, { pass: 500, come: 300, comeOn: { 4: { bet: 500, odds: 0 }, 9: { bet: 200, odds: 400 } } }, 2, 5);
  assert.equal(out.kind, 'sevenOut');
  assert.equal(out.lostCents, 500 + 500 + 200 + 400);
  assert.equal(out.returnCents, 600, 'the fresh Come bet wins 1:1 on the 7');
  assert.deepEqual(out.bets.comeOn, {});
  // A fresh Come on the point-made roll moves to that number; an older Come on it wins first.
  const made = roll(CR, 6, { pass: 500, come: 500, comeOn: { 6: { bet: 200, odds: 0 } } }, 2, 4);
  assert.equal(made.kind, 'pointMade');
  assert.equal(made.returnCents, 1000 + 400);
  assert.deepEqual(made.bets.comeOn, { 6: { bet: 500, odds: 0 } });
  // A new Come bet can't pile onto an older one: the roll that moves it to 5 is the roll that makes the
  // older Come 5 win, so the older one is paid and the new one takes its place ("off and on").
  const land = roll(CR, 6, { come: 1000, comeOn: { 5: { bet: 1500, odds: 0 } } }, 2, 3);
  assert.deepEqual([land.bets.comeOn, land.returnCents], [{ 5: { bet: 1000, odds: 0 } }, 3000], 'old $15 Come 5 paid, new $10 on 5');
});

test('Crapless Come: only a 7 wins at once; every other number (2, 3, 11, 12 too) moves', () => {
  assert.equal(roll(CL, 6, { come: 500 }, 3, 4).returnCents, 1000);
  for (const [a, b] of [[1, 1], [1, 2], [5, 6], [6, 6], [2, 2], [4, 5]]) {
    const r = roll(CL, 6, { come: 500 }, a, b);
    assert.deepEqual([r.returnCents, r.lostCents, r.bets.comeOn], [0, 0, { [a + b]: { bet: 500, odds: 0 } }], `Crapless Come moves to ${a + b}`);
  }
  const eleven = roll(CL, 6, { comeOn: { 11: { bet: 500, odds: 500 } } }, 5, 6);
  assert.equal(eleven.returnCents, 1000 + 500 + 1500, 'Come 11 wins 1:1, Odds 3:1');
  const two = roll(CL, 6, { comeOn: { 2: { bet: 500, odds: 1000 } } }, 1, 1);
  assert.equal(two.returnCents, 1000 + 1000 + 5000, 'Come 2 Odds 5:1');
});

test('Come Odds are off on a come-out roll: a 7 loses the Come bet and returns its Odds', () => {
  for (const variant of [CR, CL]) {
    const seven = roll(variant, null, { comeOn: { 6: { bet: 500, odds: 1000 } } }, 3, 4);
    assert.deepEqual([seven.lostCents, seven.returnCents, seven.bets.comeOn], [500, 1000, {}], `${variant.id}: flat lost, Odds back`);
    assert.ok(seven.lines.some((l) => l.bet === 'comeOdds' && l.result === 'returned'));
    const six = roll(variant, null, { comeOn: { 6: { bet: 500, odds: 1000 } } }, 2, 4);
    assert.deepEqual([six.returnCents, six.lostCents, six.nextPoint], [1000 + 1000, 0, 6], `${variant.id}: flat wins 1:1, Odds back unpaid`);
  }
});

test("Odds pay true odds to the cent; Don't Pass Odds pay the inverse", () => {
  const pass = (point, odds) => roll(CR, point, { pass: 100, odds }, ...{ 4: [1, 3], 5: [1, 4], 6: [1, 5], 8: [2, 6], 9: [3, 6], 10: [4, 6] }[point]).returnCents - 200;
  assert.deepEqual([pass(4, 100), pass(10, 100), pass(5, 300), pass(9, 300), pass(6, 500), pass(8, 500)], [300, 300, 750, 750, 1100, 1100]);
  assert.equal(pass(6, 700), 700 + 840, '$7 at 6:5 = $8.40');
  const lay = (point, dontOdds) => roll(CR, point, { dontPass: 1000, dontOdds }, 3, 4).returnCents - 2000;
  assert.equal(lay(4, 2000), 2000 + 1000, '4 at 1:2');
  assert.equal(lay(10, 2000), 2000 + 1000);
  assert.equal(lay(5, 300), 300 + 200, '5 at 2:3');
  assert.equal(lay(9, 1500), 1500 + 1000);
  assert.equal(lay(6, 1200), 1200 + 1000, '6 at 5:6');
  assert.equal(lay(8, 500), 500 + 417, '$5 at 5:6 = $4.17 (to the nearest cent)');
  const made = roll(CR, 6, { dontPass: 1000, dontOdds: 1200 }, 2, 4);
  assert.deepEqual([made.returnCents, made.lostCents], [0, 2200], 'point made: Don\'t Pass and its Odds lose');
  // Crapless Odds on the extra points.
  assert.equal(roll(CL, 2, { pass: 100, odds: 500 }, 1, 1).returnCents, 200 + 500 + 2500, '2 at 5:1');
  assert.equal(roll(CL, 12, { pass: 100, odds: 500 }, 6, 6).returnCents, 200 + 500 + 2500, '12 at 5:1');
  assert.equal(roll(CL, 3, { pass: 100, odds: 500 }, 1, 2).returnCents, 200 + 500 + 1500, '3 at 3:1');
  assert.equal(roll(CL, 11, { pass: 100, odds: 500 }, 5, 6).returnCents, 200 + 500 + 1500, '11 at 3:1');
});

test('limit messages name the limit (line $20, spot $30, Odds 2×, $60 total)', () => {
  assert.match(D.limitProblem(CR, bets({ pass: 2100 }), { kind: 'pass' }), /Line limit.*\$20/);
  assert.match(D.limitProblem(CR, bets({ come: 2100 }), { kind: 'come' }), /Line limit: Come/);
  assert.match(D.limitProblem(CR, bets({ place: { 6: 3100 } }), { kind: 'place', number: 6 }), /Spot limit: Place 6.*\$30/);
  assert.match(D.limitProblem(CR, bets({ hard: { 8: 3100 } }), { kind: 'hard', number: 8 }), /Spot limit: Hard 8/);
  assert.match(D.limitProblem(CR, bets({ pass: 1000, odds: 2100 }), { kind: 'odds' }), /2× your Pass bet \(\$20\)/);
  assert.match(D.limitProblem(CR, bets({ dontPass: 1000, dontOdds: 2100 }), { kind: 'dontOdds' }), /2× your Don't Pass bet/);
  assert.match(D.limitProblem(CR, bets({ comeOn: { 5: { bet: 500, odds: 1100 } } }), { kind: 'comeOdds', number: 5 }), /2× your Come 5 bet \(\$10\)/);
  assert.equal(D.limitProblem(CR, bets({ pass: 2000, odds: 4000 }), { kind: 'odds' }), '', '$40 Odds behind $20: not capped by $30, total exactly $60');
  assert.match(D.limitProblem(CR, bets({ pass: 2000, odds: 4000, field: 100 }), { kind: 'field' }), /Table limit.*\$60.*\$61/);
});

// ================= Craps at the table =================
const CRAPS = 'craps';
const cr = (uid, action, fields, now) => act(CRAPS, uid, action, fields, now);
const chips = (uid, changes) => cr(uid, 'bets', { changes, requestId: rid() });
const crRoll = (uid, d1, d2, seq = table(CRAPS).rollSeq) => {
  dice = [d1, d2];
  return cr(uid, 'roll', { rollSeq: seq });
};
const betsOf = (seat) => table(CRAPS).seats[seat].bets;

test('every limit at the table, with cent-exact payouts: line $20, spot $30, Odds 2×, $60 on the felt', async () => {
  seed(20000);
  await cr('p1', 'sit', { seat: 0 });
  await err(chips('p1', [{ kind: 'pass', cents: 2100 }]), 'SPOT_LIMIT', /Line limit: Pass holds up to \$20/);
  await chips('p1', [{ kind: 'pass', cents: 2000 }]);
  await err(chips('p1', [{ kind: 'field', cents: 3100 }]), 'SPOT_LIMIT', /Spot limit: Field holds up to \$30/);
  await err(chips('p1', [{ kind: 'hard', number: 4, cents: 3100 }]), 'SPOT_LIMIT', /Spot limit: Hard 4/);
  await err(chips('p1', [{ kind: 'come', cents: 500 }]), 'BET_NOT_ALLOWED', /Come spot opens once a Point is set/);
  await chips('p1', [{ kind: 'field', cents: 3000 }]);
  await err(chips('p1', [{ kind: 'hard', number: 4, cents: 1100 }]), 'SPOT_LIMIT', /Table limit/);
  await chips('p1', [{ kind: 'hard', number: 4, cents: 1000 }]); // exactly $60
  assert.equal(D.totalOnFelt(betsOf(0)), 6000);
  await cr('p1', 'removeBet', { kind: 'field' });
  await cr('p1', 'removeBet', { kind: 'hard', number: 4 }); // Hard ways come down any time before a roll
  assert.equal(wallet('p1'), 20000 - 2000);

  await crRoll('p1', 2, 2); // point 4
  assert.equal(table(CRAPS).point, 4);
  await err(chips('p1', [{ kind: 'odds', cents: 4100 }]), 'SPOT_LIMIT', /2× your Pass bet \(\$40\)/);
  await chips('p1', [{ kind: 'odds', cents: 4000 }]); // above the $30 spot max: Odds aren't capped by it
  await err(chips('p1', [{ kind: 'come', cents: 100 }]), 'SPOT_LIMIT', /Table limit/);
  await chips('p1', [{ kind: 'odds', cents: -2000 }]);
  await chips('p1', [{ kind: 'come', cents: 2000 }]);
  await err(chips('p1', [{ kind: 'come', cents: 100 }]), 'SPOT_LIMIT', /Line limit: Come/);

  // 1+3: point made. Pass $20 at 1:1, Odds $20 at 2:1; the fresh Come moves to 4.
  const before = wallet('p1');
  await crRoll('p1', 1, 3);
  assert.equal(wallet('p1'), before + 4000 + 6000);
  assert.deepEqual(betsOf(0).comeOn, { 4: { bet: 2000, odds: 0 } });
  // Come Odds on 4: up to 2× the Come bet.
  await err(chips('p1', [{ kind: 'comeOdds', number: 4, cents: 4100 }]), 'SPOT_LIMIT', /2× your Come 4 bet/);
  await err(chips('p1', [{ kind: 'comeOdds', number: 5, cents: 100 }]), 'BET_NOT_ALLOWED', /need a Come bet on 5/);
  await chips('p1', [{ kind: 'comeOdds', number: 4, cents: 4000 }]);
  await err(cr('p1', 'removeBet', { kind: 'come' }), 'BET_LOCKED', /stays on its number/);
  await cr('p1', 'removeBet', { kind: 'comeOdds', number: 4 }); // its Odds can come down
  await chips('p1', [{ kind: 'comeOdds', number: 4, cents: 1000 }, { kind: 'pass', cents: 500 }]);
  // Come-out 7: Pass wins; Come 4 loses; its Odds are off and come back.
  const w = wallet('p1');
  await crRoll('p1', 3, 4);
  assert.equal(wallet('p1'), w + 1000 + 1000, 'Pass $5 → $10 back, Come Odds $10 returned');
  assert.deepEqual(betsOf(0).comeOn, {});
  moneyAddsUp(20000);
});

test('Come bets at the table: several numbers, one Come bet per number, seven-out takes them all', async () => {
  seed(20000);
  await cr('p1', 'sit', { seat: 0 });
  await cr('p2', 'sit', { seat: 1 });
  await chips('p1', [{ kind: 'pass', cents: 500 }]);
  await crRoll('p1', 4, 4); // point 8
  await chips('p2', [{ kind: 'come', cents: 500 }]);
  await crRoll('p1', 2, 3); // → Come 5
  await chips('p2', [{ kind: 'come', cents: 500 }]);
  await crRoll('p1', 4, 6); // → Come 10
  await chips('p2', [{ kind: 'come', cents: 1000 }]);
  await crRoll('p1', 1, 4); // Come 5 wins 1:1 ($5 → $10 back), the new Come takes its place on 5
  assert.deepEqual(betsOf(1).comeOn, { 5: { bet: 1000, odds: 0 }, 10: { bet: 500, odds: 0 } });
  await chips('p2', [{ kind: 'comeOdds', number: 10, cents: 1000 }, { kind: 'come', cents: 1500 }]);
  await crRoll('p1', 2, 3); // Come 5 ($10) wins; the $15 Come moves onto 5
  assert.deepEqual(betsOf(1).comeOn, { 5: { bet: 1500, odds: 0 }, 10: { bet: 500, odds: 1000 } });
  const w = wallet('p2');
  await crRoll('p1', 6, 1); // seven-out
  assert.equal(wallet('p2'), w, 'every Come bet and Come Odds on a number lost');
  assert.deepEqual(betsOf(1).comeOn, {});
  assert.equal(table(CRAPS).point, null);
  moneyAddsUp(20000);
});

test('leaving with a Come bet on a number: it keeps working; Hard ways are refunded when the seat frees', async () => {
  seed(10000);
  await cr('p2', 'sit', { seat: 0 });
  await cr('p1', 'sit', { seat: 1 });
  await chips('p2', [{ kind: 'pass', cents: 500 }]);
  await crRoll('p2', 3, 3); // point 6
  await chips('p1', [{ kind: 'come', cents: 500 }, { kind: 'hard', number: 8, cents: 500 }]);
  await crRoll('p2', 2, 2); // p1's Come → 4
  const r = await cr('p1', 'leave', {});
  assert.equal(r.leaving, true, 'a Come bet on a number must play out');
  await crRoll('p2', 1, 2);
  assert.equal(table(CRAPS).seats[1]?.uid, 'p1', 'still there while Come 4 is working');
  await crRoll('p2', 1, 3); // Come 4 wins → nothing left that must play out → seat frees, Hard 8 refunded
  assert.equal(table(CRAPS).seats[1], null);
  assert.equal(wallet('p1'), 10000 - 1000 + 1000 + 500);
  assert.ok(ledger().some((e) => e.uid === 'p1' && e.type === 'casino_refund' && e.amountCents === 500 && /Hard/.test(e.note)));
  moneyAddsUp(10000);
});

test("another player's Come, Hard-way and Odds bets never block the shooter's roll", async () => {
  seed(20000);
  await cr('p1', 'sit', { seat: 0 });
  await cr('p2', 'sit', { seat: 1 });
  await chips('p1', [{ kind: 'pass', cents: 500 }]);
  await crRoll('p1', 2, 4); // point 6
  const seq = table(CRAPS).rollSeq; // what the shooter's phone loaded
  await chips('p2', [{ kind: 'come', cents: 500 }, { kind: 'hard', number: 6, cents: 500 }]);
  await chips('p2', [{ kind: 'place', number: 8, cents: 600 }]);
  await chips('p1', [{ kind: 'odds', cents: 1000 }]);
  const r = await crRoll('p1', 3, 3, seq); // made the hard way
  assert.deepEqual([r.total, r.kind], [6, 'pointMade']);
  await err(crRoll('p1', 1, 1, seq), 'STALE', 'the same tap twice is refused');
  moneyAddsUp(20000);
});
