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
