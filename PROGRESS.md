# PROGRESS

Read CLAUDE.md first (standing rules), then this file. `git fetch`; check out `wip` if it is ahead of
`main`; continue from "Next". Casino history: `docs/CASINO_PROGRESS.md`.
Earlier phases (all merged): cash out (0.7.0), card dealing speed (0.7.1), casino batch A (0.8.0),
Battles (0.9.0), Challenges (0.10.0).

## Phase 0.14.0 (Will, 2026-10-18 12:25 CT) — IN PROGRESS
Spec: Will's attachment of 2026-10-18 12:25. One phase on a fresh wip off main; merge after every CLAUDE.md check;
stop dev/harness servers at the end.

### Checklist
- [x] 1 Crypto cash out: `quoteCryptoCashout` in server/cashout.js (crypto bets take this path; singles only). Always
      "live" once the market has opened; value = `liveValueCents(potential, [bid])` (× 0.90, floored). The market
      is fetched fresh every time — estimates too (`ctx.freshKalshiMarket`, memoized only within one request), so a
      cached bid is never used. `cryptoCashoutProblem`: result set / settled → no; not active; not yet open; ≤ 60 s
      to close (same cutoff as betting); bid missing or 0; ask − bid > MAX_BID_ASK_GAP; ticker must be the leg's
      stored ticker, of the leg's event, of a configured series (and Kalshi's answer must be that ticker). Same
      cashOutBet transaction / `cashout_{betId}`. `NO_CASHOUT_PREFIXES` is now custom + Challenge only, so My Bets
      quotes crypto bets and shows the "Live cash out value" button. Tests (test/crypto): YES $20 × 0.62 × 0.9 =
      $11.16, NO $6.48, fresh bid each quote, double cash out pays once, CASHOUT_CHANGED; refusals (60/30/0 s, bid 0 /
      missing, wide gap, closed, settled, result set, leg graded, another event's ticker incl. Kalshi answer without
      event_ticker, unconfigured series, wrong ticker answered). Mutation-checked: 0.90 → 0.95, 0.90 dropped, 60 s
      cutoff, ticker check, gap check — each fails a test. CLAUDE.md + README cash out lines; phone fixture b9.
- [x] 2 Crypto chart, rolling: `fetchCoinbaseCandles(product)` asks Coinbase for exactly now − 60 min → now
      (granularity 60) and returns { from, to, points }; cached per product for 10 s (window taken at fetch time, so
      the rolling start never defeats the cache). getCryptoCoin returns that window. Coin page: close times as text
      above the chart, "15-min closes 12:38 PM (6:00)" / "Hourly closes 1:10 PM (37:48)", live countdowns; nothing
      drawn for them on the chart. Targets and scrubber unchanged; the held minute moves to the oldest point once it
      rolls off (nearest point). Tests: window, exact Coinbase request, 10 s memory, rolls after 3 min. interact.mjs
      scrubber check now also rolls the window 10 min and expects the oldest point. Fixtures use the rolling window.
- [ ] 3 Player props (Kalshi, pre-game only): series discovery (Sports list read to the end) → checked-in config
      (series → league, stat label), included/left-out list here; matching only by the mapped winner event's ticker
      suffix; pre-game rule ('pre' and server clock < startTime); pricing (configured series, mapped event, active,
      pre-game, price checks, ask); leg marketType 'prop'; labels; LINE_CHANGED / ODDS_CHANGED; parlays (no same-game
      with a prop); cash out (pre-game stake × 0.9, after start bid formula); settlement by Kalshi result (non-yes/no
      → void); /api/board &game=&props=1 with 30 s memory cache, no Firestore. Tests + mutation (pre-game cutoff,
      suffix check). CLAUDE.md props line.
- [ ] 4 LineWheel (src/components/LineWheel.jsx): scroll-snap chips, centered = selected, two bet buttons, starts on
      the main line, arrows + keys, aria labels, slip dot, keeps its line across refreshes, IntersectionObserver /
      debounced scroll end (no setState per frame), pan-x, ≥ 44 px chips. Used for alt spreads + totals and each
      props player row. Props page /sportsbook/{league}/{gameId}/props (stat tabs, player rows sorted by team then
      most-traded, search, single-threshold rows without a wheel); game page "Player props" button when pre-game with
      a tradable prop. Phone check: wheels (main, non-main, pick in slip), props page with and without props.
- [ ] 5 Checks (test:all, lint, build, interact.mjs, dealcheck.mjs, phone check) → merge as 0.14.0; stop servers.

