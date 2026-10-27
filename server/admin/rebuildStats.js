// Admin action "rebuildStats" (0.21.0): recomputes every player's performance totals (stats.won / lost / stakedCents /
// returnedCents / settledBets / byLeague) from their settled bets, and adminAdjustCents from the admin_adjust ledger,
// because bets settled before 0.21.0 never added to the new fields.
//   { confirm: false } (or nothing): dry run, nothing written: { bets, users, changes: [{ uid, username, before, after }] }
//   { confirm: true }: the same computation, then one transaction per changed player that re-reads the user doc and
//     writes only if its stats are still what was read (a bet settling in between skips that player: run it again).
// Idempotent: a second run finds nothing to change. Reads: the settled bets, the admin_adjust ledger entries and the users.

import { adminDb } from '../firebaseAdmin.js';
import { SETTLED_STATUSES, statsFromBets } from '../../shared/perfStats.js';

const KEYS = ['won', 'lost', 'stakedCents', 'returnedCents', 'settledBets'];

function sameStats(a, b) {
  return KEYS.every((k) => (Number(a?.[k]) || 0) === (Number(b?.[k]) || 0)) && JSON.stringify(sortKeys(a?.byLeague ?? {})) === JSON.stringify(sortKeys(b?.byLeague ?? {}));
}

function sortKeys(obj) {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

function shortStats(s) {
  return Object.fromEntries(KEYS.map((k) => [k, Number(s?.[k]) || 0]));
}

export async function computeRebuild(db) {
  const [betSnap, ledgerSnap, userSnap] = await Promise.all([
    db.collection('bets').where('status', 'in', SETTLED_STATUSES).get(),
    db.collection('ledger').where('type', '==', 'admin_adjust').get(),
    db.collection('users').get(),
  ]);
  const betsBy = new Map();
  betSnap.docs.forEach((d) => {
    const bet = d.data();
    betsBy.set(bet.uid, [...(betsBy.get(bet.uid) ?? []), bet]);
  });
  const adjustBy = new Map();
  ledgerSnap.docs.forEach((d) => {
    const e = d.data();
    adjustBy.set(e.uid, (adjustBy.get(e.uid) ?? 0) + (Number(e.amountCents) || 0));
  });
  const plans = userSnap.docs.map((d) => {
    const user = d.data();
    const computed = statsFromBets(betsBy.get(d.id) ?? []);
    const after = { ...(user.stats ?? {}), ...computed };
    const adminAdjustCents = adjustBy.get(d.id) ?? 0;
    const changed = !sameStats(user.stats, after) || (Number(user.adminAdjustCents) || 0) !== adminAdjustCents || user.adminAdjustCents === undefined;
    return { uid: d.id, username: user.username ?? d.id, beforeStats: user.stats ?? null, after, adminAdjustCents, changed };
  });
  return { bets: betSnap.size, plans };
}

export async function rebuildStats(body, _caller, { db = adminDb() } = {}) {
  const { bets, plans } = await computeRebuild(db);
  const changes = plans.filter((p) => p.changed);
  const report = {
    bets,
    users: plans.length,
    changes: changes.map((p) => ({ uid: p.uid, username: p.username, before: shortStats(p.beforeStats), after: shortStats(p.after), adminAdjustCents: p.adminAdjustCents })),
  };
  if (body?.confirm !== true) return { ok: true, dryRun: true, ...report };

  let written = 0;
  const skipped = [];
  for (const plan of changes) {
    const ref = db.collection('users').doc(plan.uid);
    const done = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const now = snap.data();
      if (JSON.stringify(now.stats ?? null) !== JSON.stringify(plan.beforeStats)) return false; // a bet settled meanwhile
      tx.update(ref, { stats: plan.after, adminAdjustCents: plan.adminAdjustCents });
      return true;
    });
    if (done) written += 1;
    else skipped.push(plan.username);
  }
  return { ok: true, dryRun: false, ...report, written, skipped };
}
