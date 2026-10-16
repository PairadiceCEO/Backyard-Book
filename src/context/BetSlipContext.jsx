// Holds the bet slip for the signed-in session; survives switching tabs, resets on sign out.

import { createContext, useContext, useMemo, useReducer } from 'react';
import { betSlipReducer, initialSlipState } from '../lib/betSlipReducer.js';

const BetSlipContext = createContext(null);

export function BetSlipProvider({ children }) {
  const [state, dispatch] = useReducer(betSlipReducer, initialSlipState);

  // dispatch is stable, so these helpers only change when the slip state changes.
  const value = useMemo(() => {
    const selected = new Set(state.legs.map((l) => l.legId));
    return {
      state,
      isSelected: (legId) => selected.has(legId),
      toggle: (pick) => dispatch({ type: 'toggle', pick }),
      remove: (legId) => dispatch({ type: 'remove', legId }),
      setMode: (mode) => dispatch({ type: 'setMode', mode }),
      setStake: (legId, value) => dispatch({ type: 'setStake', legId, value }),
      setParlayStake: (value) => dispatch({ type: 'setParlayStake', value }),
      serverRejected: (details) => dispatch({ type: 'serverRejected', ...details }),
      accept: (legId) => dispatch({ type: 'accept', legId }),
      acceptAll: () => dispatch({ type: 'acceptAll' }),
      clear: () => dispatch({ type: 'clear' }),
      dismissNotice: () => dispatch({ type: 'dismissNotice' }),
    };
  }, [state]);

  return <BetSlipContext.Provider value={value}>{children}</BetSlipContext.Provider>;
}

export function useBetSlip() {
  const value = useContext(BetSlipContext);
  if (!value) throw new Error('useBetSlip must be used inside <BetSlipProvider>.');
  return value;
}
