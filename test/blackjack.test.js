// npm test: Blackjack rules in shared/casino/blackjack.js (hand totals, the dealer's soft 17, payouts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canDouble,
  canSplit,
  dealerHits,
  handValue,
  insuranceReturnCents,
  isBlackjack,
  maxInsuranceCents,
  naturalReturnCents,
  settlePlayedHand,
} from '../shared/casino/blackjack.js';

const cards = (...ranks) => ranks.map((r, i) => `${r}${'SHDC'[i % 4]}0`);

test('hand totals: Aces count 11 or 1, soft totals, naturals', () => {
  assert.deepEqual(handValue(cards('A', '6')), { total: 17, soft: true });
  assert.deepEqual(handValue(cards('A', '6', 'T')), { total: 17, soft: false });
  assert.deepEqual(handValue(cards('A', 'A', 'A')), { total: 13, soft: true });
  assert.deepEqual(handValue(cards('K', 'Q', '2')), { total: 22, soft: false });
  assert.equal(isBlackjack(cards('A', 'K')), true);
  assert.equal(isBlackjack(cards('A', 'K'), true), false, '21 after a split is not blackjack');
});

test('the dealer hits soft 17 and stands on hard 17 and soft 18', () => {
  assert.equal(dealerHits(cards('A', '6')), true);
  assert.equal(dealerHits(cards('5', 'A', 'A')), true);
  assert.equal(dealerHits(cards('T', '7')), false);
  assert.equal(dealerHits(cards('A', '7')), false);
  assert.equal(dealerHits(cards('T', '6')), true);
});

test('split and double', () => {
  assert.equal(canSplit({ cards: cards('8', '8') }, 1), true);
  assert.equal(canSplit({ cards: cards('K', 'T') }, 1), true);
  assert.equal(canSplit({ cards: cards('8', '9') }, 1), false);
  assert.equal(canSplit({ cards: cards('8', '8') }, 2), false, 'one split per seat');
  assert.equal(canDouble({ cards: cards('5', '6') }), true);
  assert.equal(canDouble({ cards: cards('5', '6'), fromSplit: true }), true, 'double after split');
  assert.equal(canDouble({ cards: cards('A', '6'), splitAces: true }), false);
  assert.equal(canDouble({ cards: cards('2', '3', '4') }), false);
});

test('payouts in cents: blackjack 3:2, insurance 2:1 up to half the bet, wins 1:1, pushes', () => {
  assert.equal(naturalReturnCents(500), 1250);
  assert.equal(naturalReturnCents(100), 250);
  assert.equal(insuranceReturnCents(250), 750);
  assert.equal(maxInsuranceCents(500), 250);
  const hand = (ranks, betCents = 500) => ({ cards: cards(...ranks), betCents });
  assert.deepEqual(settlePlayedHand(hand(['T', '9']), cards('T', '8')), { outcome: 'win', returnCents: 1000 });
  assert.deepEqual(settlePlayedHand(hand(['T', '8']), cards('T', '8')), { outcome: 'push', returnCents: 500 });
  assert.deepEqual(settlePlayedHand(hand(['T', '7']), cards('T', '8')), { outcome: 'lose', returnCents: 0 });
  assert.deepEqual(settlePlayedHand(hand(['T', '7']), cards('T', '6', 'K')), { outcome: 'win', returnCents: 1000 });
  assert.deepEqual(settlePlayedHand(hand(['T', '7', 'K']), cards('T', '6', 'K')), { outcome: 'bust', returnCents: 0 });
});
