# PROGRESS

Read this first in every session: `git fetch`, check out `wip` if it is ahead of `main`, read this
file, continue from "Next". `main` = finished, tested phases only (Vercel deploys it). Work in
progress is pushed to `wip` after every commit. Casino history: `docs/CASINO_PROGRESS.md`.

## Current phase: Sportsbook CASH OUT (started 2026-10-17)

Spec: Will's message of 2026-10-17 (cash out for sportsbook bets). Summary of the rules:
- Pre-game (no leg's game started, singles and parlays): cashout = floor(stake × 0.90).
- Live (any leg's game started): cashout = floor(potential payout × P × 0.90). Potential payout =
  stake × product of decimals of legs not pushed/voided (= `potentialPayoutCents` when none dropped).
  P = product of the Kalshi BID (yes_bid_dollars / no_bid_dollars) of every undecided leg; won legs = 1.
- Kalshi leg: its stored `sourceRef.ticker` + `side`. DraftKings (ESPN) leg: the Kalshi market at the
  same line via the board's `kalshi` mapping (spread −N = YES "team wins by over N"; +N = NO on the
  opponent's "wins by over N"; total = strike N, over YES / under NO; moneyline = team's winner market
  YES, else the opponent's NO). No exact match or no bid → unavailable.
- Unavailable: any leg lost; the bet would settle now (all legs final); a leg's game ended without a
  gradable score; no active Kalshi market / no bid; a custom-game leg whose game started (pre-game
  cashout works on custom games); bet not open.
- Safety: server computes the value; confirm re-prices with FRESH Kalshi + ESPN (no board cache) and
  returns CASHOUT_CHANGED with the new value if it differs from what was confirmed; one transaction
  (bet must still be open → status "cashed_out", cashoutCents, cashedOutAt, payoutCents = cashout,
  wallet credit, ledger `cashout_{betId}` type "cashout"); settlement skips cashed-out bets.
- Display: My Bets shows the estimate on open bets (refreshes every 30 s like the board), "Cash out $X"
  → confirm → server; finished list shows "Cashed out $X". Win rate: neither won nor lost. Admin Bets:
  status filter "Cashed out", no force-grade. Shop purchases: cashout entries never shown.

### Decisions (tell Will)
- "Any leg's game is final → unavailable" is read as: unavailable when every leg is decided (settlement
  will pay it) or a leg lost. A parlay with a final, WON leg and other legs still to play can cash out
  (won leg counts as 1), which is what the spec's own test case ("one leg won, one live, one not
  started") needs. A final leg that pushed/voided drops out of the payout.
- Leg results for cash out are graded on the fly from ESPN/custom results (stored legs only get results
  when the whole bet settles).
- Estimates may reuse Kalshi/ESPN answers for up to 15 s per server instance; confirmation never does.
- A cashout value under 1 cent is "unavailable".

### Plan / checklist
- [ ] 1 `server/cashout.js`: pure `computeCashout(bet, legStates)` + `quoteCashout(bet, ctx)` (game
      states from ESPN/custom, Kalshi bids, DraftKings-line matching) + `cashOutBet(caller, body)` tx
- [ ] 2 `api/bets.js`: `action: 'cashoutQuote' { betIds }` and `action: 'cashout' { betId, expectedCents }`
      (no new Vercel function); settlement explicit skip; admin regrade refuses cashed-out bets
- [ ] 3 Tests `test/cashout.test.mjs` (server, in-memory Firestore + fake Kalshi/ESPN) — every case in
      the spec's list
- [ ] 4 Phones: My Bets estimate + Cash out button + confirm dialog (CASHOUT_CHANGED re-confirm);
      BetCard "Cashed out"; Admin Bets filter + no regrade buttons; Shop purchases unchanged
- [ ] 5 Full suite, build, phone check 320/375/414, merge wip → main, report with live test steps

## Next
Step 1.

## Open questions
None yet.
