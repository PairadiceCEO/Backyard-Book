// npm test: the dice engine (shared/casino/dice.js) with both variant tables.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DICE_VARIANTS } from '../shared/casino/diceVariants.js';
import { placeBlocker, removeBlocker, rollKind, settleRoll } from '../shared/casino/dice.js';

const CRAPS = DICE_VARIANTS.craps;
const CRAPLESS = DICE_VARIANTS.crapless;
const bets = (b) => ({ pass: 0, dontPass: 0, odds: 0, field: 0, place: {}, ...b });

test('dice.js holds no game numbers of its own: every rule comes from the variant table', () => {
  const code = readFileSync(new URL('../shared/casino/dice.js', import.meta.url), 'utf8')
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const numbers = code.match(/\b\d+\b/g) ?? [];
  assert.deepEqual([...new Set(numbers)].sort(), ['0', '1', '100'].filter((n) => numbers.includes(n)).sort(), `found ${[...new Set(numbers)]}`);
});

test('come-out: every total, both variants', () => {
  const expect = {
    craps: { 2: 'craps', 3: 'craps', 4: 'point', 5: 'point', 6: 'point', 7: 'natural', 8: 'point', 9: 'point', 10: 'point', 11: 'natural', 12: 'craps' },
    crapless: { 2: 'point', 3: 'point', 4: 'point', 5: 'point', 6: 'point', 7: 'natural', 8: 'point', 9: 'point', 10: 'point', 11: 'point', 12: 'point' },
  };
  for (const v of [CRAPS, CRAPLESS]) {
    for (let t = 2; t <= 12; t += 1) {
      assert.equal(rollKind(v, null, t), expect[v.id][t], `${v.id} come-out ${t}`);
      const r = settleRoll(v, null, bets({ pass: 500 }), t);
      if (expect[v.id][t] === 'natural') assert.deepEqual([r.returnCents, r.bets.pass, r.nextPoint], [1000, 0, null]);
      if (expect[v.id][t] === 'craps') assert.deepEqual([r.returnCents, r.lostCents, r.bets.pass], [0, 500, 0]);
      if (expect[v.id][t] === 'point') assert.deepEqual([r.returnCents, r.bets.pass, r.nextPoint], [0, 500, t]);
    }
  }
});

