// One game: status, both teams (away on top), scores when live/final, and spread / total / moneyline.

import OddsButton from './OddsButton.jsx';
import { formatCentralClock, formatSpreadLine } from '../lib/format.js';

function TeamLogo({ team }) {
  const src = team.logoDark || team.logo;
  if (!src) return <span className="team-logo placeholder" aria-hidden="true" />;
  return <img className="team-logo" src={src} alt="" width="28" height="28" loading="lazy" referrerPolicy="no-referrer" />;
}

function StatusLine({ game }) {
  if (game.state === 'in') {
    return (
      <span className="game-status live">
        <span className="live-dot" aria-hidden="true" />
        {game.statusText || 'Live'}
      </span>
    );
  }
  if (game.state === 'post') {
    return <span className="game-status final">{game.statusText || 'Final'}</span>;
  }
  return <span className="game-status">{formatCentralClock(game.startTime)}</span>;
}

function TeamRow({ team, side, game, showScore }) {
  const isAway = side === 'away';
  const spread = game.markets.spread[side];
  const total = isAway ? game.markets.total.over : game.markets.total.under;
  const moneyline = game.markets.moneyline[side];
  const won =
    game.state === 'post' &&
    !game.canceled &&
    team.score !== null &&
    (isAway ? game.home.score : game.away.score) !== null &&
    team.score > (isAway ? game.home.score : game.away.score);

  return (
    <div className="team-row">
      <div className="team-info">
        <TeamLogo team={team} />
        <span className={won ? 'team-name winner' : 'team-name'}>{team.shortName}</span>
      </div>
      <span className="team-score">{showScore && team.score !== null ? team.score : ''}</span>
      <OddsButton
        quote={spread}
        lineLabel={spread ? formatSpreadLine(spread.line) : ''}
        ariaLabel={`${team.shortName} spread`}
      />
      <OddsButton
        quote={total}
        lineLabel={total ? `${isAway ? 'O' : 'U'} ${total.line}` : ''}
        ariaLabel={`${isAway ? 'Over' : 'Under'} total`}
      />
      <OddsButton quote={moneyline} ariaLabel={`${team.shortName} moneyline`} />
    </div>
  );
}

export default function GameCard({ game }) {
  const showScore = game.state !== 'pre';
  return (
    <article className={`game-card state-${game.state}`}>
      <header className="game-header">
        <StatusLine game={game} />
        <div className="market-labels" aria-hidden="true">
          <span>Spread</span>
          <span>Total</span>
          <span>Money</span>
        </div>
      </header>
      <TeamRow team={game.away} side="away" game={game} showScore={showScore} />
      <TeamRow team={game.home} side="home" game={game} showScore={showScore} />
      {game.oddsNote || game.source === 'custom' ? (
        <footer className="game-footer muted small">
          {game.oddsNote ? <span>{game.oddsNote}</span> : null}
          {game.source === 'custom' ? <span className="badge">custom</span> : null}
        </footer>
      ) : null}
    </article>
  );
}
