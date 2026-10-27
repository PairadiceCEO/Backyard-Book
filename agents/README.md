# AI agent players (0.21.0)

`node agents/run.mjs <claude-small | claude-big | openai | gemini>` plays one session for that agent and exits. It runs on
GitHub Actions (`.github/workflows/agents.yml`): daily at 16:00 UTC, or Actions → Agents → Run workflow. Nothing here is
deployed or bundled by Vite; it only calls the live site's `/api`, as that agent's player account.

- `prompt.md`: the instructions, the same for every agent.
- `lib/tools.mjs`: the tools (get_leagues, get_board, get_game, get_props, get_my_bets, place_bet, web_search). Picks get short
  ids; place_bet builds the exact legs the app's bet slip sends. LINE_CHANGED / ODDS_CHANGED go back to the model with the new
  price; it must re-submit itself (never auto-accepted).
- `lib/providers.mjs`: Anthropic Messages, OpenAI Responses, Gemini generateContent, plain fetch. web_search is one request
  to the provider's own search (Anthropic web_search tool, OpenAI web_search tool, Gemini Google Search grounding).
- `lib/runner.mjs`: sign-in (Firebase Auth REST), the turn loop and the budget: 25 turns, 5 searches, 150k input + 20k
  output tokens per run (env AGENT_MAX_TURNS, AGENT_MAX_SEARCHES, AGENT_MAX_INPUT_TOKENS, AGENT_MAX_OUTPUT_TOKENS). A provider
  error skips the run; nothing is retried.
- `prices.json`: the price table for the summary's estimated cost (edit it when prices change).

## Models (as of 2026-10-27)

| Agent | Variable | Default | Notes |
|---|---|---|---|
| claude-small | AGENT_CLAUDE_SMALL_MODEL | claude-haiku-5-5 | |
| claude-big | AGENT_CLAUDE_BIG_MODEL | claude-sonnet-5-5 | |
| openai | AGENT_OPENAI_MODEL | gpt-6-luna | OpenAI's cheapest current text model ($0.10 in / $0.50 out per 1M tokens); Responses API, function calling and the web_search tool ($10 per 1,000 searches) |
| gemini | AGENT_GEMINI_MODEL | gemini-3.8-flash | On the free tier (limits are per project, see aistudio.google.com/rate-limit; roughly 10 requests a minute). Free-tier prompts may be used by Google to improve its products. Grounding with Google Search is **not available on the free tier**; with billing on, 5,000 searches a month are included, then $14 per 1,000. Without it this agent plays without web search (the summary says so). |

## Secrets (repo Settings → Secrets and variables → Actions)

AGENT_CLAUDE_SMALL_USERNAME / _PASSWORD, AGENT_CLAUDE_BIG_USERNAME / _PASSWORD, AGENT_OPENAI_USERNAME / _PASSWORD,
AGENT_GEMINI_USERNAME / _PASSWORD, ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, BB_SITE_URL (the live site, e.g.
https://your-site.vercel.app) and VITE_FIREBASE_API_KEY (the same public web API key as in Vercel). Each job gets only its own
agent's login and its own provider's key. The logs are public (public repo) and never contain secrets.

Tests: `npm run test:agents` (test/agents/).
