// Side bets (0.24.0), shared by the server (settling) and the phone (labels, the result on each spot, the rules sheet).
// Pure functions: no Firestore, no clock. Amounts in cents; payouts round down to the cent (every payout here is a whole
// number of times a whole-dollar stake, so in practice nothing rounds).
//
// Sources (checked 2026-10-28):
//   21+3 (Blackjack): the paytable Will specified (suited three of a kind 100, straight flush 40, three of a kind 30,
//     straight 10, flush 5). Wizard of Odds lists it as "21+3 Version 7" (wizardofodds.com/games/blackjack/side-bets/21plus3/):
//     house edge 6.39% with 4 decks and 3.70% with 8. Our exact calculation (test/sideBets.test.js) gives the same two
//     numbers, and 4.62% for our 6-deck shoe.
//   Dragon Bonus and Fortune 7 (Baccarat): the paytables Will specified; Wizard of Odds' Baccarat side bets appendix
//     (wizardofodds.com/games/baccarat/appendix/5/) has the same tables: Dragon Bonus house edge 2.65% (Player) and 9.37%
//     (Banker), Fortune 7 (= Dragon 7) 7.61%, all 8 decks.
//   Heavenly 9, Golden 8, Blazing 7s (Baccarat): Nevada Gaming Control Board, approved rules of play "Commission Free
//     5 Treasures Baccarat – Version 2" (gaming.nv.gov, Enforcement → Rules of Play), which also publishes their house
//     edges for 8 decks: Golden 8 10.19%, Heavenly 9 9.31%, Blazing 7s 16.75% (Fortune 7 7.61%). New Jersey's
//     N.J.A.C. 13:69F-3.3(m) (5 Treasures bonus wagers, allowed on regular punto banco) has the same Fortune 7 / Golden 8 /
//     Heavenly 9 payouts; its Blazing 7's tables differ (Paytable 1: 3-card 400; Paytable 2: 3-card 200, 2-card 50).
//     We use Nevada's because it publishes the house edge we can check against. Only the side bets come from that game:
//     our main Banker bet still pays 0.95:1 (no 3-card-7 push).

import { cardRank, cardSuit } from './cards.js';

// ---------- Blackjack: 21+3 (the player's first two cards + the dealer's up card) ----------

export const TWENTY_ONE_3 = 'side213';
export const TWENTY_ONE_3_NAME = '21+3';

// Winnings per $1, best hand first.
export const TWENTY_ONE_3_PAYS = [
  { hand: 'suitedTrips', label: 'Suited three of a kind', pays: 100 },
  { hand: 'straightFlush', label: 'Straight flush', pays: 40 },
  { hand: 'trips', label: 'Three of a kind', pays: 30 },
  { hand: 'straight', label: 'Straight', pays: 10 },
  { hand: 'flush', label: 'Flush', pays: 5 },
];

const RANK_ORDER = { A: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13 };

// Three ranks in a row. Ace is low (A-2-3) or high (Q-K-A); it never wraps (K-A-2 is not a straight).
export function isStraight(cards) {
  const r = cards.map((c) => RANK_ORDER[cardRank(c)]).sort((a, b) => a - b);
  if (new Set(r).size !== 3) return false;
  if (r[2] - r[0] === 2) return true;
  return r[0] === 1 && r[1] === 12 && r[2] === 13; // Q-K-A
}

// The best 21+3 hand three cards make ('suitedTrips', 'straightFlush', 'trips', 'straight', 'flush'), or null.
export function twentyOne3Hand(cards) {
  if (!Array.isArray(cards) || cards.length !== 3) return null;
  const sameRank = cards.every((c) => cardRank(c) === cardRank(cards[0]));
  const sameSuit = cards.every((c) => cardSuit(c) === cardSuit(cards[0]));
  const straight = isStraight(cards);
  if (sameRank && sameSuit) return 'suitedTrips';
  if (straight && sameSuit) return 'straightFlush';
  if (sameRank) return 'trips';
  if (straight) return 'straight';
  if (sameSuit) return 'flush';
  return null;
}

export function twentyOne3Label(hand) {
  return TWENTY_ONE_3_PAYS.find((row) => row.hand === hand)?.label ?? 'No hand';
}

// What a 21+3 bet returns (stake + winnings), in cents: 0 when it loses.
export function twentyOne3ReturnCents(stakeCents, cards) {
  if (!(stakeCents > 0)) return 0;
  const hand = twentyOne3Hand(cards);
  const row = TWENTY_ONE_3_PAYS.find((r) => r.hand === hand);
  return row ? stakeCents + Math.floor(stakeCents * row.pays) : 0;
}

// ---------- Baccarat ----------

export const BACCARAT_SIDE_SPOTS = ['dragonPlayer', 'dragonBanker', 'fortune7', 'heavenly9', 'golden8', 'blazing7'];

