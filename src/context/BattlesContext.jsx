// My Battles, live: one Firestore listener for the whole app (the Sportsbook badge, the Custom tab and
// My Bets all read it). The query is `participantUids array-contains my uid`, which is exactly what the
// Firestore rules allow a player to read. No orderBy (that would need a composite index); sorted here.

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { collection, limit, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../firebase.js';
import { useAuth } from './AuthContext.jsx';
import { battleNeedsMe, toMs } from '../lib/battles.js';

const MAX_BATTLES = 100;

const BattlesContext = createContext({ battles: [], loading: true, error: '', needsMeCount: 0, uid: null });

export function BattlesProvider({ children }) {
  const { authUser } = useAuth();
  const uid = authUser ? authUser.uid : null;
  const [state, setState] = useState({ uid: null, battles: [], error: '', loaded: false });

  // Subscribes once per signed-in player; removed on sign-out or unmount.
  useEffect(() => {
    if (!uid || !db) return undefined;
    const q = query(collection(db, 'battles'), where('participantUids', 'array-contains', uid), limit(MAX_BATTLES));
    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        const battles = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (toMs(b.createdAt) ?? 0) - (toMs(a.createdAt) ?? 0));
        setState({ uid, battles, error: '', loaded: true });
      },
      (err) => setState({ uid, battles: [], error: err.message || 'Could not load your Battles.', loaded: true }),
    );
    return unsubscribe;
  }, [uid]);

  const value = useMemo(() => {
    const current = state.uid === uid;
    const battles = current ? state.battles : [];
    const now = Date.now();
    return {
      uid,
      battles,
      loading: !current || !state.loaded,
      error: current ? state.error : '',
      needsMeCount: battles.filter((b) => battleNeedsMe(b, uid, now)).length,
    };
  }, [state, uid]);

  return <BattlesContext.Provider value={value}>{children}</BattlesContext.Provider>;
}

export function useBattles() {
  return useContext(BattlesContext);
}
