// Casino values shared by the browser and /api/casino.

export const CASINO_MIN_BET_DOLLARS = 1;
export const CASINO_MAX_BET_DOLLARS = 10;
export const CASINO_SEATS = 5;

// Table timers. Deadlines are server milliseconds; phones count down against the server's clock.
export const TURN_SECONDS = 15; // betting closes this long after the first bet; turn timers
export const RESULTS_SECONDS = 5; // results stay up this long (after the last card turns over)
export const HEARTBEAT_SECONDS = 20; // a seated phone says "still here" this often while visible
export const PRESENCE_WRITE_SECONDS = 30; // the server writes presence at most this often per player
export const SEAT_TIMEOUT_SECONDS = 60; // no heartbeat for this long → the seat frees at round end
export const TICK_JITTER_MS = 800; // phones wait 0–800 ms after zero before sending tick
export const DICE_ANIMATION_MS = 1400; // phones tumble the dice this long; the point-phase clock starts after it

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

// Whole dollars from $1 to $10.
export function isValidCasinoBet(dollars) {
  return Number.isInteger(dollars) && dollars >= CASINO_MIN_BET_DOLLARS && dollars <= CASINO_MAX_BET_DOLLARS;
}

// Winnings rounded to the nearest cent (stake × num / den), e.g. $5 at 7:6 → 583.
export function winningsCents(stakeCents, num, den) {
  return Math.round((stakeCents * num) / den);
}
