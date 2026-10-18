// My Bets → Finished: sorting, filters and the summary line. Pure functions (no React, no Firestore), shared by the
// page and the tests. Every money value is integer cents.

import { centralDateKey, centralYmd } from '../../shared/time.js';
import { LEAGUES } from '../../shared/constants.js';
import { parseDollarsToCents } from './format.js';

export const FINISHED_STATUSES = ['won', 'lost', 'push', 'cashed_out', 'void'];

export const RESULT_OPTIONS = [
  { id: 'won', label: 'Won' },
  { id: 'lost', label: 'Lost' },
  { id: 'push', label: 'Push' },
  { id: 'cashed_out', label: 'Cashed out' },
  { id: 'void', label: 'Void' },
];

export const DATE_OPTIONS = [
  { id: 'today', label: 'Today' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'last30', label: 'Last 30 days' },
  { id: 'month', label: 'This month' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom dates' },
];

export const CATEGORY_OPTIONS = [
  ...LEAGUES.map((l) => ({ id: l.id, label: l.label })),
  { id: 'custom', label: 'Custom games' },
  { id: 'challenge', label: 'Challenges' },
  { id: 'crypto', label: 'Crypto' },
];

export const TYPE_OPTIONS = [
  { id: 'both', label: 'Both' },
  { id: 'single', label: 'Singles' },
  { id: 'parlay', label: 'Parlays' },
];

export const MARKET_OPTIONS = [
  { id: 'moneyline', label: 'Moneyline' },
  { id: 'spread', label: 'Spread' },
  { id: 'total', label: 'Total' },
  { id: 'challenge', label: 'Challenge' },
  { id: 'crypto', label: 'Crypto' },
];

export const TIMING_OPTIONS = [
  { id: 'both', label: 'Both' },
  { id: 'live', label: 'Live' },
  { id: 'pre', label: 'Pre-game' },
];

export const SORT_OPTIONS = [
  { id: 'settledDesc', label: 'Settled: newest' },
  { id: 'settledAsc', label: 'Settled: oldest' },
  { id: 'placedDesc', label: 'Placed: newest' },
  { id: 'stakeDesc', label: 'Stake: high → low' },
  { id: 'profitDesc', label: 'Profit: high → low' },
];
export const DEFAULT_SORT = 'settledDesc';

export const DEFAULT_FILTERS = Object.freeze({
  results: [],
  date: 'all',
  from: '',
  to: '',
  categories: [],
  type: 'both',
  markets: [],
  timing: 'both',
  stakeMin: '',
  stakeMax: '',
  text: '',
  posterOnly: false,
});

// ---------- per bet ----------

export function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value === 'object' && Number.isFinite(value.seconds)) return value.seconds * 1000;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function isFinishedBet(bet) {
  return FINISHED_STATUSES.includes(bet?.status);
}

// What the bet paid back (cents): a cash out's value, a win's payout, a push/void's stake; a loss returns 0.
export function returnedCents(bet) {
  if (bet.status === 'lost') return 0;
  if (bet.status === 'cashed_out') return Number(bet.cashoutCents ?? bet.payoutCents) || 0;
  return Number(bet.payoutCents) || 0;
}

// Profit = returned − stake (a loss is −stake).
export function profitCents(bet) {
  return returnedCents(bet) - (Number(bet.stakeCents) || 0);
}

export function legCategory(leg) {
  const id = String(leg?.gameId ?? '');
  if (id.startsWith('custom:')) return 'custom';
  if (id.startsWith('challenge:')) return 'challenge';
  if (id.startsWith('crypto:')) return 'crypto';
  return leg?.league ?? '';
}

// Placed live = placed at or after a leg's start time (a parlay: any leg).
export function placedLive(bet) {
  const placed = toMs(bet.placedAt);
  if (placed === null) return false;
  return (bet.legs ?? []).some((leg) => {
    const start = toMs(leg.startTime);
    return start !== null && placed >= start;
  });
}

function searchText(bet) {
  return (bet.legs ?? []).map((l) => `${l.label ?? ''} ${l.gameLabel ?? ''}`).join(' ').toLowerCase();
}

// ---------- filters ----------

function dateKeyRange(filters, nowMs) {
  const today = centralDateKey(new Date(nowMs));
  // Calendar days back in Central Time (safe across daylight-saving changes).
  const daysAgo = (n) => {
    const ymd = centralYmd(-n, new Date(nowMs));
    return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  };
  switch (filters.date) {
    case 'today':
      return [today, today];
    case 'last7':
      return [daysAgo(6), today];
    case 'last30':
      return [daysAgo(29), today];
    case 'month':
      return [`${today.slice(0, 7)}-01`, today];
    case 'custom': {
      const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '');
      return [ok(filters.from) ? filters.from : null, ok(filters.to) ? filters.to : null];
    }
    default:
      return [null, null];
  }
}

// Number of filters that differ from the defaults (for the badge).
export function activeFilterCount(filters) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  let n = 0;
  if (f.results.length) n += 1;
  if (f.date !== 'all' && (f.date !== 'custom' || f.from || f.to)) n += 1;
  if (f.categories.length) n += 1;
  if (f.type !== 'both') n += 1;
  if (f.markets.length) n += 1;
  if (f.timing !== 'both') n += 1;
  if (String(f.stakeMin).trim() || String(f.stakeMax).trim()) n += 1;
  if (String(f.text).trim()) n += 1;
  if (f.posterOnly) n += 1;
  return n;
}

