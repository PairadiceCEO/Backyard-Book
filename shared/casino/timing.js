// Every casino timing value in one place: card dealing speed, table timers, dice. Change a number here
// and both the server (deadlines) and the phones (animations) follow, because both import this file.
//
// Cards are timed from the server's timestamp of the write that dealt them, so every phone turns the
// same card over at the same moment, and a phone that opens the table mid-deal shows the cards already
// dealt. Decision clocks (insurance, turns) and the results pause start only after the last card of
// that write has turned over and settled, so the longer deal never eats into anyone's time.

// ---------- Blackjack ----------
// Opening deal, one card at a time: seat 1, 2, 3, 4, 5 (seats without a bet are skipped and add no
// delay), dealer; then the second card in the same order (the dealer's face down).
export const BLACKJACK_INITIAL_GAP_MS = 1000; // between each opening card
// Every card after the opening deal: hits, doubles, split cards, the hole-card reveal, dealer draws.
export const BLACKJACK_LATER_GAP_MS = 1500;
// After the last card of a write turns over, before a decision clock or the results pause starts.
export const BLACKJACK_SETTLE_MS = 700;

// ---------- Baccarat ----------
// Opening deal, one card at a time: Player, Banker, Player, Banker.
export const BACCARAT_OPENING_GAP_MS = 1000;
// Before each third card (Player's, then Banker's).
export const BACCARAT_THIRD_CARD_GAP_MS = 1500;
// After the last card turns over, before the results pause starts.
export const BACCARAT_SETTLE_MS = 700;

// ---------- Table timers ----------
export const TURN_SECONDS = 15; // betting closes this long after the first bet; insurance and turn clocks
export const RESULTS_MS = 2500; // results stay up this long (after the last card turns over); 0.17.2: was 5 s
export const TICK_JITTER_MS = 800; // phones wait 0–800 ms after a deadline before asking the server to move on

// ---------- Dice ----------
export const DICE_ANIMATION_MS = 1000; // phones tumble the dice this long; the point-phase clock starts after it
// Craps and Crapless shooter clocks (come-out after the first bet, point-phase auto-roll, after the dice pass).
// Only with 2 or more players at the table; a player alone has no clock and rolls when they tap Roll.
export const CRAPS_TURN_SECONDS = 30;
