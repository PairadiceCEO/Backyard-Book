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
- [x] 1 `server/cashout.js`: pure `computeCashout(bet, legStates)`, `findKalshiMatch` (DraftKings line →
      Kalshi strike), `liveValueCents` (exact BigInt), `quoteCashout(bet, ctx)`, `createCashoutContext`
      (fresh=false: board game states + 15 s Kalshi cache; fresh=true: fresh ESPN + Kalshi), `quoteBets`,
      `cashOutBet` (pre-checks → fresh quote → CASHOUT_CHANGED → transaction with getAll(bet,user,ledger))
- [x] 2 `api/bets.js` routes `action` (`place` default, `cashoutQuote`, `cashout`); `server/settlement.js`
      guard comment (already skipped non-open); `server/admin/bets.js` `refuseCashedOut` (409 CASHED_OUT in
      preview and confirm)
- [x] 3 `test/cashout/cashout.test.mjs` (21 tests, `npm run test:cashout`; `npm run test:all` runs all
      three suites). Mutation-checked: removing the tx status+version guards, the duplicate check, the
      CASHOUT_CHANGED check, freshness, the spread side rule, won=1, bid-vs-ask, or the settlement guard
      each fails a test. `test/casino/fakeFirestore.mjs` gained a non-transaction `db.getAll`.
- [x] 4 UI: `src/hooks/useCashoutQuotes.js` (estimates every 30 s while visible, restarts only when the
      open-bet id set changes), `src/components/CashoutConfirmModal.jsx` (value, CASHOUT_CHANGED "changed
      from $A to $B, confirm again", unavailable reason), `src/pages/MyBetsPage.jsx` (flow + success line +
      reportBalance), `src/components/BetCard.jsx` ("Cash out $X" / reason, "Cashed out $X" in Finished),
      `src/pages/admin/AdminBets.jsx` (status filter "Cashed out", no Set leg / Force buttons, note),
      CSS in `src/styles/index.css` (/* Cash out */). Harness: `tools/phone-check` fixtures (bet b7
      cashed out) + scenarios my-bets-cashout-{confirm,changed,unavailable,done}, admin-bets-cashed.
- [ ] 5 Full suite, build, phone check 320/375/414, merge wip → main, report with live test steps

## Next
Step 5: all suites pass (26 + 70 + 21 + scratchpad sportsbook suites), lint clean, cash-out screens pass
320/375/414. Remaining: full phone check of every screen + production build, then merge wip → main.

## Open questions
None yet.
