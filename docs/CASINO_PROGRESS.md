# Casino build progress

Plan: "Backyard Book — Casino Plan" (Claude Docs). Work order: phase 1 slots → 2 tables + Baccarat →
roads → 3 Blackjack → 4 Craps + Crapless. Finished work goes to `main`; work in progress lives on
the `casino-phase4` branch until it's tested, then it's merged.

## Status

| Step | State | Commit |
|---|---|---|
| Phase 1: lobby, `/api/casino`, money helper, 7s slot | done, tested live | 6feac45 |
| Phase 2: shared tables (seats, presence, deadlines/tick, shoe) + Baccarat | done, tested live | 2daba6d |
| Baccarat scoreboard (Bead Plate, Big Road, derived roads) | done, tested live | 0d407aa |
| Phase 3: Blackjack | done, tested live | 7d20181 |
| Phase 4: Craps + Crapless | in progress (branch `casino-phase4`) | — |

### Phase 4 checklist

- [x] Branch, this file, casino server tests moved into `test/casino/` (`npm run test:casino`)
- [ ] `shared/casino/diceVariants.js` (the only place Craps and Crapless differ) + `shared/casino/dice.js` (pure roll/settle) + `test/dice.test.js`
- [ ] `server/casino/crapsTable.js` (one engine, two variants) wired in `server/casino/tables.js`; `test/casino/casino4.test.mjs`
- [ ] Phone UI `src/pages/casino/CrapsPage.jsx`, lobby labels, CSS; phone check at 320/375/414
- [ ] Full regression, README section, merge to `main`, push, report to Will

## Phase 4 rules being built (from the approved plan)

- Bets $1–$10, whole dollars; each spot holds at most $10 (Odds up to $10). Every bet carries a requestId.
- Pass / Don't Pass (Craps only): placed before a come-out; taken down only before the come-out (never once a Point is set).
- Odds (Pass only): after a Point is set; true odds 4/10 2:1, 5/9 3:2, 6/8 6:5; Crapless adds 2/12 5:1 (Will confirmed 5:1), 3/11 3:1.
- Place: point phase only; 4/10 9:5, 5/9 7:5, 6/8 7:6; Crapless adds 2/12 9:2, 3/11 11:4. A win pays and stays up; off on come-outs; loses on a seven-out.
- Field: any time, one roll: 3, 4, 9, 10, 11 pay 1:1; 2 and 12 pay 2:1; 5–8 lose.
- Craps: come-out 7/11 win, 2/3/12 lose; Don't Pass wins 2/3, pushes 12. Crapless: come-out 7 wins, every other number is a point.
- Roll: shooter only, needs a line bet, carries `rollSeq`; refused only if a roll already happened (another seat's bet in between never blocks it).
- Timers: come-out clock starts at the first bet after the last roll; point phase clock starts right after each roll; 15 s; at zero the server rolls for the shooter (or, on a come-out with no line bet, passes the dice; after a full lap with no line bet the table waits with no timer).
- Seven-out: dice to the next occupied seat clockwise.
- Leaving / gone 60 s: Pass, Don't Pass, Odds keep working until resolved; Place and Field are refunded (casino_refund) when the seat frees. Presence is checked after every roll.
- Ledger: bet `cbet_{uid}_{requestId}`, one payout per player per roll `cpay_{game}_{epoch}-{roll}_{uid}`, refunds `cref_{game}_{epoch}_{uid}_{n}`.

## How to check everything

- `npm test` — pure rules (slot RTP, Baccarat tableau + exact odds, roads vs Wizard of Odds, Blackjack, dice).
- `npm run test:casino` — server engines against an in-memory Firestore (transactions retry on conflict like the real one).
- Phone layout check (Playwright at 320/375/414 px with mocked Firebase) lived in the session scratchpad; rebuild it from `src/` if needed.