## Phase 0.13.0 (Will, 2026-10-18 01:56 CT; re-sent 11:31) — COMPLETE (2026-10-18), merged to main, ready for Will to test
Spec: Will's attachment of 2026-10-18 01:56. One phase on a fresh wip off main; merge after every CLAUDE.md check.

### Checklist
- [x] 1 Stale-market guard (b) removed: `marketUpdatedMs`/`liveSinceMs`/`freshForLive` gone from kalshi.js;
      tradablePrice/quoteFromMarket/buildKalshiMarkets/buildLadders back to no live check; compactEvent rows back to 6
      fields (old 7-field cached rows still read); no `updatedAt` on quote refs; gameDetail, priceLeg
      (STALE_LIVE gone) and cash out bids (STALE_LIVE, liveSince gone) cleaned. Kept: game-number matching, `isAmbiguous`
      ("when unsure, no price"), cash out mapping check. Tests: phase11 stale tests replaced by "live game's mapped
      market is priced (board, ladder, bet time ±ticker, live cash out ±DK line)", "bet-time price is the fresh
      market", "old cached rows still build"; 0.11.0 fixture `updated_time` lines removed. Re-mutation-checked:
      cash out mapping (1 fail), game number (6), unsure (1). CLAUDE.md + README lines updated.
- [x] 2 ODDS_CHANGED: `ODDS_CONFIRM_POINTS = 50`, `oddsScale`, `oddsDistance`, `needsOddsConfirm` in
      shared/oddsMath.js. placeBets checks after MARKET_CLOSED and LINE_CHANGED: any leg ≥ 50 → 409 ODDS_CHANGED
      { oddsChanges: [{ legId, oldAmerican, newAmerican, quote }], lineChanges: [], closedLegs: [] }, nothing placed.
      Phone: OddsChangedModal ("Old +100 → New +155", Accept new odds / Remove pick(s)); reducer actions
      `acceptOdds` (new odds + decimal → payout recalculated) and `removeMany`. Admin test switch added: "submit with
      odds 60 points off" (next submit only) to trigger the popup on purpose. Crypto settlement test fixture now
      quotes what the board showed. Tests: test/sportsbook/phase13.test.mjs (5: the examples, 50 refused / 49
      accepted incl. a Challenge leg, parlay with one leg 60 off refused with no wallet/ledger/bet change then
      resubmitted, LINE_CHANGED/MARKET_CLOSED priority, slip actions). Mutation-checked: threshold 51, 49, strict >,
      no −100=+100 scale, server check off — each fails. Phone check screen: sportsbook-odds-changed. CLAUDE.md line.
- [x] 3 My Bets → Finished: src/lib/betFilters.js (pure: sorts, filters, `summarize`, `activeFilterCount`,
      `cleanView`/`readSavedView`/`saveView` in try/catch), src/components/FinishedBets.jsx (sort select, Filters
      panel with count badge + Clear all + Done, summary line with green/red net, list 50 at a time with "Show N
      more"), MyBetsPage merges history + listener. Profit = returned − stake (cash out value; push/void = stake back;
      loss −stake). Category: custom-game / Challenge / crypto legs count as those, not their league. Live = placedAt ≥
      a leg's startTime. Dates in Central Time (calendar arithmetic, DST-safe). Battles unchanged.
      Data decision (Spark reads): the live listener (newest 200, existing uid + placedAt index) stays. Only when it is
      full does `useBetHistory` (src/hooks/useBetHistory.js) load the older bets, startAfter the listener's oldest doc,
      100 per getDocs, all pages, once per browser session (kept in module memory, so reopening My Bets reads nothing).
      Under 200 bets: 0 extra reads; otherwise (N − 200) reads once per session. Filters/sort/summary are exact over
      every finished bet because everything is in memory. Rejected: paging 50 with Load more (filters/summary would
      only cover what was loaded, or every filter change would re-query); a status/settledAt query (needs a new
      composite index for no read savings, since the summary needs every finished bet anyway). NO new index, so no
      Firebase console step. Listener bets are remembered in the same cache so a bet sliding out of the 200 window
      never drops out of Finished.
      Tests: test/betFilters.test.js (5, in `npm test`): profit, sorts, every filter + combined, summary/win rate,
      remembered view. Mutation-checked (loss profit, parlay any→all, inclusive "to", win rate counting pushes).
      interact.mjs: 263-bet player sees all 260 finished after exactly one history query; Lost filter + stake sort,
      remembered across reload, Clear all; a <200-bet player makes no extra query. Phone screens: my-bets-filters,
      my-bets-filters-dates, my-bets-history. Mock Firestore gained startAfter and a getDocs counter.
