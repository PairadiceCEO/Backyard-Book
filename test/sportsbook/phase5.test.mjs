// npm run test:sportsbook  (or: node --experimental-test-module-mocks test/sportsbook/phase5.test.mjs)
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;

const store = new Map();
const fakeDb = {
  collection(name) {
    return {
      doc: (id) => ({ async get() { const d = store.get(`${name}/${id}`); return { exists: !!d, data: () => d }; }, async set(v) { store.set(`${name}/${id}`, v); } }),
      where: () => ({ async get() { return { forEach() {} }; } }),
    };
  },
};
mock.module(url('server/firebaseAdmin.js'), { namedExports: { adminDb: () => fakeDb, adminAuth: () => ({}), normalizePrivateKey: (k) => k } });

const k = await import(url('server/sources/kalshi.js'));
const tm = await import(url('server/teamMatch.js'));
const { mergeGameMarkets, buildBoard } = await import(url('server/board.js'));
const { emptyMarkets } = await import(url('server/sources/espn.js'));
const { groupShopPurchases } = await import(url('src/lib/shopHistory.js'));

// ---------- helpers ----------
function espnTeam(abbr, displayName, shortName, nickname, location) {
  return { id: abbr, name: displayName, shortName, nickname, location, abbr, logo: null, logoDark: null, score: null };
}
function espnGame(id, startTime, home, away, state = 'pre', markets = emptyMarkets()) {
  return { id, league: 'nfl', source: 'espn', startTime, state, statusText: '', canceled: false, bettingClosed: state !== 'pre', home, away, markets, oddsNote: null };
}
const HOU = espnTeam('HOU', 'Houston Texans', 'Texans', 'Texans', 'Houston');
const JAX = espnTeam('JAX', 'Jacksonville Jaguars', 'Jaguars', 'Jaguars', 'Jacksonville');
const BAL = espnTeam('BAL', 'Baltimore Ravens', 'Ravens', 'Ravens', 'Baltimore');
const CLE = espnTeam('CLE', 'Cleveland Browns', 'Browns', 'Browns', 'Cleveland');
const CAR = espnTeam('CAR', 'Carolina Panthers', 'Panthers', 'Panthers', 'Carolina');
const PHI = espnTeam('PHI', 'Philadelphia Eagles', 'Eagles', 'Eagles', 'Philadelphia');

// Kalshi market with no_bid derived like the real API (1 - yes_ask) unless given.
function km(ticker, yesSub, yesAsk, noAsk, extra = {}) {
  return {
    ticker, yes_sub_title: yesSub, no_sub_title: yesSub, status: 'active',
    yes_ask_dollars: yesAsk.toFixed(4), no_ask_dollars: noAsk.toFixed(4),
    yes_bid_dollars: (yesAsk - 0.01).toFixed(4), no_bid_dollars: (noAsk - 0.01).toFixed(4),
    updated_time: '2026-10-18T17:30:00Z', // after the live game's start (stale-market guard)
    ...extra,
  };
}
function withParsed(event) {
  return { ...event, parsed: k.parseEventTicker(event.event_ticker) };
}

