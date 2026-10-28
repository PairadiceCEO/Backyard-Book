// Chip betting that feels instant. A tap puts the chip on the felt at once; taps within BATCH_MS of
// each other go to the server as one request (one at a time, never overlapping). If the server
// refuses, those chips come back off and the reason is shown. Undo takes back the last chip placed this
// round; Clear takes back every chip placed this round.
// Every tap counts (0.23.0): there is no limit on taps and none is ever dropped without a reason on screen; a tap the
// page can't take right now (a refusal by validate) shows why. tools/phone-check/tapcheck.mjs taps 10 quick chips on
// every game against the real engines.
//
//   spots      { [spotKey]: cents } as the server has them (from the table doc)
//   roundKey   changes when a new round starts: the Undo history starts over
//   validate   (spotKey, newCents, spotsAfter) → reason string, or '' if the chip may go down
//   send       async (changes, totalsAfter) → sends one batch: changes = [{ spot, cents (±) }]. Games that send absolute
//              totals (Blackjack, Baccarat) resolve with the server's spots after the change ({ [spotKey]: cents });
//              the next batch is then built on those, not on the table doc this page may not have re-rendered yet
//              (0.17.2: Clear / Undo / more chips while a batch was in flight used to send a stale or negative
//              total). Craps sends deltas and resolves with nothing: its spots come from the table doc as before.
//   onPending  (cents) → chips not confirmed yet, so the wallet can show them as spent

import { useCallback, useEffect, useRef, useState } from 'react';
import { playSound } from '../lib/casinoSound.js';

export const BATCH_MS = 300;
export const BET_CHANGED_MESSAGE = 'Your bet changed, try again';

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
  // spotsRef = what the server holds: the table doc's spots whenever they change, or what the last reply said (which
  // can be newer than the props of this render). Only a change of the prop overwrites it.
  const lastPropSpotsRef = useRef(spots);
  sendRef.current = send;
  if (spots !== lastPropSpotsRef.current) {
    lastPropSpotsRef.current = spots;
    spotsRef.current = spots;
  }

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

  // A new round: the Undo history starts over, except for chips tapped but not sent yet. 0.23.0: those used to be dropped
  // here, so at craps a roll landing in the middle of quick taps (another player's roll, or the listener catching up) lost
  // every tap still waiting in the 300 ms batch. Now they still go to the server (it is the judge; a bet the new round
  // doesn't allow comes back off with the reason), and Undo can still take them back.
  // An Undo / Clear still waiting belonged to the round that just ended, so it is dropped (its chips were decided by it).
  useEffect(() => {
    const waiting = queuedRef.current.filter((op) => op.cents > 0);
    if (waiting.length !== queuedRef.current.length) {
      queuedRef.current = waiting;
      setQueued(waiting);
    }
    historyRef.current = historyRef.current.filter((h) => waiting.some((op) => op.id === h.id));
    setHistory(historyRef.current);
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
    // Refused (or never sent): these chips come back off; an Undo that failed puts its chip back in the history.
    const giveBack = () => {
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
    };
    try {
      // A total below $0 means the bet changed under us (e.g. a new round, another phone): never send it.
      if (Object.values(totals).some((cents) => cents < 0)) {
        giveBack();
        setError(BET_CHANGED_MESSAGE);
      } else {
        const confirmed = await sendRef.current(
          Object.entries(deltas)
            .filter(([, cents]) => cents !== 0)
            .map(([spot, cents]) => ({ spot, cents })),
          totals,
        );
        // The server's spots after this batch: the next batch builds on them.
        if (confirmed && typeof confirmed === 'object') {
          const clean = Object.fromEntries(Object.entries(confirmed).filter(([, cents]) => Number.isInteger(cents) && cents >= 0));
          spotsRef.current = { ...spotsRef.current, ...clean };
        }
      }
    } catch (err) {
      giveBack();
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

  // On screen: the server's amounts (the newest we know) plus chips not confirmed yet.
  const current = { ...spotsRef.current };
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
      playSound('chip'); // 0.20.0: a chip going down (sound only; the batching is unchanged)
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
