# Backyard Book

A play-money sportsbook for a few friends. React (Vite) on Vercel, Vercel Functions in `/api`, Firebase Auth and Firestore. No real money.

Everything is done in the browser: GitHub upload → Vercel deploy. Nothing needs to be installed on your PC.

## One-time setup (in this order)

### 1. Firebase console (console.firebase.google.com)

1. **Add project** → name it → turn Google Analytics off → **Create project**.
2. **Build → Authentication → Get started → Sign-in method → Email/Password** → turn on the first switch only → **Save**.
3. **Build → Firestore Database → Create database** → **Production mode** → a US location → **Create**.
4. **Firestore Database → Rules** → delete everything → paste the contents of `firestore.rules` → **Publish**.
5. **Firestore Database → Indexes → Composite → Create index**: collection `bets`, field `uid` Ascending, field `placedAt` Descending, scope Collection → **Create**.
6. **Project settings (gear) → General → Your apps → Web (`</>`)** → nickname → **Register app**. Copy `apiKey`, `authDomain`, `projectId`, `appId`.
7. **Project settings → Service accounts → Generate new private key**. Open the downloaded .json in Notepad; copy `project_id`, `client_email`, `private_key`. Never upload this file to GitHub.

### 2. First GitHub upload

Repository → **Add file → Upload files** → drag in everything inside the `backyard-book` folder (not the folder itself) → **Commit changes**.

### 3. Import into Vercel

vercel.com → **Add New… → Project** → import the repository → Framework Preset **Vite** → **Deploy**.

### 4. Environment variables

Vercel project → **Settings → Environment Variables**. Add each name from `.env.example`:

| Name | Value |
| --- | --- |
| `VITE_FIREBASE_API_KEY` | `apiKey` from step 1.6 |
| `VITE_FIREBASE_AUTH_DOMAIN` | `authDomain` |
| `VITE_FIREBASE_PROJECT_ID` | `projectId` |
| `VITE_FIREBASE_APP_ID` | `appId` |
| `FIREBASE_PROJECT_ID` | `project_id` from the .json |
| `FIREBASE_CLIENT_EMAIL` | `client_email` from the .json |
| `FIREBASE_PRIVATE_KEY` | the whole `private_key`, BEGIN line through END line (`\n` or real line breaks both work) |
| `SETUP_SECRET` | a long random phrase you invent |
| `CRON_SECRET` | another long random phrase |

### 5. Redeploy

**Deployments → latest → ⋯ → Redeploy.** Variables only apply to new deployments.

### 6. Create your admin account

Open `https://<your-site>.vercel.app/setup`, enter the setup secret, a username and a password. It signs you in and then locks itself.

## Updating to a new phase

Unzip the new phase, upload everything inside the `backyard-book` folder to GitHub the same way (files with the same path are replaced), commit, and Vercel redeploys on its own. If a phase lists a deleted file, delete it on GitHub (**⋯ → Delete file**).

## Settlement (Phase 7)

Bets settle by ESPN game id once ESPN marks the game final (custom games once the admin enters the final score). It runs:

- when a player opens the app or has My Bets open (at most once a minute across everyone),
- from **Admin → Settlement → Settle now**,
- once a day at 11:00 UTC (6 AM CDT / 5 AM CST) from the Vercel cron in `vercel.json`. Vercel sends `CRON_SECRET` with that call, so the variable must be set (step 4) — check under **Settings → Cron Jobs** that `/api/settle` is listed.

**Admin → Settlement → Preview settlement** shows what a run would do right now without changing anything. Bets with a leg still pending 72 hours after its game started appear under **Needs review**.

## Admin tools (Phase 8)

