// Per-league configuration for every data source.

export const LEAGUE_CONFIG = {
  mlb: {
    id: 'mlb',
    label: 'MLB',
    espnPath: 'baseball/mlb',
    schedule: 'daily', // one ?dates=YYYYMMDD call per day
    espnParams: {},
    kalshi: { game: 'KXMLBGAME', spread: 'KXMLBSPREAD', total: 'KXMLBTOTAL' },
  },
  nfl: {
    id: 'nfl',
    label: 'NFL',
    espnPath: 'football/nfl',
    schedule: 'week', // ESPN's default scoreboard is the current week
    espnParams: {},
    kalshi: { game: 'KXNFLGAME', spread: 'KXNFLSPREAD', total: 'KXNFLTOTAL' },
  },
  nhl: {
    id: 'nhl',
    label: 'NHL',
    espnPath: 'hockey/nhl',
    schedule: 'daily',
    espnParams: {},
    kalshi: { game: 'KXNHLGAME', spread: 'KXNHLSPREAD', total: 'KXNHLTOTAL' },
  },
  ncaaf: {
    id: 'ncaaf',
    label: 'College Football',
    espnPath: 'football/college-football',
    schedule: 'week',
    espnParams: { groups: '80', limit: '300' }, // FBS only
    kalshi: { game: 'KXNCAAFGAME', spread: 'KXNCAAFSPREAD', total: 'KXNCAAFTOTAL' },
  },
  nba: {
    id: 'nba',
    label: 'NBA',
    espnPath: 'basketball/nba',
    schedule: 'daily',
    espnParams: {},
    kalshi: { game: 'KXNBAGAME', spread: 'KXNBASPREAD', total: 'KXNBATOTAL' },
  },
};

// Daily leagues fetch yesterday (still-live games only) through two days ahead.
export const DAILY_OFFSETS = [-1, 0, 1, 2];

export function getLeague(id) {
  return Object.prototype.hasOwnProperty.call(LEAGUE_CONFIG, id) ? LEAGUE_CONFIG[id] : null;
}
