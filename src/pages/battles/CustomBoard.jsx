// The Sportsbook's Custom tab: my Battles (invites first) with "New Battle"; Challenges (player-posted
// lines, betting once the admin approves them) with "Post a Challenge"; then the admin's custom games from
// every league (bet on them like any game).

import { Link } from 'react-router-dom';
import BattleCard from '../../components/BattleCard.jsx';
import ChallengeCard from '../../components/ChallengeCard.jsx';
import GameCard from '../../components/GameCard.jsx';
import UpdatedAgo from '../../components/UpdatedAgo.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/StatusViews.jsx';
import { useBattles } from '../../context/BattlesContext.jsx';
import { battleNeedsMe, isFinished } from '../../lib/battles.js';
import { groupByDay } from '../../lib/board.js';
import { boardChallenges, sortForBoard, useChallenges, useNowMs } from '../../lib/challenges.js';

const RECENT_FINISHED = 3;

export default function CustomBoard({ board }) {
  const { battles, uid, loading: battlesLoading, error: battlesError } = useBattles();
  const needsMe = battles.filter((b) => battleNeedsMe(b, uid));
  const open = battles.filter((b) => !isFinished(b) && !battleNeedsMe(b, uid));
  const finished = battles.filter(isFinished).slice(0, RECENT_FINISHED);
  const groups = board.games ? groupByDay(board.games) : [];
  const { challenges: allChallenges, loading: challengesLoading, error: challengesError, retry: retryChallenges } = useChallenges();
  const nowMs = useNowMs();
  const challenges = sortForBoard(boardChallenges(allChallenges, uid, nowMs), nowMs);

  return (
    <>
      <div className="section-head">
        <h2 className="section-title">Battles</h2>
        <Link to="/sportsbook/battles/new" className="btn btn-primary">
          New Battle
        </Link>
      </div>
      {battlesLoading ? <LoadingState label="Loading your Battles…" rows={1} /> : null}
      {battlesError ? <p className="error-text small">{battlesError}</p> : null}
      {!battlesLoading && !battlesError && battles.length === 0 ? (
        <EmptyState icon="⚔️" title="No Battles yet">
          Challenge your friends: everyone puts in the same stake and the pot goes to the winners. Tap New Battle to start one.
        </EmptyState>
      ) : null}
      {[...needsMe, ...open].map((b) => (
        <BattleCard key={b.id} battle={b} uid={uid} />
      ))}
      {finished.length ? (
        <>
          <h3 className="day-label">Recently finished</h3>
          {finished.map((b) => (
            <BattleCard key={b.id} battle={b} uid={uid} />
          ))}
          <p className="muted small">Every Battle you've been in is also in My Bets.</p>
        </>
      ) : null}

      <div className="section-head">
        <h2 className="section-title">Challenges</h2>
        <Link to="/sportsbook/challenges/new" className="btn btn-primary">
          Post a Challenge
        </Link>
      </div>
      {challengesLoading ? <LoadingState label="Loading Challenges…" rows={1} /> : null}
      {!challengesLoading && challengesError ? <ErrorState title="Couldn't load Challenges" message={challengesError} onRetry={retryChallenges} /> : null}
      {!challengesLoading && !challengesError && challenges.length === 0 ? (
        <EmptyState icon="🎯" title="No Challenges yet">
          Post a line anyone can bet on (“Will Mike run a 5K under 25 minutes?”). It opens for betting once the admin approves it.
        </EmptyState>
      ) : null}
      {challenges.map((c) => (
        <ChallengeCard key={c.id} challenge={c} uid={uid} nowMs={nowMs} />
      ))}

      <div className="section-head">
        <h2 className="section-title">Custom games</h2>
      </div>
      <div className="board-status">
        <UpdatedAgo timestamp={board.fetchedAt} />
        {board.stale ? <span className="warning-text small">Showing the last saved list.</span> : null}
      </div>
      {board.loading ? <LoadingState label="Loading custom games…" rows={2} /> : null}
      {!board.loading && board.error && !board.games ? <ErrorState title="Couldn't load custom games" message={board.error} onRetry={board.retry} /> : null}
      {!board.loading && board.games && board.games.length === 0 ? (
        <EmptyState icon="🏟️" title="No custom games right now">
          House games the admin sets up show here, whatever their league.
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
    </>
  );
}
