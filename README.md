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

## Cash out

Open bets on **My Bets** show a cash out value, refreshed every 30 seconds:

- **Before any game in the bet starts:** stake × 0.90.
- **Once a game has started:** potential payout × the Kalshi bid for every undecided leg × 0.90 (legs already won count as 1; pushed/voided legs drop out of the payout). DraftKings lines use the Kalshi market at the same line; with no exact match or no bid, it shows "Cash out unavailable right now".
- **Crypto bets:** potential payout × the fresh Kalshi bid for your side × 0.90 (no pre-game mode); not in the last 60 s, with no bid, a wide price, or once Kalshi has a result.
- No cash out once a leg has lost, or when every game is final (settlement pays it). Never on a bet with a custom-game or Challenge leg (singles or parlays, before or after the start); My Bets shows no cash out row on those. Battles have no cash out.
- Playoff games are matched to Kalshi by series game number (a postponed game keeps its own markets); when the match is unclear, the game gets no Kalshi price.

**Cash out $X** → confirm. The server re-prices with fresh ESPN and Kalshi data; if the value moved it shows the new amount to confirm again, and it never pays a different amount silently. A cashed-out bet moves to Finished as **Cashed out $X**, counts as neither won nor lost, writes a `cashout` ledger entry (once per bet), and is final: settlement skips it and **Admin → Bets** shows it (Status filter **Cashed out**) without regrade buttons.

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
- **Timers:** betting closes 15 s after the first bet (or at once when every seated player has bet); 15 s per hand, then it stands; results stay 2.5 s after the last card turns over (Baccarat too), then the next hand opens by itself.
- **Double taps:** Hit / Stand / Double / Split send the hand's index and its `actionSeq`; the server refuses a move only if that hand has already moved on, so another player's action in between never blocks you.
- **Hole card:** dealt into `casinoTables/blackjack/private/shoe` (`holeCard`); the public doc only has `holeDown: true` until the dealer turns it over.

## Casino phase 4: Craps and Crapless Craps

