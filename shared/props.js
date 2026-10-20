// Player props from Kalshi: the series offered, how a prop market is named, and the betting rules shared by the
// server (authoritative) and the phone (display, slip rules).
//
// A prop series has one event per game whose ticker suffix is the game's (KXMLBHR-26OCT181700TBCLE ↔
// KXMLBGAME-26OCT181700TBCLE) and one market per player per threshold: ticker "{event}-{TEAM}{PLAYER}{n}-{N}",
// yes_sub_title "Deshaun Watson: 30+", strike_type greater, floor_strike 29.5. YES = the player reaches N or more,
// NO = fewer than N.
//
// Every series below was verified on 2026-10-18 against Kalshi's public API (open per-game events with that shape).
// Left out (see PROGRESS.md 0.14.0): no open events (KXNHLSAVES, KXNHLSOG, KXNHLBLK, KXNFLPASSTD, KXMLBRUN,
// KXMLBWALK, KXNCAAFPASSYDS, KXNCAAFRSHYDS, KXNCAAFRECYDS, KXNCAAFTD), not one market per player per threshold
// (KXNFLLADDERRSHYDS scalar ladder, KXNBAONE3PT season-long, KXNFLLONGESTREC, KXNFLMOSTRECYDS, KXNFLWEEKMOST*,
// KXNBAH2HPTS, KXNBAFIRSTBASKET, KXNHLFIRSTGOAL, season and leader series).

export const PROP_MARKET = 'prop';
export const PROP_CLOSED_MESSAGE = 'Player props close when the game starts.';

// series → { league, stat (tab and label), anytime: threshold 1 reads "1+ TD" / "No TD" }
export const PROP_SERIES = {
  KXNFLPASSYDS: { league: 'nfl', stat: 'Pass Yds' },
  KXNFLRSHYDS: { league: 'nfl', stat: 'Rush Yds' },
  KXNFLRECYDS: { league: 'nfl', stat: 'Rec Yds' },
  KXNFLREC: { league: 'nfl', stat: 'Receptions' },
  KXNFLTD: { league: 'nfl', stat: 'TD', anytime: true },
  KXMLBHR: { league: 'mlb', stat: 'HR', anytime: true },
  KXMLBHIT: { league: 'mlb', stat: 'Hits' },
  KXMLBKS: { league: 'mlb', stat: 'Strikeouts' },
  KXMLBTB: { league: 'mlb', stat: 'Total Bases' },
  KXMLBRBI: { league: 'mlb', stat: 'RBIs' },
  KXMLBHRR: { league: 'mlb', stat: 'H+R+RBI' },
  KXMLBSB: { league: 'mlb', stat: 'Stolen Bases' },
  KXNHLGOAL: { league: 'nhl', stat: 'Goals' },
  KXNHLPTS: { league: 'nhl', stat: 'Points' },
  KXNHLAST: { league: 'nhl', stat: 'Assists' },
  KXNHLSAVE: { league: 'nhl', stat: 'Saves' },
  KXNBAPTS: { league: 'nba', stat: 'Points' },
  KXNBAREB: { league: 'nba', stat: 'Rebounds' },
  KXNBAAST: { league: 'nba', stat: 'Assists' },
  KXNBA3PT: { league: 'nba', stat: 'Threes' },
  KXNBASTL: { league: 'nba', stat: 'Steals' },
  KXNBABLK: { league: 'nba', stat: 'Blocks' },
  KXNBASTOCK: { league: 'nba', stat: 'Stl+Blk' },
  KXNBAPRA: { league: 'nba', stat: 'Pts+Reb+Ast' },
};

export function propSeries(series) {
  return Object.prototype.hasOwnProperty.call(PROP_SERIES, series) ? PROP_SERIES[series] : null;
}

// Configured series for one league, in the order above (the props page's tab order).
export function propSeriesForLeague(leagueId) {
  return Object.keys(PROP_SERIES).filter((s) => PROP_SERIES[s].league === leagueId);
}

