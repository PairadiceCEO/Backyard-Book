// npm run test:agents — 0.21.2: compact tool results (shape, no-vig math, size per league), the pre-turn budget stop, the busy-provider
// retry rules and the prompt showing the configured limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;
const { createTools, fairPair, estimateTokens, LEAGUES, toolDefs } = await import(url('agents/lib/tools.mjs'));
const { runAgent, renderPrompt, nextTurnEstimate } = await import(url('agents/lib/runner.mjs'));
const { anthropicAdapter, openaiAdapter, geminiAdapter, ProviderError } = await import(url('agents/lib/providers.mjs'));

const NOW = new Date('2026-10-27T15:00:00Z');
const LIMITS = { maxSearches: 3, maxTurns: 25 };

// ---- fixtures: a full-size board for each league, with the fields the real /api/board sends (logos, colors, records…) ----
const GAMES = { nfl: 14, nba: 10, mlb: 15, nhl: 10, ncaaf: 40 };
const NAMES = ['Jaguars', 'Texans', 'Packers', 'Lions', 'Chiefs', 'Bills', 'Ravens', 'Eagles', 'Cowboys', 'Giants', 'Jets', 'Patriots', 'Colts', 'Titans', 'Bengals', 'Browns', 'Steelers', 'Broncos', 'Raiders', 'Chargers', 'Saints', 'Falcons', 'Panthers', 'Buccaneers', 'Rams', 'Seahawks', '49ers', 'Cardinals', 'Bears', 'Vikings', 'Commanders', 'Dolphins'];
const team = (i) => ({ name: `City ${NAMES[i % NAMES.length]}`, shortName: NAMES[i % NAMES.length], abbr: NAMES[i % NAMES.length].slice(0, 3).toUpperCase(), logo: `https://a.espncdn.com/i/teamlogos/x/${i}.png`, color: '1a2b3c', record: '4-3', rank: null });
function fixtureBoard(league, n = GAMES[league]) {
  const games = Array.from({ length: n }, (_, i) => {
    const fav = -(110 + ((i * 37) % 280));
    const kal = i % 3 === 0;
    const q = (american, line, over) => ({ american, decimal: 1.9, line, source: kal && over !== undefined ? 'kalshi' : 'espn', ref: kal && over !== undefined ? { ticker: `KX${league}-G${i}-${over ? 'O' : 'U'}`, side: 'yes' } : null });
    return {
      id: `${league}${1000 + i}`, league, state: 'pre', bettingClosed: false, source: 'espn',
      startTime: new Date(NOW.getTime() + (60 + i * 25) * 60e3).toISOString(),
      venue: 'Big Stadium, Somewhere', broadcast: 'ESPN', oddsNote: 'DK',
      away: team(i * 2), home: team(i * 2 + 1),
      kalshi: i % 4 === 3 ? null : { gameEvent: `KX${i}`, spreadEvent: `KXS${i}`, totalEvent: `KXT${i}`, sideByCode: {} },
      markets: {
        moneyline: { home: q(fav, null), away: q(-fav - 20 > 0 ? -fav - 20 : 120 + i, null) },
        spread: { home: q(-110, -3.5), away: q(-110, 3.5) },
        total: { over: q(-112, 44.5, true), under: q(-108, 44.5, false) },
      },
    };
  });
  return { league, games };
}
const fakeApi = (boards) => ({ get: async (path) => (path.includes('game=') ? boards.detail : boards[new URL(`http://x${path}`).searchParams.get('league')]), post: async () => ({}) });

test('fairPair: both sides add up to exactly 100.0, and a pick-em stays 50 / 50', () => {
  for (const [a, b] of [[-150, 130], [-110, -110], [-400, 330], [250, -300], [105, -125], [-105, -105], [900, -1600]]) {
    const [x, y] = fairPair(a, b);
    assert.equal(Math.round((x + y) * 10) / 10, 100, `${a}/${b}`);
    assert.equal(x, Math.round(x * 10) / 10);
  }
  assert.deepEqual(fairPair(-110, -110), [50, 50]);
  assert.deepEqual(fairPair(-150, 130), [58, 42], '60.0% and 43.5% implied, margin removed');
  assert.deepEqual(fairPair(0, -110), [null, null]);
});

