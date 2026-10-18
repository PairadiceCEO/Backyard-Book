// npm run test:sportsbook  (or: node --experimental-test-module-mocks test/sportsbook/phase11b.test.mjs)
// 0.11.0 items 4 and 5:
//   4. Board tabs list only games that haven't finished (filtered in /api/board's reply, never in the cache);
//      the Live tab lists every ESPN game in progress from the five cached league boards.
//   5. No cash out on any bet with a custom-game or Challenge leg, before or after the start; nothing fetched.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;

const store = new Map();
const reads = [];
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const fakeDb = {
  collection: (name) => ({
    doc: (id) => ({
      async get() { reads.push(`${name}/${id}`); const d = store.get(`${name}/${id}`); return { exists: d !== undefined, data: () => clone(d) }; },
      async set(v) { store.set(`${name}/${id}`, clone(v)); },
      async delete() { store.delete(`${name}/${id}`); },
    }),
    where: () => ({ async get() { return { forEach() {} }; } }),
  }),
};
mock.module(url('server/firebaseAdmin.js'), { namedExports: { adminDb: () => fakeDb, adminAuth: () => ({}), normalizePrivateKey: (k) => k } });
mock.module(url('server/auth.js'), {
  namedExports: { requireUser: async () => ({ uid: 'u1', token: {}, user: { username: 'mike' } }), requireAdmin: async () => ({}), checkProfile: (s) => s.data() },
});

const boardMod = await import(url('server/board.js'));
const { getGameDetail } = await import(url('server/gameDetail.js'));
const cache = await import(url('server/cache.js'));
const { emptyMarkets } = await import(url('server/sources/espn.js'));
const cashout = await import(url('server/cashout.js'));
const { NO_CASHOUT_REASON, cashoutEligible } = await import(url('shared/betRules.js'));
const { groupByLeague } = await import(url('src/lib/board.js'));
const { LEAGUES } = await import(url('shared/constants.js'));
const handler = (await import(url('api/board.js'))).default;

const res = () => ({ statusCode: 200, headers: {}, body: null, headersSent: false, setHeader(a, b) { this.headers[a] = b; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } });
const get = async (query) => { const r = res(); await handler({ method: 'GET', query, headers: {} }, r); return r; };

