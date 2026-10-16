// Tracks the signed-in user, their admin claim, and a live copy of their users/{uid} doc (wallet).

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, db } from '../firebase.js';
import { usernameToEmail } from '../../shared/constants.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [authUser, setAuthUser] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [authReady, setAuthReady] = useState(false);

  const [profile, setProfile] = useState(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [profileError, setProfileError] = useState('');

  // 1. Firebase Auth state. Runs once; the listener is removed on unmount.
  useEffect(() => {
    if (!auth) {
      setAuthReady(true);
      return undefined;
    }
    let latestRun = 0;
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      latestRun += 1;
      const run = latestRun;
      let admin = false;
      if (user) {
        try {
          const tokenResult = await user.getIdTokenResult();
          admin = tokenResult.claims.admin === true;
        } catch {
          admin = false;
        }
      }
      if (run !== latestRun) return; // a newer auth change already arrived
      setIsAdmin(admin);
      setAuthUser(user);
      setAuthReady(true);
    });
    return unsubscribe;
  }, []);

  const uid = authUser ? authUser.uid : null;

  // 2. Live wallet/profile listener. Re-subscribes only when the uid changes.
  useEffect(() => {
    if (!uid || !db) {
      setProfile(null);
      setProfileLoaded(false);
      setProfileError('');
      return undefined;
    }
    setProfileLoaded(false);
    setProfileError('');
    const unsubscribe = onSnapshot(
      doc(db, 'users', uid),
      (snap) => {
        setProfile(snap.exists() ? { id: snap.id, ...snap.data() } : null);
        setProfileLoaded(true);
      },
      (err) => {
        setProfileError(err.message || 'Could not load your profile.');
        setProfileLoaded(true);
      },
    );
    return unsubscribe;
  }, [uid]);

  const signIn = useCallback(async (username, password) => {
    if (!auth) throw new Error('Firebase is not configured.');
    await signInWithEmailAndPassword(auth, usernameToEmail(username), password);
  }, []);

  const signOut = useCallback(async () => {
    if (!auth) return;
    await firebaseSignOut(auth);
  }, []);

  const value = useMemo(
    () => ({
      authUser,
      isAdmin,
      authReady,
      profile,
      profileLoaded,
      profileError,
      signIn,
      signOut,
    }),
    [authUser, isAdmin, authReady, profile, profileLoaded, profileError, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>.');
  return value;
}
