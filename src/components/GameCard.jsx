// One game: status, both teams (away on top), scores when live/final, and spread / total / moneyline.

import { useNavigate } from 'react-router-dom';
import PickButton from './PickButton.jsx';
import { formatCentralClock, formatSpreadLine } from '../lib/format.js';

export function gamePath(game) {
  return `/sportsbook/${game.league}/${encodeURIComponent(game.id)}`;
}

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
      <PickButton
        game={game}
        marketType="spread"
        selection={side}
        quote={spread}
        lineLabel={spread ? formatSpreadLine(spread.line) : ''}
        ariaLabel={`${team.shortName} spread`}
      />
      <PickButton
        game={game}
        marketType="total"
        selection={isAway ? 'over' : 'under'}
        quote={total}
        lineLabel={total ? `${isAway ? 'O' : 'U'} ${total.line}` : ''}
        ariaLabel={`${isAway ? 'Over' : 'Under'} total`}
      />
      <PickButton game={game} marketType="moneyline" selection={side} quote={moneyline} ariaLabel={`${team.shortName} moneyline`} />
    </div>
  );
}

const SOURCE_LABELS = { espn: 'DraftKings', kalshi: 'Kalshi', custom: 'House', sharpapi: 'SharpAPI' };

// Which providers priced this game, e.g. "DraftKings + Kalshi".
function oddsSourceLabel(game) {
  const found = new Set();
  for (const sides of Object.values(game.markets)) {
    for (const quote of Object.values(sides)) {
      if (quote) found.add(quote.source === 'espn' ? quote.ref?.provider || 'DraftKings' : SOURCE_LABELS[quote.source] || quote.source);
    }
  }
  return [...found].join(' + ');
}

// clickable: tapping the card (anywhere except a price) opens the game page.
export default function GameCard({ game, clickable = true }) {
  const navigate = useNavigate();
  const showScore = game.state !== 'pre';
  const sourceLabel = oddsSourceLabel(game);

  function open(event) {
    if (event.target.closest('button, a, input, label')) return; // price taps go to the slip
    navigate(gamePath(game));
  }

  function openWithKey(event) {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      navigate(gamePath(game));
    }
  }

  const interactive = clickable
    ? {
        onClick: open,
        onKeyDown: openWithKey,
        role: 'link',
        tabIndex: 0,
        'aria-label': `${game.away.shortName} at ${game.home.shortName}: all lines`,
      }
    : {};

  return (
    <article className={`game-card state-${game.state}${clickable ? ' clickable' : ''}`} {...interactive}>
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
      {game.oddsNote || sourceLabel || game.source === 'custom' || clickable ? (
        <footer className="game-footer muted small">
          {game.oddsNote ? <span>{game.oddsNote}</span> : null}
          {!game.oddsNote && sourceLabel ? (
            <span>
              {game.state === 'in' ? 'Live odds' : 'Odds'}: {sourceLabel}
            </span>
          ) : null}
          {game.source === 'custom' ? <span className="badge">custom</span> : null}
          {clickable ? <span className="more-lines">All lines ›</span> : null}
        </footer>
      ) : null}
    </article>
  );
}
