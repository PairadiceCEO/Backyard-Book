# Phone check (developer tool, not deployed)

Runs the real app in Chromium at 320 / 375 / 414 px with Firebase mocked (`mocks/`) and `/api` answered
by fixtures, then reports sideways overflow, tap targets under 40 px and console errors
(`shoot.mjs`), and checks chip batching, refusal rollback, slots quick stop and the shooter's dice
(`interact.mjs`).

1. Copy the repo somewhere temporary, then put `mocks/` there as `harness-mocks/` and
   `vite.harness.config.mjs` at its root; `npm install`.
2. Start it: `VITE_FIREBASE_API_KEY=x VITE_FIREBASE_AUTH_DOMAIN=x VITE_FIREBASE_PROJECT_ID=x VITE_FIREBASE_APP_ID=x npx vite --config vite.harness.config.mjs` (port 5199).
3. Here: `npm install playwright`, then `node shoot.mjs ./shots` and `node interact.mjs`.
