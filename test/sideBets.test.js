// npm test: side bets (0.24.0). Every paytable row from a fixed shoe through the real playCoup / the real cards; the house
// edges computed exactly (every coup / every three-card draw) against the published figures; and a seeded 1,000,000-round
// simulation of each bet against the exact edge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playCoup } from '../shared/casino/baccarat.js';
import {
  BACCARAT_SIDE_SPOTS,
  baccaratSideOutcome,
  baccaratSideReturnCents,
  isStraight,
  twentyOne3Hand,
  twentyOne3ReturnCents,
} from '../shared/casino/sideBets.js';
import { exactBaccaratSideEdges, exactTwentyOne3Edge, simulateBaccaratSides, simulateTwentyOne3 } from './sideBetMath.js';

// A coup dealt from a fixed shoe, in dealing order: Player, Banker, Player, Banker, Player's third, Banker's third.
const coupFrom = (ranks) => {
  const cards = ranks.map((r, i) => `${r}${'SHDC'[i % 4]}${i % 8}`);
  let k = 0;
  return playCoup(() => cards[k++]);
};
const pays = (spot, coup) => {
  const o = baccaratSideOutcome(spot, coup);
  return o ? (o.push ? 'push' : o.pays) : 'lose';
};

test('21+3: every hand, Ace low or high but never wrapping, best hand counts', () => {
  const cases = [
    [['7H0', '7H3', '7H5'], 'suitedTrips', 101],
    [['9S0', 'TS1', 'JS2'], 'straightFlush', 41],
    [['AD0', '2D1', '3D2'], 'straightFlush', 41],
    [['QC0', 'KC1', 'AC2'], 'straightFlush', 41],
    [['7H0', '7S1', '7H2'], 'trips', 31],
    [['AD0', '2S1', '3H2'], 'straight', 11],
    [['QD0', 'KS1', 'AH2'], 'straight', 11],
    [['4D0', '5S1', '6H2'], 'straight', 11],
    [['KD0', 'AS1', '2H2'], null, 0], // K-A-2 is not a straight
    [['KD0', 'AD1', '2D2'], 'flush', 6], // ... so suited it's only a flush
    [['2C0', '9C1', 'KC2'], 'flush', 6],
    [['2C0', '2S1', '9H2'], null, 0], // a pair pays nothing
    [['2C0', '9D1', 'KH2'], null, 0],
  ];
  for (const [cards, hand, perDollar] of cases) {
    assert.equal(twentyOne3Hand(cards), hand, cards.join(' '));
    assert.equal(twentyOne3ReturnCents(500, cards), perDollar * 500, `${cards.join(' ')} returns`);
  }
  assert.equal(isStraight(['JS0', 'QS0', 'KS0']), true);
  assert.equal(twentyOne3ReturnCents(0, ['7H0', '7H3', '7H5']), 0);
});

test('Baccarat side bets: every paytable row from a fixed shoe', () => {
  const rows = [
    // [shoe, expected { spot: pays | 'push' | 'lose' }]
    [['9', '5', 'K', '2'], { dragonPlayer: 1, dragonBanker: 'lose' }], // Player natural 9 beats 7
    [['8', '8', 'K', 'Q'], { dragonPlayer: 'push', dragonBanker: 'push' }], // natural tie
    [['K', 'K', 'Q', 'J', '9', 'K'], { dragonPlayer: 30, heavenly9: 10, golden8: 'lose' }], // 9 v 0, non-natural, by 9
    [['K', 'A', 'Q', 'K', '9', 'K'], { dragonPlayer: 10 }], // 9 v 1: by 8
    [['K', '2', 'Q', 'K', '9', '7'], { dragonPlayer: 'lose' }], // 9 v 9 (3 cards each)? no: banker 2+7 = 9, tie
    [['K', '2', 'Q', '3', '9'], { dragonPlayer: 1 }], // 9 v 5 (banker stands on 5 against a 9): by 4
    [['K', '3', 'Q', '3', '9'], { dragonPlayer: 'lose' }], // 9 v 6: by 3 loses
    [['K', '2', 'Q', 'K', '5', '5'], { fortune7: 40, dragonBanker: 'lose' }], // Banker 3-card 7 beats 5 (by 2)
    [['K', 'K', 'Q', 'J', '8', '2'], { golden8: 25, dragonPlayer: 4 }], // Player 3-card 8 v 2: by 6
    [['K', 'K', 'Q', 'J', '9', '9'], { heavenly9: 75, dragonPlayer: 'lose', dragonBanker: 'lose' }], // both 3-card 9: tie
    [['K', 'K', 'Q', 'J', '7', '7'], { blazing7: 200 }], // both 3-card 7
    [['3', '2', '4', '5'], { blazing7: 40, dragonPlayer: 'lose', dragonBanker: 'lose' }], // both 2-card 7 (non-natural tie)
    [['3', 'K', '4', 'J', '7'], { blazing7: 'lose' }], // 7 (two cards) v 7 (three cards)
    [['K', '2', 'Q', 'K', '5', '6'], { fortune7: 'lose', dragonBanker: 'lose' }], // Banker 3-card 8 v 5: not a 7; by 3
    [['K', 'K', 'Q', 'J', '8', '9'], { golden8: 'lose', dragonBanker: 'lose', heavenly9: 10 }], // Player 3-card 8 loses to Banker 3-card 9: by 1 (Dragon needs 4+)
  ];
  // Row 5 is a tie, not a Dragon payout: check the coup itself so the fixture can't drift.
  assert.equal(coupFrom(['K', '2', 'Q', 'K', '9', '7']).winner, 'tie');
  for (const [shoe, expected] of rows) {
    const coup = coupFrom(shoe);
    for (const [spot, want] of Object.entries(expected)) {
      assert.equal(pays(spot, coup), want, `${shoe.join(',')} ${spot} (P ${coup.playerTotal}/${coup.player.length}, B ${coup.bankerTotal}/${coup.banker.length})`);
    }
  }
  // Returns in cents: stake back plus winnings; a push gives the stake back; a loss 0.
  assert.equal(baccaratSideReturnCents('dragonPlayer', 700, coupFrom(['K', 'K', 'Q', 'J', '9', 'K'])), 700 * 31);
  assert.equal(baccaratSideReturnCents('dragonBanker', 700, coupFrom(['8', '8', 'K', 'Q'])), 700);
  assert.equal(baccaratSideReturnCents('blazing7', 300, coupFrom(['K', 'K', 'Q', 'J', '7', '7'])), 300 * 201);
  assert.equal(baccaratSideReturnCents('fortune7', 300, coupFrom(['9', '5', 'K', '2'])), 0);
});

