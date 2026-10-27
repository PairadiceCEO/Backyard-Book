// Settles open bets. Every trigger (app open / My Bets, admin "Settle now", daily cron) calls settleOpenBets().
//
// Pay-once guarantee: each bet settles in its own transaction that re-reads the bet and stops unless it is
// still "open", and the payout ledger entry is created with create(), which fails if it already exists.
// Running settlement many times, from several players at once, can never pay a bet twice.
//
// Money rule shared with admin regrades: a bet's payoutCents is what its owner has been credited for it,
// and every change moves only (new payout − payoutCents). A bet the admin reopened has payoutCents 0 again.

import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from './firebaseAdmin.js';
import { gameKey, loadGameResults } from './gameResults.js';
import { gradeBet } from './grading.js';
import { sweepExpiredBattles } from './battles.js';
import { pruneCasinoChat } from './casinoChatPrune.js';
import { applyContribution, betContribution } from '../shared/perfStats.js';
import { AGENT_DAILY_KEEP_DAYS, centralDayMinus } from '../shared/agents.js';

export const THROTTLE_MS = 60 * 1000;
export const REVIEW_AFTER_MS = 72 * 60 * 60 * 1000;
const MAX_OPEN_BETS = 1000;

function toMs(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function toIso(value) {
  const ms = toMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

// Player triggers share one throttle: skipped if any run started in the last 60 seconds.
async function claimThrottledRun(db, now, trigger) {
  const ref = db.collection('meta').doc('settlement');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const last = snap.exists ? toMs(snap.data().lastRunAt) : null;
    if (last !== null && now.getTime() - last < THROTTLE_MS) return { ok: false, lastRunMs: last };
    tx.set(ref, { lastRunAt: Timestamp.fromDate(now), lastRunBy: trigger }, { merge: true });
    return { ok: true };
  });
}

// Why an open bet needs the admin: a leg still pending 72 hours after its game's start.
function reviewInfo(bet, grades, decision, now) {
  if (decision.status !== 'open') return null;
  const stuck = [];
  bet.legs.forEach((leg, i) => {
    if (grades[i].result !== 'pending') return;
    const start = toMs(leg.startTime);
    if (start !== null && now.getTime() - start >= REVIEW_AFTER_MS) {
      stuck.push(`${leg.gameLabel || leg.gameId}: ${grades[i].reason || 'no result'}`);
    }
  });
  return stuck.length > 0 ? { reason: `Pending over 72 h — ${stuck.join(' | ')}`.slice(0, 500) } : null;
}

function legsWithResults(legs, grades) {
  return legs.map((leg, i) => {
    const g = grades[i];
    if (g.result === 'pending') return { ...leg, result: 'pending' };
    return { ...leg, result: g.result, scoreText: g.scoreText ?? null, finalScore: g.finalScore ?? null };
  });
}

const STATUS_WORDS = { won: 'Won', lost: 'Lost', push: 'Push — stake back', void: 'Void — stake back' };

function payoutNote(bet, status) {
  const word = STATUS_WORDS[status] ?? status;
  if (bet.type === 'parlay') return `Parlay (${bet.legs.length} legs): ${word}`;
  return `${word}: ${bet.legs[0]?.label ?? 'bet'}`.slice(0, 200);
}

// Ledger id for a settlement payout: payout_{betId} the first time, payout_{betId}_v{n} if an admin
// reopened the bet and it settles again at version n.
export function payoutLedgerId(betId, newVersion) {
  return newVersion <= 1 ? `payout_${betId}` : `payout_${betId}_v${newVersion}`;
}

// agentDaily/{uid}_{day} docs whose Central day is more than AGENT_DAILY_KEEP_DAYS days before today's.
export async function pruneAgentDaily(db, now) {
  const cutoff = centralDayMinus(now, AGENT_DAILY_KEEP_DAYS);
  const snap = await db.collection('agentDaily').where('day', '<', cutoff).limit(400).get();
  if (snap.empty) return 0;
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  return snap.size;
}

