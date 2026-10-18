// npm run test:sportsbook  (or: node --experimental-test-module-mocks test/sportsbook/phase11.test.mjs)
// 0.11.0 item 1: a live game must never be priced from another game's Kalshi markets.
//   a) playoff games match Kalshi events by series game number (postponed ALCS Game 4, 2026-10-17)
//   b) a game in progress never uses a market whose updated_time is before the game's start
//   c) when the matcher can't decide, the game gets no Kalshi markets
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
      async delete() { store.delete(`${name}/${id}`); },
    }),
    where: () => ({ async get() { return { forEach() {} }; } }),
  }),
};
mock.module(url('server/firebaseAdmin.js'), { namedExports: { adminDb: () => fakeDb, adminAuth: () => ({}), normalizePrivateKey: (k) => k } });

const k = await import(url('server/sources/kalshi.js'));
const { normalizeEspnEvent, seriesGameNumber } = await import(url('server/sources/espn.js'));
const { buildBoard } = await import(url('server/board.js'));
const { getGameDetail } = await import(url('server/gameDetail.js'));
const { createPricingContext, priceLeg } = await import(url('server/pricing.js'));
const { createCashoutContext, quoteCashout } = await import(url('server/cashout.js'));
const cache = await import(url('server/cache.js'));

// ---------- real-shaped ESPN events ----------
// ESPN keeps the game number in competitions[0].notes[].headline, e.g. "ALCS - Game 5".
function espnRaw(id, date, state, headline, { home = ['CLE', 'Cleveland', 'Guardians'], away = ['TB', 'Tampa Bay', 'Rays'] } = {}) {
  const t = ([abbr, loc, nick]) => ({ id: abbr, abbreviation: abbr, displayName: `${loc} ${nick}`, shortDisplayName: nick, name: nick, location: loc });
  const name = state === 'in' ? 'STATUS_IN_PROGRESS' : state === 'post' ? 'STATUS_FINAL' : 'STATUS_SCHEDULED';
  return {
    id, date,
    status: { type: { state, name, shortDetail: state, completed: state === 'post' } },
    competitions: [{
      date,
      notes: headline ? [{ type: 'event', headline }] : [],
      series: { type: 'playoff', title: 'Playoff Series', summary: 'CLE leads series 2-1', completed: false, totalCompetitions: 7 },
      competitors: [{ homeAway: 'home', score: '0', team: t(home) }, { homeAway: 'away', score: '0', team: t(away) }],
      odds: [],
    }],
  };
}

// ---------- real-shaped Kalshi events (fields as served by /events?with_nested_markets=true) ----------
function mk(ticker, yesSub, yesAsk, { strike = null, updated, status = 'active' } = {}) {
  return {
    ticker,
    event_ticker: ticker.slice(0, ticker.lastIndexOf('-')),
    yes_sub_title: yesSub,
    status,
    floor_strike: strike,
    strike_type: strike === null ? undefined : 'greater',
    yes_ask_dollars: yesAsk.toFixed(4),
    yes_bid_dollars: (yesAsk - 0.01).toFixed(4),
    no_ask_dollars: (1.01 - yesAsk).toFixed(4),
    no_bid_dollars: (1 - yesAsk).toFixed(4),
    updated_time: updated,
  };
}

// One Rays–Guardians game's three events. slot e.g. '26OCT161800'; prices: TB winner ask and TB −N.5 asks.
function series(slot, gameNo, { tbWin, tbSpread, totals, updated }) {
  const suffix = `${slot}TBCLE`;
  const game = {
    event_ticker: `KXMLBGAME-${suffix}`,
    title: gameNo ? `Game ${gameNo}: Tampa Bay vs Cleveland` : 'Tampa Bay vs Cleveland',
    sub_title: `TB vs CLE (${slot.slice(2, 5)} ${slot.slice(5, 7)})`,
    markets: [mk(`KXMLBGAME-${suffix}-TB`, 'Tampa Bay', tbWin, { updated }), mk(`KXMLBGAME-${suffix}-CLE`, 'Cleveland', 1.01 - tbWin, { updated })],
  };
  const spread = {
    event_ticker: `KXMLBSPREAD-${suffix}`,
    title: 'Tampa Bay vs Cleveland: Spread',
    markets: [
      ...tbSpread.map(([strike, ask]) => mk(`KXMLBSPREAD-${suffix}-TB${Math.ceil(strike)}`, `Tampa Bay wins by over ${strike} runs`, ask, { strike, updated })),
      mk(`KXMLBSPREAD-${suffix}-CLE2`, 'Cleveland wins by over 1.5 runs', 0.05, { strike: 1.5, updated }),
    ],
  };
  const total = {
    event_ticker: `KXMLBTOTAL-${suffix}`,
    title: 'Tampa Bay vs Cleveland: Total Runs',
    markets: totals.map(([strike, ask]) => mk(`KXMLBTOTAL-${suffix}-${Math.ceil(strike)}`, `Over ${strike} runs`, ask, { strike, updated })),
  };
  return { game, spread, total };
}

