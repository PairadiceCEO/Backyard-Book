// One game: the card with main lines, then one line wheel for the alternate spreads and one for the alternate totals
// (Kalshi), and a "Player props" button before the game when Kalshi has tradable props for it.

import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import EditLog from '../components/EditLog.jsx';
import GameCard from '../components/GameCard.jsx';
import LineWheel from '../components/LineWheel.jsx';
import UpdatedAgo from '../components/UpdatedAgo.jsx';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusViews.jsx';
import { useGameDetail } from '../hooks/useGameDetail.js';
import { makePick } from '../lib/betSlipReducer.js';
import { formatSpreadLine } from '../lib/format.js';

const sameLine = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;

// Spread wheel items: chips show the line from the home team's side (−3.5, −2.5, +1.5…), lowest to highest; the
// buttons are the home team and the away team at that line. Only lines with both sides tradable.
export function spreadItems(game, ladders) {
  if (!game || !ladders) return [];
  const items = [];
  for (const home of ladders.spreads.home) {
    const away = ladders.spreads.away.find((q) => sameLine(q.line, -home.line));
    if (!away) continue;
    const homeText = `${game.home.shortName} ${formatSpreadLine(home.line)}`;
    const awayText = `${game.away.shortName} ${formatSpreadLine(away.line)}`;
    items.push({
      key: `s${home.line}`,
      value: home.line,
      chip: formatSpreadLine(home.line),
      aria: `Spread ${homeText}`,
      sides: [
        { id: 'home', text: homeText, short: homeText, quote: home, pick: makePick(game, 'spread', 'home', home) },
        { id: 'away', text: awayText, short: awayText, quote: away, pick: makePick(game, 'spread', 'away', away) },
      ],
    });
  }
  return items.sort((a, b) => a.value - b.value);
}

export function totalItems(game, ladders) {
  if (!game || !ladders) return [];
  return ladders.totals
    .filter((row) => row.over && row.under)
    .map((row) => ({
      key: `t${row.line}`,
      value: row.line,
      chip: String(row.line),
      aria: `Total ${row.line}`,
      sides: [
        { id: 'over', text: `Over ${row.line}`, short: 'Over', quote: row.over, pick: makePick(game, 'total', 'over', row.over) },
        { id: 'under', text: `Under ${row.line}`, short: 'Under', quote: row.under, pick: makePick(game, 'total', 'under', row.under) },
      ],
    }))
    .sort((a, b) => a.value - b.value);
}

export default function GameDetailPage() {
  const { league, gameId } = useParams();
  const { game, ladders, propsCount, fetchedAt, stale, kalshiStatus, error, notFound, loading, retry } = useGameDetail(league, gameId);

  const finished = game && (game.state === 'post' || game.canceled);
  const spreads = useMemo(() => spreadItems(game, ladders), [game, ladders]);
  const totals = useMemo(() => totalItems(game, ladders), [game, ladders]);
  // The wheels start on the main board line.
  const mainSpread = game?.markets?.spread?.home?.line ?? null;
  const mainTotal = game?.markets?.total?.over?.line ?? null;
  const showProps = game && game.source === 'espn' && game.state === 'pre' && !game.canceled && propsCount > 0;

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

      {loading ? <LoadingState label="Loading game…" rows={4} /> : null}
      {!loading && notFound ? (
        <EmptyState
          icon="🏁"
          title="This game is no longer on the board"
          action={
            <Link to="/sportsbook" className="btn btn-primary">
              Back to board
            </Link>
          }
        >
          Finished games drop off after a while. Your bets on it are in My Bets.
        </EmptyState>
      ) : null}
      {!loading && error && !notFound && !game ? <ErrorState title="Couldn't load this game" message={error} onRetry={retry} /> : null}

      {game ? (
        <>
          <GameCard game={game} clickable={false} />

          {finished ? <p className="muted">This game is over, so no lines are offered.</p> : null}

          {!finished && game.source === 'custom' ? (
            <p className="muted small">House game: main lines only. Betting closes at the start time.</p>
          ) : null}
          {game.source === 'custom' ? <EditLog edits={game.edits} /> : null}

          {showProps ? (
            <Link to={`/sportsbook/${encodeURIComponent(game.league)}/${encodeURIComponent(game.id)}/props`} className="btn btn-primary props-link">
              Player props ({propsCount} players) ›
            </Link>
          ) : null}

          {!finished && game.source !== 'custom' ? (
            <>
              <div className="card">
                <h3>Alternate spreads {game.state === 'in' ? <span className="muted small">· live · Kalshi</span> : <span className="muted small">· Kalshi</span>}</h3>
                {spreads.length ? (
                  <LineWheel key={`spread-${game.id}`} items={spreads} initialKey={mainSpread === null ? null : `s${mainSpread}`} initialValue={mainSpread} label="spread" />
                ) : (
                  <p className="muted small">No alternate spreads posted right now.</p>
                )}
              </div>

              <div className="card">
                <h3>Alternate totals {game.state === 'in' ? <span className="muted small">· live · Kalshi</span> : <span className="muted small">· Kalshi</span>}</h3>
                {totals.length ? (
                  <LineWheel key={`total-${game.id}`} items={totals} initialKey={mainTotal === null ? null : `t${mainTotal}`} initialValue={mainTotal} label="total" />
                ) : (
                  <p className="muted small">No alternate totals posted right now.</p>
                )}
              </div>

              <p className="muted small">
                Swipe a wheel (or use ‹ ›) to pick a line. Only lines Kalshi has actually posted and that are trading are shown. A slip can
                hold one spread and one total per game; picking another replaces the first.
              </p>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
