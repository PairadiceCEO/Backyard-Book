// Display formatting for money, win rate and Central Time.

import { DISPLAY_TIME_ZONE } from '../../shared/constants.js';

const moneyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatMoney(cents) {
  const value = Number.isFinite(cents) ? cents : 0;
  return moneyFormatter.format(value / 100);
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
