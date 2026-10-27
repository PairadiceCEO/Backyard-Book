# Phone check (developer tool, not deployed)

Runs the real app in Chromium at 320 / 375 / 414 px with Firebase mocked (`mocks/`) and `/api` answered
by fixtures, then reports sideways overflow, tap targets under 40 px and console errors
(`shoot.mjs`), and checks chip batching, refusal rollback, slots quick stop and the shooter's dice
(`interact.mjs`).

Since 0.18.0 the craps and Crapless screens in `shoot.mjs` run at eight sizes (upright 320×568, 375×667, 414×896; sideways
568×320, 667×375, 844×390, 932×430; a computer 1280×800) and report page scroll, clipping and felt buttons under 44×44; the
felt behaviour checks (each area places a chip, rotating mid-bet, the Table sheet, Crapless) are in `interact.mjs`. The
fonts.googleapis.com stylesheet is answered with an empty one in `fixtures.mjs`.

Since 0.19.0 the Blackjack and Baccarat screens (`bj-*`, `bac-*`) run at 320×640, 375×800, 414×896, 844×390 (sideways) and
1280×800 (a computer), shot full page (scrolling is allowed) and checked for sideways overflow and small buttons. `interact.mjs`
covers Rebet / Rebet ×2 (totals, one request, a double tap, a tap while a batch is in flight, a wallet that can't cover it), the total
pills, the "+$" float and chip slide at results (and reduced motion), and the Baccarat squeeze finishing on its reveal time;
`dealcheck.mjs` also checks that cards slide from the shoe without changing when they show.

Since 0.20.0: Slots screens `slots-paytable`, `slots-auto-panel`, `slots-auto-running`, `slots-big-win` and the lobby with its sound
button; `interact.mjs` checks the paytable against PAYTABLE, every autospin stop rule (with a mocked spin that also checks no spin
is sent before the last one has landed), the win line / count-up / Big win, and the sound toggle persisting across reloads and games.
Pages log the sounds they ask for to `window.__soundLog` when the harness puts an array there.

1. Copy the repo somewhere temporary, then put `mocks/` there as `harness-mocks/` and
   `vite.harness.config.mjs` at its root; `npm install`.
2. Start it: `VITE_FIREBASE_API_KEY=x VITE_FIREBASE_AUTH_DOMAIN=x VITE_FIREBASE_PROJECT_ID=x VITE_FIREBASE_APP_ID=x npx vite --config vite.harness.config.mjs` (port 5199).
3. Here: `npm install playwright`, then `node shoot.mjs ./shots` and `node interact.mjs`.
4. Table end-to-end (0.17.2): `node --experimental-test-module-mocks tablesim.mjs <repo root>` runs the real Blackjack
   and Baccarat engines behind two pages (one seated, one watching) with real timers, and checks that the next hand shows
   on both screens within ~1 s of the results countdown reaching 0. Options reproduce field conditions: `--work=600`
   (server time per request), `--lag=2500` (listener delay), `--tickfail=12` (ticks failing), `--skew=3000`,
   `--watch=30000` (keep watching a late screen), `--verbose` (timeline), `--game=blackjack`.
