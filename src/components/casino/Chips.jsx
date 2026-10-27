// Casino chips: $1 white, $2 yellow, $5 red, $10 blue, $25 green, $100 black (0.19.0: the craps felt's look, FeltChip, on every
// game). Chips are denominations, not limits (0.16.0): a spot holds any whole-dollar amount the wallet covers.
//   ChipRack   pick a chip, plus Undo and Clear (and whatever the game adds)
//   ChipStack  what a spot holds: one chip coloured by its largest chip, with the amount printed on it

import { CHIP_VALUES } from '../../../shared/casino/constants.js';
import { FeltChip } from './FeltChip.jsx';

export { CHIP_VALUES };
const LARGEST_FIRST = [...CHIP_VALUES].sort((a, b) => b - a);

// $8 → [5, 2, 1]; $137 → [100, 25, 10, 2]. A whole-dollar amount as the fewest chips (largest first).
// `limit` stops early (a $1,000,000 spot would otherwise list 10,000 chips just to draw a few).
export function chipsFor(cents, limit = Infinity) {
  let left = Math.floor(Math.max(0, cents) / 100);
  const out = [];
  for (const d of LARGEST_FIRST) {
    const n = Math.floor(left / d);
    for (let i = 0; i < n && out.length < limit; i += 1) out.push(d);
    left -= n * d;
  }
  return out;
}

export function ChipStack({ cents }) {
  if (!(cents > 0)) return null;
  return (
    <span className="chip-stack" aria-label={`$${(cents / 100).toFixed(cents % 100 ? 2 : 0)} in chips`}>
      <FeltChip cents={cents} className="spot-chip" />
    </span>
  );
}

export function ChipRack({ chip, onChip, onUndo, onClear, canUndo, disabled = false, extra = null, rebet = null }) {
  return (
    <div className="chip-rack">
      <div className="chip-choices" role="radiogroup" aria-label="Chip">
        {CHIP_VALUES.map((d) => (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={chip === d}
            aria-label={`$${d} chip`}
            className={chip === d ? 'chip-pick active' : 'chip-pick'}
            onClick={() => onChip(d)}
            disabled={disabled}
          >
            <FeltChip dollars={d} />
          </button>
        ))}
      </div>
      {rebet}
      <div className="chip-tools">
        <button type="button" className="btn" onClick={onUndo} disabled={disabled || !canUndo}>
          Undo
        </button>
        <button type="button" className="btn" onClick={onClear} disabled={disabled || !canUndo}>
          Clear
        </button>
        {extra}
      </div>
    </div>
  );
}
