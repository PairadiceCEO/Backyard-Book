// Battles on the phone: calls to /api/battles and small helpers for showing a Battle.
// Every value that moves money is decided by the server; these only display.

import { apiRequest } from './api.js';

export function battleAction(action, fields = {}) {
  return apiRequest('/api/battles', { method: 'POST', body: { action, ...fields } });
}

export function toMs(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value === 'object' && Number.isFinite(value.seconds)) return value.seconds * 1000;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function myPart(battle, uid) {
  return (battle?.participants ?? []).find((p) => p.uid === uid) ?? null;
}

export function isExpired(battle, now = Date.now()) {
  const exp = toMs(battle?.expiresAt);
  return battle?.status === 'pending' && exp !== null && now >= exp;
}

// Something for me to do: an invite to answer, or a payout change to keep or withdraw from.
export function battleNeedsMe(battle, uid, now = Date.now()) {
  const me = myPart(battle, uid);
  if (!me || battle.status !== 'pending' || isExpired(battle, now)) return false;
  return me.status === 'invited' || me.notice === 'payoutChanged';
}

export function isFinished(battle) {
  return ['settled', 'cancelled', 'void'].includes(battle?.status);
}

// "2 h 15 m" / "45 m" until a time (or "now").
export function timeLeft(ms, now = Date.now()) {
  const left = ms - now;
  if (left <= 0) return 'now';
  const minutes = Math.ceil(left / 60000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h ${m} m` : `${m} m`;
}

export const PARTICIPANT_STATUS = {
  invited: 'Invited',
  accepted: 'In',
  declined: 'Declined',
  refunded: 'Refunded',
};
