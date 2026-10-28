// One agent session (0.21.0): sign in → the model plays with the tools → a run summary. Budget per run, enforced here:
// at most AGENT_MAX_TURNS model turns (25), AGENT_MAX_SEARCHES searches (5), AGENT_MAX_INPUT_TOKENS (150k) and
// AGENT_MAX_OUTPUT_TOKENS (20k), summed over the run including searches. Hitting one stops the run and is logged. The input
// budget is checked before every model turn (0.21.2): when the next request would take the run over it, the run ends without
// sending it. A provider error (no credit, quota, bad key, outage) ends that agent's run cleanly; only a busy provider (503 /
// 429 / overloaded / rate limit) is retried, once, after 60 s (providers.mjs).
// 0.22.0: the research tools (agents/lib/research.mjs) count toward the same input budget. When 75% of it is used the tools answer
// researchClosed and the agent has to decide, so a run never ends on the cap without deciding (RESEARCH_SHARE).
// The summary never contains a password, token or key (redact() also scrubs every secret value it was given).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { usernameToEmail } from '../../shared/constants.js';
import { RESEARCH_TOOLS, createTools, estimateTokens, toolDefs } from './tools.mjs';
import { CACHE_READ_WEIGHT, CACHE_WRITE_WEIGHT, ProviderError, makeAdapter } from './providers.mjs';

export const RESEARCH_SHARE = 0.75;
const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// The four agents. Models come from GitHub variables, with these defaults.
export const AGENTS = {
  'claude-small': { provider: 'anthropic', secret: 'CLAUDE_SMALL', modelVar: 'AGENT_CLAUDE_SMALL_MODEL', defaultModel: 'claude-haiku-5-5', keyVar: 'ANTHROPIC_API_KEY' },
  'claude-big': { provider: 'anthropic', secret: 'CLAUDE_BIG', modelVar: 'AGENT_CLAUDE_BIG_MODEL', defaultModel: 'claude-sonnet-5-5', keyVar: 'ANTHROPIC_API_KEY' },
  openai: { provider: 'openai', secret: 'OPENAI', modelVar: 'AGENT_OPENAI_MODEL', defaultModel: 'gpt-6.1-sol', keyVar: 'OPENAI_API_KEY' },
};

export function limitsFrom(env) {
  const n = (name, d) => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : d;
  };
  return { maxTurns: n('AGENT_MAX_TURNS', 25), maxSearches: n('AGENT_MAX_SEARCHES', 5), maxInput: n('AGENT_MAX_INPUT_TOKENS', 150_000), maxOutput: n('AGENT_MAX_OUTPUT_TOKENS', 20_000) };
}

// The prompt with this run's real limits filled in ({{MAX_SEARCHES}}, {{MAX_TURNS}}), so it never disagrees with the settings.
export function renderPrompt(template, limits) {
  return String(template).replaceAll('{{MAX_SEARCHES}}', String(limits.maxSearches)).replaceAll('{{MAX_TURNS}}', String(limits.maxTurns));
}

// What the next model request will add to the run's input total: the conversation so far (the last request's size plus the reply
// it got) plus the new tool results, cautiously counted at 3.5 characters per token. When the last request used the prompt cache
// the re-sent conversation counts 0.1x and only the new text (the reply and the results) 1.25x, the same weights the budget uses.
export function nextTurnEstimate({ lastInput, lastRaw = lastInput, lastOutput, cached = false, results }) {
  const newText = (results ? Math.ceil(JSON.stringify(results).length / 3.5) : 0) + lastOutput;
  return cached ? Math.ceil(CACHE_READ_WEIGHT * lastRaw + CACHE_WRITE_WEIGHT * newText) : lastRaw + newText;
}

export function redactor(secrets) {
  const values = secrets.filter((s) => typeof s === 'string' && s.length >= 6).sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text);
    for (const v of values) out = out.split(v).join('***');
    // Anything that still looks like a bearer token, an API key or a JWT.
    return out
      .replace(/Bearer\s+[A-Za-z0-9._-]{12,}/g, 'Bearer ***')
      .replace(/\b(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,})\b/g, '***')
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '***');
  };
}

