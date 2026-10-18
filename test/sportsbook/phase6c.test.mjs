// npm run test:sportsbook  (or: node --experimental-test-module-mocks test/sportsbook/phase6c.test.mjs)
// Back-to-back same-opponent games: each ESPN game must get its own day's Kalshi events.
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

const k = await import(url('server/sources/kalshi.js'));
const tm = await import(url('server/teamMatch.js'));
const { buildBoard } = await import(url('server/board.js'));
const { getGameDetail } = await import(url('server/gameDetail.js'));
const { priceLeg } = await import(url('server/pricing.js'));
const cache = await import(url('server/cache.js'));
const { emptyMarkets } = await import(url('server/sources/espn.js'));

// ---------- builders ----------
function km(ticker, yesSub, yesAsk, noAsk, extra = {}) {
  return {
    ticker, yes_sub_title: yesSub, status: 'active',
    yes_ask_dollars: yesAsk.toFixed(4), no_ask_dollars: noAsk.toFixed(4),
    yes_bid_dollars: (yesAsk - 0.01).toFixed(4), no_bid_dollars: (noAsk - 0.01).toFixed(4), ...extra,
  };
}
const withParsed = (e) => ({ ...e, parsed: k.parseEventTicker(e.event_ticker) });
const team = (abbr, loc, nick) => ({ id: abbr, name: `${loc} ${nick}`, shortName: nick, nickname: nick, location: loc, abbr, logo: null, logoDark: null, score: null });
const game = (id, league, startTime, home, away, state = 'pre') => ({
  id, league, source: 'espn', startTime, state, statusText: '', canceled: false, bettingClosed: state !== 'pre', home, away, markets: emptyMarkets(), oddsNote: null,
});

// One full set of Kalshi events (winner, spread ladder, totals ladder) for one game slot.
// teams: [{ code, label }, { code, label }] in Kalshi's ticker order.
function kalshiSet(prefix, slot, teams, { spreadStrikes = [1.5, 2.5, 3.5], totalStrikes = [], unit = 'runs', status = 'active', winnerAsk = 0.45 } = {}) {
  const [a, b] = teams;
  const suffix = `${slot}${a.code}${b.code}`;
  const st = { status };
  const gameEv = {
    event_ticker: `${prefix}GAME-${suffix}`, title: `${a.label} vs ${b.label}`,
    markets: [
      km(`${prefix}GAME-${suffix}-${a.code}`, a.label, winnerAsk, 1.01 - winnerAsk, st),
      km(`${prefix}GAME-${suffix}-${b.code}`, b.label, 1.01 - winnerAsk, winnerAsk, st),
    ],
  };
  const spreadEv = {
    event_ticker: `${prefix}SPREAD-${suffix}`, title: `${a.label} vs ${b.label}: Spread`,
    markets: [a, b].flatMap((t, ti) => spreadStrikes.map((s, i) => {
      const ask = Math.max(0.1, (ti === 1 ? 0.42 : 0.3) - i * 0.08);
      return km(`${prefix}SPREAD-${suffix}-${t.code}${Math.ceil(s)}`, `${t.label} wins by over ${s} ${unit}`, ask, 1.01 - ask, { ...st, floor_strike: s });
    })),
  };
  const totalEv = {
    event_ticker: `${prefix}TOTAL-${suffix}`, title: `${a.label} vs ${b.label}: Total ${unit}`,
    markets: totalStrikes.map((s, i) => {
      const ask = Math.min(0.9, Math.max(0.1, 0.9 - i * 0.08));
      return km(`${prefix}TOTAL-${suffix}-${Math.ceil(s)}`, `Over ${s} ${unit}`, ask, 1.01 - ask, { ...st, floor_strike: s });
    }),
  };
  return { game: gameEv, spread: spreadEv, total: totalEv };
}
const match = (league, games, sets) => k.matchKalshiEntries({
  league, games,
  gameEvents: sets.map((s) => withParsed(s.game)),
  spreadEvents: sets.map((s) => withParsed(s.spread)),
  totalEvents: sets.map((s) => withParsed(s.total)),
});
const tickersOf = (entry) => entry && [entry.gameEvent?.event_ticker ?? null, entry.spreadEvent?.event_ticker ?? null, entry.totalEvent?.event_ticker ?? null];

