// Blackjack rules shared by the server (dealing, settling) and the phone (totals, which buttons work).
// Pure functions: no Firestore, no clock.

import { cardRank } from './cards.js';
import { winningsCents } from './constants.js';

export const BLACKJACK_DECKS = 6;
export const BLACKJACK_SHOE_CARDS = 52 * BLACKJACK_DECKS; // 312
export const BLACKJACK_RESHUFFLE_AT = 281; // reshuffle before a round once 90% of the shoe is dealt
// Card timing, measured from the server's timestamp of the write that dealt them, so every phone turns
// the same card over at the same moment: the opening cards (two each, dealer included) 0.5 s apart,
// every card after that (hits, doubles, split cards, the hole card, the dealer's draws) 1 s apart.
export const BLACKJACK_INITIAL_GAP_MS = 500;
export const BLACKJACK_LATER_GAP_MS = 1000;
export const CARD_SETTLE_MS = 700; // after the last card turns over, before a decision clock starts

// A = 11 (or 1), 2–9 face value, 10/J/Q/K = 10.
export function cardValue(card) {
  const rank = cardRank(card);
  if (rank === 'A') return 11;
  if (rank === 'T' || rank === 'J' || rank === 'Q' || rank === 'K') return 10;
  return Number(rank);
}

// { total, soft } — soft when an Ace still counts as 11.
export function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (!card) continue;
    total += cardValue(card);
    if (cardRank(card) === 'A') aces += 1;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0 };
}

// A natural: an Ace and a 10-value card as the first two cards of an unsplit hand.
export function isBlackjack(cards, fromSplit = false) {
  return !fromSplit && cards.length === 2 && handValue(cards).total === 21;
}

export function isBust(cards) {
  return handValue(cards).total > 21;
}

// The dealer hits below 17 and on soft 17.
export function dealerHits(cards) {
  const { total, soft } = handValue(cards);
  return total < 17 || (total === 17 && soft);
}

// The dealer peeks for blackjack when showing an Ace or a 10-value card.
export function dealerPeeks(upCard) {
  return Boolean(upCard) && (cardRank(upCard) === 'A' || cardValue(upCard) === 10);
}

export function offersInsurance(upCard) {
  return Boolean(upCard) && cardRank(upCard) === 'A';
}

// Two cards of the same value (any two 10-value cards count), once per seat.
export function canSplit(hand, handsInSeat) {
  return handsInSeat === 1 && hand.cards.length === 2 && cardValue(hand.cards[0]) === cardValue(hand.cards[1]);
}

// Any first two cards, also after a split, except split Aces (they get one card each and stand).
export function canDouble(hand) {
  return hand.cards.length === 2 && !hand.splitAces;
}

// Blackjack pays 3:2: a $5 natural returns $12.50.
export function naturalReturnCents(betCents) {
  return betCents + winningsCents(betCents, 3, 2);
}

// Insurance pays 2:1.
export function insuranceReturnCents(insuranceCents) {
  return insuranceCents + winningsCents(insuranceCents, 2, 1);
}

export function maxInsuranceCents(betCents) {
  return Math.floor(betCents / 2);
}

// Outcome of a hand that was played out against the dealer's final cards.
// Returns { outcome: 'win' | 'push' | 'lose' | 'bust', returnCents }.
export function settlePlayedHand(hand, dealerCards) {
  if (isBust(hand.cards)) return { outcome: 'bust', returnCents: 0 };
  const player = handValue(hand.cards).total;
  const dealer = handValue(dealerCards).total;
  if (dealer > 21 || player > dealer) return { outcome: 'win', returnCents: hand.betCents * 2 };
  if (player === dealer) return { outcome: 'push', returnCents: hand.betCents };
  return { outcome: 'lose', returnCents: 0 };
}

// What the phone prints for a total: "17", "soft 17", "BJ", "bust 24".
export function totalLabel(cards, fromSplit = false) {
  const { total, soft } = handValue(cards);
  if (isBlackjack(cards, fromSplit)) return 'BJ';
  if (total > 21) return `bust ${total}`;
  return soft && total < 21 ? `soft ${total}` : String(total);
}
