// Live hooks for a casino table: the public table doc, the server-time countdown, the tick that ends
// a timed phase, heartbeats while seated, and the one-by-one card reveal.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase.js';
import { lastCasinoCallAt, serverNow, tableAction } from '../lib/casino.js';
import { HEARTBEAT_SECONDS, TICK_JITTER_MS } from '../../shared/casino/constants.js';

// Which of two copies of the table doc is newer. Within one table (same epoch) the write counter decides: every write
// reads the doc and adds 1 to version inside its transaction, so version only ever goes up. updatedAt can't decide it:
// it is the request's start time, kept when Firestore retries the transaction, so a request that started earlier but
// committed later carries an older updatedAt on a newer table (0.17.2). A new epoch (the table doc was recreated)
// falls back to time.
export function newerTable(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.epoch && b.epoch && a.epoch === b.epoch) {
    const av = Number(a.version) || 0;
    const bv = Number(b.version) || 0;
    if (av !== bv) return av > bv ? a : b;
  }
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

// When the deadline passes, wait a random 0–800 ms (so every phone doesn't fire at once) and send tick. The server
// applies the default only once (and only once its own clock has passed the deadline). Until this table's deadline or
// phase changes, keep ticking every 2 s (plus up to 0.4 s jitter): a tick that lands early, fails (cold start, network)
// or loses to another phone's is simply sent again. 0.17.2: it used to give up after 5 tries, which could leave the
// table on its results for good when every phone's tries failed or came early.
// `call` (the page's useTableCall) shows the tick reply's table at once, so the next hand appears even when this
// phone's Firestore listener is slow or stalled; without it the reply is only used for the clock.
export const TICK_RETRY_MS = 2000;
const TICK_RETRY_JITTER_MS = 400;

export function useDeadlineTick(game, deadline, { enabled = true, call = null, phase = null } = {}) {
  const callRef = useRef(call);
  useEffect(() => {
    callRef.current = call;
  });
  useEffect(() => {
    if (!enabled || !game || !deadline) return undefined;
    let cancelled = false;
    let timer = null;

    const fire = async () => {
      if (cancelled) return;
      let next = TICK_RETRY_MS + Math.floor(Math.random() * TICK_RETRY_JITTER_MS);
      try {
        const reply = callRef.current ? await callRef.current('tick') : await tableAction(game, 'tick');
        // "Not yet": the server says when its deadline is; try again just after it rather than 2 s later.
        const due = reply?.applied === false && Number(reply?.deadline) === deadline ? deadline - serverNow() : null;
        if (due !== null && due > -TICK_RETRY_MS && due < TICK_RETRY_MS) next = Math.max(100, due + 100 + Math.floor(Math.random() * 300));
      } catch {
        // A failed tick is harmless: the next one (or another phone's) covers it.
      }
      if (!cancelled) timer = setTimeout(fire, next);
    };

    const wait = Math.max(0, deadline - serverNow()) + Math.floor(Math.random() * TICK_JITTER_MS);
    timer = setTimeout(fire, wait);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [game, deadline, phase, enabled]);
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
const MAX_EARLY_MS = 2000;

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
    // If this phone's clock reads a little before the deal time, the first card waits for the deal time
    // instead of the whole sequence starting early (at most 2 s, so a badly-set clock can't stall it).
    const elapsed = Math.max(serverNow() - at, -MAX_EARLY_MS);
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

// Leaving the table page (to the lobby, another tab or another game) gives up every seat the player
// holds there. Sent shortly after the page goes away and cancelled if the same table page comes straight
// back (React's development double-mount, or a quick back/forward), so a re-render never drops a seat.
// Closing the browser or losing the connection is still covered by the 60 s heartbeat rule.
const LEAVE_DELAY_MS = 400;
const pendingLeaves = new Map(); // game → timer

export function useLeaveOnExit(game, seated) {
  // The table this page was seated at, remembered past the render that switches games (Craps ↔
  // Crapless share a page), so the cleanup below still knows to leave the old one.
  const seatedAt = useRef(null);
  useEffect(() => {
    if (seated) seatedAt.current = game;
  }, [game, seated]);
  useEffect(() => {
    if (!game) return undefined;
    clearTimeout(pendingLeaves.get(game));
    pendingLeaves.delete(game);
    return () => {
      if (seatedAt.current !== game) return;
      seatedAt.current = null;
      const timer = setTimeout(() => {
        pendingLeaves.delete(game);
        tableAction(game, 'leave', { all: true }).catch(() => {});
      }, LEAVE_DELAY_MS);
      pendingLeaves.set(game, timer);
    };
  }, [game]);
}

// Several chip racks (one per seat) feed one "pending" figure for the nav wallet. pendingFor(key) gives a
// stable callback per seat; the total is passed on whenever any seat's pending amount changes.
export function usePendingTotal(setPendingCents) {
  const amounts = useRef(new Map());
  const callbacks = useRef(new Map());
  const setRef = useRef(setPendingCents);
  setRef.current = setPendingCents;
  return useCallback((key) => {
    if (!callbacks.current.has(key)) {
      callbacks.current.set(key, (cents) => {
        if ((amounts.current.get(key) ?? 0) === cents) return;
        amounts.current.set(key, cents);
        let total = 0;
        for (const v of amounts.current.values()) total += v;
        setRef.current(total);
      });
    }
    return callbacks.current.get(key);
  }, []);
}

// The player's seats at a table, in seat order, and which one the controls show: the seat that needs a
// decision now (its turn, or an undecided insurance) wins; otherwise the one last tapped; otherwise the first.
export function useSeatFocus(mySeats, needsAction) {
  const [preferred, setPreferred] = useState(null);
  const focus = needsAction ?? (mySeats.includes(preferred) ? preferred : (mySeats[0] ?? null));
  return [focus, setPreferred];
}
