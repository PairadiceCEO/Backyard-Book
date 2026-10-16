// Asks the server to settle finished bets. Called on app open and while My Bets is open.
// At most one request per minute from this browser (the server also skips runs under a minute apart),
// and failures are silent: settlement also runs from the admin button and the daily cron.

import { apiRequest } from './api.js';

const MIN_GAP_MS = 60 * 1000;
let lastAttemptMs = 0;
let inFlight = null;

export function requestSettlement() {
  if (inFlight) return inFlight;
  const now = Date.now();
  if (now - lastAttemptMs < MIN_GAP_MS) return Promise.resolve(null);
  lastAttemptMs = now;
  inFlight = apiRequest('/api/settle', { method: 'POST', body: {} })
    .catch((err) => {
      console.warn('Settlement request failed:', err.message);
      return null;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function previewSettlement() {
  return apiRequest('/api/settle', { method: 'POST', body: { preview: true } });
}

export function settleNow() {
  return apiRequest('/api/settle', { method: 'POST', body: { force: true } });
}
