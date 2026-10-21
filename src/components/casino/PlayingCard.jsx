// A playing card drawn with CSS. `card` is a server card id like "TH5" (the deck digit is ignored).
// Cards that arrive in one write are revealed one by one by the parent; `fresh` plays the short fade-in.
//
// 0.19.0: `dealAt` (server ms: when this card is due to turn face up) makes the card slide out of the shoe
// ([data-shoe] on the page) into its place, about 250 ms, when it mounts at that moment. A card that mounts later (a
// phone opening mid-hand, a tab coming back) just appears. prefers-reduced-motion: no slide, it just appears. Only the
// arrival is animated; when a card shows is still the server's reveal time (useTimedReveal).

import { useLayoutEffect, useRef, useState } from 'react';
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
// finishes face up exactly when the server's reveal time arrives (the real card replaces it at that moment). `startAt` is the
// server time the gap began (the previous card's reveal time), `gapMs` its length. The animation is a CSS animation with a
// negative delay worked out once at mount, so a phone that opens mid-gap joins it where it is, and every phone ends together.
// Reduced motion: it stays face down (CSS), and the real card then simply shows at the reveal time.
export function PeelCard({ card, startAt, gapMs }) {
  const [elapsed] = useState(() => Math.max(0, Math.min(serverNow() - startAt, gapMs)));
  const face = cardFace(card);
  const red = isRedCard(card);
  const style = { '--peel-ms': `${gapMs}ms`, '--peel-delay': `${-elapsed}ms` };
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
