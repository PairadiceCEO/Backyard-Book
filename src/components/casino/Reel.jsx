// One reel: while spinning, a blurred column of symbols scrolls past (CSS animation only);
// when stopped, the three stops around `stop`, with the payline (middle) symbol highlighted. `glow` (0.20.0): this reel's
// payline symbol is part of the win.

import SlotSymbol from './SlotSymbol.jsx';
import { REELS, symbolAt } from '../../../shared/casino/slotMachine.js';

export default function Reel({ reel, stop, spinning, glow = false }) {
  if (spinning) {
    const strip = REELS[reel];
    return (
      <div className="reel spinning" aria-label={`Reel ${reel + 1} spinning`}>
        <div className={`reel-track reel-speed-${reel}`}>
          {[...strip.slice(0, 10), ...strip.slice(0, 10)].map((id, i) => (
            <div key={i} className="reel-cell">
              <SlotSymbol id={id} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const above = symbolAt(reel, stop - 1);
  const line = symbolAt(reel, stop);
  const below = symbolAt(reel, stop + 1);
  return (
    <div className="reel" aria-label={`Reel ${reel + 1}: ${line}`}>
      <div className="reel-cell dim">
        <SlotSymbol id={above} />
      </div>
      <div className={glow ? 'reel-cell payline glow' : 'reel-cell payline'}>
        <SlotSymbol id={line} />
      </div>
      <div className="reel-cell dim">
        <SlotSymbol id={below} />
      </div>
    </div>
  );
}
