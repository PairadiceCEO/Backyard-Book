// npm run test:sportsbook  (or: node --experimental-test-module-mocks test/sportsbook/phase6b.test.mjs)
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;

const store = new Map();
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const fakeDb = {
  collection: (name) => ({
    doc: (id) => ({
      async get() { const d = store.get(`${name}/${id}`); return { exists: d !== undefined, data: () => clone(d) }; },
      async set(v) { store.set(`${name}/${id}`, clone(v)); },
    }),
    where: () => ({ async get() { return { forEach() {} }; } }),
  }),
};
mock.module(url('server/firebaseAdmin.js'), { namedExports: { adminDb: () => fakeDb, adminAuth: () => ({}), normalizePrivateKey: (k) => k } });
mock.module(url('server/auth.js'), {
  namedExports: { requireUser: async () => ({ uid: 'u1', token: {}, user: { username: 'mike' } }), requireAdmin: async () => ({}) },
});

const rules = await import(url('shared/betRules.js'));
const k = await import(url('server/sources/kalshi.js'));
const { priceLeg } = await import(url('server/pricing.js'));
const { buildBoard } = await import(url('server/board.js'));
const { getGameDetail } = await import(url('server/gameDetail.js'));
const cache = await import(url('server/cache.js'));
const { emptyMarkets } = await import(url('server/sources/espn.js'));
const red = await import(url('src/lib/betSlipReducer.js'));

// ---------- real Kalshi data (Oct 16, 2026): Houston vs Jacksonville ----------
function km(ticker, yesSub, yesAsk, noAsk, extra = {}) {
  return {
    ticker, yes_sub_title: yesSub, status: 'active',
    yes_ask_dollars: yesAsk.toFixed(4), no_ask_dollars: noAsk.toFixed(4),
    yes_bid_dollars: (yesAsk - 0.01).toFixed(4), no_bid_dollars: (noAsk - 0.01).toFixed(4), ...extra,
  };
}
const spreadRows = [
  ['JAC21', 'Jacksonville', 20.5, 0.08, 0.93], ['JAC11', 'Jacksonville', 10.5, 0.23, 0.78],
  ['JAC4', 'Jacksonville', 3.5, 0.43, 0.58], ['JAC3', 'Jacksonville', 2.5, 0.52, 0.49], ['JAC2', 'Jacksonville', 1.5, 0.55, 0.46],
  ['HOU2', 'Houston', 1.5, 0.41, 0.60], ['HOU3', 'Houston', 2.5, 0.39, 0.62], ['HOU15', 'Houston', 14.5, 0.10, 0.92],
  ['HOU30', 'Houston', 29.5, 0.01, 0.99], // fails the $0.03–$0.97 rule on both sides → hidden
];
const SPREAD = {
  event_ticker: 'KXNFLSPREAD-26OCT18HOUJAC', title: 'Houston vs Jacksonville: Spread',
  markets: spreadRows.map(([code, team, strike, y, n]) => km(`KXNFLSPREAD-26OCT18HOUJAC-${code}`, `${team} wins by over ${strike} points`, y, n, { floor_strike: strike })),
};
const TOTAL = {
  event_ticker: 'KXNFLTOTAL-26OCT18HOUJAC', title: 'HOU Texans vs JAC Jaguars: Total Points',
  markets: [[38.5, 0.71, 0.31], [42.5, 0.51, 0.51], [44.5, 0.42, 0.60], [60.5, 0.02, 0.99]].map(([s, y, n]) =>
    km(`KXNFLTOTAL-26OCT18HOUJAC-${Math.ceil(s)}`, `Over ${s} points`, y, n, { floor_strike: s })),
};
const GAME = {
  event_ticker: 'KXNFLGAME-26OCT18HOUJAC', title: 'HOU Texans vs JAC Jaguars',
  markets: [km('KXNFLGAME-26OCT18HOUJAC-JAC', 'Jacksonville', 0.57, 0.44), km('KXNFLGAME-26OCT18HOUJAC-HOU', 'Houston', 0.44, 0.57)],
};
const sideByCode = { JAC: 'away', HOU: 'home' };
const withParsed = (e) => ({ ...e, parsed: k.parseEventTicker(e.event_ticker) });

