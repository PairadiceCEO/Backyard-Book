// Admin regrades: force a whole bet to win / lose / void, or override one leg's result and recompute the
// bet from all its legs with the normal rules. Works on open and already-settled bets, never on a bet
// the player cashed out (final).
//
// Every call first runs with confirm: false and returns a preview (status, payout and wallet change, record
// before → after). The confirm call carries the previewed bet version; if the bet changed in between it is
// refused, so what you confirmed is exactly what happens.
//
// Money rule (same as settlement): only (new payout − what the bet already paid) moves the wallet, with an
// admin_regrade ledger entry keyed by the bet's new version, so a regrade can't be applied twice.

import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../firebaseAdmin.js';
import { HttpError } from '../http.js';
import { decideBet } from '../grading.js';
import { combinedDecimal, payoutCents } from '../../shared/betRules.js';
import { decimalToAmerican, roundDecimal } from '../../shared/oddsMath.js';

const OUTCOMES = new Set(['win', 'lose', 'void']);
const LEG_RESULTS = new Set(['win', 'loss', 'push', 'void']);
const COUNTED = { won: 'won', lost: 'lost' };
const STATUS_WORDS = { open: 'Open', won: 'Won', lost: 'Lost', push: 'Push', void: 'Void', cashed_out: 'Cashed out' };

// A cashed-out bet is final: the player was paid its cash out value, so no regrade applies.
function refuseCashedOut(bet) {
  if (bet.status === 'cashed_out') {
    throw new HttpError(409, 'CASHED_OUT', 'This bet was cashed out by the player. Cashed-out bets are final and cannot be regraded.');
  }
}
const LEG_WORDS = { win: 'Won', loss: 'Lost', push: 'Push', void: 'Void', pending: 'Pending' };

function betIdFrom(body) {
  const betId = typeof body.betId === 'string' ? body.betId.trim() : '';
  if (!betId || betId.length > 200 || betId.includes('/')) throw new HttpError(400, 'MISSING_FIELD', 'Missing "betId".');
  return betId;
}

// What the bet becomes. Returns { legs, status, payoutCents, settledDecimal, settledAmerican, droppedLegs, describe }.
export function planForce(bet, outcome) {
  const legs = bet.legs.map((leg) => ({ ...leg }));
  if (outcome === 'win') {
    const decimal = combinedDecimal(legs.map((l) => Number(l.decimalOdds)));
    legs.forEach((leg) => {
      if (!leg.result || leg.result === 'pending') leg.result = 'win';
    });
    return {
      legs,
      status: 'won',
      payoutCents: payoutCents(Number(bet.stakeCents) || 0, decimal),
      settledDecimal: roundDecimal(decimal),
      settledAmerican: decimalToAmerican(decimal),
      droppedLegs: 0,
      describe: 'Forced win (full odds)',
    };
  }
  if (outcome === 'lose') {
    return { legs, status: 'lost', payoutCents: 0, settledDecimal: null, settledAmerican: null, droppedLegs: 0, describe: 'Forced loss' };
  }
  legs.forEach((leg) => {
    if (!leg.result || leg.result === 'pending') leg.result = 'void';
  });
  return {
    legs,
    status: 'void',
    payoutCents: Number(bet.stakeCents) || 0,
    settledDecimal: null,
    settledAmerican: null,
    droppedLegs: 0,
    describe: 'Voided (stake back)',
  };
}

export function planLegOverride(bet, legIndex, result) {
  const legs = bet.legs.map((leg, i) => (i === legIndex ? { ...leg, result, overriddenBy: 'admin' } : { ...leg }));
  const decision = decideBet({ ...bet, legs }, legs.map((l) => ({ result: l.result || 'pending' })));
  const leg = bet.legs[legIndex];
  return {
    legs,
    status: decision.status,
    payoutCents: decision.status === 'open' ? 0 : decision.payoutCents,
    settledDecimal: decision.settledDecimal,
    settledAmerican: decision.settledAmerican,
    droppedLegs: decision.droppedLegs,
    describe: `Leg "${leg.label}" ${LEG_WORDS[leg.result || 'pending']} → ${LEG_WORDS[result]}`,
  };
}

function statsAfter(stats, fromStatus, toStatus) {
  const next = { won: Number(stats?.won) || 0, lost: Number(stats?.lost) || 0 };
  if (COUNTED[fromStatus]) next[COUNTED[fromStatus]] = Math.max(0, next[COUNTED[fromStatus]] - 1);
  if (COUNTED[toStatus]) next[COUNTED[toStatus]] += 1;
  return next;
}

