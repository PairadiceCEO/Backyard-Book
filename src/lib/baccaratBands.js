// The three Baccarat bet bands (0.26.0): concentric arcs of circles whose centre is well below the felt, across the full width.
// Top to bottom: TIE, BANKER, PLAYER. Everything is worked out in the felt's own 390 × 560 units (the felt scales with its width),
// so the printed bands (SVG) and the real buttons laid over them (clip-path polygons) always agree.
//
//   bandPath(spot)        the filled band, as an SVG path
//   edgePaths(spot)       the two thin gold outline arcs (outer, inner)
//   textPath(spot)        the arc the text runs along (left to right, text above the path)
//   textOffset(spot)      where along that arc the text is centred (a fraction)
//   buttonBox(spot)       { top, height, fullHeight } in felt units: the button is the band's top strip (THICKNESS tall, so its
//                         centre is on the band), the tap shape inside it (the .bac-spot-hit span) is fullHeight tall
//   clipPolygon(spot)     the band's shape as a CSS polygon() in percent of the full-height box (so only the band is tappable)
//   chipAnchor(spot)      where my chips sit, as percent of the button's box ({ x, y })

export const FELT_W = 390;
export const FELT_H = 560;
export const CENTER = { x: 195, y: 772 };
export const THICKNESS = 56; // radial, so every band is at least 44 px tall down to a 320 px phone (56 × 320/390 = 46)
export const GAP = 6;

const OUTER_TIE = 560;
export const BANDS = {
  tie: { outer: OUTER_TIE, inner: OUTER_TIE - THICKNESS },
  banker: { outer: OUTER_TIE - THICKNESS - GAP, inner: OUTER_TIE - 2 * THICKNESS - GAP },
  player: { outer: OUTER_TIE - 2 * THICKNESS - 2 * GAP, inner: OUTER_TIE - 3 * THICKNESS - 2 * GAP },
};

export const BAND_ORDER = ['tie', 'banker', 'player']; // top to bottom

const X0 = 0;
const X1 = FELT_W;
const TEXT_X = 132; // the text's centre
const CHIP_X = 316; // my chips

function y(r, x) {
  return CENTER.y - Math.sqrt(r * r - (x - CENTER.x) ** 2);
}

function n(v) {
  return Math.round(v * 100) / 100;
}

export function bandPath(spot) {
  const { outer, inner } = BANDS[spot];
  const a0 = [X0 - 4, y(outer, X0 - 4)];
  const a1 = [X1 + 4, y(outer, X1 + 4)];
  const b1 = [X1 + 4, y(inner, X1 + 4)];
  const b0 = [X0 - 4, y(inner, X0 - 4)];
  return `M ${n(a0[0])} ${n(a0[1])} A ${outer} ${outer} 0 0 1 ${n(a1[0])} ${n(a1[1])} L ${n(b1[0])} ${n(b1[1])} A ${inner} ${inner} 0 0 0 ${n(b0[0])} ${n(b0[1])} Z`;
}

export function edgePaths(spot) {
  const { outer, inner } = BANDS[spot];
  const arc = (r) => `M ${X0 - 4} ${n(y(r, X0 - 4))} A ${r} ${r} 0 0 1 ${X1 + 4} ${n(y(r, X1 + 4))}`;
  return [arc(outer), arc(inner)];
}

function midRadius(spot) {
  return (BANDS[spot].outer + BANDS[spot].inner) / 2;
}

export function textPath(spot) {
  const r = midRadius(spot);
  return `M ${X0 - 4} ${n(y(r, X0 - 4))} A ${r} ${r} 0 0 1 ${X1 + 4} ${n(y(r, X1 + 4))}`;
}

// The share of the arc's length at which x falls (exact: the arc's angle is asin((x − cx) / r)).
export function textOffset(spot, x = TEXT_X) {
  const r = midRadius(spot);
  const t = (px) => Math.asin((px - CENTER.x) / r);
  return (t(x) - t(X0 - 4)) / (t(X1 + 4) - t(X0 - 4));
}

export function buttonBox(spot) {
  const { outer, inner } = BANDS[spot];
  const top = y(outer, CENTER.x);
  const bottom = Math.max(y(inner, X0), y(inner, X1));
  return { top: n(top), height: THICKNESS, fullHeight: n(bottom - top) };
}

// The band as polygon() points in percent of its box: the outer arc left to right, then the inner arc right to left.
export function clipPolygon(spot, steps = 24) {
  const { outer, inner } = BANDS[spot];
  const { top, fullHeight } = buttonBox(spot);
  const pt = (r, x) => `${n((x / FELT_W) * 100)}% ${n(((y(r, x) - top) / fullHeight) * 100)}%`;
  const pts = [];
  for (let i = 0; i <= steps; i += 1) pts.push(pt(outer, X0 + ((X1 - X0) * i) / steps));
  for (let i = steps; i >= 0; i -= 1) pts.push(pt(inner, X0 + ((X1 - X0) * i) / steps));
  return `polygon(${pts.join(', ')})`;
}

export function chipAnchor(spot) {
  const r = midRadius(spot);
  const { top, height } = buttonBox(spot);
  return { x: n((CHIP_X / FELT_W) * 100), y: n(((y(r, CHIP_X) - top) / height) * 100), px: CHIP_X, py: n(y(r, CHIP_X)) };
}

// The six side-bet circles sit in a straight row under the bands.
export const SIDE_ROW = { top: 440, circle: 52, step: 62 };