// Settles one bet. Returns 'settled' | 'already' | 'open'.
export async function settleBet(db, betId, resultFor, now) {
  const betRef = db.collection('bets').doc(betId);

  return db.runTransaction(async (tx) => {
    // All reads first (Firestore transactions require reads before writes).
    const betSnap = await tx.get(betRef);
    if (!betSnap.exists) return 'already';
    const bet = betSnap.data();
    // Only open bets settle: a bet already settled, voided or cashed out ('cashed_out') is never touched,
    // and because this re-read happens inside the transaction, a cash out that commits first wins the race.
    if (bet.status !== 'open') return 'already';

    // Grade from the bet as it is now, not as it was when this run listed it.
    const { grades, decision } = gradeBet(bet, resultFor);
    if (decision.status === 'open') return 'open';

    const newVersion = (Number(bet.version) || 0) + 1;
    const alreadyPaid = Number(bet.payoutCents) || 0;
    const deltaCents = decision.payoutCents - alreadyPaid;
    const ledgerRef = db.collection('ledger').doc(payoutLedgerId(betId, newVersion));
    const ledgerSnap = await tx.get(ledgerRef);
    if (ledgerSnap.exists) return 'already';
    const userRef = db.collection('users').doc(bet.uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new Error(`player ${bet.uid} not found`);
    const user = userSnap.data();

    const settledAt = Timestamp.fromDate(now);
    tx.update(betRef, {
      legs: legsWithResults(bet.legs, grades),
      status: decision.status,
      payoutCents: decision.payoutCents,
      settledDecimal: decision.settledDecimal,
      settledAmerican: decision.settledAmerican,
      droppedLegs: decision.droppedLegs,
      settledAt,
      settledBy: 'auto',
      version: newVersion,
      needsReview: false,
      reviewReason: null,
    });

    // won / lost plus the 0.21.0 performance totals (staked, returned, settled bets, per league): one user write, as before.
    const userUpdate = { stats: applyContribution(user.stats, betContribution(bet, decision.status, decision.payoutCents), 1) };
    if (deltaCents !== 0) {
      const balanceAfter = (Number(user.balanceCents) || 0) + deltaCents;
      userUpdate.balanceCents = balanceAfter;
      tx.create(ledgerRef, {
        uid: bet.uid,
        type: 'payout',
        amountCents: deltaCents,
        balanceAfterCents: balanceAfter,
        betId,
        note: payoutNote(bet, decision.status),
        by: 'settlement',
        createdAt: settledAt,
      });
    }
    tx.update(userRef, userUpdate);
    return 'settled';
  });
}

async function flagForReview(db, betId, reason, now) {
  const betRef = db.collection('bets').doc(betId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(betRef);
    if (!snap.exists || snap.data().status !== 'open' || snap.data().needsReview === true) return false;
    tx.update(betRef, { needsReview: true, reviewReason: reason, reviewFlaggedAt: Timestamp.fromDate(now) });
    return true;
  });
}

// Each player's wallet change if the previewed bets settled: [{ uid, username, deltaCents, bets, balanceBeforeCents, balanceAfterCents }].
export async function walletChangesFor(db, rows) {
  const byUid = new Map();
  for (const row of rows) {
    const entry = byUid.get(row.uid) ?? { uid: row.uid, username: row.username, deltaCents: 0, bets: 0 };
    entry.deltaCents += row.deltaCents;
    entry.bets += 1;
    byUid.set(row.uid, entry);
  }
  const out = await Promise.all(
    [...byUid.values()].map(async (entry) => {
      const snap = await db.collection('users').doc(entry.uid).get();
      const before = Number(snap.data()?.balanceCents) || 0;
      return { ...entry, balanceBeforeCents: before, balanceAfterCents: before + entry.deltaCents };
    }),
  );
  return out.sort((a, b) => String(a.username).localeCompare(String(b.username)));
}

function previewReport(evaluated, now) {
  const rows = evaluated.map(({ bet, grades, decision, review }) => ({
    id: bet.id,
    uid: bet.uid,
    username: bet.username ?? bet.uid,
    type: bet.type,
    stakeCents: bet.stakeCents,
    combinedAmerican: bet.combinedAmerican ?? null,
    placedAt: toIso(bet.placedAt),
    status: decision.status,
    payoutCents: decision.payoutCents,
    deltaCents: decision.status === 'open' ? 0 : decision.payoutCents - (Number(bet.payoutCents) || 0),
    settledAmerican: decision.settledAmerican,
    droppedLegs: decision.droppedLegs,
    review: review ? review.reason : null,
    legs: bet.legs.map((leg, i) => ({
      label: leg.label,
      gameLabel: leg.gameLabel,
      league: leg.league,
      gameId: leg.gameId,
      americanOdds: leg.americanOdds,
      source: leg.source,
      result: grades[i].result,
      scoreText: grades[i].scoreText ?? null,
      reason: grades[i].reason || '',
    })),
  }));
  const wouldSettle = rows.filter((r) => r.status !== 'open');
  const staysOpen = rows.filter((r) => r.status === 'open');
  const count = (s) => wouldSettle.filter((r) => r.status === s).length;
  return {
    preview: true,
    generatedAt: now.toISOString(),
    checked: rows.length,
    totals: {
      bets: wouldSettle.length,
      payoutCents: wouldSettle.reduce((sum, r) => sum + r.payoutCents, 0),
      won: count('won'),
      lost: count('lost'),
      push: count('push'),
      void: count('void'),
      needsReview: staysOpen.filter((r) => r.review).length,
    },
    wouldSettle,
    staysOpen,
  };
}