test('parlay rule: no moneyline + spread from the same game (either team); everything else unchanged', () => {
  const L = (gameId, marketType, selection) => ({ gameId, marketType, selection });
  const parlay = (legs) => rules.slipProblems({ mode: 'parlay', legs, stakeCents: 500 });
  assert.deepEqual(parlay([L('g1', 'moneyline', 'home'), L('g1', 'spread', 'away')]), [rules.PARLAY_ML_SPREAD_MESSAGE], 'different teams');
  assert.deepEqual(parlay([L('g1', 'moneyline', 'home'), L('g1', 'spread', 'home')]), [rules.PARLAY_ML_SPREAD_MESSAGE], 'same team');
  assert.deepEqual(parlay([L('g1', 'moneyline', 'home'), L('g1', 'total', 'over')]), [], 'ML + total ok');
  assert.deepEqual(parlay([L('g1', 'spread', 'home'), L('g1', 'total', 'under')]), [], 'spread + total ok');
  assert.deepEqual(parlay([L('g1', 'moneyline', 'home'), L('g2', 'spread', 'away')]), [], 'different games ok');
  assert.deepEqual(rules.slipProblems({ mode: 'singles', legs: [{ ...L('g1', 'moneyline', 'home'), stakeCents: 100 }, { ...L('g1', 'spread', 'away'), stakeCents: 100 }] }), [], 'singles unaffected');
  assert.match(parlay([L('g1', 'spread', 'home'), L('g1', 'spread', 'away')])[0], /one pick per game/, 'old rule kept');
});

test('leg ids: alternates and sources are distinct picks; the slip still allows one spread per game', () => {
  assert.equal(rules.makeLegId({ league: 'nfl', gameId: 'g1', marketType: 'spread', selection: 'away', line: -3.5, source: 'kalshi' }), 'nfl:g1:spread:away:-3.5:kalshi');
  assert.equal(rules.makeLegId({ league: 'nfl', gameId: 'g1', marketType: 'moneyline', selection: 'home', source: 'espn' }), 'nfl:g1:moneyline:home:espn');
  const g = { id: 'g1', league: 'nfl', home: { shortName: 'Texans' }, away: { shortName: 'Jaguars' } };
  const alt = red.makePick(g, 'spread', 'away', { american: -150, decimal: 1.6667, line: -1.5, source: 'kalshi', ref: { ticker: 'KXNFLSPREAD-26OCT18HOUJAC-JAC2', side: 'yes' } });
  const main = red.makePick(g, 'spread', 'away', { american: -110, decimal: 1.9091, line: -2.5, source: 'espn', ref: { provider: 'DraftKings' } });
  assert.deepEqual(alt.kalshi, { ticker: 'KXNFLSPREAD-26OCT18HOUJAC-JAC2', side: 'yes' }, 'exact market stored on the pick');
  assert.equal(main.kalshi, null);
  let s = red.betSlipReducer(red.initialSlipState, { type: 'toggle', pick: main });
  s = red.betSlipReducer(s, { type: 'toggle', pick: alt });
  assert.equal(s.legs.length, 1, 'alternate spread replaces the main spread');
  assert.equal(s.legs[0].line, -1.5);
});

