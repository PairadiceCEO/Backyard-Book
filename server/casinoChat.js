// Casino chat (0.17.0): one room per game, written only here.
//   sendChat            POST /api/casino { action: 'chat', game, text, requestId }   any signed-in, non-disabled player
//   deleteChatMessage   POST /api/admin  { action: 'chatDelete', game, messageId }    admin only
//   pruneCasinoChat     server/casinoChatPrune.js (from every settlement run)
//
// A message and the sender's rate counter (chatRate/{uid}, server-only) are written in one transaction. The message
// id is {uid}_{requestId}, created with create(), so a retried request posts once.

import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from './firebaseAdmin.js';
import { HttpError } from './http.js';
import { REQUEST_ID_PATTERN } from '../shared/constants.js';
import {
  CHAT_EMPTY_MESSAGE,
  CHAT_MESSAGE_ID_PATTERN,
  CHAT_ROOM_MESSAGE,
  CHAT_SLOW_MESSAGE,
  chatRateProblem,
  chatTextProblem,
  cleanChatText,
  isChatRoom,
  nextChatRate,
} from '../shared/casino/chat.js';

function messagesOf(db, room) {
  return db.collection('casinoChat').doc(room).collection('messages');
}

// The sender's profile as read in the transaction: missing or disabled → refused (same answers as auth.js
// checkProfile; kept here so loading the chat never needs the sign-in module).
function chatProfile(snap) {
  if (!snap.exists) throw new HttpError(403, 'NO_PROFILE', 'No player profile exists for this login.');
  const user = snap.data();
  if (user.disabled === true) throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account has been disabled.');
  return user;
}

function requireRoom(room) {
  if (!isChatRoom(room)) throw new HttpError(400, 'BAD_ROOM', CHAT_ROOM_MESSAGE);
}

export async function sendChat(caller, body, { now = new Date() } = {}) {
  const room = body?.game;
  requireRoom(room);
  if (typeof body.requestId !== 'string' || !REQUEST_ID_PATTERN.test(body.requestId)) {
    throw new HttpError(400, 'BAD_REQUEST_ID', 'Missing or invalid requestId.');
  }
  const text = cleanChatText(body.text);
  const problem = chatTextProblem(text);
  if (problem) throw new HttpError(400, problem === CHAT_EMPTY_MESSAGE ? 'EMPTY_MESSAGE' : 'MESSAGE_TOO_LONG', problem);

  const db = adminDb();
  const messageId = `${caller.uid}_${body.requestId}`;
  const userRef = db.collection('users').doc(caller.uid);
  const rateRef = db.collection('chatRate').doc(caller.uid);
  const messageRef = messagesOf(db, room).doc(messageId);
  const nowMs = now.getTime();

  return db.runTransaction(async (tx) => {
    const [userSnap, rateSnap, messageSnap] = await tx.getAll(userRef, rateRef, messageRef);
    const user = chatProfile(userSnap); // missing or disabled → refused
    // The same request again (double tap, retry): it already posted.
    if (messageSnap.exists) {
      if (messageSnap.data().uid !== caller.uid) throw new HttpError(409, 'DUPLICATE_REQUEST', 'That request id was already used.');
      return { ok: true, duplicate: true, messageId };
    }
    const recent = rateSnap.exists ? rateSnap.data().recent : [];
    if (chatRateProblem(recent, nowMs)) throw new HttpError(429, 'SLOW_DOWN', CHAT_SLOW_MESSAGE);
    const name = String(user.displayName || user.username || 'Player').slice(0, 40);
    tx.create(messageRef, { uid: caller.uid, name, text, createdAt: Timestamp.fromDate(now), deleted: false });
    tx.set(rateRef, { recent: nextChatRate(recent, nowMs), updatedAt: Timestamp.fromDate(now) });
    return { ok: true, duplicate: false, messageId };
  });
}

export async function deleteChatMessage(body, caller, { now = new Date() } = {}) {
  const room = body?.game;
  requireRoom(room);
  const messageId = body?.messageId;
  if (typeof messageId !== 'string' || !CHAT_MESSAGE_ID_PATTERN.test(messageId)) {
    throw new HttpError(400, 'BAD_MESSAGE_ID', 'Missing or invalid messageId.');
  }
  const db = adminDb();
  const ref = messagesOf(db, room).doc(messageId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'That message is gone (messages are kept 24 hours).');
    if (snap.data().deleted === true) return { ok: true, already: true, messageId };
    tx.update(ref, { deleted: true, text: '', deletedAt: Timestamp.fromDate(now), deletedBy: caller.uid });
    return { ok: true, already: false, messageId };
  });
}