test('get_board is compact: only what a bettor needs, fair probabilities that add to 100, no art, no records, no venue', async () => {
  const tools = createTools({ api: fakeApi({ nfl: fixtureBoard('nfl') }), now: () => NOW, limits: LIMITS });
  const out = await tools.run('get_board', { league: 'nfl' });
  assert.equal(out.games.length, 14);
  const g = out.games[0];
  assert.deepEqual(Object.keys(g).filter((k) => !['ml', 'sp', 'tot', 'k'].includes(k)), ['gameId', 't', 'in', 'a', 'an', 'h', 'hn']);
  assert.match(g.t, /^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d+, \d+:\d\d (AM|PM) CT$|^[A-Z][a-z]{2} .*CT$/);
  assert.equal(g.in, 60);
  assert.equal(g.a, 'JAG');
  const json = JSON.stringify(out);
  for (const banned of ['logo', 'color', 'record', 'venue', 'broadcast', 'espncdn', 'City ', 'oddsNote', 'decimal']) assert.equal(json.includes(banned), false, `${banned} is left out`);
  assert.equal(json.includes('\n'), false, 'not pretty-printed');
  for (const game of out.games) {
    for (const [market, pair] of [['ml', ['h', 'a']], ['sp', ['h', 'a']], ['tot', ['o', 'u']]]) {
      const [x, y] = pair.map((k) => game[market][k]);
      assert.equal(Math.round((x.f + y.f) * 10) / 10, 100, `${game.gameId} ${market}`);
      assert.match(x.p, /^p\d+$/);
      assert.ok(Number.isInteger(x.o));
    }
    assert.equal(game.sp.h.l, -3.5);
    assert.equal(game.sp.a.l, 3.5);
    assert.equal(game.tot.o.l, 44.5);
    assert.equal('l' in game.tot.u, false, 'a total shares one line');
  }
  assert.equal(out.games[0].tot.o.s, 'k', 'a Kalshi price is marked');
  assert.equal(out.games[1].tot.o.s, undefined, 'DraftKings is the default');
  assert.equal(out.games[0].k, 1);
  assert.equal(out.games[3].k, undefined, 'no Kalshi mapping, no flag');
});

test('games within 10 minutes, started or finished are left out; a board over 30 games says how many more', async () => {
  const b = fixtureBoard('ncaaf');
  b.games[0].startTime = new Date(NOW.getTime() + 5 * 60e3).toISOString();
  b.games[1].state = 'in';
  b.games[2].state = 'post';
  const tools = createTools({ api: fakeApi({ ncaaf: b }), now: () => NOW, limits: LIMITS });
  const out = await tools.run('get_board', { league: 'ncaaf' });
  assert.equal(out.games.length, 30);
  assert.equal(out.more, 7);
  assert.equal(out.games.some((g) => ['ncaaf1000', 'ncaaf1001', 'ncaaf1002'].includes(g.gameId)), false);
});

test('get_leagues counts upcoming games and games with a Kalshi price', async () => {
  const boards = Object.fromEntries(LEAGUES.map((l) => [l, fixtureBoard(l, 4)]));
  boards.nhl = { games: [] };
  const tools = createTools({ api: fakeApi(boards), now: () => NOW, limits: LIMITS });
  const out = await tools.run('get_leagues', {});
  const nfl = out.leagues.find((l) => l.league === 'nfl');
  assert.deepEqual({ upcoming: nfl.upcoming, within36h: nfl.within36h, withKalshi: nfl.withKalshi }, { upcoming: 4, within36h: 4, withKalshi: 3 });
  assert.equal(out.leagues.some((l) => l.league === 'nhl'), false);
});

test('size: a typical league board is at most 3,000 tokens (chars / 4); numbers printed for PROGRESS', async () => {
  const boards = Object.fromEntries(LEAGUES.map((l) => [l, fixtureBoard(l)]));
  const tools = createTools({ api: fakeApi(boards), now: () => NOW, limits: LIMITS });
  const sizes = {};
  for (const league of LEAGUES) sizes[league] = estimateTokens(await tools.run('get_board', { league }));
  console.log(`# board tokens (chars/4): ${JSON.stringify(sizes)}`);
  for (const league of ['nfl', 'nba', 'mlb', 'nhl']) assert.ok(sizes[league] <= 3000, `${league} ${sizes[league]}`);
  assert.ok(sizes.ncaaf <= 6000, `ncaaf (30 of 40 games) ${sizes.ncaaf}`);
});

