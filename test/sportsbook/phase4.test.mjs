// npm run test:sportsbook  (or: node --experimental-test-module-mocks test/sportsbook/phase4.test.mjs)
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;

// ---- fake Firestore ----
const store = new Map();
let failCacheReads = false;
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const fakeDb = {
  collection(name) {
    return {
      doc: (id) => ({
        path: `${name}/${id}`,
        async get() {
          if (name === 'cache' && failCacheReads) throw new Error('read failed');
          const d = store.get(`${name}/${id}`);
          return { exists: d !== undefined, data: () => clone(d) };
        },
        async set(data) { store.set(`${name}/${id}`, clone(data)); },
      }),
      where: (field, _op, value) => ({
        async get() {
          const docs = [...store.entries()]
            .filter(([p, d]) => p.startsWith(`${name}/`) && d[field] === value)
            .map(([p, d]) => ({ id: p.split('/')[1], data: () => clone(d) }));
          return { forEach: (fn) => docs.forEach(fn) };
        },
      }),
      async get() {
        const docs = [...store.entries()]
          .filter(([p]) => p.startsWith(`${name}/`))
          .map(([p, d]) => ({ id: p.split('/')[1], data: () => clone(d) }));
        return { forEach: (fn) => docs.forEach(fn) };
      },
    };
  },
};
mock.module(url('server/firebaseAdmin.js'), {
  namedExports: { adminDb: () => fakeDb, adminAuth: () => ({}), normalizePrivateKey: (k) => k },
});
let signedIn = true;
mock.module(url('server/auth.js'), {
  namedExports: {
    requireUser: async () => {
      if (!signedIn) { const { HttpError } = await import(url('server/http.js')); throw new HttpError(401, 'NOT_SIGNED_IN', 'x'); }
      return { uid: 'u1', token: {}, user: {} };
    },
    requireAdmin: async () => ({ uid: 'admin', token: { admin: true }, user: {} }),
  },
});

const espn = await import(url('server/sources/espn.js'));
const { buildBoard, buildCustomBoard, normalizeCustomGame } = await import(url('server/board.js'));
const cache = await import(url('server/cache.js'));
const { centralYmd, centralDateKey } = await import(url('shared/time.js'));
const om = await import(url('shared/oddsMath.js'));

// ---- fixtures in the shape Will reported ----
function team(id, abbr, name, short, loc) {
  return { id, abbreviation: abbr, displayName: name, shortDisplayName: short, location: loc,
    logo: `https://a.espncdn.com/i/teamlogos/${abbr}.png`, logoDark: `https://a.espncdn.com/i/teamlogos/dark/${abbr}.png` };
}
function event({ id, date, state = 'pre', name = 'STATUS_SCHEDULED', detail = 'Sat, October 18th at 12:00 PM EDT', homeScore = '0', awayScore = '0', odds }) {
  return {
    id, date,
    status: { type: { state, name, shortDetail: detail, completed: state === 'post' } },
    competitions: [{
      competitors: [
        { homeAway: 'home', score: homeScore, team: team('1', 'HOU', 'Houston Texans', 'Texans', 'Houston') },
        { homeAway: 'away', score: awayScore, team: team('2', 'JAX', 'Jacksonville Jaguars', 'Jaguars', 'Jacksonville') },
      ],
      odds: odds === undefined ? undefined : [odds],
    }],
  };
}
const nestedOdds = {
  provider: { name: 'DraftKings' },
  details: 'HOU -2.5', spread: -2.5, overUnder: 42.5,
  moneyline: { home: { open: { odds: '-105' }, close: { odds: '-142' } }, away: { open: { odds: '-115' }, close: { odds: '+120' } } },
  pointSpread: {
    home: { open: { line: '-1.5', odds: '-110' }, close: { line: '-2.5', odds: '-115' } },
    away: { open: { line: '+1.5', odds: '-110' }, close: { line: '+2.5', odds: '-105' } },
  },
  total: { over: { open: { line: 'o44.5', odds: '-110' }, close: { line: 'o42.5', odds: '-112' } },
           under: { open: { line: 'u44.5', odds: '-110' }, close: { line: 'u42.5', odds: '-108' } } },
};
const flatOdds = {
  provider: { name: 'DraftKings' }, details: 'HOU -3', spread: -3, overUnder: 47,
  homeTeamOdds: { moneyLine: -160, spreadOdds: -110 }, awayTeamOdds: { moneyLine: 135, spreadOdds: -110 },
};