test("Don't Pass (Craps only): wins on 2 and 3, barred on 12 (push, stays up), loses on 7 and 11; wins on a seven-out", () => {
  const dp = (t, point = null) => settleRoll(CRAPS, point, bets({ dontPass: 500 }), t);
  assert.deepEqual([dp(2).returnCents, dp(2).bets.dontPass], [1000, 0]);
  assert.deepEqual([dp(3).returnCents, dp(3).bets.dontPass], [1000, 0]);
  assert.deepEqual([dp(12).returnCents, dp(12).lostCents, dp(12).bets.dontPass, dp(12).lines[0].result], [0, 0, 500, 'push']);
  assert.deepEqual([dp(7).lostCents, dp(11).lostCents], [500, 500]);
  assert.deepEqual([dp(7, 6).returnCents, dp(6, 6).lostCents, dp(5, 6).bets.dontPass], [1000, 500, 500]);
  assert.match(placeBlocker(CRAPLESS, null, bets(), 'dontPass'), /no Don't Pass/);
});

test('point phase: point made pays Pass 1:1 and Odds at true odds; seven-out loses Pass, Odds and every Place', () => {
  for (const v of [CRAPS, CRAPLESS]) {
    for (const point of v.points) {
      const made = settleRoll(v, point, bets({ pass: 500, odds: 1000 }), point);
      const [n, d] = v.odds[point];
      assert.equal(made.kind, 'pointMade');
      assert.equal(made.returnCents, 1000 + 1000 + Math.round((1000 * n) / d), `${v.id} odds on ${point}`);
      assert.equal(made.nextPoint, null);
      const out = settleRoll(v, point, bets({ pass: 500, odds: 1000, place: { [v.points[0] === point ? v.points[1] : v.points[0]]: 600 } }), 7);
      assert.deepEqual([out.kind, out.returnCents, out.lostCents, out.nextPoint, Object.keys(out.bets.place).length], ['sevenOut', 0, 2100, null, 0]);
    }
  }
  // The odds table itself.
  const oddsOn = (v, p) => settleRoll(v, p, bets({ pass: 100, odds: 1000 }), p).returnCents - 1200;
  assert.deepEqual([4, 5, 6, 8, 9, 10].map((p) => oddsOn(CRAPS, p)), [2000, 1500, 1200, 1200, 1500, 2000]);
  assert.deepEqual([2, 3, 11, 12].map((p) => oddsOn(CRAPLESS, p)), [5000, 3000, 3000, 5000], 'Crapless 2/12 at 5:1, 3/11 at 3:1');
});

test('Place: pays with cent rounding ($5 Place 6 wins $5.83), stays up, off on come-outs', () => {
  const place = (v, number, stake, total, point) => settleRoll(v, point, bets({ place: { [number]: stake } }), total);
  const p6 = place(CRAPS, 6, 500, 6, 8);
  assert.deepEqual([p6.returnCents, p6.profitCents, p6.bets.place[6]], [583, 583, 500], '$5 Place 6 at 7:6 wins $5.83 and stays up');
  assert.equal(place(CRAPS, 4, 500, 4, 8).returnCents, 900, '9:5');
  assert.equal(place(CRAPS, 5, 500, 5, 8).returnCents, 700, '7:5');
  assert.equal(place(CRAPS, 6, 300, 6, 8).returnCents, 350, '$3 at 7:6 = $3.50');
  assert.equal(place(CRAPS, 8, 100, 8, 6).returnCents, 117, '$1 at 7:6 = $1.1667 → $1.17');
  assert.equal(place(CRAPLESS, 2, 200, 2, 6).returnCents, 900, 'Crapless Place 2 at 9:2');
  assert.equal(place(CRAPLESS, 11, 400, 11, 6).returnCents, 1100, 'Crapless Place 11 at 11:4');
  assert.equal(place(CRAPS, 6, 500, 6, 6).returnCents, 583, 'a Place bet on the point number wins when the point is made');
  // Off on the come-out: a 7 doesn't lose them, their number doesn't pay.
  const offSeven = place(CRAPS, 6, 500, 7, null);
  assert.deepEqual([offSeven.lostCents, offSeven.bets.place[6]], [0, 500]);
  assert.equal(place(CRAPS, 6, 500, 6, null).returnCents, 0);
  assert.equal(placeBlocker(CRAPS, null, bets(), 'place', 6), null, 'Place bets go up on a come-out too (0.23.0)');
  assert.equal(placeBlocker(CRAPLESS, null, bets(), 'place', 2), null);
  assert.equal(removeBlocker(null, 'place'), null, 'and come down before any roll');
  assert.match(placeBlocker(CRAPS, 6, bets(), 'place', 2), /no Place 2/);
  assert.equal(placeBlocker(CRAPLESS, 6, bets(), 'place', 2), null);
});

test('Field: one roll; 3 4 9 10 11 pay 1:1, 2 and 12 pay 2:1, 5–8 lose; the same in both games', () => {
  for (const v of [CRAPS, CRAPLESS]) {
    const f = (t) => settleRoll(v, 6, bets({ field: 500 }), t);
    for (const t of [3, 4, 9, 10, 11]) assert.equal(f(t).returnCents, 1000);
    for (const t of [2, 12]) assert.equal(f(t).returnCents, 1500);
    for (const t of [5, 6, 7, 8]) assert.deepEqual([f(t).returnCents, f(t).lostCents], [0, 500]);
    for (let t = 2; t <= 12; t += 1) assert.equal(f(t).bets.field, 0, 'off after every roll');
  }
});

test('what can go down and come down when', () => {
  assert.equal(placeBlocker(CRAPS, null, bets(), 'pass'), null);
  assert.match(placeBlocker(CRAPS, 6, bets(), 'pass'), /before a come-out/);
  assert.match(placeBlocker(CRAPS, null, bets({ pass: 500 }), 'odds'), /once a Point is set/);
  assert.match(placeBlocker(CRAPS, 6, bets(), 'odds'), /need a Pass bet/);
  assert.equal(placeBlocker(CRAPS, 6, bets({ pass: 500 }), 'odds'), null);
  assert.equal(placeBlocker(CRAPS, null, bets(), 'field'), null);
  assert.equal(removeBlocker(null, 'pass'), null);
  assert.match(removeBlocker(6, 'pass'), /until the Point is decided/);
  assert.match(removeBlocker(6, 'dontPass'), /until the Point is decided/);
  for (const k of ['odds', 'place', 'field']) assert.equal(removeBlocker(6, k), null);
});