test('get_game: alternate rows with fair probabilities, and the gap to DraftKings at the same line', async () => {
  const g = fixtureBoard('nfl', 1).games[0];
  g.markets.spread = { home: { american: -110, line: -3.5, source: 'espn' }, away: { american: -110, line: 3.5, source: 'espn' } };
  g.markets.total = { over: { american: -110, line: 44.5, source: 'espn' }, under: { american: -110, line: 44.5, source: 'espn' } };
  const q = (american, line) => ({ american, line, source: 'kalshi', ref: { ticker: `T${american}${line}`, side: 'yes' } });
  const detail = {
    game: g,
    propsCount: 12,
    ladders: {
      spreads: { home: [q(-150, -4.5), q(-120, -3.5), q(130, -2.5)], away: [q(120, 4.5), q(100, 3.5)] },
      totals: [{ line: 43.5, over: q(-130, 43.5), under: q(110, 43.5) }, { line: 44.5, over: q(-105, 44.5), under: q(-105, 44.5) }, { line: 45.5, over: q(115, 45.5), under: null }],
    },
  };
  const tools = createTools({ api: fakeApi({ detail }), now: () => NOW, limits: LIMITS });
  const out = await tools.run('get_game', { league: 'nfl', gameId: g.id });
  assert.deepEqual(out.dk.sp.h, { l: -3.5, o: -110, f: 50 });
  assert.deepEqual(out.dk.tot, { l: 44.5, o: { o: -110, f: 50 }, u: { o: -110, f: 50 } });
  assert.equal(out.props, true);
  // Totals: the 44.5 row is compared with DraftKings; the others are not.
  const t = out.alt.tot;
  assert.deepEqual(t.map((r) => r.l), [43.5, 44.5, 45.5]);
  assert.equal(t[1].o.d, 0);
  assert.equal(t[0].o.d, undefined);
  assert.equal(Math.round((t[0].o.f + t[0].u.f) * 10) / 10, 100);
  assert.equal(t[2].u, null, 'a missing side stays out');
  assert.equal(t[2].o.f, undefined, 'no fair probability without both sides');
  // Spreads: home -3.5 pairs with away +3.5 (one Kalshi market) and is compared with DraftKings' 50.
  const h35 = out.alt.sp.h.find((r) => r.l === -3.5);
  const a35 = out.alt.sp.a.find((r) => r.l === 3.5);
  assert.equal(Math.round((h35.f + a35.f) * 10) / 10, 100);
  assert.equal(h35.d, Math.round((h35.f - 50) * 10) / 10);
  assert.equal(out.alt.sp.h.find((r) => r.l === -4.5).d, undefined);
  assert.match(h35.p, /^p\d+$/);
  assert.ok(estimateTokens(out) < 800);
});

test('get_props: players, thresholds, yes / no with fair probabilities', async () => {
  const g = fixtureBoard('nfl', 1).games[0];
  const side = (american) => ({ american, line: 1, source: 'kalshi' });
  const detail = {
    game: g,
    props: { open: true, tabs: [{ stat: 'Passing yards', series: 'KXNFLPASS', anytime: false, players: [{ name: 'C.J. Stroud', team: 'HOU', rows: [{ ticker: 'KXNFLPASS-A-250', threshold: 250, strike: 249.5, yes: side(-120), no: side(100) }, { ticker: 'KXNFLPASS-A-300', threshold: 300, strike: 299.5, yes: side(250), no: null }] }] }] },
  };
  const tools = createTools({ api: fakeApi({ detail }), now: () => NOW, limits: LIMITS });
  const out = await tools.run('get_props', { league: 'nfl', gameId: g.id });
  const row = out.props[0].players[0].r;
  assert.equal(out.props[0].players[0].n, 'C.J. Stroud');
  assert.equal(row[0].at, 250);
  assert.equal(Math.round((row[0].y.f + row[0].n.f) * 10) / 10, 100);
  assert.equal(row[1].n, undefined);
  assert.equal(row[1].y.f, undefined);
  assert.match(row[1].y.p, /^p\d+$/);
});

// ---- the pre-turn budget ----
const ENV = { AGENT_CLAUDE_BIG_USERNAME: 'claude-big', AGENT_CLAUDE_BIG_PASSWORD: 'hunter2-very-secret', ANTHROPIC_API_KEY: 'sk-ant-api03-SECRETKEYVALUE123', VITE_FIREBASE_API_KEY: 'AIzaSyD-fakeFirebaseWebKey12345', BB_SITE_URL: 'https://bb.example.app' };
function api(boards) {
  return async (u, init = {}) => {
    const href = String(u);
    const reply = (status, json) => ({ ok: status < 300, status, json: async () => json, text: async () => JSON.stringify(json) });
    if (href.startsWith('https://identitytoolkit.googleapis.com/')) return reply(200, { idToken: 'eyJhbGciOiJSUzI1NiJ9.eyJ1aWQiOiJib3QifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ' });
    if (href.endsWith('/api/bets')) return reply(200, { balanceCents: 10000, openBets: [], today: { slips: 0, limit: 10 } });
    const league = new URL(href).searchParams.get('league');
    return reply(200, boards[league] ?? { games: [] });
  };
}
const scriptedModel = (steps, usage) => {
  let n = 0;
  const seen = [];
  return { seen, provider: 'anthropic', model: 'claude-sonnet-5-5', async turn(results) { seen.push(results); const s = steps[Math.min(n++, steps.length - 1)]; return { calls: [], text: '', usage, ...s }; }, async search() { return { summary: '', sources: [], usage: { input: 0, output: 0 } }; } };
};
const PRICES = { anthropic: { 'claude-sonnet-5-5': { input: 3, output: 15 } } };

