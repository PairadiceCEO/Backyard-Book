// npm test: 0.25.0 come-out "working" switch for Place bets and Hard ways (shared/casino/dice.js), Craps and Crapless.
// OFF by default on every come-out; switched ON they win and lose on the come-out like with a point on; the flags reset when a
// point is made or on a seven-out; a bet taken down loses its flag; payouts round down to the cent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DICE_VARIANTS } from '../shared/casino/diceVariants.js';
import { WORKING_POINT_ON, cloneBets, isWorking, setWorking, settleRoll, workingState } from '../shared/casino/dice.js';

const CRAPS = DICE_VARIANTS.craps;
const CRAPLESS = DICE_VARIANTS.crapless;
const bets = (b) => cloneBets({ pass: 500, ...b });
const on = (v, b, change) => {
  const r = setWorking(v, null, b, change);
  assert.equal(r.problem, undefined, r.problem);
  return r.bets;
};

test('default OFF on the come-out: Place and Hard ways are untouched by a 6, a 7 and a hard 8 (new and existing bets)', () => {
  const b = bets({ place: { 6: 600, 4: 500 }, hard: { 8: 100 } });
  assert.equal(workingState(b), 'off');
  for (const [total, dice] of [[6, [3, 3]], [7, [3, 4]], [8, [4, 4]], [4, [2, 2]]]) {
    const r = settleRoll(CRAPS, null, b, total, dice);
    assert.deepEqual([r.bets.place, r.bets.hard], [{ 4: 500, 6: 600 }, { 8: 100 }], `come-out ${total}`);
    assert.equal(r.lines.filter((l) => l.bet === 'place' || l.bet === 'hard').length, 0, `nothing decided on ${total}`);
  }
});

test('switch one, switch all, back off; refused with a point on or without the bet; a mixed seat says "some"', () => {
  let b = bets({ place: { 4: 1000 }, hard: { 8: 500 } });
  b = on(CRAPS, b, { kind: 'hard', number: 8, on: true });
  assert.deepEqual([isWorking(b, 'hard', 8), isWorking(b, 'place', 4), workingState(b)], [true, false, 'some']);
  b = on(CRAPS, b, { all: true, on: true });
  assert.deepEqual([workingState(b), b.working], ['on', { place: { 4: true }, hard: { 8: true } }]);
  b = on(CRAPS, b, { all: true, on: false });
  assert.equal(b.working, undefined, 'nothing ON: no working key at all');
  assert.equal(setWorking(CRAPS, 6, b, { all: true, on: true }).problem, WORKING_POINT_ON);
  assert.equal(WORKING_POINT_ON, 'Bets always work once a Point is set.');
  assert.equal(setWorking(CRAPS, null, b, { kind: 'place', number: 5, on: true }).problem, 'No Place 5 bet to switch on.');
  assert.match(setWorking(CRAPS, null, b, { kind: 'place', number: 2, on: true }).problem, /no Place 2 in Craps/);
  assert.match(setWorking(CRAPS, null, bets({}), { all: true, on: true }).problem, /no Place bets or Hard ways/);
  assert.match(setWorking(CRAPS, null, b, { kind: 'field', on: true }).problem, /Only Place bets and Hard ways/);
});

test('ON Place 6 is paid on a come-out 6 and stays up; ON Place and Hard ways lose on a come-out 7', () => {
  const b = on(CRAPS, bets({ place: { 6: 600, 4: 500 }, hard: { 8: 100 } }), { all: true, on: true });
  const six = settleRoll(CRAPS, null, b, 6, [2, 4]);
  assert.equal(six.nextPoint, 6, 'the 6 is also the new point');
  assert.deepEqual([six.returnCents, six.profitCents, six.bets.place[6]], [700, 700, 600], '$6 at 7:6 pays $7 and stays up');
  assert.equal(six.bets.hard[8], 100, 'Hard 8 untouched by a 6');
  const seven = settleRoll(CRAPS, null, b, 7, [3, 4]);
  assert.deepEqual([seven.lostCents, seven.bets.place, seven.bets.hard], [1200, {}, {}], 'a come-out 7 takes every ON bet');
  assert.equal(seven.returnCents, 1000, 'Pass still wins its 7');
  assert.equal(seven.bets.working, undefined, 'the flags went with the bets');
});

