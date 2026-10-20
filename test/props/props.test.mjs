// npm run test:props  (or: node --experimental-test-module-mocks --test test/props/props.test.mjs)
// 0.14.0 player props (Kalshi, pre-game only): matching by the mapped winner event's ticker suffix (incl. the
// postponed ALCS Game 4 / Game 5 case), the props page, pricing refusals, parlay rules, cash out, settlement.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFakeDb } from '../casino/fakeFirestore.mjs';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;
const fake = makeFakeDb();
mock.module(url('server/firebaseAdmin.js'), { namedExports: { adminDb: () => fake.db, adminAuth: () => ({}), normalizePrivateKey: (k) => k } });

const P = await import(url('shared/props.js'));
const rules = await import(url('shared/betRules.js'));
const { buildBoard } = await import(url('server/board.js'));
const { getGameDetail } = await import(url('server/gameDetail.js'));
const props = await import(url('server/props.js'));
const { createPricingContext, priceLeg } = await import(url('server/pricing.js'));
const { placeBets } = await import(url('server/placeBet.js'));
const { gradeLeg } = await import(url('server/grading.js'));
const { settleOpenBets } = await import(url('server/settlement.js'));
const cashout = await import(url('server/cashout.js'));
const cache = await import(url('server/cache.js'));
const { probabilityToAmerican } = await import(url('shared/oddsMath.js'));

// ---------- the world: ALCS Rays at Guardians, Game 4 postponed (Kalshi keeps it under Oct 16) and Game 5 ----------
const G4_START = '2026-10-18T00:00:00Z'; // 7 pm CT Oct 17
const G5_START = '2026-10-19T00:00:00Z'; // 7 pm CT Oct 18
const NOW = new Date('2026-10-17T22:00:00Z'); // 5 pm CT Oct 17: both games still to come
const MIN = 60e3;

function espnRaw(id, date, state, headline) {
  const t = (abbr, loc, nick) => ({ id: abbr, abbreviation: abbr, displayName: `${loc} ${nick}`, shortDisplayName: nick, name: nick, location: loc });
  const name = state === 'in' ? 'STATUS_IN_PROGRESS' : state === 'post' ? 'STATUS_FINAL' : 'STATUS_SCHEDULED';
  return {
    id, date,
    status: { type: { state, name, shortDetail: state, completed: state === 'post' } },
    competitions: [{ date, notes: headline ? [{ type: 'event', headline }] : [], odds: [], competitors: [
      { homeAway: 'home', score: '0', team: t('CLE', 'Cleveland', 'Guardians') },
      { homeAway: 'away', score: '0', team: t('TB', 'Tampa Bay', 'Rays') },
    ] }],
  };
}
function mk(ticker, sub, yesAsk, { strike = null, status = 'active', volume = 0, gap = 0.02 } = {}) {
  return {
    ticker, event_ticker: ticker.split('-').slice(0, 2).join('-'), yes_sub_title: sub, status,
    strike_type: strike === null ? undefined : 'greater', floor_strike: strike,
    yes_ask_dollars: yesAsk.toFixed(4), yes_bid_dollars: Math.max(0, yesAsk - gap).toFixed(4),
    no_ask_dollars: Math.min(1, 1 - yesAsk + gap).toFixed(4), no_bid_dollars: Math.max(0, 1 - yesAsk).toFixed(4),
    volume_fp: String(volume), result: '',
  };
}
function gameSets(slot, gameNo, tbWin) {
  const suffix = `${slot}TBCLE`;
  return {
    game: { event_ticker: `KXMLBGAME-${suffix}`, title: `Game ${gameNo}: Tampa Bay vs Cleveland`, markets: [mk(`KXMLBGAME-${suffix}-TB`, 'Tampa Bay', tbWin), mk(`KXMLBGAME-${suffix}-CLE`, 'Cleveland', 1 - tbWin)] },
    spread: { event_ticker: `KXMLBSPREAD-${suffix}`, title: 'Tampa Bay vs Cleveland: Spread', markets: [mk(`KXMLBSPREAD-${suffix}-TB2`, 'Tampa Bay wins by over 1.5 runs', 0.4, { strike: 1.5 }), mk(`KXMLBSPREAD-${suffix}-CLE2`, 'Cleveland wins by over 1.5 runs', 0.3, { strike: 1.5 })] },
    total: { event_ticker: `KXMLBTOTAL-${suffix}`, title: 'Tampa Bay vs Cleveland: Total Runs', markets: [mk(`KXMLBTOTAL-${suffix}-8`, 'Over 7.5 runs', 0.5, { strike: 7.5 })] },
  };
}
// Prop events for one game slot. `hr` is Ramírez's HR YES ask, so each game's props can be told apart.
function propEvents(slot, hr) {
  const e = (series) => `${series}-${slot}TBCLE`;
  return {
    [e('KXMLBHR')]: { event_ticker: e('KXMLBHR'), markets: [
      mk(`${e('KXMLBHR')}-CLEJRAMIREZ11-1`, 'José Ramírez: 1+', hr, { strike: 0.5, volume: 900 }),
      mk(`${e('KXMLBHR')}-CLEJRAMIREZ11-2`, 'José Ramírez: 2+', 0.02, { strike: 1.5, volume: 10 }), // ask under MIN_PRICE: hidden
      mk(`${e('KXMLBHR')}-TBJCAMINERO13-1`, 'Junior Caminero: 1+', 0.2, { strike: 0.5, volume: 4000 }),
      mk(`${e('KXMLBHR')}-TBYDIAZ2-1`, 'Yandy Díaz: 1+', 0.12, { strike: 0.5, volume: 50, gap: 0.3 }), // gap too wide: player hidden
    ] },
    [e('KXMLBHIT')]: { event_ticker: e('KXMLBHIT'), markets: [
      mk(`${e('KXMLBHIT')}-CLEJRAMIREZ11-1`, 'José Ramírez: 1+', 0.7, { strike: 0.5, volume: 300 }),
      mk(`${e('KXMLBHIT')}-CLEJRAMIREZ11-2`, 'José Ramírez: 2+', 0.45, { strike: 1.5, volume: 200 }),
      mk(`${e('KXMLBHIT')}-CLEJRAMIREZ11-3`, 'José Ramírez: 3+', 0.12, { strike: 2.5, volume: 100 }),
    ] },
  };
}