export async function signIn({ apiKey, username, password, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: usernameToEmail(username), password, returnSecureToken: true }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.idToken) throw new Error(`Sign-in failed (${res.status}${json.error?.message ? `: ${json.error.message}` : ''}).`);
  return json.idToken;
}

// Our own /api with the agent's ID token. Errors carry the server's code, message and details (lineChanges, …).
export function makeApi({ siteUrl, idToken, fetchImpl = fetch }) {
  const base = String(siteUrl).replace(/\/+$/, '');
  async function call(method, path, body) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${idToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json?.error?.message || `HTTP ${res.status}`);
      err.code = json?.error?.code ?? `HTTP_${res.status}`;
      err.status = res.status;
      err.details = json?.error ?? {};
      throw err;
    }
    return json;
  }
  return { get: (path) => call('GET', path), post: (path, body) => call('POST', path, body) };
}

export function estimateCost(prices, provider, model, usage, searches) {
  const table = prices?.[provider] ?? {};
  const row = table[model];
  const tokens = row ? (usage.input / 1e6) * row.input + (usage.output / 1e6) * row.output : null;
  const search = ((table._search_per_1000 ?? 0) * searches) / 1000;
  return tokens === null ? null : Math.round((tokens + search) * 10000) / 10000;
}

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

export function formatSummary(s) {
  const lines = [];
  lines.push(`## ${s.agentId} (${s.provider} · ${s.model})`);
  lines.push(`Result: ${s.outcome}${s.stopReason ? ` (${s.stopReason})` : ''}`);
  if (s.balanceCents !== null && s.balanceCents !== undefined) lines.push(`Balance: ${money(s.balanceCents)}`);
  if (s.bets.length) {
    lines.push(`Bets placed: ${s.bets.length}`);
    for (const b of s.bets) lines.push(`- [${b.league}] ${b.pick} @ ${b.odds > 0 ? '+' : ''}${b.odds} · stake ${money(b.stakeCents)} · why: ${b.why || '—'}`);
  } else {
    lines.push('Bets placed: none (passed)');
  }
  if (s.refusals.length) {
    lines.push(`Refusals: ${s.refusals.length}`);
    for (const r of s.refusals) lines.push(`- ${r.code}: ${r.message}`);
  }
  lines.push(`Searches: ${s.searches} of ${s.limits.maxSearches}${s.searchFailures ? ` (${s.searchFailures} unavailable or failed)` : ''}`);
  lines.push(`Model turns: ${s.turns} of ${s.limits.maxTurns}`);
  const researchCalls = s.trace.reduce((n, t) => n + t.tools.filter((x) => RESEARCH_TOOLS.includes(x.name)).length, 0);
  lines.push(`Research calls: ${researchCalls}${s.researchClosedAtTurn ? ` (research closed after turn ${s.researchClosedAtTurn}: 75% of the input budget was used, so the agent had to decide)` : ''}`);
  if (s.retries) lines.push(`Retries: ${s.retries} (provider was busy; waited 60 s and tried once more)`);
  lines.push(`Tokens: ${s.usage.input.toLocaleString('en-US')} in / ${s.usage.output.toLocaleString('en-US')} out${s.usage.cacheRead || s.usage.cacheWrite ? ` (input is billed-equivalent: ${s.usage.cacheRead.toLocaleString('en-US')} read from cache at 0.1x, ${s.usage.cacheWrite.toLocaleString('en-US')} written to cache at 1.25x)` : ''}`);
  if (s.trace.length) {
    lines.push('Turn by turn (input is what the budget counts; tool results are about chars / 4):');
    for (const t of s.trace) lines.push(`- Turn ${t.turn}: ${t.input.toLocaleString('en-US')} in${t.cacheRead ? ` (${t.cacheRead.toLocaleString('en-US')} read from cache)` : ''} · ${t.output.toLocaleString('en-US')} out${t.tools.length ? ` · ${t.tools.map((x) => `${x.name} ≈${x.tokens.toLocaleString('en-US')}`).join(', ')}` : ''}`);
  }
  lines.push(`Estimated cost: ${s.costUsd === null ? 'unknown (model not in agents/prices.json)' : `$${s.costUsd.toFixed(4)}`}`);
  if (s.finalText) lines.push(`Agent's note: ${s.finalText.replace(/\s+/g, ' ').slice(0, 600)}`);
  return lines.join('\n');
}

