import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import BetCard from '../components/BetCard.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusViews.jsx';
import { useMyBets } from '../hooks/useMyBets.js';
import { usePolling } from '../hooks/usePolling.js';
import { requestSettlement } from '../lib/settle.js';

const SETTLE_CHECK_MS = 60 * 1000;

export default function MyBetsPage() {
  const { bets, error, loading, retry } = useMyBets();

  // On load and every minute while this page is visible, ask the server to settle finished games.
  // Results arrive through the live bets listener; requestSettlement is a stable module function.
  usePolling(requestSettlement, SETTLE_CHECK_MS, 'my-bets');

  const { active, finished } = useMemo(
    () => ({
      active: bets.filter((b) => b.status === 'open'),
      finished: bets.filter((b) => b.status !== 'open'),
    }),
    [bets],
  );

  if (loading) {
    return (
      <section className="page">
        <h2 className="section-title">My Bets</h2>
        <LoadingState label="Loading your bets…" rows={3} />
      </section>
    );
  }

  if (error) {
    return (
      <section className="page">
        <h2 className="section-title">My Bets</h2>
        <ErrorState title="Couldn't load your bets" message={error} onRetry={retry} />
      </section>
    );
  }

  if (bets.length === 0) {
    return (
      <section className="page">
        <h2 className="section-title">My Bets</h2>
        <EmptyState
          icon="🎟️"
          title="No bets yet"
          action={
            <Link to="/sportsbook" className="btn btn-primary">
              Go to the Sportsbook
            </Link>
          }
        >
          Tap any price on the board to add it to your bet slip. Your bets show up here, and settle on their own when games end.
        </EmptyState>
      </section>
    );
  }

  return (
    <section className="page">
      <h2 className="section-title">Active ({active.length})</h2>
      {active.length === 0 ? (
        <EmptyState title="No active bets">Everything you've bet on has finished. Pick a price on the Sportsbook to start a slip.</EmptyState>
      ) : null}
      {active.map((bet) => (
        <BetCard key={bet.id} bet={bet} />
      ))}

      <h2 className="section-title">Finished ({finished.length})</h2>
      {finished.length === 0 ? (
        <EmptyState title="Nothing settled yet">Bets settle automatically once their games are final.</EmptyState>
      ) : null}
      {finished.map((bet) => (
        <BetCard key={bet.id} bet={bet} />
      ))}
    </section>
  );
}