let world;
function resetWorld({ g4State = 'pre', g4Headline = 'ALCS - Game 4' } = {}) {
  world = {
    espn: { 20261017: [espnRaw('g4', G4_START, g4State, g4Headline)], 20261018: [espnRaw('g5', G5_START, 'pre', 'ALCS - Game 5')] },
    sets: [gameSets('26OCT172000', 5, 0.5), gameSets('26OCT161800', 4, 0.55)], // Kalshi lists Game 5 first
    props: { ...propEvents('26OCT161800', 0.3), ...propEvents('26OCT172000', 0.4) },
    calls: [],
  };
}
const allMarkets = () => {
  const map = new Map();
  for (const s of world.sets) for (const e of [s.game, s.spread, s.total]) for (const m of e.markets) map.set(m.ticker, m);
  for (const e of Object.values(world.props)) for (const m of e.markets) map.set(m.ticker, m);
  return map;
};
async function fetchImpl(u) {
  const p = new URL(u);
  world.calls.push(p.pathname + p.search);
  const ok = (body) => ({ ok: true, status: 200, json: async () => structuredClone(body) });
  const notFound = { ok: false, status: 404, json: async () => ({}) };
  if (p.host === 'site.api.espn.com') return ok({ events: world.espn[p.searchParams.get('dates')] ?? [] });
  if (p.pathname.endsWith('/events')) {
    const kind = { KXMLBGAME: 'game', KXMLBSPREAD: 'spread', KXMLBTOTAL: 'total' }[p.searchParams.get('series_ticker')];
    return ok({ events: kind ? world.sets.map((s) => s[kind]) : [], cursor: '' });
  }
  const ev = /\/events\/([^/]+)$/.exec(p.pathname);
  if (ev) {
    const t = decodeURIComponent(ev[1]);
    const found = world.props[t] ?? world.sets.flatMap((s) => [s.game, s.spread, s.total]).find((e) => e.event_ticker === t);
    return found ? ok({ event: found }) : notFound;
  }
  const one = /\/markets\/([^/]+)$/.exec(p.pathname);
  if (one) {
    const m = allMarkets().get(decodeURIComponent(one[1]));
    return m ? ok({ market: m }) : notFound;
  }
  throw new Error(`unexpected ${u}`);
}

