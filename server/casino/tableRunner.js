// Runs one table action as one Firestore transaction.
//
// Reads happen lazily while the action runs (the table first, then the shoe, wallets, presence or
// ledger docs only if the action needs them); every write is held back and applied at the end, so
// Firestore's "all reads before any write" rule always holds and a refused action writes nothing.
//
// What the action gets (ctx):
//   ctx.state         the public table doc, as a plain object the action edits in place
//   ctx.now           server time in ms (the only clock deadlines are compared against)
//   ctx.seatIndex     the caller's first seat (−1 if only watching)
//   ctx.mySeats       every seat the caller holds (Blackjack and Baccarat allow several), in seat order
//   ctx.changed       set true to write the table doc (version is bumped, for display only)
//   ctx.shoe()        the secret shoe and the dealer's hole card (loaded once, written back at the end)
//   ctx.balance(uid)  wallet balance, counting money already queued in this action
//   ctx.addMoney(uid, entry)        queue a casino_bet / casino_payout / casino_refund
//   ctx.ledgerExists(id)            for retry checks
//   ctx.presenceAt(uid)             last heartbeat time (ms) or null
//   ctx.markPresent(uid, {force})   write presence if the last write is 30 s old (or always)

import { adminDb } from '../firebaseAdmin.js';
import { HttpError } from '../http.js';
import { checkProfile } from '../auth.js';
import { applyCasinoEntries } from './money.js';
import { freshShoe } from './shoe.js';
import { CASINO_SEATS, PRESENCE_WRITE_SECONDS } from '../../shared/casino/constants.js';

export function findSeat(state, uid) {
  return (state.seats ?? []).findIndex((seat) => seat && seat.uid === uid);
}

export function seatsOf(state, uid) {
  return (state.seats ?? []).map((seat, i) => (seat && seat.uid === uid ? i : -1)).filter((i) => i >= 0);
}

function shoeSignature(shoe) {
  return `${shoe.dealt}|${shoe.shuffles ?? 0}|${shoe.holeCard ?? ''}|${shoe.cards.length}|${shoe.cards.join(',')}`;
}

const noTiming = { time: (_n, fn) => fn(), add() {}, attempt() {} };