// ---------- real Kalshi data (fetched Oct 16, 2026) ----------
const GAME_HOUJAC = {
  event_ticker: 'KXNFLGAME-26OCT18HOUJAC', title: 'HOU Texans vs JAC Jaguars',
  markets: [km('KXNFLGAME-26OCT18HOUJAC-JAC', 'Jacksonville', 0.57, 0.44), km('KXNFLGAME-26OCT18HOUJAC-HOU', 'Houston', 0.44, 0.57)],
};
const GAME_BALCLE = {
  event_ticker: 'KXNFLGAME-26OCT18BALCLE', title: 'BAL Ravens vs CLE Browns',
  markets: [km('KXNFLGAME-26OCT18BALCLE-CLE', 'Cleveland', 0.39, 0.62), km('KXNFLGAME-26OCT18BALCLE-BAL', 'Baltimore', 0.62, 0.39)],
};
const GAME_CARPHI = {
  event_ticker: 'KXNFLGAME-26OCT18CARPHI', title: 'CAR Panthers vs PHI Eagles',
  markets: [km('KXNFLGAME-26OCT18CARPHI-PHI', 'Philadelphia', 0.38, 0.63), km('KXNFLGAME-26OCT18CARPHI-CAR', 'Carolina', 0.63, 0.38)],
};
const spreadRows = [
  ['JAC21', 'Jacksonville', 20.5, 0.08, 0.93], ['JAC11', 'Jacksonville', 10.5, 0.23, 0.78], ['JAC7', 'Jacksonville', 6.5, 0.35, 0.66],
  ['JAC4', 'Jacksonville', 3.5, 0.43, 0.58], ['JAC3', 'Jacksonville', 2.5, 0.52, 0.49], ['JAC2', 'Jacksonville', 1.5, 0.55, 0.46],
  ['HOU2', 'Houston', 1.5, 0.41, 0.60], ['HOU3', 'Houston', 2.5, 0.39, 0.62], ['HOU4', 'Houston', 3.5, 0.31, 0.70],
];
const SPREAD_HOUJAC = {
  event_ticker: 'KXNFLSPREAD-26OCT18HOUJAC', title: 'Houston vs Jacksonville: Spread',
  markets: spreadRows.map(([code, team, strike, y, n]) =>
    km(`KXNFLSPREAD-26OCT18HOUJAC-${code}`, `${team} wins by over ${strike} points`, y, n, { floor_strike: strike, strike_type: 'greater' })),
};
const TOTAL_HOUJAC = {
  event_ticker: 'KXNFLTOTAL-26OCT18HOUJAC', title: 'HOU Texans vs JAC Jaguars: Total Points',
  markets: [[38.5, 0.71, 0.31], [41.5, 0.58, 0.44], [42.5, 0.51, 0.51], [44.5, 0.42, 0.60]].map(([s, y, n]) =>
    km(`KXNFLTOTAL-26OCT18HOUJAC-${Math.ceil(s)}`, `Over ${s} points`, y, n, { floor_strike: s, strike_type: 'greater' })),
};

test('ticker parsing: standard, MLB with start time, bad input', () => {
  assert.deepEqual(k.parseEventTicker('KXNBAGAME-26OCT16BOSPHI'), { series: 'KXNBAGAME', suffix: '26OCT16BOSPHI', dateKey: '2026-10-16', hhmm: null });
  assert.deepEqual(k.parseEventTicker('KXMLBGAME-26OCT161800TBCLE'), { series: 'KXMLBGAME', suffix: '26OCT161800TBCLE', dateKey: '2026-10-16', hhmm: '1800' });
  assert.equal(k.parseEventTicker('KXNFLSPREAD-26OCT18HOUJAC').suffix, '26OCT18HOUJAC');
  assert.equal(k.parseEventTicker('garbage'), null);
  assert.equal(k.parseEventTicker('KXNFLGAME-26XYZ18HOUJAC'), null);
});

test('name normalization and team scoring (cities, schools, St., codes)', () => {
  assert.equal(tm.normalizeName('Appalachian St.'), 'appalachian state');
  assert.equal(tm.normalizeName('Miami (OH)'), 'miami oh');
  assert.equal(tm.normalizeName("Hawai'i"), 'hawaii');
  assert.ok(tm.scoreTeam('Jacksonville', 'JAC', JAX, 'nfl') >= 3, 'city label matches location');
  assert.equal(tm.scoreTeam('Houston', 'HOU', JAX, 'nfl'), 0);
  assert.ok(tm.scoreTeam('CAR Panthers', 'CAR', CAR, 'nfl') >= 3, 'nickname inside "CAR Panthers"');
  const app = espnTeam('APP', 'App State Mountaineers', 'App State', 'Mountaineers', 'App State');
  assert.ok(tm.scoreTeam('Appalachian St.', 'APP', app, 'ncaaf') > 0, 'alias / code rescue App State');
});