let board;
async function freshBoard(now = NOW) {
  cache.clearMemoryCache();
  props.clearPropsCache();
  board = await buildBoard('mlb', { now, fetchImpl });
  return board;
}
const pctx = (now = NOW) => createPricingContext({ now, fetchImpl, getBoard: async () => board });
const findMarket = (t) => allMarkets().get(t);
const askAmerican = (t, side) => probabilityToAmerican(Number(findMarket(t)[`${side}_ask_dollars`]));
const propLeg = (ticker, side = 'yes', extra = {}) => ({
  league: 'mlb', gameId: ticker.includes('161800') ? 'g4' : 'g5', marketType: 'prop', selection: side,
  line: Number(findMarket(ticker).floor_strike), kalshiTicker: ticker, kalshiSide: side, quotedAmerican: askAmerican(ticker, side), ...extra,
});
const G4HR = 'KXMLBHR-26OCT161800TBCLE-CLEJRAMIREZ11-1';
const G5HR = 'KXMLBHR-26OCT172000TBCLE-CLEJRAMIREZ11-1';

const caller = (uid) => ({ uid, token: {}, user: fake.get(`users/${uid}`) });
let n = 0;
const rid = () => `prop-req-${String(++n).padStart(6, '0')}`;
beforeEach(async () => {
  fake.reset();
  cashout.clearEstimateCache();
  resetWorld();
  for (const uid of ['mike', 'dan']) fake.write(`users/${uid}`, { username: uid, displayName: uid, balanceCents: 10_000, stats: { won: 0, lost: 0 } });
  await freshBoard();
});

// ---------- matching ----------

test('suffix matching: a prop event belongs only to the game whose mapped winner event has the same suffix', () => {
  const g4 = board.games.find((g) => g.id === 'g4');
  const g5 = board.games.find((g) => g.id === 'g5');
  assert.equal(g4.kalshi.gameEvent, 'KXMLBGAME-26OCT161800TBCLE', 'postponed Game 4 keeps its own winner event (game-number rule)');
  assert.equal(g5.kalshi.gameEvent, 'KXMLBGAME-26OCT172000TBCLE');
  const ctxOf = (g) => ({ league: 'mlb', gameEventTicker: g.kalshi.gameEvent });
  assert.equal(P.propBelongsToGame('KXMLBHR-26OCT161800TBCLE', ctxOf(g4)), true);
  assert.equal(P.propBelongsToGame(G4HR, ctxOf(g4)), true, 'a market ticker too');
  assert.equal(P.propBelongsToGame(G5HR, ctxOf(g4)), false, "Game 5's props never on Game 4");
  assert.equal(P.propBelongsToGame(G4HR, ctxOf(g5)), false);
  assert.equal(P.propBelongsToGame('KXNFLTD-26OCT161800TBCLE', ctxOf(g4)), false, 'a series of another league');
  assert.equal(P.propBelongsToGame('KXMLBXYZ-26OCT161800TBCLE', ctxOf(g4)), false, 'an unconfigured series');
  assert.equal(P.propBelongsToGame(G4HR, { league: 'mlb', gameEventTicker: null }), false, 'no mapped winner → nothing');
  assert.equal(P.propEventTickerFor('KXMLBHIT', g4.kalshi.gameEvent), 'KXMLBHIT-26OCT161800TBCLE');
});

test('props page: each game shows its own props; tabs, players sorted by team then volume, main threshold nearest $0.50; failing prices hidden', async () => {
  const d4 = await getGameDetail('mlb', 'g4', { fetchImpl, now: () => NOW, props: true });
  assert.equal(d4.props.open, true);
  assert.deepEqual(d4.props.tabs.map((t) => t.stat), ['HR', 'Hits']);
  const hr = d4.props.tabs[0];
  assert.deepEqual(hr.players.map((p) => p.name), ['Junior Caminero', 'José Ramírez'], 'away team first (Rays), Díaz hidden (no tradable threshold)');
  assert.deepEqual(hr.players.map((p) => p.team), ['Rays', 'Guardians']);
  const ram = hr.players[1];
  assert.deepEqual(ram.rows.map((r) => r.threshold), [1], 'the 2+ HR at $0.02 is hidden');
  assert.equal(ram.rows[0].yes.ref.price, 0.3, "Game 4's own market");
  assert.deepEqual(ram.rows[0].labels, { yes: '1+ HR', no: 'No HR' });
  const hits = d4.props.tabs[1].players[0];
  assert.deepEqual(hits.rows.map((r) => r.threshold), [1, 2, 3]);
  assert.equal(hits.mainTicker, 'KXMLBHIT-26OCT161800TBCLE-CLEJRAMIREZ11-2', 'YES ask $0.45 is nearest $0.50');
  assert.deepEqual(hits.rows[1].labels, { yes: '2+', no: 'Under 2' });
  assert.ok(world.calls.every((c) => !c.includes('/events/KXMLB') || c.includes('161800') || c.includes('172000')));

  const d5 = await getGameDetail('mlb', 'g5', { fetchImpl, now: () => NOW, props: true });
  assert.equal(d5.props.tabs[0].players.find((p) => p.name === 'José Ramírez').rows[0].yes.ref.price, 0.4, "Game 5's own market");

  // Main game page: a "Player props" count only before the game.
  const page = await getGameDetail('mlb', 'g4', { fetchImpl, now: () => NOW });
  assert.equal(page.propsCount, 2, 'distinct players (José Ramírez has both an HR and a Hits row)');
  // 30 s memory cache, nothing in Firestore.
  const before = world.calls.length;
  await getGameDetail('mlb', 'g4', { fetchImpl, now: () => new Date(NOW.getTime() + 10e3), props: true });
  assert.equal(world.calls.length, before, 'props from memory within 30 s');
  assert.ok(![...fake.store.keys()].some((k) => k.includes('prop')), 'no prop data in Firestore');
});