// ---------- MLB: Rays at Guardians, three-game series ----------
const TB = team('TB', 'Tampa Bay', 'Rays');
const CLE = team('CLE', 'Cleveland', 'Guardians');
const RAYS_GUARDS = [{ code: 'TB', label: 'Tampa Bay' }, { code: 'CLE', label: 'Cleveland' }];
const TOTALS_1_TO_10 = [1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5, 10.5];
const MLB_YDAY = kalshiSet('KXMLB', '26OCT151800', RAYS_GUARDS, { totalStrikes: [7.5, 8.5] }); // finished, markets still trading
const MLB_TONIGHT = kalshiSet('KXMLB', '26OCT161800', RAYS_GUARDS, { totalStrikes: TOTALS_1_TO_10 });
const MLB_TOMORROW = kalshiSet('KXMLB', '26OCT171310', RAYS_GUARDS, { totalStrikes: [6.5, 7.5, 8.5] });

test('date distance: exact date beats the time-zone fallback; never a day earlier; HHMM ranks start times', () => {
  const tonight = '2026-10-16T22:00:00Z'; // 6:00 pm ET Oct 16
  assert.equal(tm.eventDistance({ dateKey: '2026-10-16', hhmm: '1800' }, tonight), 0);
  assert.equal(tm.eventDistance({ dateKey: '2026-10-15', hhmm: '1800' }, tonight), null, 'yesterday never matches tonight');
  assert.equal(tm.eventDistance({ dateKey: '2026-10-17', hhmm: '1310' }, tonight), null, 'tomorrow afternoon never matches tonight');
  assert.equal(tm.eventDistance({ dateKey: '2026-10-16', hhmm: '1310' }, tonight), 290, 'same day, 4h50m apart');
  const late = '2026-10-17T02:40:00Z'; // 10:40 pm ET Oct 16 (Oct 17 in UTC)
  assert.equal(tm.eventDistance('2026-10-16', late), 0);
  assert.ok(tm.eventDistance('2026-10-17', late) >= 100000, 'UTC-dated ticker is only a fallback');
  const hawaii = '2026-10-18T07:00:00Z'; // 9 pm HST Oct 17 = 2 am CT Oct 18
  assert.equal(tm.eventDistance('2026-10-18', hawaii), 0);
  assert.ok(tm.eventDistance('2026-10-17', hawaii) >= 100000, 'local Hawaii date still matches as fallback');
  assert.equal(tm.easternInstant('2026-10-16', '1800'), Date.parse('2026-10-16T22:00:00Z'), 'EDT');
  assert.equal(tm.easternInstant('2026-12-01', '1900'), Date.parse('2026-12-02T00:00:00Z'), 'EST');
});

test('MLB series: yesterday still trading and listed first → tonight and tomorrow each get their own events', () => {
  const games = [
    game('tonight', 'mlb', '2026-10-16T22:00:00Z', CLE, TB),
    game('tomorrow', 'mlb', '2026-10-17T17:10:00Z', CLE, TB),
  ];
  for (const order of [[MLB_YDAY, MLB_TONIGHT, MLB_TOMORROW], [MLB_TOMORROW, MLB_TONIGHT, MLB_YDAY]]) {
    const map = match('mlb', games, order);
    assert.deepEqual(tickersOf(map.get('tonight')), ['KXMLBGAME-26OCT161800TBCLE', 'KXMLBSPREAD-26OCT161800TBCLE', 'KXMLBTOTAL-26OCT161800TBCLE']);
    assert.deepEqual(tickersOf(map.get('tomorrow')), ['KXMLBGAME-26OCT171310TBCLE', 'KXMLBSPREAD-26OCT171310TBCLE', 'KXMLBTOTAL-26OCT171310TBCLE']);
    assert.deepEqual(map.get('tonight').sideByCode, { TB: 'away', CLE: 'home' });
  }
});

