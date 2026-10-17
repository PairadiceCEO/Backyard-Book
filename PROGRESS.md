# PROGRESS

Read this first in every session: `git fetch`, check out `wip` if it is ahead of `main`, read this
file, continue from "Next". `main` = finished, tested phases only (Vercel deploys it). Work in
progress is pushed to `wip` after every commit. Casino history: `docs/CASINO_PROGRESS.md`.
Previous phase: Sportsbook CASH OUT — complete, merged 2026-10-17 (see git history / README "Cash out").

## Current phase: CARD DEALING SPEED (Blackjack + Baccarat), started 2026-10-17

Spec (Will, 2026-10-17):
- Blackjack: one card at a time, seat 1 → 5, dealer, then the second card in the same order; seats
  without a bet skipped (no delay). 1 s between opening cards; 1.5 s for every later card (hits,
  doubles, split cards, hole-card reveal, each dealer draw). Hole card face down until the dealer's turn.
- Baccarat: Player, Banker, Player, Banker 1 s apart; 1.5 s before each third card.
- Keep: server-timed reveals (same card same moment on every phone; late joiners see cards dealt);
  insurance/turn/betting clocks start after the cards finish → server deadlines updated.
- All timing values in one constants file.

### Decisions
- The order, seat skipping, server-timed reveal and "clocks start after the cards" already existed
  (casino batch 5). This phase changes the numbers and moves every timing value into
  `shared/casino/timing.js` (card gaps, settle pause, turn/results seconds, tick jitter, dice animation).
  `constants.js`, `blackjack.js` and `baccarat.js` re-export them so existing imports keep working.
- The first card of a write still turns over at t = 0 (e.g. the card from a Hit shows right away; the
  1.5 s gap is between cards of the same step, e.g. split cards, hole card → dealer draws). A hit keeps
  the hand's existing 15 s clock (unchanged rule: 15 s per hand).

### Plan / checklist
- [x] 1 `shared/casino/timing.js` (1000 / 1500 / 700 ms blackjack; 1000 / 1500 / 700 ms baccarat)
- [x] 2 Tests: casino2 coup timing + full round deadline; casino3 3-seat deal timing and a new five-seat
      test (seat with no bet skipped, insurance deadline, double, split 1.5 s, hole → draw 1.5 s, results)
- [x] 3 Browser check `tools/phone-check/dealcheck.mjs` (real page, sampled between card times): BJ 10
      opening cards 1 s apart, seat totals 1 → 2 → 3 → 5 with no-bet seat 4 skipped, hole card face down,
      "Dealing…" + no clock until the cards are down, mid-deal joiner; Baccarat P, B, P, B 1 s apart and
      third cards at +1.5 s. All pass.
- [x] 3b Fix found by that check: `src/hooks/useCasinoTable.js` useTimedReveal clamped elapsed at 0, so a
      phone whose clock read before the deal time started the whole sequence early. Now counts from the
      deal time (early wait capped at 2 s).
- [ ] 4 Full suite, lint, build, interact.mjs, phone check 320/375/414, merge wip → main, report

## Next
Step 4.

## Open questions
None.
