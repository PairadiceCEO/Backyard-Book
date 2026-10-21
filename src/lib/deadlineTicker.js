// The client's "move the table on" ticker (0.18.1), kept free of React so it can be tested with fake timers.
//
// After a table's deadline passes, every open phone asks the server (action "tick") to move on; the first valid one wins and
// the rest are no-ops. Rules:
//   - the first tick goes 0–TICK_JITTER_MS after the deadline;
//   - while it keeps failing or isn't due yet: every 2 s (+ up to 400 ms of jitter) for the first 30 s after the deadline,
//     then every 10 s (+ up to 2 s of jitter), so a broken server (or a spent Firestore quota) is not hammered by every phone;
//   - nothing is sent while the page is hidden; one tick goes the moment it is visible again;
//   - a reply that says "not yet, the deadline is X" aims the next tick just after X.
// The caller stops it (the returned function) when the deadline or phase changes: a reply that moves the table restarts it.

export const TICK_FAST_MS = 2000;
export const TICK_FAST_JITTER_MS = 400;
export const TICK_FAST_WINDOW_MS = 30_000;
export const TICK_SLOW_MS = 10_000;
export const TICK_SLOW_JITTER_MS = 2000;

// Delay before the next retry, given how long ago the deadline passed.
export function tickRetryDelay(lateMs, random = Math.random) {
  return lateMs < TICK_FAST_WINDOW_MS
    ? TICK_FAST_MS + Math.floor(random() * TICK_FAST_JITTER_MS)
    : TICK_SLOW_MS + Math.floor(random() * TICK_SLOW_JITTER_MS);
}

export function startDeadlineTicker({ deadline, jitterMs, send, now, isVisible = () => true, onVisible = () => () => {}, random = Math.random }) {
  let cancelled = false;
  let timer = null;
  let waitingForVisible = false;
  let inFlight = false;

  const schedule = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(fire, ms);
  };

  async function fire() {
    if (cancelled || inFlight) return;
    if (!isVisible()) {
      waitingForVisible = true; // no tick while hidden; the visibility listener sends one
      return;
    }
    waitingForVisible = false;
    inFlight = true;
    let next = tickRetryDelay(now() - deadline, random);
    try {
      const reply = await send();
      // "Not yet": the server says when its deadline is; try again just after it rather than 2 s later.
      const due = reply?.applied === false && Number(reply?.deadline) === deadline ? deadline - now() : null;
      if (due !== null && due > -TICK_FAST_MS && due < TICK_FAST_MS) next = Math.max(100, due + 100 + Math.floor(random() * 300));
    } catch {
      // A failed tick is harmless: the next one (or another phone's) covers it.
    }
    inFlight = false;
    if (!cancelled) schedule(next);
  }

  const stopListening = onVisible(() => {
    if (cancelled || !isVisible() || !waitingForVisible) return;
    clearTimeout(timer);
    fire();
  });

  schedule(Math.max(0, deadline - now()) + Math.floor(random() * jitterMs));
  return () => {
    cancelled = true;
    clearTimeout(timer);
    stopListening();
  };
}
