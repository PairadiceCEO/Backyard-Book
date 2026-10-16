// One game: status, both teams (away on top), scores when live/final, and spread / total / moneyline.

import OddsButton from './OddsButton.jsx';
import { useBetSlip } from '../context/BetSlipContext.jsx';
import { makePick } from '../lib/betSlipReducer.js';
import { formatCentralClock, formatSpreadLine } from '../lib/format.js';

// One selectable price. A missing quote renders as "—" and can't be picked.
function PickButton({ game, marketType, selection, quote, lineLabel, ariaLabel }) {
  const slip = useBetSlip();
  if (!quote) return <OddsButton quote={null} ariaLabel={ariaLabel} />;
  const pick = makePick(game, marketType, selection, quote);
  return (
    <OddsButton
      quote={quote}
      lineLabel={lineLabel}
      ariaLabel={ariaLabel}
      selected={slip.isSelected(pick.legId)}
      onSelect={() => slip.toggle(pick)}
    />
  );
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

export default function GameCard({ game }) {
  const showScore = game.state !== 'pre';
  const sourceLabel = oddsSourceLabel(game);
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
      {game.oddsNote || sourceLabel || game.source === 'custom' ? (
        <footer className="game-footer muted small">
          {game.oddsNote ? <span>{game.oddsNote}</span> : null}
          {!game.oddsNote && sourceLabel ? (
            <span>
              {game.state === 'in' ? 'Live odds' : 'Odds'}: {sourceLabel}
            </span>
          ) : null}
          {game.source === 'custom' ? <span className="badge">custom</span> : null}
        </footer>
      ) : null}
    </article>
  );
}
