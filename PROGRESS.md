# PROGRESS

Read CLAUDE.md first (standing rules), then this file. `git fetch`; check out `wip` if it is ahead of
`main`; continue from "Next". Casino history: `docs/CASINO_PROGRESS.md`.
Earlier phases (all merged): cash out (0.7.0), card dealing speed (0.7.1), casino batch A (0.8.0),
Battles (0.9.0), Challenges (0.10.0).

## Phase 0.20.0 (Will, 2026-10-27 02:57 CT) — IN PROGRESS
Spec: Will's message of 02:57 ("Slots paytable, win line and big wins, autospin, casino sounds"). 0.19.0 merged first
(main = 284cb79). Fresh wip. Client only: no server, rules or money change; every spin is the normal /api/casino spin call.
No firestore.rules change; nothing to publish.

### Checklist
- [ ] 1 Paytable sheet (Paytable button in the Slots top bar; chat drawer sheet styles), rows read from PAYTABLE, pays for the
      current bet beside each.
- [ ] 2 Win line + count-up (about 1 s) on a win; Big win (>= 10x bet): banner + CSS coin shower, at most 2.5 s, tap to skip;
      reduced motion: amount and banner only.
- [ ] 3 Autospin: 10 / 25 / 50, stop on any win / 10x bet / don't stop; one spin at a time after the last result shows; stops on
      count, rule, short wallet, failed spin, Stop, leaving, hidden tab; bet locked; "Auto 12/25" + big Stop.
- [ ] 4 Sounds (src/lib/casinoSound.js, Web Audio only): chip, card, dice rattle/land, reel spin/stop, win, big win; mute button in
      every casino top bar and the lobby (localStorage, on by default); AudioContext on the first tap; silent while hidden;
      vibrate(30) on a win when sound is on.
- [ ] 5 Harness: Slots screens (paytable open, autospin running, big win) at 320/375/414; interact: paytable values, autospin rules,
      mute persisting across a reload and between games.
- [ ] 6 Version 0.20.0, README, casino notes, test:all, eslint, build, phone check, merge to main.

## Phase 0.19.0 (Will, 2026-10-20 23:01 CT) — COMPLETE (2026-10-21), merged to main, ready for Will to test
Spec: Will's attachment of 23:01 ("Blackjack and Baccarat table look, Rebet, hand totals and win effects, Baccarat squeeze,
one chip style everywhere"). 0.18.1 merged first (main = 9a15e6d). Fresh wip. Look and client only: server, betting rules,
money code and useChipBetting's send/reply logic (0.17.2) are untouched. No firestore.rules change; nothing to publish.

### Checklist
- [x] 1 One chip style: src/styles/chips.css + FeltChip.jsx are the only chip look; Chips.jsx (ChipRack, ChipStack) uses it;
      old .chip-token CSS removed; Slots, Blackjack, Baccarat use ChipRack/ChipStack; Oswald loaded on all three pages.
- [x] 2 Blackjack felt (BlackjackFelt.jsx, src/styles/tablefelt.css): #0b5d3b in a 6 px #5a3519 rail, half-moon, dealer + shoe
      top right, Oswald arcs (SVG textPath), five betting circles (mine gold, others white, empty dashed "Sit"), name + status
      under each. Tap one of my circles to switch seats (with 2+ seats). Someone else's turn: their hand in a card under the felt.
- [x] 3 Cards slide from the shoe (PlayingCard `dealAt`, 250 ms, Web Animations; reveal times unchanged; reduced motion = none).
      The old card-in flip is now a 0.2 s fade.
- [x] 4 Total pills beside every hand (Blackjack: dealer, my hands, the spotlight; Baccarat: both boxes). ResultFx: +$ / −$ / Push
      float 1.2 s and a chip slide dealer<->spot, on each of my Blackjack seats and each of my focused Baccarat seat's spots
      (net per spot = spotReturnCents − stake). Plays once per round key (module-level set).
- [x] 5 Rebet / Rebet ×2 (Blackjack per seat, Baccarat every spot) through chips.place; remembered per seat in memory when the
      cards are dealt; hidden once any chip is on screen (shows again after Undo to $0); wallet shortfall shows the usual
      message and places nothing (Baccarat checks the whole total first).
- [x] 6 Baccarat printed table (BaccaratFelt.jsx): PLAYER (blue) / BANKER (red, 5% commission) / TIE (green, white text) spots
      64 / 64 / 52 px tall, printed PLAYER / BANKER card boxes with total pills, roads unchanged below.
- [x] 7 Baccarat squeeze: PeelCard from the start of the third card's gap, a CSS animation as long as the gap with a negative
      delay set at mount, so it finishes on the coupRevealTimes time (checked within 220 ms in the harness).
- [x] 8 Harness: shoot.mjs TABLE_SIZES (320×640, 375×800, 414×896, 844×390, 1280×800, full-page shots); interact.mjs: Rebet (5 checks
      × 2 games), pills (2), floats (5 + Baccarat 2), squeeze (2); dealcheck.mjs: slide checks (2), seat text now from the felt.
      Rebet math is checked end to end in interact.mjs (the fake server holds the totals) rather than as a unit test.
