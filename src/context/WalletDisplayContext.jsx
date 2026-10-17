// What the nav wallet shows while the casino is busy:
//   heldCents     a page can pin the wallet for a moment (e.g. while cards turn over or slot reels spin,
//                 so the live balance doesn't give the result away early). null = not pinned.
//   pendingCents  chips on the felt that the server hasn't confirmed yet: shown as already spent.
//   reportBalance the balance an API reply just returned; shown until the live users-doc listener
//                 catches up (it's cleared the moment the profile changes).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext.jsx';

const WalletDisplayContext = createContext({
  heldCents: null,
  setHeldCents: () => {},
  pendingCents: 0,
  setPendingCents: () => {},
  reportBalance: () => {},
  displayCents: (profileCents) => profileCents,
});

export function WalletDisplayProvider({ children }) {
  const { profile } = useAuth();
  const profileCents = Number(profile?.balanceCents) || 0;
  const [heldCents, setHeldCents] = useState(null);
  const [pendingCents, setPendingCents] = useState(0);
  const [reported, setReported] = useState(null); // { cents, baseline }
  const profileRef = useRef(profileCents);
  profileRef.current = profileCents;

  // The listener brought a new balance: it's the truth again.
  useEffect(() => {
    setReported(null);
  }, [profileCents]);

  const reportBalance = useCallback((cents) => {
    if (!Number.isFinite(cents)) return;
    setReported(cents === profileRef.current ? null : { cents, baseline: profileRef.current });
  }, []);

  const displayCents = useCallback(
    (cents) => {
      if (heldCents !== null) return heldCents;
      const base = reported && reported.baseline === cents ? reported.cents : cents;
      return base - pendingCents;
    },
    [heldCents, reported, pendingCents],
  );

  const value = useMemo(
    () => ({ heldCents, setHeldCents, pendingCents, setPendingCents, reportBalance, displayCents }),
    [heldCents, pendingCents, reportBalance, displayCents],
  );
  return <WalletDisplayContext.Provider value={value}>{children}</WalletDisplayContext.Provider>;
}

export function useWalletDisplay() {
  return useContext(WalletDisplayContext);
}
