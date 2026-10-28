// Max bet (0.23.0, Blackjack and Baccarat): what the Max button would put on one spot. Pure, shared by the page
// (src/components/casino/MaxBet.jsx) and the tests. Amounts in cents.
//   currentCents    what the spot holds now on the screen (confirmed + not yet confirmed)
//   availableCents  the wallet left for that seat (the balance minus every chip not confirmed yet, on any seat)
// Returns { addCents, totalCents, capped } (addCents whole dollars, at least $1), or { refuse: 'ceiling' | 'wallet' }.
// One bet never passes the casino's $1,000,000 ceiling: past it the total stops at $1,000,000 (capped: true).

import { BET_CEILING_CENTS } from './constants.js';

export function maxBetPlan(currentCents, availableCents) {
  const current = Math.max(0, Math.floor(Number(currentCents) || 0));
  const wallet = Math.floor(Math.max(0, Number(availableCents) || 0) / 100) * 100; // whole dollars
  const wanted = current + wallet;
  const totalCents = Math.min(wanted, BET_CEILING_CENTS);
  const addCents = totalCents - current;
  if (addCents < 100) return { refuse: current >= BET_CEILING_CENTS ? 'ceiling' : 'wallet' };
  return { addCents, totalCents, capped: wanted > BET_CEILING_CENTS };
}