test('matching: real NFL events, date window, either team order, crosstown teams', () => {
  const games = [
    espnGame('g1', '2026-10-18T17:00:00Z', HOU, JAX),
    espnGame('g2', '2026-10-18T17:00:00Z', CLE, BAL),
  ];
  const sides = [{ label: 'Jacksonville', code: 'JAC' }, { label: 'Houston', code: 'HOU' }];
  let m = tm.matchTeamsToGame(sides, '2026-10-18', games, 'nfl');
  assert.equal(m.game.id, 'g1');
  assert.deepEqual(m.sideOf, ['away', 'home'], 'Kalshi lists JAC first, ESPN has JAX away');

  assert.equal(tm.matchTeamsToGame(sides, '2026-10-25', games, 'nfl'), null, 'outside ±1 day');
  assert.equal(tm.matchTeamsToGame(sides, '2026-10-19', games, 'nfl'), null, '1 pm kickoff is Oct 18 everywhere: an Oct 19 ticker is another game');
  const snf = [espnGame('snf', '2026-10-19T00:20:00Z', HOU, JAX)]; // 8:20 pm ET Oct 18 = Oct 19 in UTC
  assert.equal(tm.matchTeamsToGame(sides, '2026-10-19', snf, 'nfl').game.id, 'snf', 'late game crossing midnight (UTC) still matches');
  assert.equal(tm.matchTeamsToGame(sides, '2026-10-17', snf, 'nfl'), null, 'never a day earlier');

  const NYG = espnTeam('NYG', 'New York Giants', 'Giants', 'Giants', 'New York');
  const NYJ = espnTeam('NYJ', 'New York Jets', 'Jets', 'Jets', 'New York');
  const crosstown = [espnGame('ny', '2026-10-18T17:00:00Z', NYJ, NYG)];
  m = tm.matchTeamsToGame([{ label: 'New York', code: 'NYG' }, { label: 'New York', code: 'NYJ' }], '2026-10-18', crosstown, 'nfl');
  assert.deepEqual(m.sideOf, ['away', 'home'], 'team codes break the New York tie');
  m = tm.matchTeamsToGame([{ label: 'New York J', code: 'X1' }, { label: 'New York G', code: 'X2' }], '2026-10-18', crosstown, 'nfl');
  assert.deepEqual(m.sideOf, ['home', 'away'], 'aliases break it when codes differ');
  assert.equal(tm.matchTeamsToGame([{ label: 'New York', code: '' }, { label: 'New York', code: '' }], '2026-10-18', crosstown, 'nfl'), null, 'no guessing when ambiguous');
});

test('tradable price rules: active, $0.03–$0.97, bid-ask gap ≤ $0.15, derived bid', () => {
  assert.equal(k.tradablePrice(km('T', 'x', 0.52, 0.49), 'yes'), 0.52);
  assert.equal(k.tradablePrice({ ...km('T', 'x', 0.52, 0.49), status: 'closed' }, 'yes'), null);
  assert.equal(k.tradablePrice(km('T', 'x', 0.99, 0.02), 'yes'), null);
  assert.equal(k.tradablePrice(km('T', 'x', 0.02, 0.99), 'yes'), null);
  assert.equal(k.tradablePrice({ ...km('T', 'x', 0.60, 0.70), yes_bid_dollars: '0.30' }, 'yes'), null, 'gap 0.30');
  const noBids = { ticker: 'T', status: 'active', yes_ask_dollars: '0.5200', no_ask_dollars: '0.4900' };
  assert.equal(k.tradablePrice(noBids, 'yes'), 0.52, 'yes bid derived as 1 - no ask = 0.51');
  assert.equal(k.tradablePrice(noBids, 'no'), 0.49);
});

test('Kalshi markets for Houston vs Jacksonville (real prices)', () => {
  const games = [espnGame('g1', '2026-10-18T17:00:00Z', HOU, JAX, 'in')];
  const map = k.attachKalshiToGames({
    league: 'nfl', games,
    gameEvents: [withParsed(GAME_HOUJAC)], spreadEvents: [withParsed(SPREAD_HOUJAC)], totalEvents: [withParsed(TOTAL_HOUJAC)],
  });
  const m = map.get('g1');
  assert.ok(m, 'matched');
  // Moneyline: JAX (away) YES 0.57 → -133; HOU (home) YES 0.44 → +127
  assert.equal(m.moneyline.away.american, -133);
  assert.equal(m.moneyline.home.american, 127);
  assert.deepEqual(m.moneyline.away.ref, { provider: 'Kalshi', ticker: 'KXNFLGAME-26OCT18HOUJAC-JAC', side: 'yes', price: 0.57, updatedAt: '2026-10-18T17:30:00Z' });
  // Spread: favorite JAX; strike closest to $0.50 is JAC3 (2.5 @ 0.52)
  assert.equal(m.spread.away.line, -2.5);
  assert.equal(m.spread.away.american, -108);
  assert.equal(m.spread.away.ref.ticker, 'KXNFLSPREAD-26OCT18HOUJAC-JAC3');
  assert.equal(m.spread.away.ref.side, 'yes');
  assert.equal(m.spread.home.line, 2.5);
  assert.equal(m.spread.home.american, 104);
  assert.equal(m.spread.home.ref.ticker, 'KXNFLSPREAD-26OCT18HOUJAC-JAC3', 'underdog = NO on the same market');
  assert.equal(m.spread.home.ref.side, 'no');
  // Total: 42.5 (YES 0.51 closest)
  assert.equal(m.total.over.line, 42.5);
  assert.equal(m.total.over.ref.side, 'yes');
  assert.equal(m.total.under.line, 42.5);
  assert.equal(m.total.under.ref.side, 'no');
});

