// A playing card drawn with CSS. `card` is a server card id like "TH5" (the deck digit is ignored).
// Cards that arrive in one write are revealed one by one by the parent; `fresh` plays the short fade-in.
//
// 0.19.0: `dealAt` (server ms: when this card is due to turn face up) makes the card slide out of the shoe
// ([data-shoe] on the page) into its place, about 250 ms, when it mounts at that moment. A card that mounts later (a
// phone opening mid-hand, a tab coming back) just appears. prefers-reduced-motion: no slide, it just appears. Only the
// arrival is animated; when a card shows is still the server's reveal time (useTimedReveal).

import { useLayoutEffect, useRef } from 'react';
import { cardFace, cardName, isRedCard } from '../../../shared/casino/cards.js';
import { serverNow } from '../../lib/casino.js';
import { prefersReducedMotion } from '../../lib/reducedMotion.js';

export const SLIDE_MS = 250;
const SLIDE_WINDOW_MS = 700; // the card slides only if it mounts within this of its reveal time

export function slideFromShoe(el) {
  if (!el || typeof el.animate !== 'function' || prefersReducedMotion()) return false;
  const shoe = document.querySelector('[data-shoe]');
  if (!shoe) return false;
  const a = shoe.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  if (!a.width || !b.width) return false;
  const dx = a.left + a.width / 2 - (b.left + b.width / 2);
  const dy = a.top + a.height / 2 - (b.top + b.height / 2);
  el.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scale(0.5) rotate(-10deg)`, opacity: 0.85 },
      { transform: 'none', opacity: 1 },
    ],
    { duration: SLIDE_MS, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' },
  );
  return true;
}

export default function PlayingCard({ card, fresh = false, small = false, dealAt = null }) {
  const ref = useRef(null);
  const slid = useRef(false);
  useLayoutEffect(() => {
    if (slid.current || !card || dealAt === null || dealAt === undefined) return;
    slid.current = true;
    if (Math.abs(serverNow() - dealAt) > SLIDE_WINDOW_MS) return;
    slideFromShoe(ref.current);
  }, [card, dealAt]);

  if (!card) {
    return <span className={small ? 'pcard back small' : 'pcard back'} aria-label="Face-down card" />;
  }
  const face = cardFace(card);
  const classes = ['pcard', isRedCard(card) ? 'red' : 'black', fresh ? 'fresh' : '', small ? 'small' : ''].filter(Boolean).join(' ');
  return (
    <span ref={ref} className={classes} role="img" aria-label={cardName(card)}>
      <span className="pcard-corner">
        {face.rank}
        <span className="pcard-corner-suit">{face.suit}</span>
      </span>
      <span className="pcard-pip" aria-hidden="true">
        {face.suit}
      </span>
    </span>
  );
}

// Baccarat's squeeze (0.19.0): the third card sits face down while its 1.5 s gap runs, lifts a corner, then turns, and
// finishes face up exactly when the server's reveal time arrives (the real card replaces it at that moment). `gapMs` is
// the gap (reveal time − the previous card's reveal time), `elapsedMs` how far into it we already are (a phone that opens
// mid-gap joins the animation where it is). Reduced motion: stays face down, the real card then flips at the reveal time.
export function PeelCard({ card, gapMs, elapsedMs = 0 }) {
  const face = cardFace(card);
  const red = isRedCard(card);
  const style = { '--peel-ms': `${gapMs}ms`, '--peel-delay': `${-Math.max(0, Math.min(elapsedMs, gapMs))}ms` };
  return (
    <span className="peel-card" style={style} data-peel="" aria-hidden="true">
      <span className="peel-inner">
        <span className={red ? 'peel-face red' : 'peel-face'}>
          <span className="pcard-corner">
            {face.rank}
            <span className="pcard-corner-suit">{face.suit}</span>
          </span>
          <span className="pcard-pip">{face.suit}</span>
        </span>
        <span className="peel-back" />
      </span>
    </span>
  );
}
