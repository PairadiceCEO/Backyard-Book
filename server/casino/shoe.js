// The secret shoe: casinoTables/{game}/private/shoe. Only /api/casino reads or writes it; the rules deny
// every client. The public table doc only ever shows how many cards are left.
//
// Doc shape: { cards: [card ids still in the shoe], dealt: cards dealt since the last shuffle, shuffles }.
// A draw takes the card at a crypto.randomInt position out of the remaining cards (splice), so the
// shoe never needs to be stored in a shuffled order.

import { buildShoe } from '../../shared/casino/cards.js';

export function freshShoe(decks, shuffles = 0) {
  return { cards: buildShoe(decks), dealt: 0, shuffles };
}

export function drawCard(shoe, randomInt) {
  if (!shoe.cards.length) throw new Error('the shoe is empty');
  const [card] = shoe.cards.splice(randomInt(shoe.cards.length), 1);
  shoe.dealt += 1;
  return card;
}

// Starts a new shoe (every card back in) when the cut card has been reached or too few cards remain.
// Returns true if it reshuffled.
export function reshuffleIfDue(shoe, { decks, reshuffleAt, minCards }) {
  if (shoe.dealt >= reshuffleAt || shoe.cards.length < minCards) {
    const next = freshShoe(decks, (shoe.shuffles ?? 0) + 1);
    shoe.cards = next.cards;
    shoe.dealt = 0;
    shoe.shuffles = next.shuffles;
    return true;
  }
  return false;
}