test('no mapped winner event → no props; after the start → no props (state in, or clock at the start)', async () => {
  // No game number from ESPN and no Kalshi winner event in Game 4's date slot → Game 4 unmapped.
  resetWorld({ g4Headline: 'ALCS - Game 7' });
  await freshBoard();
  const g4 = board.games.find((g) => g.id === 'g4');
  assert.equal(g4.kalshi, null, 'Game 7 has no Kalshi events → not mapped');
  const d = await getGameDetail('mlb', 'g4', { fetchImpl, now: () => NOW, props: true });
  assert.deepEqual(d.props.tabs, []);
  assert.equal((await getGameDetail('mlb', 'g4', { fetchImpl, now: () => NOW })).propsCount, 0);

  resetWorld();
  await freshBoard();
  const atStart = await getGameDetail('mlb', 'g4', { fetchImpl, now: () => new Date(G4_START), props: true });
  assert.equal(atStart.props.open, false);
  assert.equal(atStart.props.reason, P.PROP_CLOSED_MESSAGE);
  assert.equal(P.propsOpen({ state: 'pre', startTime: G4_START }, Date.parse(G4_START) - 1), true);
  assert.equal(P.propsOpen({ state: 'pre', startTime: G4_START }, Date.parse(G4_START)), false);
  assert.equal(P.propsOpen({ state: 'in', startTime: G4_START }, Date.parse(G4_START) - MIN), false);
});

// ---------- pricing ----------

test('pricing: a valid prop prices at the ask; refusals for every rule', async () => {
  let r = await priceLeg(propLeg(G4HR, 'yes'), pctx());
  assert.equal(r.status, 'ok');
  assert.equal(r.quote.ref.price, 0.3);
  assert.equal(r.quote.line, 0.5);
  r = await priceLeg(propLeg(G4HR, 'no'), pctx());
  assert.equal(r.quote.ref.price, 0.72);

  // Unknown series.
  r = await priceLeg({ ...propLeg(G4HR), kalshiTicker: 'KXMLBXYZ-26OCT161800TBCLE-CLEJRAMIREZ11-1' }, pctx());
  assert.equal(r.status, 'closed');
  assert.match(r.reason, /not offered/);
  // A ticker from another game's event (Game 5's prop on Game 4).
  r = await priceLeg({ ...propLeg(G4HR), kalshiTicker: G5HR }, pctx());
  assert.equal(r.status, 'closed');
  assert.match(r.reason, /not offered for this game/);
  // Inactive market.
  findMarket(G4HR).status = 'closed';
  r = await priceLeg(propLeg(G4HR), pctx());
  assert.equal(r.status, 'closed');
  findMarket(G4HR).status = 'active';
  // Price outside the checks: ask above MAX_PRICE, gap too wide.
  Object.assign(findMarket(G4HR), { yes_ask_dollars: '0.9800', yes_bid_dollars: '0.9700' });
  assert.equal((await priceLeg({ ...propLeg(G4HR), quotedAmerican: -4900 }, pctx())).status, 'closed');
  Object.assign(findMarket(G4HR), { yes_ask_dollars: '0.3000', yes_bid_dollars: '0.1000' });
  assert.equal((await priceLeg(propLeg(G4HR), pctx())).status, 'closed', 'gap 0.20 > 0.15');
  Object.assign(findMarket(G4HR), { yes_bid_dollars: '0.2800' });

  // Another threshold's strike is another bet.
  r = await priceLeg({ ...propLeg(G4HR), line: 1.5 }, pctx());
  assert.equal(r.status, 'lineChanged');

  // The game has started: clock at/after the start, or ESPN says 'in'.
  r = await priceLeg(propLeg(G4HR), pctx(new Date(G4_START)));
  assert.equal(r.status, 'closed');
  assert.equal(r.reason, P.PROP_CLOSED_MESSAGE);
  resetWorld({ g4State: 'in' });
  r = await priceLeg(propLeg(G4HR), pctx(new Date(Date.parse(G4_START) - 5 * MIN)));
  assert.equal(r.status, 'closed', 'ESPN in progress, even before the scheduled start');
  assert.equal(r.reason, P.PROP_CLOSED_MESSAGE);
});