const parsed = (e) => ({ ...e, parsed: k.parseEventTicker(e.event_ticker) });
const match = (games, sets, league = 'mlb') => k.matchKalshiEntries({
  league, games,
  gameEvents: sets.map((s) => parsed(s.game)), spreadEvents: sets.map((s) => parsed(s.spread)), totalEvents: sets.map((s) => parsed(s.total)),
});
const tickersOf = (entry) => entry && [entry.gameEvent?.event_ticker ?? null, entry.spreadEvent?.event_ticker ?? null, entry.totalEvent?.event_ticker ?? null];
const G4_TICKERS = ['KXMLBGAME-26OCT161800TBCLE', 'KXMLBSPREAD-26OCT161800TBCLE', 'KXMLBTOTAL-26OCT161800TBCLE'];
const G5_TICKERS = ['KXMLBGAME-26OCT172000TBCLE', 'KXMLBSPREAD-26OCT172000TBCLE', 'KXMLBTOTAL-26OCT172000TBCLE'];

// The night of 2026-10-17: Game 4 (postponed from Oct 16) is live, priced ~$0.90 on Rays −1.5 and its markets
// updated after first pitch. Game 5's markets sat at pre-game prices (TB2 ask $0.43), last updated 20:30Z.
const G4_START = '2026-10-18T00:00:00Z';
const G4_LIVE = series('26OCT161800', 4, { tbWin: 0.95, tbSpread: [[1.5, 0.9], [2.5, 0.72], [3.5, 0.52]], totals: [[6.5, 0.8], [7.5, 0.55], [8.5, 0.4]], updated: '2026-10-18T00:41:07Z' });
const G5_PRE = series('26OCT172000', 5, { tbWin: 0.53, tbSpread: [[1.5, 0.43], [2.5, 0.3]], totals: [[7.5, 0.5], [8.5, 0.4]], updated: '2026-10-17T20:30:00Z' });
const NOW = new Date('2026-10-18T01:00:00Z'); // 8 pm CT Oct 17, Game 4 in progress

const norm = (raw) => normalizeEspnEvent(raw, 'mlb');
const GAME4 = norm(espnRaw('g4', G4_START, 'in', 'ALCS - Game 4'));
const GAME5 = norm(espnRaw('g5', '2026-10-19T00:00:00Z', 'pre', 'ALCS - Game 5'));

// ---------- a fake ESPN + Kalshi network for the board, game page, bet pricing and cash out ----------
function network({ espnByDate, sets, marketOverrides = {} }) {
  const events = sets.flatMap((s) => [s.game, s.spread, s.total]);
  const markets = new Map(events.flatMap((e) => e.markets.map((m) => [m.ticker, m])));
  const calls = { kalshiMarket: 0 };
  const fetchImpl = async (u) => {
    const p = new URL(u);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (p.host === 'site.api.espn.com') return ok({ events: espnByDate[p.searchParams.get('dates')] ?? [] });
    if (p.pathname.endsWith('/events')) {
      const kind = { KXMLBGAME: 'game', KXMLBSPREAD: 'spread', KXMLBTOTAL: 'total' }[p.searchParams.get('series_ticker')];
      return ok({ events: sets.map((s) => s[kind]), cursor: '' });
    }
    const one = /\/markets\/([^/]+)$/.exec(p.pathname);
    if (one) {
      calls.kalshiMarket += 1;
      const t = decodeURIComponent(one[1]);
      return ok({ market: marketOverrides[t] ?? markets.get(t) ?? null });
    }
    const ev = /\/events\/([^/]+)$/.exec(p.pathname);
    if (ev) return ok({ event: events.find((e) => e.event_ticker === decodeURIComponent(ev[1])) ?? null });
    throw new Error(`unexpected ${u}`);
  };
  return { fetchImpl, calls, markets };
}

