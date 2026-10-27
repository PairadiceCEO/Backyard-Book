// Casino lobby: the 7s slot and the four tables (live seats from each table doc, Sit / Watch).

import SoundToggle from '../../components/casino/SoundToggle.jsx';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BET_HELP_TEXT, CASINO_GAMES, CASINO_SEATS } from '../../../shared/casino/constants.js';
import SlotSymbol from '../../components/casino/SlotSymbol.jsx';
import { friendlyError } from '../../components/StatusViews.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useCasinoTable } from '../../hooks/useCasinoTable.js';
import { tableAction } from '../../lib/casino.js';

const ICONS = { blackjack: 'A♠', baccarat: '9♥', craps: '⚂⚄', crapless: '⚅⚀' };

function phaseLabel(table) {
  if (!table || !table.seats?.some(Boolean)) return 'Nobody playing yet';
  if (table.game === 'craps' || table.game === 'crapless') return table.point ? `Point is ${table.point}` : 'Come-out roll';
  if (table.phase === 'results') return 'Showing results';
  return table.deadline ? 'Betting now' : 'Waiting for bets';
}

// A table that's open: its 5 seats live, plus Sit (takes the first empty seat) and Watch.
function OpenTableCard({ game }) {
  const { authUser } = useAuth();
  const navigate = useNavigate();
  const { table, loading } = useCasinoTable(game.id);
  const [sitting, setSitting] = useState(false);
  const [error, setError] = useState('');

  const seats = Array.from({ length: CASINO_SEATS }, (_, i) => table?.seats?.[i] ?? null);
  const seated = seats.some((s) => s && s.uid === authUser?.uid);
  const full = seats.every(Boolean);

  async function sit() {
    setSitting(true);
    setError('');
    try {
      await tableAction(game.id, 'sit');
      navigate(`/casino/${game.id}`);
    } catch (err) {
      setError(friendlyError(err.message));
      setSitting(false);
    }
  }

  return (
    <li className="card lobby-card lobby-table">
      <div className="lobby-icon" aria-hidden="true">
        {ICONS[game.id]}
      </div>
      <div className="lobby-text">
        <strong>{game.name}</strong>
        <span className="muted small">{game.blurb}</span>
        <span className="muted small">{loading ? 'Checking the table…' : phaseLabel(table)}</span>
      </div>
      <ol className="lobby-seats" aria-label={`${game.name} seats`}>
        {seats.map((seat, i) => (
          <li key={i} className={seat ? (seat.uid === authUser?.uid ? 'lobby-seat taken mine' : 'lobby-seat taken') : 'lobby-seat'}>
            {seat ? (seat.uid === authUser?.uid ? 'You' : seat.name) : 'Empty'}
          </li>
        ))}
      </ol>
      <div className="lobby-actions">
        {seated ? (
          <Link to={`/casino/${game.id}`} className="btn btn-primary">
            Back to your seat
          </Link>
        ) : (
          <>
            <button type="button" className="btn btn-primary" onClick={sit} disabled={sitting || full || loading}>
              {sitting ? 'Sitting…' : full ? 'Table full' : 'Sit'}
            </button>
            <Link to={`/casino/${game.id}`} className="btn">
              Watch
            </Link>
          </>
        )}
      </div>
      {error ? (
        <p className="error-text small lobby-error" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

export default function CasinoLobby() {
  return (
    <section className="page">
      <div className="slots-top lobby-top">
        <h2 className="section-title">Casino</h2>
        <SoundToggle className="lobby-sound" />
      </div>
      <p className="muted small">Play money from your wallet. {BET_HELP_TEXT}</p>
      <ul className="lobby-list">
        {CASINO_GAMES.map((game) => {
          if (game.kind === 'table' && !game.opensIn) return <OpenTableCard key={game.id} game={game} />;
          return (
            <li key={game.id} className="card lobby-card">
              <div className="lobby-icon" aria-hidden="true">
                {game.kind === 'slots' ? <SlotSymbol id="R7" small /> : ICONS[game.id]}
              </div>
              <div className="lobby-text">
                <strong>{game.name}</strong>
                <span className="muted small">{game.blurb}</span>
                {game.kind === 'table' ? <span className="muted small">5 seats · watch any time</span> : null}
              </div>
              {game.opensIn ? (
                <span className="badge">Coming soon</span>
              ) : (
                <Link to={`/casino/${game.id}`} className="btn btn-primary">
                  Play
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
