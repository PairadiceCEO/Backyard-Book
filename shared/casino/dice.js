// One dice engine for Craps and Crapless Craps. Every game-specific number comes from the variant table
// (shared/casino/diceVariants.js); this file has none of its own. Pure functions: bets in, results out.
//
// A seat's bets (cents):
//   pass, dontPass        line bets (made on a come-out)
//   odds, dontOdds        Odds behind Pass / Don't Pass (once a Point is set)
//   come                  a fresh Come bet in the Come spot (point phase only; decided by the next roll)
//   comeOn { [n]: { bet, odds } }   Come bets that moved to their number, with their Odds
//   place { [n] }, hard { [n] }, field

import { BET_CEILING_CENTS, BET_CEILING_MESSAGE, dollarsText, winningsCents } from './constants.js';

export const BET_KINDS = ['pass', 'dontPass', 'odds', 'dontOdds', 'come', 'comeOdds', 'place', 'hard', 'field'];
export const NUMBERED_KINDS = ['place', 'hard', 'comeOdds'];
export const BET_LABELS = {
  pass: 'Pass',
  dontPass: "Don't Pass",
  odds: 'Odds',
  dontOdds: "Don't Pass Odds",
  come: 'Come',
  comeOdds: 'Come Odds',
  place: 'Place',
  hard: 'Hard',
  field: 'Field',
};

export function emptyDiceBets() {
  return { pass: 0, dontPass: 0, odds: 0, dontOdds: 0, come: 0, field: 0, place: {}, hard: {}, comeOn: {} };
}

function cleanMap(map) {
  const out = {};
  for (const [n, v] of Object.entries(map ?? {})) if (v) out[n] = v;
  return out;
}

export function cloneBets(bets) {
  const b = bets ?? {};
  const comeOn = {};
  for (const [n, c] of Object.entries(b.comeOn ?? {})) {
    if (c && (c.bet || c.odds)) comeOn[n] = { bet: c.bet || 0, odds: c.odds || 0 };
  }
  return {
    pass: b.pass || 0,
    dontPass: b.dontPass || 0,
    odds: b.odds || 0,
    dontOdds: b.dontOdds || 0,
    come: b.come || 0,
    field: b.field || 0,
    place: cleanMap(b.place),
    hard: cleanMap(b.hard),
    comeOn,
  };
}

const sum = (map) => Object.values(map).reduce((s, v) => s + (v || 0), 0);

export function totalOnFelt(bets) {
  const b = cloneBets(bets);
  const comeOn = Object.values(b.comeOn).reduce((s, c) => s + c.bet + c.odds, 0);
  return b.pass + b.dontPass + b.odds + b.dontOdds + b.come + b.field + sum(b.place) + sum(b.hard) + comeOn;
}

// Bets that must play out before a seat can be freed: Pass, Don't Pass, their Odds, Come bets (in the
// Come spot or on a number) and Come Odds. Place, Field and Hard ways are refunded instead.
export function hasLineAction(bets) {
  const b = cloneBets(bets);
  return b.pass > 0 || b.dontPass > 0 || b.odds > 0 || b.dontOdds > 0 || b.come > 0 || Object.keys(b.comeOn).length > 0;
}

// Refundable bets (when a seat frees): Place, Field and Hard ways.
export function refundableCents(bets) {
  const b = cloneBets(bets);
  return sum(b.place) + b.field + sum(b.hard);
}

export function spotAmount(bets, kind, number) {
  const b = cloneBets(bets);
  if (kind === 'place') return b.place[number] || 0;
  if (kind === 'hard') return b.hard[number] || 0;
  if (kind === 'comeOdds') return b.comeOn[number]?.odds || 0;
  return b[kind] || 0;
}

function spotLabel(kind, number) {
  if (kind === 'place') return `Place ${number}`;
  if (kind === 'hard') return `Hard ${number}`;
  if (kind === 'comeOdds') return `Odds on Come ${number}`;
  if (kind === 'odds') return 'Pass Odds';
  return BET_LABELS[kind] ?? kind;
}

// The line bet an Odds spot sits behind (cents), or null for a spot that isn't Odds.
function oddsBase(bets, kind, number) {
  const b = cloneBets(bets);
  if (kind === 'odds') return b.pass;
  if (kind === 'dontOdds') return b.dontPass;
  if (kind === 'comeOdds') return b.comeOn[number]?.bet || 0;
  return null;
}

// The most an Odds spot can hold (cents): oddsMultiple × its line bet (a game rule). Every other spot has no maximum
// (null); the wallet and the per-bet sanity ceiling are its only caps.
export function spotLimitCents(variant, bets, kind, number) {
  const base = oddsBase(bets, kind, number);
  if (base !== null) return base * variant.oddsMultiple;
  return null;
}

