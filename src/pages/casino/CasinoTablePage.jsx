// /casino/:game for the table games. Until a table's phase ships, it shows when it opens.

import { Link, Navigate, useParams } from 'react-router-dom';
import { EmptyState } from '../../components/StatusViews.jsx';
import { casinoGame } from '../../../shared/casino/constants.js';

export default function CasinoTablePage() {
  const { game: gameId } = useParams();
  const game = casinoGame(gameId);
  if (!game || game.kind !== 'table') return <Navigate to="/casino" replace />;

  return (
    <section className="page">
      <EmptyState
        icon="🎲"
        title={`${game.name} is coming soon`}
        action={
          <Link to="/casino" className="btn btn-primary">
            Back to the casino
          </Link>
        }
      >
        {game.blurb}. The table opens with 5 seats in a later casino update; the 7s slot is open now.
      </EmptyState>
    </section>
  );
}
