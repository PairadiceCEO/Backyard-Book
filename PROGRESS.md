# PROGRESS

Read this first in every session: `git fetch`, check out `wip` if it is ahead of `main`, read this
file, continue from "Next". `main` = finished, tested phases only (Vercel deploys it). Work in
progress is pushed to `wip` after every commit. Casino history: `docs/CASINO_PROGRESS.md`.
Earlier phases (all merged): cash out (0.7.0), card dealing speed (0.7.1).

## Batch (Will, 2026-10-17): casino seats + craps, Battles, Challenges
Spec file: Will's attachment of 2026-10-17 14:17 ("Backyard Book — Next batch"). Three phases, each
merged to main on its own: **A** casino changes (build now) · **B** Battles · **C** Challenges.
B/C plan was sent to Will 2026-10-17 for approval — **do not code B before he approves it** (copy of the
plan below under "B/C plan (sent)").

## Phase A — casino seats, leaving, craps — COMPLETE (2026-10-17), merged to main, ready for Will to test

Spec summary:
1. Blackjack + Baccarat: a player may sit in any number of open seats (up to 5). Each seat plays exactly
   like a separate player (own bet $1–$10 / own baccarat spots, own hands, insurance, double, split,
   15 s turn, normal seat order). Show which seats are mine (name + seat number). Deal order unchanged.
   One heartbeat covers all my seats. Craps/Crapless: one seat per player; refuse a second clearly.
2. "Leave seat" per seat (keep the rest, or leave all and watch). Leaving the table page (lobby, another
   tab, another game) leaves ALL my seats. Existing leaving rules for bets in play. 60 s heartbeat rule stays.
3. Craps/Crapless: limits (Pass/Don't Pass/each Come $1–$20; Odds ≤ 2× its line bet, not capped by $30;
   every other spot $1–$30; total on felt incl. Odds ≤ $60; refuse with which limit; picker shows total and
   room left). Hard ways 4/6/8/10 (4/10 6:1, 6/8 8:1 as written; off on come-out; win hard, lose easy or 7;
   winner stays up; place/take down any time before a roll). Come bets (open only with a point; craps:
   7/11 win, 2/3/12 lose, else move; crapless: 7 wins, else move; on its number: win 1:1 before a 7; Come
   Odds ≤ 2×, true odds, off on come-out (come-out 7 loses the flat, returns Odds); several numbers; one per
   number, landing adds within $20; flat can't come down once moved; Odds can; seven-out loses them all).
   Don't Pass Odds (inverse payouts) — doing it (small change).
4. Tests for all of it, incl. the Phase 4 "other player's bet never blocks the shooter's roll".

### Decisions
- Actions name the seat: `seat` (0–4) on bet/bets/confirm/insurance/hit/stand/double/split/removeBet/
  leave. Omitted + exactly one seat → that seat (old phones keep working). Moves with no seat use the
  seat whose turn it is if it's mine. `leave` with no seat = leave all.
- Ledger ids that were per player per round now include the seat (`_s{i}`), so two seats never collide.
- Page-leave: the table page sends leave-all when it unmounts (delayed 400 ms and cancelled if the same
  table remounts, so React dev double-mounts and quick re-renders don't drop seats). Not on refresh/close
  (that stays the 60 s heartbeat rule).
- Come bet "landing on a number that already has a Come bet" can't actually happen: the roll that moves
  the new Come to n is the roll that makes the older Come n win, so the older one is paid and the new one
  takes its place (standard "off and on"). The $20 cap on landing is still coded as a safety net. Tell Will.
- Hard ways pay what the spec says (6:1, 8:1), kept in diceVariants.js so it's one number to change.
  (Standard casino pays are 7:1 / 9:1 — mention to Will.)

### Plan / checklist
- [x] A1 Server multi-seat: tableRunner `mySeats` + `requireSeat(ctx, body)`; tables.js sit (multi for
      bj/baccarat, one for craps with message) / leave(seat | all) / heartbeat; blackjack + baccarat use
      the seat; ledger ids with seat
- [x] A2 Shared dice rules: limits, hard ways, Come, Come Odds, Don't Pass Odds; crapsTable uses them
- [x] A3 Tests: casino2/3/4 updated; new test/casino/casino5.test.mjs (16 tests; suite now 87). Mutation-
      checked (hard ways on come-out, Come Odds on come-out, DP Odds ratio, $60 total, easy way, seat in
      payout id, Odds capped by $30 → each fails a test)
- [x] A4 Phones: Blackjack/Baccarat seat panels (tabs per my seat, own chips, insurance, moves, leave),
      leave-all on page exit (useLeaveOnExit, survives the Craps↔Crapless page switch), Craps felt (Come,
      Come bets on numbers + Odds, Hard ways, DP Odds, $60 meter). Harness: two-seat + craps scenarios,
      interact.mjs "leaving the page sends one leave-all; opening it never does". dice.js "no numbers"
      test fixed (dollarsText moved to constants.js).
- [x] A5 Full suite (26 + 87 + 21 + scratchpad sportsbook suites), lint, build, interact.mjs (incl. leave-all),
      dealcheck.mjs, phone check 66 screens × 320/375/414 clean; merged wip → main (0.8.0)

## Next
Phase B (Battles) — BLOCKED until Will approves the B/C plan below (sent 2026-10-17). When he does: start
from a fresh `wip` off main, follow the plan, then Phase C (Challenges + section 6 admin odds edits).

## Open questions
- Waiting for Will to approve the B/C plan.

## B/C plan (sent 2026-10-17)
Battles doc `battles/{id}` (title, description, creator, format ffa|teams, teams, stakeCents, payout bps by
place, participants [{uid,name,team,status}], participantUids, status pending→live→settled|cancelled|void,
expiresAt 48 h, result, paid-so-far per player, disputes, edit log, version). Challenges `challenges/{id}`
(poster, title, description, 2–6 outcomes {id,label,american}, closeTime, status pending→open→settled|
rejected|void, winner, reject note, edit log). customGames get an edit log. Rules: battles readable by
participants + admin; challenges by everyone signed in; no client writes. New `/api/battles` (create,
accept, decline, withdraw, cancel, setResult, dispute, postChallenge) → 7 functions. Admin actions:
battleSetResult/SetPayout/Void, challengeApprove/Reject/Edit/Settle/Void, customGameEditOdds (preview +
confirm). Challenge bets via /api/bets: gameId `challenge:{id}`, marketType `challenge`, selection =
outcome id; priced fresh; close time server clock; poster can't bet; one leg per challenge; graded from
admin's pick; count toward win rate; cash out stake×0.9 before close. Screens: Custom tab (custom games,
Challenges, Battles), badge on Sportsbook tab, Battle detail, My Bets shows Battles, admin Battles +
Challenges tabs, edit logs. Money: battle_stake (create/accept), battle_refund (decline/cancel/withdraw/
48 h expiry swept when settlement runs), battle_payout (ties split covered places; team shares even;
floor to cent; leftover to highest-placed winner), admin fixes move only differences (admin_regrade, wallet
may go negative). Defaults: anyone can be invited; in-app notices only; accept refused without funds;
only admin edits challenge odds.
