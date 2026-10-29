// The Spotlight card at the top of the Sportsbook (0.27.0): gold-tinted glass with a gold hairline, "SPOTLIGHT · {LEAGUE}" and the
// start time (or LIVE and the clock), both teams with logo circles and the two moneyline buttons. The game comes from the board that
// is already loaded (spotlightGame in lib/board.js); nothing is fetched here. The prices are the same PickButtons as on the cards.

import PickButton from './PickButton.jsx';
import { TeamLogo } from './GameCard.jsx';
import { formatCentralClock } from '../lib/format.js';
import { LEAGUES } from '../../shared/constants.js';

function SpotTeam({ team, side, game }) {
  return (
    <div className="spot-team">
      <TeamLogo team={team} size={44} />
      <span className="spot-team-name">{team.shortName}</span>
      {game.state === 'in' && team.score !== null ? (
        <span className="spot-team-sub spot-score">{team.score}</span>
      ) : team.record ? (
        <span className="spot-team-sub">{team.record}</span>
      ) : null}
      <PickButton
        game={game}
        marketType="moneyline"
        selection={side}
        quote={game.markets.moneyline[side]}
        lineLabel="Moneyline"
        ariaLabel={`Spotlight: ${team.shortName} moneyline`}
      />
    </div>
  );
}

export default function Spotlight({ game }) {
  if (!game) return null;
  const league = LEAGUES.find((l) => l.id === game.league)?.label ?? String(game.league || '').toUpperCase();
  return (
    <section className="spotlight gold-hairline" aria-label="Spotlight game">
      <header className="spot-head">
        <span className="spot-kicker">SPOTLIGHT · {league.toUpperCase()}</span>
        {game.state === 'in' ? (
          <span className="game-status live">
            <span className="live-pill">
              <span className="live-dot" aria-hidden="true" />
              LIVE
            </span>
            <span className="live-clock">{game.statusText || ''}</span>
          </span>
        ) : (
          <span className="spot-time">{formatCentralClock(game.startTime)}</span>
        )}
      </header>
      <div className="spot-body">
        <SpotTeam team={game.away} side="away" game={game} />
        <span className="spot-at" aria-hidden="true">
          @
        </span>
        <SpotTeam team={game.home} side="home" game={game} />
      </div>
    </section>
  );
}
