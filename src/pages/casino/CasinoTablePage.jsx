// /casino/:game for the table games: the open ones render their table; the rest say when they open.

import { Link, Navigate, useParams } from 'react-router-dom';
import { EmptyState } from '../../components/StatusViews.jsx';
import { casinoGame } from '../../../shared/casino/constants.js';
import BaccaratPage from './BaccaratPage.jsx';
import BlackjackPage from './BlackjackPage.jsx';

const TABLES = { baccarat: BaccaratPage, blackjack: BlackjackPage };

export default function CasinoTablePage() {
  const { game: gameId } = useParams();
  const game = casinoGame(gameId);
  if (!game || game.kind !== 'table') return <Navigate to="/casino" replace />;

  const Table = !game.opensIn ? TABLES[game.id] : null;
  if (Table) return <Table />;

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
        {game.blurb}. The table opens with 5 seats in a later casino update; Blackjack, Baccarat and the 7s slot are open now.
      </EmptyState>
    </section>
  );
}
