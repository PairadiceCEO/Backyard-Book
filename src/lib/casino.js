// Calls POST /api/casino with the signed-in player's token.

import { apiRequest, makeRequestId } from './api.js';

export function casinoAction(action, fields = {}) {
  return apiRequest('/api/casino', { method: 'POST', body: { action, ...fields } });
}

export function spinSlots(amountDollars) {
  return casinoAction('spin', { amount: amountDollars, requestId: makeRequestId() });
}
