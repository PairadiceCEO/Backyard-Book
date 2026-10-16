// Bet slip rules shared by the browser (to guide the user) and /api/bets (to enforce them).

import { REQUEST_ID_PATTERN } from './constants.js';
import { decimalToAmerican } from './oddsMath.js';

export const MIN_STAKE_CENTS = 100; // $1.00
export const MAX_LEGS = 10;
export const MIN_PARLAY_LEGS = 2;
export const MARKET_TYPES = ['moneyline', 'spread', 'total'];

const SELECTIONS = {
  moneyline: ['home', 'away'],
  spread: ['home', 'away'],
  total: ['over', 'under'],
};

export function isValidSelection(marketType, selection) {
  return Array.isArray(SELECTIONS[marketType]) && SELECTIONS[marketType].includes(selection);
}

// One leg per game + market type: blocks both moneylines, both spread sides, over + under.
export function conflictKey(leg) {
  return `${leg.gameId}|${leg.marketType}`;
}

export function makeLegId({ league, gameId, marketType, selection }) {
  return `${league}:${gameId}:${marketType}:${selection}`;
}

export function combinedDecimal(decimals) {
  return decimals.reduce((acc, d) => acc * d, 1);
}

// Payout includes the stake; rounded down to the cent.
export function payoutCents(stakeCents, decimal) {
  return Math.floor(stakeCents * decimal + 1e-9);
}

export function combinedAmerican(decimals) {
  return decimalToAmerican(combinedDecimal(decimals));
}

// Returns a list of human-readable problems ([] when the slip is valid).
// slip: { mode: 'singles' | 'parlay', legs: [{ gameId, marketType, selection, stakeCents? }], stakeCents? }
export function slipProblems(slip, { balanceCents = Infinity } = {}) {
  const problems = [];
  const legs = Array.isArray(slip?.legs) ? slip.legs : [];

  if (slip?.mode !== 'singles' && slip?.mode !== 'parlay') problems.push('Choose singles or a parlay.');
  if (legs.length === 0) problems.push('Add at least one pick.');
  if (legs.length > MAX_LEGS) problems.push(`A slip can hold at most ${MAX_LEGS} picks.`);
  if (slip?.mode === 'parlay' && legs.length > 0 && legs.length < MIN_PARLAY_LEGS) {
    problems.push(`A parlay needs at least ${MIN_PARLAY_LEGS} picks.`);
  }

  const seen = new Set();
  for (const leg of legs) {
    if (!MARKET_TYPES.includes(leg.marketType) || !isValidSelection(leg.marketType, leg.selection)) {
      problems.push('One of the picks is not a valid market.');
      break;
    }
    const key = conflictKey(leg);
    if (seen.has(key)) {
      problems.push('Only one pick per game and market type is allowed.');
      break;
    }
    seen.add(key);
  }

  let total = 0;
  if (slip?.mode === 'singles') {
    for (const leg of legs) {
      if (!Number.isInteger(leg.stakeCents) || leg.stakeCents < MIN_STAKE_CENTS) {
        problems.push('Every single needs a stake of at least $1.00.');
        break;
      }
    }
    total = legs.reduce((sum, leg) => sum + (Number.isInteger(leg.stakeCents) ? leg.stakeCents : 0), 0);
  } else if (slip?.mode === 'parlay') {
    if (!Number.isInteger(slip.stakeCents) || slip.stakeCents < MIN_STAKE_CENTS) {
      problems.push('The parlay needs a stake of at least $1.00.');
    }
    total = Number.isInteger(slip.stakeCents) ? slip.stakeCents : 0;
  }

  if (total > balanceCents) problems.push('Total stake is more than your wallet balance.');
  return problems;
}

export function totalStakeCents(slip) {
  if (slip?.mode === 'parlay') return Number.isInteger(slip.stakeCents) ? slip.stakeCents : 0;
  return (slip?.legs ?? []).reduce((sum, leg) => sum + (Number.isInteger(leg.stakeCents) ? leg.stakeCents : 0), 0);
}

export function isValidRequestId(id) {
  return typeof id === 'string' && REQUEST_ID_PATTERN.test(id);
}

// "+2.5", "-2.5", "PK"
export function formatSignedLine(line) {
  if (!Number.isFinite(line)) return '';
  if (line === 0) return 'PK';
  return line > 0 ? `+${line}` : String(line);
}

// Human label for a pick, e.g. "Jaguars -2.5", "Over 42.5", "Texans moneyline".
export function pickLabel({ marketType, selection, line, homeName, awayName }) {
  if (marketType === 'total') return `${selection === 'over' ? 'Over' : 'Under'} ${line}`;
  const team = selection === 'home' ? homeName : awayName;
  if (marketType === 'spread') return `${team} ${formatSignedLine(line)}`;
  return `${team} moneyline`;
}
