// Values shared by the browser and the /api functions.

export const APP_NAME = 'Pairadice Casino';

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

// 0.28.2: largest single admin wallet change (Admin → Players → Adjust wallet) or starting balance (Create player):
// $100,000,000. Admin only; it is no longer tied to any bet ceiling.
export const MAX_WALLET_CHANGE_CENTS = 10_000_000_000;

// 0.28.2: the per-bet sanity ceiling for EVERYTHING: casino tables, side bets, 7s Slots, the VIP slot, Battles and the sportsbook
// (a single, or a parlay's stake): $10,000,000. No maximum bets otherwise (the wallet is the cap). Every payout stays a safe
// integer at this ceiling: the largest is the VIP slot's 10,000× cap, $100,000,000,000 = 1e13 cents (safe integers go to 9e15);
// a sportsbook parlay that could pass that is refused by payoutTooLarge.
export const BET_CEILING_CENTS = 1_000_000_000;
// The sportsbook's name for the same ceiling (0.23.0 introduced it at $10,000,000; since 0.28.2 it is BET_CEILING_CENTS).
export const SPORTSBOOK_BET_CEILING_CENTS = BET_CEILING_CENTS;

// "$10,000,000": a whole-dollar amount of cents for messages.
export function wholeDollarsText(cents) {
  return `$${Math.floor(cents / 100).toLocaleString('en-US')}`;
}

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