test('ladders from real Kalshi markets: both teams, YES/NO mapping, posted lines only, sorted', () => {
  const entry = { spreadEvent: SPREAD, totalEvent: TOTAL, sideByCode };
  const compact = k.compactAlternates(entry);
  const ladders = k.buildLadders(compact, sideByCode);
  const fmt = (qs) => qs.map((q) => [q.line, q.american, q.ref.ticker.split('-').pop(), q.ref.side]);

  // Jaguars (away): -N from JAC markets (YES), +N from HOU markets (NO)
  assert.deepEqual(fmt(ladders.spreads.away), [
    [-20.5, 1150, 'JAC21', 'yes'], [-10.5, 335, 'JAC11', 'yes'], [-3.5, 133, 'JAC4', 'yes'], [-2.5, -108, 'JAC3', 'yes'], [-1.5, -122, 'JAC2', 'yes'],
    [1.5, -150, 'HOU2', 'no'], [2.5, -163, 'HOU3', 'no'], [14.5, -1150, 'HOU15', 'no'],
  ]);
  // Texans (home): -N from HOU (YES), +N from JAC (NO)
  assert.deepEqual(fmt(ladders.spreads.home), [
    [-14.5, 900, 'HOU15', 'yes'], [-2.5, 156, 'HOU3', 'yes'], [-1.5, 144, 'HOU2', 'yes'],
    [1.5, 117, 'JAC2', 'no'], [2.5, 104, 'JAC3', 'no'], [3.5, -138, 'JAC4', 'no'], [10.5, -355, 'JAC11', 'no'], [20.5, -1329, 'JAC21', 'no'],
  ]);
  assert.ok(!ladders.spreads.away.concat(ladders.spreads.home).some((q) => q.ref.ticker.endsWith('HOU30')), '29.5 market fails availability → hidden');
  assert.deepEqual(ladders.totals.map((r) => [r.line, r.over?.american ?? null, r.under?.american ?? null]), [
    [38.5, -245, 223], [42.5, -104, -104], [44.5, 138, -150],
  ], '60.5 hidden');
  assert.equal(ladders.totals[1].over.ref.side, 'yes');
  assert.equal(ladders.totals[1].under.ref.side, 'no');
  assert.deepEqual(k.buildLadders(null, sideByCode), { spreads: { home: [], away: [] }, totals: [] });
});

test('marketMatchesLeg: ticker must belong to this game, market and side', () => {
  const mapping = { gameEvent: GAME.event_ticker, spreadEvent: SPREAD.event_ticker, totalEvent: TOTAL.event_ticker, sideByCode };
  const t = 'KXNFLSPREAD-26OCT18HOUJAC-JAC3';
  assert.ok(k.marketMatchesLeg(mapping, { marketType: 'spread', selection: 'away' }, t, 'yes'), 'Jaguars -2.5');
  assert.ok(k.marketMatchesLeg(mapping, { marketType: 'spread', selection: 'home' }, t, 'no'), 'Texans +2.5');
  assert.ok(!k.marketMatchesLeg(mapping, { marketType: 'spread', selection: 'home' }, t, 'yes'), 'YES on JAC is not a Texans bet');
  assert.ok(!k.marketMatchesLeg(mapping, { marketType: 'spread', selection: 'away' }, 'KXNFLSPREAD-26OCT18BALCLE-BAL3', 'yes'), 'other game');
  assert.ok(!k.marketMatchesLeg(mapping, { marketType: 'total', selection: 'over' }, t, 'yes'), 'spread ticker on a total');
  assert.ok(k.marketMatchesLeg(mapping, { marketType: 'total', selection: 'under' }, 'KXNFLTOTAL-26OCT18HOUJAC-43', 'no'));
  assert.ok(!k.marketMatchesLeg(mapping, { marketType: 'total', selection: 'under' }, 'KXNFLTOTAL-26OCT18HOUJAC-43', 'yes'));
  assert.ok(k.marketMatchesLeg(mapping, { marketType: 'moneyline', selection: 'home' }, 'KXNFLGAME-26OCT18HOUJAC-HOU', 'yes'));
  assert.ok(!k.marketMatchesLeg(null, { marketType: 'spread', selection: 'away' }, t, 'yes'));
});