function summarize(betId, bet, user, plan) {
  const fromPayout = Number(bet.payoutCents) || 0;
  const deltaCents = plan.payoutCents - fromPayout;
  const balanceBeforeCents = Number(user.balanceCents) || 0;
  return {
    betId,
    version: Number(bet.version) || 0,
    uid: bet.uid,
    username: bet.username ?? user.username ?? bet.uid,
    type: bet.type,
    stakeCents: bet.stakeCents,
    describe: plan.describe,
    from: { status: bet.status, payoutCents: fromPayout },
    to: { status: plan.status, payoutCents: plan.payoutCents },
    deltaCents,
    balanceBeforeCents,
    balanceAfterCents: balanceBeforeCents + deltaCents,
    statsBefore: { won: Number(user.stats?.won) || 0, lost: Number(user.stats?.lost) || 0 },
    statsAfter: statsAfter(user.stats, bet.status, plan.status),
    legs: plan.legs.map((l) => ({ label: l.label, gameLabel: l.gameLabel, result: l.result || 'pending' })),
    noChange: deltaCents === 0 && bet.status === plan.status && JSON.stringify(plan.legs.map((l) => l.result)) === JSON.stringify(bet.legs.map((l) => l.result)),
  };
}

// Shared preview/confirm flow. makePlan(bet) returns the plan for the bet as read.
async function regrade(body, caller, makePlan) {
  const betId = betIdFrom(body);
  const db = adminDb();
  const betRef = db.collection('bets').doc(betId);

  if (body.confirm !== true) {
    const betSnap = await betRef.get();
    if (!betSnap.exists) throw new HttpError(404, 'BET_NOT_FOUND', 'That bet does not exist.');
    const bet = betSnap.data();
    refuseCashedOut(bet);
    const userSnap = await db.collection('users').doc(bet.uid).get();
    if (!userSnap.exists) throw new HttpError(404, 'USER_NOT_FOUND', "The bet's player no longer exists.");
    return { preview: true, ...summarize(betId, bet, userSnap.data(), makePlan(bet)) };
  }

  if (!Number.isInteger(body.expectedVersion)) {
    throw new HttpError(400, 'MISSING_FIELD', 'Missing "expectedVersion" from the preview.');
  }

  const now = Timestamp.now();
  return db.runTransaction(async (tx) => {
    const betSnap = await tx.get(betRef);
    if (!betSnap.exists) throw new HttpError(404, 'BET_NOT_FOUND', 'That bet does not exist.');
    const bet = betSnap.data();
    refuseCashedOut(bet);
    if ((Number(bet.version) || 0) !== body.expectedVersion) {
      throw new HttpError(409, 'BET_CHANGED', 'This bet changed since you previewed it (it may have just settled). Review it again.');
    }
    const plan = makePlan(bet);
    const userRef = db.collection('users').doc(bet.uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new HttpError(404, 'USER_NOT_FOUND', "The bet's player no longer exists.");
    const user = userSnap.data();
    const summary = summarize(betId, bet, user, plan);
    if (summary.noChange) throw new HttpError(400, 'NO_CHANGE', 'That leaves the bet exactly as it is.');

    const newVersion = summary.version + 1;
    const ledgerRef = db.collection('ledger').doc(`regrade_${betId}_v${newVersion}`);
    const ledgerSnap = await tx.get(ledgerRef);
    if (ledgerSnap.exists) throw new HttpError(409, 'BET_CHANGED', 'This regrade was already applied.');

    const open = plan.status === 'open';
    tx.update(betRef, {
      legs: plan.legs,
      status: plan.status,
      payoutCents: plan.payoutCents,
      settledDecimal: plan.settledDecimal,
      settledAmerican: plan.settledAmerican,
      droppedLegs: plan.droppedLegs,
      settledAt: open ? null : now,
      settledBy: open ? null : 'admin',
      version: newVersion,
      needsReview: false,
      reviewReason: null,
      adminNote: plan.describe,
    });

    const userUpdate = { stats: summary.statsAfter };
    if (summary.deltaCents !== 0) {
      userUpdate.balanceCents = summary.balanceAfterCents; // may go below $0 if winnings are taken back
      tx.create(ledgerRef, {
        uid: bet.uid,
        type: 'admin_regrade',
        amountCents: summary.deltaCents,
        balanceAfterCents: summary.balanceAfterCents,
        betId,
        note: `${plan.describe}: ${STATUS_WORDS[bet.status] ?? bet.status} → ${STATUS_WORDS[plan.status] ?? plan.status}`.slice(0, 200),
        by: caller.uid,
        createdAt: now,
      });
    }
    tx.update(userRef, userUpdate);
    return { ok: true, ...summary, version: newVersion };
  });
}

// { betId, outcome: 'win' | 'lose' | 'void', confirm?, expectedVersion? }
export async function gradeBet(body, caller) {
  const outcome = body.outcome;
  if (!OUTCOMES.has(outcome)) throw new HttpError(400, 'BAD_OUTCOME', 'outcome must be "win", "lose" or "void".');
  return regrade(body, caller, (bet) => planForce(bet, outcome));
}

// { betId, legIndex, result: 'win' | 'loss' | 'push' | 'void', confirm?, expectedVersion? }
export async function setLegResult(body, caller) {
  const result = body.result;
  if (!LEG_RESULTS.has(result)) throw new HttpError(400, 'BAD_RESULT', 'result must be "win", "loss", "push" or "void".');
  const legIndex = body.legIndex;
  return regrade(body, caller, (bet) => {
    if (!Number.isInteger(legIndex) || legIndex < 0 || legIndex >= bet.legs.length) {
      throw new HttpError(400, 'BAD_LEG', 'That leg does not exist on this bet.');
    }
    return planLegOverride(bet, legIndex, result);
  });
}
