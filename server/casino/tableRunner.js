// Runs one table action as one Firestore transaction.
//
// Reads happen lazily while the action runs (the table first, then the shoe, wallets, presence or
// ledger docs only if the action needs them); every write is held back and applied at the end, so
// Firestore's "all reads before any write" rule always holds and a refused action writes nothing.
//
// What the action gets (ctx):
//   ctx.state         the public table doc, as a plain object the action edits in place
//   ctx.now           server time in ms (the only clock deadlines are compared against)
//   ctx.seatIndex     the caller's seat (−1 if only watching)
//   ctx.changed       set true to write the table doc (version is bumped, for display only)
//   ctx.shoe()        the secret shoe and the dealer's hole card (loaded once, written back at the end)
//   ctx.balance(uid)  wallet balance, counting money already queued in this action
//   ctx.addMoney(uid, entry)        queue a casino_bet / casino_payout / casino_refund
//   ctx.ledgerExists(id)            for retry checks
//   ctx.presenceAt(uid)             last heartbeat time (ms) or null
//   ctx.markPresent(uid, {force})   write presence if the last write is 30 s old (or always)

import { adminDb } from '../firebaseAdmin.js';
import { HttpError } from '../http.js';
import { applyCasinoEntries } from './money.js';
import { freshShoe } from './shoe.js';
import { CASINO_SEATS, PRESENCE_WRITE_SECONDS } from '../../shared/casino/constants.js';

export function findSeat(state, uid) {
  return (state.seats ?? []).findIndex((seat) => seat && seat.uid === uid);
}

export async function runTableAction({ game, engine, caller, now = Date.now(), randomInt }, action) {
  const db = adminDb();
  const tableRef = db.collection('casinoTables').doc(game);
  const shoeRef = tableRef.collection('private').doc('shoe');
  const presenceRef = (uid) => tableRef.collection('presence').doc(uid);

  return db.runTransaction(async (tx) => {
    const tableSnap = await tx.get(tableRef);
    const exists = tableSnap.exists;
    const state = exists ? tableSnap.data() : engine.createTable(now);
    if (!Array.isArray(state.seats) || state.seats.length !== CASINO_SEATS) {
      state.seats = Array.from({ length: CASINO_SEATS }, (_, i) => state.seats?.[i] ?? null);
    }

    let shoe = null;
    const wallets = new Map(); // uid → { exists, balanceCents }
    const money = new Map(); // uid → [entries]
    const presence = new Map(); // uid → ms | null
    const presenceWrites = new Map(); // uid → ms

    async function loadWallet(uid) {
      if (!wallets.has(uid)) {
        const snap = await tx.get(db.collection('users').doc(uid));
        wallets.set(uid, { exists: snap.exists, balanceCents: snap.exists ? Number(snap.data().balanceCents) || 0 : 0 });
      }
      return wallets.get(uid);
    }

    async function loadPresence(uid) {
      if (!presence.has(uid)) {
        const snap = await tx.get(presenceRef(uid));
        presence.set(uid, snap.exists ? Number(snap.data().at) || 0 : null);
      }
      return presence.get(uid);
    }

    const ctx = {
      game,
      state,
      exists,
      now,
      randomInt,
      caller,
      changed: false,
      get seatIndex() {
        return caller ? findSeat(state, caller.uid) : -1;
      },
      async shoe() {
        if (!shoe) {
          const snap = await tx.get(shoeRef);
          shoe = snap.exists ? snap.data() : freshShoe(engine.decks);
          if (!Array.isArray(shoe.cards)) shoe = freshShoe(engine.decks);
          shoe.dealt = Number(shoe.dealt) || 0;
        }
        return shoe;
      },
      async balance(uid) {
        const wallet = await loadWallet(uid);
        const queued = (money.get(uid) ?? []).reduce((sum, e) => sum + e.amountCents, 0);
        return wallet.balanceCents + queued;
      },
      addMoney(uid, entry) {
        if (!money.has(uid)) money.set(uid, []);
        money.get(uid).push({ game, ...entry });
      },
      async ledgerExists(id) {
        const snap = await tx.get(db.collection('ledger').doc(id));
        return snap.exists;
      },
      presenceAt: loadPresence,
      async markPresent(uid, { force = false } = {}) {
        const last = await loadPresence(uid);
        if (force || last === null || now - last >= PRESENCE_WRITE_SECONDS * 1000) {
          presenceWrites.set(uid, now);
          presence.set(uid, now);
          return true;
        }
        return false;
      },
    };

    const result = await action(ctx);

    // Any action from a seated player also counts as "still here".
    if (caller && findSeat(state, caller.uid) !== -1) await ctx.markPresent(caller.uid);

    // ---- every read is done; now the writes ----
    for (const uid of money.keys()) await loadWallet(uid);

    for (const [uid, entries] of money) {
      const wallet = wallets.get(uid);
      if (!wallet.exists) {
        // A deleted player can't be paid; skip them rather than jam the table.
        console.error(`casino: no users/${uid} doc, skipped ${entries.length} entries`);
        continue;
      }
      applyCasinoEntries(tx, db, { uid, balanceCents: wallet.balanceCents, entries, now: new Date(now) });
    }

    if (shoe) tx.set(shoeRef, { cards: shoe.cards, dealt: shoe.dealt, shuffles: shoe.shuffles ?? 0, holeCard: shoe.holeCard ?? null, updatedAt: now });
    for (const [uid, at] of presenceWrites) tx.set(presenceRef(uid), { at });

    if (ctx.changed) {
      if (shoe) state.shoe = { remaining: shoe.cards.length, total: engine.decks * 52, shuffles: shoe.shuffles ?? 0 };
      state.version = (Number(state.version) || 0) + 1;
      state.updatedAt = now;
      tx.set(tableRef, state);
    }

    return { ok: true, ...(result ?? {}) };
  });
}

// Refusals shared by every table.
export function requireSeat(ctx) {
  const index = ctx.seatIndex;
  if (index === -1) throw new HttpError(403, 'NOT_SEATED', 'Take a seat to play. You can watch without one.');
  return index;
}

export function requirePhase(ctx, phase, message) {
  if (ctx.state.phase !== phase) throw new HttpError(409, 'PHASE', message);
}