test('MLB: tonight not listed yet → tonight gets nothing rather than yesterday\'s markets', () => {
  const games = [game('tonight', 'mlb', '2026-10-16T22:00:00Z', CLE, TB), game('tomorrow', 'mlb', '2026-10-17T17:10:00Z', CLE, TB)];
  const map = match('mlb', games, [MLB_YDAY, MLB_TOMORROW]);
  assert.equal(map.has('tonight'), false);
  assert.equal(map.get('tomorrow').gameEvent.event_ticker, 'KXMLBGAME-26OCT171310TBCLE');
});

test('MLB: yesterday\'s game still on the board (ran past midnight) keeps yesterday\'s events', () => {
  const games = [game('yday', 'mlb', '2026-10-15T22:00:00Z', CLE, TB, 'in'), game('tonight', 'mlb', '2026-10-16T22:00:00Z', CLE, TB)];
  const map = match('mlb', games, [MLB_TONIGHT, MLB_YDAY]);
  assert.equal(map.get('yday').spreadEvent.event_ticker, 'KXMLBSPREAD-26OCT151800TBCLE');
  assert.equal(map.get('tonight').spreadEvent.event_ticker, 'KXMLBSPREAD-26OCT161800TBCLE');
});

test('MLB doubleheader: ticker start time picks the right game', () => {
  const g1 = kalshiSet('KXMLB', '26OCT161310', RAYS_GUARDS, { totalStrikes: [7.5] });
  const g2 = kalshiSet('KXMLB', '26OCT161840', RAYS_GUARDS, { totalStrikes: [8.5] });
  const games = [game('dh1', 'mlb', '2026-10-16T17:10:00Z', CLE, TB), game('dh2', 'mlb', '2026-10-16T22:40:00Z', CLE, TB)];
  for (const order of [[g1, g2], [g2, g1]]) {
    const map = match('mlb', games, order);
    assert.deepEqual(tickersOf(map.get('dh1')), ['KXMLBGAME-26OCT161310TBCLE', 'KXMLBSPREAD-26OCT161310TBCLE', 'KXMLBTOTAL-26OCT161310TBCLE']);
    assert.deepEqual(tickersOf(map.get('dh2')), ['KXMLBGAME-26OCT161840TBCLE', 'KXMLBSPREAD-26OCT161840TBCLE', 'KXMLBTOTAL-26OCT161840TBCLE']);
  }
});

test('NBA home-and-home back-to-back (venue flips) with the day before still trading', () => {
  const BOS = team('BOS', 'Boston', 'Celtics');
  const PHI = team('PHI', 'Philadelphia', '76ers');
  const bp = [{ code: 'BOS', label: 'Boston' }, { code: 'PHI', label: 'Philadelphia' }];
  const pb = [{ code: 'PHI', label: 'Philadelphia' }, { code: 'BOS', label: 'Boston' }];
  const sets = [
    kalshiSet('KXNBA', '26OCT15', bp, { unit: 'points', totalStrikes: [221.5] }),
    kalshiSet('KXNBA', '26OCT16', bp, { unit: 'points', totalStrikes: [224.5] }),
    kalshiSet('KXNBA', '26OCT17', pb, { unit: 'points', totalStrikes: [226.5] }),
  ];
  const games = [
    game('at-phi', 'nba', '2026-10-16T23:30:00Z', PHI, BOS), // Fri 7:30 pm ET in Philadelphia
    game('at-bos', 'nba', '2026-10-17T23:30:00Z', BOS, PHI), // Sat 7:30 pm ET in Boston
  ];
  const map = match('nba', games, sets);
  assert.deepEqual(tickersOf(map.get('at-phi')), ['KXNBAGAME-26OCT16BOSPHI', 'KXNBASPREAD-26OCT16BOSPHI', 'KXNBATOTAL-26OCT16BOSPHI']);
  assert.deepEqual(tickersOf(map.get('at-bos')), ['KXNBAGAME-26OCT17PHIBOS', 'KXNBASPREAD-26OCT17PHIBOS', 'KXNBATOTAL-26OCT17PHIBOS']);
  assert.deepEqual(map.get('at-phi').sideByCode, { BOS: 'away', PHI: 'home' });
  assert.deepEqual(map.get('at-bos').sideByCode, { PHI: 'away', BOS: 'home' });
});

