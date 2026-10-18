# PROGRESS

Read CLAUDE.md first (standing rules), then this file. `git fetch`; check out `wip` if it is ahead of
`main`; continue from "Next". Casino history: `docs/CASINO_PROGRESS.md`.
Earlier phases (all merged): cash out (0.7.0), card dealing speed (0.7.1), casino batch A (0.8.0),
Battles (0.9.0), Challenges (0.10.0).

## Batch (Will, 2026-10-18): Phase 1 fixes (0.11.0), then Phase 2 crypto markets (0.12.0)
Spec: Will's message of 2026-10-18 00:03 CT. Two phases, each merged to main on its own, in order.
Push `wip` after every commit. Phase 2 starts from a fresh `wip` off main after Phase 1 is merged.

## Phase 1 — fixes (0.11.0) — IN PROGRESS

### Checklist
- [x] 1 URGENT (own commit): live games priced from the wrong Kalshi game (ALCS G4 postponed → matched G5 events).
  - [x] a) series game number: `seriesGameNumber()` (server/sources/espn.js) reads competitions[0].notes[].headline
        ("ALCS - Game 5", "NLCS - Game 5 If Necessary") → `gameNumber` on the normalized ESPN game;
        `kalshiGameNumber()` reads the winner title "Game 5: …"; spread/total inherit it from the winner event with
        the same ticker suffix (`numbersBySuffix`). `matchTeamsToGame(…, eventNumber)` (server/teamMatch.js): a
        numbered game accepts only the same number, any ticker date in the fetched window; unnumbered unchanged.
        Verified on the real APIs 2026-10-18: ESPN notes `[{"type":"event","headline":"ALCS - Game 5"}]`; Kalshi
        KXMLBGAME-26OCT161800TBCLE title "Game 4: Tampa Bay vs Cleveland", …26OCT172000TBCLE "Game 5: …",
        KXMLBSPREAD-26OCT161800TBCLE "Tampa Bay vs Cleveland: Spread".
  - [x] b) stale-market guard: `freshForLive(market, liveSince)` / `liveSinceMs(game)` in kalshi.js;
        tradablePrice/quoteFromMarket/buildKalshiMarkets/buildLadders take the game's start when it is 'in'.
        compactEvent rows carry updatedMs (7th field; older 6-field rows are never used live); Kalshi quote refs carry
        `updatedAt` (board cache). priceLeg checks the freshly fetched market (kalshiTicker path and board-quote path;
        the fresh live lookup builds with the fresh ESPN state). Cash out: live legs carry `liveSince`; bids only from
        fresh markets. See Q1 below: updated_time doesn't move on trades.
  - [x] c) unsure → no price: `isAmbiguous()` — closest candidates in two different events/slots, or two events of
        one kind tied in the chosen slot → the game gets no Kalshi markets.
  - [x] Cash out also requires a stored ticker to belong to the event the board maps to that game now (bets placed
        on Game 5's market before the fix can't cash out from it).
  - [x] tests: test/sportsbook/phase11.test.mjs (11). Fixtures of live markets in phase5/6/6c and cashout tests got an
        `updated_time` after their game's start (they model live markets). Mutation-checked: guard a off (6 fail),
        guard b off (4), guard c off (1), spread number inheritance off (4), cash out mapping check off (1), pricing
        fresh check off (2), board-quote path off (1), cash out fresh check off (1), ladder guard off (1).
- [x] 2 Craps/Crapless shooter timer (server/casino/crapsTable.js, both variants): `clocksOn(state)` = 2+ players
      (seated, not leaving); `CRAPS_TURN_SECONDS = 30` in shared/casino/timing.js (TURN_SECONDS 15 stays for
      Blackjack/Baccarat). No deadline with 1 player (afterChipDown, doRoll, onDeadline re-check → no auto-roll, no
      pass); afterSeatsChanged: 2+→1 clears the deadline (and `waiting`), 1→2+ with a point on → now + 30 s
      (`state.clocksOn` remembers the last answer). Rules text on the Craps page updated. Decision: a shooter who
      left with bets in play keeps the auto-roll (nobody can tap Roll for them; without it the remaining player
      could never get the dice). Tests: test/casino/casino6.test.mjs (11); casino4 expectations 15 s → 30 s.
      Mutation-checked (always on, no 2→1 clear, no 1→2 start, no onDeadline re-check, 15 s, no leaving-shooter
      exception: each fails a test).
