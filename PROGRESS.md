# PROGRESS

Read CLAUDE.md first (standing rules), then this file. `git fetch`; check out `wip` if it is ahead of
`main`; continue from "Next". Casino history: `docs/CASINO_PROGRESS.md`.
Earlier phases (all merged): cash out (0.7.0), card dealing speed (0.7.1), casino batch A (0.8.0),
Battles (0.9.0), Challenges (0.10.0).

## Phase 0.15.0 (Will, 2026-10-20 10:22 CT) — IN PROGRESS on wip
Spec: Will's attachment of 2026-10-20 10:22. One phase on a fresh wip off main (d09682b); merge after every
CLAUDE.md check; stop dev/harness servers at the end.

### Checklist
- [x] 1 Same-game parlays with props allowed. `PROP_PARLAY_MESSAGE` / `hasPropSameGame` and the slip warning removed.
      New key: `parsePropTicker().statKey` = series + the ticker's player segment ("KXNFLRSHYDS-CLEDWATSON4"), never a
      name; `propStatKey(leg)` and `conflictKey` (props: `prop|{statKey}`) in shared/betRules.js. slipProblems: a
      repeated prop key in a parlay → `propConflictMessageFor(leg)` = "You already have a Derrick Henry Rush Yds pick
      in this parlay." (stat from the series config; name from the pick, only as text). placeBets refuses in
      parseRequest, before any pricing fetch (BAD_SLIP, nothing placed). The slip sends `playerName` (sanitized,
      ≤ 60 chars, never stored, only used in that message; no name → "You already have a Hits pick on that player in
      this parlay."). Slip: in parlay mode a second pick on the same player + stat is refused with that notice
      (singles still swap, as in 0.14.0); the notice also shows above the closed slip bar (× dismiss, 44 px).
      Decision (literal spec): the key has no game in it, so the same player's same stat in two different games is
      also refused in one parlay (0.14.0 allowed it); singles unaffected. Kept: ML + spread same game, crypto singles.
      Tests (test/props, replacing the 0.14.0 parlay test): accepted = prop + same-game ML, two players same game, same
      player different stats, props from two games + a same-game total; refused = two thresholds, YES + NO same market,
      non-adjacent, same player/stat across games, ML + spread with a prop (no fetch, no bet, no money); slip reducer
      and slipProblems mirror. Mutation-checked: threshold in key (2 fail), no series (3), game suffix in key (2), key
      by name (3), key per market ticker (2), slip refusal off (1), generic message in parlay (2). CLAUDE.md line,
      README line, props help text.
      Lint: the repo has no eslint config (eslint 10 via npx refuses to run without one); I lint `src` + `shared` with
      a scratch flat config outside the repo (@eslint/js recommended + react + react-hooks recommended), clean.
- [x] 2 Player props on the game page. src/pages/GameDetailPage.jsx: section tabs "Game lines" / "Player props" right
      under the score header (GameCard), shown only when `hasProps` (ESPN game, pre-game, not canceled, propsCount > 0);
      no tab bar at all otherwise. Game lines = the alternate spread/total wheels as before. Player props =
      src/components/PlayerPropsSection.jsx (the old page's stat tabs, search, a wheel per player), MOUNTED ONLY while
      that tab shows, so usePropsData's props call (/api/board …&props=1, 30 s server memory cache) runs only then and
      its 30 s poll stops when the player goes back to Game lines. src/pages/PlayerPropsPage.jsx deleted; the
      "Player props (N players) ›" button removed. Section remembered in sessionStorage `bb.gameSection`
      (`readSavedSection` / `saveSection`, both try/catch). Visible section is derived (`visibleSection(choice,
      hasProps)`): when the game starts the next detail refresh has state 'in' / propsCount 0, the tab disappears and
      Game lines shows, with no effect or state change needed. /sportsbook/{league}/{gameId}/props → `PropsRedirect` →
      the game page with `?section=props`, which one effect turns into the saved choice and then strips from the URL
      (replace). Hooks: one effect (only acts while the param is present; after it removes the param it is a no-op),
      no state set during render, the props section keyed by game.
      Interpretation (recorded, not a contradiction): "opening the game page alone must not fetch props" = the phone
      makes no props call; the game detail's server-side `propsCount` (needed to decide whether to show the tab) stays
      as in 0.14.0, from the same 30 s memory cache.
      interact.mjs: new check "props tab" (no props call on the game page; tab loads once; lines hidden; saved; Game
      lines → no props call on refresh; reload reopens Player props; kickoff refresh removes the tabs and calls no props;
      404 shows no tabs; old URL redirects, cleans the URL, selects the tab) and "sessionStorage blocked" (no errors).
      Mutation-checked: tab kept after the start (fails), props section always mounted/hidden (fails "no props call").
      Phone screens (replacing props-page*): game-lines-tab, game-props-tab, game-no-props, game-props-old-url,
      game-props-pick, game-props-td, game-props-none, props-parlay-conflict (item 1's notice above the slip bar).
- [x] 3 Craps/Crapless layout (src/pages/casino/CrapsPage.jsx, both variants; game logic untouched: same validate /
      sendChips / tapSpot / rollDice / seatDetail code, no change to shared/casino or server/casino). Top: one compact
      bar `.craps-bar` (puck, two 36 px dice, last total + kind, a status line, countdown, Roll when it's my turn; for a
      player not seated "Sit down" = first open seat, or "Table full"). Then the felt: `CrapsRack` (4 chips + Take down
      in one row; craps-only, so Blackjack/Baccarat's ChipRack is unchanged), tools row ($60 meter + Undo + Clear), then
      grids: Pass / Odds / Don't Pass / Don't Odds (crapless: Pass / Odds / Come / Field), Come + Field, Place numbers
      (6 across; crapless 5 × 2), Come bets on their numbers (tap = their Odds), Hard ways (4 across). Spots are always
      shown (Odds etc. dimmed until they apply; tapping one says why, from the existing placeBlocker). Payouts moved to
      the rules text (spots keep a short ratio); amounts as whole dollars. Errors show as a toast over the felt (no
      layout shift). Below: seats, last rolls, Leave seat, help, rules, then "‹ Casino" (moved from the top to save
      height; the bottom nav also goes back; the page title is a visually hidden h2). ≥ 720 px: the felt is two
      columns. Short screens: `DOCK_QUERY` = (max-height: 620px) via the new src/hooks/useMediaQuery.js
      (useSyncExternalStore + the media query's change event, removed on unmount; no resize listener) moves the rack
      and Roll into `.craps-dock`, fixed above the bottom nav; the spots scroll. All tap targets ≥ 44 px.
      interact.mjs: per variant, the busiest felt (my roll, point on, countdown, 3 Come bets) measured at 375×667,
      390×844, 414×896, 1280×720, 1440×900 (Roll, 4 chips, Take down, Undo, Clear and all 19 / 21 spots inside the area
      between the sticky top bar and the bottom nav at scrollY 0, each ≥ 44 px) and 320×568 (dock only). Lowest control
      at 375×667: 501 px of 607 visible. "Sit down" check: first open seat, empty seat below still seats, "Table full",
      dock follows the query both ways, media listeners added = removed after leaving the page. Mutation-checked: spots
      80 px tall (fails at 375×667), dock off (fails at 320×568), subscription never removed (fails cleanup).
      Phone screens added: cr-full, cr-my-roll, cx-point, cx-comeout, cx-watch, cx-full, cx-my-roll (existing cr-point,
      cr-comeout, cr-watch, cr-takedown, cr-chips, cr-come-hard, cr-dont-odds, cr-solo, cr-crapless kept).
- [ ] 4 Checks: test:all, lint, build, interact.mjs (incl. no-scroll), dealcheck.mjs, phone check. Version 0.15.0.
      Merge wip → main. Tonight's prop games for Will's test steps. Servers stopped.

## Phase 0.14.0 (Will, 2026-10-18 12:25 CT; re-sent 2026-10-20 09:33) — COMPLETE (2026-10-20), merged to main, ready for Will to test
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
- [x] 3 Player props (server). Series discovery (2026-10-18 ~17:35Z): GET /series?category=Sports is cut off by the
      fetch tool at ~119k characters (also per tag: Basketball/Baseball/Hockey/Football), has no cursor and comes
      back in a different order each time, so it could NOT be read to the end (spec item impossible as written).
      Safest option taken: sampled the list (whole and per tag) and probed every plausible player-stat ticker
      directly (open per-game events, min_close_ts now); included only verified series with "Player: N+" markets,
      strike_type greater, a floor_strike, no cap, one event per game. Config: shared/props.js `PROP_SERIES`.
      Included (24): NFL KXNFLPASSYDS, KXNFLRSHYDS, KXNFLRECYDS, KXNFLREC, KXNFLTD · MLB KXMLBHR, KXMLBHIT, KXMLBKS,
      KXMLBTB, KXMLBRBI, KXMLBHRR, KXMLBSB · NHL KXNHLGOAL, KXNHLPTS, KXNHLAST, KXNHLSAVE · NBA KXNBAPTS, KXNBAREB,
      KXNBAAST, KXNBA3PT, KXNBASTL, KXNBABLK, KXNBASTOCK (Stl+Blk), KXNBAPRA (Pts+Reb+Ast).
      Left out: KXNHLSAVES (named in the spec; no events — the live series is KXNHLSAVE, used instead), KXNHLSOG,
      KXNHLBLK, KXNFLPASSTD, KXMLBRUN, KXMLBWALK, KXNCAAFPASSYDS/RSHYDS/RECYDS/TD (no open events); KXNFLLADDERRSHYDS
      (scalar ladder, no floor_strike), KXNBAONE3PT (season-long), KXNFLLONGESTREC, KXNFLMOSTRECYDS,
      KXNFLWEEKMOST*, KXNBAH2HPTS, KXNBAFIRSTBASKET, KXNHLFIRSTGOAL, season/leader/award series (not per player per
      threshold per game). No college-football or college-basketball prop series found.
      Matching: `propBelongsToGame` — configured series of the game's league AND ticker suffix = the mapped winner
      event's suffix (so the playoff game-number rule carries over); prop event ticker = `{series}-{suffix}`; no
      mapped winner → no props. Pre-game: `propsOpen` (ESPN 'pre' and server clock < startTime). server/props.js:
      loadGameProps (one /events/{ticker} per configured series, 30 s memory, never Firestore; tabs per stat; players
      sorted away team, home team, then most-traded; thresholds whose price fails the checks hidden, players with none
      hidden; main = YES ask nearest $0.50), pricePropLeg (configured series, mapped event, fresh market active and
      prop-shaped, pre-game, price checks, ask; LINE_CHANGED on another strike; ODDS_CHANGED as usual),
      resultFromPropMarket (finalized yes/no → graded; voided or final non-yes/no → void). Leg marketType 'prop',
      gameId = ESPN id, `prop` {series, stat, player, team, threshold, anytime}; labels "Derrick Henry 50+ Rush Yds" /
      "… Under 50 …", TD/HR at 1: "1+ TD" / "No TD". Bet rules: conflictKey one pick per player per stat; legId
      includes the ticker; `hasPropSameGame` → PROP_PARLAY_MESSAGE. Cash out: generic pre-game × 0.90; live bid from
      the prop's own market (suffix-checked) with the gap check. Settlement: gameKey per prop market; Kalshi result.
      /api/board &game={id}&props=1 → getGameDetail(…, { props: true }); the normal game detail adds `propsCount`
      (pre-game only). Team of a player: ticker code prefix = the game's Kalshi team code (`teamCodeOf`).
      Tests: test/props/props.test.mjs (9, `npm run test:props`, in test:all). Mutation-checked: clock cutoff (2 fail),
      state check (2), suffix helper (2), bet-time suffix check (1), same-game parlay rule (1), non-yes/no → void (2),
      cash out gap (1). CLAUDE.md props line.
- [x] 4 LineWheel (src/components/LineWheel.jsx), no library: one row of chips, CSS scroll-snap (x mandatory),
      centered chip = selected (larger, accent), chips fade to the edges (mask), two bet buttons under it. Starts on
      the main line (spreads/totals: the main board line, else the nearest Kalshi strike; props: YES ask nearest
      $0.50). Tap a chip to center it; ‹ › buttons and ←/→ keys (track focusable) step one line. Centered chip found
      on a debounced scroll end (120 ms) plus `scrollend` — never per frame; listeners/timer removed on unmount. On a
      refresh it keeps its line; a vanished line moves to the nearest by value, re-centered instantly (layout effect
      keyed on the set of lines, not prices). Slip pick: button stays pressed, chip shows a gold dot. aria: selected
      chip "Total 44.5, Over −110, Under −110", plus a polite live region. `touch-action: pan-x pan-y` on the track:
      the spec's "pan-x" alone would stop vertical swipes on the wheel from scrolling the page, which the spec also
      forbids, so I kept the requirement (vertical swipes scroll) — decision. Chips ≥ 44 px (non-selected chips are
      never scaled down; the selected one grows). Spacers are ::before/::after sized against the track (a % padding
      pushed the › button out of the card — caught in review and now asserted by interact.mjs).
      Game page: spread wheel (chips from the home side, lowest → highest; buttons "Browns −3.5" / "Ravens +3.5";
      only lines with both sides tradable) and total wheel ("Over 44.5" / "Under 44.5"); main-line card unchanged;
      "Player props (N players) ›" button when pre-game and N > 0 (N = distinct players, not players × stat tabs).
      Props page /sportsbook/{league}/{gameId}/props (src/pages/PlayerPropsPage.jsx, src/lib/props.js): stat tabs,
      search, one card per player (name, team) sorted by team then most-traded; a wheel per player, or just the two
      buttons for a single threshold ("1+ TD" / "No TD"); 30 s poll; closed / none states. Slip: same-game prop parlay
      warning (PROP_PARLAY_MESSAGE), prop line text, LINE_CHANGED on a prop updates its threshold.
      Phone check: game-detail-wheels-moved, game-detail-wheel-pick, props-page, props-page-pick, props-page-td,
      props-page-none, props-parlay-same-game. interact.mjs "line wheel" check: main line + centered, sorted chips,
      pan-y, snap, 44 px, arrows inside the card, aria, tap / arrow key / swipe select, slip dot, a 30 s refresh that
      drops the selected line → nearest and still centered, props rows (start nearest $0.50, single-threshold
      buttons, search).
      Also fixed: test/sportsbook/phase6b "/api/board … ladders" read the real clock against Oct 18 Kalshi fixtures
      and started failing on Oct 20 (outside the 1-day lookback); the clock is now pinned in that test.
- [x] 5 Checks: test:all (31 + 97 + 21 + 104 + 15 + 11 + 11 + 9 = 299), lint, build, interact.mjs (10 checks incl.
      the wheel), dealcheck.mjs, phone check 115 screens × 320/375/414 clean. Version 0.14.0. Merged wip → main.
      No firestore.rules change, no new index. Harness server stopped.
      Props to test with (Kalshi, checked 2026-10-20 ~09:45 CT): NBA tonight BOS@DET, PHI@NYK, OKC@SAS (rebounds etc.;
      KXNBAPTS had no events yet); NHL tonight 11 games (goals, e.g. COL@NJ, TB@VGK, BOS@DAL); MLB World Series opener
      Fri Oct 23 TB vs MIL (HR). No NFL week-8 prop events listed yet.

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
0.15.0 item 1 (prop parlay rule), then 2 (props tab), then 3 (craps layout), then 4 (checks + merge).

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
