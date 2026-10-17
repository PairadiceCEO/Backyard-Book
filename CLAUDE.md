# CLAUDE.md — standing rules for Backyard Book

Backyard Book is a play-money sportsbook and casino for a group of friends. Repo: PairadiceCEO/Backyard-Book.
Vercel deploys the live site from `main`.

## Start of every session
1. `git fetch`. If `wip` is ahead of `main`, check out `wip`.
2. Read this file, then `PROGRESS.md` (current phase, what's done, what's next, open questions,
   decisions). For casino work also read `docs/CASINO_PROGRESS.md`.
3. Continue exactly from PROGRESS.md "Next".

## Workflow
- Work on the `wip` branch, never directly on `main`. Commit often and push `wip` after every commit
  (Vercel only makes preview deployments from it).
- Keep `PROGRESS.md` current with every commit: current phase and task, what's done, what's in progress
  (with file names), what's next, open questions, decisions. A new session must be able to continue from it.
- Push to `main` once per phase, as one merge of `wip`, only after all of these pass:
  - the full test suite: `npm run test:all` (rules, casino engines, cash out) plus every other suite in `test/`
  - the production build (`npx vite build` with dummy `VITE_FIREBASE_*` env vars)
  - lint (`npx eslint src`)
  - the phone check at 320 / 375 / 414 px (`tools/phone-check/`: `shoot.mjs`, `interact.mjs`, `dealcheck.mjs`)
- If something blocks a phase: push to `wip`, record it in PROGRESS.md, tell Will. Never push unfinished
  work to `main`.
- When a phase is merged, mark it complete in PROGRESS.md and tell Will it's ready to test.

## Models
- Opus for anything that moves money, settles bets or adds a game.
- Sonnet for layout and small fixes.

## Stack and limits (everything on free tiers)
- React + Vite on Vercel Hobby: at most 12 serverless functions in `/api`, cron jobs at most daily
  (`/api/settle` runs once a day; players' visits trigger the rest).
- Firebase Auth + Firestore on the Spark plan (50k reads / 20k writes a day): keep reads and writes lean.
- Data: ESPN (scores, DraftKings lines) and Kalshi (live prices) public APIs.

## Code rules
- Deliver complete, runnable files. No placeholders like `// add logic here`.
- Check every React component for correct `useState` / `useEffect` use: no re-render loops, stable
  dependencies, no state set during render.
- The server is authoritative. Never trust a price, amount, result or flag sent from the browser;
  recompute it on the server.
- Money is integer cents.
- Every money change happens in one Firestore transaction with a deterministic ledger id (e.g.
  `stake_{betId}`, `payout_{betId}`, `cashout_{betId}`), written with `create()`, so a retry or
  double-tap can never pay twice.
- Firestore rules block clients from writing wallets, bets, ledger or results; all money moves through
  `/api` functions using the Admin SDK. `/api` verifies the Firebase ID token on every request; admin
  endpoints also check the admin role.
- Secrets (Firebase admin credentials, API keys) live only in Vercel environment variables and are used
  only inside `/api` functions. Never in frontend code.

## Deliberate decisions — do NOT "fix" these
- Hard ways pay 6:1 (Hard 4 and 10) and 8:1 (Hard 6 and 8).
- Crapless 2/12 Odds pay 5:1.
- The $60 craps table total includes Odds.
- Payouts round down to the cent.
- Cash out: pre-game = stake × 0.90; live = potential payout × Kalshi bid(s) × 0.90.
- Kalshi matching picks the closest date; settlement finds games by ESPN game id, never by team names.
- A line change returns LINE_CHANGED (the player must accept); a price change on the same line is
  accepted automatically.
- Win rate = won ÷ (won + lost). Pushes, voids, cash outs and Battles don't count; Challenge bets do.
- A Challenge's poster may bet on it; that bet is tagged "Poster's bet".

## Working with Will
- Will works in the browser only (no terminal). Claude pushes to GitHub.
- After each phase, give step-by-step test instructions for the live site, using Will plus a test player
  in an incognito window.
- Commit messages end with the Co-Authored-By / Claude-Session lines the session provides.
