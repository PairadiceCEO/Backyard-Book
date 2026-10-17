// Casino lobby: the 7s slot (open now) and the four table games (each opens in a later casino phase).

import { Link } from 'react-router-dom';
import { CASINO_GAMES } from '../../../shared/casino/constants.js';
import SlotSymbol from '../../components/casino/SlotSymbol.jsx';

const ICONS = { blackjack: 'A♠', baccarat: '9♥', craps: '⚂⚄', crapless: '⚅⚀' };

export default function CasinoLobby() {
  return (
    <section className="page">
      <h2 className="section-title">Casino</h2>
      <p className="muted small">Play money from your wallet. Bets are $1–$10.</p>
      <ul className="lobby-list">
        {CASINO_GAMES.map((game) => (
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
        ))}
      </ul>
    </section>
  );
}