// preload: { shoe: true } when the action deals cards; ledgerIds: bet entries to check for retries.
// Everything the action is known to need is read in ONE round trip (tx.getAll) before it runs.
export async function runTableAction({ game, engine, caller, now = Date.now(), randomInt, timing = noTiming, preload = {} }, action) {
  const db = adminDb();
  const tableRef = db.collection('casinoTables').doc(game);
  const shoeRef = tableRef.collection('private').doc('shoe');
  const presenceRef = (uid) => tableRef.collection('presence').doc(uid);
  const userRef = (uid) => db.collection('users').doc(uid);
  const ledgerRef = (id) => db.collection('ledger').doc(id);
  let fnDoneAt = 0;

  const result = await db.runTransaction(async (tx) => {
    timing.attempt();
    const ledgerIds = [...new Set(preload.ledgerIds ?? [])];
    const refs = [tableRef, userRef(caller.uid), presenceRef(caller.uid)];
    if (preload.shoe) refs.push(shoeRef);
    for (const id of ledgerIds) refs.push(ledgerRef(id));
    const snaps = await timing.time('read', () => tx.getAll(...refs), `${refs.length} docs`);

    const [tableSnap, userSnap, presenceSnap] = snaps;
    const callerUser = checkProfile(userSnap); // refuses missing / disabled players
    const me = { ...caller, user: callerUser };

    const exists = tableSnap.exists;
    const state = exists ? tableSnap.data() : engine.createTable(now);
    if (!Array.isArray(state.seats) || state.seats.length !== CASINO_SEATS) {
      state.seats = Array.from({ length: CASINO_SEATS }, (_, i) => state.seats?.[i] ?? null);
    }

    const wallets = new Map(); // uid → { exists, balanceCents }
    const money = new Map(); // uid → [entries]
    const presence = new Map(); // uid → ms | null
    const presenceWrites = new Map(); // uid → ms
    const ledger = new Map(); // id → exists

    wallets.set(caller.uid, { exists: true, balanceCents: Number(callerUser.balanceCents) || 0 });
    presence.set(caller.uid, presenceSnap.exists ? Number(presenceSnap.data().at) || 0 : null);

    let shoe = null;
    let shoeLoadedSig = null;
    const adoptShoe = (snap) => {
      shoe = snap.exists ? snap.data() : freshShoe(engine.decks);
      if (!Array.isArray(shoe.cards)) shoe = freshShoe(engine.decks);
      shoe.dealt = Number(shoe.dealt) || 0;
      shoeLoadedSig = shoeSignature(shoe);
    };
    let next = 3;
    if (preload.shoe) adoptShoe(snaps[next++]);
    for (const id of ledgerIds) ledger.set(id, snaps[next++].exists);

    // Reads the action didn't predict: batched, one round trip per call.
    async function readMany(kind, list, build, keep) {
      const missing = [...new Set(list)].filter((key) => !keep.has(key));
      if (!missing.length) return;
      const got = await timing.time('read-more', () => tx.getAll(...missing.map(build)), `${missing.length} ${kind}`);
      missing.forEach((key, i) => keep.set(key, got[i]));
    }
    async function loadWallets(uids) {
      const raw = new Map();
      await readMany('wallets', uids.filter((u) => !wallets.has(u)), userRef, raw);
      for (const [uid, snap] of raw) wallets.set(uid, { exists: snap.exists, balanceCents: snap.exists ? Number(snap.data().balanceCents) || 0 : 0 });
    }
    async function loadPresence(uids) {
      const raw = new Map();
      await readMany('presence', uids.filter((u) => !presence.has(u)), presenceRef, raw);
      for (const [uid, snap] of raw) presence.set(uid, snap.exists ? Number(snap.data().at) || 0 : null);
    }

    const ctx = {
      game,
      state,
      exists,
      now,
      randomInt,
      caller: me,
      changed: false,
      get seatIndex() {
        return findSeat(state, caller.uid);
      },
      get mySeats() {
        return seatsOf(state, caller.uid);
      },
      async shoe() {
        if (!shoe) adoptShoe(await timing.time('read-more', () => tx.get(shoeRef), 'shoe'));
        return shoe;
      },
      async balance(uid) {
        await loadWallets([uid]);
        const queued = (money.get(uid) ?? []).reduce((sum, e) => sum + e.amountCents, 0);
        return wallets.get(uid).balanceCents + queued;
      },
      addMoney(uid, entry) {
        if (!money.has(uid)) money.set(uid, []);
        money.get(uid).push({ game, ...entry });
      },
      async ledgerExists(id) {
        if (!ledger.has(id)) ledger.set(id, (await timing.time('read-more', () => tx.get(ledgerRef(id)), 'ledger')).exists);
        return ledger.get(id);
      },
      // Read several players' presence in one round trip before checking them one by one.
      async prefetchPresence(uids) {
        await loadPresence(uids);
      },
      // Presence and wallets for several players together: one round trip for both.
      async prefetch({ wallets: walletUids = [], presence: presenceUids = [] } = {}) {
        const w = [...new Set(walletUids)].filter((u) => !wallets.has(u));
        const p = [...new Set(presenceUids)].filter((u) => !presence.has(u));
        if (!w.length && !p.length) return;
        const got = await timing.time('read-more', () => tx.getAll(...w.map(userRef), ...p.map(presenceRef)), `${w.length} wallets + ${p.length} presence`);
        w.forEach((uid, i) => wallets.set(uid, { exists: got[i].exists, balanceCents: got[i].exists ? Number(got[i].data().balanceCents) || 0 : 0 }));
        p.forEach((uid, i) => {
          const snap = got[w.length + i];
          presence.set(uid, snap.exists ? Number(snap.data().at) || 0 : null);
        });
      },
      async presenceAt(uid) {
        await loadPresence([uid]);
        return presence.get(uid);
      },
      async markPresent(uid, { force = false } = {}) {
        const last = await ctx.presenceAt(uid);
        if (force || last === null || now - last >= PRESENCE_WRITE_SECONDS * 1000) {
          presenceWrites.set(uid, now);
          presence.set(uid, now);
          return true;
        }
        return false;
      },
    };

    const out = await action(ctx);

    // Any action from a seated player also counts as "still here".
    if (findSeat(state, caller.uid) !== -1) await ctx.markPresent(caller.uid);

    // ---- every read is done (the wallets being paid come in one batch); now the writes ----
    await loadWallets([...money.keys()]);
    let callerBalance = wallets.get(caller.uid).balanceCents;
    for (const [uid, entries] of money) {
      const wallet = wallets.get(uid);
      if (!wallet.exists) {
        // A deleted player can't be paid; skip them rather than jam the table.
        console.error(`casino: no users/${uid} doc, skipped ${entries.length} entries`);
        continue;
      }
      const after = applyCasinoEntries(tx, db, { uid, balanceCents: wallet.balanceCents, entries, now: new Date(now) });
      if (uid === caller.uid) callerBalance = after;
    }

    // The shoe is written only when a card moved, the hole card changed, or it was reshuffled.
    if (shoe && shoeSignature(shoe) !== shoeLoadedSig) {
      tx.set(shoeRef, { cards: shoe.cards, dealt: shoe.dealt, shuffles: shoe.shuffles ?? 0, holeCard: shoe.holeCard ?? null, updatedAt: now });
    }
    for (const [uid, at] of presenceWrites) tx.set(presenceRef(uid), { at });

    if (ctx.changed) {
      if (shoe) state.shoe = { remaining: shoe.cards.length, total: engine.decks * 52, shuffles: shoe.shuffles ?? 0 };
      state.version = (Number(state.version) || 0) + 1;
      state.updatedAt = now;
      tx.set(tableRef, state);
    }

    fnDoneAt = performance.now();
    // The reply carries the public table (never the shoe or the hole card: they aren't in it) so the
    // caller's phone can show the result at once instead of waiting for its listener.
    return { ok: true, ...(out ?? {}), table: exists || ctx.changed ? state : null, balanceCents: callerBalance };
  });
  if (fnDoneAt) timing.add('commit', performance.now() - fnDoneAt);
  return result;
}

// Refusals shared by every table.
// The seat an action is for: body.seat (0–4) when given — it must be one of the caller's — or, when the
// caller holds exactly one seat, that one.
export function requireSeat(ctx, body = {}) {
  const mine = ctx.mySeats;
  if (!mine.length) throw new HttpError(403, 'NOT_SEATED', 'Take a seat to play. You can watch without one.');
  const wanted = body?.seat;
  if (wanted === undefined || wanted === null) {
    if (mine.length === 1) return mine[0];
    throw new HttpError(400, 'PICK_SEAT', `You have ${mine.length} seats here. Say which one (seat ${mine.map((i) => i + 1).join(', ')}).`);
  }
  if (!Number.isInteger(wanted) || !mine.includes(wanted)) {
    throw new HttpError(403, 'NOT_YOUR_SEAT', Number.isInteger(wanted) && wanted >= 0 && wanted < CASINO_SEATS ? `Seat ${wanted + 1} isn't yours.` : 'Pick one of your seats.');
  }
  return wanted;
}

export function requirePhase(ctx, phase, message) {
  if (ctx.state.phase !== phase) throw new HttpError(409, 'PHASE', message);
}
