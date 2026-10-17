// A playing card drawn with CSS. `card` is a server card id like "TH5" (the deck digit is ignored).
// Cards that arrive in one write are revealed one by one by the parent; `fresh` plays the flip-in.

import { cardFace, cardName, isRedCard } from '../../../shared/casino/cards.js';

export default function PlayingCard({ card, fresh = false, small = false }) {
  if (!card) {
    return <span className={small ? 'pcard back small' : 'pcard back'} aria-label="Face-down card" />;
  }
  const face = cardFace(card);
  const classes = ['pcard', isRedCard(card) ? 'red' : 'black', fresh ? 'fresh' : '', small ? 'small' : ''].filter(Boolean).join(' ');
  return (
    <span className={classes} role="img" aria-label={cardName(card)}>
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
