// Values shared by the browser and the /api functions.

export const APP_NAME = 'Backyard Book';

// Usernames map to a hidden Firebase Auth email: will -> will@backyardbook.app
export const INTERNAL_EMAIL_DOMAIN = 'backyardbook.app';

export const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;
export const USERNAME_RULES = '3–20 characters: lowercase letters, numbers and underscores.';

export const PASSWORD_MIN_LENGTH = 8;
export const DISPLAY_NAME_MAX_LENGTH = 30;

export const LEAGUES = [
  { id: 'mlb', label: 'MLB' },
  { id: 'nfl', label: 'NFL' },
  { id: 'nhl', label: 'NHL' },
  { id: 'ncaaf', label: 'College Football' },
  { id: 'nba', label: 'NBA' },
];

export const SHOP_AMOUNTS_DOLLARS = [5, 25, 50, 100];

// Largest single admin wallet change or starting balance: $1,000,000. Also the casino's (and Battles') per-bet ceiling.
export const MAX_WALLET_CHANGE_CENTS = 100_000_000;

// 0.23.0: the sportsbook's per-bet ceiling (a single, or a parlay's stake): $10,000,000. Sportsbook only; the casino and
// Battles keep $1,000,000.
export const SPORTSBOOK_BET_CEILING_CENTS = 1_000_000_000;

// Optional id the browser sends so a double-click can't apply the same request twice.
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export const DISPLAY_TIME_ZONE = 'America/Chicago';

export function normalizeUsername(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

export function isValidUsername(username) {
  return USERNAME_PATTERN.test(username);
}

export function usernameToEmail(username) {
  return `${normalizeUsername(username)}@${INTERNAL_EMAIL_DOMAIN}`;
}
