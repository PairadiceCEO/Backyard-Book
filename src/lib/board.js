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
      let label = formatCentralDay(game.startTime);
      if (key === todayKey) label = `Today · ${label}`;
      else if (key === tomorrowKey) label = `Tomorrow · ${label}`;
      group = { key, label, games: [] };
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
