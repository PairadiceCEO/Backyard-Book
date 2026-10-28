// npm run test:agents — the agent runner (agents/) with mocked providers and a mocked /api: the tool loop, the
// LINE_CHANGED path (shown to the model, never auto-accepted), the turn / search / token caps, a provider error skipping
// cleanly, no secrets in the summary, and the three real adapters' request and response handling on a mocked fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;
const { runAgent, redactor, limitsFrom } = await import(url('agents/lib/runner.mjs'));
const { ProviderError, anthropicAdapter, openaiAdapter, geminiAdapter } = await import(url('agents/lib/providers.mjs'));
const { TOOL_DEFS } = await import(url('agents/lib/tools.mjs'));

const NOW = new Date('2026-10-27T15:00:00Z');
const SECRET = { password: 'hunter2-very-secret', anthropic: 'sk-ant-api03-SECRETKEYVALUE123', firebase: 'AIzaSyD-fakeFirebaseWebKey12345', idToken: 'eyJhbGciOiJSUzI1NiJ9.eyJ1aWQiOiJib3QiLCJ4IjoxfQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ' };
const ENV = {
  AGENT_CLAUDE_BIG_USERNAME: 'claude-big',
  AGENT_CLAUDE_BIG_PASSWORD: SECRET.password,
  ANTHROPIC_API_KEY: SECRET.anthropic,
  VITE_FIREBASE_API_KEY: SECRET.firebase,
  BB_SITE_URL: 'https://bb.example.app/',
};
const PRICES = { anthropic: { 'claude-sonnet-5-5': { input: 3, output: 15 }, _search_per_1000: 10 } };

const game = (id, startMs, extra = {}) => ({
  id, league: 'nfl', state: 'pre', startTime: new Date(startMs).toISOString(), bettingClosed: false,
  home: { shortName: 'Texans', name: 'Houston Texans' }, away: { shortName: 'Jaguars', name: 'Jacksonville Jaguars' },
  markets: {
    moneyline: { home: { american: -150, decimal: 1.6667, line: null, source: 'espn', ref: null }, away: { american: 130, decimal: 2.3, line: null, source: 'espn', ref: null } },
    spread: { home: { american: -110, decimal: 1.9091, line: -3.5, source: 'espn', ref: null }, away: { american: -110, decimal: 1.9091, line: 3.5, source: 'espn', ref: null } },
    total: { over: { american: -110, decimal: 1.9091, line: 44.5, source: 'kalshi', ref: { ticker: 'KXNFLTOTAL-26OCT27JAXHOU-44', side: 'yes' } }, under: null },
  },
  ...extra,
});

// A fake world: Firebase sign-in and our /api. `onPlace(body, n)` answers each place request.
function world({ onPlace } = {}) {
  const calls = [];
  const places = [];
  const fetchImpl = async (u, init = {}) => {
    const href = String(u);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ href, method: init.method ?? 'GET', headers: init.headers ?? {}, body });
    const reply = (status, json) => ({ ok: status < 300, status, json: async () => json, text: async () => JSON.stringify(json) });
    if (href.startsWith('https://identitytoolkit.googleapis.com/')) {
      assert.equal(body.email, 'claude-big@backyardbook.app');
      return body.password === SECRET.password ? reply(200, { idToken: SECRET.idToken }) : reply(400, { error: { message: 'INVALID_PASSWORD' } });
    }
    assert.equal(init.headers.authorization, `Bearer ${SECRET.idToken}`, 'every /api call carries the ID token');
    if (href.includes('/api/board?league=nfl') && !href.includes('game=')) {
      return reply(200, { league: 'nfl', games: [game('401', NOW.getTime() + 3 * 3600e3), game('402', NOW.getTime() + 5 * 60e3), game('403', NOW.getTime() - 3600e3, { state: 'in' })] });
    }
    if (href.includes('/api/board?league=')) return reply(200, { games: [] });
    if (href.endsWith('/api/bets') && body.action === 'mine') return reply(200, { ok: true, balanceCents: 10000, openBets: [], today: { slips: 0, limit: 10 } });
    if (href.endsWith('/api/bets')) {
      places.push(body);
      const [status, json] = onPlace ? onPlace(body, places.length) : [200, placed(body)];
      return reply(status, json);
    }
    return reply(404, { error: { code: 'NOT_FOUND', message: 'no route' } });
  };
  return { fetchImpl, calls, places };
}
const placed = (body) => ({
  ok: true,
  balanceCents: 10000 - body.legs.reduce((s, l) => s + (l.stakeCents ?? 0), 0) - (body.stakeCents ?? 0),
  bets: body.legs.map((l, i) => ({ id: `bot_${body.clientRequestId}_${i + 1}`, stakeCents: l.stakeCents, combinedAmerican: l.quotedAmerican, potentialPayoutCents: 2 * l.stakeCents, agentWhy: body.why, legs: [{ league: l.league, label: `pick ${l.legId}` }] })),
  priceChanges: [],
});

