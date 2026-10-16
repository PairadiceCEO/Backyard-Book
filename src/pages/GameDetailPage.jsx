// One game: the card with main lines, then every posted alternate spread and total (Kalshi).

import { Link, useParams } from 'react-router-dom';
import GameCard from '../components/GameCard.jsx';
import PickButton from '../components/PickButton.jsx';
import UpdatedAgo from '../components/UpdatedAgo.jsx';
import { useGameDetail } from '../hooks/useGameDetail.js';
import { formatSpreadLine } from '../lib/format.js';

function SpreadLadder({ game, side, quotes }) {
  const team = game[side];
  return (
    <div className="ladder-column">
      <h4 className="ladder-team">{team.shortName}</h4>
      {quotes.length === 0 ? <p className="muted small">None posted</p> : null}
      <div className="ladder-list">
        {quotes.map((quote) => (
          <PickButton
            key={`${quote.ref?.ticker}:${quote.ref?.side}`}
            game={game}
            marketType="spread"
            selection={side}
            quote={quote}
            lineLabel={formatSpreadLine(quote.line)}
            ariaLabel={`${team.shortName} ${formatSpreadLine(quote.line)}`}
          />
        ))}
      </div>
    </div>
  );
}

function TotalsLadder({ game, rows }) {
  if (rows.length === 0) return <p className="muted small">No alternate totals posted right now.</p>;
  return (
    <div className="totals-ladder">
      <div className="totals-row totals-head muted small">
        <span>Line</span>
        <span>Over</span>
        <span>Under</span>
      </div>
      {rows.map((row) => (
        <div key={row.line} className="totals-row">
          <span className="totals-line">{row.line}</span>
          {row.over ? (
            <PickButton game={game} marketType="total" selection="over" quote={row.over} lineLabel={`O ${row.line}`} ariaLabel={`Over ${row.line}`} />
          ) : (
            <span />
          )}
          {row.under ? (
            <PickButton game={game} marketType="total" selection="under" quote={row.under} lineLabel={`U ${row.line}`} ariaLabel={`Under ${row.line}`} />
          ) : (
            <span />
          )}
        </div>
      ))}
    </div>
  );
}

export default function GameDetailPage() {
  const { league, gameId } = useParams();
  const { game, ladders, fetchedAt, stale, kalshiStatus, error, notFound, loading } = useGameDetail(league, gameId);

  const finished = game && (game.state === 'post' || game.canceled);
  const hasSpreads = ladders && (ladders.spreads.home.length > 0 || ladders.spreads.away.length > 0);

  return (
    <section className="page">
      <div className="detail-top">
        <Link to="/sportsbook" className="btn btn-ghost small">
          ‹ Back to board
        </Link>
        <UpdatedAgo timestamp={fetchedAt} />
      </div>

      {stale ? <p className="warning-text small">ESPN didn't answer; showing the last saved data.</p> : null}
      {kalshiStatus === 'failed' ? <p className="warning-text small">Kalshi isn't answering, so alternate lines may be missing.</p> : null}

      {loading ? <div className="card muted">Loading game…</div> : null}
      {!loading && notFound ? (
        <div className="card empty-state">
          <p className="muted">This game is no longer on the board.</p>
          <Link to="/sportsbook" className="btn btn-primary">
            Back to board
          </Link>
        </div>
      ) : null}
      {!loading && error && !notFound && !game ? <div className="card error-text">{error}</div> : null}

      {game ? (
        <>
          <GameCard game={game} clickable={false} />

          {finished ? <p className="muted">This game is over, so no lines are offered.</p> : null}

          {!finished && game.source === 'custom' ? (
            <p className="muted small">House game: main lines only. Betting closes at the start time.</p>
          ) : null}

          {!finished && game.source !== 'custom' ? (
            <>
              <div className="card">
                <h3>Alternate spreads {game.state === 'in' ? <span className="muted small">· live · Kalshi</span> : <span className="muted small">· Kalshi</span>}</h3>
                {hasSpreads ? (
                  <div className="ladder-grid">
                    <SpreadLadder game={game} side="away" quotes={ladders.spreads.away} />
                    <SpreadLadder game={game} side="home" quotes={ladders.spreads.home} />
                  </div>
                ) : (
                  <p className="muted small">No alternate spreads posted right now.</p>
                )}
              </div>

              <div className="card">
                <h3>Alternate totals {game.state === 'in' ? <span className="muted small">· live · Kalshi</span> : <span className="muted small">· Kalshi</span>}</h3>
                <TotalsLadder game={game} rows={ladders ? ladders.totals : []} />
              </div>

              <p className="muted small">
                Only lines Kalshi has actually posted and that are trading are shown. A slip can hold one spread and one total per game;
                picking another replaces the first.
              </p>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
