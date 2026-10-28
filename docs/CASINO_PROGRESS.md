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
- Place: point phase only (0.23.0: any time, OFF on come-outs; 0.25.0: can be switched ON for the come-out — see below); 4/10 9:5, 5/9 7:5, 6/8 7:6; Crapless adds 2/12 9:2, 3/11 11:4. A win pays and stays up; off on come-outs; loses on a seven-out.
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

## 0.17.2 (2026-10-20): Blackjack/Baccarat fixes
- Chips: Clear / Undo / more chips while a batch is in flight used to send a stale or negative total (and in Baccarat a
  batch for another spot could wipe the first). Batches now build on the server's reply; a negative total is never sent.
- Results pause 2.5 s (RESULTS_MS in shared/casino/timing.js).
- Next hand: phones keep ticking until the table moves on (no 5-try limit), show the tick reply at once, and estimate
  the server clock from the midpoint of the server's work; table copies compare by version. tools/phone-check/tablesim.mjs
  runs the real engines end to end. Details in PROGRESS.md 0.17.2.

## 0.18.0 (2026-10-20): real casino-style craps felt (Craps and Crapless)
Look and layout only (src/components/casino/CrapsFelt.jsx + FeltChip.jsx, src/styles/craps.css, CrapsPage.jsx rewritten for
layout; server, shared/casino, useChipBetting and the bet actions untouched). One DOM, two layouts by CSS: upright
(`orientation: portrait`: stacked felt, docked chips / Undo / Clear / Take down / Roll) and sideways (`orientation: landscape`:
Pass and Don't Pass strips down the left edge, number boxes, Come, Field, Hardways column, rail on the right; computers
use it sized up). Seats, last rolls, Leave seat, help and rules: the Table sheet (chat drawer styles), or under the felt on
tall upright screens (one media-query listener decides). Replaces the 0.15.0 layout. The 0.15.0 "dock above the bottom
nav" no longer exists: the craps page covers the app's top bar and tabs. Hard-way payouts (6:1, 8:1) are deliberate. Details
and decisions in PROGRESS.md 0.18.0.

## 0.18.1 (2026-10-20): chat and tick fixes
Slots has no chat (one player; its old room is only pruned). A failed chat load tells the admin when the Firestore rules aren't
published, disables Send, and has Try again. The deadline tick backs off (2 s for 30 s, then 10 s; none while the page is
hidden): src/lib/deadlineTicker.js. Craps shows the offline banner inside its page. Details in PROGRESS.md 0.18.1.

