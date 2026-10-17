// Chip betting that feels instant. A tap puts the chip on the felt at once; taps within BATCH_MS of
// each other go to the server as one request (one at a time, never overlapping). If the server
// refuses, those chips come back off and the reason is shown. Undo takes back the last chip placed this
// round; Clear takes back every chip placed this round.
//
//   spots      { [spotKey]: cents } as the server has them (from the table doc)
//   roundKey   changes when a new round starts: the Undo history starts over
//   validate   (spotKey, newCents, spotsAfter) → reason string, or '' if the chip may go down
//   send       async (changes, totalsAfter) → sends one batch: changes = [{ spot, cents (±) }]
//   onPending  (cents) → chips not confirmed yet, so the wallet can show them as spent

import { useCallback, useEffect, useRef, useState } from 'react';

export const BATCH_MS = 300;

function sumBy(ops) {
  const out = {};
  for (const op of ops) out[op.spot] = (out[op.spot] ?? 0) + op.cents;
  return out;
}

export function useChipBetting({ spots, roundKey, validate, send, onPending, enabled = true }) {
  const [queued, setQueued] = useState([]); // tapped, not sent yet
  const [inFlight, setInFlight] = useState([]); // sent, waiting for the reply
  const [history, setHistory] = useState([]); // chips placed this round, in order: [{ spot, cents }]
  const [error, setError] = useState('');

  const queuedRef = useRef([]);
  const inFlightRef = useRef([]);
  const historyRef = useRef([]);
  const timerRef = useRef(null);
  const sendRef = useRef(send);
  const spotsRef = useRef(spots);
  const waitersRef = useRef([]);
  sendRef.current = send;
  spotsRef.current = spots;

  const setQ = (next) => {
    queuedRef.current = next;
    setQueued(next);
  };
  const setF = (next) => {
    inFlightRef.current = next;
    setInFlight(next);
  };
  const setH = (next) => {
    historyRef.current = next;
    setHistory(next);
  };

  // A new round: the Undo history starts over (anything still queued is dropped with it).
  useEffect(() => {
    clearTimeout(timerRef.current);
    queuedRef.current = [];
    historyRef.current = [];
    setQueued([]);
    setHistory([]);
    setError('');
  }, [roundKey]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const settleWaiters = () => {
    if (inFlightRef.current.length || queuedRef.current.length) return;
    const waiters = waitersRef.current;
    waitersRef.current = [];
    waiters.forEach((resolve) => resolve());
  };

  const flush = useCallback(async () => {
    clearTimeout(timerRef.current);
    if (inFlightRef.current.length || !queuedRef.current.length) return;
    const batch = queuedRef.current;
    setQ([]);
    setF(batch);
    const deltas = sumBy(batch);
    const totals = { ...spotsRef.current };
    for (const [spot, cents] of Object.entries(deltas)) totals[spot] = (totals[spot] ?? 0) + cents;
    try {
      await sendRef.current(
        Object.entries(deltas)
          .filter(([, cents]) => cents !== 0)
          .map(([spot, cents]) => ({ spot, cents })),
        totals,
      );
    } catch (err) {
      // Refused: these chips come back off; an Undo that failed puts its chip back in the history.
      let next = [...historyRef.current];
      for (const op of batch) {
        if (op.cents > 0) {
          const at = next.map((h) => h.id).lastIndexOf(op.id);
          if (at !== -1) next.splice(at, 1);
        } else {
          next.push({ id: op.id, spot: op.spot, cents: -op.cents });
        }
      }
      setH(next);
      if (err?.code !== 'STALE') setError(err?.message || 'That bet was refused.');
    } finally {
      setF([]);
    }
    if (queuedRef.current.length) flush();
    else settleWaiters();
  }, []);

  const schedule = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, BATCH_MS);
  }, [flush]);

  const current = { ...spots };
  for (const op of [...inFlight, ...queued]) current[op.spot] = (current[op.spot] ?? 0) + op.cents;
  const pendingCents = [...inFlight, ...queued].reduce((s, op) => s + op.cents, 0);

  useEffect(() => {
    onPending?.(pendingCents);
  }, [pendingCents, onPending]);
  useEffect(() => () => onPending?.(0), [onPending]);

  const nextId = useRef(1);
  const place = useCallback(
    (spot, cents) => {
      if (!enabled) return false;
      const now = { ...spotsRef.current };
      for (const op of [...inFlightRef.current, ...queuedRef.current]) now[op.spot] = (now[op.spot] ?? 0) + op.cents;
      const after = { ...now, [spot]: (now[spot] ?? 0) + cents };
      const reason = validate ? validate(spot, after[spot], after) : '';
      if (reason) {
        setError(reason);
        return false;
      }
      setError('');
      const id = nextId.current++;
      setQ([...queuedRef.current, { id, spot, cents }]);
      setH([...historyRef.current, { id, spot, cents }]);
      schedule();
      return true;
    },
    [enabled, validate, schedule],
  );

  const undo = useCallback(() => {
    if (!enabled || !historyRef.current.length) return;
    const last = historyRef.current[historyRef.current.length - 1];
    setH(historyRef.current.slice(0, -1));
    setError('');
    // Not sent yet? Just drop it. Otherwise take it back from the server.
    const at = queuedRef.current.findIndex((op) => op.id === last.id);
    if (at !== -1) {
      setQ(queuedRef.current.filter((_, i) => i !== at));
      return;
    }
    setQ([...queuedRef.current, { id: last.id, spot: last.spot, cents: -last.cents }]);
    schedule();
  }, [enabled, schedule]);

  const clear = useCallback(() => {
    if (!enabled || !historyRef.current.length) return;
    const sent = historyRef.current.filter((h) => !queuedRef.current.some((op) => op.id === h.id));
    setH([]);
    setError('');
    setQ(sent.map((h) => ({ id: h.id, spot: h.spot, cents: -h.cents })));
    if (sent.length) schedule();
  }, [enabled, schedule]);

  // Sends anything waiting now and resolves when every chip is confirmed (e.g. before Confirm / Roll).
  const flushNow = useCallback(() => {
    if (!queuedRef.current.length && !inFlightRef.current.length) return Promise.resolve();
    const done = new Promise((resolve) => waitersRef.current.push(resolve));
    flush();
    return done;
  }, [flush]);

  return {
    spots: current,
    pendingCents,
    busy: inFlight.length > 0 || queued.length > 0,
    canUndo: enabled && history.length > 0,
    place,
    undo,
    clear,
    flushNow,
    error,
    setError,
  };
}
