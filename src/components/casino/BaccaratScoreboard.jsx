// The Baccarat scoreboard: shoe summary, Bead Plate and Big Road (first tab), and the three derived
// roads (second tab). Every grid comes from buildRoads() in shared/casino/baccaratRoads.js. Each grid
// scrolls sideways inside its own panel and keeps the newest columns in view.

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DERIVED_ROADS, ROAD_ROWS, buildRoads } from '../../../shared/casino/baccaratRoads.js';

const BIG_CELL = 22; // px; the derived roads use half this
const BEAD_CELL = 24;
const SMALL_CELL = BIG_CELL / 2;
const NAMES = { B: 'Banker', P: 'Player', T: 'Tie' };

function RoadGrid({ label, summary, cell, cols, minCols, children }) {
  const scrollRef = useRef(null);
  const width = Math.max(cols, minCols) * cell;

  // Keep the newest columns in view whenever the road grows.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [cols]);

  return (
    <div className="road">
      <div className="road-head">
        <span className="road-label">{label}</span>
        {summary ? <span className="muted small">{summary}</span> : null}
      </div>
      <div className="road-scroll" ref={scrollRef}>
        <div
          className="road-grid"
          role="img"
          aria-label={`${label}: ${summary || `${cols} columns`}`}
          style={{ width: `max(100%, ${width}px)`, height: ROAD_ROWS * cell, '--cell': `${cell}px` }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function place(c, cell) {
  return { left: c.col * cell, top: c.row * cell, width: cell, height: cell };
}

export default function BaccaratScoreboard({ results }) {
  const roads = useMemo(() => buildRoads(results ?? ''), [results]);
  const [tab, setTab] = useState('main');
  const { summary } = roads;

  return (
    <section className="card scoreboard" aria-label="Scoreboard">
      <div className="score-summary">
        <span className="score-pill banker">
          Banker <strong>{summary.banker}</strong>
        </span>
        <span className="score-pill player">
          Player <strong>{summary.player}</strong>
        </span>
        <span className="score-pill tie">
          Tie <strong>{summary.tie}</strong>
        </span>
        <span className="score-pill hands">
          Hands <strong>{summary.hands}</strong>
        </span>
      </div>

      <div className="road-tabs" role="tablist" aria-label="Scoreboard roads">
        <button type="button" role="tab" aria-selected={tab === 'main'} className={tab === 'main' ? 'road-tab active' : 'road-tab'} onClick={() => setTab('main')}>
          Bead Plate · Big Road
        </button>
        <button type="button" role="tab" aria-selected={tab === 'derived'} className={tab === 'derived' ? 'road-tab active' : 'road-tab'} onClick={() => setTab('derived')}>
          Derived roads
        </button>
      </div>

      {summary.hands === 0 ? <p className="muted small road-empty">New shoe: the roads fill in as hands are played.</p> : null}

      {tab === 'main' ? (
        <>
          <RoadGrid label="Bead Plate" summary="every hand, top to bottom" cell={BEAD_CELL} cols={roads.bead.cols} minCols={12}>
            {roads.bead.cells.map((c) => (
              <span key={c.hand} className={`road-cell bead-dot bead-${c.result}`} style={place(c, BEAD_CELL)} aria-hidden="true">
                {c.result}
              </span>
            ))}
          </RoadGrid>
          <RoadGrid
            label="Big Road"
            summary={roads.bigRoad.pendingTies ? `${roads.bigRoad.pendingTies} tie${roads.bigRoad.pendingTies > 1 ? 's' : ''} waiting for the first win` : 'streaks; green slash = tie'}
            cell={BIG_CELL}
            cols={roads.bigRoad.cols}
            minCols={14}
          >
            {roads.bigRoad.cells.map((c) => (
              <span
                key={c.hand}
                className={`road-cell big-ring ring-${c.winner}`}
                style={place(c, BIG_CELL)}
                title={`${NAMES[c.winner]}${c.ties ? `, ${c.ties} tie${c.ties > 1 ? 's' : ''}` : ''}`}
                aria-hidden="true"
              >
                {c.ties ? <span className="tie-slash" /> : null}
                {c.ties > 1 ? <span className="tie-count">{c.ties}</span> : null}
              </span>
            ))}
          </RoadGrid>
        </>
      ) : (
        <>
          {DERIVED_ROADS.map((road) => {
            const data = roads[road.id];
            const kind = road.id === 'bigEyeBoy' ? 'ring' : road.id === 'smallRoad' ? 'dot' : 'slash';
            return (
              <RoadGrid
                key={road.id}
                label={road.name}
                summary={data.cells.length ? `${data.colors.filter((x) => x === 'R').length} red · ${data.colors.filter((x) => x === 'B').length} blue` : 'starts later in the shoe'}
                cell={SMALL_CELL}
                cols={data.cols}
                minCols={28}
              >
                {data.cells.map((c, i) => (
                  <span key={i} className={`road-cell derived-${kind} derived-${c.color}`} style={place(c, SMALL_CELL)} aria-hidden="true" />
                ))}
              </RoadGrid>
            );
          })}
          <p className="muted small road-key">Red = the pattern is repeating, blue = choppy. These colors are not Banker and Player.</p>
        </>
      )}
    </section>
  );
}