// "KXNFLRSHYDS-26OCT18BALCLE-CLEDWATSON4-30" → { series, suffix, eventTicker, playerCode, playerKey, statKey, threshold },
// or null. playerKey (the market ticker without its threshold) is one player's markets in one stat of one game.
// statKey ("KXNFLRSHYDS-CLEDWATSON4": series + the ticker's player segment) is one player in one stat: the parlay rule
// allows at most one leg per statKey (0.15.0). Players are never identified by their display names.
export function parsePropTicker(ticker) {
  const parts = String(ticker ?? '').split('-');
  if (parts.length !== 4 || parts.some((p) => !p)) return null;
  const [series, suffix, playerCode, n] = parts;
  if (!/^[A-Z0-9]+$/.test(series) || !/^[A-Z0-9]+$/.test(suffix) || !/^[A-Z0-9]+$/.test(playerCode) || !/^\d{1,4}$/.test(n)) return null;
  return { series, suffix, eventTicker: `${series}-${suffix}`, playerCode, playerKey: `${series}-${suffix}-${playerCode}`, statKey: `${series}-${playerCode}`, threshold: Number(n) };
}

// The part of an event ticker after the series: "KXMLBGAME-26OCT181700TBCLE" → "26OCT181700TBCLE".
export function tickerSuffix(eventTicker) {
  const text = String(eventTicker ?? '');
  const dash = text.indexOf('-');
  return dash > 0 ? text.slice(dash + 1) : null;
}

// The prop event of `series` for a game whose winner event is `gameEventTicker`: same suffix, or null.
export function propEventTickerFor(series, gameEventTicker) {
  const suffix = tickerSuffix(gameEventTicker);
  return suffix && propSeries(series) ? `${series}-${suffix}` : null;
}

// A prop event (or market ticker) belongs to a game only when its series is configured for the game's league and its
// ticker suffix equals the suffix of the winner event the matcher mapped to that game. Never by names or dates.
export function propBelongsToGame(ticker, { league, gameEventTicker }) {
  const [series, suffix] = String(ticker ?? '').split('-');
  const config = propSeries(series);
  if (!config || config.league !== league || !suffix) return false;
  const gameSuffix = tickerSuffix(gameEventTicker);
  return Boolean(gameSuffix) && suffix === gameSuffix;
}

// Parlay rule (0.15.0): props may be parlayed with anything from the same game (other props, moneyline, spread, total)
// and with other games, but at most one leg per player per stat (statKey above): "50+" with "Under 50" or "60+" on
// the same player and stat is refused. The message names the player and the stat.
export function propConflictMessage({ player = '', stat = '' } = {}) {
  const name = String(player ?? '').trim();
  const what = String(stat ?? '').trim() || 'prop';
  return name ? `You already have a ${name} ${what} pick in this parlay.` : `You already have a ${what} pick on that player in this parlay.`;
}

// Props are bet only before the game: ESPN still says 'pre' AND the server clock is before the start time.
export function propsOpen(game, nowMs) {
  if (!game || game.state !== 'pre' || game.canceled) return false;
  const start = Date.parse(game.startTime ?? '');
  return Number.isFinite(start) && nowMs < start;
}

// "Deshaun Watson: 30+" → "Deshaun Watson".
export function playerNameOf(yesSubTitle) {
  const text = String(yesSubTitle ?? '');
  const i = text.lastIndexOf(':');
  return (i > 0 ? text.slice(0, i) : text).trim();
}

// The threshold N of a market: from "Name: N+", else floor_strike + 0.5.
export function thresholdOf(market) {
  const m = /:\s*(\d+(?:\.\d+)?)\+\s*$/.exec(String(market?.yes_sub_title ?? ''));
  if (m) return Number(m[1]);
  const strike = Number(market?.floor_strike);
  return Number.isFinite(strike) ? Math.round(strike + 0.5) : null;
}

// "Derrick Henry 50+ Rush Yds" / "Derrick Henry Under 50 Rush Yds"; anytime stats at 1: "… 1+ TD" / "… No TD".
export function propPickLabel({ player, stat, threshold, anytime = false, selection }) {
  if (anytime && threshold === 1) return `${player} ${selection === 'yes' ? '1+' : 'No'} ${stat}`;
  return selection === 'yes' ? `${player} ${threshold}+ ${stat}` : `${player} Under ${threshold} ${stat}`;
}

// The two wheel buttons for a threshold: "50+" / "Under 50" (anytime at 1: "1+ TD" / "No TD").
export function propButtonLabels({ stat, threshold, anytime = false }) {
  if (anytime && threshold === 1) return { yes: `1+ ${stat}`, no: `No ${stat}` };
  return { yes: `${threshold}+`, no: `Under ${threshold}` };
}

// Which team a player is on: their ticker code starts with the team's Kalshi code (the longest code that fits).
export function teamCodeOf(playerCode, sideByCode) {
  let best = null;
  for (const code of Object.keys(sideByCode ?? {})) {
    if (String(playerCode).startsWith(code) && (!best || code.length > best.length)) best = code;
  }
  return best;
}