const allQuotes = (game, ladders) => [
  ...Object.values(game.markets).flatMap((sides) => Object.values(sides)),
  ...(ladders ? [...ladders.spreads.home, ...ladders.spreads.away, ...ladders.totals.flatMap((r) => [r.over, r.under])] : []),
].filter(Boolean);

// ---------- a) series game number ----------

test('game numbers: parsed from real ESPN notes and Kalshi winner titles', () => {
  assert.equal(seriesGameNumber({ notes: [{ type: 'event', headline: 'ALCS - Game 5' }] }), 5);
  assert.equal(seriesGameNumber({ notes: [{ type: 'event', headline: 'NLCS - Game 5 If Necessary' }] }), 5);
  assert.equal(seriesGameNumber({ notes: [{ type: 'event', headline: 'World Series - Game 7 If Necessary' }] }), 7);
  assert.equal(seriesGameNumber({ notes: [] }), null, 'regular season: no notes');
  assert.equal(seriesGameNumber({}), null);
  assert.equal(seriesGameNumber({ notes: [{ headline: 'Big Ten Championship Game' }] }), null, 'no number after "Game"');
  assert.equal(GAME4.gameNumber, 4, 'stored on the normalized ESPN game');
  assert.equal(norm(espnRaw('x', G4_START, 'pre', null)).gameNumber, null);

  assert.equal(k.kalshiGameNumber('Game 4: Tampa Bay vs Cleveland'), 4);
  assert.equal(k.kalshiGameNumber('Game 5: Tampa Bay vs Cleveland'), 5);
  assert.equal(k.kalshiGameNumber('Tampa Bay vs Cleveland: Spread'), null, 'spread titles carry no number');
  assert.equal(k.kalshiGameNumber('Tampa Bay vs Cleveland'), null);
});

test('repro (ALCS 2026-10-17): live, rescheduled Game 4 maps to its own 26OCT161800 events, never Game 5\'s', () => {
  for (const order of [[G4_LIVE, G5_PRE], [G5_PRE, G4_LIVE]]) {
    const map = match([GAME4], order);
    assert.deepEqual(tickersOf(map.get('g4')), G4_TICKERS);
    assert.deepEqual(map.get('g4').sideByCode, { TB: 'away', CLE: 'home' });
  }
  // With Game 5 on the board too (moved to the next day), each gets its own events.
  const map = match([GAME4, GAME5], [G5_PRE, G4_LIVE]);
  assert.deepEqual(tickersOf(map.get('g4')), G4_TICKERS);
  assert.deepEqual(tickersOf(map.get('g5')), G5_TICKERS);

  // Board quotes for the live game: Rays −1.5 is priced from Game 4's $0.90 market, never Game 5's $0.43 (+133).
  const markets = k.attachKalshiToGames({ league: 'mlb', games: [GAME4, GAME5], gameEvents: [G5_PRE.game, G4_LIVE.game].map(parsed), spreadEvents: [G5_PRE.spread, G4_LIVE.spread].map(parsed), totalEvents: [G5_PRE.total, G4_LIVE.total].map(parsed) }).get('g4');
  const quotes = [markets.moneyline.home, markets.moneyline.away, markets.spread.home, markets.spread.away, markets.total.over, markets.total.under].filter(Boolean);
  assert.ok(quotes.length >= 4);
  assert.ok(quotes.every((q) => q.ref.ticker.includes('-26OCT161800TBCLE-')), 'every main line from Game 4');
  assert.ok(quotes.every((q) => q.american !== 133));
});