- [x] 4 Crypto chart scrubber (src/components/crypto/CryptoChart.jsx, still hand-built SVG): React pointer handlers
      only (no document listeners/timers; removed with the element). Touch: pointerdown starts (pointer capture, in
      try/catch), drag moves, up/cancel hides; `touch-action: pan-y` so vertical swipes scroll (the browser cancels the
      pointer → hidden). Mouse: hover follows, leaving hides. Remembers the minute's TIMESTAMP (`scrubT`), so the 10 s
      refresh keeps it on that minute or the nearest; state set only when the minute changes; geometry read through a
      ref. Label: time ("2:11 AM") + price (`chartPrice`: cents ≥ $100, 4 decimals ≥ $1, 6 below) + "Target $X" /
      "Hourly target $X" for a line within 6% of the price range; `labelBox` flips left near the right edge and stays
      inside. interact.mjs check (touch drag, target, flip, refresh that drops the held minute, lift, mouse hover/leave);
      mutation-checked (no timestamp hold, no flip, no target line, no hide on lift: each fails). Phone screen
      crypto-coin-scrub.
- [x] 5 Checks: test:all (31 + 97 + 21 + 104 + 15 + 11 + 9 = 288), lint, build, interact.mjs (incl. My Bets history and
      the chart scrubber), dealcheck.mjs, phone check 108 screens × 320/375/414 clean. Version 0.13.0. Merged wip → main.
      No firestore.rules change and no new index. Harness server stopped.

## Batch (Will, 2026-10-18): Phase 1 fixes (0.11.0), then Phase 2 crypto markets (0.12.0)
Spec: Will's message of 2026-10-18 00:03 CT. Two phases, each merged to main on its own, in order.
Push `wip` after every commit. Phase 2 starts from a fresh `wip` off main after Phase 1 is merged.

## Phase 1 — fixes (0.11.0) — COMPLETE (2026-10-18), merged to main, ready for Will to test

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
- [x] 6 package-lock.json committed (lockfileVersion 3, from `npm install`); `npm ci` + production build pass
- [x] 7 CLAUDE.md "Deliberate decisions": cash out line replaced, craps clocks and Kalshi matching added; a note
      that the lockfile is committed
- [x] 8 Checks: test:all (26 + 97 + 21 + 100 + 15 + 11 = 270), lint, build, interact.mjs, dealcheck.mjs, phone
      check 96 screens × 320/375/414 clean (new: sportsbook-live, sportsbook-live-empty, cr-solo; fixtures' league
      boards now drop finished games like the server). interact.mjs's "three quick taps" check read the wallet in
      the instant before it re-rendered (failed on main too in this environment); it now waits up to 300 ms.
      Merged wip → main as 0.11.0. No firestore.rules change.

## Phase 2 — crypto markets (0.12.0) — COMPLETE (2026-10-18), merged to main, ready for Will to test

### Checklist
- [x] P2-1 Series discovery (2026-10-18 ~05:00–06:00Z, real APIs). The /series?category=Crypto list has no cursor but
      is too long to read in one go, so it was read several times (it comes back in a different order each time)
      and every candidate checked on its own (/series/{t}, open /events with nested markets, Coinbase /products/{id}).
      Config: shared/crypto/coins.js (`CRYPTO_COINS`, `CRYPTO_SERIES`).
      Included (Coinbase product online for each):
        BTC  KXBTC15M + KXBTCD (BTC-USD) · ETH KXETH15M + KXETHD (ETH-USD) · SOL KXSOL15M + KXSOLD (SOL-USD) ·
        XRP KXXRP15M + KXXRPD (XRP-USD) · DOGE KXDOGE15M + KXDOGED (DOGE-USD) · BNB KXBNB15M + KXBNBD (BNB-USD) ·
        HYPE KXHYPE15M + KXHYPED (HYPE-USD) · NEAR KXNEAR15M only (NEAR-USD) · ZEC KXZEC15M only (ZEC-USD).
        15-min markets: one market, strike_type greater_or_equal, floor_strike = target; hourly: ~45+ markets,
        strike_type greater, floor_strike only, opens on the hour and closes on the next.
      Left out: ranges (cap_strike / between): KXBTC, KXETH, KXSOL, KXSOLE, KXXRP, KXRIPPLE, KXDOGE, KXZEC, KXTON,
        KXNEAR, KXHYPE ("Hype", less/between). No open market when checked: KXBCH15M, KXADA15M, KXTON15M, KXTONH,
        KXTOND, KXNEARH, KXZECD, KXZECH (so BCH, ADA, TON left out; NEAR and ZEC 15-min only). Daily or longer:
        ETHD, KXBCHD, KXLTCD, KXSHIBAD and the monthly/annual/one-off series. Not one coin: KXCRYPTOCOMP15M,
        KXCRYPTOLEAD15M.
      Coinbase: /products/{id} status online; /ticker {price, time…}; /candles?granularity=60 → [time s, low, high,
        open, close, volume], newest first, ~300 rows. CORS wasn't checkable from here, so the phone never calls
        Coinbase: the chart comes through /api/board (decision).
