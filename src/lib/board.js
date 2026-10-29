// Board helpers shared by the league boards and the Custom tab.

import { formatCentralDay } from './format.js';
import { centralDateKey } from '../../shared/time.js';

// Games grouped by Central Time day, labelled "Today · …" / "Tomorrow · …".
export function groupByDay(games) {
  const todayKey = centralDateKey(new Date());
  const tomorrowKey = centralDateKey(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const groups = [];
  for (const game of games) {
    const key = centralDateKey(game.startTime);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      const date = formatCentralDay(game.startTime);
      let label = date;
      let day = '';
      if (key === todayKey) {
        label = `Today · ${date}`;
        day = 'Today';
      } else if (key === tomorrowKey) {
        label = `Tomorrow · ${date}`;
        day = 'Tomorrow';
      }
      // label = the full heading; day ('Today' / 'Tomorrow' / '') and date are its two parts (the section header shows them apart).
      group = { key, label, day, date, games: [] };
      groups.push(group);
    }
    group.games.push(game);
  }
  return groups;
}

// Live tab: games grouped by league in the app's league order (leagues = [{ id, label }]), each group by start
// time. Leagues with no game in progress are left out.
export function groupByLeague(games, leagues) {
  const groups = [];
  for (const league of leagues) {
    const inLeague = games
      .filter((g) => g.league === league.id)
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime() || String(a.id).localeCompare(String(b.id)));
    if (inLeague.length) groups.push({ key: league.id, label: league.label, games: inLeague });
  }
  return groups;
}

// ---------- Spotlight (0.27.0) ----------
// The one game the top of the Sportsbook features, picked from the board that is already loaded (no new reads): on a league tab
// the next upcoming game that has both moneyline prices; on the Live tab the live game closest to finishing. null when there is none.

const PERIODS = { nba: { count: 4, minutes: 12 }, nfl: { count: 4, minutes: 15 }, ncaaf: { count: 4, minutes: 15 }, nhl: { count: 3, minutes: 20 }, mlb: { count: 9, minutes: 0 } };

// 0 (just started) … 1+ (nearly over), worked out from ESPN's short status ("4:32 - 3rd", "Bot 8th", "End of 2nd", "Halftime").
export function liveProgress(game) {
  const text = String(game.statusText || '');
  const spec = PERIODS[game.league] ?? { count: 4, minutes: 12 };
  if (/half/i.test(text) && spec.count === 4) return 0.5;
  const period = /(\d+)(?:st|nd|rd|th)/i.exec(text);
  if (!period) return 0;
  const n = Number(period[1]);
  if (game.league === 'mlb') return (n - 1 + (/bot|end/i.test(text) ? 0.5 : 0)) / spec.count;
  if (/end of/i.test(text)) return n / spec.count;
  const clock = /(\d{1,2}):(\d{2})/.exec(text);
  const left = clock ? Math.min(spec.minutes, Number(clock[1]) + Number(clock[2]) / 60) : spec.minutes / 2;
  return (n - 1 + (1 - left / spec.minutes)) / spec.count;
}

function hasMoneyline(game) {
  const ml = game.markets?.moneyline;
  return Boolean(ml?.home && ml?.away);
}

export function spotlightGame(games, { live = false } = {}) {
  if (!Array.isArray(games)) return null;
  if (live) {
    const candidates = games.filter((g) => g.state === 'in' && hasMoneyline(g));
    candidates.sort((a, b) => liveProgress(b) - liveProgress(a) || new Date(a.startTime).getTime() - new Date(b.startTime).getTime() || String(a.id).localeCompare(String(b.id)));
    return candidates[0] ?? null;
  }
  const candidates = games.filter((g) => g.state === 'pre' && !g.canceled && !g.bettingClosed && hasMoneyline(g));
  candidates.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime() || String(a.id).localeCompare(String(b.id)));
  return candidates[0] ?? null;
}