test('repro end to end: board, alternate ladder, bet pricing and cash out all use Game 4\'s markets', async () => {
  cache.clearMemoryCache();
  store.clear();
  const espnByDate = { 20261017: [espnRaw('g4', G4_START, 'in', 'ALCS - Game 4')], 20261018: [espnRaw('g5', '2026-10-19T00:00:00Z', 'pre', 'ALCS - Game 5')] };
  // Kalshi lists Game 5 first, like the night it happened. Its TB2 market even answers as freshly updated here,
  // so only the game-number mapping keeps it away from Game 4.
  const g5tb2 = 'KXMLBSPREAD-26OCT172000TBCLE-TB2';
  const g5Fresh = { ...G5_PRE.spread.markets.find((m) => m.ticker === g5tb2), updated_time: '2026-10-18T00:30:00Z' };
  const net = network({ espnByDate, sets: [G5_PRE, G4_LIVE], marketOverrides: { [g5tb2]: g5Fresh } });
  const board = await buildBoard('mlb', { now: NOW, fetchImpl: net.fetchImpl });
  const g4 = board.games.find((g) => g.id === 'g4');
  assert.equal(g4.kalshi.spreadEvent, 'KXMLBSPREAD-26OCT161800TBCLE');
  assert.equal(board.games.find((g) => g.id === 'g5').kalshi.spreadEvent, 'KXMLBSPREAD-26OCT172000TBCLE');

  const detail = await getGameDetail('mlb', 'g4', { fetchImpl: net.fetchImpl, now: () => NOW });
  const all = allQuotes(detail.game, detail.ladders);
  assert.ok(all.length > 6);
  assert.ok(all.every((q) => q.ref.ticker.includes('-26OCT161800TBCLE-')), 'no Game 5 market anywhere on Game 4\'s page');
  const raysMinus15 = detail.ladders.spreads.away.find((q) => q.line === -1.5);
  assert.equal(raysMinus15.ref.ticker, 'KXMLBSPREAD-26OCT161800TBCLE-TB2');
  assert.equal(raysMinus15.american, -900, 'Rays −1.5 at Game 4\'s $0.90, not +133');

  // The exploit bet: Rays −1.5 via Game 5's market → refused; via Game 4's market → Game 4's price.
  const ctx = () => createPricingContext({ now: NOW, fetchImpl: net.fetchImpl, getBoard: async () => board });
  const leg = (ticker) => ({ league: 'mlb', gameId: 'g4', marketType: 'spread', selection: 'away', line: -1.5, kalshiTicker: ticker, kalshiSide: 'yes' });
  let r = await priceLeg(leg('KXMLBSPREAD-26OCT172000TBCLE-TB2'), ctx());
  assert.equal(r.status, 'closed');
  r = await priceLeg(leg('KXMLBSPREAD-26OCT161800TBCLE-TB2'), ctx());
  assert.equal(r.status, 'ok');
  assert.equal(r.quote.american, -900);

  // Cash out on a bet that was priced from Game 5's market (placed before this fix): no bid from it.
  const exploitBet = {
    status: 'open', type: 'single', stakeCents: 1000, potentialPayoutCents: 2330,
    legs: [{ league: 'mlb', gameId: 'g4', marketType: 'spread', selection: 'away', line: -1.5, decimalOdds: 2.33, startTime: G4_START, result: 'pending', source: 'kalshi', sourceRef: { provider: 'Kalshi', ticker: 'KXMLBSPREAD-26OCT172000TBCLE-TB2', side: 'yes', price: 0.43 } }],
  };
  const cctx = createCashoutContext({ now: NOW, fetchImpl: net.fetchImpl, fresh: true, getBoard: async () => board });
  const q = await quoteCashout(exploitBet, cctx);
  assert.equal(q.available, false);
  assert.match(q.reason, /No matching Kalshi market/);
  // The same bet on Game 4's own market: live value from Game 4's bid.
  const fairBet = { ...exploitBet, legs: [{ ...exploitBet.legs[0], sourceRef: { provider: 'Kalshi', ticker: 'KXMLBSPREAD-26OCT161800TBCLE-TB2', side: 'yes', price: 0.9 } }] };
  const q2 = await quoteCashout(fairBet, createCashoutContext({ now: NOW, fetchImpl: net.fetchImpl, fresh: true, getBoard: async () => board }));
  assert.equal(q2.available, true);
  assert.equal(q2.valueCents, Math.floor(2330 * 0.89 * 0.9));
});