test('oddsMath parsing and conversion', () => {
  assert.equal(om.parseAmerican('-142'), -142);
  assert.equal(om.parseAmerican('+120'), 120);
  assert.equal(om.parseAmerican('EVEN'), 100);
  assert.equal(om.parseAmerican('-50'), null);
  assert.equal(om.parseAmerican('OFF'), null);
  assert.equal(om.parseLine('o42.5'), 42.5);
  assert.equal(om.parseLine('u42.5'), 42.5);
  assert.equal(om.parseLine('+2.5'), 2.5);
  assert.equal(om.parseLine('PK'), 0);
  assert.equal(om.americanToDecimal(-110).toFixed(4), '1.9091');
  assert.equal(om.americanToDecimal(150), 2.5);
  assert.equal(om.decimalToAmerican(2.5), 150);
  assert.equal(om.decimalToAmerican(1.9091), -110);
  assert.equal(om.probabilityToAmerican(0.62), -163);
  assert.equal(om.probabilityToAmerican(0.4), 150);
});

test('nested ESPN odds: close values are the current line', () => {
  const { provider, markets } = espn.normalizeEspnOdds(nestedOdds);
  assert.equal(provider, 'DraftKings');
  assert.equal(markets.moneyline.home.american, -142);
  assert.equal(markets.moneyline.away.american, 120);
  assert.equal(markets.spread.home.line, -2.5);
  assert.equal(markets.spread.home.american, -115);
  assert.equal(markets.spread.away.line, 2.5);
  assert.equal(markets.spread.away.american, -105);
  assert.equal(markets.total.over.line, 42.5);
  assert.equal(markets.total.over.american, -112);
  assert.equal(markets.total.under.line, 42.5);
  assert.equal(markets.total.under.american, -108);
  assert.equal(markets.moneyline.home.source, 'espn');
});

test('flat ESPN odds fallback, missing prices default to -110, empty odds', () => {
  const { markets } = espn.normalizeEspnOdds(flatOdds);
  assert.equal(markets.moneyline.home.american, -160);
  assert.equal(markets.spread.home.line, -3);
  assert.equal(markets.spread.away.line, 3);
  assert.equal(markets.total.over.line, 47);
  assert.equal(markets.total.over.american, -110, 'no over price → -110');
  const partial = espn.normalizeEspnOdds({ provider: { name: 'X' }, pointSpread: { home: { close: { line: '-7' } } } });
  assert.equal(partial.markets.spread.home.american, -110);
  assert.equal(partial.markets.spread.away.line, 7);
  assert.equal(partial.markets.moneyline.home, null);
  assert.equal(espn.normalizeEspnOdds(undefined), null);
});

