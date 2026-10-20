// One game's player props (Kalshi, pre-game only), shown in the game page's "Player props" tab, at the same level as
// the alternate spreads and totals. Tabs per stat; under each, one row per player (name, team), sorted by team and then
// by the player's most-traded market; each row is a line wheel over that player's thresholds (starting on the threshold
// whose YES price is nearest $0.50) with "50+" / "Under 50" buttons. A player with one threshold shows just the two
// buttons. A search box filters by player name.
//
// This component is mounted only while the Player props tab is open, so the props call
// (/api/board?league=…&game=…&props=1, 30 s server memory cache) runs only then, every 30 s while it stays open, and
// stops when the player switches back to Game lines or the tab disappears at the start.

import { useMemo, useState } from 'react';
import LineWheel from './LineWheel.jsx';
import OddsButton from './OddsButton.jsx';
import { EmptyState, ErrorState, LoadingState } from './StatusViews.jsx';
import { useBetSlip } from '../context/BetSlipContext.jsx';
import { formatAmerican, formatCentralClock } from '../lib/format.js';
import { makePropPick, usePropsData } from '../lib/props.js';

function sideOf(game, tab, player, row, side) {
  const text = row.labels[side];
  return { id: side, text, short: text, quote: row[side], pick: makePropPick(game, tab, player, row, side) };
}

// Wheel items for one player: one chip per threshold ("1+", "2+", …).
function playerItems(game, tab, player) {
  return player.rows.map((row) => ({
    key: row.ticker,
    value: row.threshold,
    chip: `${row.threshold}+`,
    aria: `${player.name} ${row.threshold}+ ${tab.stat}`,
    sides: [sideOf(game, tab, player, row, 'yes'), sideOf(game, tab, player, row, 'no')],
  }));
}

function SinglePair({ game, tab, player }) {
  const slip = useBetSlip();
  const row = player.rows[0];
  return (
    <div className="wheel-buttons">
      {['yes', 'no'].map((side) => {
        const s = sideOf(game, tab, player, row, side);
        return (
          <OddsButton
            key={side}
            quote={s.quote}
            lineLabel={s.text}
            ariaLabel={s.quote ? `${player.name} ${s.text}, ${formatAmerican(s.quote.american)}` : `${player.name} ${s.text}`}
            selected={Boolean(s.pick && slip.isSelected(s.pick.legId))}
            onSelect={s.pick ? () => slip.toggle(s.pick) : null}
          />
        );
      })}
    </div>
  );
}

function PlayerRow({ game, tab, player }) {
  const items = useMemo(() => playerItems(game, tab, player), [game, tab, player]);
  return (
    <div className="card prop-player">
      <div className="prop-player-head">
        <strong>{player.name}</strong>
        <span className="muted small">{player.team ?? ''}</span>
      </div>
      {player.rows.length > 1 ? (
        <LineWheel items={items} initialKey={player.mainTicker} label={`${player.name} ${tab.stat}`} />
      ) : (
        <SinglePair game={game} tab={tab} player={player} />
      )}
    </div>
  );
}

export default function PlayerPropsSection({ league, gameId }) {
  const { game, props, error, notFound, loading, retry } = usePropsData(league, gameId);
  const [tabChoice, setTabChoice] = useState(null);
  const [query, setQuery] = useState('');

  const tabs = props?.tabs ?? [];
  const tab = tabs.find((t) => t.series === tabChoice) ?? tabs[0] ?? null; // a tab that disappears falls back to the first
  const needle = query.trim().toLowerCase();
  const players = useMemo(() => (tab ? tab.players.filter((p) => !needle || p.name.toLowerCase().includes(needle)) : []), [tab, needle]);

  if (loading) return <LoadingState label="Loading player props…" rows={4} />;
  if (notFound) return <EmptyState icon="🏁" title="This game is no longer on the board" />;
  if (!props || !game) return error ? <ErrorState title="Couldn't load player props" message={error} onRetry={retry} /> : null;

  return (
    <div className="props-section">
      <p className="muted small props-close-note">Player props · Kalshi · close at the start ({formatCentralClock(game.startTime)})</p>

      {!props.open || tabs.length === 0 ? (
        <EmptyState icon="🧍" title={props.open ? 'No player props for this game' : 'Player props are closed'}>
          {props.open ? 'Kalshi has no tradable player props for this game right now. Check back closer to the start.' : props.reason}
        </EmptyState>
      ) : (
        <>
          <div className="sub-tabs props-tabs" role="tablist" aria-label="Stat">
            {tabs.map((t) => (
              <button
                key={t.series}
                type="button"
                role="tab"
                aria-selected={t.series === tab.series}
                className={t.series === tab.series ? 'sub-tab active' : 'sub-tab'}
                onClick={() => setTabChoice(t.series)}
              >
                {t.stat}
              </button>
            ))}
          </div>
          <input
            className="props-search"
            type="search"
            placeholder="Search players"
            aria-label="Search players"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {players.length === 0 ? <p className="muted small">No player matches “{query}”.</p> : null}
          {players.map((player) => (
            <PlayerRow key={player.key} game={game} tab={tab} player={player} />
          ))}
          <p className="muted small">
            Props are pre-game only and close when the game starts. They can go in a parlay with anything from the same game, but a parlay
            can hold one pick per player per stat. Kalshi&apos;s own result settles every prop; a player who doesn&apos;t play is a void (stake back).
          </p>
        </>
      )}
    </div>
  );
}