test('normal series, no postponement: Games 4 and 5 on consecutive days each map to their own events', () => {
  const g4 = series('26OCT161800', 4, { tbWin: 0.5, tbSpread: [[1.5, 0.4]], totals: [[7.5, 0.5]], updated: '2026-10-16T10:00:00Z' });
  const g5 = series('26OCT171810', 5, { tbWin: 0.5, tbSpread: [[1.5, 0.4]], totals: [[7.5, 0.5]], updated: '2026-10-16T10:00:00Z' });
  const games = [
    norm(espnRaw('n4', '2026-10-16T22:00:00Z', 'pre', 'ALCS - Game 4')),
    norm(espnRaw('n5', '2026-10-17T22:10:00Z', 'pre', 'ALCS - Game 5')),
  ];
  for (const order of [[g4, g5], [g5, g4]]) {
    const map = match(games, order);
    assert.deepEqual(tickersOf(map.get('n4')), ['KXMLBGAME-26OCT161800TBCLE', 'KXMLBSPREAD-26OCT161800TBCLE', 'KXMLBTOTAL-26OCT161800TBCLE']);
    assert.deepEqual(tickersOf(map.get('n5')), ['KXMLBGAME-26OCT171810TBCLE', 'KXMLBSPREAD-26OCT171810TBCLE', 'KXMLBTOTAL-26OCT171810TBCLE']);
  }
});

test('numbered game: events with another number or no known number are rejected (no price)', () => {
  const unnumbered = series('26OCT161800', null, { tbWin: 0.5, tbSpread: [[1.5, 0.4]], totals: [[7.5, 0.5]], updated: '2026-10-18T00:30:00Z' });
  assert.equal(match([GAME4], [G5_PRE]).size, 0, 'only Game 5 listed → Game 4 gets nothing');
  assert.equal(match([GAME4], [unnumbered]).size, 0, 'no number in the title → rejected even on a matching date');
  // A spread event whose winner event isn't listed has no known number either.
  const map = k.matchKalshiEntries({ league: 'mlb', games: [GAME4], gameEvents: [], spreadEvents: [parsed(G4_LIVE.spread)], totalEvents: [] });
  assert.equal(map.size, 0);
});

test('regular season (no game numbers): date and start-time matching unchanged', () => {
  const reg = series('26OCT161800', null, { tbWin: 0.5, tbSpread: [[1.5, 0.4]], totals: [[7.5, 0.5]], updated: '2026-10-16T10:00:00Z' });
  const tomorrow = series('26OCT171310', null, { tbWin: 0.5, tbSpread: [[1.5, 0.4]], totals: [[7.5, 0.5]], updated: '2026-10-16T10:00:00Z' });
  const games = [norm(espnRaw('r1', '2026-10-16T22:00:00Z', 'pre', null)), norm(espnRaw('r2', '2026-10-17T17:10:00Z', 'pre', null))];
  const map = match(games, [tomorrow, reg]);
  assert.equal(map.get('r1').gameEvent.event_ticker, 'KXMLBGAME-26OCT161800TBCLE');
  assert.equal(map.get('r2').gameEvent.event_ticker, 'KXMLBGAME-26OCT171310TBCLE');
});

// ---------- c) when unsure, no price ----------

test('unsure → no Kalshi markets: two equally close events, or one game number in two slots', () => {
  // NBA tickers carry no start time: two listings of the same matchup on the same date are equally close.
  const team = (abbr, loc, nick) => ['BOS', 'PHI'].includes(abbr) && [abbr, loc, nick];
  const nbaGame = norm(espnRaw('nba1', '2026-10-16T23:30:00Z', 'pre', null, { home: team('PHI', 'Philadelphia', '76ers'), away: team('BOS', 'Boston', 'Celtics') }));
  nbaGame.league = 'nba';
  const ev = (suffix, codes) => ({
    event_ticker: `KXNBAGAME-${suffix}`, title: 'Boston vs Philadelphia',
    markets: codes.map((c) => mk(`KXNBAGAME-${suffix}-${c}`, c === 'BOS' ? 'Boston' : 'Philadelphia', 0.5, { updated: '2026-10-10T00:00:00Z' })),
  });
  const one = k.matchKalshiEntries({ league: 'nba', games: [nbaGame], gameEvents: [parsed(ev('26OCT16BOSPHI', ['BOS', 'PHI']))], spreadEvents: [], totalEvents: [] });
  assert.equal(one.get('nba1').gameEvent.event_ticker, 'KXNBAGAME-26OCT16BOSPHI', 'one listing: matched');
  const two = k.matchKalshiEntries({ league: 'nba', games: [nbaGame], gameEvents: [parsed(ev('26OCT16BOSPHI', ['BOS', 'PHI'])), parsed(ev('26OCT16PHIBOS', ['PHI', 'BOS']))], spreadEvents: [], totalEvents: [] });
  assert.equal(two.size, 0, 'two listings equally close → no markets, never a guess');

  // Kalshi lists "Game 4" twice (original slot and a relisted one): can't tell which → no markets.
  const relisted = series('26OCT172000', 4, { tbWin: 0.5, tbSpread: [[1.5, 0.4]], totals: [[7.5, 0.5]], updated: '2026-10-18T00:30:00Z' });
  assert.equal(match([GAME4], [G4_LIVE, relisted]).size, 0);
});

