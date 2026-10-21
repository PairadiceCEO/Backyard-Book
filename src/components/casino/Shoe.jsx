// The dealing shoe drawn at the top right of a table (Blackjack, Baccarat). Cards slide out of it (PlayingCard's `dealAt`).
// Decorative: hidden from screen readers.
export default function Shoe({ className = '' }) {
  return (
    <span className={['shoe', className].filter(Boolean).join(' ')} data-shoe="" aria-hidden="true">
      <span className="shoe-body" />
      <span className="shoe-cards" />
    </span>
  );
}