const team = (abbr) => ({ id: abbr, name: abbr, shortName: abbr, nickname: abbr, location: abbr, abbr, logo: null, logoDark: null, score: null });
const g = (id, league, state, startTime, extra = {}) => ({
  id, league, source: 'espn', startTime, state, statusText: state, statusName: null, completed: state === 'post', canceled: false,
  bettingClosed: state !== 'pre', gameNumber: null, home: team('H'), away: team('A'), markets: emptyMarkets(), oddsNote: null, kalshi: null, ...extra,
});
function putBoard(leagueId, games, ageMs = 5000) {
  store.set(`cache/board_${leagueId}`, { fetchedAtMs: Date.now() - ageMs, value: { games, partial: false, kalshiStatus: 'ok', alts: {}, altsDropped: false } });
}
function blockFetch() {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => { calls.push(String(u)); throw new Error(`no network in this test: ${u}`); };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

// ---------- 4a: only games that haven't finished ----------

test('board tabs list only unfinished games; the cache keeps them all; a finished game\'s page still opens', async () => {
  cache.clearMemoryCache();
  store.clear();
  const games = [
    g('done', 'mlb', 'post', '2026-10-17T17:00:00Z'),
    g('postponed', 'mlb', 'post', '2026-10-17T22:00:00Z', { canceled: true, statusName: 'STATUS_POSTPONED' }),
    g('canceledPre', 'mlb', 'pre', '2026-10-18T22:00:00Z', { canceled: true, statusName: 'STATUS_CANCELED' }),
    g('live', 'mlb', 'in', '2026-10-18T00:00:00Z'),
    g('later', 'mlb', 'pre', '2026-10-19T00:00:00Z'),
  ];
  putBoard('mlb', games);
  const net = blockFetch();
  try {
    const r = await get({ league: 'mlb' });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.games.map((x) => x.id), ['live', 'later']);
    assert.equal(store.get('cache/board_mlb').value.games.length, 5, 'the cache keeps every game (settlement, pricing, game pages)');
    const detail = await getGameDetail('mlb', 'done');
    assert.equal(detail.game.id, 'done', 'a finished game\'s page still opens (from My Bets)');
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});

test('Custom tab: final and canceled custom games are left out', async () => {
  const at = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  const custom = [
    boardMod.normalizeCustomGame('a', { league: 'nfl', startTime: at(-30), status: 'final', finalScore: { home: 1, away: 0 }, home: { name: 'X' }, away: { name: 'Y' } }, new Date()),
    boardMod.normalizeCustomGame('b', { league: 'nfl', startTime: at(2), status: 'canceled', home: { name: 'X' }, away: { name: 'Y' } }, new Date()),
    boardMod.normalizeCustomGame('c', { league: 'nfl', startTime: at(2), status: 'scheduled', home: { name: 'X' }, away: { name: 'Y' }, odds: { moneyline: { home: -110, away: -110 } } }, new Date()),
    boardMod.normalizeCustomGame('d', { league: 'nfl', startTime: at(-1), status: 'scheduled', home: { name: 'X' }, away: { name: 'Y' } }, new Date()),
  ];
  assert.deepEqual(boardMod.listedGames(custom).map((x) => x.id), ['custom:c', 'custom:d'], 'scheduled and started (not final) stay');
  cache.clearMemoryCache();
  store.clear();
  store.set('cache/board_custom', { fetchedAtMs: Date.now() - 1000, value: { games: custom, partial: false, kalshiStatus: 'ok', alts: {}, altsDropped: false } });
  const r = await get({ league: 'custom' });
  assert.deepEqual(r.body.games.map((x) => x.id), ['custom:c', 'custom:d']);
});

// ---------- 4b: the Live tab ----------

test('/api/board?league=live: every ESPN game in progress, league order then start time, from the cached boards only', async () => {
  cache.clearMemoryCache();
  store.clear();
  putBoard('mlb', [g('m2', 'mlb', 'in', '2026-10-18T01:00:00Z'), g('m1', 'mlb', 'in', '2026-10-18T00:00:00Z'), g('m3', 'mlb', 'pre', '2026-10-19T00:00:00Z'), g('m4', 'mlb', 'post', '2026-10-17T00:00:00Z')]);
  putBoard('nfl', [g('f1', 'nfl', 'in', '2026-10-18T17:00:00Z'), g('f2', 'nfl', 'in', '2026-10-18T17:00:00Z', { canceled: true })]);
  putBoard('nhl', []);
  putBoard('ncaaf', [g('c1', 'ncaaf', 'in', '2026-10-18T02:30:00Z')]);
  putBoard('nba', [g('b1', 'nba', 'pre', '2026-10-20T23:30:00Z')]);
  const net = blockFetch();
  try {
    const r = await get({ league: 'live' });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.league, 'live');
    assert.deepEqual(r.body.games.map((x) => `${x.league}:${x.id}`), ['mlb:m1', 'mlb:m2', 'nfl:f1', 'ncaaf:c1']);
    assert.equal(net.calls.length, 0, 'no ESPN or Kalshi request: the five cached boards only');
    assert.ok(r.body.games.every((x) => x.source === 'espn'), 'custom games are not on it');
    // The phone groups them by league in the app's order.
    const groups = groupByLeague(r.body.games, LEAGUES);
    assert.deepEqual(groups.map((x) => [x.label, x.games.map((y) => y.id)]), [['MLB', ['m1', 'm2']], ['NFL', ['f1']], ['College Football', ['c1']]]);

    // Nothing live anywhere: empty list (the phone shows "No games are live right now.").
    cache.clearMemoryCache();
    store.clear();
    for (const l of LEAGUES) putBoard(l.id, [g(`${l.id}-x`, l.id, 'pre', '2026-12-01T00:00:00Z')]);
    const empty = await get({ league: 'live' });
    assert.deepEqual(empty.body.games, []);
    assert.equal(net.calls.length, 0);

    const bad = await get({ league: 'live', game: 'm1' });
    assert.equal(bad.statusCode, 400);
  } finally {
    net.restore();
  }
});

