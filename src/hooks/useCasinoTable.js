// Live hooks for a casino table: the public table doc, the server-time countdown, the tick that ends
// a timed phase, heartbeats while seated, and the one-by-one card reveal.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase.js';
import { lastCasinoCallAt, serverNow, tableAction } from '../lib/casino.js';
import { HEARTBEAT_SECONDS, TICK_JITTER_MS } from '../../shared/casino/constants.js';

// Which of two copies of the table doc is newer (server time, then version).
function newerTable(a, b) {
  if (!a) return b;
  if (!b) return a;
  const at = Number(a.updatedAt) || 0;
  const bt = Number(b.updatedAt) || 0;
  if (at !== bt) return at > bt ? a : b;
  return (Number(b.version) || 0) > (Number(a.version) || 0) ? b : a;
}

// One onSnapshot listener on casinoTables/{game}. table is null until someone first sits down.
// accept(table) takes the copy an API reply carried: the caller's own action shows at once, and the
// listener's copy wins again as soon as it's as new.
export function useCasinoTable(game) {
  const [state, setState] = useState({ table: null, loading: true, error: '' });
  const [fromReply, setFromReply] = useState(null);

  useEffect(() => {
    setFromReply(null);
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

  const accept = useCallback((table) => {
    if (table && typeof table === 'object') setFromReply((prev) => newerTable(prev, table));
  }, []);

  const table = newerTable(state.table, fromReply);
  return { table, loading: state.loading && !fromReply, error: state.error, accept };
}

// Calls a table action and shows its result at once: the reply's table (accept) and wallet
// (reportBalance). Everyone else still sees it through their listener.
export function useTableCall(game, accept, reportBalance) {
  return useCallback(
    async (action, fields = {}) => {
      const reply = await tableAction(game, action, fields);
      if (reply?.table) accept(reply.table);
      if (Number.isFinite(reply?.balanceCents)) reportBalance(reply.balanceCents);
      return reply;
    },
    [game, accept, reportBalance],
  );
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

// How many of a write's cards are face up right now. offsets: when each card turns over, in ms after
// `at` (the server's time of the deal), so every phone shows the same card at the same moment and a
// phone that arrives late shows the cards already dealt. A layout effect, so a fresh deal never
// flashes every card face up for one frame.
export function useTimedReveal(at, offsets) {
  const key = offsets.join(',');
  const count = offsets.length;
  const [shown, setShown] = useState(count);

  useLayoutEffect(() => {
    const times = key ? key.split(',').map(Number) : [];
    if (!at || !times.length) {
      setShown(times.length);
      return undefined;
    }
    const elapsed = Math.max(0, serverNow() - at);
    const already = times.filter((t) => t <= elapsed).length;
    setShown(already);
    const timers = [];
    for (let i = already; i < times.length; i += 1) {
      timers.push(setTimeout(() => setShown(i + 1), times[i] - elapsed));
    }
    return () => timers.forEach(clearTimeout);
  }, [at, key]);

  return Math.min(shown, count);
}

// True while a roll that the server made at `at` (server ms) is still tumbling on screen.
// A phone that opens the page later just shows the dice.
export function useRollAnimation(at, durationMs) {
  const [rolling, setRolling] = useState(false);

  useLayoutEffect(() => {
    if (!at) {
      setRolling(false);
      return undefined;
    }
    const left = at + durationMs - serverNow();
    if (left <= 0) {
      setRolling(false);
      return undefined;
    }
    setRolling(true);
    const timer = setTimeout(() => setRolling(false), left);
    return () => clearTimeout(timer);
  }, [at, durationMs]);

  return rolling;
}
