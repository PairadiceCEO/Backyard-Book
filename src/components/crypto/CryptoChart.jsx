// Hand-built SVG line chart of Coinbase 1-minute closes for the current hour, with labeled horizontal lines (the
// 15-min target, the hourly main strike) and vertical marks at the close times. Scales to its container's width
// (viewBox), so it fits 320–414 px phones. No library.

import { useMemo } from 'react';
import { formatCloseClock, formatCryptoPrice } from '../../../shared/crypto/coins.js';

const W = 340;
const H = 200;
const PAD = { top: 12, right: 8, bottom: 22, left: 8 };

// Short price for an axis-side label: "$81,932" for big numbers, more decimals for small ones.
function shortPrice(v) {
  if (Math.abs(v) >= 1000) return `$${Math.round(v).toLocaleString('en-US')}`;
  return formatCryptoPrice(Number(v.toPrecision(5)));
}

export default function CryptoChart({ chart, levels = [], marks = [] }) {
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
    const path = chart.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.c).toFixed(1)}`).join(' ');
    return { x, y, path, x0, x1, last: chart.points[chart.points.length - 1] };
  }, [chart, levels]);

  if (!geometry) {
    return (
      <div className="crypto-chart unavailable" role="img" aria-label="Chart unavailable">
        Chart unavailable
      </div>
    );
  }

  const { x, y, path, x0, x1, last } = geometry;
  return (
    <svg className="crypto-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Price over the current hour, 1-minute closes">
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
    </svg>
  );
}
