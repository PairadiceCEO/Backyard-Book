// Polls /api/board for one league every 30 seconds (league null: nothing is loaded).
// Responses for a league the user has already switched away from are ignored.

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../lib/api.js';
import { usePolling } from './usePolling.js';

const BOARD_POLL_MS = 30 * 1000;

export function useBoard(league) {
  const [result, setResult] = useState({ league: null, data: null, error: '' });
  const currentLeagueRef = useRef(league);
  const inFlightRef = useRef(null);

  // Track which league is on screen (null after unmount) so late responses can be dropped.
  useEffect(() => {
    currentLeagueRef.current = league;
    return () => {
      currentLeagueRef.current = null;
    };
  }, [league]);

  const load = useCallback(async () => {
    const target = league;
    if (!target) return;
    if (inFlightRef.current === target) return; // a request for this league is already running
    inFlightRef.current = target;
    try {
      const data = await apiRequest(`/api/board?league=${encodeURIComponent(target)}`);
      if (currentLeagueRef.current === target) {
        setResult({ league: target, data, error: '' });
      }
    } catch (err) {
      if (currentLeagueRef.current === target) {
        setResult((prev) => ({
          league: target,
          data: prev.league === target ? prev.data : null, // keep the last good board on a failed refresh
          error: err.message || 'Could not load games.',
        }));
      }
    } finally {
      if (inFlightRef.current === target) inFlightRef.current = null;
    }
  }, [league]);

  usePolling(load, BOARD_POLL_MS, league);

  const isCurrent = result.league === league;
  const data = isCurrent ? result.data : null;
  return {
    games: data ? data.games : null,
    fetchedAt: data ? data.fetchedAt : null,
    stale: data ? data.stale === true : false,
    partial: data ? data.partial === true : false,
    kalshiStatus: data ? data.kalshiStatus || 'ok' : 'ok',
    error: isCurrent ? result.error : '',
    loading: !isCurrent || (!result.data && !result.error),
    retry: load,
  };
}