test('event normalization: pre / live / final / postponed / no odds', () => {
  const pre = espn.normalizeEspnEvent(event({ id: '10', date: '2026-10-18T17:00Z', odds: nestedOdds }), 'nfl');
  assert.equal(pre.state, 'pre');
  assert.equal(pre.home.name, 'Houston Texans');
  assert.equal(pre.home.shortName, 'Texans');
  assert.equal(pre.away.abbr, 'JAX');
  assert.ok(pre.home.logoDark.includes('dark'));
  assert.equal(pre.home.score, null, 'no score before start');
  assert.equal(pre.markets.moneyline.home.american, -142);
  assert.equal(pre.oddsNote, null);
  assert.equal(pre.bettingClosed, false);
  assert.equal(pre.startTime, '2026-10-18T17:00:00.000Z');

  const live = espn.normalizeEspnEvent(event({ id: '11', date: '2026-10-16T17:00Z', state: 'in', name: 'STATUS_IN_PROGRESS', detail: 'Q3 4:12', homeScore: '17', awayScore: '14', odds: nestedOdds }), 'nfl');
  assert.equal(live.state, 'in');
  assert.equal(live.statusText, 'Q3 4:12');
  assert.equal(live.home.score, 17);
  assert.equal(live.markets.moneyline.home, null, 'ESPN pre-game odds are never shown live');
  assert.equal(live.oddsNote, 'Live prices unavailable');
  assert.equal(live.bettingClosed, true);

  const fin = espn.normalizeEspnEvent(event({ id: '12', date: '2026-10-15T17:00Z', state: 'post', name: 'STATUS_FINAL', detail: 'Final/OT', homeScore: '20', awayScore: '23' }), 'nfl');
  assert.equal(fin.completed, true);
  assert.equal(fin.away.score, 23);
  assert.equal(fin.oddsNote, null);

  const pp = espn.normalizeEspnEvent(event({ id: '13', date: '2026-10-18T17:00Z', state: 'post', name: 'STATUS_POSTPONED', detail: 'Postponed' }), 'mlb');
  assert.equal(pp.canceled, true);

  const none = espn.normalizeEspnEvent(event({ id: '14', date: '2026-10-18T17:00Z' }), 'ncaaf');
  assert.equal(none.oddsNote, 'Odds unavailable');
  assert.ok(!espn.hasAnyQuote(none.markets));

  assert.equal(espn.normalizeEspnEvent({ id: 'x', competitions: [] }, 'nfl'), null);
});

function fakeFetch(handler) {
  const calls = [];
  const impl = async (u) => {
    calls.push(u);
    const r = await handler(new URL(u));
    if (r instanceof Error) throw r;
    return { ok: r.status ? r.status < 400 : true, status: r.status ?? 200, json: async () => r.body };
  };
  return { impl, calls };
}

test('central time dates for ?dates= (including DST change on Nov 1)', () => {
  const lateFri = new Date('2026-10-17T03:30:00Z'); // 10:30 PM CDT Fri Oct 16
  assert.equal(centralYmd(0, lateFri), '20261016');
  assert.equal(centralYmd(-1, lateFri), '20261015');
  assert.equal(centralYmd(2, lateFri), '20261018');
  const afterDst = new Date('2026-11-02T05:30:00Z'); // 11:30 PM CST Sun Nov 1
  assert.equal(centralYmd(0, afterDst), '20261101');
  assert.equal(centralDateKey('2026-10-17T03:30:00Z'), '2026-10-16');
});

test('daily league: one call per day, dedupe, drop yesterday finals, keep yesterday live games, partial flag', async () => {
  const now = new Date('2026-10-16T20:00:00Z');
  const { impl, calls } = fakeFetch((u) => {
    const d = u.searchParams.get('dates');
    if (d === '20261015') return { body: { events: [
      event({ id: 'y-final', date: '2026-10-15T23:00Z', state: 'post', name: 'STATUS_FINAL' }),
      event({ id: 'y-live', date: '2026-10-16T04:00Z', state: 'in', name: 'STATUS_IN_PROGRESS' }),
    ] } };
    if (d === '20261016') return { body: { events: [
      event({ id: 'y-live', date: '2026-10-16T04:00Z', state: 'in' }),
      event({ id: 't1', date: '2026-10-16T23:10Z', odds: nestedOdds }),
    ] } };
    if (d === '20261017') return { body: { events: [event({ id: 't2', date: '2026-10-17T23:10Z' })] } };
    if (d === '20261018') return new Error('timeout');
    throw new Error(`unexpected ${u}`);
  });
  const { games, partial } = await espn.fetchLeagueGames({ id: 'nhl', espnPath: 'hockey/nhl', schedule: 'daily', espnParams: {} }, { now, fetchImpl: impl });
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.includes('/hockey/nhl/scoreboard?dates=')));
  assert.deepEqual(games.map((g) => g.id).sort(), ['t1', 't2', 'y-live']);
  assert.equal(partial, true);

  const allFail = fakeFetch(() => new Error('down'));
  await assert.rejects(espn.fetchLeagueGames({ id: 'nhl', espnPath: 'hockey/nhl', schedule: 'daily', espnParams: {} }, { now, fetchImpl: allFail.impl }));
});

