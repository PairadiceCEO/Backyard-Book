// Casino chips for the craps felt (0.18.0): a round disc with a dashed edge, coloured by the largest chip in the amount
// ($1 white with a blue edge, $2 yellow, $5 red, $10 blue, $25 green, $100 black with a gold edge) and the amount printed
// on it ("$12", "$1.2k"). 0.19.0: this is the one chip look for every casino game (the rack, every bet spot, Slots); the
// styles are in src/styles/chips.css.

import '../../styles/chips.css';
import { CHIP_VALUES } from '../../../shared/casino/constants.js';
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
// replaces the printed amount (a Come bet's "C").
export function FeltChip({ cents, dollars, mark = null, className = '' }) {
  const tier = dollars ?? chipTier(cents);
  const label = mark ?? (dollars !== undefined ? `$${dollars}` : chipAmountLabel(cents));
  return (
    <span className={['fchip', `fc-${tier}`, className].filter(Boolean).join(' ')} data-len={label.length} aria-hidden="true">
      <span className="fchip-face">{label}</span>
    </span>
  );
}