- [x] 3 Slots: the "Return to player 90.0%…" line removed from SlotsPage.jsx (math unchanged)
- [x] 4 Board: `isListedGame` / `listedGames` (server/board.js) drop ESPN games that are final, canceled or
      postponed and custom games that are final or canceled — applied to /api/board's reply only (the cache keeps
      every game for settlement, pricing and game pages from My Bets). Live tab: `LIVE_TAB` first in LeagueTabs
      (`BOARD_TABS`, saved tab accepts 'live'); /api/board?league=live → `getLiveBoard()` builds from the five
      league boards via getOrRefresh (no new function, no extra ESPN/Kalshi fetches); each game keeps its `league`;
      phone groups by league (`groupByLeague`, app order) sorted by start; empty "No games are live right now.";
      polls every 30 s through useBoard. Decision (Spark quota): for the Live tab a league whose cached board has
      nothing live or starting is reused up to 5 min (the 30-second rebuild only for leagues with a game in
      progress or starting), so an open Live tab doesn't rewrite five boards every 30 s.
- [x] 5 No cash out with a custom-game or Challenge leg (and crypto, Phase 2): `cashoutEligible()` /
      `NO_CASHOUT_PREFIXES` in shared/betRules.js. quoteCashout and cashOutBet refuse before fetching anything
      (cashOutBet reads only the bet). My Bets asks quotes only for eligible bets and shows no cash out row on the
      others. Existing tests that expected pre-game cash out on custom/Challenge bets now expect the refusal.
      Tests: test/sportsbook/phase11b.test.mjs (board filter, Custom filter, Live tab, quota, cash out refusals);
      mutation-checked (no list filter, canceled kept, live includes pre, always 30 s, no server check, Challenge
      prefix dropped: each fails a test).
- [ ] 6 package-lock.json committed; build passes
- [ ] 7 CLAUDE.md "Deliberate decisions": cash out line, craps clocks, Kalshi matching
- [ ] 8 Checks (test:all, build, lint, phone check 320/375/414) → merge wip → main as 0.11.0

## Phase 2 — crypto markets (0.12.0) — PLANNED (starts after Phase 1 is merged)

### Checklist
- [ ] P2-1 Discover Kalshi crypto series (category=Crypto): keep 15-min "Up or Down" (fifteen_min) and hourly
      above/below (hourly, greater / greater_or_equal, floor_strike only); drop ranges (cap_strike) and daily+.
      Verify each coin's Coinbase product "{SYMBOL}-USD" is online. Checked-in config `shared/crypto/coins.js`
      (series → coin, symbol, product, kind). Record included / left-out coins below.
- [ ] P2-2 Server data: `server/crypto.js` — soonest open 15-min event with a floor_strike that has opened; soonest
      open hourly event; Coinbase ticker + 1-min candles. In-memory only (10 s TTL), never the Firestore cache.
      Served by /api/board (league=crypto, league=crypto&game={coin}); no new function.
- [ ] P2-3 Betting: leg { league 'crypto', gameId 'crypto:{eventTicker}', marketType 'crypto', selection yes|no,
      kalshiTicker, line floor_strike }; fresh market at bet time (configured series, active, opened, > 60 s before
      close, MIN/MAX price + gap); price = ask; LINE_CHANGED on another strike; singles only; no cash out.
- [ ] P2-4 Settlement: Kalshi result yes/no grades; voided/cancelled → void; unsettled → pending; hooked into
      gameResults/grading so every settlement run settles crypto bets (same ledger ids).
