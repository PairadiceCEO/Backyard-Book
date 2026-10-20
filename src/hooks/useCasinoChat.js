// Casino chat on the phone (0.17.0): one room per game, read live from casinoChat/{room}/messages.
//
// Quota (Spark plan): while the drawer is closed the page listens to the newest 1 message only (for the badge); while
// it is open, to the newest 30 of the last 24 hours. Opening or closing swaps the listener; leaving the page removes
// it. Unread = messages newer than the last one I saw in that room (kept in localStorage, read and written inside
// try/catch); when the newest message is newer than that, one count query (an aggregation: 1 read) gives the number.
// Sending goes through /api/casino action "chat" (the server writes; clients never write the chat).
//
// Hooks: the listener effect depends only on [room, open]; state is set only in Firestore callbacks and after the
// count query (guarded against a room or drawer change in between); nothing is set during render.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Timestamp, collection, getCountFromServer, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '../firebase.js';
import { casinoAction, newRequestId } from '../lib/casino.js';
import { CHAT_KEEP_MS, CHAT_PAGE } from '../../shared/casino/chat.js';

const SEEN_PREFIX = 'bb.chatSeen.';

export function readSeen(room) {
  try {
    const value = Number(window.localStorage.getItem(SEEN_PREFIX + room));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export function saveSeen(room, ms) {
  try {
    if (Number.isFinite(ms) && ms > readSeen(room)) window.localStorage.setItem(SEEN_PREFIX + room, String(ms));
  } catch {
    // Storage blocked: the badge just can't remember across visits.
  }
}

function msOf(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.toDate === 'function') return ts.toDate().getTime();
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function toMessage(doc) {
  const d = doc.data() ?? {};
  return {
    id: doc.id,
    uid: String(d.uid ?? ''),
    name: String(d.name ?? 'Player'),
    text: typeof d.text === 'string' ? d.text : '',
    deleted: d.deleted === true,
    createdAtMs: msOf(d.createdAt),
  };
}

function messagesRef(room) {
  return collection(db, 'casinoChat', room, 'messages');
}

export function useCasinoChat(room) {
  const [open, setOpen] = useState(false);
  const [feed, setFeed] = useState({ key: null, messages: [], error: '' });
  const [unread, setUnread] = useState({ key: null, count: 0 });
  const key = `${room}|${open ? 'open' : 'closed'}`;

  // The one live listener: newest 1 (closed) or newest 30 (open), last 24 hours only.
  useEffect(() => {
    if (!db || !room) return undefined;
    const since = Timestamp.fromMillis(Date.now() - CHAT_KEEP_MS);
    const q = query(messagesRef(room), where('createdAt', '>=', since), orderBy('createdAt', 'desc'), limit(open ? CHAT_PAGE : 1));
    const unsubscribe = onSnapshot(
      q,
      (snap) => setFeed({ key, messages: snap.docs.map(toMessage).reverse(), error: '' }),
      () => setFeed({ key, messages: [], error: 'Chat is unavailable right now.' }),
    );
    return unsubscribe;
  }, [room, open, key]);

  const current = feed.key === key;
  const messages = useMemo(() => (current ? feed.messages : []), [current, feed.messages]);
  const newestMs = messages.length ? messages[messages.length - 1].createdAtMs : null;

  // Seen / unread. Open: everything shown is seen. Closed: count what's newer than the last one seen.
  useEffect(() => {
    if (!room || !current) return undefined;
    if (open) {
      if (newestMs !== null) saveSeen(room, newestMs);
      setUnread({ key: room, count: 0 });
      return undefined;
    }
    const seen = readSeen(room);
    if (newestMs === null || newestMs <= seen || !db) {
      setUnread({ key: room, count: 0 });
      return undefined;
    }
    let cancelled = false;
    const from = Math.max(seen, Date.now() - CHAT_KEEP_MS);
    getCountFromServer(query(messagesRef(room), where('createdAt', '>', Timestamp.fromMillis(from))))
      .then((snap) => {
        if (!cancelled) setUnread({ key: room, count: Number(snap.data().count) || 1 });
      })
      .catch(() => {
        if (!cancelled) setUnread({ key: room, count: 1 }); // at least the newest one
      });
    return () => {
      cancelled = true;
    };
  }, [room, open, current, newestMs]);

  const send = useCallback((text, requestId) => casinoAction('chat', { game: room, text, requestId }), [room]);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const close = useCallback(() => setOpen(false), []);

  return {
    room,
    open,
    toggle,
    close,
    messages,
    loading: !current,
    error: current ? feed.error : '',
    unread: unread.key === room && !open ? unread.count : 0,
    send,
    newRequestId,
  };
}