export function matchesFilters(bet, filters, nowMs = Date.now()) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  if (f.results.length && !f.results.includes(bet.status)) return false;

  const [fromKey, toKey] = dateKeyRange(f, nowMs);
  if (fromKey || toKey) {
    const placed = toMs(bet.placedAt);
    if (placed === null) return false;
    const key = centralDateKey(new Date(placed));
    if (fromKey && key < fromKey) return false;
    if (toKey && key > toKey) return false;
  }

  const legs = bet.legs ?? [];
  if (f.categories.length && !legs.some((l) => f.categories.includes(legCategory(l)))) return false;
  if (f.type !== 'both' && bet.type !== f.type) return false;
  if (f.markets.length && !legs.some((l) => f.markets.includes(l.marketType))) return false;
  if (f.timing === 'live' && !placedLive(bet)) return false;
  if (f.timing === 'pre' && placedLive(bet)) return false;

  const stake = Number(bet.stakeCents) || 0;
  const min = String(f.stakeMin).trim() ? parseDollarsToCents(f.stakeMin) : null;
  const max = String(f.stakeMax).trim() ? parseDollarsToCents(f.stakeMax) : null;
  if (min !== null && stake < min) return false;
  if (max !== null && stake > max) return false;

  const text = String(f.text).trim().toLowerCase();
  if (text && !searchText(bet).includes(text)) return false;
  if (f.posterOnly && bet.posterBet !== true) return false;
  return true;
}

export function filterBets(bets, filters, nowMs = Date.now()) {
  return bets.filter((b) => matchesFilters(b, filters, nowMs));
}

// ---------- sort ----------

export function sortBets(bets, sort = DEFAULT_SORT) {
  const settled = (b) => toMs(b.settledAt) ?? toMs(b.cashedOutAt) ?? toMs(b.placedAt) ?? 0;
  const placed = (b) => toMs(b.placedAt) ?? 0;
  const keyed = {
    settledDesc: (a, b) => settled(b) - settled(a),
    settledAsc: (a, b) => settled(a) - settled(b),
    placedDesc: (a, b) => placed(b) - placed(a),
    stakeDesc: (a, b) => (Number(b.stakeCents) || 0) - (Number(a.stakeCents) || 0),
    profitDesc: (a, b) => profitCents(b) - profitCents(a),
  }[sort] ?? ((a, b) => settled(b) - settled(a));
  // Ties: newest settled first, then id, so the order never jumps between renders.
  return [...bets].sort((a, b) => keyed(a, b) || settled(b) - settled(a) || String(a.id).localeCompare(String(b.id)));
}

// ---------- summary ----------

// For the bets showing: count, total staked, total returned, net, and win rate = won ÷ (won + lost) (pushes, voids and
// cash outs excluded, as on Leaders; null when nothing is decided).
export function summarize(bets) {
  let staked = 0;
  let returned = 0;
  let won = 0;
  let lost = 0;
  for (const b of bets) {
    staked += Number(b.stakeCents) || 0;
    returned += returnedCents(b);
    if (b.status === 'won') won += 1;
    if (b.status === 'lost') lost += 1;
  }
  return { count: bets.length, stakedCents: staked, returnedCents: returned, netCents: returned - staked, won, lost, winRate: won + lost ? won / (won + lost) : null };
}

// ---------- remembered for the session ----------

export const VIEW_STORAGE_KEY = 'backyardbook.finishedView';

const pickList = (value, options) => (Array.isArray(value) ? value.filter((v) => options.some((o) => o.id === v)) : []);
const pickOne = (value, options, fallback) => (options.some((o) => o.id === value) ? value : fallback);
const pickText = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

// Any stored value → a valid { sort, filters } (unknown or broken values fall back to the defaults).
export function cleanView(raw) {
  const f = raw?.filters ?? {};
  return {
    sort: pickOne(raw?.sort, SORT_OPTIONS, DEFAULT_SORT),
    filters: {
      results: pickList(f.results, RESULT_OPTIONS),
      date: pickOne(f.date, DATE_OPTIONS, 'all'),
      from: /^\d{4}-\d{2}-\d{2}$/.test(f.from ?? '') ? f.from : '',
      to: /^\d{4}-\d{2}-\d{2}$/.test(f.to ?? '') ? f.to : '',
      categories: pickList(f.categories, CATEGORY_OPTIONS),
      type: pickOne(f.type, TYPE_OPTIONS, 'both'),
      markets: pickList(f.markets, MARKET_OPTIONS),
      timing: pickOne(f.timing, TIMING_OPTIONS, 'both'),
      stakeMin: pickText(f.stakeMin, 12),
      stakeMax: pickText(f.stakeMax, 12),
      text: pickText(f.text, 80),
      posterOnly: f.posterOnly === true,
    },
  };
}

export function readSavedView() {
  try {
    const text = window.sessionStorage.getItem(VIEW_STORAGE_KEY);
    return cleanView(text ? JSON.parse(text) : null);
  } catch {
    return cleanView(null);
  }
}

export function saveView(view) {
  try {
    window.sessionStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {
    // Storage can be blocked; the view just isn't remembered.
  }
}
