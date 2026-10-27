// Performance totals on users/{uid}.stats (0.21.0), kept for every player (humans and agents) by the transactions that
// already write the user doc when a bet's money moves: settlement, cash out and admin regrades. No extra reads or writes.
//
//   stats.won, stats.lost            settled bets won / lost (win rate = won ÷ (won + lost); pushes, voids, cash outs don't count)
//   stats.stakedCents                stakes of settled bets
//   stats.returnedCents              what came back: the payout of a win, 0 for a loss, the stake for a push or void,
//                                    the cash-out amount for a cash out
//   stats.settledBets                settled bets of any kind
//   stats.byLeague.{league}          { staked, returned, won, lost } (cents and counts); a parlay across leagues is 'mixed'
//
// Battles are not bets (their own collection), so they never count. ROI = (returned − staked) ÷ staked.

export const SETTLED_STATUSES = ['won', 'lost', 'push', 'void', 'cashed_out'];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// The league key a bet counts under.
export function betLeague(bet) {
  const leagues = [...new Set((bet?.legs ?? []).map((l) => String(l.league ?? '').toLowerCase()).filter(Boolean))];
  if (leagues.length === 1) return leagues[0];
  return leagues.length > 1 ? 'mixed' : 'other';
}

// What one settled bet adds to the totals; null for a status that doesn't count (open).
export function betContribution(bet, status, payoutCents) {
  if (!SETTLED_STATUSES.includes(status)) return null;
  const staked = Math.max(0, Math.round(num(bet?.stakeCents)));
  let returned;
  if (status === 'lost') returned = 0;
  else if (status === 'push' || status === 'void') returned = staked;
  else returned = Math.max(0, Math.round(num(payoutCents))); // won, cashed_out
  return { league: betLeague(bet), staked, returned, won: status === 'won' ? 1 : 0, lost: status === 'lost' ? 1 : 0 };
}

// stats with a contribution added (sign +1) or taken back (sign −1). Missing fields count as 0; never below 0.
export function applyContribution(stats, contrib, sign = 1) {
  const out = {
    ...(stats && typeof stats === 'object' ? stats : {}),
    won: num(stats?.won),
    lost: num(stats?.lost),
    stakedCents: num(stats?.stakedCents),
    returnedCents: num(stats?.returnedCents),
    settledBets: num(stats?.settledBets),
    byLeague: { ...(stats?.byLeague && typeof stats.byLeague === 'object' ? stats.byLeague : {}) },
  };
  if (!contrib) return out;
  const clamp = (v) => Math.max(0, v);
  out.won = clamp(out.won + sign * contrib.won);
  out.lost = clamp(out.lost + sign * contrib.lost);
  out.stakedCents = clamp(out.stakedCents + sign * contrib.staked);
  out.returnedCents = clamp(out.returnedCents + sign * contrib.returned);
  out.settledBets = clamp(out.settledBets + sign);
  const prev = out.byLeague[contrib.league] ?? {};
  out.byLeague[contrib.league] = {
    staked: clamp(num(prev.staked) + sign * contrib.staked),
    returned: clamp(num(prev.returned) + sign * contrib.returned),
    won: clamp(num(prev.won) + sign * contrib.won),
    lost: clamp(num(prev.lost) + sign * contrib.lost),
  };
  return out;
}

// The totals from scratch over a list of bets (rebuildStats; also how the tests check the running totals).
export function statsFromBets(bets) {
  let stats = applyContribution({}, null);
  for (const bet of bets) stats = applyContribution(stats, betContribution(bet, bet.status, bet.payoutCents), 1);
  return stats;
}

// ROI as a fraction ((returned − staked) ÷ staked), or null with nothing staked.
export function roi(stakedCents, returnedCents) {
  const s = num(stakedCents);
  return s > 0 ? (num(returnedCents) - s) / s : null;
}

export function winRate(won, lost) {
  const w = num(won);
  const l = num(lost);
  return w + l > 0 ? w / (w + l) : null;
}