test('NHL back-to-back, late Mountain-time game (UTC date rolls over) with yesterday still trading', () => {
  const COL = team('COL', 'Colorado', 'Avalanche');
  const PIT = team('PIT', 'Pittsburgh', 'Penguins');
  const pc = [{ code: 'PIT', label: 'Pittsburgh' }, { code: 'COL', label: 'Colorado' }];
  const yday = kalshiSet('KXNHL', '26OCT15', pc, { unit: 'goals', totalStrikes: [5.5] });
  const tonight = kalshiSet('KXNHL', '26OCT16', pc, { unit: 'goals', totalStrikes: [6.5] });
  const games = [game('tonight', 'nhl', '2026-10-17T01:00:00Z', COL, PIT)]; // 7 pm MT Oct 16
  assert.deepEqual(tickersOf(match('nhl', games, [yday, tonight]).get('tonight')), ['KXNHLGAME-26OCT16PITCOL', 'KXNHLSPREAD-26OCT16PITCOL', 'KXNHLTOTAL-26OCT16PITCOL']);
  assert.equal(match('nhl', games, [yday]).size, 0, 'yesterday alone never matches tonight');
});

test('events with no active markets are skipped (finished games)', () => {
  const games = [game('tonight', 'mlb', '2026-10-16T22:00:00Z', CLE, TB)];
  const done = kalshiSet('KXMLB', '26OCT161800', RAYS_GUARDS, { status: 'finalized', totalStrikes: [8.5] });
  assert.equal(match('mlb', games, [done]).size, 0);
  const partlyDone = { ...MLB_TONIGHT, spread: { ...MLB_TONIGHT.spread, markets: MLB_TONIGHT.spread.markets.map((m) => ({ ...m, status: 'closed' })) } };
  const entry = match('mlb', games, [partlyDone]).get('tonight');
  assert.equal(entry.gameEvent.event_ticker, 'KXMLBGAME-26OCT161800TBCLE');
  assert.equal(entry.spreadEvent, null, 'spread event with only closed markets is not attached');
});

test('a game never mixes days: kinds must share the closest event\'s slot', () => {
  const HOU = team('HOU', 'Houston', 'Texans');
  const JAX = team('JAX', 'Jacksonville', 'Jaguars');
  const hj = [{ code: 'HOU', label: 'Houston' }, { code: 'JAC', label: 'Jacksonville' }];
  const sun = kalshiSet('KXNFL', '26OCT18', hj, { unit: 'points', totalStrikes: [42.5] });
  const mon = kalshiSet('KXNFL', '26OCT19', hj, { unit: 'points', totalStrikes: [44.5] }); // same teams, next day
  const games = [game('snf', 'nfl', '2026-10-19T00:20:00Z', JAX, HOU)]; // 8:20 pm ET Sunday = Monday UTC
  const map = k.matchKalshiEntries({
    league: 'nfl', games,
    gameEvents: [withParsed(sun.game)], spreadEvents: [withParsed(mon.spread)], totalEvents: [withParsed(sun.total), withParsed(mon.total)],
  });
  assert.deepEqual(tickersOf(map.get('snf')), ['KXNFLGAME-26OCT18HOUJAC', null, 'KXNFLTOTAL-26OCT18HOUJAC'], 'Monday-dated spread is not attached to Sunday\'s winner market');
});

