// The furniture around a Blackjack or Baccarat felt (0.26.0), all look: the dealer's chip tray at the top centre (ten chip tubes),
// the discard holder at the top left, the shoe at the top right (Shoe.jsx; cards slide out of it) and the black rail with its
// dashed gold stitch along the players' (bottom) edge. The tray carries data-dealer-spot: winning chips slide from it and
// losing chips slide back to it (ResultFx).

import Shoe from './Shoe.jsx';

// white, white, red, red, green, green, black, black, orange, purple (the stripes are the chip colours)
const TUBES = ['#f4efe2', '#f4efe2', '#b3262f', '#b3262f', '#1b7a45', '#1b7a45', '#1a1a1d', '#1a1a1d', '#d9791c', '#6a35b8'];

export function DealerTray() {
  return (
    <div className="cf-tray" data-dealer-spot="" aria-hidden="true">
      {TUBES.map((color, i) => (
        <span key={i} className="cf-tube" style={{ '--tube': color }} />
      ))}
    </div>
  );
}

export function DiscardHolder() {
  return (
    <span className="cf-discard" aria-hidden="true">
      <span className="cf-discard-cards" />
    </span>
  );
}

export function FeltRail() {
  return <div className="cf-rail" aria-hidden="true" />;
}

// Everything the two felts share; the game draws its own layout on top.
export default function FeltDecor() {
  return (
    <>
      <DealerTray />
      <DiscardHolder />
      <Shoe className="cf-shoe" />
      <FeltRail />
    </>
  );
}