test('placing a prop stores label, strike and ticker; the 50-point odds rule applies', async () => {
  const res = await placeBets(caller('mike'), { mode: 'singles', clientRequestId: rid(), legs: [{ ...propLeg('KXMLBHIT-26OCT161800TBCLE-CLEJRAMIREZ11-2', 'no'), stakeCents: 1000 }] }, { now: NOW, fetchImpl, ctx: pctx() });
  const leg = res.bets[0].legs[0];
  assert.equal(leg.label, 'José Ramírez Under 2 Hits');
  assert.equal(leg.marketType, 'prop');
  assert.equal(leg.line, 1.5);
  assert.equal(leg.gameId, 'g4');
  assert.equal(leg.sourceRef.ticker, 'KXMLBHIT-26OCT161800TBCLE-CLEJRAMIREZ11-2');
  assert.deepEqual(leg.prop.player, 'José Ramírez');
  const hr = await placeBets(caller('mike'), { mode: 'singles', clientRequestId: rid(), legs: [{ ...propLeg(G4HR, 'yes'), stakeCents: 100 }] }, { now: NOW, fetchImpl, ctx: pctx() });
  assert.equal(hr.bets[0].legs[0].label, 'José Ramírez 1+ HR');
  const no = await placeBets(caller('mike'), { mode: 'singles', clientRequestId: rid(), legs: [{ ...propLeg(G4HR, 'no'), stakeCents: 100 }] }, { now: NOW, fetchImpl, ctx: pctx() });
  assert.equal(no.bets[0].legs[0].label, 'José Ramírez No HR');
  assert.equal(P.propPickLabel({ player: 'Derrick Henry', stat: 'Rush Yds', threshold: 50, selection: 'yes' }), 'Derrick Henry 50+ Rush Yds');
  assert.equal(P.propPickLabel({ player: 'Derrick Henry', stat: 'Rush Yds', threshold: 50, selection: 'no' }), 'Derrick Henry Under 50 Rush Yds');
  assert.equal(P.propPickLabel({ player: 'Derrick Henry', stat: 'TD', threshold: 1, anytime: true, selection: 'no' }), 'Derrick Henry No TD');

  // Price moved 50+ points from what the player saw → ODDS_CHANGED, nothing placed.
  const balance = fake.get('users/dan').balanceCents;
  await assert.rejects(
    placeBets(caller('dan'), { mode: 'singles', clientRequestId: rid(), legs: [{ ...propLeg(G4HR, 'yes', { quotedAmerican: 180 }), stakeCents: 1000 }] }, { now: NOW, fetchImpl, ctx: pctx() }),
    (e) => e.code === 'ODDS_CHANGED',
  );
  assert.equal(fake.get('users/dan').balanceCents, balance);
});

// ---------- parlays ----------

// 0.15.0: same-game parlays with props are allowed; at most one leg per player per stat (series + the ticker's player
// segment). ML + spread from one game and crypto singles-only are unchanged.
// A team-market leg exactly as the board quotes it (Kalshi ticker when the quote is Kalshi's).
function teamLeg(gameId, marketType, selection) {
  const q = board.games.find((g) => g.id === gameId).markets[marketType][selection];
  assert.ok(q, `board quote ${gameId} ${marketType} ${selection}`);
  const ticker = q.source === 'kalshi' ? q.ref?.ticker : null;
  return { league: 'mlb', gameId, marketType, selection, line: q.line ?? null, quotedAmerican: q.american, ...(ticker ? { kalshiTicker: ticker, kalshiSide: q.ref.side } : {}) };
}
const HIT1 = 'KXMLBHIT-26OCT161800TBCLE-CLEJRAMIREZ11-1';
const HIT2 = 'KXMLBHIT-26OCT161800TBCLE-CLEJRAMIREZ11-2';
const CAM = 'KXMLBHR-26OCT161800TBCLE-TBJCAMINERO13-1';
const parlayOf = (uid, legs) => placeBets(caller(uid), { mode: 'parlay', clientRequestId: rid(), stakeCents: 500, legs }, { now: NOW, fetchImpl, ctx: pctx() });