test('pricing alternate legs: exact market re-priced; foreign ticker or vanished line → MARKET_CLOSED; stale line → LINE_CHANGED', async () => {
  const team = (abbr, short) => ({ id: abbr, name: short, shortName: short, abbr, score: null });
  const g = { id: 'g1', league: 'nfl', source: 'espn', startTime: '2026-10-18T17:00:00.000Z', state: 'pre', canceled: false, home: team('HOU', 'Texans'), away: team('JAX', 'Jaguars'), markets: emptyMarkets(),
    kalshi: { gameEvent: GAME.event_ticker, spreadEvent: SPREAD.event_ticker, totalEvent: TOTAL.event_ticker, sideByCode } };
  const t = 'KXNFLSPREAD-26OCT18HOUJAC-JAC11';
  const ctx = (markets) => ({ now: new Date(), board: async () => ({ games: [g] }), freshEspnGames: async () => [g], freshKalshiForGames: async () => new Map(), market: async (x) => markets[x] ?? null, customGame: async () => null });
  const leg = { league: 'nfl', gameId: 'g1', marketType: 'spread', selection: 'away', line: -10.5, kalshiTicker: t, kalshiSide: 'yes' };

  let r = await priceLeg(leg, ctx({ [t]: km(t, 'x', 0.25, 0.76, { floor_strike: 10.5 }) }));
  assert.equal(r.status, 'ok');
  assert.equal(r.quote.line, -10.5);
  assert.equal(r.quote.american, 300);
  assert.equal(r.quote.ref.ticker, t);

  r = await priceLeg({ ...leg, kalshiTicker: 'KXNFLSPREAD-26OCT18BALCLE-BAL11' }, ctx({}));
  assert.equal(r.status, 'closed');
  assert.match(r.reason, /not offered/);

  r = await priceLeg(leg, ctx({ [t]: { ...km(t, 'x', 0.25, 0.76, { floor_strike: 10.5 }), status: 'closed' } }));
  assert.equal(r.status, 'closed');
  assert.match(r.reason, /no longer posted/);

  r = await priceLeg({ ...leg, line: -10 }, ctx({ [t]: km(t, 'x', 0.25, 0.76, { floor_strike: 10.5 }) }));
  assert.equal(r.status, 'lineChanged', 'admin stale-line test still works on Kalshi legs');
  assert.equal(r.quote.line, -10.5);

  r = await priceLeg(leg, { ...ctx({}), freshEspnGames: async () => [{ ...g, state: 'post' }] });
  assert.equal(r.status, 'closed', 'finished game');
});

// ---------- board + game detail ----------
function espnEvent(id, state = 'pre') {
  const t = (abbr, loc, nick) => ({ id: abbr, abbreviation: abbr, displayName: `${loc} ${nick}`, shortDisplayName: nick, name: nick, location: loc });
  return {
    id, date: '2026-10-18T17:00:00Z',
    status: { type: { state, name: state === 'post' ? 'STATUS_FINAL' : 'STATUS_SCHEDULED', shortDetail: 'x', completed: state === 'post' } },
    competitions: [{ competitors: [
      { homeAway: 'home', score: '0', team: t('HOU', 'Houston', 'Texans') },
      { homeAway: 'away', score: '0', team: t('JAX', 'Jacksonville', 'Jaguars') },
    ] }],
  };
}
function routedFetch({ espnState = 'pre', spread = SPREAD, calls = [] } = {}) {
  return async (u) => {
    const p = new URL(u);
    calls.push(p.pathname + p.search);
    if (p.host === 'site.api.espn.com') return { ok: true, status: 200, json: async () => ({ events: [espnEvent('401', espnState)] }) };
    if (p.pathname.endsWith('/events')) {
      const series = p.searchParams.get('series_ticker');
      const events = series === 'KXNFLGAME' ? [GAME] : series === 'KXNFLSPREAD' ? [spread] : [TOTAL];
      return { ok: true, status: 200, json: async () => ({ events, cursor: '' }) };
    }
    if (p.pathname.includes('/events/')) {
      const ticker = decodeURIComponent(p.pathname.split('/events/')[1]);
      const event = ticker.startsWith('KXNFLSPREAD') ? spread : TOTAL;
      return { ok: true, status: 200, json: async () => ({ event }) };
    }
    throw new Error(`unexpected ${u}`);
  };
}

test('board keeps a compact alternates copy and the game mapping; same Kalshi calls as before', async () => {
  const calls = [];
  const board = await buildBoard('nfl', { now: new Date('2026-10-16T20:00:00Z'), fetchImpl: routedFetch({ calls }) });
  assert.equal(calls.filter((c) => c.includes('/events')).length, 3, 'still one call per series');
  const game = board.games[0];
  assert.deepEqual(game.kalshi, { gameEvent: GAME.event_ticker, spreadEvent: SPREAD.event_ticker, totalEvent: TOTAL.event_ticker, sideByCode });
  assert.ok(board.alts['401'].s.m.length === spreadRows.length);
  assert.equal(board.altsDropped, false);
  const bytes = Buffer.byteLength(JSON.stringify(board));
  assert.ok(bytes < 20000, `board doc is small (${bytes} bytes)`);
});

