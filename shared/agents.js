// AI agent players (0.21.0): house rules shared by the server, the admin screens and the agent runner (agents/).
// An agent is a normal non-admin player whose users/{uid} doc has `agent: { provider, label }` (set by the admin only).
// The rules are enforced in server/placeBet.js; the runner only repeats them to the model.

import { chatLength, cleanChatText } from './casino/chat.js';

export const AGENT_PROVIDERS = ['anthropic', 'openai', 'google'];
export const AGENT_PROVIDER_NAMES = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google' };
export const AGENT_LABEL_MAX = 40;
export const AGENT_STAKE_PERCENT = 5; // at most 5% of the balance per bet slip (a parlay counts once)
export const AGENT_DAILY_LIMIT = 10; // bet slips per Central calendar day
export const AGENT_WHY_MAX = 280; // characters, counted like chat (an emoji is one)
export const AGENT_DAILY_KEEP_DAYS = 3; // the settle cron deletes agentDaily docs older than this
export const AGENT_TIME_ZONE = 'America/Chicago';

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: AGENT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

// "2026-10-27": the Central calendar day of `date` (daylight time and standard time both handled by Intl).
export function centralDay(date = new Date()) {
  return dayFormat.format(date);
}

// The Central day `days` before `date`'s Central day, as "YYYY-MM-DD" (calendar arithmetic, no time zone drift).
export function centralDayMinus(date, days) {
  const [y, m, d] = centralDay(date).split('-').map(Number);
  const back = new Date(Date.UTC(y, m - 1, d - days));
  return back.toISOString().slice(0, 10);
}

export function agentDailyId(uid, day) {
  return `${uid}_${day}`;
}

// The largest stake (cents) an agent may put on one bet slip with this balance: 5%, rounded down to the cent.
export function agentStakeCapCents(balanceCents) {
  const balance = Math.max(0, Math.floor(Number(balanceCents) || 0));
  return Math.floor((balance * AGENT_STAKE_PERCENT) / 100);
}

// The reason an agent gives for a bet, as stored on the bet (agentWhy): cleaned like chat text, at most 280 characters
// (longer text is cut, never refused, so an explanation can't cost a bet). '' when there is nothing.
export function cleanAgentWhy(raw) {
  const text = cleanChatText(typeof raw === 'string' ? raw : '');
  if (chatLength(text) <= AGENT_WHY_MAX) return text;
  return [...text].slice(0, AGENT_WHY_MAX).join('').trim();
}

// users/{uid}.agent as the admin sets it, or null (not an agent). Throws a message string on bad input.
export function cleanAgentProfile(raw) {
  if (raw === null || raw === undefined || raw === false) return null;
  if (typeof raw !== 'object') throw new Error('agent must be { provider, label } or null.');
  const provider = String(raw.provider ?? '').toLowerCase();
  if (!AGENT_PROVIDERS.includes(provider)) throw new Error(`Provider must be one of: ${AGENT_PROVIDERS.join(', ')}.`);
  const label = cleanChatText(String(raw.label ?? ''));
  if (!label) throw new Error('Give the agent a model label (e.g. "Claude Sonnet").');
  if (chatLength(label) > AGENT_LABEL_MAX) throw new Error(`The model label can be at most ${AGENT_LABEL_MAX} characters.`);
  return { provider, label };
}

export function isAgent(user) {
  return Boolean(user && user.agent && typeof user.agent === 'object' && user.agent.provider);
}
