// Playing cards shared by the server (shoes, dealing) and the phone (drawing a card face).
//
// A card is a 3-character id: rank + suit + deck number, e.g. "TH5" = ten of hearts from deck 5.
// The deck digit makes every card in a multi-deck shoe unique, so tests can prove that no card still
// in the shoe ever shows up in the public table doc. Phones ignore the digit when drawing the card.

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
export const SUITS = ['S', 'H', 'D', 'C'];

const SUIT_SYMBOLS = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANK_LABELS = { T: '10' };
const RANK_NAMES = { A: 'Ace', T: '10', J: 'Jack', Q: 'Queen', K: 'King' };
const SUIT_NAMES = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };

const CARD_PATTERN = /^[A2-9TJQK][SHDC][0-9]$/;

export function isCard(card) {
  return typeof card === 'string' && CARD_PATTERN.test(card);
}

// Every card of `decks` decks (up to 10), in a fixed order. Draws pick a random position from this.
export function buildShoe(decks) {
  if (!Number.isInteger(decks) || decks < 1 || decks > 10) throw new Error(`buildShoe needs 1–10 decks, got ${decks}`);
  const cards = [];
  for (let d = 0; d < decks; d += 1) {
    for (const suit of SUITS) {
      for (const rank of RANKS) cards.push(`${rank}${suit}${d}`);
    }
  }
  return cards;
}

export function cardRank(card) {
  return card[0];
}

export function cardSuit(card) {
  return card[1];
}

export function isRedCard(card) {
  const suit = cardSuit(card);
  return suit === 'H' || suit === 'D';
}

// What the phone prints in the corner: "10", "♥".
export function cardFace(card) {
  const rank = cardRank(card);
  return { rank: RANK_LABELS[rank] ?? rank, suit: SUIT_SYMBOLS[cardSuit(card)] ?? '?' };
}

// For screen readers: "10 of hearts".
export function cardName(card) {
  const rank = cardRank(card);
  return `${RANK_NAMES[rank] ?? rank} of ${SUIT_NAMES[cardSuit(card)] ?? 'unknown'}`;
}
