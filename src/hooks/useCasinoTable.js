// Live hooks for a casino table: the public table doc, the server-time countdown, the tick that ends
// a timed phase, heartbeats while seated, and the one-by-one card reveal.

import { useEffect, useLayoutEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase.js';
import { lastCasinoCallAt, serverNow, tableAction } from '../lib/casino.js';
import { HEARTBEAT_SECONDS, TICK_JITTER_MS } from '../../shared/casino/constants.js';

// One onSnapshot listener on casinoTables/{game}. table is null until someone first sits down.
export function useCasinoTable(game) {
  const [state, setState] = useState({ table: null, loading: true, error: '' });

  useEffect(() => {
    if (!db || !game) {
      setState({ table: null, loading: false, error: '' });
      return undefined;
    }
    setState({ table: null, loading: true, error: '' });
    const unsubscribe = onSnapshot(
      doc(db, 'casinoTables', game),
      (snap) => setState({ table: snap.exists() ? snap.data() : null, loading: false, error: '' }),
      (err) => setState({ table: null, loading: false, error: err.message || 'Could not load the table.' }),
    );
    return unsubscribe;
  }, [game]);

  return state;
}

// Whole seconds left until `deadline` (server ms), or null with no deadline. Re-renders once a second.
export function useCountdown(deadline) {
  const [seconds, setSeconds] = useState(() => (deadline ? Math.max(0, Math.ceil((deadline - serverNow()) / 1000)) : null));

  useEffect(() => {
    if (!deadline) {
      setSeconds(null);
      return undefined;
    }
    const update = () => setSeconds(Math.max(0, Math.ceil((deadline - serverNow()) / 1000)));
    update();
    const id = setInterval(update, 250); // same value → React skips the re-render
    return () => clearInterval(id);
  }, [deadline]);

  return seconds;
}

// When the deadline passes, wait a random 0–800 ms (so every phone doesn't fire at once) and send tick.
// The server applies the default only once; if the table still shows the same deadline a little later
// (another phone's tick hasn't landed, or the clocks disagree), tick again, up to 5 times.
export function useDeadlineTick(game, deadline, enabled = true) {
  useEffect(() => {
    if (!enabled || !game || !deadline) return undefined;
    let cancelled = false;
    let timer = null;
    let attempts = 0;

    const fire = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        await tableAction(game, 'tick');
      } catch {
        // A failed tick is harmless; the retry below or another phone covers it.
      }
      if (!cancelled && attempts < 5) timer = setTimeout(fire, 2500);
    };

    const wait = Math.max(0, deadline - serverNow()) + Math.floor(Math.random() * TICK_JITTER_MS);
    timer = setTimeout(fire, wait);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [game, deadline, enabled]);
}

// Every 20 s while seated and the page is visible. Skipped when any casino call finished in the last
// 20 s (that call already counted as "still here"). Also sent when the page becomes visible again.
export function useHeartbeat(game, seated) {
  useEffect(() => {
    if (!game || !seated) return undefined;
    const beat = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastCasinoCallAt() < HEARTBEAT_SECONDS * 1000 - 1000) return;
      tableAction(game, 'heartbeat').catch(() => {});
    };
    const id = setInterval(beat, HEARTBEAT_SECONDS * 1000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') beat();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [game, seated]);
}

// How many of a deal's cards are face up, given when the server dealt them (server ms) and the gap
// between cards. A phone that opens the page late shows the cards already turned at once.
// A layout effect, so a fresh deal never flashes every card face up for one frame.
export function useCardReveal(dealtAt, cardCount, gapMs) {
  const [shown, setShown] = useState(cardCount);

  useLayoutEffect(() => {
    if (!dealtAt || !cardCount) {
      setShown(cardCount);
      return undefined;
    }
    const elapsed = Math.max(0, serverNow() - dealtAt);
    const already = Math.min(cardCount, Math.floor(elapsed / gapMs) + 1);
    setShown(already);
    const timers = [];
    for (let i = already; i < cardCount; i += 1) {
      timers.push(setTimeout(() => setShown(i + 1), i * gapMs - elapsed));
    }
    return () => timers.forEach(clearTimeout);
  }, [dealtAt, cardCount, gapMs]);

  return shown;
}