// A scripted model: each turn returns the next item (a function of the last tool results, or a value).
function scripted(steps, { usage = { input: 1000, output: 100 }, searchImpl } = {}) {
  const seen = [];
  let n = 0;
  return {
    seen,
    searches: [],
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    async turn(results, firstText) {
      seen.push(firstText ? { firstText } : { results });
      const step = steps[Math.min(n, steps.length - 1)];
      n += 1;
      const out = typeof step === 'function' ? step(results, n) : step;
      if (out instanceof Error) throw out;
      return { calls: [], text: '', usage, ...out };
    },
    async search(q) {
      this.searches.push(q);
      return searchImpl ? searchImpl(q) : { summary: `news for ${q}`, sources: ['https://news.example/a'], usage: { input: 50, output: 20 } };
    },
  };
}
const call = (name, args = {}, id = `c${Math.random().toString(36).slice(2, 8)}`) => ({ id, name, args });
const findPick = (results, gameId, market, side) => {
  const board = results.find((r) => r.name === 'get_board').output;
  const m = { moneyline: 'ml', spread: 'sp', total: 'tot' }[market];
  const k = { home: 'h', away: 'a', over: 'o', under: 'u' }[side];
  return board.games.find((g) => g.gameId === gameId)[m][k].p;
};

test('the tool loop: leagues → board (started and too-soon games left out) → a bet with its why → done', async () => {
  const w = world();
  const model = scripted([
    { calls: [call('get_leagues')] },
    (results) => {
      const nfl = results[0].output.leagues.find((l) => l.league === 'nfl');
      assert.equal(nfl.upcoming, 1, 'the game in 5 minutes and the game in progress are not offered');
      return { calls: [call('get_board', { league: 'nfl' })] };
    },
    (results) => {
      const board = results[0].output;
      assert.deepEqual(board.games.map((g) => g.gameId), ['401']);
      assert.deepEqual(board.games[0].ml.h, { p: board.games[0].ml.h.p, o: -150, f: 58 }, 'odds and the no-vig fair probability');
      return { calls: [call('place_bet', { mode: 'singles', legs: [{ pick: board.games[0].ml.h.p, stakeCents: 300 }], why: 'Texans ML: 64% vs 60% fair.' })] };
    },
    (results) => {
      assert.equal(results[0].output.placed.length, 1);
      return { text: 'One bet today: Texans ML.' };
    },
  ]);
  const { summary, text } = await runAgent({ agentId: 'claude-big', env: ENV, fetchImpl: w.fetchImpl, now: () => NOW, adapter: model, prompt: 'test prompt', prices: PRICES });
  assert.equal(summary.outcome, 'ran', summary.stopReason);
  assert.equal(w.places.length, 1);
  const sent = w.places[0];
  assert.equal(sent.mode, 'singles');
  assert.match(sent.clientRequestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...sent.legs[0], legId: undefined }, { legId: undefined, league: 'nfl', gameId: '401', marketType: 'moneyline', selection: 'home', line: null, quotedAmerican: -150, stakeCents: 300 });
  assert.equal(sent.why, 'Texans ML: 64% vs 60% fair.');
  assert.equal(summary.bets.length, 1);
  assert.match(text, /Bets placed: 1/);
  assert.match(text, /stake \$3\.00 · why: Texans ML: 64% vs 60% fair\./);
  assert.match(text, /Model turns: 4 of 25/);
  assert.match(text, /Estimated cost: \$0\.0180/, '4 turns × (1000 in × $3 + 100 out × $15) per 1M');
  assert.match(model.seen[0].firstText, /balance is \$100\.00, so at most \$5\.00 per slip/);
});

