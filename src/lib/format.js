// Display formatting for money, win rate and Central Time.

import { DISPLAY_TIME_ZONE } from '../../shared/constants.js';

const moneyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatMoney(cents) {
  const value = Number.isFinite(cents) ? cents : 0;
  return moneyFormatter.format(value / 100);
}

// Turns what someone typed ("25", "$1,250.50", "-10") into whole cents, or null if it isn't a valid amount.
export function parseDollarsToCents(input, { allowNegative = false } = {}) {
  const cleaned = String(input ?? '').replace(/[$,\s]/g, '');
  const pattern = allowNegative ? /^-?\d+(\.\d{1,2})?$/ : /^\d+(\.\d{1,2})?$/;
  if (!pattern.test(cleaned)) return null;
  const negative = cleaned.startsWith('-');
  const [whole, fraction = ''] = cleaned.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

// Win rate = won ÷ (won + lost). Pushes and voids never count. No decided bets shows "—".
export function formatWinRate(stats) {
  const won = Number(stats?.won) || 0;
  const lost = Number(stats?.lost) || 0;
  const decided = won + lost;
  if (decided === 0) return '—';
  return `${Math.round((won / decided) * 100)}%`;
}

const centralFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: DISPLAY_TIME_ZONE,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

// e.g. "Sat, Oct 17, 2:30 PM CDT" — switches to CST automatically.
export function formatCentralTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return centralFormatter.format(date);
}

// "+150", "-110"
export function formatAmerican(american) {
  if (!Number.isFinite(american)) return '';
  return american > 0 ? `+${american}` : String(american);
}

// Spread line from the team's point of view: "+2.5", "-2.5", "PK"
export function formatSpreadLine(line) {
  if (!Number.isFinite(line)) return '';
  if (line === 0) return 'PK';
  return line > 0 ? `+${line}` : String(line);
}

const clockFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: DISPLAY_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

// "2:30 PM CDT"
export function formatCentralClock(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return clockFormatter.format(date);
}

const dayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: DISPLAY_TIME_ZONE,
  weekday: 'long',
  month: 'short',
  day: 'numeric',
});

// "Saturday, Oct 17"
export function formatCentralDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return dayFormatter.format(date);
}