test('parlays accepted: prop + same-game moneyline; two players from one game; same player on different stats; props from two games', async () => {
  const a = await parlayOf('mike', [propLeg(G4HR), teamLeg('g4', 'moneyline', 'home')]);
  assert.equal(a.bets[0].type, 'parlay');
  assert.deepEqual(a.bets[0].legs.map((l) => l.marketType), ['prop', 'moneyline']);
  const b = await parlayOf('mike', [propLeg(G4HR), propLeg(CAM)]);
  assert.deepEqual(b.bets[0].legs.map((l) => l.label), ['José Ramírez 1+ HR', 'Junior Caminero 1+ HR']);
  const c = await parlayOf('dan', [propLeg(G4HR), propLeg(HIT2)]);
  assert.deepEqual(c.bets[0].legs.map((l) => l.label), ['José Ramírez 1+ HR', 'José Ramírez 2+ Hits'], 'Rush Yds + Anytime TD style: different stats');
  const d = await parlayOf('dan', [propLeg(CAM), propLeg(G5HR), teamLeg('g4', 'total', 'over')]);
  assert.equal(d.bets[0].legs.length, 3, 'a prop with another game and with a same-game total');
  assert.equal(fake.get('users/mike').balanceCents, 10_000 - 1000);
  assert.equal(fake.get('users/dan').balanceCents, 10_000 - 1000);
  // Singles from the same game, as before.
  const singles = await placeBets(caller('dan'), { mode: 'singles', clientRequestId: rid(), legs: [{ ...propLeg(G4HR), stakeCents: 100 }, { ...propLeg(CAM), stakeCents: 100 }] }, { now: NOW, fetchImpl, ctx: pctx() });
  assert.equal(singles.bets.length, 2);
});

test('parlays refused: same player + stat at two thresholds, YES and NO on one market, ML + spread from one game; nothing placed or fetched', async () => {
  const msg = 'You already have a José Ramírez Hits pick in this parlay.';
  const named = (ticker, side = 'yes') => ({ ...propLeg(ticker, side), playerName: 'José Ramírez' });
  const before = world.calls.length;
  await assert.rejects(parlayOf('mike', [named(HIT1), named(HIT2)]), (e) => e.code === 'BAD_SLIP' && e.message === msg);
  await assert.rejects(parlayOf('mike', [named(HIT2, 'no'), named(HIT2, 'yes')]), (e) => e.code === 'BAD_SLIP' && e.message === msg);
  await assert.rejects(parlayOf('mike', [named(HIT1, 'yes'), propLeg(G4HR), named(HIT2, 'no')]), (e) => e.code === 'BAD_SLIP' && e.message === msg, 'not next to each other');
  // The decision is the ticker's: another name (or none) changes only the text, never the answer.
  await assert.rejects(parlayOf('mike', [propLeg(HIT1), { ...propLeg(HIT2), playerName: 'Someone Else' }]), (e) => e.code === 'BAD_SLIP' && e.message === 'You already have a Someone Else Hits pick in this parlay.');
  await assert.rejects(parlayOf('mike', [propLeg(HIT1), propLeg(HIT2)]), (e) => e.code === 'BAD_SLIP' && e.message === 'You already have a Hits pick on that player in this parlay.');
  // Same player and stat in two different games: still one player per stat in this parlay (the rule names no game).
  await assert.rejects(parlayOf('mike', [named(G4HR), named(G5HR)]), (e) => e.code === 'BAD_SLIP' && e.message === 'You already have a José Ramírez HR pick in this parlay.');
  // Unchanged: ML + spread from one game.
  await assert.rejects(parlayOf('mike', [teamLeg('g4', 'moneyline', 'home'), teamLeg('g4', 'spread', 'away'), propLeg(G4HR)]), (e) => e.code === 'BAD_SLIP' && e.message === rules.PARLAY_ML_SPREAD_MESSAGE);
  assert.equal(world.calls.length, before, 'refused before pricing: no Kalshi or ESPN request');
  assert.equal(fake.get('users/mike').balanceCents, 10_000);
  assert.equal([...fake.store.keys()].filter((k) => k.startsWith('bets/')).length, 0, 'no bet written');
});

