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
