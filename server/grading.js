// Pure grading rules. No I/O: given a game result and a leg (or a whole bet), say what happened.
// The same rules apply whatever priced the leg (DraftKings via ESPN, Kalshi, or a custom game).

import { combinedDecimal, payoutCents } from '../shared/betRules.js';
import { decimalToAmerican, roundDecimal } from '../shared/oddsMath.js';

// ESPN statuses that void a leg. Suspended, delayed, forfeits and anything unknown stay pending
// (and reach the admin "Needs review" list after 72 hours) rather than being guessed.
export const VOID_STATUS_NAMES = new Set(['STATUS_POSTPONED', 'STATUS_CANCELED', 'STATUS_CANCELLED']);

// ---------- game results ----------
// A result is { status: 'final' | 'void' | 'pending', homeScore, awayScore, homeName, awayName, statusText, reason }.

function pending(reason, extra = {}) {
  return { status: 'pending', homeScore: null, awayScore: null, homeName: null, awayName: null, statusText: '', reason, ...extra };
}

// From a normalized ESPN game (server/sources/espn.js normalizeEspnEvent).
export function resultFromEspnGame(game) {
  if (!game) return pending('Game not found on ESPN yet.');
  const names = { homeName: game.home?.shortName ?? 'Home', awayName: game.away?.shortName ?? 'Away' };
  const statusText = game.statusText || '';

  if (VOID_STATUS_NAMES.has(game.statusName)) {
    return { ...pending(''), ...names, status: 'void', statusText: statusText || 'Postponed', reason: `ESPN: ${statusText || 'postponed / canceled'}` };
  }

  // Only a game ESPN marks completed is graded. In progress, delays, intermissions, suspensions: wait.
  const completed = game.completed === true || /^STATUS_FINAL/.test(game.statusName || '');
  if (game.state !== 'post' || !completed) {
    return pending(`Not final yet (ESPN: ${statusText || game.state || 'unknown'}).`, names);
  }

  const homeScore = Number(game.home?.score);
  const awayScore = Number(game.away?.score);
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore) || game.home?.score === null || game.away?.score === null) {
    return pending('ESPN shows the game final but without a score.', names);
  }
  return { status: 'final', homeScore, awayScore, ...names, statusText: statusText || 'Final', reason: '' };
}

// From a customGames doc, already normalized by board.js normalizeCustomGame (or null if the doc is gone).
export function resultFromCustomGame(game) {
  if (!game) return pending('Custom game not found.');
  const names = { homeName: game.home?.shortName ?? 'Home', awayName: game.away?.shortName ?? 'Away' };
  if (game.canceled) return { ...pending(''), ...names, status: 'void', statusText: 'Canceled', reason: 'Custom game canceled' };
  if (!game.completed) return pending('Waiting for the admin to enter the final score.', names);
  const homeScore = Number(game.home?.score);
  const awayScore = Number(game.away?.score);
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore) || game.home?.score === null || game.away?.score === null) {
    return pending('Custom game is final but has no score.', names);
  }
  return { status: 'final', homeScore, awayScore, ...names, statusText: 'Final', reason: '' };
}

// "Rays 3 @ Guardians 5 · Final/10" (a Challenge: "Winner: Yes")
export function scoreText(result) {
  if (!result) return null;
  if (result.status === 'void') return result.statusText || 'Canceled';
  if (result.status !== 'final') return null;
  if (result.winner) return `Winner: ${result.winnerLabel ?? result.winner}`;
  return `${result.awayName} ${result.awayScore} @ ${result.homeName} ${result.homeScore} · ${result.statusText || 'Final'}`;
}

// ---------- legs ----------

// Lines are whole or half points, so compare in thousandths to avoid floating-point noise.
function compare(value, against) {
  const diff = Math.round((value - against) * 1000);
  return diff > 0 ? 'win' : diff < 0 ? 'loss' : 'push';
}

