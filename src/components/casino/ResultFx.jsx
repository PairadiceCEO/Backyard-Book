// Win / loss effects at results (Blackjack seats, Baccarat spots), 0.19.0: a "+$15" (green) or "−$10" (red) floats up for
// about 1.2 s, "Push" for an even result; on a win a chip slides from the dealer to this spot, on a loss from the spot to
// the dealer. prefers-reduced-motion: just the text (it fades in place). Plays once per round (`roundKey`), only while
// `show` is true (the cards that decide it are face up), and takes itself off the screen afterwards.
//
// Render it inside the spot (position: relative); `dealerSelector` finds the dealer's mark on the page.

import { useEffect, useRef, useState } from 'react';
import { formatMoney } from '../../lib/format.js';
import { prefersReducedMotion } from '../../lib/reducedMotion.js';
import { playSound } from '../../lib/casinoSound.js';
import { FeltChip } from './FeltChip.jsx';

export const FX_MS = 1200;
export const CHIP_SLIDE_MS = 600;

export function fxText(netCents) {
  if (netCents > 0) return `+${formatMoney(netCents)}`;
  if (netCents < 0) return `−${formatMoney(-netCents)}`;
  return 'Push';
}

// Which spots have already played their effect (module level, so a seat panel that mounts again, a tab switch, or React's
// development double-mount doesn't play it twice or strand it on screen).
const played = new Set();

export default function ResultFx({ show, netCents, stakeCents = 0, roundKey, dealerSelector = '[data-dealer-spot]' }) {
  const [, setTick] = useState(0);
  const chipRef = useRef(null);
  const hostRef = useRef(null);

  useEffect(() => {
    if (!show || played.has(roundKey)) return undefined;
    const timer = setTimeout(() => {
      if (played.size > 300) played.clear();
      played.add(roundKey);
      setTick((n) => n + 1);
    }, FX_MS + 100);
    return () => clearTimeout(timer);
  }, [show, roundKey]);
  const active = show && !played.has(roundKey);

  // 0.20.0: a win chimes once as its effect starts (several winning spots at the same moment chime once).
  useEffect(() => {
    if (active && netCents > 0) playSound('win');
  }, [active, netCents]);

  // The chip: from the dealer to here (win) or from here to the dealer (loss).
  useEffect(() => {
    const chip = chipRef.current;
    const host = hostRef.current;
    if (!active || !chip || !host || typeof chip.animate !== 'function' || prefersReducedMotion() || netCents === 0) return;
    const dealer = document.querySelector(dealerSelector);
    if (!dealer) return;
    const a = dealer.getBoundingClientRect();
    const b = host.getBoundingClientRect();
    if (!a.width || !b.width) return;
    const dx = a.left + a.width / 2 - (b.left + b.width / 2);
    const dy = a.top + a.height / 2 - (b.top + b.height / 2);
    const to = `translate(${dx}px, ${dy}px)`;
    chip.animate(netCents > 0 ? [{ transform: to, opacity: 1 }, { transform: 'none', opacity: 1 }] : [{ transform: 'none', opacity: 1 }, { transform: to, opacity: 0.2 }], {
      duration: CHIP_SLIDE_MS,
      easing: 'ease-in-out',
      fill: 'both',
    });
  }, [active, netCents, dealerSelector]);

  if (!active) return null;
  const kind = netCents > 0 ? 'win' : netCents < 0 ? 'lose' : 'push';
  return (
    <span className="fx-host" ref={hostRef} aria-hidden="true">
      <span className={`fx-float ${kind}`}>{fxText(netCents)}</span>
      {netCents !== 0 ? (
        <span className="fx-chip" ref={chipRef}>
          <FeltChip cents={Math.max(100, netCents > 0 ? stakeCents || netCents : stakeCents || -netCents)} className="fx-chip-disc" />
        </span>
      ) : null}
    </span>
  );
}