export const BACCARAT_SIDE_NAMES = {
  dragonPlayer: 'Dragon Bonus Player',
  dragonBanker: 'Dragon Bonus Banker',
  fortune7: 'Fortune 7',
  heavenly9: 'Heavenly 9',
  golden8: 'Golden 8',
  blazing7: 'Blazing 7s',
};

// What's printed on the felt (two short lines).
export const BACCARAT_SIDE_PRINT = {
  dragonPlayer: ['Dragon', 'Player'],
  dragonBanker: ['Dragon', 'Banker'],
  fortune7: ['Fortune', '7'],
  heavenly9: ['Heavenly', '9'],
  golden8: ['Golden', '8'],
  blazing7: ['Blazing', '7s'],
};

// Dragon Bonus: a non-natural win by this many points pays this much (winnings per $1).
export const DRAGON_MARGIN_PAYS = { 9: 30, 8: 10, 7: 6, 6: 4, 5: 2, 4: 1 };

// The paytables as rows for the rules sheet: [what happens, pays].
export const BACCARAT_SIDE_PAYTABLES = {
  dragon: [
    ['Your side wins with a natural', '1 to 1'],
    ['Natural tie', 'push'],
    ['Non-natural win by 9', '30 to 1'],
    ['Non-natural win by 8', '10 to 1'],
    ['Non-natural win by 7', '6 to 1'],
    ['Non-natural win by 6', '4 to 1'],
    ['Non-natural win by 5', '2 to 1'],
    ['Non-natural win by 4', '1 to 1'],
    ['Anything else', 'loses'],
  ],
  fortune7: [['Banker wins with a three-card 7', '40 to 1']],
  golden8: [['Player wins with a three-card 8', '25 to 1']],
  heavenly9: [
    ['Player and Banker both end on a three-card 9', '75 to 1'],
    ['Player or Banker ends on a three-card 9', '10 to 1'],
  ],
  blazing7: [
    ['Player and Banker both end on a three-card 7', '200 to 1'],
    ['Player and Banker both end on a two-card 7', '40 to 1'],
  ],
};

// One side bet's outcome for a coup ({ player, banker, playerTotal, bankerTotal, winner, natural }):
// { pays: n } winnings n per $1, { push: true }, or null (loses).
export function baccaratSideOutcome(spot, coup) {
  if (!coup) return null;
  const p3 = coup.player.length === 3;
  const b3 = coup.banker.length === 3;
  const { playerTotal: pt, bankerTotal: bt, winner } = coup;
  switch (spot) {
    case 'dragonPlayer':
    case 'dragonBanker': {
      const side = spot === 'dragonPlayer' ? 'player' : 'banker';
      if (coup.natural) {
        if (winner === side) return { pays: 1 };
        if (winner === 'tie') return { push: true };
        return null;
      }
      if (winner !== side) return null;
      const pays = DRAGON_MARGIN_PAYS[Math.abs(pt - bt)];
      return pays ? { pays } : null;
    }
    case 'fortune7':
      return winner === 'banker' && b3 && bt === 7 ? { pays: 40 } : null;
    case 'golden8':
      return winner === 'player' && p3 && pt === 8 ? { pays: 25 } : null;
    case 'heavenly9': {
      const p9 = p3 && pt === 9;
      const b9 = b3 && bt === 9;
      if (p9 && b9) return { pays: 75 };
      return p9 || b9 ? { pays: 10 } : null;
    }
    case 'blazing7':
      if (pt !== 7 || bt !== 7) return null;
      if (p3 && b3) return { pays: 200 };
      if (!p3 && !b3) return { pays: 40 };
      return null;
    default:
      return null;
  }
}

// What a side bet returns (stake + winnings, the stake on a push), in cents: 0 when it loses.
export function baccaratSideReturnCents(spot, stakeCents, coup) {
  if (!(stakeCents > 0)) return 0;
  const outcome = baccaratSideOutcome(spot, coup);
  if (!outcome) return 0;
  if (outcome.push) return stakeCents;
  return stakeCents + Math.floor(stakeCents * outcome.pays);
}

// Shown on a spot at results time: "Win 30 to 1", "Push", "Lose".
export function sideOutcomeText(returnCents, stakeCents) {
  if (returnCents > stakeCents) return `Win ${Math.round((returnCents - stakeCents) / stakeCents)} to 1`;
  if (returnCents === stakeCents && stakeCents > 0) return 'Push';
  return 'Lose';
}

export const SIDE_BET_NEEDS_MAIN = 'A side bet needs a main bet on this seat first.';
export const SIDE_BET_KEEPS_MAIN = 'Take the side bets down before the main bet (a side bet needs a main bet).';
