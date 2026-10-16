// Kalshi team labels that need help matching ESPN, per league.
// Key: the Kalshi label after normalizeName() (lowercase, no punctuation, "st" → "state").
// Value: ESPN's team abbreviation.
// Most teams match automatically by city/school name or by Kalshi's team code;
// add a line here when a game shows "unavailable" because a name didn't line up.

export const TEAM_ALIASES = {
  nfl: {
    'new york g': 'NYG',
    'new york j': 'NYJ',
    'ny giants': 'NYG',
    'ny jets': 'NYJ',
    'los angeles c': 'LAC',
    'los angeles r': 'LAR',
    'la chargers': 'LAC',
    'la rams': 'LAR',
  },
  nba: {
    'los angeles c': 'LAC',
    'los angeles l': 'LAL',
    'la clippers': 'LAC',
    'la lakers': 'LAL',
  },
  mlb: {
    'new york y': 'NYY',
    'new york m': 'NYM',
    'los angeles d': 'LAD',
    'los angeles a': 'LAA',
    'chicago c': 'CHC',
    'chicago ws': 'CHW',
  },
  nhl: {
    'new york r': 'NYR',
    'new york i': 'NYI',
  },
  ncaaf: {
    'appalachian state': 'APP',
    'miami fl': 'MIA',
    'southern california': 'USC',
  },
};
