// Bet slip rules shared by the browser (to guide the user) and /api/bets (to enforce them).

import { REQUEST_ID_PATTERN } from './constants.js';
import { decimalToAmerican } from './oddsMath.js';
import { cryptoPickLabel } from './crypto/coins.js';

export const MIN_STAKE_CENTS = 100; // $1.00
export const MAX_LEGS = 10;
export const MIN_PARLAY_LEGS = 2;
// 'challenge' = a player-posted Challenge (selection = one of its outcome ids, no line).
// 'crypto' = a Kalshi crypto market (selection yes = Up / above, no = Down / below; line = its strike).
export const MARKET_TYPES = ['moneyline', 'spread', 'total', 'challenge', 'crypto'];

const SELECTIONS = {
  moneyline: ['home', 'away'],
  spread: ['home', 'away'],
  total: ['over', 'under'],
  challenge: ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'],
  crypto: ['yes', 'no'],
};

// Spread, total and crypto picks carry a line (a crypto line is the market's strike, so another strike is a
// different bet); moneyline and Challenge picks don't.
export function marketHasLine(marketType) {
  return marketType === 'spread' || marketType === 'total' || marketType === 'crypto';
}

export const CRYPTO_PARLAY_MESSAGE = "Crypto picks are singles only: they can't go in a parlay.";

export function isValidSelection(marketType, selection) {
  return Array.isArray(SELECTIONS[marketType]) && SELECTIONS[marketType].includes(selection);
}

// One leg per game + market type: blocks both moneylines, both spread sides, over + under, and two
// outcomes of the same Challenge.
export function conflictKey(leg) {
  return `${leg.gameId}|${leg.marketType}`;
}

// Unique id for one priced pick. Spread/total ids include the line and source, so the main line and
// each alternate line (or the same number from a different source) are separate picks.
export function makeLegId({ league, gameId, marketType, selection, line = null, source = '' }) {
  const base = `${league}:${gameId}:${marketType}:${selection}`;
  if (!marketHasLine(marketType)) return source ? `${base}:${source}` : base;
  return `${base}:${line}${source ? `:${source}` : ''}`;
}

export const PARLAY_ML_SPREAD_MESSAGE = "A parlay can't include a moneyline and a spread from the same game.";

// Parlay-only rule: no moneyline + spread from the same game (either team). ML + total and spread + total are fine.
export function hasMoneylineSpreadConflict(legs) {
  const byGame = new Map();
  for (const leg of legs) {
    const types = byGame.get(leg.gameId) ?? new Set();
    types.add(leg.marketType);
    byGame.set(leg.gameId, types);
  }
  return [...byGame.values()].some((types) => types.has('moneyline') && types.has('spread'));
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

  if (slip?.mode === 'parlay' && hasMoneylineSpreadConflict(legs)) {
    problems.push(PARLAY_ML_SPREAD_MESSAGE);
  }
  if (slip?.mode === 'parlay' && legs.some((leg) => leg.marketType === 'crypto')) {
    problems.push(CRYPTO_PARLAY_MESSAGE);
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

// Human label for a pick, e.g. "Jaguars -2.5", "Over 42.5", "Texans moneyline". A Challenge pick is its
// outcome's name (outcomeLabel); a crypto pick "BTC Up (≥ $81,931.55, 7:30 PM)" (crypto: { symbol, kind, closeTime }).
export function pickLabel({ marketType, selection, line, homeName, awayName, outcomeLabel = '', crypto = null }) {
  if (marketType === 'challenge') return outcomeLabel || selection;
  if (marketType === 'crypto') return cryptoPickLabel({ ...(crypto ?? {}), selection, line });
  if (marketType === 'total') return `${selection === 'over' ? 'Over' : 'Under'} ${line}`;
  const team = selection === 'home' ? homeName : awayName;
  if (marketType === 'spread') return `${team} ${formatSignedLine(line)}`;
  return `${team} moneyline`;
}

// ---------- Cash out eligibility ----------
// Cash out exists only for bets whose every leg has a market price. A bet with any leg on a custom game
// ("custom:") or a Challenge ("challenge:") can never be cashed out, before or after the start, singles and
// parlays alike. Battles have no cash out at all. Crypto singles can (0.14.0): live only, from the fresh Kalshi bid
// (server/cashout.js quoteCryptoCashout). Shared by the server (authoritative) and the phone (which shows no cash
// out row and asks for no quote on a bet that can never be cashed out).
export const NO_CASHOUT_PREFIXES = ['custom:', 'challenge:'];
export const NO_CASHOUT_REASON = 'No cash out on bets with a custom game or Challenge pick.';

export function legBlocksCashout(leg) {
  const gameId = String(leg?.gameId ?? '');
  return NO_CASHOUT_PREFIXES.some((p) => gameId.startsWith(p));
}

export function cashoutEligible(bet) {
  const legs = Array.isArray(bet?.legs) ? bet.legs : [];
  return legs.length > 0 && !legs.some(legBlocksCashout);
}