- [x] P2-2 server/crypto.js: memory-only 10 s cache (failures kept 10 s too); `pickCryptoEvent` (soonest-closing
      open event that has opened and has a target), `fifteenSection`, `hourlySection` (main strike = YES ask
      nearest $0.50; full tradable ladder on the coin page), Coinbase price + this hour's 1-minute candles.
      /api/board?league=crypto → getCryptoBoard, &game={coin} → getCryptoCoin. No Firestore reads or writes.
- [x] P2-3 Betting: shared/betRules.js knows 'crypto' (yes/no, has a line = strike, singles only:
      CRYPTO_PARLAY_MESSAGE); `priceCryptoLeg` (configured series, ticker of that event, fresh market, active,
      opened, target set, > 60 s before close, MIN/MAX/gap, ask price, LINE_CHANGED on another strike); placeBet
      stores label ("BTC Up (≥ $81,931.55, 7:30 PM)"), strike, close time as startTime, `crypto` {symbol, coin,
      kind, closeTime}. No cash out (NO_CASHOUT_PREFIXES has 'crypto:').
- [x] P2-4 Settlement: gameKey for crypto legs includes the market ticker (each strike is its own market);
      loadGameResults fetches the market; `resultFromCryptoMarket` (settled/finalized + yes/no → final; voided →
      void; else pending); gradeLeg 'crypto'. Same settleBet path and ledger ids.
      Tests: test/crypto/crypto.test.mjs (9, `npm run test:crypto`, in test:all). Mutation-checked: 60 s cutoff
      (3 fail), series check (1), opened (1), target (1), price checks (2), parlay rule (1), cash out (1), grading
      inverted (2), void ignored (2).
- [x] P2-5 Screens: Crypto tab (Live, leagues, Crypto, Custom; `CRYPTO_TAB`), src/pages/crypto/CryptoBoard.jsx (coin
      cards: price, 15-min target + countdown + Up/Down, hourly main strike + Above/Below + countdown; "Closed" in
      the last 60 s; "Next market opens soon" with no open market), src/pages/crypto/CryptoCoinPage.jsx at
      /sportsbook/crypto/{coin} (big price, chart, 15-min buttons, full hourly ladder), src/components/crypto/
      (CryptoPick, CoinMarkets, CryptoChart = hand-built SVG, no library; "Chart unavailable" fallback).
      src/lib/crypto.js: useCryptoData (10 s poll, server-clock offset), useServerNow (one 1 s interval, cleared on
      unmount), makeCryptoPick. Slip: crypto label/line text, Parlay tab disabled with the singles-only note, adding
      a crypto pick switches the slip to singles. useBoard(null) loads nothing (Crypto tab). Hooks checked: stable
      deps, intervals cleaned up, state only set in callbacks; chart inputs memoized.
- [x] P2-6 Tests (see P2-4) + phone check scenarios: sportsbook-crypto, sportsbook-crypto-pick, crypto-coin,
      crypto-coin-pick, crypto-coin-closing (15-min in its last 60 s), crypto-coin-15m-only, crypto-coin-no-chart.
- [x] P2-7 Checks: test:all (26 + 97 + 21 + 100 + 15 + 11 + 9 = 279), lint, build, interact.mjs, dealcheck.mjs, phone
      check 103 screens × 320/375/414 clean. Version 0.12.0. Merged wip → main. No firestore.rules change.

## Next
0.14.0: item 3 (player props), then 4, checks.

## Open questions
None open.

## Answered
- Q1 — ANSWERED by Will 2026-10-18 01:56: remove guard (b) entirely, no latest-trade replacement (0.13.0 item 1).
  Original question (2026-10-18, Phase 1 item 1b): Kalshi's `updated_time` does NOT move when a market trades. Checked against the
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
