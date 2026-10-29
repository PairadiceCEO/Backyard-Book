// Casino chips: $1 white, $2 yellow, $5 red, $10 blue, $25 green, $100 black, $1,000 orange, $10,000 purple (0.19.0: FeltChip on
// every game; 0.23.0: the last two; 0.26.0: the Pairadice house chip, HouseChip.jsx). Chips are denominations, not limits
// (0.16.0): a spot holds any whole-dollar amount the wallet covers. The rack is two rows of four on phones, one row of eight on
// wide screens, in a glass panel with Rebet / Max / Undo / Clear in one row under it and the game's main button below that.
//   ChipRack   pick a chip, plus Undo and Clear (and whatever the game adds)
//   ChipStack  what a spot holds: chipsFor() splits the amount into chips (at most STACK_MAX drawn), 3 px apart with a shadow,
//              the total on a label over the top one

import { CHIP_VALUES, chipName } from '../../../shared/casino/constants.js';
import { FeltChip, chipAmountLabel } from './FeltChip.jsx';
import HouseChip from './HouseChip.jsx';

export { CHIP_VALUES };
const LARGEST_FIRST = [...CHIP_VALUES].sort((a, b) => b - a);

// $8 → [5, 2, 1]; $137 → [100, 25, 10, 2]; $12,130 → [10000, 1000, 1000, 100, 25, 5]. A whole-dollar amount as the fewest
// chips (largest first).
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

export const STACK_MAX = 6;
export const STACK_STEP_PX = 3;

export function ChipStack({ cents }) {
  if (!(cents > 0)) return null;
  // Largest chips at the bottom; a sub-dollar amount (it can't happen at the tables, but a spot never shows nothing) is one $1 chip.
  const list = chipsFor(cents, STACK_MAX);
  const chips = list.length ? list : [CHIP_VALUES[0]];
  return (
    <span className="chip-stack" aria-label={`$${(cents / 100).toFixed(cents % 100 ? 2 : 0)} in chips`} style={{ '--stack-n': chips.length, '--stack-step': `${STACK_STEP_PX}px` }}>
      <span className="chip-stack-chips" aria-hidden="true">
        {chips.map((d, i) => (
          <HouseChip key={i} dollars={d} className="spot-chip-disc" style={{ bottom: `${i * STACK_STEP_PX}px` }} />
        ))}
      </span>
      <span className="chip-stack-total" aria-hidden="true">
        {chipAmountLabel(cents)}
      </span>
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
            aria-label={`${chipName(d)} chip`}
            className={chip === d ? 'chip-pick active' : 'chip-pick'}
            onClick={() => onChip(d)}
            disabled={disabled}
          >
            <FeltChip dollars={d} />
          </button>
        ))}
      </div>
      <div className="chip-actions">
        {rebet}
        <button type="button" className="btn chip-act" onClick={onUndo} disabled={disabled || !canUndo}>
          Undo
        </button>
        <button type="button" className="btn chip-act" onClick={onClear} disabled={disabled || !canUndo}>
          Clear
        </button>
      </div>
      {extra ? <div className="chip-main">{extra}</div> : null}
    </div>
  );
}
