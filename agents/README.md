# AI agent players (0.21.0, leaner since 0.21.2, cached and traced since 0.21.3, researching since 0.22.0)

`node agents/run.mjs <claude-small | claude-big | openai>` plays one session for that agent and exits. It runs on
GitHub Actions (`.github/workflows/agents.yml`): daily at 16:00 UTC, or Actions → Agents → Run workflow. Nothing here is
deployed or bundled by Vite; it only calls the live site's `/api`, as that agent's player account.

- `prompt.md`: the instructions (since 0.22.0 a daily routine: get_my_history, 2-3 leagues, a shortlist of 6-10, research, estimate vs the
  no-vig fair probability, bet at an edge of 2+ points (3 for props and parlays), quarter-Kelly 0.5-3%, 2-6 bets on a normal day, `why`
  = estimated vs fair probability plus the strongest reasons), the same for every agent. `{{MAX_SEARCHES}}` and `{{MAX_TURNS}}` are filled in by the runner
  from the run's settings (`renderPrompt` in `lib/runner.mjs`), so the prompt never disagrees with them.
- `lib/tools.mjs`: the tools (get_leagues, get_board, get_game, get_props, get_my_bets, place_bet, web_search). Picks get short
  ids; place_bet builds the exact legs the app's bet slip sends. LINE_CHANGED / ODDS_CHANGED go back to the model with the new
  price; it must re-submit itself (never auto-accepted). Results are compact (0.21.2): short keys, no pretty-printing, no logos,
  colors, records, venue or alternate ids. Each side is `{ p pick id, o American odds, f no-vig fair %, l line, s "k" if Kalshi }`;
  the two sides of a market always add to 100.0. get_board lists at most 30 games (`more` says how many were left out) and drops
  games within 10 minutes of the start; get_game shows Kalshi's alternate rows with `d` = Kalshi fair % minus DraftKings' fair %
  at the same line; get_props has `y` / `n` per threshold; get_leagues counts upcoming games, games within 36 h and games with a
  Kalshi price. Sizes on the test fixtures (chars / 4): about 1,000-1,500 tokens for NFL, NBA, MLB and NHL boards.
  The board only shows one source per market (DraftKings, else Kalshi), so the Kalshi-vs-DraftKings gap is in get_game.
- Research (0.22.0, `lib/research.mjs`, exposed in `lib/tools.mjs`). Public ESPN data only, read from the runner (no Firestore, no
  /api, nothing stored); one in-memory cache per run; every result is compact JSON of at most about 1,500 tokens (chars / 4) and a
  failed, empty or malformed source gives a safe value (`{ available: false, error }`), never an exception. Times are Central.
  - `get_matchup(league, gameId)`: per side `a` (away) / `h` (home): `rec` season record, `hm` home, `rd` road, `l10` the last 10
    results (date, vs / @, opponent, W / L, score), `pf5 pa5 pf10 pa10` points (runs, goals) for / against per game over the last 5 / 10,
    `rest` days off (0 = back-to-back); `h2h` this season; `inj` injuries per side (out first, at most 6); `prob` probable pitchers
    (MLB) or goalies where ESPN lists them; `wx` weather (outdoor NFL / MLB / college football only); `ats` against-the-spread
    records when ESPN has them; `mv` DraftKings opening (`o`) vs current (`c`): `sp` home spread, `tot` total, `ml` moneylines;
    `sharp` flags (only with a splits source). Sources: team schedule, game summary, scoreboard event, core odds.
  - `get_team_stats(league, team)` (abbreviation or name): season and last-10 points for / against, league ranks `rk` (1 = best, from
    the standings), the last 10 game totals `tot10` and their average (to compare with a total line), and up to 6 ESPN offense and
    defense stats per side (per-game or percentage values first).
  - `get_player_trends(league, player, stat, line?)`: the player's last 10 games for the stat, newest first (date, vs / @, opponent,
    value), `avg10`, season `avg`, home / away averages `hAvg` / `aAvg` and, with `line`, `over` = "7/10 over 24.5". The player
    comes from the team that get_props showed him on (else the rosters are searched); names match ignoring case, punctuation and
    Jr. Stats match by ESPN's names ("points", "rebounds", "assists", "threes", "passing yards", "strikeouts", ...); made-attempted
    columns read the made number.
  - `get_betting_splits(league)`: **no source is read.** DK Network's terms forbid automated collection and VSiN's data is
    script-loaded, partly paywalled and its terms could not be read, so the tool answers `{ available: false, hint: "use web_search
    for public and sharp betting splits" }`. With a permitted `splitsSource(league)` injected (a function returning
    `{ games: [{ away, home, sp: {a, h}, tot: {o, u}, ml: {a, h} }] }` with `{ b: bets%, m: money% }` per side) it returns those splits
    plus `sharp` flags, and get_matchup carries the same flags: money% at least 15 points above bets% on a side, and reverse line
    movement (the line moves 0.5+ points, or 2+ implied points on the moneyline, against the side that has 55%+ of the bets).
  - `get_my_history()`: your settled bets of the last 14 days (at most 50 fetched, 25 shown newest first) with won / lost counts,
    staked and returned cents, from `/api/bets` action "mine" with `history: true` (needs the Firestore index bets: uid ascending,
    settledAt descending; without it the tool says history is not available yet).
  - The 75% rule: once the run's input total reaches 75% of AGENT_MAX_INPUT_TOKENS, the research tools and web_search answer
    `researchClosed` ("Decide now") and the agent has to place its bets or pass; the other tools keep working. The summary shows
    "Research calls: N" and when research closed; the turn trace lists each research tool's result size.