## 0.19.0 (2026-10-21): Blackjack and Baccarat table look, Rebet, totals and win effects, Baccarat squeeze
Look and client only (server, shared/casino, useChipBetting and the bet actions untouched). One chip look: src/styles/chips.css
+ FeltChip.jsx (the 0.18.0 craps chip) used by ChipRack / ChipStack (Chips.jsx) in Blackjack, Baccarat and Slots; the old
.chip-token CSS is gone. Blackjack: BlackjackFelt.jsx (half-moon, SVG textPath arcs, five circles at fixed positions in a 300 × 310
drawing); Baccarat: BaccaratFelt.jsx (printed PLAYER / BANKER boxes; the focused seat's panel puts its three PrintedSpot buttons
into the felt through a portal, so the aria-labels still read "Seat N: Player, pays 1:1, your bet $X"); both in src/styles/tablefelt.css.
Cards slide out of Shoe.jsx ([data-shoe]) with a Web Animation in PlayingCard (`dealAt` = the server time the card turns face up;
only when it mounts within 0.7 s of that, so a late phone just sees the cards). ResultFx.jsx: the "+$" float and the chip slide, once
per round key (module-level set, so remounts and React's dev double-mount can't strand or replay it). Rebet: per seat, in memory
(`lastBet` / `lastBets`), through chips.place. Squeeze: PeelCard (a CSS animation as long as the 1.5 s gap, with a negative delay worked
out at mount, so it ends on coupRevealTimes' time on every phone). Details and decisions in PROGRESS.md 0.19.0.

## 0.20.0 (2026-10-27): Slots paytable, win line and big wins, autospin, casino sounds
Client only. SlotsPage.jsx: PaytableSheet.jsx (chat drawer sheet classes; rows from PAYTABLE), Reel `glow`, `.win-line`, WinCount /
BigWin (SlotWinFx.jsx; Big win = winCents >= 10 × betCents, 2.5 s, tap to skip), autospin as state + one effect: a run is
{ total, done, rule, bet }; land() decides whether it stops (autoStopReason: count, rule, outcome.balanceCents < bet); the effect
sends the next spin AUTO_GAP_MS after a landing (never while busy or during a Big win); a failed spin, Stop, unmount or
visibilitychange → hidden end it. src/styles/slots.css. Sounds: src/lib/casinoSound.js (Web Audio oscillators + filtered noise;
mute in localStorage 'backyardbook.casinoSound', useSyncExternalStore; AudioContext created on the first pointerdown/keydown,
suspended while hidden, closed when the last page using it unmounts; navigator.vibrate(30) on win / bigWin). SoundToggle.jsx in every
casino top bar and the lobby. Hooks: useChipBetting.place (chip), PlayingCard slide (card), ResultFx (win), CrapsPage (dice), Slots
(reels, win, big win). Details in PROGRESS.md 0.20.0.

## 0.25.0 (2026-10-28): come-out working switch (Craps, Crapless)
- shared/casino/dice.js: bets.working { place: {n: true}, hard: {n: true} } (cloneBets keeps a flag only while its bet is up,
  and leaves the key out when empty); isWorking / workingState / setWorking (WORKING_POINT_ON "Bets always work once a Point is
  set."). settleRoll: on a come-out, ON Place n pays and stays on n, loses on 7; ON Hard n pays on the hard n (stays), loses on the
  easy n and on 7; OFF bets untouched. Flags deleted on pointMade / sevenOut. Come Odds unchanged (returned on a come-out 7).
- server/casino/crapsTable.js: action `working` { seat, kind, number, on } | { seat, all: true, on }, requestId (seat.reqs dupes);
  refused with a point on (WORKING_NOT_ALLOWED); no ledger, no clock change. resetWorking when the dice go to a new shooter on a
  come-out (onDeadline pass, afterSeatsChanged). router.js lists `working`.
- shared/casino/constants.js winningsCents now rounds down (Math.floor), as CLAUDE.md says; only craps amounts change (7:6, the
  inverse Odds); two tests that asserted round-half-up updated.
- UI: CrapsFelt WorkPuck (black OFF / white ON) on my Place and Hard boxes during a come-out (the 0.23.0 OFF-on-every-box is
  gone); CrapsPage: all-bets button + Switch mode (like Take down). Placement by size: upright 360 px+ in the tools row (Take down
  on two lines, Roll 44 px+), upright < 360 a row of its own, wide sideways a row under the tools, 568 × 320 Switch in the rack's
  ninth cell and the all-bets button beside Roll.
- Tests: test/diceWorking.test.js, test/casino/casino10.test.mjs; interact.mjs come-out switch checks; shoot.mjs
  cr-comeout-working, cr-comeout-switch, cx-comeout-working.

## 0.24.0 (2026-10-28): side bets
- shared/casino/sideBets.js: 21+3 (twentyOne3Hand / ReturnCents), Baccarat baccaratSideOutcome / ReturnCents for dragonPlayer,
  dragonBanker, fortune7, heavenly9, golden8, blazing7; paytables + sources in the header comment; rules-sheet rows.
- Blackjack engine: `bet` takes `side` (dollars; left out = unchanged), charged with the main bet's diff (cbet_{uid}_{requestId});
  needs a main bet (SIDE_NEEDS_MAIN); settled in deal() after the hole card, before insurance: seat.side { cards, hand, stakeCents,
  returnCents }, paid cpay_blackjack_{round}_{uid}_s{n}_213. seat.sideCents counts toward stakeCents / the seat's result.
- Baccarat engine: the six side spots on seat.bets (stored only while > 0), same `bet` action, needs a main bet; settleBaccaratBets(bets,
  coup) adds `sides` { spot: { stakeCents, returnCents } } and pays them in the seat's one cpay_..._end entry.
- UI: BaccaratFelt SideSpot row (.bact-sides, 3 across on phones, 6 on wide screens) portalled by the seat panel; Blackjack 21+3 circle
  beside the bet spot + a look-only marker on every felt seat (sideFor); RulesSheet + src/lib/casinoRules.js. Max stays on the main spot.
- Tests: test/sideBets.test.js (+ test/sideBetMath.js: exact enumeration, seeded 1M-round sims), test/casino/casino9.test.mjs;
  interact.mjs side-bet + Rebet checks; shoot.mjs bj-sides, bj-side-result, bj-rules, bac-sides, bac-side-results, bac-rules.

## 0.21.0 (2026-10-27): no casino change
AI agent players are a sportsbook feature (see PROGRESS.md 0.21.0). The casino is unchanged; agents never play it.

## 0.23.0 (2026-10-28): Place before the point, every tap counts, $1,000 / $10,000 chips, Max, seat cards
- Craps/Crapless: placeBlocker allows Place on a come-out; settleRoll already left Place bets alone on every come-out roll (now
  tested for all 36 dice). CrapsFelt shows the black OFF puck on every Place box during a come-out.
- useChipBetting keeps taps still waiting in the 300 ms batch when the round key (craps rollSeq) changes (only an Undo / Clear
  still waiting is dropped); the craps felt takes chips while the dice tumble (no more pointer-events: none), and only between
  the shooter's Roll tap and the reply says "The dice are on their way…". Every control: touch-action: manipulation (index.css).
  tools/phone-check/tapcheck.mjs (real engines behind the real client) checks 10 quick taps on every game.
- CHIP_VALUES gains 1000 and 10000 (chipName for "$1,000"); .fc-1000 / .fc-10000 in chips.css; racks 4 × 2 on phones; craps rail
  182 px sideways (3 × 3 at 568 × 320, 236 px on computers).
- MaxBet.jsx + shared/casino/maxBet.js (Blackjack, Baccarat); through chips.place; capped at the $1,000,000 casino ceiling.
- BlackjackFelt handsFor → mini cards above every seat circle with total pills (split hands side by side).
- Tests: test/casino/casino8.test.mjs, test/chips.test.js; interact.mjs Max and seat-card checks; shoot.mjs bj-/bac-max-confirm.