test('spread without a winner market falls back to the strike closest to $0.50 overall', () => {
  const games = [espnGame('g1', '2026-10-18T17:00:00Z', HOU, JAX, 'in')];
  const map = k.attachKalshiToGames({ league: 'nfl', games, gameEvents: [], spreadEvents: [withParsed(SPREAD_HOUJAC)], totalEvents: [] });
  const m = map.get('g1');
  assert.equal(m.spread.away.line, -2.5);
  assert.equal(m.moneyline.home, null);
  assert.equal(m.total.over, null);
});

test('totals matched by title when no winner/spread event shares the suffix', () => {
  const games = [espnGame('g1', '2026-10-18T17:00:00Z', HOU, JAX, 'pre')];
  const map = k.attachKalshiToGames({ league: 'nfl', games, gameEvents: [], spreadEvents: [], totalEvents: [withParsed(TOTAL_HOUJAC)] });
  assert.equal(map.get('g1').total.over.line, 42.5);
});

test('college: FCS event dropped, Miami (OH) and Appalachian St. matched', () => {
  const T = (abbr, display, short, nick, loc) => espnTeam(abbr, display, short, nick, loc);
  const games = [
    { ...espnGame('c1', '2026-10-17T00:00:00Z', T('M-OH', 'Miami (OH) RedHawks', 'Miami (OH)', 'RedHawks', 'Miami (OH)'), T('AKR', 'Akron Zips', 'Akron', 'Zips', 'Akron')), league: 'ncaaf' },
    { ...espnGame('c2', '2026-10-17T00:00:00Z', T('CCU', 'Coastal Carolina Chanticleers', 'Coastal', 'Chanticleers', 'Coastal Carolina'), T('APP', 'App State Mountaineers', 'App State', 'Mountaineers', 'App State')), league: 'ncaaf' },
  ];
  const ev = (ticker, title, a, b) => withParsed({ event_ticker: ticker, title, markets: [km(`${ticker}-${a[0]}`, a[1], 0.6, 0.41), km(`${ticker}-${b[0]}`, b[1], 0.41, 0.6)] });
  const map = k.attachKalshiToGames({
    league: 'ncaaf', games,
    gameEvents: [
      ev('KXNCAAFGAME-26OCT16CLMBPENN', 'Columbia vs Penn', ['PENN', 'Penn'], ['CLMB', 'Columbia']),
      ev('KXNCAAFGAME-26OCT16AKRMOH', 'Akron vs Miami (OH)', ['MOH', 'Miami (OH)'], ['AKR', 'Akron']),
      ev('KXNCAAFGAME-26OCT16APPCCAR', 'Appalachian St. vs Coastal Carolina', ['CCAR', 'Coastal Carolina'], ['APP', 'Appalachian St.']),
    ],
    spreadEvents: [], totalEvents: [],
  });
  assert.deepEqual([...map.keys()].sort(), ['c1', 'c2'], 'Columbia vs Penn dropped');
  assert.equal(map.get('c1').moneyline.home.american, -150, 'Miami (OH) is home at 0.60');
  assert.equal(map.get('c2').moneyline.away.ref.ticker, 'KXNCAAFGAME-26OCT16APPCCAR-APP');
});