const dollars = dollarsText;

// Why `bets` (after a change) break a rule, or '' if they don't: each Odds at most oddsMultiple × its line bet, and
// no single spot above the $1,000,000 sanity ceiling. Used by the server (refusals) and the phone (refusing a chip
// at once).
export function limitProblem(variant, bets, { kind, number } = {}) {
  const b = cloneBets(bets);
  const check = (k, n, amount) => {
    if (amount > BET_CEILING_CENTS || !Number.isSafeInteger(amount)) return BET_CEILING_MESSAGE;
    const limit = spotLimitCents(variant, b, k, n);
    if (limit === null || amount <= limit) return '';
    const behind = k === 'odds' ? 'Pass' : k === 'dontOdds' ? "Don't Pass" : `Come ${n}`;
    return `${spotLabel(k, n)} can be up to ${variant.oddsMultiple}× your ${behind} bet (${dollars(limit)}).`;
  };
  // The spot just changed first, so its message wins.
  if (kind) {
    const problem = check(kind, number, spotAmount(b, kind, number));
    if (problem) return problem;
  }
  for (const k of ['pass', 'dontPass', 'come', 'field', 'odds', 'dontOdds']) {
    const problem = check(k, undefined, b[k]);
    if (problem) return problem;
  }
  for (const [n, v] of Object.entries(b.place)) {
    const problem = check('place', Number(n), v);
    if (problem) return problem;
  }
  for (const [n, v] of Object.entries(b.hard)) {
    const problem = check('hard', Number(n), v);
    if (problem) return problem;
  }
  for (const [n, c] of Object.entries(b.comeOn)) {
    const problem = check('comeOdds', Number(n), c.odds) || (c.bet > BET_CEILING_CENTS ? BET_CEILING_MESSAGE : '');
    if (problem) return problem;
  }
  return '';
}

const win = (stake, ratio) => winningsCents(stake, ratio[0], ratio[1]);
const inverse = (ratio) => [ratio[1], ratio[0]];

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

// Why a bet can't go down right now (null if it can). number is the Place / Hard / Come Odds number.
export function placeBlocker(variant, point, bets, kind, number) {
  const pointOn = point !== null && point !== undefined;
  const b = cloneBets(bets);
  switch (kind) {
    case 'pass':
      return pointOn ? 'Pass goes down before a come-out roll.' : null;
    case 'dontPass':
      if (!variant.dontPass) return `${variant.name} has no Don't Pass.`;
      return pointOn ? "Don't Pass goes down before a come-out roll." : null;
    case 'odds':
      if (!pointOn) return 'Odds go behind Pass once a Point is set.';
      return b.pass > 0 ? null : 'Odds need a Pass bet.';
    case 'dontOdds':
      if (!variant.dontPass) return `${variant.name} has no Don't Pass.`;
      if (!pointOn) return "Don't Pass Odds go down once a Point is set.";
      return b.dontPass > 0 ? null : "Don't Pass Odds need a Don't Pass bet.";
    case 'come':
      return pointOn ? null : 'The Come spot opens once a Point is set.';
    case 'comeOdds':
      return b.comeOn[number]?.bet > 0 ? null : `Odds on ${number} need a Come bet on ${number}.`;
    case 'place':
      if (!variant.place[number]) return `There's no Place ${number} in ${variant.name}.`;
      return pointOn ? null : 'Place bets go up once a Point is set.';
    case 'hard':
      return variant.hardWays[number] ? null : `There's no Hard ${number}.`;
    case 'field':
      return null;
    default:
      return 'Unknown bet.';
  }
}

// Why a bet can't be taken down right now (null if it can). Everything comes down before the next
// roll except Pass / Don't Pass once a Point is set, and a Come bet once it has moved to its number
// (that one isn't a spot you can take chips from at all; its Odds are).
export function removeBlocker(point, kind) {
  const pointOn = point !== null && point !== undefined;
  if ((kind === 'pass' || kind === 'dontPass') && pointOn) return `${BET_LABELS[kind]} stays up until the Point is decided.`;
  return BET_KINDS.includes(kind) ? null : 'Unknown bet.';
}

