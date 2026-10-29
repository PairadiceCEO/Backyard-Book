// The Baccarat table (0.26.0): a real casino felt, edge to edge (560 px on a computer), with the dealer's chip tray, the discard
// holder and the shoe along the top, two printed card boxes (PLAYER in blue print, BANKER in red print, each with its cards and a
// total pill), a gold result line, the three main bets as concentric curved bands (TIE, BANKER, PLAYER from the top; the texts run
// along the curves) and a row of six printed side-bet circles under them, with the black rail along the players' edge.
//
// The bands are drawn here (SVG, aria-hidden) and are also real buttons: PrintedSpot lays a transparent <button> over its band,
// clipped to the band's shape (src/lib/baccaratBands.js) so only the band is tappable (at least 44 px tall at every phone width).
// Look only: the buttons call the same chip handlers as before.
//
// BaccaratFelt draws the table and leaves `spotsRef` (a callback ref) on the empty box the bands' buttons go into and `sidesRef` on
// the side-bet row; the seat panel whose tab is showing puts its PrintedSpot / SideSpot buttons there (createPortal), so each keeps
// its seat-specific label. Someone who is only watching gets them rendered disabled (watcherSpots / watcherSides).
// Side bets (0.24.0): Dragon Bonus Player / Banker, Fortune 7, Heavenly 9, Golden 8, Blazing 7s; each prints its top payout, read
// from shared/casino/sideBets.js; at results a side bet says what it did ("Win 30 to 1", "Push", "Lose").

import { BACCARAT_ODDS, SPOT_LABELS } from '../../../shared/casino/baccarat.js';
import { BACCARAT_SIDE_PRINT, BACCARAT_SIDE_SPOTS, baccaratSideTopPays, sideOutcomeText } from '../../../shared/casino/sideBets.js';
import { BAND_ORDER, FELT_H, FELT_W, SIDE_ROW, bandPath, buttonBox, chipAnchor, clipPolygon, edgePaths, textOffset, textPath } from '../../lib/baccaratBands.js';
import FeltDecor from './FeltDecor.jsx';
import { ChipStack } from './Chips.jsx';
import ResultFx from './ResultFx.jsx';
import '../../styles/casinofelt.css';
import '../../styles/bacfelt.css';

export const PRINT_ODDS = { player: 'pays 1 to 1', banker: 'pays 0.95 to 1', tie: 'pays 8 to 1' };
export const SPOT_ORDER = ['player', 'banker', 'tie'];
// The felt's side-bet order, left to right (the spec's): Dragon Player, Fortune 7, Heavenly 9, Golden 8, Blazing 7s, Dragon Banker.
const PRINT_ORDER = ['dragonPlayer', 'fortune7', 'heavenly9', 'golden8', 'blazing7', 'dragonBanker'];
export const SIDE_ORDER = PRINT_ORDER.filter((spot) => BACCARAT_SIDE_SPOTS.includes(spot));

// What is printed along each band, from the same tables the server pays by.
export function bandText(spot) {
  return `${SPOT_LABELS[spot]} ${PRINT_ODDS[spot]}`.toUpperCase();
}

// One printed bet area: a transparent button over its band. `fx` = { show, netCents, stakeCents, roundKey } for my result effect.
export function PrintedSpot({ spot, cents = 0, won = false, disabled, onClick, label, fx = null }) {
  const { top, height, fullHeight } = buttonBox(spot);
  const anchor = chipAnchor(spot);
  const style = {
    top: `calc(${top} * var(--u))`,
    height: `calc(${height} * var(--u))`,
    '--chip-x': `${anchor.x}%`,
    '--chip-y': `${anchor.y}%`,
  };
  const clip = clipPolygon(spot);
  return (
    <button type="button" className={['bac-spot', spot, won ? 'won' : '', cents ? 'has-bet' : ''].filter(Boolean).join(' ')} style={style} onClick={onClick} disabled={disabled} aria-label={label}>
      {/* only the band's own shape takes taps (the clip-path also clips hit-testing), so the three overlapping boxes never steal each other's taps */}
      <span className="bac-spot-hit" style={{ height: `calc(${fullHeight} * var(--u))`, clipPath: clip, WebkitClipPath: clip }} />
      <span className="bac-spot-chipwrap">
        {cents ? <ChipStack cents={cents} /> : null}
        {fx ? <ResultFx show={fx.show} netCents={fx.netCents} stakeCents={fx.stakeCents} roundKey={fx.roundKey} /> : null}
      </span>
    </button>
  );
}