// ---------- end to end: board → game page → bet placement ----------
function espnEvent(id, date, state) {
  const t = (abbr, loc, nick) => ({ id: abbr, abbreviation: abbr, displayName: `${loc} ${nick}`, shortDisplayName: nick, name: nick, location: loc });
  return {
    id, date,
    status: { type: { state, name: state === 'post' ? 'STATUS_FINAL' : 'STATUS_SCHEDULED', shortDetail: 'x', completed: state === 'post' } },
    competitions: [{ competitors: [
      { homeAway: 'home', score: '0', team: t('CLE', 'Cleveland', 'Guardians') },
      { homeAway: 'away', score: '0', team: t('TB', 'Tampa Bay', 'Rays') },
    ] }],
  };
}
const ESPN_BY_DATE = {
  20261015: [espnEvent('g15', '2026-10-15T22:00:00Z', 'post')],
  20261016: [espnEvent('g16', '2026-10-16T22:00:00Z', 'pre')],
  20261017: [espnEvent('g17', '2026-10-17T17:10:00Z', 'pre')],
};
const ALL_EVENTS = [MLB_YDAY, MLB_TONIGHT, MLB_TOMORROW]; // Kalshi lists the oldest first
function mlbFetch() {
  return async (u) => {
    const p = new URL(u);
    if (p.host === 'site.api.espn.com') {
      return { ok: true, status: 200, json: async () => ({ events: ESPN_BY_DATE[p.searchParams.get('dates')] ?? [] }) };
    }
    if (p.pathname.endsWith('/events')) {
      const kind = { KXMLBGAME: 'game', KXMLBSPREAD: 'spread', KXMLBTOTAL: 'total' }[p.searchParams.get('series_ticker')];
      return { ok: true, status: 200, json: async () => ({ events: ALL_EVENTS.map((s) => s[kind]), cursor: '' }) };
    }
    throw new Error(`unexpected ${u}`);
  };
}
const NOW = new Date('2026-10-16T20:00:00Z'); // Friday afternoon

test('board + game page: tonight\'s Rays–Guardians shows ±1.5/2.5/3.5 run spreads and totals 1.5–10.5', async () => {
  cache.clearMemoryCache();
  store.clear();
  const board = await buildBoard('mlb', { now: NOW, fetchImpl: mlbFetch() });
  const ids = board.games.map((g) => g.id).sort();
  assert.deepEqual(ids, ['g16', 'g17'], 'yesterday\'s finished game drops off');
  const g16 = board.games.find((g) => g.id === 'g16');
  assert.deepEqual(g16.kalshi, {
    gameEvent: 'KXMLBGAME-26OCT161800TBCLE', spreadEvent: 'KXMLBSPREAD-26OCT161800TBCLE', totalEvent: 'KXMLBTOTAL-26OCT161800TBCLE',
    sideByCode: { TB: 'away', CLE: 'home' },
  });
  assert.equal(board.games.find((g) => g.id === 'g17').kalshi.gameEvent, 'KXMLBGAME-26OCT171310TBCLE');
  assert.ok(g16.markets.moneyline.home.ref.ticker.startsWith('KXMLBGAME-26OCT161800TBCLE-'), 'main line from tonight');

  const detail = await getGameDetail('mlb', 'g16', { fetchImpl: mlbFetch(), now: () => NOW });
  const lines = (qs) => qs.map((q) => q.line);
  assert.deepEqual(lines(detail.ladders.spreads.home), [-3.5, -2.5, -1.5, 1.5, 2.5, 3.5], 'Guardians');
  assert.deepEqual(lines(detail.ladders.spreads.away), [-3.5, -2.5, -1.5, 1.5, 2.5, 3.5], 'Rays');
  const clem15 = detail.ladders.spreads.home.find((q) => q.line === -1.5);
  assert.deepEqual([clem15.ref.ticker, clem15.ref.side], ['KXMLBSPREAD-26OCT161800TBCLE-CLE2', 'yes'], 'Guardians -1.5 = YES "Cleveland wins by over 1.5 runs"');
  assert.deepEqual(detail.ladders.totals.map((r) => r.line), TOTALS_1_TO_10);
  const all = [...detail.ladders.spreads.home, ...detail.ladders.spreads.away, ...detail.ladders.totals.flatMap((r) => [r.over, r.under])].filter(Boolean);
  assert.ok(all.every((q) => q.ref.ticker.includes('-26OCT161800TBCLE-')), 'every alternate is tonight\'s market');
});