test('house edges, exact: every coup from 8 and 6 decks; every 21+3 draw — against the published figures', () => {
  const near = (got, want, what) => assert.ok(Math.abs(got - want) < 0.01, `${what}: ${got.toFixed(3)}% vs ${want}%`);
  const e8 = exactBaccaratSideEdges(8);
  // Main game first: the textbook 8-deck probabilities, so the enumeration itself is right.
  near(100 * e8.main.banker, 45.86, 'Banker wins');
  near(100 * e8.main.player, 44.62, 'Player wins');
  near(100 * e8.main.tie, 9.52, 'Tie');
  // Wizard of Odds, Baccarat side bets appendix (8 decks).
  near(e8.edge.dragonPlayer, 2.65, 'Dragon Bonus Player');
  near(e8.edge.dragonBanker, 9.37, 'Dragon Bonus Banker');
  // Nevada GCB, Commission Free 5 Treasures Baccarat V2 (8 and 6 decks).
  near(e8.edge.fortune7, 7.61, 'Fortune 7, 8 decks');
  near(e8.edge.golden8, 10.19, 'Golden 8, 8 decks');
  near(e8.edge.heavenly9, 9.31, 'Heavenly 9, 8 decks');
  near(e8.edge.blazing7, 16.75, 'Blazing 7s, 8 decks');
  const e6 = exactBaccaratSideEdges(6);
  near(e6.edge.fortune7, 7.61, 'Fortune 7, 6 decks');
  near(e6.edge.golden8, 10.21, 'Golden 8, 6 decks');
  near(e6.edge.heavenly9, 9.30, 'Heavenly 9, 6 decks');
  near(e6.edge.blazing7, 16.75, 'Blazing 7s, 6 decks');
  // Wizard of Odds, 21+3 Version 7: 6.39% (4 decks), 3.70% (8 decks). Our shoe is 6 decks: 4.62%.
  near(exactTwentyOne3Edge(4).edge, 6.39, '21+3, 4 decks');
  near(exactTwentyOne3Edge(8).edge, 3.70, '21+3, 8 decks');
  near(exactTwentyOne3Edge(6).edge, 4.62, '21+3, 6 decks');
});

// 1,000,000 rounds from a seeded shoe. The spec asks for ±0.3 points; for long-shot bets one million rounds can't resolve
// that (Blazing 7s' standard error is about 1 point), so each bet must land within ±0.3 points or 3 standard errors of the
// exact edge, whichever is wider. The exact test above is the precise check.
test('house edges, simulated: 1,000,000 rounds per game land on the exact edges', () => {
  const exact = exactBaccaratSideEdges(8).edge;
  const sim = simulateBaccaratSides(1_000_000, 2026);
  for (const spot of BACCARAT_SIDE_SPOTS) {
    const tol = Math.max(0.3, 3 * sim[spot].se);
    assert.ok(Math.abs(sim[spot].edge - exact[spot]) <= tol, `${spot}: simulated ${sim[spot].edge.toFixed(2)}% vs exact ${exact[spot].toFixed(2)}% (±${tol.toFixed(2)})`);
  }
  const s213 = simulateTwentyOne3(1_000_000, 2026);
  const tol = Math.max(0.3, 3 * s213.se);
  assert.ok(Math.abs(s213.edge - exactTwentyOne3Edge(6).edge) <= tol, `21+3: simulated ${s213.edge.toFixed(2)}%`);
});