export function SideSpot({ spot, cents = 0, result = null, disabled, onClick, label }) {
  const [top, bottom] = BACCARAT_SIDE_PRINT[spot];
  const tone = result ? (result.returnCents > result.stakeCents ? 'won' : result.returnCents === result.stakeCents ? 'push' : 'lost') : '';
  return (
    <button
      type="button"
      className={['bac-side', spot, tone, cents ? 'has-bet' : ''].filter(Boolean).join(' ')}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      data-side={spot}
    >
      <span className="bac-side-disc">
        <span className="bac-side-pays" aria-hidden="true">
          {baccaratSideTopPays(spot)}:1
        </span>
        {cents ? <ChipStack cents={cents} /> : null}
        {result ? <span className="bac-side-result">{sideOutcomeText(result.returnCents, result.stakeCents)}</span> : null}
      </span>
      <span className="bac-side-name" aria-hidden="true">
        <span>{top}</span>
        <span>{bottom}</span>
      </span>
    </button>
  );
}

export function watcherLabel(spot) {
  return `${SPOT_LABELS[spot]}, pays ${BACCARAT_ODDS[spot].label}. Sit down to bet.`;
}

const TINT = { tie: 'rgba(40,170,100,.14)', banker: 'rgba(205,55,55,.13)', player: 'rgba(60,110,225,.15)' };
const INK = { tie: '#a9e8bf', banker: '#ffb7b4', player: '#bcd5ff' };

export default function BaccaratFelt({ player, banker, banner, hint, spotsRef, watcherSpots, sidesRef, watcherSides, winner = null }) {
  return (
    <div className="cfelt-box">
      <div className="cfelt bacf-felt" data-felt="baccarat">
        <FeltDecor />

        <svg className="bacf-print" viewBox={`0 0 ${FELT_W} ${FELT_H}`} aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="bacf-gold" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#a97b2c" />
              <stop offset="50%" stopColor="#e2bd62" />
              <stop offset="100%" stopColor="#a97b2c" />
            </linearGradient>
            <filter id="bacf-glow" x="-10%" y="-60%" width="120%" height="220%">
              <feGaussianBlur stdDeviation="3.5" />
            </filter>
            {BAND_ORDER.map((spot) => (
              <path key={spot} id={`bacf-text-${spot}`} d={textPath(spot)} fill="none" />
            ))}
          </defs>
          {BAND_ORDER.map((spot) => {
            const [outer, inner] = edgePaths(spot);
            const won = winner === spot;
            return (
              <g key={spot} className={won ? 'bacf-band won' : 'bacf-band'}>
                <path d={bandPath(spot)} fill="rgba(0,0,0,0.10)" />
                <path d={bandPath(spot)} fill={TINT[spot]} />
                {won ? (
                  <>
                    <path d={outer} fill="none" stroke="#f8e3a3" strokeWidth="6" opacity="0.7" filter="url(#bacf-glow)" />
                    <path d={inner} fill="none" stroke="#f8e3a3" strokeWidth="6" opacity="0.7" filter="url(#bacf-glow)" />
                  </>
                ) : null}
                <path d={outer} fill="none" stroke={won ? '#f8e3a3' : 'url(#bacf-gold)'} strokeWidth={won ? 2 : 1.5} strokeLinecap="round" />
                <path d={inner} fill="none" stroke={won ? '#f8e3a3' : 'url(#bacf-gold)'} strokeWidth={won ? 2 : 1.5} strokeLinecap="round" />
                <text className="bacf-band-text" dy="3.6" fill={INK[spot]}>
                  <textPath href={`#bacf-text-${spot}`} startOffset={`${(textOffset(spot) * 100).toFixed(2)}%`} textAnchor="middle">
                    {bandText(spot)}
                  </textPath>
                </text>
              </g>
            );
          })}
        </svg>

        <div className="bacf-boxes">
          {player}
          {banker}
        </div>
        <div className="bacf-result" aria-live="polite">
          {banner}
          {hint}
        </div>

        <div className="bacf-spots" ref={spotsRef}>
          {watcherSpots}
        </div>
        <div className="bacf-sides bact-sides" ref={sidesRef} role="group" aria-label="Side bets" style={{ top: `calc(${SIDE_ROW.top} * var(--u))` }}>
          {watcherSides}
        </div>
      </div>
    </div>
  );
}
