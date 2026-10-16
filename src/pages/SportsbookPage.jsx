// League tabs and the game board, refreshed every 30 seconds.

import { useMemo, useState } from 'react';
import LeagueTabs from '../components/LeagueTabs.jsx';
import GameCard from '../components/GameCard.jsx';
import UpdatedAgo from '../components/UpdatedAgo.jsx';
import { useBoard } from '../hooks/useBoard.js';
import { formatCentralDay } from '../lib/format.js';
import { LEAGUES } from '../../shared/constants.js';
import { centralDateKey } from '../../shared/time.js';

const LEAGUE_STORAGE_KEY = 'backyardbook.league';

function readSavedLeague() {
  try {
    const saved = window.sessionStorage.getItem(LEAGUE_STORAGE_KEY);
    if (LEAGUES.some((l) => l.id === saved)) return saved;
  } catch {
    // Storage can be blocked; fall back to the first league.
  }
  return LEAGUES[0].id;
}

function groupByDay(games) {
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

export default function SportsbookPage() {
  const [league, setLeague] = useState(readSavedLeague);
  const { games, fetchedAt, stale, partial, kalshiStatus, error, loading } = useBoard(league);

  const groups = useMemo(() => (games ? groupByDay(games) : []), [games]);
  const leagueLabel = LEAGUES.find((l) => l.id === league)?.label ?? '';

  function changeLeague(id) {
    setLeague(id);
    try {
      window.sessionStorage.setItem(LEAGUE_STORAGE_KEY, id);
    } catch {
      // Ignore storage errors; the choice just won't be remembered.
    }
  }

  return (
    <section className="page">
      <LeagueTabs value={league} onChange={changeLeague} />

      <div className="board-status">
        <UpdatedAgo timestamp={fetchedAt} />
        {stale ? <span className="warning-text small">ESPN didn't answer; showing the last saved board.</span> : null}
        {partial && !stale ? <span className="warning-text small">Some days couldn't be loaded; retrying.</span> : null}
        {kalshiStatus === 'failed' ? (
          <span className="warning-text small">Kalshi isn't answering, so live games have no prices right now.</span>
        ) : null}
      </div>

      {loading ? <div className="card muted">Loading {leagueLabel} games…</div> : null}

      {!loading && error && !games ? <div className="card error-text">{error}</div> : null}
      {!loading && error && games ? <p className="warning-text small">Refresh failed: {error}</p> : null}

      {!loading && games && games.length === 0 ? (
        <div className="card empty-state">
          <p className="muted">No {leagueLabel} games scheduled in this window.</p>
        </div>
      ) : null}

      {groups.map((group) => (
        <div key={group.key} className="day-group">
          <h3 className="day-label">{group.label}</h3>
          {group.games.map((game) => (
            <GameCard key={game.id} game={game} />
          ))}
        </div>
      ))}
    </section>
  );
}
