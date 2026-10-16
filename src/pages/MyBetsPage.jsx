import { useMemo } from 'react';
import BetCard from '../components/BetCard.jsx';
import { useMyBets } from '../hooks/useMyBets.js';
import { usePolling } from '../hooks/usePolling.js';
import { requestSettlement } from '../lib/settle.js';

const SETTLE_CHECK_MS = 60 * 1000;

export default function MyBetsPage() {
  const { bets, error, loading } = useMyBets();

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

  return (
    <section className="page">
      {error ? (
        <div className="card error-text">
          {error}
          {error.toLowerCase().includes('index') ? (
            <p className="muted small">
              The bets index is missing or still building. In the Firebase console: Firestore Database → Indexes → create
              collection <code>bets</code>, <code>uid</code> Ascending, <code>placedAt</code> Descending.
            </p>
          ) : null}
        </div>
      ) : null}

      <h2 className="section-title">Active</h2>
      {loading ? <div className="card muted">Loading…</div> : null}
      {!loading && active.length === 0 ? (
        <div className="card empty-state">
          <p className="muted">No active bets. Pick a price on the Sportsbook to start a slip.</p>
        </div>
      ) : null}
      {active.map((bet) => (
        <BetCard key={bet.id} bet={bet} />
      ))}

      <h2 className="section-title">Finished</h2>
      {!loading && finished.length === 0 ? (
        <div className="card empty-state">
          <p className="muted">No finished bets yet. Bets settle automatically once ESPN marks their games final.</p>
        </div>
      ) : null}
      {finished.map((bet) => (
        <BetCard key={bet.id} bet={bet} />
      ))}
    </section>
  );
}