test('a Kalshi pick sends its exact market; a parlay sends one stake', async () => {
  const w = world();
  const model = scripted([
    { calls: [call('get_board', { league: 'nfl' })] },
    (results) => ({ calls: [call('place_bet', { mode: 'parlay', stakeCents: 200, legs: [{ pick: findPick(results, '401', 'total', 'over') }, { pick: findPick(results, '401', 'moneyline', 'away') }], why: 'Correlated.' })] }),
    { text: 'done' },
  ]);
  await runAgent({ agentId: 'claude-big', env: ENV, fetchImpl: w.fetchImpl, now: () => NOW, adapter: model, prompt: 'p', prices: PRICES });
  const sent = w.places[0];
  assert.equal(sent.stakeCents, 200);
  assert.equal(sent.legs[0].kalshiTicker, 'KXNFLTOTAL-26OCT27JAXHOU-44');
  assert.equal(sent.legs[0].kalshiSide, 'yes');
  assert.equal(sent.legs[0].line, 44.5);
  assert.equal(sent.legs.every((l) => l.stakeCents === undefined), true);
});

test('LINE_CHANGED: the new line goes back to the model, nothing is re-sent for it; its explicit re-submit uses the new price', async () => {
  const w = world({
    onPlace: (body, n) =>
      n === 1
        ? [409, { error: { code: 'LINE_CHANGED', message: 'A line moved. Accept the new line or remove the pick, then submit again.', lineChanges: [{ legId: body.legs[0].legId, oldLine: -3.5, newLine: -4.5, newAmerican: -105, quote: { american: -105, decimal: 1.9524, line: -4.5, source: 'espn' } }], closedLegs: [] } }]
        : [200, placed(body)],
  });
  let pick;
  const model = scripted([
    { calls: [call('get_board', { league: 'nfl' })] },
    (results) => {
      pick = findPick(results, '401', 'spread', 'home');
      return { calls: [call('place_bet', { mode: 'singles', legs: [{ pick, stakeCents: 400 }], why: 'Texans -3.5' })] };
    },
    (results) => {
      const r = results[0].output;
      assert.equal(r.notPlaced, true);
      assert.equal(r.code, 'LINE_CHANGED');
      assert.deepEqual(r.moved, [{ pick, was: { line: -3.5, odds: -110 }, now: { line: -4.5, odds: -105, impliedPct: 51.2 } }]);
      assert.equal(w.places.length, 1, 'not re-sent automatically');
      return { calls: [call('place_bet', { mode: 'singles', legs: [{ pick, stakeCents: 400 }], why: 'Still like Texans at -4.5' })] };
    },
    { text: 'done' },
  ]);
  const { summary } = await runAgent({ agentId: 'claude-big', env: ENV, fetchImpl: w.fetchImpl, now: () => NOW, adapter: model, prompt: 'p', prices: PRICES });
  assert.equal(w.places.length, 2);
  assert.equal(w.places[1].legs[0].line, -4.5);
  assert.equal(w.places[1].legs[0].quotedAmerican, -105);
  assert.notEqual(w.places[1].clientRequestId, w.places[0].clientRequestId);
  assert.equal(summary.refusals[0].code, 'LINE_CHANGED');
  assert.equal(summary.bets.length, 1);
});

