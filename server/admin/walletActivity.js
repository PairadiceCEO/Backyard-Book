// POST /api/admin { action: 'walletActivity', uid, cursor? }: one player's ledger for the last 24 hours, read only.
//
// Entries: ledger where uid == X and createdAt ≥ now − 24 h, newest first, 50 a page; `cursor` (the last entry's id
// from the previous page) continues it. Summary (first page only): Firestore aggregation queries (count + sum of
// amountCents, ~1 read per 1,000 entries) per ledger type, and per casino game, never by reading every entry.
// Nothing is written; the ledger is never changed.
//
// Composite indexes (Firestore Database → Indexes → Composite), all on collection `ledger`, scope Collection:
//   ENTRIES  uid Ascending, createdAt Descending                    (the list and the 24 h total)
//   BY_TYPE  uid Ascending, type Ascending, createdAt Ascending     (summary per type)
//   BY_GAME  uid Ascending, type Ascending, game Ascending, createdAt Ascending   (summary per casino game)
// If one is missing (or still building) the reply says which, and everything that doesn't need it still loads.

import { AggregateField, Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../firebaseAdmin.js';
import { HttpError } from '../http.js';
import { ACTIVITY_PAGE, ACTIVITY_WINDOW_MS, CASINO_GAME_IDS, CASINO_TYPES, NON_CASINO_TYPES, buildSummary } from '../../shared/walletActivity.js';

export const ACTIVITY_INDEXES = {
  ENTRIES: { id: 'ENTRIES', collection: 'ledger', fields: [['uid', 'Ascending'], ['createdAt', 'Descending']], usedFor: 'the entry list and the 24 h total' },
  BY_TYPE: { id: 'BY_TYPE', collection: 'ledger', fields: [['uid', 'Ascending'], ['type', 'Ascending'], ['createdAt', 'Ascending']], usedFor: 'the summary per type' },
  BY_GAME: {
    id: 'BY_GAME',
    collection: 'ledger',
    fields: [['uid', 'Ascending'], ['type', 'Ascending'], ['game', 'Ascending'], ['createdAt', 'Ascending']],
    usedFor: 'the summary per casino game',
  },
};

const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,300}$/;

// Firestore says FAILED_PRECONDITION (code 9) "The query requires an index…" (also while an index is still building).
export function isMissingIndex(err) {
  const code = err?.code;
  return (code === 9 || code === 'failed-precondition' || code === 'FAILED_PRECONDITION') && /index/i.test(String(err?.message ?? ''));
}

function missing(index, err) {
  const link = /https:\/\/console\.firebase\.google\.com\/\S+/.exec(String(err?.message ?? ''))?.[0] ?? null;
  const building = /currently building|is building|not ready/i.test(String(err?.message ?? ''));
  return { ...index, link, building };
}

