// Hand-built SVG line chart of Coinbase 1-minute closes for the last 60 minutes (ending now, rolling with each refresh),
// with labeled horizontal lines (the 15-min target, the hourly main strike); `marks` can draw vertical marks at times
// inside the window. Scales to its container's width
// (viewBox), so it fits 320–414 px phones. No library.
//
// Scrubber: touching the chart (or hovering it with a mouse) shows a vertical line and a dot at the nearest 1-minute
// point, with its time and price (and "Target $X" when a target line is close by). Dragging moves it; lifting the
// finger, or the mouse leaving, hides it. The chart has touch-action: pan-y, so vertical swipes still scroll the page
// (the browser then cancels the pointer and the scrubber hides) while horizontal drags scrub.
// The scrubber remembers the point's TIMESTAMP, so the 10-second data refresh keeps it on the same minute (or the
// nearest one if that minute is gone — once it scrolls off the left edge, that is the oldest point) instead of jumping.
//
// Loop safety: React pointer handlers only (removed with the element on unmount), no document listeners or timers;
// state is set only from pointer events and only when the chosen minute changes; geometry is memoized on the data.

import { useCallback, useMemo, useRef, useState } from 'react';
import { formatCloseClock, formatCryptoPrice } from '../../../shared/crypto/coins.js';

const W = 340;
const H = 200;
const PAD = { top: 12, right: 8, bottom: 22, left: 8 };
const NEAR_LEVEL = 0.06; // a target line within 6% of the chart's price range counts as "near"
const LABEL_GAP = 6;
const CHAR_W = 6.1; // ~ width of one 11px character in the label, for keeping it inside the chart

// Short price for an axis-side label: "$81,932" for big numbers, more decimals for small ones.
function shortPrice(v) {
  if (Math.abs(v) >= 1000) return `$${Math.round(v).toLocaleString('en-US')}`;
  return formatCryptoPrice(Number(v.toPrecision(5)));
}

// A chart price: cents for anything $100 and up, 4 decimals above $1, 6 below (1-minute closes can carry noise).
export function chartPrice(v) {
  const decimals = Math.abs(v) >= 100 ? 2 : Math.abs(v) >= 1 ? 4 : 6;
  return formatCryptoPrice(Number(v.toFixed(decimals)));
}

export function nearestPoint(points, t) {
  let best = null;
  for (const p of points) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  return best;
}

// Where the scrubber's label box goes: to the right of the line, or flipped left near the right edge; inside the chart.
export function labelBox(lineX, lines) {
  const width = Math.max(...lines.map((s) => s.length)) * CHAR_W + 12;
  const height = lines.length * 13 + 8;
  const right = lineX + LABEL_GAP;
  const x = right + width <= W - PAD.right ? right : Math.max(PAD.left, lineX - LABEL_GAP - width);
  return { x, y: PAD.top, width, height };
}

