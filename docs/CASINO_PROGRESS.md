# Casino build progress

Plan: "Backyard Book — Casino Plan" (Claude Docs). Work order: phase 1 slots → 2 tables + Baccarat →
roads → 3 Blackjack → 4 Craps + Crapless. Finished work goes to `main`; work in progress lives on
a branch until it's tested, then it's squash-merged. All four casino phases are built; next steps
come from Will's live testing.

## Status

| Step | State | Commit |
|---|---|---|
| Phase 1: lobby, `/api/casino`, money helper, 7s slot | done, tested live | 6feac45 |
| Phase 2: shared tables (seats, presence, deadlines/tick, shoe) + Baccarat | done, tested live | 2daba6d |
| Baccarat scoreboard (Bead Plate, Big Road, derived roads) | done, tested live | 0d407aa |
| Phase 3: Blackjack | done, tested live | 7d20181 |
| Phase 4: Craps + Crapless | done, on main — waiting for Will's live test | (see git log) |

### Phase 4 checklist

- [x] Branch, this file, casino server tests moved into `test/casino/` (`npm run test:casino`)
- [x] `shared/casino/diceVariants.js` (the only place Craps and Crapless differ) + `shared/casino/dice.js` (pure roll/settle) + `test/dice.test.js`
- [x] `server/casino/crapsTable.js` (one engine, two variants) wired in `server/casino/tables.js`; `test/casino/casino4.test.mjs`
- [x] Phone UI `src/pages/casino/CrapsPage.jsx`, lobby labels, CSS; phone check at 320/375/414
- [x] Full regression, README section, merge to `main`, push, report to Will

## Phase 4 rules being built (from the approved plan)