test('Live tab and the Spark quota: a quiet league\'s board (no game live or starting) is reused up to 5 minutes; a league with a live game refreshes at 30 s', async () => {
  cache.clearMemoryCache();
  store.clear();
  putBoard('mlb', [g('m1', 'mlb', 'in', '2026-10-18T00:00:00Z')], 60_000); // a minute old, game live
  for (const id of ['nfl', 'nhl', 'ncaaf', 'nba']) putBoard(id, [g(`${id}-x`, id, 'pre', '2026-12-01T00:00:00Z')], 120_000); // two minutes old, quiet
  const net = blockFetch();
  try {
    const r = await get({ league: 'live' });
    assert.equal(r.statusCode, 200);
    const espnCalls = net.calls.filter((c) => c.includes('espn.com'));
    assert.ok(espnCalls.length > 0 && espnCalls.every((c) => c.includes('/baseball/mlb/')), 'only MLB (live game, copy > 30 s) tried to rebuild');
    assert.ok(net.calls.every((c) => !/football|hockey|basketball/.test(c)), 'quiet leagues reused their cached copies');
    assert.equal(r.body.stale, true, 'MLB rebuild failed here → its last copy is served, marked stale');
    assert.deepEqual(r.body.games.map((x) => x.id), ['m1']);
  } finally {
    net.restore();
  }
});

// ---------- 5: no cash out on custom-game or Challenge bets ----------

function bet(legs, extra = {}) {
  return { uid: 'u1', status: 'open', type: legs.length > 1 ? 'parlay' : 'single', stakeCents: 1000, potentialPayoutCents: 3000, version: 0, legs, ...extra };
}
const mlbLeg = { league: 'mlb', gameId: '401', marketType: 'moneyline', selection: 'home', line: null, decimalOdds: 1.8, startTime: '2026-10-18T00:00:00Z', result: 'pending', source: 'kalshi', sourceRef: { provider: 'Kalshi', ticker: 'KXMLBGAME-26OCT172000TBCLE-CLE', side: 'yes', price: 0.55 } };
const customLeg = (startTime) => ({ league: 'mlb', gameId: 'custom:cg1', marketType: 'moneyline', selection: 'away', line: null, decimalOdds: 2, startTime, result: 'pending', source: 'custom', sourceRef: { provider: 'Custom' } });
const challengeLeg = (closeTime) => ({ league: 'challenge', gameId: 'challenge:u2_abcdefgh', marketType: 'challenge', selection: 'o1', line: null, decimalOdds: 2.5, startTime: closeTime, result: 'pending', source: 'challenge', sourceRef: { provider: 'Challenge' } });

test('cash out is refused for a custom single, a Challenge single and an MLB + custom parlay, before and after the start, without fetching anything', async () => {
  const NOW = new Date('2026-10-18T01:00:00Z');
  const before = '2026-10-18T03:00:00Z'; // not started yet
  const after = '2026-10-17T23:00:00Z'; // already started
  const cases = {
    customPre: bet([customLeg(before)]),
    customLive: bet([customLeg(after)]),
    challengePre: bet([challengeLeg(before)]),
    challengeClosed: bet([challengeLeg(after)]),
    parlayPre: bet([{ ...mlbLeg, startTime: before }, customLeg(before)]),
    parlayLive: bet([mlbLeg, customLeg(after)]),
  };
  store.clear();
  reads.length = 0;
  const fetchImpl = async (u) => { throw new Error(`nothing should be fetched: ${u}`); };
  for (const [name, b] of Object.entries(cases)) {
    assert.equal(cashoutEligible(b), false, name);
    for (const fresh of [false, true]) {
      const ctx = cashout.createCashoutContext({ now: NOW, fetchImpl, fresh, db: fakeDb, getBoard: async () => { throw new Error('no board either'); } });
      assert.deepEqual(await cashout.quoteCashout(b, ctx), { available: false, valueCents: null, reason: NO_CASHOUT_REASON }, `${name} fresh=${fresh}`);
    }
    // The confirmation reads the bet (it has to) and stops there.
    store.set(`bets/${name}`, b);
    reads.length = 0;
    await assert.rejects(cashout.cashOutBet({ uid: 'u1', user: { username: 'mike' } }, { betId: name, expectedCents: 900 }, { now: NOW, fetchImpl }), (e) => e.code === 'CASHOUT_UNAVAILABLE' && e.extra.reason === NO_CASHOUT_REASON);
    assert.deepEqual(reads, [`bets/${name}`], `${name}: only the bet itself was read`);
  }
  assert.equal(cashoutEligible(bet([mlbLeg])), true, 'a real-game bet is still eligible');
});