// Settles one roll for one seat. dice: [d1, d2] (Hard ways need them). Returns the bets left on the
// felt, what comes back to the wallet (returnCents: stakes + winnings), profitCents (winnings only),
// lostCents (stakes lost), one line per bet decided, and the table's next point.
export function settleRoll(variant, point, bets, total, dice = null) {
  const before = cloneBets(bets);
  const after = cloneBets(bets);
  const lines = [];
  let returnCents = 0;
  let profitCents = 0;
  let lostCents = 0;
  const pointOn = point !== null && point !== undefined;
  const hardRoll = Array.isArray(dice) && dice[0] !== undefined && dice[0] === dice[1];

  const payOff = (bet, stake, ratio, number, extra = {}) => {
    const w = win(stake, ratio);
    returnCents += stake + w;
    profitCents += w;
    lines.push({ bet, number, result: 'win', stake, winnings: w, ...extra });
  };
  // A winner that stays up: only the winnings come back.
  const payStays = (bet, stake, ratio, number) => {
    const w = win(stake, ratio);
    returnCents += w;
    profitCents += w;
    lines.push({ bet, number, result: 'win', stake, winnings: w, stays: true });
  };
  const lose = (bet, stake, number) => {
    lostCents += stake;
    lines.push({ bet, number, result: 'lose', stake });
  };
  const giveBack = (bet, stake, number, why) => {
    returnCents += stake;
    lines.push({ bet, number, result: 'returned', stake, why });
  };

  // Field: decided by every roll, then it comes off.
  if (before.field) {
    const ratio = variant.field[total];
    if (ratio) payOff('field', before.field, ratio);
    else lose('field', before.field);
    after.field = 0;
  }

  // Hard ways: off on a come-out. With a Point on: the hard number wins (and stays up); the same
  // number rolled the easy way, or any 7, loses.
  if (pointOn) {
    for (const [n, stake] of Object.entries(before.hard)) {
      const number = Number(n);
      if (total === variant.seven) {
        lose('hard', stake, number);
        delete after.hard[n];
      } else if (total === number) {
        if (hardRoll) payStays('hard', stake, variant.hardWays[number], number);
        else {
          lose('hard', stake, number);
          delete after.hard[n];
        }
      }
    }
  }

  // Come bets already on a number: the number wins (1:1, Odds at true odds), a 7 loses. Their Odds
  // are off on a come-out roll: returned, never won or lost.
  for (const [n, c] of Object.entries(before.comeOn)) {
    const number = Number(n);
    if (total !== number && total !== variant.seven) continue;
    const wins = total === number;
    if (c.bet) {
      if (wins) payOff('come', c.bet, variant.lineOdds, number);
      else lose('come', c.bet, number);
    }
    if (c.odds) {
      if (!pointOn) giveBack('comeOdds', c.odds, number, 'off on the come-out');
      else if (wins) payOff('comeOdds', c.odds, variant.odds[number], number);
      else lose('comeOdds', c.odds, number);
    }
    delete after.comeOn[n];
  }

  // A fresh Come bet: decided like a Pass bet on a come-out, or it moves to its number. Landing on a
  // number that already holds a Come bet adds to it (no line limit since 0.16.0, so nothing comes back).
  if (before.come) {
    after.come = 0;
    if (variant.comeOutPassWins.includes(total)) payOff('come', before.come, variant.lineOdds);
    else if (variant.comeOutPassLoses.includes(total)) lose('come', before.come);
    else {
      const there = after.comeOn[total] ?? { bet: 0, odds: 0 };
      after.comeOn[total] = { bet: there.bet + before.come, odds: there.odds };
      lines.push({ bet: 'come', number: total, result: 'moved', stake: before.come });
    }
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
    nextPoint = total; // line bets stay up; Place bets and Hard ways were off for the come-out
  } else if (kind === 'pointMade') {
    if (before.pass) payOff('pass', before.pass, variant.lineOdds);
    if (before.odds) payOff('odds', before.odds, variant.odds[point], point);
    if (before.dontPass) lose('dontPass', before.dontPass);
    if (before.dontOdds) lose('dontOdds', before.dontOdds, point);
    after.pass = 0;
    after.odds = 0;
    after.dontPass = 0;
    after.dontOdds = 0;
    const placed = before.place[point];
    if (placed) payStays('place', placed, variant.place[point], point); // a Place win stays up
    nextPoint = null;
  } else if (kind === 'sevenOut') {
    if (before.pass) lose('pass', before.pass);
    if (before.odds) lose('odds', before.odds, point);
    if (before.dontPass) payOff('dontPass', before.dontPass, variant.lineOdds);
    if (before.dontOdds) payOff('dontOdds', before.dontOdds, inverse(variant.odds[point]), point);
    for (const [number, stake] of Object.entries(before.place)) if (stake) lose('place', stake, Number(number));
    after.pass = 0;
    after.odds = 0;
    after.dontPass = 0;
    after.dontOdds = 0;
    after.place = {};
    nextPoint = null;
  } else {
    const placed = before.place[total];
    if (placed) payStays('place', placed, variant.place[total], total);
  }

  return { kind, bets: cloneBets(after), returnCents, profitCents, lostCents, netCents: profitCents - lostCents, lines, nextPoint };
}
