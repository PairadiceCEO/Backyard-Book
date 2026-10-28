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
  - the full test suite: `npm run test:all` (rules, casino engines, cash out, sportsbook server, Battles,
    Challenges)
  - the production build (`npx vite build` with dummy `VITE_FIREBASE_*` env vars)
  - lint (`npx eslint src`)
  - the phone check at 320 / 375 / 414 px (`tools/phone-check/`: `shoot.mjs`, `interact.mjs`, `dealcheck.mjs`, and since 0.23.0
    `tapcheck.mjs`: 10 quick chip taps on every game must all count)
- If something blocks a phase: push to `wip`, record it in PROGRESS.md, tell Will. Never push unfinished
  work to `main`.
- When a phase is merged, mark it complete in PROGRESS.md and tell Will it's ready to test.

## Models
- Opus for anything that moves money, settles bets or adds a game.
- Sonnet for layout and small fixes.

## Stack and limits (everything on free tiers)
- React + Vite on Vercel Hobby: at most 12 serverless functions in `/api` (still 7 used since 0.21.0: admin, battles, bets,
  board, casino, settle, shop; the AI agent runner in `agents/` runs on GitHub Actions and only calls these; three agents since 0.23.1: claude-small (Haiku), claude-big (Sonnet), openai (GPT-6.1 Sol)), cron jobs at most daily
  (`/api/settle` runs once a day; players' visits trigger the rest).
- Firebase Auth + Firestore on the Spark plan (50k reads / 20k writes a day): keep reads and writes lean.
- Data: ESPN (scores, DraftKings lines), Kalshi (live prices, crypto markets) and Coinbase (crypto prices) public APIs.
  Crypto data is cached in function memory only (10 s), never in Firestore.
- `package-lock.json` is committed: Vercel installs exactly those versions. Change dependencies with `npm install`
  and commit the updated lockfile.
- Vercel Web Analytics: `@vercel/analytics` (package.json + package-lock.json) and `<Analytics />` from
  '@vercel/analytics/react', rendered once in src/App.jsx after <Routes>. Never remove, move or duplicate it; keep it
  when editing App.jsx or dependencies.

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
- `firestore.rules` is published by hand in the Firebase console: whenever it changes, the phase's test
  steps must tell Will to publish it.
- Firestore rules block clients from writing wallets, bets, ledger or results; all money moves through
  `/api` functions using the Admin SDK. `/api` verifies the Firebase ID token on every request; admin
  endpoints also check the admin role.
- Secrets (Firebase admin credentials, API keys) live only in Vercel environment variables and are used
  only inside `/api` functions. Never in frontend code.

## Deliberate decisions — do NOT "fix" these
- Hard ways pay 6:1 (Hard 4 and 10) and 8:1 (Hard 6 and 8).
- Craps/Crapless: no shooter clock with 1 player at the table; 30 s clocks with 2 or more.
- Crapless 2/12 Odds pay 5:1.
- Payouts round down to the cent.
- No maximum bets anywhere (sportsbook, casino, slots, Battles): minimum $1, the wallet balance is the only cap, plus a
  per-bet sanity ceiling: $10,000,000 for sportsbook bets and parlays (SPORTSBOOK_BET_CEILING_CENTS, 0.23.0), $1,000,000 for
  the casino, slots and Battles. Craps Odds stay capped at 2× the line bet (a game rule).
- Chips: $1, $2, $5, $10, $25, $100, $1,000 and $10,000 on every game (CHIP_VALUES).
- Craps/Crapless Place bets go up any time (0.23.0) but are OFF on a come-out roll (never won or lost by it).
- Side bets (0.24.0, shared/casino/sideBets.js, sources cited there): Blackjack 21+3 (100/40/30/10/5, settled right after the
  opening deal); Baccarat Dragon Bonus Player/Banker, Fortune 7 40:1, Heavenly 9 75/10, Golden 8 25:1, Blazing 7s 200/40 (Nevada
  GCB "Commission Free 5 Treasures Baccarat" paytable). A side bet needs a main bet on the seat; the main Banker bet still pays
  0.95:1. Don't change a paytable without a published source.
- Cash out: pre-game = stake × 0.90; live = potential payout × Kalshi bid(s) × 0.90; crypto = potential payout × Kalshi
  bid × 0.90 (no cash out in the last 60 s). Never on a bet containing a custom-game or Challenge leg; Battles have no
  cash out.
- Kalshi matching picks the closest date; settlement finds games by ESPN game id, never by team names.
- Kalshi matching: playoff games match by series game number; when unsure, no price.
- A line change returns LINE_CHANGED (the player must accept); a price change on the same line under 50 points is
  accepted automatically; 50+ points (−100 and +100 count as the same point) returns ODDS_CHANGED and the player
  confirms.
- Win rate = won ÷ (won + lost). Pushes, voids, cash outs and Battles don't count; Challenge bets do.
- A Challenge's poster may bet on it; that bet is tagged "Poster's bet".
- Player props: Kalshi only, pre-game only (close at game start), matched by the game's winner-event ticker suffix,
  scratched/non-binary results are void; props may be in same-game parlays; at most one leg per player per stat in a
  parlay (player = the ticker's player segment + the series).
- Crypto bets: singles only, betting closes 60 s before the market closes, settled by Kalshi's result (never our chart).
- AI agent house rules (users/{uid}.agent set; enforced in server/placeBet.js, nowhere else): pre-game only
  (AGENT_PREGAME_ONLY), no crypto (AGENT_NO_CRYPTO), no Challenge legs, Battles or Challenge posting (AGENT_NOT_ALLOWED), no
  cash out (AGENT_NO_CASHOUT), at most 5% of the balance per bet slip rounded down to the cent (a parlay counts once, each
  single counts once; AGENT_STAKE_CAP), at most 10 slips per Central calendar day counted in agentDaily inside the
  placement transaction (AGENT_DAILY_LIMIT). `why` is stored as agentWhy (chat-cleaned, cut to 280). Agents are normal
  players otherwise and bet only through /api with their own Firebase login.
- stats.stakedCents / returnedCents / settledBets / byLeague are kept for everyone by settlement, cash out and regrades
  (shared/perfStats.js); pushes and voids return the stake, a cash out returns its amount, Battles never count.

## Working with Will
- Will works in the browser only (no terminal). Claude pushes to GitHub.
- Vercel deploys Production only from main; every other branch is a Preview. Never ask Will to promote a Preview.
- After each phase, give step-by-step test instructions for the live site, using Will plus a test player
  in an incognito window.
- Commit messages end with the Co-Authored-By / Claude-Session lines the session provides.
