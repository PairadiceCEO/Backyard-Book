// Calendar dates in Central Time (America/Chicago), used for ESPN ?dates= and display grouping.

import { DISPLAY_TIME_ZONE } from './constants.js';

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const pad = (n) => String(n).padStart(2, '0');

// { y, m, d } of the given instant, as a calendar date in Central Time.
export function centralDateParts(date = new Date()) {
  const parts = partsFormatter.formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

// "YYYYMMDD" for the Central Time date of `date`, shifted by offsetDays.
export function centralYmd(offsetDays = 0, date = new Date()) {
  const { y, m, d } = centralDateParts(date);
  const shifted = new Date(Date.UTC(y, m - 1, d + offsetDays));
  return `${shifted.getUTCFullYear()}${pad(shifted.getUTCMonth() + 1)}${pad(shifted.getUTCDate())}`;
}

// "YYYY-MM-DD" key of the Central Time date of `date` (for grouping games by day).
export function centralDateKey(date) {
  const { y, m, d } = centralDateParts(date instanceof Date ? date : new Date(date));
  return `${y}-${pad(m)}-${pad(d)}`;
}
