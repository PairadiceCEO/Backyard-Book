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

function noteServerTime(serverTime, sentAt, receivedAt) {
  if (!Number.isFinite(serverTime)) return;
  const roundTrip = receivedAt - sentAt;
  // A fast reply measures the offset best; old measurements age out slowly so drift is picked up.
  bestRoundTripMs = Math.min(bestRoundTripMs * 1.05 + 5, 60_000);
  if (roundTrip <= bestRoundTripMs) {
    bestRoundTripMs = roundTrip;
    offsetMs = serverTime - (sentAt + receivedAt) / 2;
  }
}

export async function casinoAction(action, fields = {}) {
  const sentAt = Date.now();
  const data = await apiRequest('/api/casino', { method: 'POST', body: { action, ...fields } });
  const receivedAt = Date.now();
  lastSuccessAt = receivedAt;
  noteServerTime(data?.serverNow, sentAt, receivedAt);
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
