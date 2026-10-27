// What a winning spin shows once the reels have stopped (0.20.0).
//   WinCount  the win counting up from $0 over about 1 s (reduced motion: the amount at once)
//   BigWin    a win of 10× the bet or more: a large banner and a short coin shower (CSS only), at most 2.5 s; a tap skips it.
//             Reduced motion: the banner and the amount, no coins.
import { useEffect, useState } from 'react';
import { formatMoney } from '../../lib/format.js';
import { prefersReducedMotion } from '../../lib/reducedMotion.js';

export const COUNT_MS = 1000;
export const BIG_WIN_MS = 2500;
export const BIG_WIN_TIMES = 10;
const COINS = 18;

export function WinCount({ cents }) {
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? cents : 0));
  useEffect(() => {
    if (prefersReducedMotion()) {
      setShown(cents);
      return undefined;
    }
    let raf = 0;
    const start = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - start) / COUNT_MS);
      const eased = 1 - (1 - k) ** 3;
      setShown(k >= 1 ? cents : Math.floor(cents * eased));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [cents]);
  return (
    <strong className="win-count" aria-hidden="true">
      {formatMoney(shown)}
    </strong>
  );
}

export function BigWin({ cents, onDone }) {
  useEffect(() => {
    const timer = setTimeout(onDone, BIG_WIN_MS);
    return () => clearTimeout(timer);
  }, [onDone]);
  return (
    <button type="button" className="big-win" onClick={onDone} aria-label={`Big win: ${formatMoney(cents)}. Tap to skip.`}>
      <span className="big-win-coins" aria-hidden="true">
        {Array.from({ length: COINS }, (_, i) => (
          <span key={i} className="coin" style={{ '--x': `${(i * 53) % 100}%`, '--d': `${(i % 6) * 0.16}s`, '--s': `${0.8 + (i % 4) * 0.12}`, '--r': `${(i % 2 ? 1 : -1) * (200 + i * 20)}deg` }} />
        ))}
      </span>
      <span className="big-win-banner">
        <span className="big-win-title">Big win!</span>
        <WinCount cents={cents} />
        <span className="big-win-skip">Tap to skip</span>
      </span>
    </button>
  );
}
