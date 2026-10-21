// Calls POST /api/casino with the signed-in player's token, and keeps the phone's estimate of the
// server's clock. Every reply carries serverNow; the offset from the reply with the fastest round trip
// wins, so countdowns on every phone count down against the same (server) time.

import { apiRequest, makeRequestId } from './api.js';

let offsetMs = 0;
let bestRoundTripMs = Infinity;
let lastSuccessAt = 0;

// Current time on the server, in ms.
export function serverNow() {
  return Date.now() + offsetMs;
}

// When this phone last completed any casino call (heartbeats are skipped if that was recent).
export function lastCasinoCallAt() {
  return lastSuccessAt;
}

// serverStart / serverTime: when the server started and finished the request. Their midpoint matches the midpoint of
// this phone's send and receive (0.17.2: using only the finish time, stamped after the server's work, made phones think
// the server was ahead by about half that work, so countdowns hit 0 and ticks went out a few hundred ms early). The
// network part of the round trip (minus the server's work) says how good the measurement is.
function noteServerTime(serverTime, sentAt, receivedAt, serverStart) {
  if (!Number.isFinite(serverTime)) return;
  const work = Number.isFinite(serverStart) && serverStart <= serverTime ? serverTime - serverStart : 0;
  const serverMid = serverTime - work / 2;
  const roundTrip = Math.max(0, receivedAt - sentAt - work);
  // A fast reply measures the offset best; old measurements age out slowly so drift is picked up.
  bestRoundTripMs = Math.min(bestRoundTripMs * 1.05 + 5, 60_000);
  if (roundTrip <= bestRoundTripMs) {
    bestRoundTripMs = roundTrip;
    offsetMs = serverMid - (sentAt + receivedAt) / 2;
  }
}

export async function casinoAction(action, fields = {}) {
  const sentAt = Date.now();
  const data = await apiRequest('/api/casino', { method: 'POST', body: { action, ...fields } });
  const receivedAt = Date.now();
  lastSuccessAt = receivedAt;
  noteServerTime(data?.serverNow, sentAt, receivedAt, data?.serverStart);
  return data;
}

export function spinSlots(amountDollars) {
  return casinoAction('spin', { amount: amountDollars, requestId: makeRequestId() });
}

// Table actions: sit, leave, heartbeat, tick, and each game's own (bet, confirm, …).
export function tableAction(game, action, fields = {}) {
  return casinoAction(action, { game, ...fields });
}

export function newRequestId() {
  return makeRequestId();
}
