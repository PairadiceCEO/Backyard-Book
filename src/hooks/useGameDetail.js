// Polls one game (main lines + alternate lines) every 30 seconds, same rules as the board:
// pauses in hidden tabs, restarts only when the game changes, ignores answers for a game the user left.

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../lib/api.js';
import { usePolling } from './usePolling.js';

const POLL_MS = 30 * 1000;

export function useGameDetail(league, gameId) {
  const key = `${league}/${gameId}`;
  const [result, setResult] = useState({ key: null, data: null, error: '', notFound: false });
  const currentKeyRef = useRef(key);
  const inFlightRef = useRef(null);

  useEffect(() => {
    currentKeyRef.current = key;
    return () => {
      currentKeyRef.current = null;
    };
  }, [key]);

  const load = useCallback(async () => {
    const target = key;
    if (inFlightRef.current === target) return;
    inFlightRef.current = target;
    try {
      const data = await apiRequest(`/api/board?league=${encodeURIComponent(league)}&game=${encodeURIComponent(gameId)}`);
      if (currentKeyRef.current === target) setResult({ key: target, data, error: '', notFound: false });
    } catch (err) {
      if (currentKeyRef.current === target) {
        setResult((prev) => ({
          key: target,
          data: prev.key === target ? prev.data : null,
          error: err.message || 'Could not load this game.',
          notFound: err.status === 404,
        }));
      }
    } finally {
      if (inFlightRef.current === target) inFlightRef.current = null;
    }
  }, [key, league, gameId]);

  usePolling(load, POLL_MS, key);

  const isCurrent = result.key === key;
  const data = isCurrent ? result.data : null;
  return {
    game: data ? data.game : null,
    ladders: data ? data.ladders : null,
    fetchedAt: data ? data.fetchedAt : null,
    stale: data ? data.stale === true : false,
    kalshiStatus: data ? data.kalshiStatus || 'ok' : 'ok',
    error: isCurrent ? result.error : '',
    notFound: isCurrent ? result.notFound : false,
    loading: !isCurrent || (!result.data && !result.error),
  };
}