test('weekly league: college uses groups=80&limit=300', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: { events: [event({ id: 'c1', date: '2026-10-17T16:00Z' })] } }));
  const { games } = await espn.fetchLeagueGames({ id: 'ncaaf', espnPath: 'football/college-football', schedule: 'week', espnParams: { groups: '80', limit: '300' } }, { fetchImpl: impl });
  assert.equal(calls.length, 1);
  const u = new URL(calls[0]);
  assert.equal(u.pathname, '/apis/site/v2/sports/football/college-football/scoreboard');
  assert.equal(u.searchParams.get('groups'), '80');
  assert.equal(u.searchParams.get('limit'), '300');
  assert.equal(games[0].league, 'ncaaf');
});

test('custom games: open before start, closed at start (server clock), final; on the Custom board (every league), not the league boards', async () => {
  const start = new Date('2026-10-16T22:00:00Z');
  const data = {
    league: 'nfl', startTime: { toDate: () => start }, status: 'scheduled',
    home: { name: 'Backyard Bears', abbr: 'BYB' }, away: { name: 'Porch Pirates', abbr: 'PP' },
    odds: { moneyline: { home: -150, away: 130 }, spread: { homeLine: -3.5, home: -110, away: -110 }, total: { line: 44.5, over: -110, under: -110 } },
    finalScore: { home: null, away: null },
  };
  const before = normalizeCustomGame('abc', data, new Date(start.getTime() - 1000));
  assert.equal(before.id, 'custom:abc');
  assert.equal(before.state, 'pre');
  assert.equal(before.markets.spread.away.line, 3.5);
  assert.equal(before.markets.total.under.line, 44.5);
  assert.equal(before.bettingClosed, false);

  const atStart = normalizeCustomGame('abc', data, start);
  assert.equal(atStart.bettingClosed, true);
  assert.equal(atStart.oddsNote, 'Closed');
  assert.equal(atStart.markets.moneyline.home, null);

  const fin = normalizeCustomGame('abc', { ...data, status: 'final', finalScore: { home: 24, away: 17 } }, new Date(start.getTime() + 3600e3));
  assert.equal(fin.state, 'post');
  assert.equal(fin.home.score, 24);

  store.set('customGames/abc', { ...data, startTime: start.toISOString() });
  store.set('customGames/other', { ...data, league: 'nba', startTime: start.toISOString() });
  const { impl } = fakeFetch(() => ({ body: { events: [
    event({ id: 'late', date: '2026-10-17T00:15Z', odds: nestedOdds }),
    event({ id: 'early', date: '2026-10-16T17:00Z', odds: nestedOdds }),
  ] } }));
  const board = await buildBoard('nfl', { now: new Date('2026-10-16T12:00:00Z'), fetchImpl: impl });
  assert.deepEqual(board.games.map((g) => g.id), ['early', 'late'], 'league boards carry ESPN games only');
  const customBoard = await buildCustomBoard({ now: new Date('2026-10-16T12:00:00Z') });
  assert.deepEqual(customBoard.games.map((g) => [g.id, g.league]).sort(), [['custom:abc', 'nfl'], ['custom:other', 'nba']], 'the Custom board has every league');
  store.delete('customGames/abc');
  store.delete('customGames/other');
});

