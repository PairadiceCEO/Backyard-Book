// Lets a page hold the wallet shown in the nav at a fixed amount for a moment (e.g. while slot reels
// spin, so the live balance doesn't reveal a win before the reels stop). null = show the real balance.

import { createContext, useContext, useMemo, useState } from 'react';

const WalletDisplayContext = createContext({ heldCents: null, setHeldCents: () => {} });

export function WalletDisplayProvider({ children }) {
  const [heldCents, setHeldCents] = useState(null);
  const value = useMemo(() => ({ heldCents, setHeldCents }), [heldCents]);
  return <WalletDisplayContext.Provider value={value}>{children}</WalletDisplayContext.Provider>;
}

export function useWalletDisplay() {
  return useContext(WalletDisplayContext);
}