// ---------- b) stale-market guard ----------

// Game 4 live, but its markets haven't updated since before first pitch.
const G4_STALE = series('26OCT161800', 4, { tbWin: 0.95, tbSpread: [[1.5, 0.9], [2.5, 0.72]], totals: [[7.5, 0.55]], updated: '2026-10-17T23:59:00Z' });

test('stale live market: no board quote, no ladder, priceLeg closed (also with kalshiTicker), no live cash out', async () => {
  cache.clearMemoryCache();
  store.clear();
  const espnByDate = { 20261017: [espnRaw('g4', G4_START, 'in', 'ALCS - Game 4')] };
  const net = network({ espnByDate, sets: [G4_STALE] });
  const board = await buildBoard('mlb', { now: NOW, fetchImpl: net.fetchImpl });
  const g4 = board.games.find((g) => g.id === 'g4');
  assert.equal(g4.kalshi.gameEvent, 'KXMLBGAME-26OCT161800TBCLE', 'still mapped (so a ticker can be checked), just not priced');
  assert.equal(allQuotes(g4).length, 0, 'no board quote');
  assert.equal(g4.oddsNote, 'Live prices unavailable');

  const detail = await getGameDetail('mlb', 'g4', { fetchImpl: net.fetchImpl, now: () => NOW });
  assert.equal(allQuotes(detail.game, detail.ladders).length, 0, 'no alternate line either');

  const ctx = () => createPricingContext({ now: NOW, fetchImpl: net.fetchImpl, getBoard: async () => board });
  // With the exact ticker (alternate-line pick).
  let r = await priceLeg({ league: 'mlb', gameId: 'g4', marketType: 'spread', selection: 'away', line: -1.5, kalshiTicker: 'KXMLBSPREAD-26OCT161800TBCLE-TB2', kalshiSide: 'yes' }, ctx());
  assert.equal(r.status, 'closed');
  assert.match(r.reason, /Live prices unavailable/);
  // Without a ticker (main line): the fresh live lookup finds no fresh market.
  r = await priceLeg({ league: 'mlb', gameId: 'g4', marketType: 'moneyline', selection: 'away', line: null }, ctx());
  assert.equal(r.status, 'closed');

  // Cash out: live bet on that market → unavailable (estimate and confirmation).
  const bet = {
    status: 'open', type: 'single', stakeCents: 1000, potentialPayoutCents: 1111,
    legs: [{ league: 'mlb', gameId: 'g4', marketType: 'spread', selection: 'away', line: -1.5, decimalOdds: 1.111, startTime: G4_START, result: 'pending', source: 'kalshi', sourceRef: { provider: 'Kalshi', ticker: 'KXMLBSPREAD-26OCT161800TBCLE-TB2', side: 'yes', price: 0.9 } }],
  };
  for (const fresh of [false, true]) {
    const q = await quoteCashout(bet, createCashoutContext({ now: NOW, fetchImpl: net.fetchImpl, fresh, getBoard: async () => board }));
    assert.equal(q.available, false, `fresh=${fresh}`);
    assert.match(q.reason, /Live prices unavailable/);
  }
  // A DraftKings-line leg matched to the same stale event: unavailable too.
  const dkBet = { ...bet, legs: [{ ...bet.legs[0], source: 'espn', sourceRef: { provider: 'DraftKings' } }] };
  const q = await quoteCashout(dkBet, createCashoutContext({ now: NOW, fetchImpl: net.fetchImpl, fresh: true, getBoard: async () => board }));
  assert.equal(q.available, false);
});