- [x] 9 Version 0.19.0, README, casino notes, test:all, eslint, build, phone check, merge to main.
Decisions: the hole-card reveal slides from the shoe too (a card only slides when it mounts within 0.7 s of its reveal time, so
a phone opening mid-hand just shows the cards). The Baccarat spots are rendered by the focused seat's panel into the printed
area (portal) so the buttons and their aria-labels keep their old meaning. Floats read "+$15.00" (formatMoney, like the rest
of the app). The seat row (tiles) stays under the Baccarat table for sitting and watching others. On a computer, buttons on
the casino table pages and the app's Sign out are now 44 px tall too (they were 31 px with a mouse).
Checks: test:all (all suites pass), eslint clean, build ok, interact 59 + 3 updated (chip text now read from the aria-label;
the font now loads on every casino table, never on the sportsbook), dealcheck 8/8, shoot: every bj-/bac- screen at 5 sizes and
every craps screen at 8 sizes with no sideways scroll and no small buttons.
Also fixed (test only): test/activity/walletActivity.test.mjs "admin only" seeded its entry at the fixed 2026-10-20 date but
the handler uses the real clock, so it failed from 2026-10-21; the entry is now stamped with real time.

## Phase 0.18.1 (Will, 2026-10-20 22:38 CT) — COMPLETE (2026-10-20), merged to main, ready for Will to test
Spec: Will's message of 22:38. Fresh wip off main (0.18.0). No firestore.rules change; nothing to publish.

### Checklist
- [x] 1 Slots chat removed: CHAT_ROOMS = blackjack, baccarat, craps, crapless (shared/casino/chat.js); the server refuses
      game 'slots' with 400 BAD_ROOM (test added in test/chat/chat.test.mjs). SlotsPage has no useCasinoChat / ChatButton /
      ChatDrawer (fits at 320 / 375 / 414, checked). CHAT_LEGACY_ROOMS = ['slots']: pruneCasinoChat walks both lists, so the
      old test messages go after 24 h (existing prune test still covers a slots message). Phone-check: chat-slots screens and
      fixtures removed (a plain slots-no-chat screen stays), room-count checks updated.
- [x] 2 Failed chat load: useCasinoChat keeps err.code and exposes `errorCode` and `retry` (a counter in the listener effect's
      key; nothing set during render). The drawer (CasinoChat.jsx): permission-denied → admin sees "Chat can't load: the
      Firestore rules aren't published. Firebase console → Firestore Database → Rules → Publish."; players see "Chat is
      unavailable right now."; other codes: the player text, plus the code in small type for the admin only. While the load
      has failed the text box and Send are disabled; a "Try again" button subscribes again; closing and reopening the drawer
      does too. Checks in interact.mjs (mock Firestore now accepts a `code`).
- [x] 3 Tick back-off: src/lib/deadlineTicker.js (no React, so it can be tested with fake timers); useDeadlineTick uses it. Every
      2 s (+ up to 0.4 s) for the first 30 s after the deadline, then every 10 s (+ up to 2 s); nothing while
      document.visibilityState is 'hidden', one tick as soon as it is visible again; "not yet" replies still aim just past the
      deadline; a reply that moves the table restarts the effect (deadline / phase deps) as before. test/casino/ticker.test.mjs
      (5 tests): the rate change, no ticks hidden, one on visible, the next hand within ~1 s when ticks succeed, stop().
- [x] 4 Offline banner on craps: the app's own banner stays hidden there (the page covers it); the craps page draws its own
      `.offline-banner` as the first row of the stage, above the top bar (a grid row sideways), one compact line; upright it
      takes a few pixels back from the status row. Checked offline at 375×667, 844×390, 568×320 and 320×568: above the top
      bar, nothing pushed off screen, felt buttons still 44×44, no new page scrolling.
- [x] 5 Version 0.18.1, notes, test:all, eslint, build, phone check (shoot + interact + dealcheck), merge to main.
Decision: the banner text on craps reads "You're offline. Bets and rolls will update when you're back online." (the spec gave
no wording).

## Phase 0.18.0 (Will, 2026-10-20 21:10 CT) — COMPLETE (2026-10-20), merged to main, ready for Will to test
Spec: Will's attachment of 2026-10-20 21:10 ("real casino-style craps felt, upright and sideways layouts"). 0.17.2 was
already merged (main = d5db0c8). Fresh wip off main. Look and layout only: server, betting rules, money code,
useChipBetting and the bet actions are untouched; every felt area calls the same tapSpot (place / take down) the old spots
used, and Undo / Clear / Roll / Sit down / Leave / Take down keep their handlers.

### Checklist
- [x] 1 Chip look (FeltChip: dashed edge, colour by the largest chip, "$12" / "$1.2k") for the felt and the craps rack
      (44 px sideways, 48 px upright, selected lifts 2 px + gold ring); Oswald from Google Fonts (preconnect, display=swap).
- [x] 2 The felt (src/components/casino/CrapsFelt.jsx): every printed area is one <button> (aria-label, gold focus ring,
      white wash when pressed, existing `blocked` style + message): number boxes (SIX / NINE as words; payout top, ON puck
      bottom-left, my chips bottom-right, Come bet = C chip + odds chip, tap = Come Odds), COME, FIELD, DON'T PASS BAR +
      DON'T ODDS (craps only), PASS LINE + ODDS ("up to 2×"), HARDWAYS (two red dice, gold payout).
- [x] 3 Upright layout (@media (orientation: portrait)): top bar, status row, stacked felt, docked bottom (wallet / on
      table, message line, 6 chips, Undo / Clear / Take down / ROLL). No page scrolling at 375×667 and up.