// trigger: 'player' | 'admin' | 'cron'. force skips the 60-second throttle. dryRun changes nothing.
// betFilter limits the run to some bets (e.g. those on one custom game); resultOverrides (dry runs only)
// grades games with a result that isn't saved yet, so the admin can see a final score's effect first.
export async function settleOpenBets({
  trigger = 'player',
  force = false,
  dryRun = false,
  now = new Date(),
  fetchImpl = fetch,
  betFilter = null,
  resultOverrides = null,
} = {}) {
  const db = adminDb();

  if (!dryRun) {
    if (force) {
      await db.collection('meta').doc('settlement').set({ lastRunAt: Timestamp.fromDate(now), lastRunBy: trigger }, { merge: true });
    } else {
      const claim = await claimThrottledRun(db, now, trigger);
      if (!claim.ok) {
        return { ran: false, reason: 'Settlement ran less than a minute ago.', lastRunAt: new Date(claim.lastRunMs).toISOString() };
      }
    }
  }

  const snap = await db.collection('bets').where('status', '==', 'open').limit(MAX_OPEN_BETS).get();
  const bets = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((b) => Array.isArray(b.legs) && b.legs.length > 0)
    .filter((b) => (betFilter ? betFilter(b) : true));

  const pendingLegs = bets.flatMap((b) => b.legs.filter((l) => !l.result || l.result === 'pending'));
  const results = await loadGameResults(pendingLegs, { now, fetchImpl, db, overrides: dryRun ? resultOverrides : null });
  const resultFor = (leg) => results.get(gameKey(leg)) ?? null;

  const evaluated = bets.map((bet) => {
    const { grades, decision } = gradeBet(bet, resultFor);
    return { bet, grades, decision, review: reviewInfo(bet, grades, decision, now) };
  });

  if (dryRun) {
    const report = previewReport(evaluated, now);
    return { ...report, walletChanges: await walletChangesFor(db, report.wouldSettle) };
  }

  const summary = { ran: true, trigger, checked: bets.length, settled: 0, alreadySettled: 0, stillOpen: 0, needsReview: 0, flagged: 0, errors: 0 };
  // One bet at a time: bets of the same player touch the same wallet, so parallel transactions would only contend.
  for (const item of evaluated) {
    if (item.decision.status !== 'open') {
      try {
        const outcome = await settleBet(db, item.bet.id, resultFor, now);
        if (outcome === 'settled') summary.settled += 1;
        else if (outcome === 'already') summary.alreadySettled += 1;
        else summary.stillOpen += 1;
      } catch (err) {
        summary.errors += 1;
        console.error(`settlement: bet ${item.bet.id} failed:`, err.message);
      }
      continue;
    }
    summary.stillOpen += 1;
    if (item.review) {
      summary.needsReview += 1;
      if (item.bet.needsReview !== true) {
        try {
          if (await flagForReview(db, item.bet.id, item.review.reason, now)) summary.flagged += 1;
        } catch (err) {
          summary.errors += 1;
          console.error(`settlement: flag ${item.bet.id} failed:`, err.message);
        }
      }
    }
  }

  // Battles still waiting for players after 48 h are cancelled and every stake refunded.
  try {
    summary.battlesExpired = await sweepExpiredBattles({ now, db });
  } catch (err) {
    summary.errors += 1;
    console.error('settlement: Battle expiry sweep failed:', err.message);
  }

  // AI agents' daily slip counters: the daily cron deletes those older than 3 days.
  if (trigger === 'cron') {
    try {
      summary.agentDailyPruned = await pruneAgentDaily(db, now);
    } catch (err) {
      summary.errors += 1;
      console.error('settlement: agentDaily prune failed:', err.message);
    }
  }

  // Casino chat keeps 24 hours: the daily cron always prunes, any other run at most once an hour.
  try {
    summary.chatPruned = await pruneCasinoChat({ db, now, force: trigger === 'cron' });
  } catch (err) {
    summary.errors += 1;
    console.error('settlement: chat prune failed:', err.message);
  }
  return summary;
}