- Bets $1–$10, whole dollars; each spot holds at most $10 (Odds up to $10). Every bet carries a requestId.
- Pass / Don't Pass (Craps only): placed before a come-out; taken down only before the come-out (never once a Point is set).
- Odds (Pass only): after a Point is set; true odds 4/10 2:1, 5/9 3:2, 6/8 6:5; Crapless adds 2/12 5:1 (Will confirmed 5:1), 3/11 3:1.
- Place: point phase only; 4/10 9:5, 5/9 7:5, 6/8 7:6; Crapless adds 2/12 9:2, 3/11 11:4. A win pays and stays up; off on come-outs; loses on a seven-out.
- Field: any time, one roll: 3, 4, 9, 10, 11 pay 1:1; 2 and 12 pay 2:1; 5–8 lose.
- Craps: come-out 7/11 win, 2/3/12 lose; Don't Pass wins 2/3, pushes 12. Crapless: come-out 7 wins, every other number is a point.
- Roll: shooter only, needs a line bet, carries `rollSeq`; refused only if a roll already happened (another seat's bet in between never blocks it).
- Timers (0.11.0: none with 1 player at the table; 30 s with 2 or more): come-out clock starts at the first bet after the last roll; point phase clock starts right after each roll; at zero the server rolls for the shooter (or, on a come-out with no line bet, passes the dice; after a full lap with no line bet the table waits with no timer).
- Seven-out: dice to the next occupied seat clockwise.
- Leaving / gone 60 s: Pass, Don't Pass, Odds keep working until resolved; Place and Field are refunded (casino_refund) when the seat frees. Presence is checked after every roll.
- Ledger: bet `cbet_{uid}_{requestId}`, one payout per player per roll `cpay_{game}_{epoch}-{roll}_{uid}`, refunds `cref_{game}_{epoch}_{uid}_{n}`.

## How to check everything

- `npm test` — pure rules (slot RTP, Baccarat tableau + exact odds, roads vs Wizard of Odds, Blackjack, dice).
- `npm run test:casino` — server engines against an in-memory Firestore (transactions retry on conflict like the real one).
- Phone layout + behaviour check: `tools/phone-check/` (Playwright at 320/375/414 px with mocked Firebase).

## Batch 5: speed, chips, quick stop, deal timing, Odds 2× — done, merged to main

Will's request (2026-10-17), in order: 1 speed, 2 chips on every game, 3 slots quick stop, 4 Blackjack /
Baccarat deal timing, 5 Craps Odds up to 2× Pass. Merge to main when all tests + phone check pass.

- [x] 1a Timing: Server-Timing header + one log line per casino call (auth, each read, commit, total); benchmark before/after
- [x] 1b vercel.json `"regions": ["cle1"]` (Cleveland; Firestore nam5 = us-central1 Iowa + us-central2; Hobby = one region)
- [x] 1c Runner preloads table + caller's users doc + presence (+ shoe / ledger when the action needs them) with one tx.getAll
- [x] 1d Casino: verify token only, read users doc once inside the transaction, check disabled there
- [x] 1e Replies carry the public table (never the shoe/hole card) + caller balance; Roll reply has the dice (server side; client merge pending)
- [x] 1f Client: chips appear at once, taps within 300 ms sent together, refusals roll back with the reason, wallet shows pending
- [x] 2 Chip tokens: ($1/$2/$5/$10, colored) on Blackjack, Baccarat, Craps/Crapless, Slots; Undo + Clear; Blackjack stacks then confirms
- [x] 3 Slots: second tap stops the reels on the result (never a second spin)
- [x] 4 Deal timing: initial cards 0.5 s apart, later cards 1 s; server-timed; deadlines start after the animation
- [x] 5 Odds up to 2× the Pass bet (above the $10 spot limit), max shown on the spot
- [x] Tests, phone check, merge, report (with timing numbers)

Benchmark (test/casino/bench.mjs, in-memory Firestore with a modeled delay per round trip; round-trip
counts are exact, milliseconds are the model): before 4–9 round trips per call (heartbeat 4, bet 6,
dealer turn 5–8, craps roll 6–9); after 2 (one batched read + commit), 3 when a step pays other players.

## Card dealing speed (2026-10-17) — complete
- Blackjack: one card at a time, seat 1 → 5 (no-bet seats skipped), dealer, twice; opening cards 1 s apart,
  every later card 1.5 s (hits, doubles, split cards, hole-card reveal, dealer draws).
- Baccarat: Player, Banker, Player, Banker 1 s apart; 1.5 s before each third card.
- All timing values in `shared/casino/timing.js`; deadlines start after each step's cards finish.
- useTimedReveal now counts from the server deal time even when a phone's clock reads slightly early.
- On-screen check: `tools/phone-check/dealcheck.mjs`.

## 0.15.0 (2026-10-20): Craps / Crapless layout without scrolling
Compact top bar (puck, dice, total, countdown, Roll / Sit down / Table full), then the betting interface (chips + Take
down, meter + Undo/Clear, every spot in dense grids, two columns ≥ 720 px), then seats, last rolls, Leave seat, help and
rules. Short screens (max-height 620px) dock the chips, Take down and Roll above the bottom nav. No rule, limit, payout,
timer or turn-order change. Details in PROGRESS.md 0.15.0 item 3.

## 0.16.0 (2026-10-20): no maximum bets, $25 and $100 chips
No maximum on any casino bet, slot spin or Battle stake: minimum $1, whole dollars; the wallet balance is the only cap
(INSUFFICIENT_BALANCE inside the debit's transaction, as before), plus a $1,000,000 per-bet sanity ceiling ("That bet is
larger than the table allows."). Craps Odds stay at 2× the line bet. Chips $1, $2, $5, $10, $25, $100 on every game and
Slots. The old limits in the entries above ($1–$10 a bet, $10 a spot, craps $20 / $30 / $60) no longer apply. Details in
PROGRESS.md 0.16.0.

## 0.17.0 (2026-10-20): casino chat
One chat room per game (casinoChat/{game}/messages), written only by /api/casino action `chat`; a Chat button with an
unread badge on every game page (craps: in the top bar, which is two rows on phones) and a drawer over the page.
Craps no-scroll check now also requires the Chat button on screen. Details in PROGRESS.md 0.17.0 item 1.