test('both guards: if ESPN gave no game number, the date match lands on Game 5, whose pre-game prices are still refused', async () => {
  cache.clearMemoryCache();
  store.clear();
  const espnByDate = { 20261017: [espnRaw('g4', G4_START, 'in', null)] }; // no notes → no game number
  const net = network({ espnByDate, sets: [G5_PRE, G4_LIVE] });
  const board = await buildBoard('mlb', { now: NOW, fetchImpl: net.fetchImpl });
  const g4 = board.games.find((g) => g.id === 'g4');
  assert.equal(g4.kalshi.gameEvent, 'KXMLBGAME-26OCT172000TBCLE', 'date matching alone picks Game 5 (exact date)');
  assert.equal(allQuotes(g4).length, 0, 'but its markets last updated before first pitch → no price');
  const r = await priceLeg(
    { league: 'mlb', gameId: 'g4', marketType: 'spread', selection: 'away', line: -1.5, kalshiTicker: 'KXMLBSPREAD-26OCT172000TBCLE-TB2', kalshiSide: 'yes' },
    createPricingContext({ now: NOW, fetchImpl: net.fetchImpl, getBoard: async () => board }),
  );
  assert.equal(r.status, 'closed', 'Rays −1.5 at +133 is not bettable');
});

test('stale guard uses the market fetched at bet time, not the board copy', async () => {
  cache.clearMemoryCache();
  store.clear();
  const espnByDate = { 20261017: [espnRaw('g4', G4_START, 'in', 'ALCS - Game 4')] };
  const boardNet = network({ espnByDate, sets: [G4_LIVE] });
  const board = await buildBoard('mlb', { now: NOW, fetchImpl: boardNet.fetchImpl });
  const boardQuote = board.games.find((g) => g.id === 'g4').markets.moneyline.away;
  assert.equal(boardQuote.source, 'kalshi');
  assert.equal(boardQuote.ref.updatedAt, '2026-10-18T00:41:07Z', 'board cache carries updated_time');

  // At bet time Kalshi answers with a market whose updated_time is before the start → refused.
  const t = boardQuote.ref.ticker;
  const stale = { ...boardNet.markets.get(t), updated_time: '2026-10-17T20:30:00Z' };
  const betNet = network({ espnByDate, sets: [G4_LIVE], marketOverrides: { [t]: stale } });
  const ctx = createPricingContext({ now: NOW, fetchImpl: betNet.fetchImpl, getBoard: async () => board });
  const r = await priceLeg({ league: 'mlb', gameId: 'g4', marketType: 'moneyline', selection: 'away', line: null }, ctx);
  assert.equal(r.status, 'closed');
  assert.match(r.reason, /Live prices unavailable/);
  assert.equal(betNet.calls.kalshiMarket, 1, 'the market was fetched fresh');

  // Same market, fresh → accepted.
  const ok = await priceLeg({ league: 'mlb', gameId: 'g4', marketType: 'moneyline', selection: 'away', line: null }, createPricingContext({ now: NOW, fetchImpl: boardNet.fetchImpl, getBoard: async () => board }));
  assert.equal(ok.status, 'ok');
});

test('stale guard applies only to games in progress; old cached ladder rows without updated_time are never used live', () => {
  const market = { ticker: 'X-1', status: 'active', yes_ask_dollars: '0.5000', yes_bid_dollars: '0.4900', no_ask_dollars: '0.5100', no_bid_dollars: '0.5000', updated_time: '2026-10-17T20:00:00Z' };
  const start = Date.parse(G4_START);
  assert.equal(k.tradablePrice(market, 'yes'), 0.5, 'pre-game: no check');
  assert.equal(k.tradablePrice(market, 'yes', start), null, 'live: updated before the start');
  assert.equal(k.tradablePrice({ ...market, updated_time: G4_START }, 'yes', start), 0.5, 'updated at the start counts');
  assert.equal(k.tradablePrice({ ...market, updated_time: undefined }, 'yes', start), null, 'no updated_time → no live price');
  assert.equal(k.liveSinceMs(GAME5), null);
  assert.equal(k.liveSinceMs(GAME4), start);

  // A ladder row cached before 0.11.0 (6 fields, no updated_time).
  const compact = { s: { e: 'KXMLBSPREAD-26OCT161800TBCLE', m: [['TB2', 1.5, 0.9, 0.89, 0.11, 0.1]] }, t: null };
  assert.equal(k.buildLadders(compact, { TB: 'away', CLE: 'home' }).spreads.away.length, 1, 'fine before the start');
  assert.equal(k.buildLadders(compact, { TB: 'away', CLE: 'home' }, start).spreads.away.length, 0, 'never live');
});