- [ ] P2-5 Screens: Crypto tab (Live, leagues, Crypto, Custom), coin cards (price, 15-min target + countdown +
      Up/Down, hourly main strike + Above/Below + countdown, Closed / Next market opens soon); coin page
      /sportsbook/crypto/{coin} with hand-built SVG chart (1-min candles for the current hour, 10 s refresh, target and
      main-strike lines, close-time marks, big current price, "Chart unavailable" fallback), 15-min buttons and the
      full hourly ladder.
- [ ] P2-6 Tests (config, pricing refusals, parlay refused, grading, no cash out, mutation-check 60 s cutoff and
      series check) + phone check (Crypto tab, coin page)
- [ ] P2-7 Checks → merge as 0.12.0

## Batch (Will, 2026-10-17): casino seats + craps, Battles, Challenges
Spec: Will's attachment "Backyard Book — Next batch". **A** casino (done, merged) · **B** Battles (done, merged) ·
**C** Challenges + section 6 admin odds edits (done, merged). The batch is complete. B/C plan APPROVED 2026-10-17 18:54 with changes (below).

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

## Phase B — Battles — COMPLETE (2026-10-17), merged to main (0.9.0), ready for Will to test

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
- [x] B1 shared/battles.js (validation, places → payouts, ties, leftover)
- [x] B2 server/battles.js + api/battles.js (7th function) + admin battleSetResult/SetPayout/Void + expiry sweep
      at the end of settleOpenBets + firestore.rules battles block
- [x] B3 Custom board: buildCustomBoard / CUSTOM_BOARD_KEY in server/board.js; league boards ESPN only;
      /api/board?league=custom; gameDetail; GameCard gamePath → /sportsbook/custom/{id}; admin edits
      invalidate board_custom
- [x] B4 test/battles/battles.test.mjs (15 tests: payout math incl. ties/teams/rounding, validation, create/
      accept/decline/cancel/expiry/result/dispute, admin result/payout/void, races, API). Mutation-checked (10
      mutations, each caught). Sportsbook suites moved to test/sportsbook (84). fakeFirestore: where/get queries.
- [x] B5 Phones: BattlesContext (one listener), Custom tab (LeagueTabs + badge; CustomBoard), NewBattlePage,
      BattleDetailPage (accept/decline/keep/withdraw/cancel/result/dispute, logs), BattleCard in My Bets, admin
      Battles tab (filters, disputed first, result/payout/void previews via MoneyConfirmModal), nav badge.
      Harness: battle fixtures + 11 scenarios; firestore mock supports array-contains.
- [x] B6 Full suite (26 + 87 + 21 + 84 + 15), lint, build, interact.mjs, dealcheck.mjs, phone check 77 screens ×
      320/375/414 clean; merged wip → main. Will must publish firestore.rules (battles block).

## Phase C — Challenges + admin odds edits — COMPLETE (2026-10-17), merged to main (0.10.0), ready for Will to test

### Design
- `challenges/{id}` (id = `{posterUid}_{clientRequestId}`): posterUid/Name, title, description, outcomes
  [{id 'o1'…'o6', label, american}], closeTime, status pending | open | rejected | settled | void, winner,
  rejectNote, approvedAt/By, settledAt/By, betCount, posterBets [{betId, outcomeId, label, stakeCents,
  american, parlay, at}] (public: everyone sees the poster's bets on their own Challenge), edits [{by, byName,
  at, what}], version. Rules: readable by anyone signed in; no client writes.
- Posting: `/api/battles` action `postChallenge` (keeps 7 functions). 2–6 outcomes, American odds (±100+),
  close time in Central Time (same date/clock fields as custom games), at least 10 min ahead, ≤ 60 days.
- Admin (`/api/admin`): challengeApprove (optionally with edits), challengeReject {note}, challengeEdit
  (pending: anything; open: odds and close time only — wording is fixed once bets can exist), challengeSettle
  {winner} and challengeVoid (preview with every wallet change via settlement dryRun, then settle the
  Challenge's bets at once, like custom games' final score / cancel).
