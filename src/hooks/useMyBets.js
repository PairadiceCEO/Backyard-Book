// Live list of the signed-in player's bets, newest first (needs the bets: uid + placedAt index).

import { useCallback, useEffect, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '../firebase.js';
import { useAuth } from '../context/AuthContext.jsx';

const MAX_BETS = 200;

export function useMyBets() {
  const { authUser } = useAuth();
  const uid = authUser ? authUser.uid : null;
  const [result, setResult] = useState({ uid: null, bets: [], error: '', loaded: false });
  const [attempt, setAttempt] = useState(0); // bumped by retry() to re-subscribe after an error

  // Subscribes once per signed-in user (and again on retry); the listener is removed on unmount or sign-out.
  useEffect(() => {
    if (!uid || !db) return undefined;
    const q = query(collection(db, 'bets'), where('uid', '==', uid), orderBy('placedAt', 'desc'), limit(MAX_BETS));
    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        setResult({ uid, bets: snap.docs.map((d) => ({ id: d.id, ...d.data() })), error: '', loaded: true });
      },
      (err) => {
        setResult({ uid, bets: [], error: err.message || 'Could not load your bets.', loaded: true });
      },
    );
    return unsubscribe;
  }, [uid, attempt]);

  const retry = useCallback(() => {
    setResult((prev) => ({ ...prev, error: '', loaded: false }));
    setAttempt((n) => n + 1);
  }, []);

  const current = result.uid === uid;
  return {
    bets: current ? result.bets : [],
    error: current ? result.error : '',
    loading: !current || !result.loaded,
    retry,
  };
}