test('budget: a run ends before a request that would exceed AGENT_MAX_INPUT_TOKENS, instead of overshooting', async () => {
  const boards = { nfl: fixtureBoard('nfl'), nba: fixtureBoard('nba') };
  const call = (name, args) => ({ id: `c${Math.random()}`, name, args });
  // Turn 1 used 3,000 tokens; the board result adds roughly 2,500; the budget of 5,000 cannot take another 5,500-token request.
  const model = scriptedModel([{ calls: [call('get_board', { league: 'nfl' })] }, { calls: [call('get_board', { league: 'nba' })] }, { text: 'never reached' }], { input: 3000, output: 100 });
  const r = await runAgent({ agentId: 'claude-big', env: { ...ENV, AGENT_MAX_INPUT_TOKENS: '5000' }, fetchImpl: api(boards), now: () => NOW, adapter: model, prompt: 'p', prices: PRICES });
  assert.equal(r.summary.turns, 1, 'the second request was not sent');
  assert.equal(model.seen.length, 1);
  assert.equal(r.summary.usage.input, 3000, 'never over budget');
  assert.match(r.summary.stopReason, /^token cap reached \(3000 in of 5000, 100 out of 20000\); the next turn would add about \d+ and was not sent$/);
  assert.match(r.text, /Result: ran \(token cap reached/);

  // With room to spare the same run goes on.
  const roomy = scriptedModel([{ calls: [call('get_board', { league: 'nfl' })] }, { text: 'done' }], { input: 3000, output: 100 });
  const ok = await runAgent({ agentId: 'claude-big', env: { ...ENV, AGENT_MAX_INPUT_TOKENS: '40000' }, fetchImpl: api(boards), now: () => NOW, adapter: roomy, prompt: 'p', prices: PRICES });
  assert.equal(ok.summary.turns, 2);
  assert.equal(ok.summary.stopReason, '');
  // The estimate: last request + its reply + the new results.
  assert.equal(nextTurnEstimate({ lastInput: 1000, lastOutput: 200, results: null }), 1200);
  assert.ok(nextTurnEstimate({ lastInput: 1000, lastOutput: 200, results: [{ output: 'x'.repeat(3500) }] }) > 2200);
});

// ---- busy providers: one retry after 60 s ----
function replies(list) {
  const calls = [];
  const fetchImpl = async (u, init) => {
    calls.push(init);
    const [status, json] = list[Math.min(calls.length - 1, list.length - 1)];
    return { ok: status < 300, status, text: async () => JSON.stringify(json) };
  };
  return { fetchImpl, calls };
}
const OK = [200, { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, output_tokens: 2 } }];
const mk = (r, extra = {}) => {
  const sleeps = [];
  const ad = anthropicAdapter({ apiKey: 'k', model: 'm', system: 's', tools: toolDefs(LIMITS), fetchImpl: r.fetchImpl, sleep: async (ms) => sleeps.push(ms), ...extra });
  return { ad, sleeps };
};

test('retry: 503 then success runs after one 60 s wait', async () => {
  const r = replies([[503, { error: { message: 'This model is currently experiencing high demand' } }], OK]);
  const { ad, sleeps } = mk(r);
  const out = await ad.turn([], 'go');
  assert.equal(out.text, 'hi');
  assert.deepEqual(sleeps, [60000]);
  assert.equal(r.calls.length, 2);
  assert.equal(ad.retries, 1);
});

test('retry: 503 twice skips the run (one retry only)', async () => {
  const r = replies([[503, { error: { message: 'overloaded' } }]]);
  const { ad, sleeps } = mk(r);
  await assert.rejects(() => ad.turn([], 'go'), (e) => e instanceof ProviderError && e.status === 503 && e.kind === 'server');
  assert.equal(r.calls.length, 2);
  assert.deepEqual(sleeps, [60000]);

  // Through the runner: skipped, with the retry in the summary.
  const w = replies([[503, { error: { message: 'high demand' } }]]);
  const sleeps2 = [];
  const fetchImpl = async (u, init) => (String(u).startsWith('https://api.anthropic.com') ? w.fetchImpl(u, init) : api({})(u, init));
  const res = await runAgent({ agentId: 'claude-big', env: ENV, fetchImpl, now: () => NOW, prompt: 'p', prices: PRICES, sleep: async (ms) => sleeps2.push(ms) });
  assert.equal(res.summary.outcome, 'skipped');
  assert.match(res.summary.stopReason, /provider error, run skipped: anthropic API 503/);
  assert.deepEqual(sleeps2, [60000]);
  assert.match(res.text, /Retries: 1/);
});

test('retry: 429, and bodies that say overloaded / high demand / rate limit, are retried once', async () => {
  for (const first of [[429, { error: { message: 'slow down' } }], [529, { error: { type: 'overloaded_error', message: 'Overloaded' } }], [500, { error: { message: 'The model is currently experiencing high demand' } }], [400, { error: { message: 'Rate limit reached for requests' } }]]) {
    const r = replies([first, OK]);
    const { ad, sleeps } = mk(r);
    assert.equal((await ad.turn([], 'go')).text, 'hi', String(first[0]));
    assert.deepEqual(sleeps, [60000], String(first[0]));
  }
});

test('retry: a 400, 401, 402 or other plain error is never retried', async () => {
  for (const status of [400, 401, 402, 403, 404, 500]) {
    const r = replies([[status, { error: { message: 'Your credit balance is too low' } }], OK]);
    const { ad, sleeps } = mk(r);
    await assert.rejects(() => ad.turn([], 'go'), (e) => e instanceof ProviderError && e.status === status);
    assert.equal(r.calls.length, 1, String(status));
    assert.deepEqual(sleeps, []);
  }
});