- [x] 4 Sideways layout (@media (orientation: landscape) and (max-height: 500px); computers use it sized up): one-row top
      bar, felt + 138 px rail, Pass strip + Don't Pass strip as the L with the bottom rows; notch padding.
- [x] 5 "Table" sheet (seats, last rolls, Leave seat, help, rules) from a top-bar button: chat drawer's sheet styles,
      never moves the felt; inline below the felt on tall upright screens.
- [x] 6 Orientation change keeps seat, unsent chips, drawers (CSS switch; one media-query listener only for where the
      Table content shows; removed on unmount).
- [x] 7 Phone check: both games at 320×568, 375×667, 414×896, 568×320, 667×375, 844×390, 932×430, 1280×800; interact.mjs
      felt checks (each area places a chip, Pass strip = Pass row, Odds cap message, Undo / Clear, rotate mid-bet,
      Table sheet, Crapless 10 boxes and no Don't Pass); dice-tumble check unchanged.
- [x] 8 Version 0.18.0, PROGRESS / README / casino notes; test:all, lint, build, phone check; merge wip → main; stop servers.

### What was built
- New: src/components/casino/CrapsFelt.jsx (the felt), FeltChip.jsx (chips), src/lib/feltFont.js (Oswald, loaded once when a
  craps table opens), src/styles/craps.css (both layouts; the old craps CSS left index.css). Rewritten: CrapsPage.jsx (layout
  and the Table sheet; betting code unchanged: betsToSpots / spotsToBets, validate, sendChips, useChipBetting, tapSpot, rollDice).
  Die.jsx: `decorative` dice for the Hardways boxes. No server, shared/casino, useChipBetting, rules or firestore.rules change.
- One DOM, two layouts by CSS (`@media (orientation: portrait)` / `(orientation: landscape)`; phones are short, so the sideways
  look is the landscape one, computers get it sized up and capped at 660 px tall). The page is never rotated or locked. The only
  JavaScript media query is `(orientation: portrait) and (min-height: 780px)`: it decides whether seats, last rolls, help and
  rules sit under the felt (tall upright) or in the Table sheet; the listener is removed on unmount.
- Pass Line / Don't Pass Bar exist twice (the vertical strips down the left edge sideways, the rows along the bottom); both
  call tapSpot with the same kind, so it is one bet. The strips are hidden from screen readers and from the upright layout.

### Verification (all green)
- `npm run test:all` (31 + 106 + 21 + 104 + 16 + 11 + 11 + 12 + chat + activity), `npx eslint src` (clean), `npx vite build`
  (dummy VITE_FIREBASE_* vars).
- Phone check (tools/phone-check): shoot.mjs runs every craps / Crapless screen at 320×568, 375×667, 414×896 (upright),
  568×320, 667×375, 844×390, 932×430 (sideways) and 1280×800 (computer): nothing clipped, no page scroll where required, every
  felt button at least 44×44 (one documented exception below). interact.mjs: each area places a chip on its bet (both games,
  come-out and with a Point), Pass strip = Pass row, Odds cap message, Undo / Clear, Come bet C chip + Come Odds, Take down,
  6 vs 10 boxes and no Don't Pass in Crapless, labels / hard-way pays, font links, focus ring, rotating mid-bet keeps seat,
  chips and chat drawer (and sends no leave / sit), the Table sheet (×, Escape, backdrop; felt never moves), Sit down / Table
  full, the media-query listener cleanup, 6 chips. The dice-tumble check is unchanged and passes. dealcheck.mjs passes.


### Decisions (spec points that cannot all hold; safest option taken)
- The spec's own sizes conflict with its "every felt button at least 44×44": the Pass strip (34 px) and Don't Pass strip
  (30 px) are narrower, the Don't Pass row (32 px) and Pass row (40 px) shorter, and at 568×320 six number boxes cannot be
  44 px wide beside two strips, the 116 px Hardways column and the 138 px rail. Taps win: the strips are 44 px wide, the rows
  44 px tall, and at < 640 px wide the Pass strip is left out (< 760 px: the Don't Pass strip), with Hardways 92 / 100 px
  wide, because the Pass row and Don't Pass row reach the same bets. Nothing is lost.
- Take down isn't in the spec's rail / dock lists; it sits with Undo and Clear (a third 44 px button sideways, a fourth
  button in the dock upright).
- The page covers the app's top bar and bottom tabs (the spec's sizes don't fit with them); ‹ back replaces them, and the
  wallet is in the rail / dock.

- Come Odds live inside the number boxes (the spec has no other place for them): the C chip + odds chip cluster is its own
  44 px-wide button over the bottom of a number box that holds a Come bet, 44 px tall where the box is 69 px or more. The one
  exception is Crapless at 568×320 (boxes only ~47 px tall): the cluster is 44 × 30 there, so the top of the box stays tappable
  for Place. shoot.mjs / interact.mjs allow exactly that (`comeOdds:`) and nothing else under 44 px.
- "No page scrolling at 375×667 and up": the felt and the dock always fit with no scrolling from 600 px tall (375×667, 390×844,
  and so on); on tall upright screens (780 px and up) seats, last rolls, help and rules sit under the felt, as the spec says
  ("below the dock"), so the page scrolls there to reach them while the felt and dock stay in view. Below 600 px tall
  (320×568) scrolling is allowed by the spec and the felt scrolls under the dock.
- Computers (landscape, taller than 500 px) use the sideways layout scaled up, with the felt and rail capped at 660 px tall so a
  1280×800 window isn't a billboard.
- The Oswald font request is a Google Fonts stylesheet added when a craps table opens (the app has no font loading elsewhere);
  if it can't load, the lettering falls back to Arial Narrow / Roboto Condensed and nothing breaks. fixtures.mjs answers it
  with an empty stylesheet in the phone check.
- Hardways payouts (8 to 1 for Hard 6 / 8, 6 to 1 for Hard 4 / 10) are the deliberate ones from CLAUDE.md, printed as such.

## Phase 0.17.2 (Will, 2026-10-20 19:30 CT) — COMPLETE (2026-10-20), merged to main, ready for Will to test
Spec: Will's attachment of 2026-10-20 19:30. 0.17.1 ("remove the Slots chat, clearer chat errors") was never started in
this repo (main = wip = 0.17.0's merge a932011, no branch, commit or PROGRESS entry), and its full spec isn't here, so it
was not invented; 0.17.2 goes straight on top of 0.17.0. Fresh wip off main.

### Checklist
- [x] 1 Stale totals. Reproduced first (interact.mjs, fake server with 500 ms bet replies that refuses negatives like
      the real one, listener catching up 150 ms after the reply), on the old code: Clear in flight sent 10 then −10
      (refused, chips bounced back); $5 × 4 in two batches sent 10 then 10 (server $10, screen $20); Undo in flight
      misfired; and worse, in Baccarat a Banker batch sent while a Player batch was in flight sent 0/10/0, silently
      wiping the Player bet with no error. Cause as reviewed: flush() re-runs synchronously after the await, while
      spotsRef still holds the pre-reply amounts.
      Fix (client only; server unchanged): src/hooks/useChipBetting.js — `send` may resolve with the server's spots;
      they go into spotsRef before the next flush; spotsRef is overwritten from props only when the prop changes (so a
      render with an older table copy can't undo it); the screen sums spotsRef + unconfirmed chips; a batch whose total
      would go below $0 is never sent (history restored as on a refusal, "Your bet changed, try again").
      BlackjackPage `sendChips` resolves { bet: reply.table.seats[i].betCents ?? reply.betCents }; BaccaratPage resolves
      that seat's { player, banker, tie } from reply.table. Craps' send returns nothing → unchanged behaviour.
      Checks (interact.mjs, Blackjack and Baccarat each): Clear in flight → amounts 10 then 0, never negative, server and
      screen $0, no error; $5 × 4 across two batches → $20 both; Undo in flight → $5; Baccarat two spots (Player $10 in
      flight + Banker $5 × 2 → $10 / $10; then $25 + Clear in flight → 0/0/0). All 7 fail on the old code, pass now.
      Existing chip checks (batching, refusal rollback, Undo/Clear, craps no-scroll, no maximum bets) still pass.
- [x] 2 Results pause 2.5 s: shared/casino/timing.js `RESULTS_MS = 2500` (was RESULTS_SECONDS = 5; re-exported from
      constants.js); blackjackTable finishRound = now + revealPadMs + RESULTS_MS; baccaratTable = coupRevealMs +
      RESULTS_MS. "Next hand in Xs" rounds up (3, 2, 1). casino2/casino3 deadline asserts → 2500; README timers line.
      15 s betting/turn clocks and dealing gaps unchanged.
- [x] 3 New hand not starting at the end of the results countdown. Reproduced with tools/phone-check/tablesim.mjs: the
      REAL Blackjack/Baccarat engines (server/casino with the in-memory Firestore) behind two pages, Will seated and a
      player only watching, real timers, table writes pushed to each page's listener after a delay. Under ideal
      conditions it worked (~0.4 s). The actual cause is the client's tick, found by adding field conditions:
      (a) Each phone tried 5 times, 2.5 s apart, then gave up for good. When those ticks failed (cold start, network) or
          came early, nobody moved the table and it sat on its results indefinitely, with the old hand and bet on
          screen; only a page reload (whose one-time arrival tick goes out) moved it on. Reproduced: ticks failing →
          both phones stop after 5 each, table still on results 26 s after 0.
      (b) The tick's reply was thrown away (tableAction, not the page's call), so a screen only learned about the next
          hand from its Firestore listener; a slow or stalled listener left it on the old hand even though the server
          had moved on. Reproduced: listener 2.5 s late → Will's own tick succeeded but his screen stayed on results 2.8 s.
      (c) The countdown (and the tick) ran early: replies stamp serverNow after the server's work, and the phone took
          that as the round trip's midpoint, so it thought the server was ahead by about half the work. Reproduced: 600 ms
          of server work → "Next hand in 0s" 263 ms before the deadline; a tick in that window is refused as early.
      Also fixed (fragile, not seen in the runs): newerTable compared updatedAt first, but updatedAt is the request's
      start time, kept when Firestore retries a transaction, so a request that started earlier and committed later
      carries an older updatedAt on a newer table → a reply copy could hide the newer listener copy. Now the write
      counter decides within one epoch (version only goes up); time only across epochs.
      Fixes: useDeadlineTick(game, deadline, { enabled, call, phase }) ticks at the deadline + 0–800 ms, then keeps
      ticking every 2 s + 0–400 ms until the deadline or phase changes (stops only on page exit); a "not yet" reply that
      carries the deadline schedules the next try just after it; ticks (and the one-time arrival tick) go through the
      page's `call`, so the reply's table shows at once. router.js adds `serverStart`; lib/casino.js takes the midpoint
      of serverStart/serverNow (and the network-only round trip) for the clock. Craps uses the same hook (same benefit).
      After: ideal, 600 ms work, 2.5 s listener lag, 600 ms work + 2.5 s lag → both screens on the next hand (betting,
      no cards, $0 spots) 0.02–0.97 s after 0, Blackjack and Baccarat; 12 failed ticks → moves on 8–9 s after 0 once
      ticks get through (before: never); a forced 3 s wrong clock → moves at the real deadline. Beyond the spec: with an
      8 s listener lag the watching phone's own screen is 8 s behind everything (it hasn't seen the results yet), so it
      can trail by a few seconds.
- [x] 4 Version 0.17.2; README, casino notes, phone-check README. Checks: test:all 330, lint, build, interact.mjs 29/29
      (incl. the 7 in-flight chip checks), dealcheck 6/6, phone check 147 screens × 320/375/414 clean, tablesim (600 ms
      server work) Blackjack 50 ms / Baccarat 167 ms on both screens. No firestore.rules change, no new index, no new
      /api function. Merged wip → main. Harness server stopped.

## Phase 0.17.0 (Will, 2026-10-20 15:07 CT) — COMPLETE (2026-10-20), merged to main, ready for Will to test
Spec: Will's attachment of 2026-10-20 15:07 (items 1–2). One phase on a fresh wip off main (1576556, Analytics in);
merge after every CLAUDE.md check; stop servers at the end.

### Checklist
- [x] 1 Casino chat. shared/casino/chat.js (rooms, 200 chars, `cleanChatText`: tabs/new lines → space, other C0/DEL/C1
      control characters dropped, trimmed; length in characters, an emoji is one; rate rules). server/casinoChat.js
      `sendChat` = /api/casino action `chat` (router; no new function): room check (400 BAD_ROOM), requestId, text
      (EMPTY_MESSAGE / MESSAGE_TOO_LONG "Messages can be up to 200 characters"), then one transaction: users/{uid}
      (missing/disabled refused), chatRate/{uid}, the message doc; an existing {uid}_{requestId} → duplicate: true (no
      rate used); rate: < 2 s since the last or 20 in the last minute → 429 SLOW_DOWN "Slow down a little"; message
      { uid, name (displayName, else username), text, createdAt (server), deleted: false } with create(), and chatRate
      { recent: last-minute times } set in the same transaction. Seated or not doesn't matter. `deleteChatMessage` =
      /api/admin `chatDelete` (admin only): deleted: true, text '', deletedAt, deletedBy; idempotent; 404 if gone.
      server/casinoChatPrune.js `pruneCasinoChat` from settleOpenBets (not dry runs): the cron always, other runs once
      an hour (meta/chatPrune); per room `createdAt < now − 24 h`, 500 a batch, ≤ 10 batches per room per run (single-
      field index, automatic). Kept apart from casinoChat.js so settlement doesn't load sign-in code (sportsbook tests
      mock auth.js narrowly); the chat checks the profile itself (same answers as auth.js checkProfile).
      firestore.rules: `casinoChat/{game}/messages/{id}` read if signed in, write never; chatRate falls under the
      server-only catch-all. Will must publish the rules.
      Phone: src/hooks/useCasinoChat.js (one onSnapshot: newest 1 while closed, newest 30 while open, `createdAt ≥ now −
      24 h`, desc then reversed; removed on close/unmount; unread: localStorage `bb.chatSeen.{room}` (try/catch) and,
      when the newest is newer, one getCountFromServer of `createdAt > seen` (1 read); single-field queries, no new
      index). src/components/casino/CasinoChat.jsx: ChatButton (badge, "Chat, N unread"), ChatDrawer (portal over the
      page and nav; room title; oldest on top; name + "8:42 PM" Central; mine = "You", right, green; removed = "Message
      removed"; auto-scroll only when at the bottom; input + Send + Enter; n/200 counter, red and Send off over 200;
      failed send retried with the same requestId; Escape / backdrop / × close; body scroll locked while open; admin
      Delete → inline confirm → chatDelete). Text is React text: no HTML, no links. Slots/Blackjack/Baccarat: button
      in the header (icon-only under 420 px; header items don't wrap inside). Craps/Crapless: compact button in the top
      bar; on phones (< 720 px) the bar is two rows (controls on top; last roll + shooter on one line under them).
      Decision: the badge's count comes from one count query (the spec's "listen to the newest 1" gives presence, not a
      number). Decision: the Chat button stays in the top bar at 320×568 too (Roll moves to the dock there, so it fits).
      Tests (test/chat, `npm run test:chat`, 9): rooms, validation, disabled/no profile, rate (2 s, 20/min, across rooms,
      counter written only with a message), requestId once, admin delete (403 for a player via /api/admin), prune
      (24 h edge, 1,203 in batches, hourly gate, cron), settlement prunes, rules (test/chat/rulesEval.mjs: the emulator
      can't be downloaded here, so a small evaluator of our firestore.rules, checked against known answers for other
      collections: chat read signed-in only; create/update/delete refused for players, admin and signed-out; chatRate
      closed). Mutation-checked: no 2 s gap, 1,999 ms, 21 a minute, no per-minute cap, counter per room, server rate
      check off, room check off, extra room, sendChat skipping the room check — each fails. phase7's fake gained
      subcollections/range filters/batch delete (settlement now walks the chat); casino fakeFirestore gained range
      operators, chained where, orderBy, startAfter, aggregation, batch.
      interact.mjs: no-scroll check now also requires the Chat button on screen (all sizes; lowest control 521/607 at
      375×667); new: rooms + listener limits (1 / 30 / 1 / 0 after leaving, all five games), drawer content + badge +
      unread memory + auto-scroll both ways, send/Enter/counter/refusal/retry id/storage blocked, craps: open/close never
      leaves and the felt doesn't move, admin delete with confirm. Phone mock: nested paths, >=/>/< on timestamps,
      Timestamp, getCountFromServer, live listeners (emit / liveListeners). Phone-side mutations (closed listens to 30,
      listener never removed, always auto-scroll, seen never saved) each fail. Phone screens: chat-{slots, blackjack,
      baccarat, craps, crapless} closed and -open, craps watching open, admin open + confirm, typing 205, empty room.
- [x] 2 Admin → Wallet activity. server/admin/walletActivity.js = /api/admin `walletActivity` { uid, cursor? } (admin
      only via api/admin's requireAdmin; read only, nothing written). Entries: ledger uid == X and createdAt ≥ now −
      24 h, createdAt desc, 50 a page (+1 to know there's more), cursor = the last entry's id (its snapshot; must be the
      same player's). Summary (first page only) by aggregation (count + sum(amountCents)): 1 over the window (total,
      catches unknown types), 9 per non-casino type, 15 per casino type × game. shared/walletActivity.js: categories
      (Sportsbook = stake/payout/cashout; Casino = casino_* by game; Other = battle_*, shop, admin_*), Wagered = debit
      types, Won/returned = credit types, admin = signed, shown as its own column (net); `whereOf` ("Blackjack seat 3"
      from the note); `checkBalances`: oldest → newest, groups of identical createdAt (exact seconds.nanoseconds key)
      chained in whatever order fits; a link that doesn't add up → jump { expected, ledger says }, the walk then
      continues from what the ledger says; the window's first group is "start of 24 h" (or "load more to check" while
      pages remain); newest balance after vs the wallet now.
      Indexes (all collection `ledger`, scope Collection): ENTRIES uid Asc + createdAt Desc; BY_TYPE uid Asc + type Asc
      + createdAt Asc; BY_GAME uid Asc + type Asc + game Asc + createdAt Asc. A missing (or building) index is caught
      (FAILED_PRECONDITION "requires an index") and returned in `missingIndexes` with its fields and Firebase's link;
      whatever doesn't need it still loads.
      Screen: src/pages/admin/AdminWalletActivity.jsx, tab "Wallet activity" after "Shop purchases": player picker
      (users read once, as Shop purchases), Refresh, missing-index card with click-by-click steps, summary table
      (Sportsbook, Casino + each game, Other + Battles/Shop/Admin, Total; net green/red), balance check card (✓ or N
      jumps; wallet comparison), filters All/Sportsbook/Casino/Battles/Shop/Admin + Game, rows (time with seconds,
      Central, plus the day when not today; where; note; Wagered; Won; balance after; ✓ / start / load more / red
      jump), "Open bet ›" → Admin → Bets with that bet shown first (AdminBets `focusBetId`), Load more. ≤ 520 px: rows
      are cards. Filters only change what's shown; the check always covers everything loaded.
      Tests (test/activity, `npm run test:activity`, 9): window edge (24 h in, 24 h + 1 s out), other players excluded,
      pages 50/50/23 with no gaps, read only, bad cursor, admin only via /api/admin, summary math (incl. a type it
      doesn't know), good chain + wallet match, broken chain (expected vs ledger, flagged once, resumes), a same-
      transaction group in either order (and a wrong number in it), wallet mismatch, missing index (per-game and main),
      other errors still thrown. Mutation-checked: no transaction groups, group walked in ledger order only, never
      flags, window start as a jump, no wallet comparison, expected without the amount, resume from expected — each
      fails. interact.mjs "wallet activity" (pick, summary, seconds, Load more sends the cursor and finishes the
      chain, Casino → Blackjack filter, Open bet → Bets). Phone screens: admin-activity-pick, admin-activity,
      admin-activity-jump, admin-activity-missing-index, admin-activity-building, admin-activity-casino,
      admin-activity-open-bet.
- [x] 3 Checks: test:all (31 + 106 + 21 + 104 + 16 + 11 + 11 + 12 + 9 + 9 = 330), lint (scratch flat config), build,
      interact.mjs 22/22 (craps/crapless no-scroll with the Chat button at every size), dealcheck.mjs 6/6, phone check
      147 screens × 320/375/414 clean (Analytics loaded once on every screen, no console errors). Version 0.17.0.
      firestore.rules CHANGED (Will publishes); 3 new composite indexes on ledger (Will creates). No new /api function
      (still 7). Merged wip → main. Harness server stopped.

## Vercel Web Analytics on main (Will, 2026-10-20 15:07 CT, item 0 of the 0.17.0 message) — COMPLETE (2026-10-20), merged to main
- 0.16.0 was already merged (a178963, every CLAUDE.md check passed) before this message arrived, so item 0's "finish
  0.16.0" was done; PR #1 (`vercel/install-and-configure-vercel-w-rhdtqy`, 823bf95) was still unmerged, so it was
  merged into wip (clean): `@vercel/analytics` ^2.0.1 (package.json + lockfile, 2.0.1 installed with npm ci) and
  `<Analytics />` once in src/App.jsx after </Routes>, in a fragment. Every CLAUDE.md check re-run with it in place,
  then merged to main.
- Harness: dev mode loads https://va.vercel-scripts.com/v1/script.debug.js, which the offline harness can't reach (the
  live site loads /_vercel/insights/script.js from its own domain). `offlineRoute` (fixtures.mjs) now answers that one
  URL with a stub and still aborts every other outside request (shoot, interact, dealcheck). shoot.mjs now fails a
  screen on ANY console message or failed request mentioning Vercel/analytics (unfiltered), and unless the script
  loaded exactly once on the page.
- CLAUDE.md: the Analytics line under "Stack and limits" and the Production-from-main line under "Working with Will".
- [x] Checks with Analytics: test:all 312, lint, build, interact.mjs 16/16, dealcheck 6/6, phone check 125 screens ×
      320/375/414 clean (no console errors; Analytics script loaded exactly once on every screen). Merged wip → main.

## Phase 0.16.0 (Will, 2026-10-20 11:47 CT; full spec re-sent 11:48 and 14:30) — COMPLETE (2026-10-20), merged to main, ready for Will to test
Spec: Will's attachment of 2026-10-20 11:48 (the 11:47 message was cut off mid-sentence; the attachment is the whole
spec). One phase on a fresh wip off main (c3769b4); merge after every CLAUDE.md check; stop servers at the end.

### Checklist
- [x] 1 Shared rules. shared/casino/constants.js: `CHIP_VALUES = [1, 2, 5, 10, 25, 100]` (src/components/casino/
      Chips.jsx re-exports it); `isValidCasinoBet` replaced by `isChip` (chip check) and `isValidBetAmount` (whole
      dollars, ≥ $1, safe integer), `betCeilingProblem(cents)` / `betAmountProblem(dollars)`; `BET_CEILING_CENTS` =
      MAX_WALLET_CHANGE_CENTS ($1,000,000), `BET_CEILING_MESSAGE` "That bet is larger than the table allows.",
      `BET_HELP_TEXT` "Minimum $1. Bet as much as your wallet holds." Craps (shared/casino/dice.js): `spotLimitCents`
      is now Odds only (oddsMultiple × the line bet; null elsewhere); `limitProblem` = Odds rule + the ceiling on every
      spot; a fresh Come bet moving onto a number with a Come bet already there adds all of it (nothing given back).
      Battles: `battleProblems` = whole dollars ≥ $1, then the ceiling. Sportsbook (shared/betRules.js):
      `stakeCeilingProblem` for singles and the parlay stake; `payoutTooLarge` (payout must be a safe integer).
- [x] 2 Server. Every bet still goes through the same transaction as its debit, which refuses INSUFFICIENT_BALANCE
      (tableRunner `ctx.balance` / applyCasinoEntries, slots' own transaction, Battles, placeBets) — unchanged.
      server/casino/money.js: `requireBetAmount` (400 BAD_BET, or 400 BET_TOO_LARGE with the ceiling message),
      `requireUnderCeiling`, `requireChip` (400 BAD_CHIP). Blackjack `bet` and Baccarat `bet` (each spot) and Slots
      `spin`: amount check (a total built from chips). Craps `bets` (the phone's batches): each change whole dollars
      under the ceiling, the batch's charge under the ceiling, then limitProblem (Odds 2× → 409 SPOT_LIMIT, ceiling →
      400 BET_TOO_LARGE). Craps `bet` (documented as one chip, not used by the phone): chip check. Double / split /
      insurance unchanged: requireFunds before the charge (insurance ≤ half the bet is a game rule). placeBets refuses a
      payout that isn't a safe integer (a $1,000,000 ten-leg longshot parlay would be ~10^23 cents) before reading
      anything, with the ceiling message.
      Maximums removed (searched MAX, LIMIT, "up to $", "$1–$", digit caps):
        CASINO_MAX_BET_DOLLARS ($10: Blackjack seat, Baccarat spot, Slots; server + Blackjack/Baccarat/Slots pages);
        MAX_SPOT_CENTS (BaccaratPage); CRAPS_LIMITS line $20 / spot $30 / total $60 (diceVariants `limits`, dice.js
        limitProblem + the Come "at the $20 limit" give-back, craps meter "of $60 / Room"); BATTLE_STAKE_MAX_DOLLARS
        ($10,000, shared + NewBattlePage); the Battle stake input's `.slice(0, 5)` (a hidden $99,999 cap, now 10
        digits). Kept (not bet limits): MAX_LEGS, insurance ≤ half the bet, craps CHANGE_LIMIT (20 chip changes per
        request, a request-size guard; any amount per change), text lengths, page sizes, MAX_WALLET_CHANGE_CENTS (admin
        wallet change, now also the bet ceiling). The sportsbook had no maximum stake before; it gets only the ceiling.
- [x] 3 Phone. Six chips on every game and Slots (rack 6 across; $25 green, $100 black/gold; tokens shrink to fit
      at 320 px, buttons ≥ 44 px). Craps: chips in one row, Take down moved into the tools row ("On the felt $X" +
      Take down + Undo + Clear; in the 320×568 dock: chips row, then Take down + Roll). Validators keep the wallet
      check and add only the ceiling. Text: lobby, Blackjack, Baccarat, Craps help and rules, Slots, Battle stake →
      "Minimum $1. Bet as much as your wallet holds."; README; Odds "up to 2×" kept (rule). Slots shows big bets with
      separators ($1,250). interact.mjs: the no-scroll check now also asserts the six chips at every size; new check
      "no maximum bets" ($100 + $100 + $25 → one $225 bet on Blackjack, Baccarat Banker, Craps/Crapless Pass, Slots;
      six chips; no old limit text; help text present).
- [x] 4 Tests. Rewritten (they asserted the old maximums): casino1 slots amounts ($11 → $1,000,001 BET_TOO_LARGE,
      plus 2^53 and 1e300); casino2 Baccarat ($11 → ceiling); casino3 Blackjack ($11 → ceiling); casino4 craps
      ("limits" → chips and amounts: $21 Pass accepted, $11 / $0 / $2.50 refused as one chip, wallet; batch refusals
      now Odds-before-point and the ceiling; the Odds test's "$11 Place" → BAD_CHIP); casino5 (multi-seat Blackjack and
      Baccarat lose their $10 checks; "limit messages" → "the only craps caps left"; "every limit at the table" → "big
      craps bets": $500 Pass, $31 Field / Hard 4, $562 on the felt, $1,000 Odds behind $500, $50 Come moves whole).
      casino4/casino6 `bet` helpers send a chip amount through `bet` and any other amount through `bets` (as the phone).
      New test/casino/casino7.test.mjs (9): rules (chips, amount, ceiling, old names gone); Blackjack $500 accepted /
      refused with no wallet, ledger or table change; double and split refused at $499.99, double works with funds;
      Baccarat $500 Banker accepted / refused; craps and crapless $500 Pass + $1,000 Odds accepted / refused, Odds
      $1,001 refused; $25 / $100 chips, "$3 chip" BAD_CHIP vs $1 + $2 = $3 Pass and a $3 batch; craps ceiling per
      change and per spot (exactly $1,000,000 ok); Blackjack / Baccarat totals from big chips; Slots $250 spin accepted /
      refused, ceiling, $3 total ok. Battles: $50,000 Battle among three ($150,000 pot paid in full), short wallets
      refused with nothing taken, $1,000,000 ok / $1,000,001 refused. Sportsbook (test/props): $50,000 single accepted,
      a second refused for funds, $1,000,001 single and parlay refused before pricing, exactly $1,000,000 ok, slip
      mirror, payout guard.
      Mutation-checked (each fails a test): $10 cap back (6), no ceiling (7), ceiling $1 higher (7), Odds 2× dropped (6),
      $20 line limit back (5), chip check off (3), no $25/$100 chips (2), craps spot ceiling off (2), Come $20 give-back
      back (1), Battle ceiling off (1), Battle $10,000 back (1), sportsbook ceiling off (1), payout guard off (1), the
      phone's $10 Baccarat cap back (interact "no maximum bets"). Survived alone, by design: double without requireFunds,
      split without requireFunds (the transaction's final overdraft check in applyCasinoEntries still refuses with
      INSUFFICIENT_BALANCE and writes nothing) and the craps per-change ceiling (limitProblem's per-spot ceiling still
      refuses); with both layers removed each fails (3, 2 and 2 tests).
      CLAUDE.md: "$60 craps total" line removed; "No maximum bets anywhere…" and "Chips: $1, $2, $5, $10, $25 and $100
      on every game." added (there was no chips line before, so "update" = add).
- [x] 5 Checks (re-run in full at 14:30 after a session restart, on wip 50eb712): test:all (31 + 106 + 21 + 104 + 16 +
      11 + 11 + 12 = 312), lint (scratch flat config, as 0.15.0), build, interact.mjs 16/16 ("a refused chip…" now
      expects the wallet refusal: a $100 chip with $96.40 is refused at once with "Not enough in your wallet ($96.40)"
      and no request; the craps/crapless no-scroll check passes at 375×667, 390×844, 414×896, 1280×720, 1440×900 and
      the 320×568 dock with six chips), dealcheck.mjs 6/6, phone check 125 screens × 320/375/414 clean. Version 0.16.0;
      docs/CASINO_PROGRESS.md note. No firestore.rules change, no new index, no new /api function. Merged wip → main.
      Harness server stopped.

## Phase 0.15.0 (Will, 2026-10-20 10:22 CT) — COMPLETE (2026-10-20), merged to main, ready for Will to test
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
- [x] 4 Checks: test:all (31 + 97 + 21 + 104 + 15 + 11 + 11 + 11 = 301), lint (scratch flat config, see item 1),
      build, interact.mjs (15 checks incl. the props tab, the craps/crapless no-scroll checks and Sit down),
      dealcheck.mjs (6), phone check 125 screens × 320/375/414 clean. Version 0.15.0. Merged wip → main.
      No firestore.rules change, no new index, no new /api function (still 7). Harness server stopped.
      interact.mjs note: in one full run "three quick taps on Player" (Baccarat batching, untouched by this phase) saw 2
      requests instead of 1; it passed 5 runs in a row on its own and the next full run passed 15/15. Timing flake in
      this container (the 0.11.0 note describes the same check's timing sensitivity); not changed.
      Tonight's props: Kalshi couldn't be re-checked from this session (the shell can't reach Kalshi and the web
      request needed an approval that timed out). Kalshi had props this morning (0.14.0 check, ~09:45 CT) for NBA
      BOS@DET, PHI@NYK, OKC@SAS and NHL goals on tonight's 11 games; schedule re-confirmed from public listings.

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
Nothing queued: 0.17.2 is merged. 0.17.1 (Slots chat removal, clearer chat errors) was never started here; it needs its spec re-sent.

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
