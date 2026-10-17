// One dice engine for Craps and Crapless Craps. Every game-specific number comes from the variant table
// (shared/casino/diceVariants.js); this file has none of its own. Pure functions: bets in, results out.
//
// A seat's bets (cents): { pass, dontPass, odds, field, place: { [number]: cents } }.

import { CASINO_MAX_BET_DOLLARS, winningsCents } from './constants.js';

export const SPOT_MAX_CENTS = CASINO_MAX_BET_DOLLARS * 100;
export const BET_KINDS = ['pass', 'dontPass', 'odds', 'place', 'field'];
export const BET_LABELS = { pass: 'Pass', dontPass: "Don't Pass", odds: 'Odds', place: 'Place', field: 'Field' };

export function emptyDiceBets() {
  return { pass: 0, dontPass: 0, odds: 0, field: 0, place: {} };
}

export function cloneBets(bets) {
  const b = bets ?? emptyDiceBets();
  return { pass: b.pass || 0, dontPass: b.dontPass || 0, odds: b.odds || 0, field: b.field || 0, place: { ...(b.place ?? {}) } };
}

export function totalOnFelt(bets) {
  const b = cloneBets(bets);
  return b.pass + b.dontPass + b.odds + b.field + Object.values(b.place).reduce((s, v) => s + (v || 0), 0);
}

// Bets that must play out before a seat can be freed (Place and Field are refunded instead).
export function hasLineAction(bets) {
  const b = cloneBets(bets);
  return b.pass > 0 || b.dontPass > 0 || b.odds > 0;
}

export function spotAmount(bets, kind, number) {
  const b = cloneBets(bets);
  return kind === 'place' ? b.place[number] || 0 : b[kind] || 0;
}

const win = (stake, ratio) => winningsCents(stake, ratio[0], ratio[1]);

// What a roll means for the line: 'natural' | 'craps' | 'point' (sets a point) on a come-out;
// 'pointMade' | 'sevenOut' | 'roll' while a point is on.
export function rollKind(variant, point, total) {
  if (point === null || point === undefined) {
    if (variant.comeOutPassWins.includes(total)) return 'natural';
    if (variant.comeOutPassLoses.includes(total)) return 'craps';
    if (variant.points.includes(total)) return 'point';
    return 'craps'; // unreachable with the variant tables, kept as a safe default
  }
  if (total === point) return 'pointMade';
  if (total === variant.seven) return 'sevenOut';
  return 'roll';
}

// Why a bet can't go down right now (null if it can). number is the Place number.
export function placeBlocker(variant, point, bets, kind, number) {
  const pointOn = point !== null && point !== undefined;
  switch (kind) {
    case 'pass':
      return pointOn ? 'Pass goes down before a come-out roll.' : null;
    case 'dontPass':
      if (!variant.dontPass) return `${variant.name} has no Don't Pass.`;
      return pointOn ? "Don't Pass goes down before a come-out roll." : null;
    case 'odds':
      if (!pointOn) return 'Odds go behind Pass once a Point is set.';
      return cloneBets(bets).pass > 0 ? null : 'Odds need a Pass bet.';
    case 'place':
      if (!variant.place[number]) return `There's no Place ${number} in ${variant.name}.`;
      return pointOn ? null : 'Place bets go up once a Point is set.';
    case 'field':
      return null;
    default:
      return 'Unknown bet.';
  }
}

// Why a bet can't be taken down right now (null if it can). Everything comes down before the next roll
// except Pass / Don't Pass once a Point is set.
export function removeBlocker(point, kind) {
  const pointOn = point !== null && point !== undefined;
  if ((kind === 'pass' || kind === 'dontPass') && pointOn) return `${BET_LABELS[kind]} stays up until the Point is decided.`;
  return BET_KINDS.includes(kind) ? null : 'Unknown bet.';
}

// Settles one roll for one seat. Returns the bets left on the felt, what comes back to the wallet
// (returnCents: stakes + winnings), profitCents (winnings only), lostCents (stakes lost), one line per
// bet decided, and the table's next point.
export function settleRoll(variant, point, bets, total) {
  const before = cloneBets(bets);
  const after = cloneBets(bets);
  const lines = [];
  let returnCents = 0;
  let profitCents = 0;
  let lostCents = 0;

  const payOff = (bet, stake, ratio, number) => {
    const w = win(stake, ratio);
    returnCents += stake + w;
    profitCents += w;
    lines.push({ bet, number, result: 'win', stake, winnings: w });
  };
  const lose = (bet, stake, number) => {
    lostCents += stake;
    lines.push({ bet, number, result: 'lose', stake });
  };

  // Field: decided by every roll, then it comes off.
  if (before.field) {
    const ratio = variant.field[total];
    if (ratio) payOff('field', before.field, ratio);
    else lose('field', before.field);
    after.field = 0;
  }

  const kind = rollKind(variant, point, total);
  let nextPoint = point ?? null;

  if (kind === 'natural') {
    if (before.pass) payOff('pass', before.pass, variant.lineOdds);
    if (before.dontPass) lose('dontPass', before.dontPass);
    after.pass = 0;
    after.dontPass = 0;
  } else if (kind === 'craps') {
    if (before.pass) lose('pass', before.pass);
    after.pass = 0;
    if (before.dontPass) {
      if (variant.dontPass?.comeOutWins.includes(total)) {
        payOff('dontPass', before.dontPass, variant.lineOdds);
        after.dontPass = 0;
      } else if (variant.dontPass?.comeOutPushes.includes(total)) {
        lines.push({ bet: 'dontPass', result: 'push', stake: before.dontPass }); // stays up
      }
    }
  } else if (kind === 'point') {
    nextPoint = total; // line bets stay up; Place bets were off for the come-out
  } else if (kind === 'pointMade') {
    if (before.pass) payOff('pass', before.pass, variant.lineOdds);
    if (before.odds) payOff('odds', before.odds, variant.odds[point], point);
    if (before.dontPass) lose('dontPass', before.dontPass);
    after.pass = 0;
    after.odds = 0;
    after.dontPass = 0;
    const placed = before.place[point];
    if (placed) {
      // A Place win pays its winnings; the bet stays up.
      const w = win(placed, variant.place[point]);
      returnCents += w;
      profitCents += w;
      lines.push({ bet: 'place', number: point, result: 'win', stake: placed, winnings: w, stays: true });
    }
    nextPoint = null;
  } else if (kind === 'sevenOut') {
    if (before.pass) lose('pass', before.pass);
    if (before.odds) lose('odds', before.odds, point);
    if (before.dontPass) payOff('dontPass', before.dontPass, variant.lineOdds);
    for (const [number, stake] of Object.entries(before.place)) if (stake) lose('place', stake, Number(number));
    after.pass = 0;
    after.odds = 0;
    after.dontPass = 0;
    after.place = {};
    nextPoint = null;
  } else {
    const placed = before.place[total];
    if (placed) {
      const w = win(placed, variant.place[total]);
      returnCents += w;
      profitCents += w;
      lines.push({ bet: 'place', number: total, result: 'win', stake: placed, winnings: w, stays: true });
    }
  }

  for (const [number, stake] of Object.entries(after.place)) if (!stake) delete after.place[number];
  return { kind, bets: after, returnCents, profitCents, lostCents, netCents: profitCents - lostCents, lines, nextPoint };
}
