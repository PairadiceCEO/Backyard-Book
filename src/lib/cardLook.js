// How a card sits on the felt (0.26.0): each card is turned a little, from −4° to +5°, worked out from the card id so the same
// card always lies the same way on every phone (and a re-render never makes it twitch). The tilt goes in the CSS `rotate`
// property, which composes with the shoe slide's `transform` animation instead of fighting it.
export function cardTilt(card) {
  if (typeof card !== 'string' || !card) return 2;
  let n = 7;
  for (let i = 0; i < card.length; i += 1) n = (n * 31 + card.charCodeAt(i)) % 1009;
  return (n % 10) - 4; // −4 … +5
}

export function tiltStyle(card) {
  return { '--tilt': `${cardTilt(card)}deg` };
}