- **Admin → Custom games**: create a house game (league tab, teams, optional logo, start date/time in Central Time, any of moneyline / spread / total; blank markets aren't offered). Edit anything until it's final — a later start reopens betting, an earlier one closes it at once; placed bets keep their odds. **Final score** and **Cancel game** show every wallet change first, then settle the game's bets immediately. **Delete** only appears for games nobody bet on.
- **Admin → Bets**: every bet, filter by player and status. **Force win / Force lose / Void bet** on open or settled bets, or **Set leg…** to fix one leg and recompute the bet with the normal rules. Every regrade previews the wallet change and the player's W–L record before you confirm; only the difference from any earlier payout moves, with an `admin_regrade` ledger entry. **Needs review** lists open bets with a leg pending 72+ hours.
- **Admin → Settlement**: Preview settlement, and Settle now (confirms the wallet changes first).

## Phones and the home screen (Phase 9)

- On phones the tabs move to a bottom bar and the bet slip is a drawer above it (tap the green bar to open it).
- **iPhone (Safari):** Share → **Add to Home Screen**. **Android (Chrome):** ⋮ menu → **Add to Home screen** / **Install app**. It opens full-screen as "Backyard Book" with its own icon.
- Checking the daily settlement cron: Vercel project → **Settings → Cron Jobs** lists `/api/settle` at `0 11 * * *` (6 AM CDT / 5 AM CST); **Run** triggers it now, and **Logs** (filter by `/api/settle`) shows each run's result.

## Casino (casino phase 1: lobby + 7s slot)

- **One-time step:** Firebase console → Firestore Database → **Rules** → replace everything with the updated `firestore.rules` → **Publish**. It adds the casino tables (anyone signed in can watch; their shoe and presence docs are server-only).
- **Casino** tab → lobby with the 7s slot (open) and the four table games (opening in later casino phases).
- Every spin is one `/api/casino` call: the server debits the bet, picks the three reel stops with `crypto.randomInt`, and credits any win in one transaction, with `casino_bet` / `casino_payout` ledger entries. A retried spin (same request id) replays the same result and is charged once.
- The slot's return to player is exactly 29,493 / 32,768 = 90.0055%; `npm test` checks it by enumerating every stop combination.

## Casino phase 2: live tables + Baccarat

- No console step: the rules from casino phase 1 already cover the tables (`casinoTables/{game}` readable by signed-in players; `private/shoe` and `presence/{uid}` denied to every client).
- **Tables:** each table is one public doc, `casinoTables/{game}`, that every phone listens to. Sit / leave / heartbeat / tick and the game's own actions all go through `/api/casino`, one Firestore transaction each. The table doc is created the first time someone sits.
- **Timers:** a timed phase stores a `deadline` in server milliseconds. Phones count down against the server clock (from `serverNow` in every reply) and send `tick` 0–0.8 s after zero; the server applies the default only once its own clock has passed the deadline, so five phones ticking together apply it once.
- **Seats:** a seated phone sends a heartbeat every 20 s while visible (skipped if it made any casino call in the last 20 s); presence is written at most every 30 s. A seat with no heartbeat for 60 s is freed when the next round opens (or by a heartbeat on an idle table), never while its bets are in play. Leaving with bets on the table marks the seat "leaving"; the bets play out first.
- **Baccarat:** 8 decks (416 cards), reshuffled before a hand once 354 have been dealt. Betting has no timer until the first bet, then 15 s, or closes as soon as every seated player confirms. Player 1:1, Banker 0.95:1, Tie 8:1; a Tie pushes Player and Banker. Standard drawing rules (`bankerDraws` in `shared/casino/baccarat.js`); `npm test` checks the tableau and the exact 8-deck odds. The shoe lives only in `casinoTables/baccarat/private/shoe`; the public doc shows face-up cards and a count.
- **Scoreboard (roads):** the public doc keeps every winner of the current shoe in order (`shoeResults`, e.g. `"BPPTB"`), cleared when the shoe is reshuffled. `buildRoads()` in `shared/casino/baccaratRoads.js` turns it into the Bead Plate, Big Road (ties as slashes, dragon tails), Big Eye Boy, Small Road and Cockroach Pig grids; `npm test` checks Big Eye Boy against the Wizard of Odds worked example. The newest hand joins the roads once its last card is face up.

## Casino phase 3: Blackjack

- No console step (same rules as phase 1). Casino → **Blackjack**: 5 seats, sit / watch / leave like Baccarat.
- **Rules:** 6 decks (312), reshuffled before a hand once 281 are dealt; if the shoe runs dry mid-hand, a fresh shoe is built from every card not on the table. Blackjack pays 3:2; the dealer hits soft 17 and peeks with an Ace or 10 up; insurance (Ace up, 15 s) is $0 to half your bet and pays 2:1. One split per seat (two cards of the same value; split Aces get one card each); double on any first two cards, also after a split. A bust is collected at once; naturals are paid right after the peek.
- **Timers:** betting closes 15 s after the first bet (or at once when every seated player has bet); 15 s per hand, then it stands; results stay 5 s after the last card turns over.
- **Double taps:** Hit / Stand / Double / Split send the hand's index and its `actionSeq`; the server refuses a move only if that hand has already moved on, so another player's action in between never blocks you.
- **Hole card:** dealt into `casinoTables/blackjack/private/shoe` (`holeCard`); the public doc only has `holeDown: true` until the dealer turns it over.

## Casino phase 4: Craps and Crapless Craps

- No console step (same rules). Casino → **Craps** or **Crapless Craps**: 5 seats each, separate tables.
- **One engine, two games:** `shared/casino/dice.js` settles every roll; `shared/casino/diceVariants.js` is the only place the two games differ (come-out winners/losers, Don't Pass, point numbers, Odds and Place payouts). Crapless Odds on 2/12 pay 5:1.
- **Bets:** pick a chip, tap a spot; "Take down" + tap takes a bet back (Pass / Don't Pass stay up once a Point is set). $1–$10 a bet, up to $10 a spot. Place bets work only while a Point is on and stay up after a win; Field is one roll.
- **Shooter:** only the shooter can roll, and only with a line bet. Roll carries `rollSeq`, so a double tap rolls once and other players' bets never block it. The clock starts at the first bet after a come-out roll, or right after each roll while a Point is on; at zero the server rolls (or, on a come-out with no line bet, passes the dice). Seven-out: dice to the next seat clockwise.
- **Leaving / gone 60 s:** Pass, Don't Pass and Odds play out; then the seat frees and its Place and Field bets are refunded.
- **Tests:** `npm test` (rules for every game) and `npm run test:casino` (all four table engines and the slot against an in-memory Firestore). Build notes: `docs/CASINO_PROGRESS.md`.
