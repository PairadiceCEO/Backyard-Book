// Casino values shared by the browser and /api/casino.

export const CASINO_MIN_BET_DOLLARS = 1;
export const CASINO_MAX_BET_DOLLARS = 10;
export const CASINO_SEATS = 5;

// Timers (used from the table phases on).
export const TURN_SECONDS = 15;
export const RESULTS_SECONDS = 5;
export const HEARTBEAT_SECONDS = 20;
export const SEAT_TIMEOUT_SECONDS = 60;

export const CASINO_LEDGER_TYPES = ['casino_bet', 'casino_payout', 'casino_refund'];

// The lobby. `opensIn` is the build phase that opens a table; null = open now.
export const CASINO_GAMES = [
  { id: 'slots', name: '7s Slots', kind: 'slots', blurb: 'Three reels, one payline, Red 7s pay 300×.', opensIn: null },
  { id: 'blackjack', name: 'Blackjack', kind: 'table', blurb: '6 decks · dealer hits soft 17 · blackjack pays 3:2', opensIn: 3 },
  { id: 'baccarat', name: 'Baccarat', kind: 'table', blurb: 'Player · Banker · Tie · 8 decks', opensIn: 2 },
  { id: 'craps', name: 'Craps', kind: 'table', blurb: 'Pass · Don’t Pass · Odds · Place · Field', opensIn: 4 },
  { id: 'crapless', name: 'Crapless Craps', kind: 'table', blurb: 'Every number but 7 is a point', opensIn: 4 },
];

export function casinoGame(id) {
  return CASINO_GAMES.find((g) => g.id === id) ?? null;
}

// Whole dollars from $1 to $10.
export function isValidCasinoBet(dollars) {
  return Number.isInteger(dollars) && dollars >= CASINO_MIN_BET_DOLLARS && dollars <= CASINO_MAX_BET_DOLLARS;
}

// Winnings rounded to the nearest cent (stake × num / den), e.g. $5 at 7:6 → 583.
export function winningsCents(stakeCents, num, den) {
  return Math.round((stakeCents * num) / den);
}