test('slip rules mirror the server: named message in a parlay; singles keep one pick per player per stat by swapping', async () => {
  const { betSlipReducer, initialSlipState } = await import(url('src/lib/betSlipReducer.js'));
  const pick = (ticker, side, threshold, stat = 'Hits') => ({
    legId: `mlb:g4:prop:${ticker}:${side}:${threshold - 0.5}`, kalshi: { ticker, side }, league: 'mlb', gameId: 'g4', marketType: 'prop', selection: side,
    line: threshold - 0.5, american: 120, decimal: 2.2, source: 'kalshi', gameLabel: 'Rays @ Guardians',
    prop: { series: ticker.split('-')[0], stat, player: 'José Ramírez', team: 'Guardians', threshold }, label: `José Ramírez ${threshold}+ ${stat}`,
  });
  const ml = { legId: 'mlb:g4:moneyline:home:kalshi', league: 'mlb', gameId: 'g4', marketType: 'moneyline', selection: 'home', line: null, american: -120, decimal: 1.83, source: 'kalshi' };
  let s = betSlipReducer(initialSlipState, { type: 'toggle', pick: pick(HIT1, 'yes', 1) });
  s = betSlipReducer(s, { type: 'toggle', pick: ml });
  s = betSlipReducer(s, { type: 'setMode', mode: 'parlay' });
  assert.equal(s.mode, 'parlay', 'prop + same-game moneyline can be a parlay');
  assert.deepEqual(rules.slipProblems({ mode: 'parlay', legs: s.legs, stakeCents: 500 }), []);
  const refused = betSlipReducer(s, { type: 'toggle', pick: pick(HIT2, 'yes', 2) });
  assert.equal(refused.notice, 'You already have a José Ramírez Hits pick in this parlay.');
  assert.deepEqual(refused.legs.map((l) => l.legId), s.legs.map((l) => l.legId), 'nothing swapped or added');
  assert.equal(betSlipReducer(s, { type: 'toggle', pick: pick(HIT1, 'no', 1) }).notice, 'You already have a José Ramírez Hits pick in this parlay.', 'YES then NO, same market');
  const other = betSlipReducer(s, { type: 'toggle', pick: pick(G4HR, 'yes', 1, 'HR') });
  assert.equal(other.legs.length, 3, 'same player, another stat');
  assert.equal(other.notice, '');
  // Tapping the same pick again still removes it.
  assert.equal(betSlipReducer(s, { type: 'toggle', pick: pick(HIT1, 'yes', 1) }).legs.length, 1);
  // Singles: another threshold replaces the old one (0.14.0 behavior).
  let single = betSlipReducer(initialSlipState, { type: 'toggle', pick: pick(HIT1, 'yes', 1) });
  single = betSlipReducer(single, { type: 'toggle', pick: pick(HIT2, 'yes', 2) });
  assert.deepEqual(single.legs.map((l) => l.kalshi.ticker), [HIT2]);
  // slipProblems on a hand-made parlay (as the server would see it) names the player from the pick.
  assert.deepEqual(rules.slipProblems({ mode: 'parlay', stakeCents: 500, legs: [pick(HIT1, 'yes', 1), pick(HIT2, 'no', 2)] }), ['You already have a José Ramírez Hits pick in this parlay.']);
  assert.equal(rules.propStatKey({ marketType: 'prop', kalshiTicker: 'KXNFLRSHYDS-26OCT18BALCLE-CLEDWATSON4-30' }), 'KXNFLRSHYDS-CLEDWATSON4');
  assert.equal(rules.propStatKey({ marketType: 'moneyline' }), null);
  assert.equal(P.propConflictMessage({ player: 'Derrick Henry', stat: 'Rush Yds' }), 'You already have a Derrick Henry Rush Yds pick in this parlay.');
});

// ---------- grading and settlement ----------

test('grading from Kalshi: yes → YES wins; no → NO wins; voided → void; finalized non-yes/no → void; unsettled → pending', () => {
  const L = (selection) => ({ marketType: 'prop', selection });
  const R = props.resultFromPropMarket;
  assert.equal(gradeLeg(L('yes'), R({ status: 'finalized', result: 'yes' })).result, 'win');
  assert.equal(gradeLeg(L('no'), R({ status: 'finalized', result: 'yes' })).result, 'loss');
  assert.equal(gradeLeg(L('no'), R({ status: 'settled', result: 'no' })).result, 'win');
  assert.equal(gradeLeg(L('yes'), R({ status: 'settled', result: 'no' })).result, 'loss');
  assert.equal(gradeLeg(L('yes'), R({ status: 'voided', result: '' })).result, 'void');
  assert.equal(gradeLeg(L('yes'), R({ status: 'finalized', result: 'scalar' })).result, 'void', 'scratched player settled at a fair price');
  assert.equal(gradeLeg(L('no'), R({ status: 'finalized', result: '' })).result, 'void');
  assert.equal(gradeLeg(L('yes'), R({ status: 'active', result: '' })).result, 'pending');
  assert.equal(gradeLeg(L('yes'), R({ status: 'closed', result: '' })).result, 'pending');
  assert.equal(gradeLeg(L('yes'), R(null)).result, 'pending');
});

