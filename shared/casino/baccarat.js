// Baccarat (punto banco) rules, shared by the server (dealing, settling) and the phone (totals, labels).
// Pure functions: no Firestore, no clock, and cards come from whatever `draw` function is passed in.

import { cardRank } from './cards.js';
import { winningsCents } from './constants.js';

export const BACCARAT_DECKS = 8;
export const BACCARAT_SHOE_CARDS = 52 * BACCARAT_DECKS; // 416
export const BACCARAT_RESHUFFLE_AT = 354; // reshuffle before a round once 85% of the shoe is dealt
export const BACCARAT_MAX_SHOE_RESULTS = 200; // a shoe is ~80 hands; this is only a safety cap

export const BACCARAT_SPOTS = ['player', 'banker', 'tie'];

// Winnings per spot, as num:den. Banker pays 0.95:1 (a 5% commission); Tie pays 8:1.
export const BACCARAT_ODDS = {
  player: { num: 1, den: 1, label: '1:1' },
  banker: { num: 19, den: 20, label: '0.95:1' },
  tie: { num: 8, den: 1, label: '8:1' },
};

export const SPOT_LABELS = { player: 'Player', banker: 'Banker', tie: 'Tie' };

// A = 1, 2–9 face value, 10/J/Q/K = 0.
export function baccaratValue(card) {
  const rank = cardRank(card);
  if (rank === 'A') return 1;
  if (rank === 'T' || rank === 'J' || rank === 'Q' || rank === 'K') return 0;
  return Number(rank);
}

// A hand's total is the last digit of its card values.
export function handTotal(cards) {
  return cards.reduce((sum, card) => sum + baccaratValue(card), 0) % 10;
}

// The Player draws a third card on 0–5 and stands on 6–7 (8–9 are naturals, checked first).
export function playerDraws(playerTotal) {
  return playerTotal <= 5;
}

// The Banker's tableau. playerThirdValue is the value (0–9) of the Player's third card,
// or null when the Player stood on two cards.
export function bankerDraws(bankerTotal, playerThirdValue) {
  if (playerThirdValue === null || playerThirdValue === undefined) return bankerTotal <= 5;
  const p = playerThirdValue;
  switch (bankerTotal) {
    case 0:
    case 1:
    case 2:
      return true;
    case 3:
      return p !== 8;
    case 4:
      return p >= 2 && p <= 7;
    case 5:
      return p >= 4 && p <= 7;
    case 6:
      return p === 6 || p === 7;
    default:
      return false; // 7 stands (8 and 9 never reach here)
  }
}

// Deals one coup. draw() returns the next card. Order: Player, Banker, Player, Banker,
// then the Player's third card (if any), then the Banker's third card (if any).
export function playCoup(draw) {
  const player = [draw()];
  const banker = [draw()];
  player.push(draw());
  banker.push(draw());

  const playerTwo = handTotal(player);
  const bankerTwo = handTotal(banker);
  const natural = playerTwo >= 8 || bankerTwo >= 8;

  if (!natural) {
    let playerThirdValue = null;
    if (playerDraws(playerTwo)) {
      const third = draw();
      player.push(third);
      playerThirdValue = baccaratValue(third);
    }
    if (bankerDraws(bankerTwo, playerThirdValue)) banker.push(draw());
  }

  const playerTotal = handTotal(player);
  const bankerTotal = handTotal(banker);
  const winner = playerTotal > bankerTotal ? 'player' : bankerTotal > playerTotal ? 'banker' : 'tie';
  return { player, banker, playerTotal, bankerTotal, winner, natural };
}

// The cards in the order they were dealt (how the phone turns them over).
export function revealOrder(player = [], banker = []) {
  const order = [];
  if (player[0]) order.push({ hand: 'player', index: 0 });
  if (banker[0]) order.push({ hand: 'banker', index: 0 });
  if (player[1]) order.push({ hand: 'player', index: 1 });
  if (banker[1]) order.push({ hand: 'banker', index: 1 });
  if (player[2]) order.push({ hand: 'player', index: 2 });
  if (banker[2]) order.push({ hand: 'banker', index: 2 });
  return order;
}

// What one spot returns to the player (stake + winnings), in cents. A Tie pushes Player and Banker bets.
export function spotReturnCents(spot, stakeCents, winner) {
  if (!stakeCents) return 0;
  if (spot === 'tie') return winner === 'tie' ? stakeCents + winningsCents(stakeCents, 8, 1) : 0;
  if (winner === 'tie') return stakeCents; // push
  if (spot !== winner) return 0;
  const odds = BACCARAT_ODDS[spot];
  return stakeCents + winningsCents(stakeCents, odds.num, odds.den);
}

// bets: { player, banker, tie } in cents. Returns { stakeCents, returnCents, netCents }.
export function settleBaccaratBets(bets, winner) {
  let stakeCents = 0;
  let returnCents = 0;
  for (const spot of BACCARAT_SPOTS) {
    const stake = Number(bets?.[spot]) || 0;
    stakeCents += stake;
    returnCents += spotReturnCents(spot, stake, winner);
  }
  return { stakeCents, returnCents, netCents: returnCents - stakeCents };
}

export function totalBetCents(bets) {
  return BACCARAT_SPOTS.reduce((sum, spot) => sum + (Number(bets?.[spot]) || 0), 0);
}

export function emptyBets() {
  return { player: 0, banker: 0, tie: 0 };
}

// When each card of a coup turns over, in ms from the deal (in revealOrder): the four opening cards
// 0.5 s apart, then 1 s before each third card. Every phone uses the server's deal time.
export const BACCARAT_OPENING_GAP_MS = 500;
export const BACCARAT_THIRD_CARD_GAP_MS = 1000;
export const BACCARAT_SETTLE_MS = 700;

export function coupRevealTimes(player = [], banker = []) {
  const order = revealOrder(player, banker);
  const times = [];
  order.forEach((card, k) => {
    if (k === 0) times.push(0);
    else times.push(times[k - 1] + (card.index < 2 ? BACCARAT_OPENING_GAP_MS : BACCARAT_THIRD_CARD_GAP_MS));
  });
  return times;
}

// How long the phones take to show the whole coup (Results stay up 5 s after this).
export function coupRevealMs(player = [], banker = []) {
  const times = coupRevealTimes(player, banker);
  return times.length ? times[times.length - 1] + BACCARAT_SETTLE_MS : 0;
}
