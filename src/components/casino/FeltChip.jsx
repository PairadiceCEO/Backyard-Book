// Casino chips for every game (0.19.0), the Pairadice house chip since 0.26.0 (HouseChip.jsx, an SVG; the colours per
// denomination are in HOUSE_CHIP_COLORS: $1 white with blue inserts, $2 yellow, $5 red, $10 blue, $25 green, $100 black with
// gold, $1,000 orange, $10,000 purple). A spot's chip is coloured by the largest chip in its amount. The chip face no longer
// prints the amount, so the amount sits on a small label over the chip's lower edge ("$12", "$1.2k"); a rack chip labels its
// value the same way. The styles are in src/styles/chips.css.

import '../../styles/chips.css';
import { CHIP_VALUES } from '../../../shared/casino/constants.js';
import HouseChip from './HouseChip.jsx';
import { chipsFor } from './Chips.jsx';

// 1200 → "$1.2k", 1000 → "$1k", 12 → "$12"; rounded down, so a chip never shows more than the spot holds.
export function chipAmountLabel(cents) {
  const safe = Math.max(0, Math.floor(Number(cents) || 0));
  if (safe < 100_000) return safe % 100 === 0 ? `$${safe / 100}` : `$${(safe / 100).toFixed(2)}`;
  const dollars = Math.floor(safe / 100);
  const [unit, suffix] = dollars < 1_000_000 ? [1_000, 'k'] : [1_000_000, 'M'];
  return `$${Math.floor(dollars / (unit / 10)) / 10}${suffix}`;
}

// The denomination that colours a spot's chip: the largest chip that fits in the amount ($137 → $100, $3 → $2).
export function chipTier(cents) {
  return chipsFor(cents, 1)[0] ?? CHIP_VALUES[0];
}

// One chip. Pass `cents` (a spot's amount, coloured by its largest chip) or `dollars` (a rack chip, e.g. 25). `mark`
// replaces the label (a Come bet's "C").
export function FeltChip({ cents, dollars, mark = null, className = '' }) {
  const tier = dollars ?? chipTier(cents);
  const label = mark ?? chipAmountLabel(dollars !== undefined ? dollars * 100 : cents);
  return (
    <span className={['fchip', `fc-${tier}`, className].filter(Boolean).join(' ')} data-len={label.length} aria-hidden="true">
      <HouseChip dollars={tier} />
      <span className="fchip-face">{label}</span>
    </span>
  );
}
