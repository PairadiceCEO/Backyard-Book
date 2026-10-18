// Odds conversions shared by the browser and the server.

// Accepts numbers or strings like "-142", "+120", "EVEN". Returns an integer American price or null.
export function parseAmerican(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const text = value.trim().toUpperCase();
    if (text === 'EVEN' || text === 'EV') return 100;
    const cleaned = text.replace(/[^0-9+\-.]/g, '');
    if (!cleaned) return null;
    return parseAmerican(Number(cleaned));
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  // Valid American odds are <= -100 or >= +100.
  if (rounded > -100 && rounded < 100) return null;
  return rounded;
}

// Accepts numbers or strings like "-2.5", "+3", "o42.5", "u42.5", "PK". Returns a number or null.
export function parseLine(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim().toUpperCase();
  if (text === 'PK' || text === 'PICK' || text === 'EVEN') return 0;
  const cleaned = text.replace(/^[OU]/, '').replace(/[^0-9+\-.]/g, '');
  if (!cleaned || cleaned === '+' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function americanToDecimal(american) {
  if (american >= 100) return 1 + american / 100;
  return 1 + 100 / Math.abs(american);
}

export function decimalToAmerican(decimal) {
  if (!Number.isFinite(decimal) || decimal <= 1) return null;
  if (decimal >= 2) return Math.round((decimal - 1) * 100);
  return Math.round(-100 / (decimal - 1));
}

// Kalshi-style probability (0–1) to American odds.
export function probabilityToAmerican(p) {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  if (p >= 0.5) return Math.round((-100 * p) / (1 - p));
  return Math.round((100 * (1 - p)) / p);
}

export function roundDecimal(decimal) {
  return Math.round(decimal * 10000) / 10000;
}

// A priced selection as the board and bet slip use it.
export function makeQuote(american, { line = null, source, ref = null }) {
  const price = parseAmerican(american);
  if (price === null) return null;
  return {
    american: price,
    decimal: roundDecimal(americanToDecimal(price)),
    line: line === null || line === undefined ? null : line,
    source,
    ref,
  };
}

// ---------- Odds-change confirmation ----------
// A leg whose price moved this many points or more from the price the player saw is not placed: the server answers
// ODDS_CHANGED and the player confirms the new odds. Measured on a continuous scale where −100 and +100 are the
// same point, so −110 → +110 is 20 points and +100 → −150 is 50.
export const ODDS_CONFIRM_POINTS = 50;

// f(a) = a − 100 for a ≥ +100, a + 100 for a ≤ −100 (values strictly between are not American odds; they fall on
// the matching side so the scale stays continuous).
export function oddsScale(american) {
  const a = Number(american);
  return a >= 0 ? a - 100 : a + 100;
}

export function oddsDistance(oldAmerican, newAmerican) {
  return Math.abs(oddsScale(oldAmerican) - oddsScale(newAmerican));
}

export function needsOddsConfirm(oldAmerican, newAmerican) {
  return oddsDistance(oldAmerican, newAmerican) >= ODDS_CONFIRM_POINTS;
}
