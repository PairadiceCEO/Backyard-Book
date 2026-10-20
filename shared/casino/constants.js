// Casino values shared by the browser and /api/casino.

import { MAX_WALLET_CHANGE_CENTS } from '../constants.js';

// No maximum bets (0.16.0): a bet is whole dollars, at least $1, and the wallet balance is the only cap. The one
// ceiling is a technical guard against a bad request: no single bet above MAX_WALLET_CHANGE_CENTS ($1,000,000).
export const CASINO_MIN_BET_DOLLARS = 1;
export const CASINO_SEATS = 5;

// The chips on every casino game and on Slots. A chip is a denomination, not a limit: a spot or a bet can hold any
// whole-dollar amount built from them.
export const CHIP_VALUES = [1, 2, 5, 10, 25, 100];

export const BET_CEILING_CENTS = MAX_WALLET_CHANGE_CENTS;
export const BET_CEILING_MESSAGE = 'That bet is larger than the table allows.';
export const BET_AMOUNT_MESSAGE = 'Bets are whole dollars, at least $1.';
export const CHIP_MESSAGE = `A chip is ${CHIP_VALUES.map((d) => `$${d}`).join(', ').replace(/, (\$\d+)$/, ' or $1')}.`;
export const BET_HELP_TEXT = 'Minimum $1. Bet as much as your wallet holds.';

// Table timers. Deadlines are server milliseconds; phones count down against the server's clock.
// Turn / results / dice / card-dealing timings live in timing.js (one file to tweak them all).
export { TURN_SECONDS, RESULTS_SECONDS, TICK_JITTER_MS, DICE_ANIMATION_MS, CRAPS_TURN_SECONDS } from './timing.js';
export const HEARTBEAT_SECONDS = 20; // a seated phone says "still here" this often while visible
export const PRESENCE_WRITE_SECONDS = 30; // the server writes presence at most this often per player
export const SEAT_TIMEOUT_SECONDS = 60; // no heartbeat for this long → the seat frees at round end

export const CASINO_LEDGER_TYPES = ['casino_bet', 'casino_payout', 'casino_refund'];

// The lobby. `opensIn` is the build phase that opens a table; null = open now.
export const CASINO_GAMES = [
  { id: 'slots', name: '7s Slots', kind: 'slots', blurb: 'Three reels, one payline, Red 7s pay 300×.', opensIn: null },
  { id: 'blackjack', name: 'Blackjack', kind: 'table', blurb: '6 decks · dealer hits soft 17 · blackjack pays 3:2', opensIn: null },
  { id: 'baccarat', name: 'Baccarat', kind: 'table', blurb: 'Player 1:1 · Banker 0.95:1 · Tie 8:1 · 8 decks', opensIn: null },
  { id: 'craps', name: 'Craps', kind: 'table', blurb: 'Pass · Don’t Pass · Odds · Place · Field', opensIn: null },
  { id: 'crapless', name: 'Crapless Craps', kind: 'table', blurb: 'Every number but 7 is a point · no Don’t Pass', opensIn: null },
];

export function casinoGame(id) {
  return CASINO_GAMES.find((g) => g.id === id) ?? null;
}

// Chip check: the tapped chip is one of CHIP_VALUES (dollars).
export function isChip(dollars) {
  return Number.isInteger(dollars) && CHIP_VALUES.includes(dollars);
}

// Amount check: whole dollars, at least $1, a safe integer. Says nothing about the ceiling (betAmountProblem does).
export function isValidBetAmount(dollars) {
  return Number.isSafeInteger(dollars) && dollars >= CASINO_MIN_BET_DOLLARS;
}

// Sanity ceiling on one bet, in cents: '' when fine, else BET_CEILING_MESSAGE. Not a game limit.
export function betCeilingProblem(cents) {
  return Number.isSafeInteger(cents) && cents <= BET_CEILING_CENTS ? '' : BET_CEILING_MESSAGE;
}

// Why `dollars` can't be one bet: '' if it can. Integers past the ceiling (or past safe integers) get the ceiling
// message; anything else that isn't whole dollars ≥ $1 gets BET_AMOUNT_MESSAGE.
export function betAmountProblem(dollars) {
  if (typeof dollars !== 'number' || !Number.isInteger(dollars) || dollars < CASINO_MIN_BET_DOLLARS) return BET_AMOUNT_MESSAGE;
  if (!isValidBetAmount(dollars)) return BET_CEILING_MESSAGE;
  return betCeilingProblem(dollars * 100);
}

// Winnings rounded to the nearest cent (stake × num / den), e.g. $5 at 7:6 → 583.
export function winningsCents(stakeCents, num, den) {
  return Math.round((stakeCents * num) / den);
}

// "$5" or "$5.50": dollars for messages shared by the server and the phone.
export function dollarsText(cents) {
  return `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
}
