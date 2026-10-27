// Every wallet change goes through here: the balance and its ledger entry are written in one transaction.

import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from './firebaseAdmin.js';
import { HttpError } from './http.js';

// Applies deltaCents to users/{uid}.balanceCents and writes ledger/{ledgerId}.
// If ledger/{ledgerId} already exists, nothing changes and the earlier result is returned,
// which makes a repeated request (double-click, retry) harmless.
// trackAdminAdjust (0.21.0): also add deltaCents to users/{uid}.adminAdjustCents (every admin_adjust, starting balance
// included), so profit = balance − adminAdjustCents needs no ledger reads. Same single user write.
export async function applyWalletChange({ uid, deltaCents, ledgerId, type, note = '', by, allowNegative = false, trackAdminAdjust = false }) {
  if (!Number.isInteger(deltaCents) || deltaCents === 0) {
    throw new HttpError(400, 'BAD_AMOUNT', 'The amount must be a non-zero whole number of cents.');
  }

  const db = adminDb();
  const userRef = db.collection('users').doc(uid);
  const ledgerRef = db.collection('ledger').doc(ledgerId);

  return db.runTransaction(async (tx) => {
    const [userSnap, ledgerSnap] = await Promise.all([tx.get(userRef), tx.get(ledgerRef)]);

    if (!userSnap.exists) {
      throw new HttpError(404, 'USER_NOT_FOUND', 'That player does not exist.');
    }

    const currentBalance = Number(userSnap.data().balanceCents) || 0;

    if (ledgerSnap.exists) {
      return { balanceCents: currentBalance, duplicate: true };
    }

    const newBalance = currentBalance + deltaCents;
    if (newBalance < 0 && !allowNegative) {
      throw new HttpError(
        409,
        'INSUFFICIENT_BALANCE',
        `That would take the wallet below $0.00 (current balance $${(currentBalance / 100).toFixed(2)}).`,
      );
    }

    const update = { balanceCents: newBalance };
    if (trackAdminAdjust) update.adminAdjustCents = (Number(userSnap.data().adminAdjustCents) || 0) + deltaCents;
    tx.update(userRef, update);
    tx.create(ledgerRef, {
      uid,
      type,
      amountCents: deltaCents,
      balanceAfterCents: newBalance,
      betId: null,
      note: String(note).slice(0, 200),
      by,
      createdAt: Timestamp.now(),
    });

    return { balanceCents: newBalance, duplicate: false };
  });
}
