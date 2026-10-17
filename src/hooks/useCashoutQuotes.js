// Cash out estimates for the player's open bets, refreshed every 30 seconds (like the board) while the
// page is visible. The server computes every value; this only displays them.
//
// Loop safety: the poll restarts only when the set of open bet ids changes (a string key), the latest
// ids are read from a ref, and state is set only when a reply arrives (never during render).

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../lib/api.js';
import { usePolling } from './usePolling.js';

export const CASHOUT_REFRESH_MS = 30 * 1000;
const MAX_IDS = 50;

export function useCashoutQuotes(betIds) {
  const idsKey = [...betIds].sort().join('|');
  const idsRef = useRef(betIds);
  idsRef.current = betIds;
  const [quotes, setQuotes] = useState({});
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const ids = idsRef.current.slice(0, MAX_IDS);
    if (ids.length === 0 || inFlight.current) return;
    inFlight.current = true;
    try {
      const data = await apiRequest('/api/bets', { method: 'POST', body: { action: 'cashoutQuote', betIds: ids } });
      if (mounted.current) setQuotes(data?.quotes ?? {});
    } catch {
      // Keep the last estimates; the next refresh tries again.
    } finally {
      inFlight.current = false;
    }
  }, []);

  usePolling(refresh, CASHOUT_REFRESH_MS, idsKey);

  // The confirm flow learns newer values (CASHOUT_CHANGED / unavailable) before the next refresh.
  const setQuote = useCallback((betId, quote) => {
    setQuotes((prev) => ({ ...prev, [betId]: quote }));
  }, []);

  return { quotes, setQuote, refresh };
}
