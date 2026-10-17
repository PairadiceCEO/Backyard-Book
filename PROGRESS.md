# PROGRESS

Read CLAUDE.md first (standing rules), then this file. `git fetch`; check out `wip` if it is ahead of
`main`; continue from "Next". Casino history: `docs/CASINO_PROGRESS.md`.
Earlier phases (all merged): cash out (0.7.0), card dealing speed (0.7.1), casino batch A (0.8.0).

## Batch (Will, 2026-10-17): casino seats + craps, Battles, Challenges
Spec: Will's attachment "Backyard Book — Next batch". **A** casino (done, merged) · **B** Battles (now) ·
**C** Challenges + section 6 admin odds edits. B/C plan APPROVED 2026-10-17 18:54 with changes (below).

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

## Current phase: B — Battles (started 2026-10-17 18:55)

### Approved plan (B/C), with Will's changes
Battles `battles/{id}`: title, description, creatorUid/Name, format 'ffa' | 'teams', teams [{id, name}],
stakeCents, payoutBps [per place, sum 10000], participants [{uid, name, team, status: invited | accepted |
declined, stakeSeq, notice}], **participantUids** (array; client query `array-contains` my uid is what the
rules allow — Will's change 2), potCents, status pending → live → settled | cancelled | void, createdAt,
expiresAt (+48 h), liveAt, result {places, enteredBy, enteredAt}, paid {uid: cents credited by payouts},
disputes [{uid, name, note, at}], disputed, edits [{by, byName, at, what}], version.
Challenges (Phase C) `challenges/{id}`: poster, title, description, 2–6 outcomes {id, label, american},
closeTime, status pending → open → settled | rejected | void, winner, rejectNote, edits. **Posters CAN bet**
(Will's change 1): same limits/pricing/close time, only after approval; the server sets `posterBet: true`
on the bet when bet.uid === challenge.poster; "Poster's bet" tag in My Bets, Challenge detail, admin
Challenges and Bets tabs; no automatic blocking; test: poster bets on own approved Challenge → accepted,
posterBet true, graded normally.
Rules: battles readable by isAdmin() or `request.auth.uid in resource.data.participantUids`; challenges by
signed-in; no client writes. (Will must publish the new firestore.rules in the Firebase console.)
API: new `/api/battles` (create, accept, decline, withdraw, keep, cancel, setResult, dispute; Phase C adds
postChallenge) → 7 functions. Admin (`/api/admin`, preview + confirm with expectedVersion):
battleSetResult, battleSetPayout, battleVoid; Phase C: challengeApprove/Reject/Edit/Settle/Void,
customGameEditOdds. Challenge bets via /api/bets (gameId `challenge:{id}`, marketType `challenge`).
Money: battle_stake (create/accept), battle_refund (decline → everyone, cancel, withdraw, 48 h expiry
swept by settlement runs and lazily on any Battle action), battle_payout (ties split the places they cover;
team share split evenly; floor to the cent; leftover cents to the highest-placed winner); admin fixes move
only differences (admin_regrade; wallet may go negative, shown red). Battles never touch win rate / Shop.
Screens: Sportsbook "Custom" sub-tab (custom games moved there from league tabs; Battles; Phase C
Challenges), badge on the Sportsbook tab (invites + payout-change notices), New Battle, Battle detail,
Battles in My Bets, admin Battles tab (disputed first) with edit log.

### Decisions (Phase B)
- Ledger ids: `bstake_{id}_{uid}_{seq}`, `brefund_{id}_{uid}_{seq}` (seq = that player's stake number, so
  withdraw → re-accept works), `bpay_{id}_{uid}`, `regrade_battle_{id}_v{version}_{uid}`.
- Withdraw (only offered after a payout change before live) refunds and puts the player back to "invited";
  they may accept again under the new payout or decline (which cancels the Battle, refunding everyone).
- Places: the creator gives each player (or team) a place number; equal numbers tie. Sorted, a tied group
  covers the next k positions (so 1,1,2 and 1,1,3 both mean "two tied for 1st, then 3rd").
- Payout places: free-for-all 1 … players − 1; teams 1 … teams − 1. Percent with up to 2 decimals (bps).
- Stake: whole dollars $1–$10,000 (sanity cap). Accept refused if the wallet can't cover it.
- Disputes: any participant, within 48 h of the result, with a note (1–300 chars), once each.

### Checklist
- [ ] B1 shared/battles.js (validation, places → payouts, ties, leftover) 
- [ ] B2 server/battles.js + api/battles.js + admin actions + expiry sweep in settlement + firestore.rules
- [ ] B3 Custom board: custom games off league boards → `/api/board?league=custom`; game links/detail
- [ ] B4 Tests test/battles/*.test.mjs (+ move the sportsbook server suites into test/sportsbook)
- [ ] B5 Phones: Custom tab, New Battle, Battle detail, badge, My Bets, admin Battles tab
- [ ] B6 Full suite, build, lint, phone check, merge, live test steps (incl. console rules step)

## Next
B1.

## Open questions
None.