export default function CryptoChart({ chart, levels = [], marks = [] }) {
  const svgRef = useRef(null);
  const touchingRef = useRef(false);
  const [scrubT, setScrubT] = useState(null);

  const geometry = useMemo(() => {
    if (!chart || !Array.isArray(chart.points) || chart.points.length < 2) return null;
    const x0 = Date.parse(chart.from);
    const x1 = Date.parse(chart.to);
    if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) return null;
    const values = chart.points.map((p) => p.c);
    const levelValues = levels.map((l) => l.value).filter(Number.isFinite);
    let lo = Math.min(...values, ...levelValues);
    let hi = Math.max(...values, ...levelValues);
    if (hi === lo) {
      hi += Math.abs(hi) * 0.001 || 1;
      lo -= Math.abs(lo) * 0.001 || 1;
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const x = (t) => PAD.left + ((t - x0) / (x1 - x0)) * (W - PAD.left - PAD.right);
    const y = (v) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);
    const tAt = (svgX) => x0 + ((svgX - PAD.left) / (W - PAD.left - PAD.right)) * (x1 - x0);
    const path = chart.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.c).toFixed(1)}`).join(' ');
    return { x, y, tAt, lo, hi, path, x0, x1, points: chart.points, last: chart.points[chart.points.length - 1] };
  }, [chart, levels]);

  // The handlers read the newest geometry through a ref, so they never need to be re-created.
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;

  const scrubTo = useCallback((clientX) => {
    const g = geometryRef.current;
    const svg = svgRef.current;
    if (!g || !svg) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const p = nearestPoint(g.points, g.tAt(((clientX - rect.left) / rect.width) * W));
    if (p) setScrubT((prev) => (prev === p.t ? prev : p.t));
  }, []);

  const onPointerDown = useCallback(
    (e) => {
      if (e.pointerType === 'mouse') return;
      touchingRef.current = true;
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId); // keep the drag even if the finger slides off the chart
      } catch {
        // Not every pointer can be captured (e.g. synthetic events); scrubbing still works without it.
      }
      scrubTo(e.clientX);
    },
    [scrubTo],
  );
  const onPointerMove = useCallback(
    (e) => {
      if (e.pointerType === 'mouse' || touchingRef.current) scrubTo(e.clientX);
    },
    [scrubTo],
  );
  const onPointerEnd = useCallback((e) => {
    if (e.pointerType === 'mouse') return; // a mouse button release keeps the hover
    touchingRef.current = false;
    setScrubT(null);
  }, []);
  const onPointerLeave = useCallback((e) => {
    if (e.pointerType !== 'mouse') return; // a finger leaving the edge keeps scrubbing (pointer capture)
    setScrubT(null);
  }, []);

  if (!geometry) {
    return (
      <div className="crypto-chart unavailable" role="img" aria-label="Chart unavailable">
        Chart unavailable
      </div>
    );
  }

  const { x, y, lo, hi, path, x0, x1, last, points } = geometry;
  // The scrubber stays on its minute across refreshes; if that minute is gone, the nearest one.
  const scrub = scrubT === null ? null : nearestPoint(points, scrubT);
  let scrubUi = null;
  if (scrub) {
    const lineX = x(scrub.t);
    const near = levels.filter((l) => Number.isFinite(l.value) && Math.abs(l.value - scrub.c) <= (hi - lo) * NEAR_LEVEL);
    const lines = [formatCloseClock(new Date(scrub.t)), chartPrice(scrub.c)];
    for (const l of near) lines.push(`${l.kind === 'strike' ? 'Hourly target' : 'Target'} ${formatCryptoPrice(l.value)}`);
    const box = labelBox(lineX, lines);
    scrubUi = (
      <g className="chart-scrub" aria-hidden="true">
        <line className="scrub-line" x1={lineX} x2={lineX} y1={PAD.top} y2={H - PAD.bottom} />
        <circle className="scrub-dot" cx={lineX} cy={y(scrub.c)} r="4" />
        <rect className="scrub-box" x={box.x} y={box.y} width={box.width} height={box.height} rx="5" />
        {lines.map((text, i) => (
          <text key={text} className={i === 1 ? 'scrub-text price' : 'scrub-text'} x={box.x + 6} y={box.y + 15 + i * 13}>
            {text}
          </text>
        ))}
      </g>
    );
  }

  return (
    <svg
      ref={svgRef}
      className={scrub ? 'crypto-chart scrubbing' : 'crypto-chart'}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={scrub ? `${formatCloseClock(new Date(scrub.t))}: ${chartPrice(scrub.c)}` : 'Price over the last 60 minutes, 1-minute closes'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onPointerLeave={onPointerLeave}
    >
      <line className="chart-axis" x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} />
      <text className="chart-tick" x={PAD.left} y={H - 6}>
        {formatCloseClock(new Date(x0))}
      </text>
      <text className="chart-tick" x={W - PAD.right} y={H - 6} textAnchor="end">
        {formatCloseClock(new Date(x1))}
      </text>
      {marks
        .filter((m) => Number.isFinite(m.t) && m.t > x0 && m.t <= x1)
        .map((m, i) => (
          <g key={`m-${m.label}`}>
            <line className={`chart-mark ${m.kind}`} x1={x(m.t)} x2={x(m.t)} y1={PAD.top} y2={H - PAD.bottom} />
            <text className={`chart-mark-label ${m.kind}`} x={x(m.t) - 3} y={PAD.top + 8 + i * 12} textAnchor="end">
              {m.label}
            </text>
          </g>
        ))}
      {levels
        .filter((l) => Number.isFinite(l.value))
        .map((l, i) => (
          <g key={`l-${l.label}`}>
            <line className={`chart-level ${l.kind}`} x1={PAD.left} x2={W - PAD.right} y1={y(l.value)} y2={y(l.value)} />
            <text className={`chart-level-label ${l.kind}`} x={PAD.left + 4} y={y(l.value) + (i % 2 ? 12 : -4)}>
              {l.label} {shortPrice(l.value)}
            </text>
          </g>
        ))}
      <path className="chart-line" d={path} />
      <circle className="chart-dot" cx={x(last.t)} cy={y(last.c)} r="3" />
      {scrubUi}
    </svg>
  );
}