- No console step (same rules). Casino → **Craps** or **Crapless Craps**: 5 seats each, separate tables.
- **One engine, two games:** `shared/casino/dice.js` settles every roll; `shared/casino/diceVariants.js` is the only place the two games differ (come-out winners/losers, Don't Pass, point numbers, Odds and Place payouts). Crapless Odds on 2/12 pay 5:1.
- **Bets:** pick a chip, tap a spot; "Take down" + tap takes a bet back (Pass / Don't Pass stay up once a Point is set). Minimum $1. Bet as much as your wallet holds. Place bets go up any time (since 0.23.0) but are OFF on a come-out roll (the felt shows OFF; a come-out roll never wins or loses them), work once a Point is set and stay up after a win; Field is one roll.
- **Shooter:** only the shooter can roll, and only with a line bet. Roll carries `rollSeq`, so a double tap rolls once and other players' bets never block it. The clock starts at the first bet after a come-out roll, or right after each roll while a Point is on; at zero the server rolls (or, on a come-out with no line bet, passes the dice). Seven-out: dice to the next seat clockwise.
- **Leaving / gone 60 s:** Pass, Don't Pass and Odds play out; then the seat frees and its Place and Field bets are refunded.
- **Tests:** `npm test` (rules for every game) and `npm run test:casino` (all four table engines and the slot against an in-memory Firestore). Everything: `npm run test:all`. Build notes: `docs/CASINO_PROGRESS.md`.

## AI agents (0.21.0)

Three AI players (two Claude models and one OpenAI model) bet the sportsbook from their own accounts, once a day, to see if
any can beat the books or Will. They are normal players: same balance, odds, data and rules, and they bet only through the
site's `/api` with their own login, so they can't do anything a player can't.

- **House rules for AI players** (the server enforces them): pre-game only, no crypto, no Challenges, no Battles, no cash
  out, at most 5% of the balance per bet slip, at most 10 slips a day (Central time). Each bet carries the agent's one- or
  two-sentence reason, shown under the bet in Admin → Bets.
- **Leaderboard:** agents are listed with everyone, with an **AI** badge and their model under the name.
- **Admin → Agents:** each agent and you, best first by **Sportsbook profit** (returned − bet on settled sportsbook bets),
  with amount bet, ROI, settled bets, win rate, balance, and the per-league breakdown on tap. **Wallet change** (balance −
  starting balance − admin adjustments) is underneath in small text: it also counts casino, shop and Battles money, so it
  isn't comparable between players. **Rebuild stats** (dry run first) fills the new totals in
  from bets settled before 0.21.0.
- **The runner** (`agents/`, GitHub Actions `Agents` workflow, daily at 16:00 UTC, or **Run workflow** by hand): each agent
  signs in, reads the boards, alternate lines and props, may search the web (at most 5 searches), and places or passes. Same
  tools and instructions (`agents/prompt.md`) for every agent; only the model differs. Budgets per run (defaults): 25 model
  turns, 5 searches, 150k input + 20k output tokens; the prompt tells the agent the real numbers from the settings. The input
  budget is checked before every model turn, so a run ends instead of overshooting it. A busy provider (HTTP 503 / 429,
  "overloaded", "high demand") is retried once after 60 s; any other provider error (no credit, bad key) skips that agent's day.
  Tool results are compact (about 1-3k tokens for a league's board). The run summary
  (bets, passes, refusals, searches, tokens, estimated cost) is in the Actions log; no passwords, tokens or keys are printed.
  Setup: `agents/README.md`.
- Agents (GitHub variables, these are the defaults): **claude-small** (Haiku, `claude-haiku-5-5`), **claude-big** (Sonnet,
  `claude-sonnet-5-5`) and **openai** (GPT-6.1 Sol, `gpt-6.1-sol`: function calling and the web search tool, $2 in / $10 out per
  1M tokens). The Gemini agent was dropped in 0.23.1 (Google's paid tier needs a prepayment and the free tier ran out of quota).
- **Disabling an agent** (Admin → Players → Disable) removes it from the leaderboard and from Admin → Agents; its bets and history
  stay untouched. Enable puts it back.

## 0.25.0

- **Craps / Crapless: Place bets and Hard ways can work on the come-out.** On a come-out they're OFF by default (each of your
  boxes shows a black OFF puck). Tap **Bets OFF for come-out** to switch all of them ON (white pucks; the button then reads
  "Bets ON", or "Some ON" when mixed), or tap **Switch** and then one Place or Hard box to flip just that bet (taps never place
  chips in Switch mode; tap Switch again or roll to stop). Switched ON on a come-out: the number pays and stays up, a 7 loses
  them, a Hard way loses on the easy number. Every come-out (after a point is made, a seven-out or a new shooter) starts with
  them all OFF again. With a Point set they always work. Switching moves no money.
- Craps payouts now round down to the cent, like every other game (a $1 Place 6 pays $1.16, not $1.17).

## 0.24.0

- **Side bets.** Optional extra spots per seat, chips like the main bet (Undo, Rebet), each needs a main bet on that seat, no maximum
  beyond the $1,000,000 per-bet ceiling. Paytables and their sources: **Rules & side bets** on each table (`shared/casino/sideBets.js`).
  - **Blackjack 21+3** (a small circle beside the betting spot; a marker on every seat's circle): your first two cards and the dealer's
    up card. Suited three of a kind 100:1, straight flush 40:1, three of a kind 30:1, straight 10:1, flush 5:1 (A-2-3 and Q-K-A are
    straights, K-A-2 isn't). Settled the moment those cards are out, before insurance or play. House edge 4.62% with our 6 decks.
  - **Baccarat** (a row above Player / Banker / Tie): Dragon Bonus Player and Banker (natural win 1:1, natural tie push, non-natural
    win by 9 30:1 … by 4 1:1), Fortune 7 (Banker wins with a three-card 7, 40:1; the Banker bet itself still pays 0.95:1), Heavenly 9
    (both three-card 9s 75:1, either 10:1), Golden 8 (Player wins with a three-card 8, 25:1) and Blazing 7s (both three-card 7s 200:1,
    both two-card 7s 40:1). The last four are Nevada's approved "Commission Free 5 Treasures Baccarat" paytable.
- Tests compute every outcome from fixed shoes and the exact house edge of every bet (all match the published figures to 0.01
  points), plus a 1,000,000-round simulation each.

## 0.23.0

- **Craps / Crapless Place bets before the point:** they go up any time and can come down before any roll; on a come-out roll they are OFF (every Place box shows a black OFF puck) and are never won or lost by it; they work once a Point is set. Come bets are unchanged (a 7 loses every Come bet on a number; Come Odds are off on a come-out and come back; a fresh Come wins on 7).
- **Every chip tap counts:** quick taps on a bet spot no longer go missing. Two causes fixed: iPhones took a second quick tap as a double-tap zoom (every control now has `touch-action: manipulation`), and at craps a roll landing in the middle of quick taps dropped the taps still waiting to be sent and ignored taps while the dice tumbled. `tools/phone-check/tapcheck.mjs` taps 10 × $5 on every game against the real engines.
- **$1,000 (yellow-orange) and $10,000 (purple) chips** on every game and Slots. Racks are two rows of four on phones.
- **Max bet** (Blackjack, Baccarat): a Max button next to Rebet asks "Bet your whole wallet, $X?" and puts it on the seat (Baccarat: the spot you tapped last, Player at first), through the normal chips (Undo works). One bet still stops at $1,000,000.
- **Sportsbook per-bet limit $10,000,000** for singles and parlays ("That bet is over the sportsbook limit of $10,000,000 per bet."). The casino, Slots and Battles keep $1,000,000.
- **Blackjack seats show their cards:** every seat circle on the felt, yours and everyone else's, shows that seat's cards as small cards with a total pill; a split's hands sit side by side. The dealer's hole card stays face down until it's turned.

## 0.22.0

AI agents now research each slate like a serious bettor and bet a few times a day instead of passing. New agent tools (read from
ESPN's public data, nothing stored): matchup (last 10 games, records, scoring for and against, rest days, head-to-head, injuries,
probable pitchers, weather, DraftKings line movement), team stats, player trends (last-10 game log against a prop line) and your own
settled bets of the last 14 days. The prompt is a daily routine (shortlist, research, estimate, bet at an edge of 2+ points,
quarter-Kelly stakes of 0.5-3%). Research stops at 75% of the token budget so a run always ends having decided. Public betting
splits are not scraped (the sources' terms don't allow it); agents use web search for them. The site and the house rules are
unchanged; one Firestore index is needed for the history tool (see PROGRESS.md).

## 0.21.3

AI agent runs: Anthropic prompt caching (the conversation that is re-sent every turn is read from the cache at a tenth of the
price, so the token budget goes much further and a run costs less) and a turn-by-turn trace in the run summary (input, cache
reads, output and each tool result's size). Agents only; the site is unchanged.

## 0.21.2

Leaner AI agent runs: compact board / game / props results with no-vig fair probabilities worked out for the model, a token
check before every model turn, one retry when a provider is busy, the prompt shows the run's real search and turn limits, and
Admin → Agents ranks by sportsbook profit. Agents only: the site, the house rules and `/api` are unchanged.

## 0.20.0

- **Slots paytable:** the **Paytable** button opens a sheet with every winning line and what it pays for your current bet (read from the game's own paytable). It replaces the paytable card that was under the machine.
- **Wins you can see:** the winning symbols glow, a gold line is drawn through them and the win counts up from $0. A win of 10× your bet or more is a **Big win**: a big banner and a short shower of coins (at most 2.5 s; tap to skip).
- **Autospin:** **Auto** → 10, 25 or 50 spins, and stop on a win of at least: any win, 10× bet, or don't stop. It shows "Auto 3/10" and a big **Stop**; the bet is locked while it runs. Each spin is a normal spin, sent only after the last one has landed and shown its result. It also stops when the wallet can't cover the next spin, a spin fails, you leave the page or switch away from it.
- **Casino sounds:** chips, cards, dice, reels, a win chime and a big-win fanfare, all made in the browser (no sound files). One 🔊 button in the top bar of every casino page and the lobby turns them off or on for every game on that phone. Sound starts after your first tap (phones require it) and never plays in the background. Android phones also buzz briefly on a win.
- No server, payout or money change. No console step.

## 0.19.0

- **Blackjack on a real felt:** green felt in a wood rail, a half-moon table with the dealer and a small shoe at the top, "BLACKJACK PAYS 3 TO 2", "DEALER MUST HIT SOFT 17" and "INSURANCE PAYS 2 TO 1" printed in an arc, and the five seats as betting circles (yours gold, other players white, empty ones dashed with "Sit"). Each circle shows its chips and the player's name. Your seat's panel and buttons stay under the table. Tap one of your own circles to switch seats.
- **Baccarat on a printed table:** PLAYER and BANKER card boxes at the top (hand totals in pills), and three printed bet areas: PLAYER (pays 1 to 1, blue), BANKER (pays 0.95 to 1, 5% commission, red) and TIE (pays 8 to 1, green). Roads are unchanged below.
- **Cards come out of the shoe** and slide to their hand as they turn face up (no change to when they show). In Baccarat the third card shows face down when its wait begins, lifts a corner and turns over exactly when it is due (the "squeeze").
- **Totals and results:** a total pill beside every hand (and the dealer's), updated as each card turns. At results "+$15.00" (green) or "−$10.00" (red) floats up from each of your seats (Baccarat: each of your spots; "Push" for an even result), and chips slide to you from the dealer or to the dealer from you.
- **Rebet and Rebet ×2:** when betting opens, a seat that bet last hand shows "Rebet $X" and "Rebet ×2 $Y" next to the chips. One tap puts the same chips back (Baccarat: every spot) as one bet; they hide once a chip is down. Not enough in the wallet: the usual message, nothing placed. Last bets are remembered only until the page is reloaded.
- **One chip look everywhere:** the craps chips are now the chips in the rack, on every Blackjack seat and Baccarat spot, and in the Slots bet picker.
- **Reduced motion:** no slide, no peel, no chip slide; only the "+$" text. Look and client only: no rule, payout, timing or money change. No console step.

## 0.18.1

- **Slots** has no chat any more (it's a one-player game); chat stays in Blackjack, Baccarat, Craps and Crapless.
- **Chat that can't load** says why: the admin is told when the Firestore rules aren't published; nobody can send into a chat that isn't loading; **Try again** reloads it.
- **Phones that keep failing to move a table on** ask less often after 30 s (every 10 s, not 2 s) and not at all while the page is hidden.
- **Craps** shows the "You're offline" banner again. No console step.

## 0.18.0

- **Real craps felt, upright and sideways (Craps and Crapless):** the table is drawn like a casino layout in green felt with a wood rail: number boxes (payout on top, the ON puck, your chips), Come, Field, Don't Pass Bar and Don't Odds (Craps only), Pass Line with Odds ("up to 2×"), and Hardways with red dice. Every printed area is a button. Hold the phone upright for a stacked table with the chips docked at the bottom, or turn it sideways for the long table with a Pass Line strip down the left and a chip rail on the right (computers use the sideways table). Seats, last rolls, help and the rules are under the felt on tall phones, or in the **Table** button's sheet. Rotating keeps your seat, chips and chat. No rule, payout or money change. No console step.

## 0.17.2

- **Blackjack / Baccarat chips:** Clear, Undo and quick taps while a bet is on its way no longer bounce back or lower a bet.
- **Results** stay up 2.5 s, then the next hand opens by itself on every screen (phones keep asking until it does).

## 0.17.0

- **Casino chat:** every game (Slots, Blackjack, Baccarat, Craps, Crapless) has its own chat room behind a **Chat** button with an unread badge. Messages are plain text, up to 200 characters, kept 24 hours; at most one every 2 seconds and 20 a minute per player. The admin can delete any message ("Message removed"). New Firestore rules: publish `firestore.rules`.
- **Admin → Wallet activity:** pick a player to see every wallet change of the last 24 hours with the balance after each one, a summary (Sportsbook, Casino per game, Other), filters, and a check that every balance adds up and matches the wallet. Needs three composite indexes on `ledger` (the tab names any that are missing).
- **Vercel Web Analytics** is on (`<Analytics />` in App.jsx).

## 0.16.0

- **No maximum bets** on any game: Blackjack, Baccarat, Craps, Crapless, Slots, Battles and the sportsbook. Minimum $1, whole dollars; the wallet balance is the only cap. A single bet or stake over $1,000,000 is refused ("That bet is larger than the table allows."), a technical guard, not a game limit. Craps Odds stay at 2× the line bet.
- **$25 and $100 chips** on every casino game and Slots.
- The craps meter now reads "On the felt $X" (no table total and no "room left" any more).

## 0.15.0

- **Same-game parlays with props:** a prop can go in a parlay with other props and the moneyline, spread or total of the same game, and with other games. A parlay holds at most one pick per player per stat (the player is read from the Kalshi ticker, not the name); a second one is refused with "You already have a Derrick Henry Rush Yds pick in this parlay." Moneyline + spread from one game and crypto singles-only are unchanged.
- **Player props on the game page:** a **Player props** tab next to **Game lines**, under the score, before the game when Kalshi has props. Props load only when the tab is opened and the choice is remembered for the session; the tab disappears when the game starts. Old `/props` links open the game page on that tab.
- **Craps and Crapless without scrolling (replaced by the 0.18.0 felt):** a compact top bar (puck, dice, total, countdown, Roll or Sit down), then the chips, Take down, Undo / Clear and every betting spot on one screen (two columns on a computer); seats, last rolls and the rules sit below. On very short phones the chips, Take down and Roll stay in a bar at the bottom.

## 0.14.0

- **Crypto cash out:** open crypto bets show "Live cash out value" = potential payout × the fresh Kalshi bid for your side × 0.90, until 60 s before the market closes.
- **Crypto chart:** always the last 60 minutes, ending now; close times shown as text with countdowns above it.
- **Player props** (Kalshi, pre-game only): a game's page has two tabs under the score, **Game lines** (the alternate spread and total wheels) and **Player props** (shown before the game when Kalshi has props; loaded only when opened, remembered for the session); Player props has tabs per stat, one row per player with a line wheel over that player's thresholds and **50+** / **Under 50** buttons. Props close at the game's start and are settled by Kalshi's result (a player who doesn't play is a void). They can go in same-game parlays (with other props, the moneyline, spread or total) and with other games, but a parlay holds at most one pick per player per stat: a second Derrick Henry Rush Yds pick is refused with "You already have a Derrick Henry Rush Yds pick in this parlay."
- **Line wheel:** alternate spreads and totals (and each props player) are one swipeable row of lines; the middle line is selected and its two bets sit underneath. ‹ › and the arrow keys step one line.

## 0.13.0

- **Odds changes:** if a pick's price moved 50 points or more from what you saw (−100 and +100 count as the same point), nothing is placed and a popup shows "Old → New" with **Accept new odds** / **Remove pick(s)**. Smaller moves are accepted at the new price as before.
- **My Bets → Finished:** sorted by when each bet settled (newest first), with a sort menu, a **Filters** panel (result, date placed, category, bet type, market, live/pre-game, stake range, search, Poster's bets) and a summary line (bets, staked, returned, net, win rate). Covers every finished bet; sort and filters are remembered for the session.
- **Crypto chart:** touch and drag (or hover with a mouse) to read any minute's time and price.
- Live games price from their Kalshi markets again (the 0.11.0 freshness check is gone; playoff game-number matching stays).

## Crypto markets (0.12.0)

- **Crypto tab** on the Sportsbook (after the leagues, before Custom): one card per coin with the live Coinbase price, Kalshi's 15-minute **Up / Down** market (target, countdown) and the hourly **Above / Below** main strike (the strike whose YES price is nearest $0.50). Tap a card for the coin's page: big price, this hour's 1-minute chart (hand-built SVG) with the 15-min target and hourly strike drawn in and both close times marked, the Up/Down buttons and every hourly strike.
- Coins and series live in `shared/crypto/coins.js` (BTC, ETH, SOL, XRP, DOGE, BNB, HYPE with both kinds; NEAR and ZEC 15-minute only). Range/bracket and daily series are left out.
- Betting: singles only; priced at the Kalshi ask fetched fresh at bet time; closes 60 s before each market's close. Cash out (0.14.0): potential payout × the fresh Kalshi bid for your side × 0.90, any time from the market's open until 60 s before its close. Kalshi's own result settles the bet (voided → stake back) in the normal settlement runs.
- Crypto data is cached in function memory for 10 s and never written to Firestore.

## Challenges (batch C)

- **One-time step:** Firebase console → Firestore Database → **Rules** → replace everything with the updated `firestore.rules` → **Publish**. It adds `challenges` (readable by anyone signed in; nobody writes from a phone).
- **Post a Challenge** (Sportsbook → Custom → Challenges): a question, an optional description, 2–6 outcomes each with proposed American odds (+100 or more / −100 or less), and when betting closes (Central Time, 10 minutes to 60 days ahead). Everyone sees it at once as **Pending approval**; nobody can bet yet.
- **Admin → Challenges → Queue:** Approve as posted, **Edit** the wording, outcomes, odds or close time and then approve (or save and keep it pending), or **Reject** with a note the poster sees. Once approved, betting opens.
- **Betting:** tap an outcome to add it to the slip, like any price: singles or parlays, one outcome per Challenge in a parlay. Odds are priced from the Challenge on the server and locked on the bet. Betting closes at the close time on the server clock. No cash out on Challenge bets.
- **Poster's bets:** the poster may bet on their own Challenge (same limits, odds and close time; only after approval). The server tags those bets **Poster's bet** (My Bets, the Challenge page, Admin → Challenges and Admin → Bets), and the Challenge page lists them for everyone.
- **Settling:** Admin → Challenges → **To settle** → Settle → pick the winning outcome → preview every wallet change → Confirm. Or **Void** (singles get their stake back, parlays drop the leg). Settlement then runs as normal; Challenge bets count toward win rate.
- **Admin edits are logged** (who, what, when) and shown on the event: every Challenge change, every custom-game change (shown on the game's page and in Admin → Custom games), and Battle payout changes. Open Challenges' odds and close time can change at any time; the wording is fixed once betting opens. Placed bets always keep their odds.
- **Tests:** `npm run test:challenges` (also in `npm run test:all`).

## Battles (batch B)

- **One-time step:** Firebase console → Firestore Database → **Rules** → replace everything with the updated `firestore.rules` → **Publish**. It adds `battles` (readable by the admin and by each Battle's own players; nobody writes from a phone).
- **Live tab** (first on the Sportsbook): every game in progress across the leagues, grouped by league. League and Custom tabs list only games that haven't finished (a finished game's page still opens from My Bets).
- **Custom tab** on the Sportsbook (after the leagues): your Battles and the admin's custom games from every league (they moved off the league tabs). A red badge on the Sportsbook tab counts invites (and payout changes) waiting for you.
- **New Battle:** title, description, free-for-all (you + 1–7) or teams (2–4 teams of 2–4, 8 max, you assign everyone), a whole-dollar stake, and the payout by place (percentages adding up to exactly 100%, at most one place fewer than players/teams). Your stake is taken when you create it.
- **Joining:** each invited player accepts (stake taken, `battle_stake`) or declines (cancels it for everyone, `battle_refund`). It goes live when everyone has accepted; after 48 hours without that it's cancelled and refunded (checked whenever settlement runs or anyone opens it). The creator can cancel before it's live.
- **Result:** the creator gives every player (or team) a place; equal places tie and split the places they cover; a team's share is split evenly. Pays out at once (`battle_payout`), rounded down to the cent with leftover cents to the top winner. Anyone in it can **Dispute** within 48 hours.
- **Admin → Battles** (disputed first): change the result, change the payout, or void — each previewed with every wallet before → after (a wallet may go below $0, shown in red); only the differences move (`admin_regrade`). A payout change before it's live asks players who already accepted to keep their spot or withdraw (full refund).
- Battles appear in My Bets, never count toward win rate, and never appear in Shop purchases.

## Casino seats and craps (batch A)

- No console step. **Blackjack and Baccarat:** sit in as many open seats as you like (up to all 5). Each seat plays like a separate player: its own bet (Baccarat: its own Player / Banker / Tie bets), hands, insurance, double, split and 15 s turn, in normal seat order. Tabs under the seats switch between your seats and jump to the one that needs a decision. **Craps / Crapless:** one seat per player.
- **Leaving:** "Leave seat N" gives up one seat; "Leave all seats" gives up every one and you keep watching. Leaving the table page (lobby, another tab, another game) leaves all your seats there automatically. Bets in play play out first (Craps: line, Come and Odds keep working; Place, Field and Hard ways are refunded). Closing the browser is still the 60 s heartbeat rule.
- **Craps bets (0.16.0):** Minimum $1. Bet as much as your wallet holds, on any spot. Odds stay at most 2× their line bet (a game rule). The felt shows "On the felt $X".
- **New bets:** Hard 4/6/8/10 (4 and 10 pay 6:1, 6 and 8 pay 8:1; off on the come-out; win stays up). Come (opens with a Point; then sits on its number, where Odds can go behind it; Come Odds are off on the come-out). Don't Pass Odds (Craps only) pay the inverse of Pass Odds. Every number lives in `shared/casino/diceVariants.js`.

## Casino speed and chips (batch 5)

- **Region:** `vercel.json` runs every function (sportsbook too) in `cle1` (Cleveland), the Vercel region closest to Firestore `nam5` (Iowa + Oklahoma). Hobby allows one region.
- **Fewer round trips:** each casino action reads everything it's known to need in one `tx.getAll` (table, your profile + wallet, your presence, the shoe when it may deal, the bet's retry check), then commits: 2 round trips, 3 when a step pays other players (their wallets come in one batch). The profile is read once, inside the transaction (`disabled` checked there); the ID token is verified locally. The private shoe is only written when a card moved.
- **Timing:** every `/api/casino` reply has a `Server-Timing` header (auth, read, read-more, commit, total), visible in the browser's developer tools → Network → the request → Timing, and one JSON log line per call in Vercel → Logs. `test/casino/bench.mjs` replays the calls against an in-memory Firestore with a modeled delay.
- **Instant results:** replies carry the public table (never the shoe or the hole card) and your balance, so your own action shows before the live listener brings it back; the Roll reply carries the dice.
- **Chips:** $1 white, $2 yellow, $5 red, $10 blue, $25 green, $100 black on every game and on Slots. Pick a chip, tap a spot; each tap stacks a chip. Taps within 300 ms go as one request; a refused chip comes back off with the reason; the nav wallet counts chips on the felt right away. Undo takes back your last chip this round, Clear the rest. Blackjack bets are built from chips and locked in with "Deal me in".
- **Slots:** tap Spin again while the reels spin to stop them on the result at once (it never starts or charges another spin).
- **Card timing:** cards are dealt one at a time. Blackjack: seat 1 → 5 (empty or no-bet seats skipped), dealer, then the second card in the same order, 1 s apart; every later card (hits, doubles, split cards, the hole-card reveal, each dealer draw) 1.5 s. Baccarat: Player, Banker, Player, Banker 1 s apart, 1.5 s before each third card. Timed from the server's deal time so every phone shows the same card at the same moment; insurance, turn and results clocks start after the cards finish. All the numbers are in `shared/casino/timing.js`.
- **Craps Odds:** up to 2× your Pass bet; the Odds spot's description gives the current maximum.
- **Phone check tool:** `tools/phone-check/` (see its README).
