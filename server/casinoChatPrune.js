// Casino chat retention (0.17.0): messages are kept 24 hours. Called from every settlement run: the daily cron always
// prunes; any other run at most once an hour (meta/chatPrune). Deletes in batches of at most 500 per room. Kept apart
// from server/casinoChat.js so settlement doesn't load the chat's sign-in code.

import { Timestamp } from 'firebase-admin/firestore';
import { CHAT_KEEP_MS, CHAT_LEGACY_ROOMS, CHAT_ROOMS } from '../shared/casino/chat.js';

export const PRUNE_BATCH = 500;
export const PRUNE_EVERY_MS = 60 * 60 * 1000;
const PRUNE_MAX_BATCHES = 10; // per room per run; anything left goes on the next run

function toMs(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function messagesOf(db, room) {
  return db.collection('casinoChat').doc(room).collection('messages');
}

// Claims this hour's prune (any non-cron run): false if one ran in the last hour.
async function claimPrune(db, now) {
  const ref = db.collection('meta').doc('chatPrune');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const last = snap.exists ? toMs(snap.data().lastRunAt) : null;
    if (last !== null && now.getTime() - last < PRUNE_EVERY_MS) return false;
    tx.set(ref, { lastRunAt: Timestamp.fromDate(now) }, { merge: true });
    return true;
  });
}

// Deletes messages older than 24 h in every room, PRUNE_BATCH at a time. force (the daily cron): always runs.
export async function pruneCasinoChat({ db, now = new Date(), force = false }) {
  if (force) await db.collection('meta').doc('chatPrune').set({ lastRunAt: Timestamp.fromDate(now) }, { merge: true });
  else if (!(await claimPrune(db, now))) return { ran: false, deleted: 0 };
  const cutoff = Timestamp.fromMillis(now.getTime() - CHAT_KEEP_MS);
  let deleted = 0;
  for (const room of [...CHAT_ROOMS, ...CHAT_LEGACY_ROOMS]) {
    for (let i = 0; i < PRUNE_MAX_BATCHES; i += 1) {
      const snap = await messagesOf(db, room).where('createdAt', '<', cutoff).orderBy('createdAt').limit(PRUNE_BATCH).get();
      if (snap.empty) break;
      const batch = db.batch();
      for (const doc of snap.docs) batch.delete(doc.ref);
      await batch.commit();
      deleted += snap.size;
      if (snap.size < PRUNE_BATCH) break;
    }
  }
  return { ran: true, deleted };
}