function msOf(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Exact timestamp key: entries written in one transaction share it (microsecond timestamps; ms alone could merge two).
function keyOf(ts) {
  if (ts && Number.isFinite(ts.seconds) && Number.isFinite(ts.nanoseconds)) return `${ts.seconds}.${String(ts.nanoseconds).padStart(9, '0')}`;
  if (ts && Number.isFinite(ts._seconds) && Number.isFinite(ts._nanoseconds)) return `${ts._seconds}.${String(ts._nanoseconds).padStart(9, '0')}`;
  const ms = msOf(ts);
  return ms === null ? '' : String(ms);
}

function entryOut(doc) {
  const d = doc.data();
  return {
    id: doc.id,
    type: String(d.type ?? ''),
    amountCents: Number(d.amountCents) || 0,
    balanceAfterCents: Number(d.balanceAfterCents) || 0,
    note: String(d.note ?? ''),
    betId: d.betId ?? null,
    battleId: d.battleId ?? null,
    game: d.game ?? null,
    roundId: d.roundId ?? null,
    createdAt: msOf(d.createdAt) === null ? null : new Date(msOf(d.createdAt)).toISOString(),
    createdKey: keyOf(d.createdAt),
  };
}

async function aggregate(query) {
  const snap = await query.aggregate({ n: AggregateField.count(), s: AggregateField.sum('amountCents') }).get();
  const data = snap.data();
  return { count: Number(data.n) || 0, sumCents: Number(data.s) || 0 };
}

export async function walletActivity(body, _caller, { now = new Date(), db = adminDb() } = {}) {
  const uid = body?.uid;
  if (typeof uid !== 'string' || !UID_PATTERN.test(uid)) throw new HttpError(400, 'BAD_UID', 'Pick a player.');
  const cursor = body?.cursor ?? null;
  if (cursor !== null && (typeof cursor !== 'string' || !ID_PATTERN.test(cursor))) throw new HttpError(400, 'BAD_CURSOR', 'Invalid cursor.');

  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) throw new HttpError(404, 'USER_NOT_FOUND', 'That player does not exist.');
  const user = userSnap.data();
  const sinceMs = now.getTime() - ACTIVITY_WINDOW_MS;
  const since = Timestamp.fromMillis(sinceMs);
  const ledger = db.collection('ledger');
  const inWindow = () => ledger.where('uid', '==', uid).where('createdAt', '>=', since);
  const missingIndexes = [];

  // ---- one page of entries ----
  let entries = null;
  let nextCursor = null;
  try {
    let q = inWindow().orderBy('createdAt', 'desc');
    if (cursor) {
      const cursorSnap = await ledger.doc(cursor).get();
      if (!cursorSnap.exists || cursorSnap.data().uid !== uid) throw new HttpError(400, 'BAD_CURSOR', 'That page no longer exists. Reload.');
      q = q.startAfter(cursorSnap);
    }
    const snap = await q.limit(ACTIVITY_PAGE + 1).get();
    const docs = snap.docs.slice(0, ACTIVITY_PAGE);
    entries = docs.map(entryOut);
    nextCursor = snap.docs.length > ACTIVITY_PAGE ? docs[docs.length - 1].id : null;
  } catch (err) {
    if (!isMissingIndex(err)) throw err;
    missingIndexes.push(missing(ACTIVITY_INDEXES.ENTRIES, err));
  }

  // ---- the 24 h summary (first page only) ----
  let summary = null;
  if (!cursor) {
    const run = async (index, fn) => {
      try {
        return await fn();
      } catch (err) {
        if (!isMissingIndex(err)) throw err;
        if (!missingIndexes.some((m) => m.id === index.id)) missingIndexes.push(missing(index, err));
        return null;
      }
    };
    const [total, typeAggs, gameAggs] = await Promise.all([
      missingIndexes.some((m) => m.id === 'ENTRIES') ? null : run(ACTIVITY_INDEXES.ENTRIES, () => aggregate(inWindow())),
      run(ACTIVITY_INDEXES.BY_TYPE, () => Promise.all(NON_CASINO_TYPES.map((t) => aggregate(inWindow().where('type', '==', t))))),
      run(ACTIVITY_INDEXES.BY_GAME, () =>
        Promise.all(CASINO_GAME_IDS.flatMap((g) => CASINO_TYPES.map((t) => aggregate(inWindow().where('type', '==', t).where('game', '==', g))))),
      ),
    ]);
    if (typeAggs && gameAggs) {
      const byType = Object.fromEntries(NON_CASINO_TYPES.map((t, i) => [t, typeAggs[i]]));
      const byGame = {};
      CASINO_GAME_IDS.forEach((g, gi) => {
        byGame[g] = Object.fromEntries(CASINO_TYPES.map((t, ti) => [t, gameAggs[gi * CASINO_TYPES.length + ti]]));
      });
      summary = buildSummary({ byType, byGame, total });
    }
  }

  return {
    ok: true,
    player: { uid, name: user.displayName || user.username || uid, username: user.username ?? null, balanceCents: Number(user.balanceCents) || 0 },
    since: new Date(sinceMs).toISOString(),
    serverNow: now.toISOString(),
    entries,
    nextCursor,
    summary,
    missingIndexes,
  };
}
