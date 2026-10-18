// Challenges: a public betting line a player proposes and the admin approves, e.g. "Will Mike finish a
// 5K under 25 minutes? Yes +150 / No −180". Rules shared by the server (authoritative) and the phone.
//
// Status: pending (posted, visible, no betting) → open (approved; betting until closeTime on the server
// clock) → settled (the admin picked the winning outcome) | void (refunds every leg). Or rejected.
// A bet on a Challenge is a leg { league: 'challenge', gameId: 'challenge:{id}', marketType: 'challenge',
// selection: outcome id }.

import { parseAmerican } from './oddsMath.js';

export const CHALLENGE_LEAGUE = 'challenge';
export const CHALLENGE_MARKET = 'challenge';
export const CHALLENGE_PREFIX = 'challenge:';
export const OUTCOMES_MIN = 2;
export const OUTCOMES_MAX = 6;
export const OUTCOME_IDS = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'];
export const CHALLENGE_TITLE_MAX = 80;
export const CHALLENGE_DESCRIPTION_MAX = 500;
export const OUTCOME_LABEL_MAX = 60;
export const REJECT_NOTE_MAX = 300;
export const CLOSE_MIN_LEAD_MS = 10 * 60 * 1000; // the close time must be at least 10 minutes away
export const CLOSE_MAX_AHEAD_MS = 60 * 24 * 60 * 60 * 1000; // …and at most 60 days away

export const CHALLENGE_STATUS_LABELS = {
  pending: 'Pending approval',
  open: 'Open',
  closed: 'Betting closed',
  rejected: 'Rejected',
  settled: 'Settled',
  void: 'Void',
};

export function isChallengeLeg(leg) {
  return String(leg?.gameId ?? '').startsWith(CHALLENGE_PREFIX);
}

export function challengeDocId(gameId) {
  return String(gameId ?? '').slice(CHALLENGE_PREFIX.length);
}

// A whole American price, +100 or more / −100 or less; null otherwise.
export function cleanAmerican(value) {
  const text = String(value ?? '').trim();
  if (!/^[+-]?\d{3,5}$/.test(text)) return null;
  const n = parseAmerican(text);
  return n !== null && Math.abs(n) >= 100 && Math.abs(n) <= 100000 ? n : null;
}

// Checks a Challenge: { title, description, outcomes: [{ label, american }], closeMs }. Returns problems.
export function challengeProblems(input, nowMs) {
  const problems = [];
  const title = String(input?.title ?? '').trim();
  const description = String(input?.description ?? '').trim();
  if (!title) problems.push('Give the Challenge a title (the question people bet on).');
  if (title.length > CHALLENGE_TITLE_MAX) problems.push(`The title can be up to ${CHALLENGE_TITLE_MAX} characters.`);
  if (description.length > CHALLENGE_DESCRIPTION_MAX) problems.push(`The description can be up to ${CHALLENGE_DESCRIPTION_MAX} characters.`);
  const outcomes = Array.isArray(input?.outcomes) ? input.outcomes : [];
  if (outcomes.length < OUTCOMES_MIN || outcomes.length > OUTCOMES_MAX) problems.push(`Give ${OUTCOMES_MIN}–${OUTCOMES_MAX} outcomes.`);
  const labels = outcomes.map((o) => String(o?.label ?? '').trim());
  if (labels.some((l) => !l || l.length > OUTCOME_LABEL_MAX)) problems.push(`Each outcome needs a name of 1–${OUTCOME_LABEL_MAX} characters.`);
  if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) problems.push('Each outcome needs a different name.');
  if (outcomes.some((o) => cleanAmerican(o?.american) === null)) problems.push('Give each outcome American odds like +150 or -180.');
  const closeMs = input?.closeMs;
  if (!Number.isFinite(closeMs)) problems.push('Pick when betting closes (date and time, Central Time).');
  else if (closeMs < nowMs + CLOSE_MIN_LEAD_MS) problems.push('Betting has to close at least 10 minutes from now.');
  else if (closeMs > nowMs + CLOSE_MAX_AHEAD_MS) problems.push('Betting has to close within 60 days.');
  return [...new Set(problems)];
}

// What the board shows for a Challenge: 'pending' | 'open' | 'closed' (approved, past close, not settled)
// | 'rejected' | 'settled' | 'void'.
export function challengeState(challenge, nowMs, closeMs) {
  if (challenge?.status === 'open') return nowMs < closeMs ? 'open' : 'closed';
  return challenge?.status ?? 'pending';
}

export function outcomeLabel(challenge, outcomeId) {
  return (challenge?.outcomes ?? []).find((o) => o.id === outcomeId)?.label ?? outcomeId;
}