test('retry: the same rules for OpenAI and Gemini', async () => {
  for (const [make, ok] of [
    [(r, s) => openaiAdapter({ apiKey: 'k', model: 'm', system: 's', tools: toolDefs(LIMITS), fetchImpl: r.fetchImpl, sleep: s }), [200, { id: 'r1', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }], usage: {} }]],
    [(r, s) => geminiAdapter({ apiKey: 'k', model: 'm', system: 's', tools: toolDefs(LIMITS), fetchImpl: r.fetchImpl, sleep: s }), [200, { candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }], usageMetadata: {} }]],
  ]) {
    let sleeps = [];
    const sleep = async (ms) => sleeps.push(ms);
    let r = replies([[503, { error: { message: 'busy' } }], ok]);
    assert.equal((await make(r, sleep).turn([], 'go')).text, 'hi');
    assert.deepEqual(sleeps, [60000]);
    sleeps = [];
    r = replies([[400, { error: { message: 'bad request' } }], ok]);
    await assert.rejects(() => make(r, sleep).turn([], 'go'), ProviderError);
    assert.equal(r.calls.length, 1);
    assert.deepEqual(sleeps, []);
  }
});

// ---- the prompt shows this run's limits ----
test('prompt: the real searches and turns from the settings, filled in by the runner', async () => {
  const template = readFileSync(`${root}/agents/prompt.md`, 'utf8');
  assert.match(template, /\{\{MAX_SEARCHES\}\}/);
  assert.doesNotMatch(template, /at most 5 searches/, 'nothing hard-coded');
  const text = renderPrompt(template, { maxSearches: 3, maxTurns: 12 });
  assert.match(text, /at most 3 searches in a session/);
  assert.match(text, /at most 12 model turns/);
  assert.doesNotMatch(text, /\{\{/);
  // End to end: the system prompt and the web_search tool the provider receives.
  let sent = null;
  const fetchImpl = async (u, init) => {
    if (String(u).startsWith('https://api.anthropic.com')) {
      sent = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: 'text', text: 'pass' }], usage: { input_tokens: 5, output_tokens: 1 } }) };
    }
    return api({})(u, init);
  };
  await runAgent({ agentId: 'claude-big', env: { ...ENV, AGENT_MAX_SEARCHES: '3', AGENT_MAX_TURNS: '12' }, fetchImpl, now: () => NOW, prices: PRICES });
  assert.match(sent.system[0].text, /at most 3 searches in a session/);
  assert.match(sent.system[0].text, /at most 12 model turns/);
  assert.match(sent.tools.find((t) => t.name === 'web_search').description, /At most 3 searches/);
  // Defaults when nothing is set: 5 searches, 25 turns.
  await runAgent({ agentId: 'claude-big', env: ENV, fetchImpl, now: () => NOW, prices: PRICES });
  assert.match(sent.system[0].text, /at most 5 searches in a session/);
  assert.match(sent.system[0].text, /at most 25 model turns/);
});