test('board merge: ESPN first pre-game, Kalshi fills gaps, live = Kalshi only, final = none', () => {
  const espnQ = (am, line = null) => ({ american: am, decimal: 2, line, source: 'espn', ref: { provider: 'DraftKings' } });
  const kalQ = (am, line = null) => ({ american: am, decimal: 2, line, source: 'kalshi', ref: { provider: 'Kalshi', ticker: 'T', side: 'yes', price: 0.5 } });
  const kal = { moneyline: { home: kalQ(120), away: kalQ(-140) }, spread: { home: kalQ(-105, 2.5), away: kalQ(-115, -2.5) }, total: { over: kalQ(-110, 42.5), under: kalQ(-110, 42.5) } };

  const preMarkets = emptyMarkets();
  preMarkets.moneyline = { home: espnQ(-142), away: espnQ(120) };
  let g = mergeGameMarkets(espnGame('a', '2026-10-18T17:00:00Z', HOU, JAX, 'pre', preMarkets), kal);
  assert.equal(g.markets.moneyline.home.source, 'espn', 'ESPN line wins pre-game');
  assert.equal(g.markets.spread.home.source, 'kalshi', 'Kalshi fills the missing spread');
  assert.equal(g.markets.total.over.source, 'kalshi');
  assert.equal(g.oddsNote, null);

  g = mergeGameMarkets(espnGame('b', '2026-10-16T17:00:00Z', HOU, JAX, 'in', preMarkets), kal);
  assert.equal(g.markets.moneyline.home.source, 'kalshi', 'live never uses ESPN');
  g = mergeGameMarkets(espnGame('c', '2026-10-16T17:00:00Z', HOU, JAX, 'in'), undefined);
  assert.equal(g.markets.moneyline.home, null);
  assert.equal(g.oddsNote, 'Live prices unavailable');
  g = mergeGameMarkets(espnGame('d', '2026-10-18T17:00:00Z', HOU, JAX, 'pre'), undefined);
  assert.equal(g.oddsNote, 'Odds unavailable');
  g = mergeGameMarkets(espnGame('e', '2026-10-15T17:00:00Z', HOU, JAX, 'post'), kal);
  assert.equal(g.markets.moneyline.home, null, 'finished games are never priced');
  const custom = { ...espnGame('custom:x', '2026-10-18T17:00:00Z', HOU, JAX, 'pre', preMarkets), source: 'custom' };
  assert.equal(mergeGameMarkets(custom, kal), custom, 'custom games untouched');
});

test('full board build: paging past old Kalshi events, window filter, Kalshi outage keeps ESPN board', async () => {
  const espnEvent = (id, date, homeAbbr, homeLoc, homeNick, awayAbbr, awayLoc, awayNick, state = 'pre') => ({
    id, date, status: { type: { state, name: state === 'in' ? 'STATUS_IN_PROGRESS' : 'STATUS_SCHEDULED', shortDetail: 'x' } },
    competitions: [{ competitors: [
      { homeAway: 'home', score: '0', team: { id: homeAbbr, abbreviation: homeAbbr, displayName: `${homeLoc} ${homeNick}`, shortDisplayName: homeNick, name: homeNick, location: homeLoc } },
      { homeAway: 'away', score: '0', team: { id: awayAbbr, abbreviation: awayAbbr, displayName: `${awayLoc} ${awayNick}`, shortDisplayName: awayNick, name: awayNick, location: awayLoc } },
    ] }],
  });
  const espnBody = { events: [
    espnEvent('401', '2026-10-18T17:00:00Z', 'HOU', 'Houston', 'Texans', 'JAX', 'Jacksonville', 'Jaguars', 'in'),
    espnEvent('402', '2026-10-18T17:00:00Z', 'CLE', 'Cleveland', 'Browns', 'BAL', 'Baltimore', 'Ravens'),
  ] };
  const oldEvent = { event_ticker: 'KXNFLGAME-26SEP07HOUJAC', title: 'old', markets: GAME_HOUJAC.markets };
  const kalshiPages = {
    KXNFLGAME: [{ events: [oldEvent], cursor: 'p2' }, { events: [GAME_HOUJAC, GAME_BALCLE, GAME_CARPHI], cursor: '' }],
    KXNFLSPREAD: [{ events: [SPREAD_HOUJAC], cursor: '' }],
    KXNFLTOTAL: [{ events: [TOTAL_HOUJAC], cursor: '' }],
  };
  const calls = [];
  const fetchImpl = async (u) => {
    const parsed = new URL(u);
    calls.push(parsed.host + parsed.pathname + parsed.search);
    if (parsed.host === 'site.api.espn.com') return { ok: true, status: 200, json: async () => espnBody };
    const series = parsed.searchParams.get('series_ticker');
    const page = parsed.searchParams.get('cursor') ? 1 : 0;
    return { ok: true, status: 200, json: async () => kalshiPages[series][page] };
  };

  const board = await buildBoard('nfl', { now: new Date('2026-10-16T20:00:00Z'), fetchImpl });
  assert.equal(board.kalshiStatus, 'ok');
  const kalshiCalls = calls.filter((c) => c.startsWith('external-api.kalshi.com'));
  assert.equal(kalshiCalls.filter((c) => c.includes('KXNFLGAME')).length, 2, 'followed the cursor to page 2');
  assert.ok(kalshiCalls.every((c) => c.includes('status=open') && c.includes('with_nested_markets=true')));
  const nowTs = Math.floor(new Date('2026-10-16T20:00:00Z').getTime() / 1000);
  assert.ok(kalshiCalls.every((c) => c.includes(`min_close_ts=${nowTs}`)), 'only events with markets still open after now');
  const live = board.games.find((g) => g.id === '401');
  assert.equal(live.markets.moneyline.away.source, 'kalshi', 'live game priced by Kalshi');
  assert.equal(live.markets.spread.away.line, -2.5);
  const pre = board.games.find((g) => g.id === '402');
  assert.equal(pre.markets.moneyline.away.source, 'kalshi', 'no ESPN odds → Kalshi fills pre-game');
  assert.equal(pre.markets.spread.home, null, 'no BAL/CLE spread event in this fixture');
  assert.equal(board.games.length, 2, 'Kalshi-only events (CAR/PHI) never add games');

  // Kalshi completely down: ESPN board still builds, flagged.
  const downFetch = async (u) => {
    if (new URL(u).host === 'site.api.espn.com') return { ok: true, status: 200, json: async () => espnBody };
    throw new Error('Kalshi down');
  };
  const board2 = await buildBoard('nfl', { now: new Date('2026-10-16T20:00:00Z'), fetchImpl: downFetch });
  assert.equal(board2.kalshiStatus, 'failed');
  assert.equal(board2.games.find((g) => g.id === '401').oddsNote, 'Live prices unavailable');

  // Primary host 500 → fallback host used.
  const hosts = [];
  const flakyFetch = async (u) => {
    const p = new URL(u);
    hosts.push(p.host);
    if (p.host === 'site.api.espn.com') return { ok: true, status: 200, json: async () => espnBody };
    if (p.host === 'external-api.kalshi.com') return { ok: false, status: 503, json: async () => ({}) };
    const series = p.searchParams.get('series_ticker');
    return { ok: true, status: 200, json: async () => kalshiPages[series][kalshiPages[series].length - 1] };
  };
  const board3 = await buildBoard('nfl', { now: new Date('2026-10-16T20:00:00Z'), fetchImpl: flakyFetch });
  assert.ok(hosts.includes('api.elections.kalshi.com'));
  assert.equal(board3.kalshiStatus, 'ok');
});

