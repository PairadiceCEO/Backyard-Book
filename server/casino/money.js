// Casino money moves. Every debit and credit changes users/{uid}.balanceCents and creates its ledger
// entry inside the caller's Firestore transaction, so a wallet change never happens without its record.
// Ledger ids are deterministic, so a retried request can't create a second entry (create() fails).

import { Timestamp } from 'firebase-admin/firestore';
import { HttpError } from '../http.js';
import {
  BET_CEILING_MESSAGE,
  CASINO_LEDGER_TYPES,
  CHIP_MESSAGE,
  betAmountProblem,
  betCeilingProblem,
  isChip,
} from '../../shared/casino/constants.js';

export function formatDollars(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function amountError(problem) {
  return new HttpError(400, problem === BET_CEILING_MESSAGE ? 'BET_TOO_LARGE' : 'BAD_BET', problem);
}

// Amount check for one bet in whole dollars (no maximum, 0.16.0): whole dollars, at least $1, a safe integer, and
// at most the $1,000,000 sanity ceiling ("That bet is larger than the table allows."). The wallet is checked
// separately, inside the transaction that debits it.
export function requireBetAmount(dollars) {
  const problem = betAmountProblem(dollars);
  if (problem) throw amountError(problem);
}

// The same ceiling for an amount already in cents (a spot or seat total after a change).
export function requireUnderCeiling(cents) {
  const problem = betCeilingProblem(cents);
  if (problem) throw amountError(problem);
}

// Chip check: the tapped chip is one of CHIP_VALUES ($1, $2, $5, $10, $25, $100). A total built from chips is an
// amount (requireBetAmount), not a chip: $3 = $1 + $2 is fine as a bet, but not as one chip.
export function requireChip(dollars) {
  if (!isChip(dollars)) throw new HttpError(400, 'BAD_CHIP', CHIP_MESSAGE);
}

// entries: [{ id, type, amountCents (negative = debit), game, note, roundId?, extra? }], applied in order.
// balanceCents: the wallet as read in this transaction. Returns the new balance.
// Refuses (and writes nothing) if a debit would take the wallet below $0.
export function applyCasinoEntries(tx, db, { uid, balanceCents, entries, now = new Date() }) {
  let running = Number(balanceCents) || 0;
  const createdAt = Timestamp.fromDate(now);
  const writes = [];

  for (const entry of entries) {
    if (!CASINO_LEDGER_TYPES.includes(entry.type)) throw new Error(`unknown casino ledger type ${entry.type}`);
    if (!Number.isInteger(entry.amountCents) || entry.amountCents === 0) throw new Error('casino entry needs a whole, non-zero amount');
    running += entry.amountCents;
    if (running < 0) {
      throw new HttpError(409, 'INSUFFICIENT_BALANCE', `Your wallet has ${formatDollars(Number(balanceCents) || 0)}; that needs ${formatDollars(-entry.amountCents)}.`);
    }
    writes.push({
      ref: db.collection('ledger').doc(entry.id),
      data: {
        uid,
        type: entry.type,
        amountCents: entry.amountCents,
        balanceAfterCents: running,
        betId: null,
        game: entry.game,
        roundId: entry.roundId ?? null,
        note: String(entry.note ?? '').slice(0, 200),
        by: 'casino',
        createdAt,
        ...(entry.extra ?? {}),
      },
    });
  }

  // All checks passed: write the ledger entries and the wallet together.
  for (const w of writes) tx.create(w.ref, w.data);
  tx.update(db.collection('users').doc(uid), { balanceCents: running });
  return running;
}