// ---- 0.21.3: Anthropic prompt caching and the per-turn trace ----
test('caching: two breakpoints at most (system and the last block), earlier turns carry none, usage is billed-equivalent', async () => {
  const { anthropicUsage } = await import(url('agents/lib/providers.mjs'));
  const bodies = [];
  const usages = [
    { input_tokens: 500, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0, output_tokens: 40 },
    { input_tokens: 300, cache_creation_input_tokens: 700, cache_read_input_tokens: 2000, output_tokens: 20 },
    { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 2700, output_tokens: 10 },
  ];
  const fetchImpl = async (u, init) => {
    bodies.push(JSON.parse(init.body));
    const n = bodies.length;
    return { ok: true, status: 200, text: async () => JSON.stringify({ content: n < 3 ? [{ type: 'tool_use', id: `t${n}`, name: 'get_leagues', input: {} }] : [{ type: 'text', text: 'done' }], usage: usages[n - 1] }) };
  };
  const ad = anthropicAdapter({ apiKey: 'k', model: 'm', system: 'sys', tools: toolDefs(LIMITS), fetchImpl });
  const t1 = await ad.turn([], 'opening');
  const t2 = await ad.turn([{ id: 't1', name: 'get_leagues', output: { a: 1 } }], null);
  await ad.turn([{ id: 't2', name: 'get_leagues', output: { b: 2 } }], null);
  const count = (b) => JSON.stringify(b).split('cache_control').length - 1;
  assert.deepEqual(bodies.map(count), [2, 2, 2], 'system + last block only, however long the conversation');
  assert.deepEqual(bodies[2].system, [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
  const lastBlock = (b) => b.messages.at(-1).content.at(-1);
  assert.deepEqual(lastBlock(bodies[0]), { type: 'text', text: 'opening', cache_control: { type: 'ephemeral' } });
  assert.equal(lastBlock(bodies[2]).type, 'tool_result');
  assert.equal(bodies[2].messages.slice(0, -1).some((m) => JSON.stringify(m).includes('cache_control')), false);
  assert.equal(bodies[2].messages.length, 5);
  // 500 + 2000 × 1.25 = 3000; 300 + 700 × 1.25 + 2000 × 0.1 = 1375.
  assert.deepEqual(t1.usage, { input: 3000, output: 40, raw: 2500, cacheRead: 0, cacheWrite: 2000 });
  assert.deepEqual(t2.usage, { input: 1375, output: 20, raw: 3000, cacheRead: 2000, cacheWrite: 700 });
  assert.deepEqual(anthropicUsage({ input_tokens: 10, output_tokens: 3 }), { input: 10, output: 3, raw: 10, cacheRead: 0, cacheWrite: 0 }, 'no cache fields, same as before');
});

test('caching: the pre-turn estimate counts a cached conversation at 0.1x and only new text at 1.25x', () => {
  const plain = nextTurnEstimate({ lastRaw: 20000, lastOutput: 500, cached: false, results: null });
  assert.equal(plain, 20500);
  const cached = nextTurnEstimate({ lastRaw: 20000, lastOutput: 500, cached: true, results: null });
  assert.equal(cached, Math.ceil(0.1 * 20000 + 1.25 * 500));
  assert.ok(cached < plain / 5);
});

test('caching: a run with a cache fits more turns under the same budget, and the summary shows the turn-by-turn trace', async () => {
  const boards = { nfl: fixtureBoard('nfl') };
  const call = (name, args) => ({ id: `c${Math.random()}`, name, args });
  // Each request sends 8,000 tokens of conversation, almost all read from the cache: 8000 × 0.1 + 200 × 1.25 = 1,050 billed.
  const usage = { input: 1050, raw: 8000, cacheRead: 7800, cacheWrite: 200, output: 50 };
  const steps = [{ calls: [call('get_leagues', {})] }, { calls: [call('get_board', { league: 'nfl' })] }, { calls: [call('get_leagues', {})] }, { calls: [call('get_leagues', {})] }, { calls: [call('get_leagues', {})] }, { text: 'Passing today.' }];
  const model = scriptedModel(steps, usage);
  const r = await runAgent({ agentId: 'claude-big', env: { ...ENV, AGENT_MAX_INPUT_TOKENS: '8000' }, fetchImpl: api(boards), now: () => NOW, adapter: model, prompt: 'p', prices: PRICES });
  assert.equal(r.summary.turns, 6, 'uncached, 8,000-token requests would have stopped the run after the first');
  assert.equal(r.summary.stopReason, '');
  assert.equal(r.summary.usage.input, 6 * 1050);
  assert.equal(r.summary.usage.cacheRead, 6 * 7800);
  assert.match(r.text, /Tokens: 6,300 in \/ 300 out \(input is billed-equivalent: 46,800 read from cache at 0\.1x, 1,200 written to cache at 1\.25x\)/);
  assert.match(r.text, /Turn by turn/);
  assert.match(r.text, /- Turn 1: 1,050 in \(7,800 read from cache\) · 50 out · get_leagues ≈\d/);
  assert.match(r.text, /- Turn 2: .* get_board ≈\d/);
  assert.match(r.text, /- Turn 6: 1,050 in .* · 50 out$/m, 'the last turn calls no tool');
  assert.equal(r.summary.trace.length, 6);
  assert.ok(r.summary.trace[1].tools[0].tokens > 500, 'the board result size is recorded');
});

test('no cache fields (OpenAI, Gemini, an uncached Anthropic reply): the trace shows turns without cache text', async () => {
  const boards = { nfl: fixtureBoard('nfl') };
  const model = scriptedModel([{ calls: [{ id: 'c1', name: 'get_board', args: { league: 'nfl' } }] }, { text: 'pass' }], { input: 2000, output: 80 });
  const r = await runAgent({ agentId: 'claude-big', env: ENV, fetchImpl: api(boards), now: () => NOW, adapter: model, prompt: 'p', prices: PRICES });
  assert.match(r.text, /Tokens: 4,000 in \/ 160 out$/m);
  assert.match(r.text, /- Turn 1: 2,000 in · 80 out · get_board ≈/);
  assert.doesNotMatch(r.text, /billed-equivalent|read from cache/);
});

// ---- 0.25.1: OpenAI cached input counts like Anthropic's (billed-equivalent), the factor from agents/prices.json ----
const REAL_PRICES = JSON.parse(readFileSync(`${root}/agents/prices.json`, 'utf8'));

test('openai cached input: the weight comes from prices.json (cached_input ÷ input), 1 when the model has no cached price', async () => {
  const { openaiCachedWeight, openaiUsage } = await import(url('agents/lib/providers.mjs'));
  assert.equal(openaiCachedWeight(REAL_PRICES, 'gpt-6.1-sol'), 0.05, '$0.10 cached ÷ $2.00 input');
  assert.equal(openaiCachedWeight({ openai: { m: { input: 4, cached_input: 1, output: 8 } } }, 'm'), 0.25, 'not hard-coded');
  assert.equal(openaiCachedWeight(REAL_PRICES, 'gpt-6-luna'), 1, 'no cached price: counted in full');
  assert.equal(openaiCachedWeight(REAL_PRICES, 'unknown-model'), 1);
  assert.equal(openaiCachedWeight(null, 'x'), 1);
  // 10,000 input tokens of which 9,000 cached: 1,000 + 9,000 × 0.05 = 1,450 billed-equivalent.
  assert.deepEqual(openaiUsage({ input_tokens: 10000, output_tokens: 70, input_tokens_details: { cached_tokens: 9000 } }, 0.05), { input: 1450, output: 70, raw: 10000, cacheRead: 9000, cacheWrite: 0 });
  assert.deepEqual(openaiUsage({ input_tokens: 500, output_tokens: 5 }, 0.05), { input: 500, output: 5, raw: 500, cacheRead: 0, cacheWrite: 0 }, 'no cached_tokens field: as before');
  assert.deepEqual(openaiUsage({ input_tokens: 100, input_tokens_details: { cached_tokens: 900 } }, 0.5).cacheRead, 100, 'never more cached than input');
  assert.deepEqual(openaiUsage(undefined, 0.05), { input: 0, output: 0, raw: 0, cacheRead: 0, cacheWrite: 0 });
});

test('openai adapter: turn and search usage read input_tokens_details.cached_tokens at the cached weight', async () => {
  const replies = [
    { id: 'r1', output: [{ type: 'function_call', call_id: 'c1', name: 'get_leagues', arguments: '{}' }], usage: { input_tokens: 4000, output_tokens: 30, input_tokens_details: { cached_tokens: 0 } } },
    { id: 'r2', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 5000, output_tokens: 10, input_tokens_details: { cached_tokens: 4000 } } },
    { id: 'r3', output: [{ type: 'message', content: [{ type: 'output_text', text: 'rain' }] }], usage: { input_tokens: 300, output_tokens: 20, input_tokens_details: { cached_tokens: 200 } } },
  ];
  let n = 0;
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(replies[n++]) });
  const ad = openaiAdapter({ apiKey: 'k', model: 'gpt-6.1-sol', system: 's', tools: toolDefs(LIMITS), fetchImpl, cachedWeight: 0.05 });
  assert.deepEqual(ad.cacheWeights, { read: 0.05, write: 1 });
  const t1 = await ad.turn([], 'hi');
  const t2 = await ad.turn([{ id: 'c1', name: 'get_leagues', output: {} }], null);
  const s = await ad.search('weather');
  assert.deepEqual(t1.usage, { input: 4000, output: 30, raw: 4000, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(t2.usage, { input: 1200, output: 10, raw: 5000, cacheRead: 4000, cacheWrite: 0 }, '1,000 + 4,000 × 0.05');
  assert.deepEqual(s.usage, { input: 110, output: 20, raw: 300, cacheRead: 200, cacheWrite: 0 }, 'the search counts the same way');
  // Without a weight (an old caller) cached tokens are counted in full, as before 0.25.1.
  n = 1;
  const plain = openaiAdapter({ apiKey: 'k', model: 'm', system: 's', tools: toolDefs(LIMITS), fetchImpl });
  assert.equal((await plain.turn([], 'x')).usage.input, 5000);
});

test('openai cached input: the pre-turn estimate uses the cached weight once a cached request has been seen', () => {
  const w = { read: 0.05, write: 1 };
  assert.equal(nextTurnEstimate({ lastRaw: 40000, lastOutput: 500, cached: false, results: null, weights: w }), 40500, 'nothing cached yet: full size');
  assert.equal(nextTurnEstimate({ lastRaw: 40000, lastOutput: 500, cached: true, results: null, weights: w }), Math.ceil(0.05 * 40000 + 500));
  assert.equal(nextTurnEstimate({ lastRaw: 40000, lastOutput: 500, cached: true, results: [{ output: 'x'.repeat(3500) }], weights: w }), Math.ceil(0.05 * 40000 + 500 + Math.ceil(JSON.stringify([{ output: 'x'.repeat(3500) }]).length / 3.5)));
  // Anthropic's weights stay the default.
  assert.equal(nextTurnEstimate({ lastRaw: 20000, lastOutput: 500, cached: true, results: null }), Math.ceil(0.1 * 20000 + 1.25 * 500));
});

test('openai cached input: a run that re-sends a big cached conversation fits its budget, the summary and cost use the billed-equivalent input', async () => {
  const { openaiUsage } = await import(url('agents/lib/providers.mjs'));
  const boards = { nfl: fixtureBoard('nfl') };
  const call = (name, args) => ({ id: `c${Math.random()}`, name, args });
  // Every request carries 20,000 input tokens, 19,000 of them cached: 1,000 + 19,000 × 0.05 = 1,950 billed-equivalent.
  const usage = openaiUsage({ input_tokens: 20000, output_tokens: 100, input_tokens_details: { cached_tokens: 19000 } }, 0.05);
  const steps = [{ calls: [call('get_leagues', {})] }, { calls: [call('get_board', { league: 'nfl' })] }, { calls: [call('get_leagues', {})] }, { calls: [call('get_leagues', {})] }, { text: 'Passing today.' }];
  const model = { ...scriptedModel(steps, usage), provider: 'openai', model: 'gpt-6.1-sol', cacheWeights: { read: 0.05, write: 1 } };
  const r = await runAgent({ agentId: 'openai', env: { ...ENV, AGENT_MAX_INPUT_TOKENS: '15000' }, fetchImpl: api(boards), now: () => NOW, adapter: model, prompt: 'p', prices: REAL_PRICES });
  assert.equal(r.summary.turns, 5, 'counted in full, 20,000 per request would have stopped the run after the first turn');
  assert.equal(r.summary.stopReason, '');
  assert.equal(r.summary.usage.input, 5 * 1950);
  assert.equal(r.summary.usage.cacheRead, 5 * 19000);
  assert.match(r.text, /Tokens: 9,750 in \/ 500 out \(input is billed-equivalent: 95,000 cached at 0\.05x\)/);
  assert.doesNotMatch(r.text, /written to cache|read from cache at 0\.1x/);
  assert.match(r.text, /- Turn 1: 1,950 in \(19,000 read from cache\)/);
  // 9,750 × $2.00 + 500 × $10.00 per 1M tokens.
  assert.equal(r.summary.costUsd, Math.round(((9750 / 1e6) * 2 + (500 / 1e6) * 10) * 10000) / 10000);
});

test('openai cached input: the runner builds the OpenAI adapter with the weight from prices.json (a real run, mocked fetch)', async () => {
  const bodies = [];
  const providerFetch = async (u, init) => {
    const href = String(u);
    if (href.startsWith('https://api.openai.com/')) {
      bodies.push(JSON.parse(init.body));
      const n = bodies.length;
      const json = n === 1
        ? { id: 'r1', output: [{ type: 'function_call', call_id: 'c1', name: 'get_leagues', arguments: '{}' }], usage: { input_tokens: 3000, output_tokens: 20, input_tokens_details: { cached_tokens: 0 } } }
        : { id: 'r2', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Pass.' }] }], usage: { input_tokens: 3400, output_tokens: 10, input_tokens_details: { cached_tokens: 3000 } } };
      return { ok: true, status: 200, text: async () => JSON.stringify(json) };
    }
    return api({})(u, init);
  };
  const env = { AGENT_OPENAI_USERNAME: 'gpt', AGENT_OPENAI_PASSWORD: 'hunter2-very-secret', OPENAI_API_KEY: 'sk-proj-SECRETKEYVALUE123456', VITE_FIREBASE_API_KEY: 'AIzaSyD-fakeFirebaseWebKey12345', BB_SITE_URL: 'https://bb.example.app' };
  const r = await runAgent({ agentId: 'openai', env, fetchImpl: providerFetch, now: () => NOW, prompt: 'p', prices: REAL_PRICES });
  assert.equal(r.summary.stopReason, '');
  assert.deepEqual(r.summary.cacheWeights, { read: 0.05, write: 1 });
  assert.equal(r.summary.usage.input, 3000 + 400 + 150, 'second request: 400 uncached + 3,000 × 0.05');
  assert.match(r.text, /3,550 in \/ 30 out \(input is billed-equivalent: 3,000 cached at 0\.05x\)/);
});

// ---- 0.25.1: the schedule and the prompt's slip rules ----
test('the workflow runs at an off-the-hour minute (14:23 UTC) and can still be started by hand', () => {
  const yml = readFileSync(`${root}/.github/workflows/agents.yml`, 'utf8');
  assert.match(yml, /^\s+- cron: '23 14 \* \* \*'/m);
  assert.doesNotMatch(yml, /cron: '0 16/);
  assert.match(yml, /workflow_dispatch:/);
  assert.match(yml, /9:23 AM Central in daylight time, 8:23 AM in standard time/);
});

test('prompt.md states the slip rules the server enforces and the re-check after a price change', () => {
  const p = readFileSync(`${root}/agents/prompt.md`, 'utf8');
  assert.match(p, /One pick per game and market type on a slip/);
  assert.match(p, /at most one leg per player per stat/);
  assert.match(p, /moneyline and spread/);
  assert.match(p, /Pre-game only/);
  assert.match(p, /At most 5% of your current balance/);
  assert.match(p, /At most 10 bet slips per day/);
  assert.match(p, /Re-check your edge at\s+the new price/);
  assert.match(p, /ODDS_CHANGED/);
  assert.match(p, /LINE_CHANGED/);
  // The placeholders still fill in.
  assert.doesNotMatch(renderPrompt(p, { maxSearches: 5, maxTurns: 25 }), /\{\{/);
});
