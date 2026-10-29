// The dealing shoe drawn at the top right of a table (Blackjack, Baccarat), 0.26.0: a dark shoe (50 × 40) with a red card back
// peeking out. Cards slide out of it (PlayingCard's `dealAt`). Decorative: hidden from screen readers.
export default function Shoe({ className = '' }) {
  return (
    <span className={['shoe', className].filter(Boolean).join(' ')} data-shoe="" aria-hidden="true">
      <span className="shoe-cards" />
      <span className="shoe-body" />
    </span>
  );
}