// Grades one leg against its game's result.
// Returns { result: 'win' | 'loss' | 'push' | 'void' | 'pending', reason, scoreText, finalScore }.
export function gradeLeg(leg, result) {
  if (!result || result.status === 'pending') {
    return { result: 'pending', reason: result?.reason || 'Game not found yet.', scoreText: null, finalScore: null };
  }
  if (result.status === 'void') {
    return { result: 'void', reason: result.reason || 'Game postponed or canceled.', scoreText: scoreText(result), finalScore: null };
  }

  const { marketType, selection } = leg;
  // A Challenge: the admin's winning outcome wins, every other outcome loses.
  if (marketType === 'challenge') {
    if (!result.winner) return { result: 'pending', reason: 'Challenge has no winner yet.', scoreText: null, finalScore: null };
    return { result: selection === result.winner ? 'win' : 'loss', reason: '', scoreText: scoreText(result), finalScore: null };
  }
  const finalScore = { home: result.homeScore, away: result.awayScore };
  const base = { reason: '', scoreText: scoreText(result), finalScore };
  const line = leg.line === null || leg.line === undefined ? null : Number(leg.line);

  if (marketType === 'moneyline' || marketType === 'spread') {
    if (selection !== 'home' && selection !== 'away') return { ...base, result: 'pending', reason: 'Leg has an unknown team.' };
    const mine = selection === 'home' ? result.homeScore : result.awayScore;
    const theirs = selection === 'home' ? result.awayScore : result.homeScore;
    if (marketType === 'moneyline') return { ...base, result: compare(mine, theirs) };
    if (line === null || !Number.isFinite(line)) return { ...base, result: 'pending', reason: 'Spread leg has no line.' };
    return { ...base, result: compare(mine + line, theirs) };
  }

  if (marketType === 'total') {
    if (line === null || !Number.isFinite(line)) return { ...base, result: 'pending', reason: 'Total leg has no line.' };
    const sum = result.homeScore + result.awayScore;
    const overResult = compare(sum, line);
    if (selection === 'over') return { ...base, result: overResult };
    if (selection === 'under') return { ...base, result: overResult === 'push' ? 'push' : overResult === 'win' ? 'loss' : 'win' };
    return { ...base, result: 'pending', reason: 'Leg has an unknown side.' };
  }

  return { ...base, result: 'pending', reason: 'Unknown market type.' };
}

// ---------- bets ----------

// grades: one { result } per bet.legs entry, in order.
// Returns { status: 'open' | 'won' | 'lost' | 'push' | 'void', payoutCents, settledDecimal, settledAmerican, droppedLegs }.
//   Any lost leg → lost (even if other legs are still playing).
//   Any leg still pending → open.
//   Otherwise push/void legs drop out; the rest pay stake × product of their decimals;
//   if every leg pushed or voided, the stake comes back (void if all voided, else push).
export function decideBet(bet, grades) {
  const results = grades.map((g) => g.result);
  const stake = Number(bet.stakeCents) || 0;
  const none = { payoutCents: 0, settledDecimal: null, settledAmerican: null, droppedLegs: 0 };

  if (results.includes('loss')) return { ...none, status: 'lost' };
  if (results.length === 0 || results.includes('pending')) return { ...none, status: 'open' };

  const winners = bet.legs.filter((_, i) => results[i] === 'win');
  const dropped = bet.legs.length - winners.length;
  if (winners.length === 0) {
    return { ...none, status: results.every((r) => r === 'void') ? 'void' : 'push', payoutCents: stake, droppedLegs: dropped };
  }

  const decimal = combinedDecimal(winners.map((l) => Number(l.decimalOdds)));
  return {
    status: 'won',
    payoutCents: payoutCents(stake, decimal),
    settledDecimal: roundDecimal(decimal),
    settledAmerican: decimalToAmerican(decimal),
    droppedLegs: dropped,
  };
}

// Grades a stored bet: legs already graded keep their result; pending legs are graded from `resultFor(leg)`.
export function gradeBet(bet, resultFor) {
  const grades = bet.legs.map((leg) => {
    if (leg.result && leg.result !== 'pending') {
      return { result: leg.result, reason: '', scoreText: leg.scoreText ?? null, finalScore: leg.finalScore ?? null };
    }
    return gradeLeg(leg, resultFor(leg));
  });
  return { grades, decision: decideBet(bet, grades) };
}
