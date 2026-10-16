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

const wallFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DISPLAY_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function wallParts(ms) {
  const parts = {};
  for (const p of wallFormatter.formatToParts(new Date(ms))) parts[p.type] = p.value;
  return parts;
}

// Central Time wall clock of an instant: { date: "2026-10-16", clock: "19:05" }.
export function centralWallParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  const p = wallParts(date.getTime());
  return { date: `${p.year}-${p.month}-${p.day}`, clock: `${p.hour}:${p.minute}` };
}

// "2026-10-16" + "19:05" read as Central Time (CDT or CST, whichever applies that day) → Date, or null.
export function centralWallTimeToDate(dateStr, clockStr) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr ?? ''));
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(clockStr ?? ''));
  if (!d || !t) return null;
  const [y, m, day, hh, mm] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2])];
  if (m < 1 || m > 12 || day < 1 || day > 31 || hh > 23 || mm > 59) return null;
  const target = Date.UTC(y, m - 1, day, hh, mm);
  // Start from the target as if it were UTC and correct by the zone's offset; a second pass settles DST edges.
  let guess = target;
  for (let i = 0; i < 2; i += 1) {
    const p = wallParts(guess);
    const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
    guess += target - shown;
  }
  const check = centralWallParts(new Date(guess));
  const want = `${d[1]}-${d[2]}-${d[3]} ${String(hh).padStart(2, '0')}:${t[2]}`;
  if (`${check.date} ${check.clock}` !== want) return null; // e.g. Feb 30, or a skipped DST hour
  return new Date(guess);
}