// Runs one session. Everything external is injectable for tests: fetchImpl (Firebase sign-in, our /api and the provider),
// now, adapter (a ready provider adapter), prompt, prices.
export async function runAgent({ agentId, env = process.env, fetchImpl = fetch, now = () => new Date(), adapter = null, prompt = null, prices = null, sleep, retryWaitMs, researchFetch, splitsSource = null }) {
  const cfg = AGENTS[agentId];
  if (!cfg) throw new Error(`Unknown agent "${agentId}". One of: ${Object.keys(AGENTS).join(', ')}.`);
  const limits = limitsFrom(env);
  const model = env[cfg.modelVar] || cfg.defaultModel;
  // AGENT_<ID>_USERNAME / _PASSWORD; the workflow passes the matrix agent's as AGENT_USERNAME / AGENT_PASSWORD.
  const username = env[`AGENT_${cfg.secret}_USERNAME`] || env.AGENT_USERNAME;
  const password = env[`AGENT_${cfg.secret}_PASSWORD`] || env.AGENT_PASSWORD;
  const apiKey = env[cfg.keyVar];
  const redact = redactor([password, apiKey, env.VITE_FIREBASE_API_KEY, env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY, env.GEMINI_API_KEY]);
  const summary = { agentId, provider: cfg.provider, model, outcome: 'skipped', stopReason: '', retries: 0, bets: [], refusals: [], searches: 0, searchFailures: 0, turns: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, trace: [], researchClosedAtTurn: 0, costUsd: 0, balanceCents: null, finalText: '', limits };
  const finish = () => {
    summary.costUsd = estimateCost(prices ?? JSON.parse(readFileSync(here('../prices.json'), 'utf8')), cfg.provider, model, summary.usage, summary.searches);
    return { summary, text: redact(formatSummary(summary)) };
  };

  const missing = [!username && `AGENT_${cfg.secret}_USERNAME`, !password && `AGENT_${cfg.secret}_PASSWORD`, !apiKey && cfg.keyVar, !env.BB_SITE_URL && 'BB_SITE_URL', !env.VITE_FIREBASE_API_KEY && 'VITE_FIREBASE_API_KEY'].filter(Boolean);
  if (missing.length && !adapter) {
    summary.stopReason = `missing secrets: ${missing.join(', ')}`;
    return finish();
  }

  let idToken;
  try {
    idToken = await signIn({ apiKey: env.VITE_FIREBASE_API_KEY, username, password, fetchImpl });
  } catch (err) {
    summary.stopReason = err.message;
    return finish();
  }
  const api = makeApi({ siteUrl: env.BB_SITE_URL, idToken, fetchImpl });
  const system = renderPrompt(prompt ?? readFileSync(here('../prompt.md'), 'utf8'), limits);
  const ai = adapter ?? makeAdapter(cfg.provider, { apiKey, model, system, tools: toolDefs(limits), fetchImpl, sleep, retryWaitMs });

  const addUsage = (u) => {
    summary.usage.input += Number(u?.input) || 0;
    summary.usage.output += Number(u?.output) || 0;
    summary.usage.cacheRead += Number(u?.cacheRead) || 0;
    summary.usage.cacheWrite += Number(u?.cacheWrite) || 0;
  };
  const overTokens = () => summary.usage.input >= limits.maxInput || summary.usage.output >= limits.maxOutput;
  const tools = createTools({
    api,
    now,
    limits,
    fetchImpl: researchFetch ?? fetchImpl,
    splitsSource,
    search: async (query) => {
      const r = await ai.search(query);
      addUsage(r.usage);
      return { summary: r.summary, sources: r.sources };
    },
  });

  let mine = null;
  try {
    mine = await api.post('/api/bets', { action: 'mine' });
    summary.balanceCents = mine.balanceCents;
  } catch (err) {
    summary.stopReason = `could not read the account: ${err.message}`;
    return finish();
  }
  const today = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(now());
  const opening = `Today is ${today} (Central time). Your balance is ${money(mine.balanceCents)}, so at most ${money(Math.floor(mine.balanceCents * 0.05))} per slip. You have ${mine.openBets.length} open bets and have placed ${mine.today.slips} of ${mine.today.limit ?? 10} slips today. Start with get_my_history, then get_leagues.`;

  summary.outcome = 'ran';
  let results = null;
  let last = { raw: 0, output: 0, cached: false }; // the previous request's own token counts (0 before the first turn)
  const capLine = () => `token cap reached (${summary.usage.input} in of ${limits.maxInput}, ${summary.usage.output} out of ${limits.maxOutput})`;
  try {
    while (true) {
      if (summary.turns >= limits.maxTurns) {
        summary.stopReason = `turn cap (${limits.maxTurns}) reached`;
        break;
      }
      if (overTokens()) {
        summary.stopReason = capLine();
        break;
      }
      // Before sending: would this request take the run's input total over its budget? Then end the run here.
      const next = results ? nextTurnEstimate({ lastRaw: last.raw, lastOutput: last.output, cached: last.cached, results }) : estimateTokens(`${system}\n${opening}`);
      if (summary.usage.input + next > limits.maxInput) {
        summary.stopReason = `${capLine()}; the next turn would add about ${next} and was not sent`;
        break;
      }
      const step = await ai.turn(results ?? [], results ? null : opening);
      summary.turns += 1;
      addUsage(step.usage);
      last = { raw: Number(step.usage?.raw ?? step.usage?.input) || 0, output: Number(step.usage?.output) || 0, cached: (Number(step.usage?.cacheRead) || 0) + (Number(step.usage?.cacheWrite) || 0) > 0 };
      const entry = { turn: summary.turns, input: Number(step.usage?.input) || 0, cacheRead: Number(step.usage?.cacheRead) || 0, output: last.output, tools: [] };
      summary.trace.push(entry);
      if (step.text) summary.finalText = step.text;
      if (!step.calls.length) break; // the model is done for the day
      results = [];
      // Research stays open until 75% of the input budget is used; after that the agent decides with what it has.
      const open = summary.usage.input < RESEARCH_SHARE * limits.maxInput;
      tools.setResearchOpen(open);
      if (!open && !summary.researchClosedAtTurn) summary.researchClosedAtTurn = summary.turns;
      for (const call of step.calls) {
        const output = await tools.run(call.name, call.args);
        entry.tools.push({ name: call.name, tokens: estimateTokens(output) });
        results.push({ id: call.id, providerId: call.providerId, name: call.name, output });
      }
      if (overTokens()) {
        summary.stopReason = capLine();
        break;
      }
    }
  } catch (err) {
    if (err instanceof ProviderError) {
      summary.outcome = 'skipped';
      summary.stopReason = `provider error, run skipped: ${err.message}`;
    } else {
      summary.outcome = 'failed';
      summary.stopReason = `runner error: ${err.message}`;
    }
  }
  summary.retries = Number(ai.retries) || 0;
  summary.bets = tools.log.bets;
  summary.refusals = tools.log.refusals;
  summary.searches = tools.log.searches;
  summary.searchFailures = tools.log.searchFailures;
  if (summary.bets.length) {
    try {
      summary.balanceCents = (await api.post('/api/bets', { action: 'mine' })).balanceCents;
    } catch {
      // keep the opening balance
    }
  }
  return finish();
}
