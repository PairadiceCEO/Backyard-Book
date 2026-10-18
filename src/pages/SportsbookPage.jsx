// League tabs and the game board, refreshed every 30 seconds. Boards list only games that haven't finished.
// The Live tab has every game in progress, grouped by league; the Custom tab has the admin's custom games
// (every league), Battles and Challenges.

import { useMemo, useState } from 'react';
import LeagueTabs, { BOARD_TABS, CUSTOM_TAB, LIVE_TAB } from '../components/LeagueTabs.jsx';
import CustomBoard from './battles/CustomBoard.jsx';
import { useBattles } from '../context/BattlesContext.jsx';
import GameCard from '../components/GameCard.jsx';
import UpdatedAgo from '../components/UpdatedAgo.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusViews.jsx';
import { useBoard } from '../hooks/useBoard.js';
import { groupByDay, groupByLeague } from '../lib/board.js';
import { LEAGUES } from '../../shared/constants.js';

const LEAGUE_STORAGE_KEY = 'backyardbook.league';

function readSavedLeague() {
  try {
    const saved = window.sessionStorage.getItem(LEAGUE_STORAGE_KEY);
    if (BOARD_TABS.some((t) => t.id === saved)) return saved;
  } catch {
    // Storage can be blocked; fall back to the first league.
  }
  return LEAGUES[0].id;
}

export default function SportsbookPage() {
  const [league, setLeague] = useState(readSavedLeague);
  const { needsMeCount } = useBattles();
  const custom = league === CUSTOM_TAB.id;
  const live = league === LIVE_TAB.id;
  // Every tab loads its own board and polls (every 30 s) only while it is showing.
  const { games, fetchedAt, stale, partial, kalshiStatus, error, loading, retry } = useBoard(league);

  const groups = useMemo(() => {
    if (!games || custom) return [];
    return live ? groupByLeague(games, LEAGUES) : groupByDay(games);
  }, [games, custom, live]);
  const leagueLabel = live ? 'live' : LEAGUES.find((l) => l.id === league)?.label ?? '';

  function changeLeague(id) {
    setLeague(id);
    try {
      window.sessionStorage.setItem(LEAGUE_STORAGE_KEY, id);
    } catch {
      // Ignore storage errors; the choice just won't be remembered.
    }
  }

  if (custom) {
    return (
      <section className="page">
        <LeagueTabs value={league} onChange={changeLeague} customBadge={needsMeCount} />
        <CustomBoard board={{ games, fetchedAt, stale, error, loading, retry }} />
      </section>
    );
  }

  return (
    <section className="page">
      <LeagueTabs value={league} onChange={changeLeague} customBadge={needsMeCount} />

      <div className="board-status">
        <UpdatedAgo timestamp={fetchedAt} />
        {stale ? <span className="warning-text small">ESPN didn't answer; showing the last saved board.</span> : null}
        {partial && !stale ? (
          <span className="warning-text small">{live ? "Some leagues couldn't be loaded; retrying." : "Some days couldn't be loaded; retrying."}</span>
        ) : null}
        {kalshiStatus === 'failed' ? (
          <span className="warning-text small">Kalshi isn't answering, so live games have no prices right now.</span>
        ) : null}
      </div>

      {loading ? <LoadingState label={`Loading ${leagueLabel} games…`} rows={3} /> : null}

      {!loading && error && !games ? <ErrorState title={`Couldn't load ${leagueLabel} games`} message={error} onRetry={retry} /> : null}
      {!loading && error && games ? (
        <p className="warning-text small">
          Couldn't refresh; showing the last prices.{' '}
          <button type="button" className="btn btn-ghost small" onClick={retry}>
            Try again
          </button>
        </p>
      ) : null}

      {!loading && games && games.length === 0 && live ? (
        <EmptyState icon="📺" title="No games are live right now.">
          Games in progress in every league show up here. The list refreshes on its own.
        </EmptyState>
      ) : null}
      {!loading && games && games.length === 0 && !live ? (
        <EmptyState icon="📅" title={`No ${leagueLabel} games right now`}>
          Nothing is scheduled from now through the next couple of days. Try another league above — the board refreshes
          on its own.
        </EmptyState>
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
