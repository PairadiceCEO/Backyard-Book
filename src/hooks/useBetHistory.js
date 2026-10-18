// Every finished bet of the signed-in player, for My Bets → Finished (sort, filters and the summary line need all
// of them, not just the newest 200 the live listener holds).
//
// Firestore reads (Spark plan): the live listener already reads the newest 200 bets. Only when it is full (the
// player has more) does this load the older ones, after the listener's oldest document, 100 per query, once per
// browser session: the pages are kept in this module, so leaving and reopening My Bets reads nothing again. A
// player with fewer than 200 bets costs no extra reads at all. Same (uid, placedAt) index as the listener, so no
// new index is needed.
//
// Bets the listener has shown are remembered here too, so a bet that later slides out of the listener's
// window (after new bets are placed) never drops out of Finished.
//
// Loop safety: the loading effect depends only on uid, `needed` and a retry counter (the listener's cursor is read
// from a ref); React state is only set from the async page callbacks and subscriptions are removed on unmount.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collection, getDocs, limit, orderBy, query, startAfter, where } from 'firebase/firestore';
import { db } from '../firebase.js';
import { isFinishedBet } from '../lib/betFilters.js';

export const HISTORY_PAGE = 100;

const caches = new Map(); // uid → { bets: Map(id → bet), cursor, started, done, loading, error, subs: Set }

function cacheFor(uid) {
  if (!caches.has(uid)) caches.set(uid, { bets: new Map(), cursor: null, started: false, done: false, loading: false, error: '', subs: new Set() });
  return caches.get(uid);
}

function notify(entry) {
  for (const fn of entry.subs) fn();
}

async function loadAll(uid, entry) {
  if (entry.loading || entry.done) return;
  entry.loading = true;
  entry.error = '';
  notify(entry);
  try {
    while (!entry.done) {
      const q = query(collection(db, 'bets'), where('uid', '==', uid), orderBy('placedAt', 'desc'), startAfter(entry.cursor), limit(HISTORY_PAGE));
      const snap = await getDocs(q);
      for (const d of snap.docs) {
        const bet = { id: d.id, ...d.data() };
        if (isFinishedBet(bet) && !entry.bets.has(bet.id)) entry.bets.set(bet.id, bet);
      }
      if (snap.docs.length) entry.cursor = snap.docs[snap.docs.length - 1];
      if (snap.docs.length < HISTORY_PAGE) entry.done = true;
      notify(entry);
    }
  } catch (err) {
    entry.error = err?.message || 'Could not load your older bets.';
  } finally {
    entry.loading = false;
    notify(entry);
  }
}

// uid: the signed-in player; liveBets: the listener's bets; startAfterDoc: the listener's oldest doc; needed: the
// listener is full (older bets exist). Returns { bets (finished: remembered + history), loading, done, error, retry }.
export function useBetHistory({ uid, liveBets, startAfterDoc, needed }) {
  const [version, setVersion] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const cursorRef = useRef(startAfterDoc);
  cursorRef.current = startAfterDoc;

  // Remember every finished bet the listener shows (module memory only; sets no React state).
  useEffect(() => {
    if (!uid) return;
    const entry = cacheFor(uid);
    for (const bet of liveBets ?? []) if (isFinishedBet(bet)) entry.bets.set(bet.id, bet);
  }, [uid, liveBets]);

  // Subscribe to this player's history and start loading it once it's needed.
  useEffect(() => {
    if (!uid) return undefined;
    const entry = cacheFor(uid);
    const bump = () => setVersion((v) => v + 1);
    entry.subs.add(bump);
    if (needed && db && !entry.done && !entry.loading) {
      if (!entry.started) {
        entry.started = true;
        entry.cursor = cursorRef.current;
      }
      if (entry.cursor) loadAll(uid, entry);
      else entry.done = true;
    }
    return () => {
      entry.subs.delete(bump);
    };
  }, [uid, needed, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const entry = uid ? caches.get(uid) : null;
  // A new array only when the history changed (version) or the listener answered.
  const bets = useMemo(() => (entry ? [...entry.bets.values()] : []), [entry, version, liveBets]); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    bets,
    loading: Boolean(entry?.loading),
    done: !needed || Boolean(entry?.done),
    error: entry?.error ?? '',
    retry,
  };
}

// Test helper: forget every cached history.
export function clearBetHistory() {
  caches.clear();
}