- Betting: legs `{ league: 'challenge', gameId: 'challenge:{id}', marketType: 'challenge', selection: 'oN' }`;
  priced fresh from the doc (must be open and before closeTime on the server clock); parlays allow one leg
  per Challenge (conflictKey). Poster may bet (Will's change 1): the server sets `posterBet: true` on the bet
  and appends to the Challenge's posterBets in the placement transaction. Graded from the admin's winner;
  count toward win rate like any bet. Cash out: stake × 0.9 before close; none after (no market price).
- Section 6: admin custom-game edits are logged on the doc (`edits`: who, what, when; odds diffs spelled out)
  and shown on the game's page and in Admin → Custom games; Challenge edits logged and shown; Battle payout
  edits already logged (Phase B). Placed bets keep their odds (they're stored on the leg).

### Checklist
- [x] C1 shared/challenges.js; betRules: 'challenge' market (selections o1–o6, no line)
- [x] C2 server/challenges.js + routing (postChallenge, admin actions) + firestore.rules
- [x] C3 betting: pricing, placeBet (posterBet, betCount, posterBets), gameResults, grading, cashout
- [x] C4 custom-game edit log (update / final / cancel) + normalizeCustomGame carries `edits`
- [x] C5 tests test/challenges/challenges.test.mjs, 11 tests incl. Will's poster-bet test (`npm run test:challenges`,
      in test:all); mutation-checked (poster flag, close checks in pricing and in the transaction, grading, approval)
- [x] C6 Phones: lib/challenges.js (live lists, slip pick), ChallengeCard (outcome buttons → slip), Custom tab
      Challenges section + "Post a Challenge", NewChallengePage, ChallengeDetailPage (outcomes, poster's bets,
      edit log), routes /sportsbook/challenges/new and /:challengeId, "Poster's bet" tag in BetCard and
      AdminBets, Admin → Challenges (Queue / Open / To settle / Finished / All; approve, edit + approve, reject
      with note, edit odds/close, settle/void previews via MoneyConfirmModal), shared EditLog (Battles,
      Challenges, custom games on GameDetailPage + AdminCustomGames). BetSlip staleCopy handles no-line legs.
      Harness: challenge fixtures + 16 scenarios.
- [x] C7 Full suite (26 + 87 + 21 + 84 + 15 + 11), lint, build, interact.mjs, dealcheck.mjs, phone check 93
      screens × 320/375/414 clean; merged wip → main as 0.10.0. Will must publish firestore.rules (challenges).

## Next
Phase 1 item 1 (Kalshi guards), then items 2–7, checks, merge 0.11.0; then Phase 2.

## Open questions
- Q1 (2026-10-18, Phase 1 item 1b): Kalshi's `updated_time` does NOT move when a market trades. Checked against the
  real API on 2026-10-18 ~05:10Z:
  - KXBTC15M-26OCT180115-15: ask moved 0.48 → 0.45 and ~500k contracts traded, `updated_time` stayed at
    05:00:00.596Z (the open time).
  - KXNCAAFGAME-26OCT17NEBORE-ORE (Nebraska at Oregon, in progress): trades at 05:11Z, price 0.47 → 0.70,
    `updated_time` 2026-10-11T19:06Z (when the market was created).
  - KXMLBSPREAD-26OCT161800TBCLE: `updated_time` jumped to 03:22Z only when the markets finalized.
  So `updated_time` changes on status/metadata changes (created, rescheduled, closed, settled), not on prices.
  Consequence of the guard as specified: almost every live game's market predates the first pitch / kickoff, so live
  Kalshi prices, live betting and live cash out become unavailable nearly everywhere.
  Safest option taken: implemented exactly as specified (a live game never uses a market whose updated_time is before
  the start). Guard (a) alone already fixes the ALCS exploit. Will to choose: keep it; or drop guard (b); or replace
  updated_time with "latest trade at or after the start" (Kalshi /markets/trades; one extra request per market,
  workable at bet time and cash out, too many requests for the board on a busy Saturday). The freshness test is one
  function, `freshForLive()` in server/sources/kalshi.js.
