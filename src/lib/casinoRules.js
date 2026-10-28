// What the Rules sheet shows for Blackjack and Baccarat (0.24.0), read from the shared paytables (never retyped), with the
// side bets' sources. Plain data for src/components/casino/RulesSheet.jsx.
import { BACCARAT_SIDE_PAYTABLES, TWENTY_ONE_3_PAYS } from '../../shared/casino/sideBets.js';
import { BET_HELP_TEXT } from '../../shared/casino/constants.js';

const NEEDS_MAIN = 'A side bet needs a main bet on the same seat. No maximum beyond the $1,000,000 per-bet ceiling.';

export function blackjackRuleSections() {
  return [
    {
      id: 'main',
      heading: 'The game',
      text: `6 decks. Blackjack pays 3:2; insurance up to half your bet pays 2:1. Dealer hits soft 17 and peeks with an Ace or 10. One split per hand (split Aces get one card), double on any first two cards, also after a split. 15 s per hand; time out = stand. ${BET_HELP_TEXT}`,
    },
    {
      id: 'side213',
      group: 'Side bets',
      side: true,
      heading: '21+3',
      text: 'Your first two cards and the dealer’s up card make a three-card poker hand. Settled as soon as those three cards are out, before insurance or play.',
      rows: [...TWENTY_ONE_3_PAYS.map((row) => [row.label, `${row.pays} to 1`]), ['Anything else', 'loses']],
      note: `A-2-3 and Q-K-A are straights; K-A-2 is not. House edge with 6 decks: 4.62%. ${NEEDS_MAIN}`,
    },
  ];
}

export function baccaratRuleSections() {
  const T = BACCARAT_SIDE_PAYTABLES;
  return [
    {
      id: 'main',
      heading: 'The game',
      text: 'Player pays 1:1, Banker 0.95:1 (5% commission), Tie 8:1; a Tie pushes Player and Banker bets. 8 decks, standard drawing rules, every card dealt on the server.',
    },
    {
      id: 'dragon',
      group: 'Side bets',
      side: true,
      heading: 'Dragon Bonus (Player or Banker)',
      text: 'Pick a side. A natural is an 8 or 9 on the first two cards.',
      rows: T.dragon,
      note: 'House edge, 8 decks: 2.65% on Player, 9.37% on Banker.',
    },
    { id: 'fortune7', side: true, heading: 'Fortune 7', rows: T.fortune7, note: 'Anything else loses. The Banker bet still pays 0.95:1. House edge 7.61%.' },
    { id: 'heavenly9', side: true, heading: 'Heavenly 9', rows: T.heavenly9, note: 'Win or lose, a hand that ends on three cards totalling 9 counts. Anything else loses. House edge 9.31%.' },
    { id: 'golden8', side: true, heading: 'Golden 8', rows: T.golden8, note: 'Anything else loses. House edge 10.19%.' },
    { id: 'blazing7', side: true, heading: 'Blazing 7s', rows: T.blazing7, note: 'A 7 on two cards against a 7 on three cards loses. Anything else loses. House edge 16.75%.' },
    {
      id: 'sources',
      side: true,
      heading: 'Where the paytables come from',
      text: `Heavenly 9, Golden 8, Blazing 7s and Fortune 7: Nevada Gaming Control Board, approved rules "Commission Free 5 Treasures Baccarat" (version 2), with its published house edges; New Jersey's N.J.A.C. 13:69F-3.3(m) has the same Fortune 7, Golden 8 and Heavenly 9 payouts. Dragon Bonus: the standard mini-baccarat table (Wizard of Odds' edges). ${NEEDS_MAIN}`,
    },
  ];
}