test('settlement runs grade props from Kalshi with the usual ledger ids and win rate; a void returns the stake', async () => {
  const place = async (uid, l) => (await placeBets(caller(uid), { mode: 'singles', clientRequestId: rid(), legs: [{ ...l, stakeCents: 1000 }] }, { now: NOW, fetchImpl, ctx: pctx() })).bets[0];
  const yes = await place('mike', propLeg(G4HR, 'yes'));
  const no = await place('dan', propLeg(G4HR, 'no'));
  const scratched = await place('mike', propLeg('KXMLBHR-26OCT161800TBCLE-TBJCAMINERO13-1', 'yes'));
  const later = new Date(Date.parse(G4_START) + 4 * 3600e3);
  assert.equal((await settleOpenBets({ trigger: 'admin', force: true, now: later, fetchImpl })).settled, 0, 'nothing until Kalshi settles');
  Object.assign(findMarket(G4HR), { status: 'finalized', result: 'yes' });
  Object.assign(findMarket('KXMLBHR-26OCT161800TBCLE-TBJCAMINERO13-1'), { status: 'finalized', result: 'scalar' });
  const run = await settleOpenBets({ trigger: 'cron', force: true, now: later, fetchImpl });
  assert.equal(run.settled, 3);
  assert.deepEqual([fake.get(`bets/${yes.id}`).status, fake.get(`bets/${no.id}`).status, fake.get(`bets/${scratched.id}`).status], ['won', 'lost', 'void']);
  assert.ok(fake.get(`ledger/payout_${yes.id}`));
  assert.equal(fake.get('users/mike').stats.won, 1);
  assert.equal(fake.get('users/dan').stats.lost, 1);
  assert.equal(fake.get(`bets/${scratched.id}`).payoutCents, 1000, 'stake back');
});

// ---------- cash out ----------

test('cash out on a prop: pre-game stake × 0.90; after the start potential × fresh bid × 0.90 (wide gap → unavailable)', async () => {
  const b = (await placeBets(caller('mike'), { mode: 'singles', clientRequestId: rid(), legs: [{ ...propLeg(G4HR, 'yes'), stakeCents: 1000 }] }, { now: NOW, fetchImpl, ctx: pctx() })).bets[0];
  const deps = (now) => ({ now, fetchImpl, makeContext: (o) => cashout.createCashoutContext({ ...o, getBoard: async () => board }) });
  let q = await cashout.quoteBets(caller('mike'), { betIds: [b.id] }, deps(NOW));
  assert.deepEqual(q.quotes[b.id], { available: true, valueCents: 900, mode: 'pregame' });

  // Game 4 underway: ESPN says in progress; the bid formula.
  world.espn[20261017] = [espnRaw('g4', G4_START, 'in', 'ALCS - Game 4')];
  await freshBoard(new Date(Date.parse(G4_START) + 20 * MIN));
  Object.assign(findMarket(G4HR), { yes_bid_dollars: '0.4000', yes_ask_dollars: '0.4200' });
  cashout.clearEstimateCache();
  const live = new Date(Date.parse(G4_START) + 20 * MIN);
  q = await cashout.quoteBets(caller('mike'), { betIds: [b.id] }, deps(live));
  const potential = fake.get(`bets/${b.id}`).potentialPayoutCents;
  assert.deepEqual(q.quotes[b.id], { available: true, valueCents: Math.floor(potential * 0.4 * 0.9), mode: 'live' });
  Object.assign(findMarket(G4HR), { yes_bid_dollars: '0.2000', yes_ask_dollars: '0.4200' });
  cashout.clearEstimateCache();
  q = await cashout.quoteBets(caller('mike'), { betIds: [b.id] }, deps(live));
  assert.equal(q.quotes[b.id].available, false, 'gap 0.22 too wide');
  Object.assign(findMarket(G4HR), { yes_bid_dollars: '0.0000' });
  cashout.clearEstimateCache();
  q = await cashout.quoteBets(caller('mike'), { betIds: [b.id] }, deps(live));
  assert.equal(q.quotes[b.id].available, false, 'no bid');
});