test('house-rule refusals are shown to the model and logged', async () => {
  const w = world({ onPlace: () => [409, { error: { code: 'AGENT_STAKE_CAP', message: 'AI agents can stake at most 5% of the balance per slip: $5.00 now.' } }] });
  const model = scripted([
    { calls: [call('get_board', { league: 'nfl' })] },
    (results) => ({ calls: [call('place_bet', { mode: 'singles', legs: [{ pick: findPick(results, '401', 'moneyline', 'home'), stakeCents: 900 }], why: 'x' })] }),
    (results) => {
      assert.equal(results[0].output.code, 'AGENT_STAKE_CAP');
      return { calls: [call('place_bet', { mode: 'singles', legs: [{ pick: 'p999', stakeCents: 100 }], why: 'x' })] };
    },
    (results) => {
      assert.match(results[0].output.error, /Unknown pick/);
      return { text: 'passing' };
    },
  ]);
  const { summary, text } = await runAgent({ agentId: 'claude-big', env: ENV, fetchImpl: w.fetchImpl, now: () => NOW, adapter: model, prompt: 'p', prices: PRICES });
  assert.equal(w.places.length, 1, 'an unknown pick is never sent');
  assert.equal(summary.refusals.length, 1);
  assert.match(text, /Bets placed: none \(passed\)/);
  assert.match(text, /AGENT_STAKE_CAP/);
  assert.match(text, /Agent's note: passing/);
});

test('caps: 25 turns by default, 5 searches, and the token budget each stop the run and say why', async () => {
  assert.deepEqual(limitsFrom({}), { maxTurns: 25, maxSearches: 5, maxInput: 150000, maxOutput: 20000 });
  assert.deepEqual(limitsFrom({ AGENT_MAX_TURNS: '3', AGENT_MAX_INPUT_TOKENS: 'x' }).maxTurns, 3);

  let w = world();
  let model = scripted([{ calls: [call('get_my_bets')] }]);
  let r = await runAgent({ agentId: 'claude-big', env: { ...ENV, AGENT_MAX_TURNS: '3' }, fetchImpl: w.fetchImpl, now: () => NOW, adapter: model, prompt: 'p', prices: PRICES });
  assert.equal(r.summary.turns, 3);
  assert.match(r.summary.stopReason, /turn cap \(3\)/);

  w = world();
  model = scripted([{ calls: Array.from({ length: 7 }, (_, i) => call('web_search', { query: `q${i}` })) }, { text: 'done' }]);
  r = await runAgent({ agentId: 'claude-big', env: ENV, fetchImpl: w.fetchImpl, now: () => NOW, adapter: model, prompt: 'p', prices: PRICES });
  assert.equal(model.searches.length, 5, 'only 5 searches reach the provider');
  assert.equal(r.summary.searches, 5);
  assert.match(model.seen[1].results[6].output.error, /No searches left/);
  assert.match(r.text, /Searches: 5 of 5/);
  assert.equal(r.summary.usage.input, 2 * 1000 + 5 * 50, 'searches count toward the budget');

  w = world();
  model = scripted([{ calls: [call('get_my_bets')] }], { usage: { input: 80000, output: 500 } });
  r = await runAgent({ agentId: 'claude-big', env: ENV, fetchImpl: w.fetchImpl, now: () => NOW, adapter: model, prompt: 'p', prices: PRICES });
  assert.equal(r.summary.turns, 1, 'the second request would take the run past 150000, so it is not sent');
  assert.match(r.summary.stopReason, /token cap reached \(80000 in of 150000.*not sent/);

  w = world();
  model = scripted([{ calls: [call('get_my_bets')] }], { usage: { input: 100, output: 11000 } });
  r = await runAgent({ agentId: 'claude-big', env: { ...ENV, AGENT_MAX_OUTPUT_TOKENS: '20000' }, fetchImpl: w.fetchImpl, now: () => NOW, adapter: model, prompt: 'p', prices: PRICES });
  assert.equal(r.summary.turns, 2);
  assert.match(r.summary.stopReason, /22000 out of 20000/);
});

test('a provider error (no credit, quota, rate limit) skips the run cleanly, without retrying', async () => {
  for (const status of [400, 402, 429, 529]) {
    const w = world();
    let turns = 0;
    const model = scripted([() => {
      turns += 1;
      return new ProviderError('anthropic', status, { error: { message: 'Your credit balance is too low' } });
    }]);
    const r = await runAgent({ agentId: 'claude-big', env: ENV, fetchImpl: w.fetchImpl, now: () => NOW, adapter: model, prompt: 'p', prices: PRICES });
    assert.equal(r.summary.outcome, 'skipped', String(status));
    assert.equal(turns, 1, 'never retried');
    assert.match(r.text, /provider error, run skipped: anthropic API \d+/);
  }
  // Missing secrets: skipped before anything is called.
  const w = world();
  const r = await runAgent({ agentId: 'openai', env: { BB_SITE_URL: 'x' }, fetchImpl: w.fetchImpl, now: () => NOW, prices: PRICES });
  assert.equal(r.summary.outcome, 'skipped');
  assert.match(r.summary.stopReason, /missing secrets: AGENT_OPENAI_USERNAME, AGENT_OPENAI_PASSWORD, OPENAI_API_KEY, VITE_FIREBASE_API_KEY/);
  assert.equal(w.calls.length, 0);
  // A wrong password: skipped, the password never printed.
  const w2 = world();
  const r2 = await runAgent({ agentId: 'claude-big', env: { ...ENV, AGENT_CLAUDE_BIG_PASSWORD: 'wrong-password-123' }, fetchImpl: w2.fetchImpl, now: () => NOW, adapter: scripted([{ text: 'x' }]), prompt: 'p', prices: PRICES });
  assert.match(r2.text, /Sign-in failed \(400: INVALID_PASSWORD\)/);
  assert.doesNotMatch(r2.text, /wrong-password-123/);
});

test('no secrets in the summary, even when a message echoes one', () => {
  const redact = redactor([SECRET.password, SECRET.anthropic, SECRET.firebase]);
  const leaked = `failed with ${SECRET.password} key=${SECRET.anthropic} fb=${SECRET.firebase} Bearer ${SECRET.idToken} raw ${SECRET.idToken} sk-proj-abcdefghijklmnop`;
  const out = redact(leaked);
  for (const s of Object.values(SECRET)) assert.equal(out.includes(s), false, s.slice(0, 6));
  assert.equal(out.includes('sk-proj-abcdefghijklmnop'), false);
});

test('no secrets in a full run log, with a refusal that quotes the key and token', async () => {
  const w = world({ onPlace: () => [409, { error: { code: 'X', message: `odd error ${SECRET.anthropic} ${SECRET.idToken} ${SECRET.password}` } }] });
  const model = scripted([
    { calls: [call('get_board', { league: 'nfl' })] },
    (results) => ({ calls: [call('place_bet', { mode: 'singles', legs: [{ pick: findPick(results, '401', 'moneyline', 'home'), stakeCents: 100 }], why: `${SECRET.password}` })] }),
    { text: `my note ${SECRET.firebase}` },
  ]);
  const { text } = await runAgent({ agentId: 'claude-big', env: ENV, fetchImpl: w.fetchImpl, now: () => NOW, adapter: model, prompt: 'p', prices: PRICES });
  for (const s of Object.values(SECRET)) assert.equal(text.includes(s), false, `leaked ${s.slice(0, 6)}`);
  assert.match(text, /\*\*\*/);
});

// ---------- the real adapters on a mocked provider API ----------
function providerFetch(answers) {
  const sent = [];
  return {
    sent,
    fetchImpl: async (u, init) => {
      sent.push({ url: String(u), headers: init.headers, body: JSON.parse(init.body) });
      const [status, json] = answers[Math.min(sent.length - 1, answers.length - 1)];
      return { ok: status < 300, status, text: async () => JSON.stringify(json) };
    },
  };
}

test('anthropic adapter: tools, tool_use → calls, tool_result back; search = the web_search server tool (one use)', async () => {
  const p = providerFetch([
    [200, { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'tu_1', name: 'get_board', input: { league: 'nfl' } }], usage: { input_tokens: 1200, output_tokens: 40 } }],
    [200, { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', usage: { input_tokens: 1500, output_tokens: 10 } }],
    [200, { content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } }, { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://espn.example/x', title: 't' }] }, { type: 'text', text: 'QB is out.' }], usage: { input_tokens: 900, output_tokens: 60 } }],
  ]);
  const a = anthropicAdapter({ apiKey: 'k', model: 'claude-haiku-5-5', system: 'sys', tools: TOOL_DEFS, fetchImpl: p.fetchImpl });
  const t1 = await a.turn([], 'hi');
  assert.deepEqual(t1.calls, [{ id: 'tu_1', name: 'get_board', args: { league: 'nfl' } }]);
  assert.deepEqual(t1.usage, { input: 1200, output: 40, raw: 1200, cacheRead: 0, cacheWrite: 0 });
  assert.equal(p.sent[0].headers['x-api-key'], 'k');
  assert.equal(p.sent[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(p.sent[0].body.tools.find((t) => t.name === 'place_bet').input_schema.type, 'object');
  const t2 = await a.turn([{ id: 'tu_1', name: 'get_board', output: { games: [] } }]);
  assert.equal(t2.text, 'Done.');
  assert.deepEqual(p.sent[1].body.messages.at(-1), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"games":[]}', cache_control: { type: 'ephemeral' } }] });
  assert.equal(p.sent[1].body.messages[1].role, 'assistant');
  const s = await a.search('Texans injuries');
  assert.deepEqual(p.sent[2].body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }]);
  assert.equal(s.summary, 'QB is out.');
  assert.deepEqual(s.sources, ['https://espn.example/x']);
});

test('openai adapter: Responses API function calls, previous_response_id, function_call_output; search = web_search tool', async () => {
  const p = providerFetch([
    [200, { id: 'resp_1', output: [{ type: 'reasoning', id: 'rs_1' }, { type: 'function_call', call_id: 'call_1', name: 'get_leagues', arguments: '{}' }], usage: { input_tokens: 800, output_tokens: 30 } }],
    [200, { id: 'resp_2', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Pass today.' }] }], usage: { input_tokens: 900, output_tokens: 5 } }],
    [200, { id: 'resp_3', output: [{ type: 'web_search_call', id: 'ws_1', status: 'completed' }, { type: 'message', content: [{ type: 'output_text', text: 'Rain expected.', annotations: [{ type: 'url_citation', url: 'https://wx.example/a' }] }] }], usage: { input_tokens: 400, output_tokens: 50 } }],
  ]);
  const a = openaiAdapter({ apiKey: 'k', model: 'gpt-6-luna', system: 'sys', tools: TOOL_DEFS, fetchImpl: p.fetchImpl });
  const t1 = await a.turn([], 'hi');
  assert.deepEqual(t1.calls, [{ id: 'call_1', name: 'get_leagues', args: {} }]);
  assert.equal(p.sent[0].headers.authorization, 'Bearer k');
  assert.equal(p.sent[0].body.instructions, 'sys');
  assert.equal(p.sent[0].body.tools[0].type, 'function');
  const t2 = await a.turn([{ id: 'call_1', name: 'get_leagues', output: { leagues: [] } }]);
  assert.equal(p.sent[1].body.previous_response_id, 'resp_1');
  assert.deepEqual(p.sent[1].body.input, [{ type: 'function_call_output', call_id: 'call_1', output: '{"leagues":[]}' }]);
  assert.equal(t2.text, 'Pass today.');
  const s = await a.search('weather');
  assert.deepEqual(p.sent[2].body.tools, [{ type: 'web_search' }]);
  assert.equal(p.sent[2].body.previous_response_id, undefined, 'a search is its own request');
  assert.deepEqual(s.sources, ['https://wx.example/a']);
});

test('gemini adapter: functionCall parts (thought signatures sent back as received), functionResponse; free-tier search refused → unavailable, asked once', async () => {
  const p = providerFetch([
    [200, { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking', thought: true }, { functionCall: { id: 'fc1', name: 'get_board', args: { league: 'nfl' } }, thoughtSignature: 'SIG123' }] } }], usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 20, thoughtsTokenCount: 30 } }],
    [200, { candidates: [{ content: { role: 'model', parts: [{ text: 'No edge today.' }] } }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 8 } }],
    [400, { error: { code: 400, message: 'Grounding with Google Search is not available on the free tier.', status: 'FAILED_PRECONDITION' } }],
  ]);
  const a = geminiAdapter({ apiKey: 'gk', model: 'gemini-3.8-flash', system: 'sys', tools: TOOL_DEFS, fetchImpl: p.fetchImpl });
  const t1 = await a.turn([], 'hi');
  assert.equal(p.sent[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(p.sent[0].headers['x-goog-api-key'], 'gk');
  assert.ok(p.sent[0].body.tools[0].functionDeclarations.every((d) => !JSON.stringify(d).includes('additionalProperties')));
  assert.equal(t1.calls.length, 1);
  assert.deepEqual(t1.usage, { input: 700, output: 50 }, 'thinking tokens count as output');
  const c = t1.calls[0];
  await a.turn([{ id: c.id, providerId: c.providerId, name: c.name, output: { games: [] } }]);
  const sentContents = p.sent[1].body.contents;
  assert.equal(sentContents[1].parts[1].thoughtSignature, 'SIG123', 'the model turn is sent back as received');
  assert.deepEqual(sentContents[2], { role: 'user', parts: [{ functionResponse: { id: 'fc1', name: 'get_board', response: { result: { games: [] } } } }] });
  await assert.rejects(a.search('injuries'), (e) => e.unavailable === true && /free tier/.test(e.message));
  assert.deepEqual(p.sent[2].body.tools, [{ googleSearch: {} }]);
  await assert.rejects(a.search('again'), (e) => e.unavailable === true);
  assert.equal(p.sent.length, 3, 'not asked again after the free tier refused');
});

// 0.23.1: three agents; openai defaults to gpt-6.1-sol and has a price row; the workflow no longer mentions gemini.
test('three agents: openai defaults to gpt-6.1-sol with prices; no gemini in the runner or the workflow', async () => {
  const { AGENTS, estimateCost } = await import(url('agents/lib/runner.mjs'));
  const { readFileSync } = await import('node:fs');
  assert.deepEqual(Object.keys(AGENTS), ['claude-small', 'claude-big', 'openai']);
  assert.equal(AGENTS.openai.defaultModel, 'gpt-6.1-sol');
  const prices = JSON.parse(readFileSync(`${root}/agents/prices.json`, 'utf8'));
  assert.deepEqual(prices.openai['gpt-6.1-sol'], { input: 2, cached_input: 0.1, output: 10 });
  assert.equal(estimateCost(prices, 'openai', 'gpt-6.1-sol', { input: 1_000_000, output: 100_000 }, 0), 3);
  assert.doesNotMatch(readFileSync(`${root}/.github/workflows/agents.yml`, 'utf8'), /gemini/i);
});
