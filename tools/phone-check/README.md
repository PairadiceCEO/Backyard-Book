# Phone check (developer tool, not deployed)

Runs the real app in Chromium at 320 / 375 / 414 px with Firebase mocked (`mocks/`) and `/api` answered
by fixtures, then reports sideways overflow, tap targets under 40 px and console errors
(`shoot.mjs`), and checks chip batching, refusal rollback, slots quick stop and the shooter's dice
(`interact.mjs`).

1. Copy the repo somewhere temporary, then put `mocks/` there as `harness-mocks/` and
   `vite.harness.config.mjs` at its root; `npm install`.
2. Start it: `VITE_FIREBASE_API_KEY=x VITE_FIREBASE_AUTH_DOMAIN=x VITE_FIREBASE_PROJECT_ID=x VITE_FIREBASE_APP_ID=x npx vite --config vite.harness.config.mjs` (port 5199).
3. Here: `npm install playwright`, then `node shoot.mjs ./shots` and `node interact.mjs`.
4. Table end-to-end (0.17.2): `node --experimental-test-module-mocks tablesim.mjs <repo root>` runs the real Blackjack
   and Baccarat engines behind two pages (one seated, one watching) with real timers, and checks that the next hand shows
   on both screens within ~1 s of the results countdown reaching 0. Options reproduce field conditions: `--work=600`
   (server time per request), `--lag=2500` (listener delay), `--tickfail=12` (ticks failing), `--skew=3000`,
   `--watch=30000` (keep watching a late screen), `--verbose` (timeline), `--game=blackjack`.