test('bet placement: a ticker from yesterday\'s (or tomorrow\'s) game is refused; tonight\'s prices', async () => {
  cache.clearMemoryCache();
  store.clear();
  const board = await buildBoard('mlb', { now: NOW, fetchImpl: mlbFetch() });
  const g16 = board.games.find((g) => g.id === 'g16');
  const allMarkets = new Map(ALL_EVENTS.flatMap((s) => [s.game, s.spread, s.total]).flatMap((e) => e.markets.map((m) => [m.ticker, { ...m, event_ticker: e.event_ticker }])));
  const ctx = (overrides = {}) => ({
    now: NOW, board: async () => board, freshEspnGames: async () => board.games, freshKalshiForGames: async () => new Map(),
    market: async (t) => overrides[t] ?? allMarkets.get(t) ?? null, customGame: async () => null,
  });
  const leg = (ticker, line = -1.5) => ({ league: 'mlb', gameId: 'g16', marketType: 'spread', selection: 'home', line, kalshiTicker: ticker, kalshiSide: 'yes' });

  assert.ok(!k.marketMatchesLeg(g16.kalshi, { marketType: 'spread', selection: 'home' }, 'KXMLBSPREAD-26OCT151800TBCLE-CLE2', 'yes'), 'yesterday');
  assert.ok(!k.marketMatchesLeg(g16.kalshi, { marketType: 'spread', selection: 'home' }, 'KXMLBSPREAD-26OCT171310TBCLE-CLE2', 'yes'), 'tomorrow');
  assert.ok(k.marketMatchesLeg(g16.kalshi, { marketType: 'spread', selection: 'home' }, 'KXMLBSPREAD-26OCT161800TBCLE-CLE2', 'yes'), 'tonight');

  let r = await priceLeg(leg('KXMLBSPREAD-26OCT151800TBCLE-CLE2'), ctx());
  assert.equal(r.status, 'closed');
  assert.match(r.reason, /not offered/);
  r = await priceLeg({ ...leg('KXMLBGAME-26OCT151800TBCLE-CLE'), marketType: 'moneyline', line: null }, ctx());
  assert.equal(r.status, 'closed', 'yesterday\'s moneyline too');

  r = await priceLeg(leg('KXMLBSPREAD-26OCT161800TBCLE-CLE2'), ctx());
  assert.equal(r.status, 'ok');
  assert.equal(r.quote.ref.ticker, 'KXMLBSPREAD-26OCT161800TBCLE-CLE2');
  assert.equal(r.quote.line, -1.5);

  // Fresh market answers for a different event than the board mapped → refused.
  const t = 'KXMLBSPREAD-26OCT161800TBCLE-CLE2';
  r = await priceLeg(leg(t), ctx({ [t]: { ...allMarkets.get(t), event_ticker: 'KXMLBSPREAD-26OCT151800TBCLE' } }));
  assert.equal(r.status, 'closed');
  assert.match(r.reason, /not offered/);
});

test('fresh live lookup (pricing fallback) uses the same corrected matching', () => {
  const games = [game('tonight', 'mlb', '2026-10-16T22:00:00Z', CLE, TB, 'in')];
  const markets = k.attachKalshiToGames({
    league: 'mlb', games,
    gameEvents: ALL_EVENTS.map((s) => withParsed(s.game)), spreadEvents: ALL_EVENTS.map((s) => withParsed(s.spread)), totalEvents: ALL_EVENTS.map((s) => withParsed(s.total)),
  }).get('tonight');
  for (const q of [markets.moneyline.home, markets.moneyline.away, markets.spread.home, markets.spread.away, markets.total.over, markets.total.under]) {
    assert.ok(q && q.ref.ticker.includes('-26OCT161800TBCLE-'), `${q?.ref?.ticker} is tonight's`);
  }
});
