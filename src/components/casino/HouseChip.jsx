// The Pairadice house chip (0.26.0): one SVG for every casino game (Blackjack, Baccarat, Craps, the Slots bet picker).
// 320 × 320 viewBox, centre (160, 158): a base disc with a radial gradient, a thin dark bevel, eight edge inserts, an inner band,
// a dotted gold ring, the ring text ("PAIRADICE ✦ $25 ✦ CASINO ✦ $25 ✦", Cinzel; unreadable at small sizes, which is intended), a
// centre disc with a gold rim and the Pairadice dice mark. The face never prints the amount in its centre: the callers show it
// beside the chip (rack chips and bet stacks, FeltChip's label).
// Every SVG id is unique per instance (React useId), so many chips on one page never share a gradient.
// The look comes from the colour table below (the approved mockup); nothing here is behaviour.

import { useId } from 'react';
import { chipName } from '../../../shared/casino/constants.js';
import { HOUSE_CHIP_COLORS, chipRingValue } from '../../lib/houseChipColors.js';

export { HOUSE_CHIP_COLORS, chipRingValue };

// The gold gradient (vertical) every gold part of a chip, and the dice mark, uses.
export function GoldGradient({ id }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor="#f8e3a3" />
      <stop offset="50%" stopColor="#e2bd62" />
      <stop offset="100%" stopColor="#a97b2c" />
    </linearGradient>
  );
}

// The Pairadice dice mark (viewBox 0 0 64 64), the same everywhere it appears. `gradId` = the id of a GoldGradient in the
// same SVG (the mark's "G").
export function PairadiceMarkShapes({ gradId }) {
  const g = `url(#${gradId})`;
  return (
    <>
      <g transform="rotate(-12 20 36)">
        <rect x="5" y="21" width="30" height="30" rx="7" fill="#0d0d10" stroke={g} strokeWidth="2.4" />
        <circle cx="13" cy="29" r="2.7" fill={g} />
        <circle cx="27" cy="29" r="2.7" fill={g} />
        <circle cx="20" cy="36" r="2.7" fill={g} />
        <circle cx="13" cy="43" r="2.7" fill={g} />
        <circle cx="27" cy="43" r="2.7" fill={g} />
      </g>
      <g transform="rotate(12 44 28)">
        <rect x="29" y="13" width="30" height="30" rx="7" fill="#0d0d10" stroke={g} strokeWidth="2.4" />
        <circle cx="37" cy="21" r="2.7" fill={g} />
        <circle cx="51" cy="35" r="2.7" fill={g} />
      </g>
    </>
  );
}

// The mark on its own (headers, the next phase's brand): a 64 × 64 SVG.
export function PairadiceMark({ size = 32, className = '' }) {
  const id = `pm${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <GoldGradient id={id} />
      </defs>
      <PairadiceMarkShapes gradId={id} />
    </svg>
  );
}

// One chip. `dollars` is a denomination from CHIP_VALUES. Size it with CSS (width / height of the SVG or its parent).
export default function HouseChip({ dollars, className = '', style = undefined }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const c = HOUSE_CHIP_COLORS[dollars] ?? HOUSE_CHIP_COLORS[1];
  const fill = `hc${uid}f`;
  const gold = `hc${uid}g`;
  const path = `hc${uid}p`;
  const value = chipRingValue(dollars);
  return (
    <svg className={['house-chip', className].filter(Boolean).join(' ')} style={style} viewBox="0 0 320 320" role="img" aria-label={`${chipName(dollars)} chip`} focusable="false">
      <defs>
        <radialGradient id={fill} cx="50%" cy="38%" r="75%">
          <stop offset="0%" stopColor={c.hi} />
          <stop offset="100%" stopColor={c.base} />
        </radialGradient>
        <GoldGradient id={gold} />
        <path id={path} d="M160,62 a98,98 0 1,1 -0.01,0" fill="none" />
      </defs>
      <circle cx="160" cy="158" r="156" fill={`url(#${fill})`} />
      <circle cx="160" cy="158" r="155" fill="none" stroke="rgba(0,0,0,.4)" strokeWidth="2" />
      <circle cx="160" cy="158" r="141" fill="none" stroke={c.ins} strokeWidth="26" strokeDasharray="34.6 76.1" />
      <circle cx="160" cy="158" r="127" fill="rgba(0,0,0,.16)" stroke="rgba(255,255,255,.28)" strokeWidth="1.5" />
      <circle cx="160" cy="158" r="115" fill="none" stroke={`url(#${gold})`} strokeWidth="1.6" strokeDasharray="2 4" />
      <text transform="translate(0,-2)" fill={c.ring} fontFamily="Cinzel, Georgia, serif" fontWeight="700" fontSize="16" letterSpacing="2">
        <textPath href={`#${path}`} textLength="606" lengthAdjust="spacing">
          {`PAIRADICE ✦ ${value} ✦ CASINO ✦ ${value} ✦`}
        </textPath>
      </text>
      <circle cx="160" cy="158" r="76" fill={`url(#${fill})`} stroke={`url(#${gold})`} strokeWidth="2.5" />
      <g transform="translate(160,158) scale(1.55) translate(-32,-32)">
        <PairadiceMarkShapes gradId={gold} />
      </g>
    </svg>
  );
}