- Adapters (Anthropic requests use prompt caching since 0.21.3: cache breakpoints on the system prompt and on the last block of the
  conversation, so what is re-sent each turn is a cache read at 0.1x and only the new text is a cache write at 1.25x; usage is
  reported as billed-equivalent input tokens, which is what the budget and the cost estimate use): Anthropic Messages, OpenAI Responses, plain fetch (and a Gemini generateContent adapter, **unused since 0.23.1**: no agent runs it any more; the code and its tests stay). web_search is one request
  to the provider's own search (Anthropic web_search tool, OpenAI web_search tool).
- `lib/runner.mjs`: sign-in (Firebase Auth REST), the turn loop and the budget: 25 turns, 5 searches, 150k input + 20k
  output tokens per run (env AGENT_MAX_TURNS, AGENT_MAX_SEARCHES, AGENT_MAX_INPUT_TOKENS, AGENT_MAX_OUTPUT_TOKENS). The input
  budget is a total over the run (every request re-sends the conversation). Before each model turn the runner estimates the
  next request (the last request's input + its reply + the new tool results at 3.5 characters per token); if that would take the
  run over the budget, the run ends there with "token cap reached (… in of …); the next turn would add about N and was not sent".
- `lib/providers.mjs`: a busy provider (HTTP 503 or 429, or a body that says overloaded / high demand / rate limit) is retried
  once after 60 s; if it fails again the run is skipped. Nothing else is retried. The summary shows "Retries: 1".
- The run summary has a **Turn by turn** section (0.21.3): per turn the input tokens (and how many were read from the cache), the
  output tokens, and each tool called with the size of its result (about chars / 4), so the heavy result is visible.
- `prices.json`: the price table for the summary's estimated cost (edit it when prices change).

## Models (as of 2026-10-27)

| Agent | Variable | Default | Notes |
|---|---|---|---|
| claude-small | AGENT_CLAUDE_SMALL_MODEL | claude-haiku-5-5 | |
| claude-big | AGENT_CLAUDE_BIG_MODEL | claude-sonnet-5-5 | |
| openai | AGENT_OPENAI_MODEL | gpt-6.1-sol | GPT-6.1 Sol ($2.00 in / $0.10 cached in / $10.00 out per 1M tokens, developers.openai.com/api/docs/pricing, 2026-10-28). Its model page lists function calling and the web_search tool (Responses API) as supported and `reasoning.effort` low / medium / high / xhigh / max, so the adapter's `reasoning: { effort: 'low' }` stays. Web search $10 per 1,000 calls. |
| ~~gemini~~ | ~~AGENT_GEMINI_MODEL~~ | | Dropped in 0.23.1: Google's paid tier needs a $30 prepayment and the free tier ran out of quota mid-run. Not in the workflow or the runner; the adapter in `lib/providers.mjs` is unused. |

## Secrets (repo Settings → Secrets and variables → Actions)

AGENT_CLAUDE_SMALL_USERNAME / _PASSWORD, AGENT_CLAUDE_BIG_USERNAME / _PASSWORD, AGENT_OPENAI_USERNAME / _PASSWORD,
ANTHROPIC_API_KEY, OPENAI_API_KEY, BB_SITE_URL (the live site, e.g.
https://your-site.vercel.app) and VITE_FIREBASE_API_KEY (the same public web API key as in Vercel). Each job gets only its own
agent's login and its own provider's key. The logs are public (public repo) and never contain secrets.

Tests: `npm run test:agents` (test/agents/).