test('size guard: a huge alternates copy is dropped and the game page falls back to a per-game fetch', async () => {
  const huge = { ...SPREAD, markets: Array.from({ length: 25000 }, (_, i) => km(`KXNFLSPREAD-26OCT18HOUJAC-JAC${i + 1}`, 'Jacksonville wins by over x', 0.5, 0.51, { floor_strike: i + 0.5 })) };
  const board = await buildBoard('nfl', { now: new Date('2026-10-16T20:00:00Z'), fetchImpl: routedFetch({ spread: huge }) });
  assert.equal(board.altsDropped, true);
  assert.deepEqual(board.alts, {});
  assert.ok(Buffer.byteLength(JSON.stringify(board)) < 800 * 1024);
  assert.ok(board.games[0].kalshi.spreadEvent, 'mapping kept for bet validation');

  cache.clearMemoryCache();
  store.clear();
  store.set('cache/board_nfl', { fetchedAtMs: Date.now(), value: JSON.parse(JSON.stringify(board)) });
  const calls = [];
  const detail = await getGameDetail('nfl', '401', { fetchImpl: routedFetch({ calls }) });
  assert.ok(calls.some((c) => c.includes('/events/KXNFLSPREAD-26OCT18HOUJAC')), 'per-game event fetch');
  assert.ok(detail.ladders.spreads.away.length > 0);
  assert.ok(store.has('cache/alts_nfl_401'), 'cached per game');
});

test('game detail: ladders from the board cache, no extra Kalshi calls; finished → no lines; unknown → 404', async () => {
  cache.clearMemoryCache();
  store.clear();
  const calls = [];
  const detail = await getGameDetail('nfl', '401', { fetchImpl: routedFetch({ calls }), now: () => new Date('2026-10-16T20:00:00Z') });
  assert.equal(detail.game.id, '401');
  assert.equal(detail.ladders.spreads.away.length, 8);
  assert.equal(detail.ladders.totals.length, 3);
  const before = calls.length;
  await getGameDetail('nfl', '401', { fetchImpl: routedFetch({ calls }) });
  assert.equal(calls.length, before, 'second view served from cache');

  cache.clearMemoryCache();
  store.clear();
  const fin = await getGameDetail('nfl', '401', { fetchImpl: routedFetch({ espnState: 'post' }), now: () => new Date('2026-10-16T20:00:00Z') });
  assert.deepEqual(fin.ladders, { spreads: { home: [], away: [] }, totals: [] });
  await assert.rejects(getGameDetail('nfl', 'nope', { fetchImpl: routedFetch() }), (err) => err.status === 404);
});

test('/api/board never sends the alternates copy; ?game= returns ladders', async () => {
  cache.clearMemoryCache();
  store.clear();
  const realFetch = globalThis.fetch;
  globalThis.fetch = routedFetch();
  const handler = (await import(url('api/board.js'))).default;
  const res = () => ({ statusCode: 200, headers: {}, body: null, headersSent: false, setHeader(a, b) { this.headers[a] = b; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } });
  let r = res();
  await handler({ method: 'GET', query: { league: 'nfl' }, headers: {} }, r);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(!('alts' in r.body));
  assert.ok(!JSON.stringify(r.body).includes('"m":'), 'no compact market rows in the board response');
  r = res();
  await handler({ method: 'GET', query: { league: 'nfl', game: '401' }, headers: {} }, r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ladders.spreads.home.length, 8);
  r = res();
  await handler({ method: 'GET', query: { league: 'nfl', game: 'missing' }, headers: {} }, r);
  assert.equal(r.statusCode, 404);
  assert.equal(r.body.error.code, 'GAME_NOT_FOUND');
  globalThis.fetch = realFetch;
});