test('ON Hard 8 loses on an easy 8 and pays 8:1 (stays up) on 4-4; an OFF Hard 8 next to it is untouched', () => {
  const b = on(CRAPS, bets({ hard: { 8: 500, 6: 200 } }), { kind: 'hard', number: 8, on: true });
  const easy = settleRoll(CRAPS, null, b, 8, [5, 3]);
  assert.deepEqual([easy.lostCents, easy.bets.hard], [500, { 6: 200 }]);
  const hard = settleRoll(CRAPS, null, b, 8, [4, 4]);
  assert.deepEqual([hard.returnCents, hard.bets.hard[8]], [4000, 500], '$5 at 8:1 = $40, and it stays up');
  const sixHard = settleRoll(CRAPS, null, b, 6, [3, 3]);
  assert.deepEqual([sixHard.returnCents, sixHard.bets.hard[6]], [0, 200], 'Hard 6 was OFF: a hard 6 on the come-out pays nothing');
});

test('the flags reset at the next come-out: after a point is made and after a seven-out', () => {
  const b = on(CRAPS, bets({ place: { 4: 500 }, hard: { 10: 100 } }), { all: true, on: true });
  const point = settleRoll(CRAPS, null, b, 9, [4, 5]);
  assert.equal(point.nextPoint, 9);
  assert.ok(point.bets.working, 'still flagged while the point is on (it doesn\'t matter then)');
  const made = settleRoll(CRAPS, 9, point.bets, 9, [3, 6]);
  assert.deepEqual([made.nextPoint, made.bets.place[4], made.bets.working], [null, 500, undefined], 'point made: Place 4 is back OFF');
  const afterSeven = settleRoll(CRAPS, 9, { ...point.bets, place: { 4: 500 } }, 7, [3, 4]);
  assert.equal(afterSeven.bets.working, undefined);
  // A Place bet added afterwards starts OFF.
  const fresh = cloneBets({ ...made.bets, place: { 4: 500, 6: 600 } });
  assert.equal(workingState(fresh), 'off');
});

test('a bet taken down loses its flag; chips added to an ON spot stay ON', () => {
  const b = on(CRAPS, bets({ place: { 4: 500, 5: 500 } }), { all: true, on: true });
  const down = cloneBets({ ...b, place: { 5: 500 } });
  assert.deepEqual(down.working, { place: { 5: true }, hard: {} });
  const more = cloneBets({ ...b, place: { 4: 1500, 5: 500 } });
  assert.equal(isWorking(more, 'place', 4), true);
});

test('Crapless: ON Place 2, 3, 11 and 12 pay on a come-out (9:2, 11:4) and lose on a 7', () => {
  const b = on(CRAPLESS, bets({ place: { 2: 200, 3: 400, 11: 400, 12: 200 } }), { all: true, on: true });
  const cases = [[2, [1, 1], 900], [3, [1, 2], 1100], [11, [5, 6], 1100], [12, [6, 6], 900]];
  for (const [total, dice, winnings] of cases) {
    const r = settleRoll(CRAPLESS, null, b, total, dice);
    assert.equal(r.returnCents, winnings, `Place ${total}`);
    assert.equal(r.bets.place[total], b.place[total], `Place ${total} stays up`);
  }
  const seven = settleRoll(CRAPLESS, null, b, 7, [1, 6]);
  assert.deepEqual([seven.lostCents, seven.bets.place], [1200, {}]);
  // OFF in Crapless: untouched.
  const off = settleRoll(CRAPLESS, null, bets({ place: { 2: 200 } }), 2, [1, 1]);
  assert.deepEqual([off.returnCents, off.bets.place[2]], [0, 200]);
});

test('payouts round down to the cent: $1 ON Place 6 on a come-out 6 pays $1.16 (7:6 = $1.1667)', () => {
  const b = on(CRAPS, bets({ place: { 6: 100 } }), { kind: 'place', number: 6, on: true });
  assert.equal(settleRoll(CRAPS, null, b, 6, [1, 5]).returnCents, 116);
  assert.equal(settleRoll(CRAPS, 8, bets({ place: { 6: 100 } }), 6, [1, 5]).returnCents, 116, 'the same with a point on');
});
