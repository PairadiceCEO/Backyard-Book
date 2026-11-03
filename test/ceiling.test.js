// npm test (0.28.2): one $10,000,000 per-bet ceiling for everything, and every payout it can lead to stays a safe integer.
// Each game's largest multiplier is read from its real paytable (never retyped) and paid on a $10,000,000 bet; craps settles a
// felt with the ceiling on every spot through the real settleRoll, for every point and every roll.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BET_CEILING_CENTS, MAX_WALLET_CHANGE_CENTS, SPORTSBOOK_BET_CEILING_CENTS } from '../shared/constants.js';
import * as K from '../shared/casino/constants.js';
import { DICE_VARIANTS } from '../shared/casino/diceVariants.js';
import { emptyDiceBets, settleRoll } from '../shared/casino/dice.js';
import { BACCARAT_SIDE_SPOTS, TWENTY_ONE_3_PAYS, baccaratSideTopPays } from '../shared/casino/sideBets.js';
import { PAYTABLE } from '../shared/casino/slotMachine.js';
import { VIP_MAX_WIN_TIMES, vipCapBonus, vipCents, VIP_PAYTABLE, VIP_BONUS_MULT } from '../shared/casino/vipSlots.js';
import { maxBetPlan } from '../shared/casino/maxBet.js';
import { battleProblems } from '../shared/battles.js';
import { payoutCents, payoutTooLarge, stakeCeilingProblem } from '../shared/betRules.js';

const TEN_M = 1_000_000_000; // $10,000,000 in cents

test('one ceiling: $10,000,000 per bet for the casino, the slots, Battles and the sportsbook; the admin maximum is separate', () => {
  assert.equal(BET_CEILING_CENTS, TEN_M);
  assert.equal(SPORTSBOOK_BET_CEILING_CENTS, TEN_M);
  assert.equal(K.BET_CEILING_CENTS, TEN_M);
  assert.equal(MAX_WALLET_CHANGE_CENTS, 10_000_000_000, '$100,000,000');
  // exactly $10,000,000 is fine everywhere; $10,000,001 is not
  assert.equal(K.betAmountProblem(10_000_000), '');
  assert.equal(K.betAmountProblem(10_000_001), K.BET_CEILING_MESSAGE);
  assert.equal(stakeCeilingProblem(TEN_M), '');
  assert.notEqual(stakeCeilingProblem(TEN_M + 1), '');
  const battle = { title: 'B', description: '', format: 'ffa', payoutBps: [10000], players: [{ uid: 'a' }, { uid: 'b' }] };
  assert.deepEqual(battleProblems({ ...battle, stakeDollars: 10_000_000 }, 'a'), []);
  assert.deepEqual(battleProblems({ ...battle, stakeDollars: 10_000_001 }, 'a'), [K.BET_CEILING_MESSAGE]);
  // Max bet stops at the ceiling
  assert.deepEqual(maxBetPlan(0, 50 * TEN_M), { addCents: TEN_M, totalCents: TEN_M, capped: true });
});

test('every casino payout on a $10,000,000 bet is a safe integer (largest multiplier of each real paytable)', () => {
  const winnings = (pays) => K.winningsCents(TEN_M, pays, 1);
  const top21 = Math.max(...TWENTY_ONE_3_PAYS.map((p) => p.pays));
  assert.equal(top21, 100);
  assert.ok(Number.isSafeInteger(TEN_M + winnings(top21)), '21+3 suited trips');
  for (const spot of BACCARAT_SIDE_SPOTS) {
    const top = baccaratSideTopPays(spot);
    assert.ok(top > 0 && Number.isSafeInteger(TEN_M + winnings(top)), `${spot} ${top}:1`);
  }
  const topSlot = Math.max(...PAYTABLE.map((l) => l.pays));
  assert.ok(Number.isSafeInteger(TEN_M * topSlot), `7s Slots ${topSlot}×`);
  // VIP: the per-line tenths at × 3, and the 10,000× cap per paid spin
  const topLine = Math.max(...VIP_PAYTABLE.map((l) => l.tenths));
  assert.ok(Number.isSafeInteger(vipCents(TEN_M, topLine, VIP_BONUS_MULT) * 3), 'three top lines × 3');
  assert.equal(vipCapBonus(TEN_M, 0, Number.MAX_SAFE_INTEGER), VIP_MAX_WIN_TIMES * TEN_M, 'the cap at $10,000,000');
  assert.ok(Number.isSafeInteger(VIP_MAX_WIN_TIMES * TEN_M), '$100,000,000,000 = 1e13 cents');
});

test('craps and Crapless: the ceiling on every spot of the felt, every point, every roll: the return is a safe integer', () => {
  for (const variant of Object.values(DICE_VARIANTS)) {
    const numbers = Object.keys(variant.place).map(Number);
    const full = {
      ...emptyDiceBets(),
      pass: TEN_M,
      odds: 2 * TEN_M,
      come: TEN_M,
      field: TEN_M,
      place: Object.fromEntries(numbers.map((n) => [n, TEN_M])),
      hard: { 4: TEN_M, 6: TEN_M, 8: TEN_M, 10: TEN_M },
      comeOn: Object.fromEntries(numbers.map((n) => [n, { bet: TEN_M, odds: 2 * TEN_M }])),
      ...(variant.dontPass ? { dontPass: TEN_M, dontOdds: 2 * TEN_M } : {}),
      working: { place: true, hard: true },
    };
    let checked = 0;
    let most = 0;
    for (const point of [null, ...variant.points]) {
      for (let a = 1; a <= 6; a += 1) {
        for (let b = 1; b <= 6; b += 1) {
          const bets = point === null ? { ...full, odds: 0, dontOdds: 0 } : full;
          const r = settleRoll(variant, point, structuredClone(bets), a + b, [a, b]);
          assert.ok(Number.isSafeInteger(r.returnCents), `${variant.id} point ${point} roll ${a}+${b}: ${r.returnCents}`);
          most = Math.max(most, r.returnCents);
          checked += 1;
        }
      }
    }
    assert.ok(checked >= 36 * 7, variant.id);
    assert.ok(most >= 10 * TEN_M, `${variant.id}: the felt really pays (most ${most} cents), so the check is not empty`);
  }
});

test('sportsbook: a $10,000,000 single pays a safe integer; the payoutTooLarge guard still refuses a ten-leg longshot parlay at the ceiling', () => {
  assert.equal(payoutTooLarge(payoutCents(TEN_M, 1.909)), false);
  assert.equal(payoutTooLarge(payoutCents(TEN_M, 1001)), false, '+100,000 single');
  assert.equal(payoutTooLarge(payoutCents(TEN_M, 34 ** 10)), true, 'a ten-leg longshot parlay');
});