test('cache: memory hit, shared Firestore hit, rebuild after 30s, stale fallback, one build for concurrent callers', async () => {
  cache.clearMemoryCache();
  store.delete('cache/board_test');
  let t = 1_000_000;
  const now = () => t;
  let builds = 0;
  const builder = async () => { builds += 1; return { games: [{ id: String(builds), note: undefined }] }; };

  let r = await cache.getOrRefresh('board_test', 30000, builder, { now });
  assert.equal(r.cacheHit, 'none');
  assert.equal(builds, 1);
  assert.ok(!('note' in r.value.games[0]), 'undefined stripped before Firestore write');
  assert.equal(store.get('cache/board_test').fetchedAtMs, 1_000_000);

  t += 10_000;
  r = await cache.getOrRefresh('board_test', 30000, builder, { now });
  assert.equal(r.cacheHit, 'memory');

  cache.clearMemoryCache(); // simulate another function instance
  r = await cache.getOrRefresh('board_test', 30000, builder, { now });
  assert.equal(r.cacheHit, 'firestore');
  assert.equal(builds, 1, 'second instance reuses the shared copy');

  t += 25_000; // 35s old
  r = await cache.getOrRefresh('board_test', 30000, builder, { now });
  assert.equal(r.cacheHit, 'none');
  assert.equal(builds, 2);

  t += 31_000;
  r = await cache.getOrRefresh('board_test', 30000, async () => { throw new Error('ESPN down'); }, { now });
  assert.equal(r.stale, true);
  assert.equal(r.value.games[0].id, '2');

  cache.clearMemoryCache();
  store.delete('cache/board_none');
  await assert.rejects(cache.getOrRefresh('board_none', 30000, async () => { throw new Error('down'); }, { now }));

  cache.clearMemoryCache();
  t += 100_000;
  let concurrentBuilds = 0;
  const slow = async () => { concurrentBuilds += 1; await new Promise((res) => setTimeout(res, 20)); return { games: [] }; };
  await Promise.all([1, 2, 3, 4, 5].map(() => cache.getOrRefresh('board_test', 30000, slow, { now })));
  assert.equal(concurrentBuilds, 1, 'concurrent requests share one upstream fetch');

  cache.clearMemoryCache();
  failCacheReads = true;
  t += 100_000;
  r = await cache.getOrRefresh('board_test', 30000, builder, { now });
  assert.equal(r.cacheHit, 'none', 'Firestore read failure still rebuilds');
  failCacheReads = false;
});

test('/api/board: auth, league validation, 502 when ESPN is down with no cache, success payload', async () => {
  const handler = (await import(url('api/board.js'))).default;
  const res = () => ({ statusCode: 200, headers: {}, body: null, headersSent: false,
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } });

  signedIn = false;
  let r = res(); await handler({ method: 'GET', query: { league: 'nfl' }, headers: {} }, r);
  assert.equal(r.statusCode, 401);
  signedIn = true;

  r = res(); await handler({ method: 'GET', query: { league: 'xfl' }, headers: {} }, r);
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error.code, 'BAD_LEAGUE');

  r = res(); await handler({ method: 'POST', query: { league: 'nfl' }, headers: {} }, r);
  assert.equal(r.statusCode, 405);

  cache.clearMemoryCache();
  store.delete('cache/board_nba');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('blocked'); };
  r = res(); await handler({ method: 'GET', url: '/api/board?league=NBA', headers: {} }, r);
  assert.equal(r.statusCode, 502);
  assert.equal(r.body.error.code, 'UPSTREAM_UNAVAILABLE');

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ events: [event({ id: 'n1', date: '2026-10-17T00:00Z', odds: nestedOdds })] }) });
  cache.clearMemoryCache();
  r = res(); await handler({ method: 'GET', query: { league: 'nba' }, headers: {} }, r);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.league, 'nba');
  assert.equal(r.body.stale, false);
  assert.ok(r.body.games.some((g) => g.id === 'n1'));
  assert.equal(r.headers['Cache-Control'], 'no-store');
  globalThis.fetch = realFetch;
});
