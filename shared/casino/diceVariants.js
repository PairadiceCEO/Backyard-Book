// Craps and Crapless Craps differ only in this table. shared/casino/dice.js contains no number specific
// to either game: every rule it applies comes from here, so a rule can only differ between the two
// games by changing this file. Odds and payouts are [winnings, stake] (e.g. [7, 6] = 7:6).

const FIELD = {
  2: [2, 1],
  3: [1, 1],
  4: [1, 1],
  9: [1, 1],
  10: [1, 1],
  11: [1, 1],
  12: [2, 1],
};

export const DICE_VARIANTS = {
  craps: {
    id: 'craps',
    name: 'Craps',
    seven: 7,
    lineOdds: [1, 1], // Pass and Don't Pass pay even money
    oddsMultiple: 2, // Odds behind Pass up to 2× the Pass bet
    comeOutPassWins: [7, 11],
    comeOutPassLoses: [2, 3, 12],
    dontPass: { comeOutWins: [2, 3], comeOutPushes: [12] },
    points: [4, 5, 6, 8, 9, 10],
    odds: { 4: [2, 1], 10: [2, 1], 5: [3, 2], 9: [3, 2], 6: [6, 5], 8: [6, 5] },
    place: { 4: [9, 5], 10: [9, 5], 5: [7, 5], 9: [7, 5], 6: [7, 6], 8: [7, 6] },
    field: FIELD,
  },
  crapless: {
    id: 'crapless',
    name: 'Crapless Craps',
    seven: 7,
    lineOdds: [1, 1],
    oddsMultiple: 2,
    comeOutPassWins: [7],
    comeOutPassLoses: [],
    dontPass: null, // not offered
    points: [2, 3, 4, 5, 6, 8, 9, 10, 11, 12],
    odds: { 2: [5, 1], 12: [5, 1], 3: [3, 1], 11: [3, 1], 4: [2, 1], 10: [2, 1], 5: [3, 2], 9: [3, 2], 6: [6, 5], 8: [6, 5] },
    place: { 2: [9, 2], 12: [9, 2], 3: [11, 4], 11: [11, 4], 4: [9, 5], 10: [9, 5], 5: [7, 5], 9: [7, 5], 6: [7, 6], 8: [7, 6] },
    field: FIELD,
  },
};

export function diceVariant(id) {
  return DICE_VARIANTS[id] ?? null;
}