test('shop purchase history: only type "shop", grouped, totals, newest first, disabled + unknown players', () => {
  const ts = (iso) => ({ toMillis: () => new Date(iso).getTime() });
  const users = [
    { id: 'u1', username: 'mike', displayName: 'Mike', disabled: false },
    { id: 'u2', username: 'sam', displayName: 'Sam', disabled: true },
  ];
  const entries = [
    { id: 'a', uid: 'u1', type: 'shop', amountCents: 2500, createdAt: ts('2026-10-16T15:00:00Z') },
    { id: 'b', uid: 'u1', type: 'shop', amountCents: 10000, createdAt: ts('2026-10-16T18:00:00Z') },
    { id: 'c', uid: 'u2', type: 'shop', amountCents: 500, createdAt: ts('2026-10-16T16:00:00Z') },
    { id: 'd', uid: 'u1', type: 'admin_adjust', amountCents: 99999, createdAt: ts('2026-10-16T19:00:00Z') },
    { id: 'e', uid: 'u1', type: 'stake', amountCents: -500, createdAt: ts('2026-10-16T19:00:00Z') },
    { id: 'f', uid: 'gone', type: 'shop', amountCents: 5000, createdAt: ts('2026-10-16T17:00:00Z') },
  ];
  const s = groupShopPurchases(entries, users);
  assert.equal(s.totalCount, 4);
  assert.equal(s.totalCents, 18000);
  assert.deepEqual(s.players.map((p) => p.username), ['mike', 'gone', 'sam'], 'sorted by total');
  const mike = s.players[0];
  assert.equal(mike.count, 2);
  assert.equal(mike.totalCents, 12500);
  assert.deepEqual(mike.purchases.map((p) => p.id), ['b', 'a'], 'newest first');
  assert.equal(s.players.find((p) => p.username === 'sam').disabled, true, 'disabled players included');
  assert.equal(groupShopPurchases([], users).totalCount, 0);
});
