// npm run test:agents  (or: node --experimental-test-module-mocks --test test/agents/agents.test.mjs)
// 0.21.0 AI agent players: the house rules in placeBet (each refusal, the 5% floor in cents, the daily counter across a
// Central midnight, a retried clientRequestId never counting twice), agentWhy, "mine", cash out / Battles refusals, and
// the performance totals kept by settlement, regrades and cash out, matched by rebuildStats.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;
const require = createRequire(`${root}/package.json`);
const { Timestamp } = require('firebase-admin/firestore');

// ---------- fake Firestore: optimistic transactions that interleave and retry on conflict ----------
const store = new Map();
const versions = new Map();
let clock = 0;
let autoId = 0;
const clone = (v) => {
  if (v === null || typeof v !== 'object') return v;
  if (typeof v.toMillis === 'function') return v;
  if (Array.isArray(v)) return v.map(clone);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
};
const tick = () => new Promise((r) => setImmediate(r));
function write(path, data) { if (data === undefined) store.delete(path); else store.set(path, clone(data)); versions.set(path, ++clock); }
function snap(path) { const d = store.get(path); return { exists: d !== undefined, id: path.split('/').pop(), ref: { path, id: path.split('/').pop() }, data: () => clone(d) }; }
function ref(path) {
  return {
    path, id: path.split('/').pop(),
    async get() { await tick(); return snap(path); },
    async set(v, opts) { write(path, opts?.merge ? { ...(store.get(path) ?? {}), ...v } : v); },
    async update(v) { if (!store.has(path)) throw new Error(`NOT_FOUND ${path}`); write(path, { ...store.get(path), ...v }); },
    async delete() { write(path, undefined); },
  };
}
function matches(x, op, v) {
  if (op === '==') return x === v;
  if (op === '!=') return x !== undefined && x !== null && JSON.stringify(x) !== JSON.stringify(v);
  if (op === '<') return x !== undefined && x < v;
  if (op === 'in') return v.includes(x);
  throw new Error(`fake query: ${op}`);
}
function makeQuery(name, filters = [], max = Infinity) {
  return {
    where: (field, op, value) => makeQuery(name, [...filters, [field, op, value]], max),
    limit: (n) => makeQuery(name, filters, n),
    async get() {
      await tick();
      const docs = [...store.keys()]
        .filter((p) => p.startsWith(`${name}/`) && p.split('/').length === 2)
        .filter((p) => filters.every(([f, op, v]) => matches(store.get(p)[f], op, v)))
        .slice(0, max)
        .map(snap);
      return { docs, size: docs.length, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn) };
    },
  };
}
class AlreadyExists extends Error { constructor() { super('ALREADY_EXISTS'); this.code = 6; } }
const fakeDb = {
  collection: (name) => ({
    doc: (id) => ref(`${name}/${id ?? `auto${++autoId}`}`),
    where: (...a) => makeQuery(name).where(...a),
    limit: (n) => makeQuery(name).limit(n),
    get: () => makeQuery(name).get(),
  }),
  batch() {
    const ops = [];
    return { delete: (r) => ops.push(() => write(r.path, undefined)), update: (r, d) => ops.push(() => write(r.path, { ...store.get(r.path), ...d })), create: (r, d) => ops.push(() => write(r.path, d)), set: (r, d) => ops.push(() => write(r.path, d)), commit: async () => ops.forEach((f) => f()) };
  },
  async runTransaction(fn) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const reads = new Map();
      const ops = [];
      const tx = {
        get: async (r) => { reads.set(r.path, versions.get(r.path) ?? 0); await tick(); return snap(r.path); },
        create: (r, d) => ops.push({ kind: 'create', path: r.path, data: d }),
        set: (r, d, o) => ops.push({ kind: o?.merge ? 'merge' : 'set', path: r.path, data: d }),
        update: (r, d) => ops.push({ kind: 'update', path: r.path, data: d }),
        delete: (r) => ops.push({ kind: 'delete', path: r.path }),
      };
      const result = await fn(tx);
      await tick();
      if ([...reads].some(([p, v]) => (versions.get(p) ?? 0) !== v)) continue;
      for (const op of ops) if (op.kind === 'create' && store.has(op.path)) throw new AlreadyExists();
      for (const op of ops) {
        if (op.kind === 'delete') write(op.path, undefined);
        else write(op.path, op.kind === 'update' || op.kind === 'merge' ? { ...(store.get(op.path) ?? {}), ...op.data } : op.data);
      }
      return result;
    }
    throw new Error('transaction contention');
  },
};
mock.module(url('server/firebaseAdmin.js'), { namedExports: { adminDb: () => fakeDb, adminAuth: () => ({}), normalizePrivateKey: (k) => k } });
let authCaller = null;
mock.module(url('server/auth.js'), { namedExports: { requireUser: async () => authCaller, requireAdmin: async () => authCaller, requireToken: async () => authCaller, checkProfile: (s) => s.data() } });

const A = await import(url('shared/agents.js'));
const S = await import(url('shared/perfStats.js'));
const { placeBets, legHasStarted } = await import(url('server/placeBet.js'));
const { myBets } = await import(url('server/agentMine.js'));
const { settleOpenBets, settleBet, pruneAgentDaily } = await import(url('server/settlement.js'));
const cg = await import(url('server/admin/customGames.js'));
const rg = await import(url('server/admin/bets.js'));
const { rebuildStats } = await import(url('server/admin/rebuildStats.js'));
const cashout = await import(url('server/cashout.js'));
const battlesApi = (await import(url('api/battles.js'))).default;
const { makeQuote } = await import(url('shared/oddsMath.js'));
const { centralWallParts } = await import(url('shared/time.js'));

const HOUR = 3600e3;
const admin = { uid: 'admin1', token: { admin: true }, user: { username: 'will', role: 'admin' } };
const AGENT = { provider: 'anthropic', label: 'Claude Sonnet' };

function seedUser(uid, username, balanceCents, extra = {}) {
  write(`users/${uid}`, { username, balanceCents, stats: { won: 0, lost: 0 }, ...extra });
}
const caller = (uid) => ({ uid, token: {}, user: store.get(`users/${uid}`) });
const bal = (uid) => store.get(`users/${uid}`).balanceCents;

// A world with ESPN games the pricing context answers directly: g1 pre-game (in 2 h), g2 in progress (Kalshi live price).
function espnGame(id, state, startMs) {
  return {
    id, league: 'nfl', source: 'espn', state, startTime: new Date(startMs).toISOString(), canceled: false,
    home: { shortName: 'Texans' }, away: { shortName: 'Jaguars' },
    markets: { moneyline: { home: makeQuote(-150, { source: 'espn' }), away: makeQuote(130, { source: 'espn' }) }, spread: { home: null, away: null }, total: { over: null, under: null } },
  };
}
const ctxAt = (now) => ({
  now,
  board: async () => ({ games: [] }),
  freshEspnGames: async () => [espnGame('g1', 'pre', now.getTime() + 2 * HOUR), espnGame('g2', 'in', now.getTime() - HOUR), espnGame('g3', 'pre', now.getTime() + 3 * HOUR)],
  freshKalshiForGames: async () => new Map([['g2', { moneyline: { home: makeQuote(-200, { source: 'kalshi', ref: { ticker: 'KXNFLGAME-X-HOU', side: 'yes' } }), away: makeQuote(170, { source: 'kalshi' }) } }]]),
  market: async () => null,
  customGame: async (id) => (store.has(`customGames/${id}`) ? clone(store.get(`customGames/${id}`)) : null),
});
let reqN = 0;
const nextId = () => `req-${String(++reqN).padStart(6, '0')}`;
const ML = (gameId, selection = 'home', stakeCents, quotedAmerican) => ({ league: 'nfl', gameId, marketType: 'moneyline', selection, line: null, quotedAmerican: quotedAmerican ?? (selection === 'home' ? -150 : 130), stakeCents });
function place(uid, legs, { mode = 'singles', stakeCents, why, now = new Date(), id = nextId() } = {}) {
  return placeBets(caller(uid), { mode, clientRequestId: id, stakeCents, legs, ...(why !== undefined ? { why } : {}) }, { now, ctx: ctxAt(now) });
}
const code = (c) => (e) => {
  assert.equal(e.code, c, `${e.code}: ${e.message}`);
  return true;
};

beforeEach(() => {
  store.clear();
  versions.clear();
  seedUser('bot', 'claude-big', 10000, { agent: AGENT });
  seedUser('mike', 'mike', 10000);
});

// ---------- shared rules ----------
test('agent rules: 5% cap floors to the cent; Central day across daylight and standard time; why cleaning', () => {
  assert.equal(A.agentStakeCapCents(10000), 500);
  assert.equal(A.agentStakeCapCents(9999), 499, '499.95 → 499');
  assert.equal(A.agentStakeCapCents(1999), 99);
  assert.equal(A.agentStakeCapCents(0), 0);
  assert.equal(A.centralDay(new Date('2026-10-27T04:59:59Z')), '2026-10-26', '11:59:59 pm CDT');
  assert.equal(A.centralDay(new Date('2026-10-27T05:00:00Z')), '2026-10-27', 'midnight CDT');
  assert.equal(A.centralDay(new Date('2026-12-02T05:59:59Z')), '2026-12-01', '11:59:59 pm CST');
  assert.equal(A.centralDay(new Date('2026-12-02T06:00:00Z')), '2026-12-02', 'midnight CST');
  assert.equal(A.centralDayMinus(new Date('2026-03-02T12:00:00Z'), 3), '2026-02-27');
  assert.equal(A.cleanAgentWhy('  Texans\tML:\u0007 58%\nvs 60% implied  '), 'Texans ML: 58% vs 60% implied');
  const long = '😀'.repeat(300);
  assert.equal([...A.cleanAgentWhy(long)].length, 280, 'counted like chat: an emoji is one');
  assert.equal(A.cleanAgentWhy(42), '');
  assert.deepEqual(A.cleanAgentProfile({ provider: 'OpenAI', label: ' GPT mini ' }), { provider: 'openai', label: 'GPT mini' });
  assert.throws(() => A.cleanAgentProfile({ provider: 'meta', label: 'x' }), /Provider/);
  assert.throws(() => A.cleanAgentProfile({ provider: 'google', label: '' }), /label/);
  assert.equal(legHasStarted({ state: 'pre', startTime: new Date(Date.now() + 1000).toISOString() }, new Date()), false);
  assert.equal(legHasStarted({ state: 'pre', startTime: new Date(Date.now() - 1000).toISOString() }, new Date()), true);
  assert.equal(legHasStarted({ state: 'in' }, new Date()), true);
});

// ---------- placeBet house rules ----------
test('agents: crypto → AGENT_NO_CRYPTO and Challenge legs → AGENT_NOT_ALLOWED, before anything is priced or written', async () => {
  const before = JSON.stringify([...store]);
  await assert.rejects(place('bot', [{ league: 'crypto', gameId: 'crypto:BTC-X', marketType: 'crypto', selection: 'yes', line: 100000, quotedAmerican: 100, stakeCents: 100, kalshiTicker: 'KXBTCD-26OCT27-T100000', kalshiSide: 'yes' }]), code('AGENT_NO_CRYPTO'));
  await assert.rejects(place('bot', [{ league: 'challenge', gameId: 'challenge:c1', marketType: 'challenge', selection: 'o1', line: null, quotedAmerican: 150, stakeCents: 100 }]), code('AGENT_NOT_ALLOWED'));
  assert.equal(JSON.stringify([...store]), before, 'nothing written');
});

test('agents: pre-game only (a game in progress → AGENT_PREGAME_ONLY); a person can still bet it live', async () => {
  await assert.rejects(place('bot', [ML('g2', 'home', 100, -200)]), (e) => {
    assert.equal(e.code, 'AGENT_PREGAME_ONLY');
    assert.equal(e.status ?? e.statusCode, 409);
    return true;
  });
  // In a parlay with a pre-game leg too.
  await assert.rejects(place('bot', [ML('g1', 'home'), ML('g2', 'home', undefined, -200)], { mode: 'parlay', stakeCents: 100 }), code('AGENT_PREGAME_ONLY'));
  assert.equal(bal('bot'), 10000);
  const r = await place('mike', [ML('g2', 'home', 100, -200)]);
  assert.equal(r.bets.length, 1);
});

test('agents: at most 5% of the balance per slip, floored to the cent; a parlay counts once; under $20 nothing fits', async () => {
  await assert.rejects(place('bot', [ML('g1', 'home', 501)]), (e) => {
    assert.equal(e.code, 'AGENT_STAKE_CAP');
    assert.equal(e.extra?.capCents ?? e.details?.capCents ?? e.capCents ?? 500, 500);
    return true;
  });
  const ok = await place('bot', [ML('g1', 'home', 500)]);
  assert.equal(ok.balanceCents, 9500);
  // Balance $95.00 now: the cap is $4.75.
  await assert.rejects(place('bot', [ML('g3', 'away', 476)]), code('AGENT_STAKE_CAP'));
  await place('bot', [ML('g3', 'away', 475)]);
  assert.equal(bal('bot'), 9025);
  // Parlay: one stake against the cap (not one per leg). $90.25 → $4.51.
  const parlay = await place('bot', [ML('g1', 'away'), ML('g3', 'home')], { mode: 'parlay', stakeCents: 451 });
  assert.equal(parlay.bets.length, 1);
  await assert.rejects(place('bot', [ML('g1', 'away'), ML('g3', 'home')], { mode: 'parlay', stakeCents: 430 + 100 }), code('AGENT_STAKE_CAP'));
  // A $19.99 agent: 5% is $0.99, under the $1 minimum: refused.
  seedUser('poor', 'gemini', 1999, { agent: { provider: 'google', label: 'Gemini' } });
  await assert.rejects(place('poor', [ML('g1', 'home', 100)]), code('AGENT_STAKE_CAP'));
  // A person has no cap.
  await place('mike', [ML('g1', 'home', 5000)]);
  assert.equal(bal('mike'), 5000);
});

test('agents: 10 slips a Central day, counted in agentDaily inside the transaction; singles count each; resets at Central midnight', async () => {
  seedUser('bot', 'claude-big', 1_000_000, { agent: AGENT });
  const night = new Date('2026-10-27T04:50:00Z'); // 11:50 pm CDT on Oct 26
  for (let i = 0; i < 8; i += 1) await place('bot', [ML('g1', 'home', 100)], { now: night });
  // 2 singles in one request: 10 now.
  await place('bot', [ML('g1', 'home', 100), ML('g3', 'away', 100)], { now: night });
  assert.equal(store.get('agentDaily/bot_2026-10-26').count, 10);
  assert.equal(store.get('agentDaily/bot_2026-10-26').day, '2026-10-26');
  await assert.rejects(place('bot', [ML('g1', 'home', 100)], { now: night }), code('AGENT_DAILY_LIMIT'));
  const balanceAfter10 = bal('bot');
  // 11 minutes later it is Oct 27 in Chicago: a new counter.
  const after = new Date('2026-10-27T05:01:00Z');
  await place('bot', [ML('g1', 'home', 100)], { now: after });
  assert.equal(store.get('agentDaily/bot_2026-10-27').count, 1);
  assert.equal(store.get('agentDaily/bot_2026-10-26').count, 10, 'yesterday untouched');
  assert.equal(bal('bot'), balanceAfter10 - 100);
  // A people's bets are never counted.
  await place('mike', [ML('g1', 'home', 100)], { now: after });
  assert.equal([...store.keys()].filter((k) => k.startsWith('agentDaily/mike')).length, 0);
  // Two singles that would make 11 of 10: refused whole.
  for (let i = 0; i < 8; i += 1) await place('bot', [ML('g1', 'home', 100)], { now: after });
  await assert.rejects(place('bot', [ML('g1', 'home', 100), ML('g3', 'home', 100)], { now: after }), code('AGENT_DAILY_LIMIT'));
  assert.equal(store.get('agentDaily/bot_2026-10-27').count, 9);
});

test('agents: a retried or doubled clientRequestId places once and counts once', async () => {
  const id = nextId();
  const now = new Date();
  const first = await place('bot', [ML('g1', 'home', 200)], { id, now });
  const again = await place('bot', [ML('g1', 'home', 200)], { id, now });
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  const id2 = nextId();
  const both = await Promise.all([place('bot', [ML('g3', 'home', 100)], { id: id2, now }), place('bot', [ML('g3', 'home', 100)], { id: id2, now })]);
  assert.deepEqual(both.map((r) => r.duplicate).sort(), [false, true]);
  assert.equal(store.get(`agentDaily/bot_${A.centralDay(now)}`).count, 2, 'two slips, never four');
  assert.equal(bal('bot'), 10000 - 300);
});

test('agentWhy: cleaned, cut to 280 and stored on each bet; ignored for people', async () => {
  const r = await place('bot', [ML('g1', 'home', 100), ML('g3', 'away', 100)], { why: `Edge:\t58% fair vs 60% implied.\u0000${'x'.repeat(400)}` });
  for (const b of r.bets) {
    const stored = store.get(`bets/${b.id}`);
    assert.equal(stored.agentWhy.startsWith('Edge: 58% fair vs 60% implied.x'), true, stored.agentWhy.slice(0, 40));
    assert.equal([...stored.agentWhy].length, 280);
  }
  const p = await place('mike', [ML('g1', 'home', 100)], { why: 'I just like them' });
  assert.equal(store.get(`bets/${p.bets[0].id}`).agentWhy, undefined);
});

test('agents: no cash out (AGENT_NO_CASHOUT) and no Battles or Challenges (403 AGENT_NOT_ALLOWED)', async () => {
  await assert.rejects(cashout.cashOutBet(caller('bot'), { betId: 'any', expectedCents: 100 }), code('AGENT_NO_CASHOUT'));
  authCaller = caller('bot');
  const res = { statusCode: 200, headers: {}, body: null, headersSent: false, setHeader(a, b) { this.headers[a] = b; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
  for (const action of ['create', 'accept', 'postChallenge']) {
    const r = { ...res };
    await battlesApi({ method: 'POST', headers: {}, body: { action } }, r);
    assert.equal(r.statusCode, 403, action);
    assert.equal(r.body?.error?.code, 'AGENT_NOT_ALLOWED');
  }
  authCaller = null;
});

test('mine: the caller\'s open bets only, the balance and today\'s slips', async () => {
  const now = new Date();
  await place('bot', [ML('g1', 'home', 300)], { why: 'Home edge', now });
  await place('bot', [ML('g1', 'away'), ML('g3', 'home')], { mode: 'parlay', stakeCents: 200, now });
  await place('mike', [ML('g1', 'home', 700)], { now });
  const mine = await myBets(caller('bot'), {}, { now, db: fakeDb });
  assert.equal(mine.balanceCents, 10000 - 500);
  assert.equal(mine.openBets.length, 2);
  assert.ok(mine.openBets.every((b) => b.legs.length >= 1 && Number.isInteger(b.stakeCents) && b.potentialPayoutCents > b.stakeCents));
  assert.equal(mine.openBets.find((b) => b.type === 'single').why, 'Home edge');
  assert.deepEqual({ slips: mine.today.slips, limit: mine.today.limit }, { slips: 2, limit: 10 });
  const human = await myBets(caller('mike'), {}, { now, db: fakeDb });
  assert.equal(human.openBets.length, 1);
  assert.deepEqual({ slips: human.today.slips, limit: human.today.limit }, { slips: 0, limit: null });
});

test('the settle cron deletes agentDaily counters older than 3 days', async () => {
  for (const day of ['2026-10-20', '2026-10-23', '2026-10-24', '2026-10-27']) write(`agentDaily/bot_${day}`, { uid: 'bot', day, count: 1 });
  const n = await pruneAgentDaily(fakeDb, new Date('2026-10-27T15:00:00Z'));
  assert.equal(n, 2);
  assert.deepEqual([...store.keys()].filter((k) => k.startsWith('agentDaily/')).sort(), ['agentDaily/bot_2026-10-24', 'agentDaily/bot_2026-10-27']);
});

// ---------- performance totals ----------
test('perfStats: win, loss, push, void, cash out, parlay across leagues; ROI and win rate', () => {
  const bet = (league, stake, legs = 1) => ({ stakeCents: stake, legs: Array.from({ length: legs }, (_, i) => ({ league: Array.isArray(league) ? league[i] : league })) });
  let s = S.applyContribution({ won: 3, lost: 1 }, null);
  s = S.applyContribution(s, S.betContribution(bet('nfl', 1000), 'won', 1909));
  s = S.applyContribution(s, S.betContribution(bet('nfl', 500), 'lost', 0));
  s = S.applyContribution(s, S.betContribution(bet('mlb', 300), 'push', 300));
  s = S.applyContribution(s, S.betContribution(bet('mlb', 200), 'void', 200));
  s = S.applyContribution(s, S.betContribution(bet('nba', 1000), 'cashed_out', 900));
  s = S.applyContribution(s, S.betContribution(bet(['nfl', 'mlb'], 100, 2), 'won', 350));
  assert.equal(S.betContribution(bet('nfl', 100), 'open', 0), null);
  assert.deepEqual({ won: s.won, lost: s.lost, staked: s.stakedCents, returned: s.returnedCents, settled: s.settledBets }, { won: 5, lost: 2, staked: 3100, returned: 3659, settled: 6 });
  assert.deepEqual(s.byLeague.nfl, { staked: 1500, returned: 1909, won: 1, lost: 1 });
  assert.deepEqual(s.byLeague.mlb, { staked: 500, returned: 500, won: 0, lost: 0 }, 'push and void: stake staked and returned');
  assert.deepEqual(s.byLeague.nba, { staked: 1000, returned: 900, won: 0, lost: 0 }, 'cash out returns the cash-out amount');
  assert.deepEqual(s.byLeague.mixed, { staked: 100, returned: 350, won: 1, lost: 0 });
  assert.ok(Math.abs(S.roi(s.stakedCents, s.returnedCents) - 559 / 3100) < 1e-12);
  assert.equal(S.roi(0, 0), null);
  assert.equal(S.winRate(5, 2), 5 / 7);
  // Taking a contribution back (regrades) undoes it exactly.
  const back = S.applyContribution(s, S.betContribution(bet('nfl', 1000), 'won', 1909), -1);
  assert.deepEqual(back.byLeague.nfl, { staked: 500, returned: 0, won: 0, lost: 1 });
});

const ct = (offsetMs) => {
  const p = centralWallParts(new Date(Date.now() + offsetMs));
  return { startDate: p.date, startClock: p.clock };
};
const gameBody = (o = {}) => ({
  league: 'nfl', home: { name: 'Backyard Bears', abbr: 'BB', logoUrl: '' }, away: { name: 'Lawn Lions', abbr: 'LL', logoUrl: '' }, ...ct(2 * HOUR),
  odds: { moneyline: { home: '-150', away: '+130' }, spread: { homeLine: '-3.5', home: '-110', away: '-110' }, total: { line: '44.5', over: '-110', under: '-110' } },
  ...o,
});
const CL = (gameId, marketType, selection, line, quotedAmerican, stakeCents) => ({ league: 'nfl', gameId, marketType, selection, line, quotedAmerican, stakeCents });
const settledBetsOf = (uid) => [...store].filter(([k, v]) => k.startsWith('bets/') && v.uid === uid).map(([, v]) => v);
const pick = (st) => ({ won: st.won, lost: st.lost, stakedCents: st.stakedCents, returnedCents: st.returnedCents, settledBets: st.settledBets, byLeague: st.byLeague });

test('settlement keeps the totals for agents and people (win, loss, push, void, parlay; Battles never); regrades follow; rebuildStats matches', async () => {
  write('ledger/start_mike', { uid: 'mike', type: 'admin_adjust', amountCents: 10000 });
  write('ledger/start_bot', { uid: 'bot', type: 'admin_adjust', amountCents: 10000 });
  const { gameId } = await cg.createCustomGame(gameBody(), admin);
  const { gameId: other } = await cg.createCustomGame(gameBody({ home: { name: 'Patio Pumas', abbr: 'PP' }, away: { name: 'Deck Ducks', abbr: 'DD' } }), admin);
  const now = new Date();
  // mike: Bears -3.5 $10 (wins), Lions ML $5 (loses), Over 47.5? no: total 44.5 over $4 at 27-17 = 44 (loses), parlay ML + other game $3.
  await place('mike', [CL(gameId, 'spread', 'home', -3.5, -110, 1000), CL(gameId, 'moneyline', 'away', null, 130, 500), CL(gameId, 'total', 'over', 44.5, -110, 400)], { now });
  await place('mike', [CL(gameId, 'moneyline', 'home', null, -150), CL(other, 'moneyline', 'away', null, 130)], { mode: 'parlay', stakeCents: 300, now });
  // bot: Bears ML $5 (wins), a single on the other game $2 (voids when it is cancelled).
  await place('bot', [CL(gameId, 'moneyline', 'home', null, -150, 500), CL(other, 'moneyline', 'home', null, -150, 200)], { now });
  // A pre-existing record from before 0.21.0 (won/lost only).
  const pre = { ...store.get('users/mike') };
  write('users/mike', { ...pre, stats: { won: 0, lost: 0 } });

  await cg.finalizeCustomGame({ gameId, homeScore: 27, awayScore: 17, confirm: true }, admin);
  await cg.cancelCustomGame({ gameId: other, confirm: true }, admin);
  for (let i = 0; i < 3; i += 1) await settleOpenBets({ trigger: 'admin', force: true });

  for (const uid of ['mike', 'bot']) {
    const bets = settledBetsOf(uid);
    assert.ok(bets.every((b) => b.status !== 'open'), `${uid}: all settled`);
    assert.deepEqual(pick(store.get(`users/${uid}`).stats), pick(S.statsFromBets(bets)), `${uid}: running totals = a recount of the bets`);
  }
  const m = store.get('users/mike').stats;
  // -3.5 won 1000 → 1909; Lions ML lost; Over 44.5 at 44 lost; parlay: other game voided → ML -150 only: 300 × 1.6667 = 500.
  assert.deepEqual({ won: m.won, lost: m.lost, staked: m.stakedCents, returned: m.returnedCents, settled: m.settledBets }, { won: 2, lost: 2, staked: 2200, returned: 1909 + 500, settled: 4 });
  const b = store.get('users/bot').stats;
  assert.deepEqual({ won: b.won, lost: b.lost, staked: b.stakedCents, returned: b.returnedCents }, { won: 1, lost: 0, staked: 700, returned: 833 + 200 }, 'void: stake staked and returned');

  // An admin regrade: force mike's losing Lions ML to a win → the totals follow.
  const lions = Object.entries(Object.fromEntries(store)).find(([k, v]) => k.startsWith('bets/') && v.uid === 'mike' && v.legs[0].selection === 'away' && v.type === 'single');
  const [lionsPath, lionsBet] = lions;
  await rg.gradeBet({ betId: lionsPath.slice(5), outcome: 'win', confirm: true, expectedVersion: lionsBet.version }, admin);
  assert.deepEqual(pick(store.get('users/mike').stats), pick(S.statsFromBets(settledBetsOf('mike'))), 'after a regrade');

  // Battles never touch the totals: a Battle-like record in its own collection changes nothing on a rebuild.
  write('battles/b1', { participantUids: ['mike'], stakeCents: 5000, status: 'paid' });

  // rebuildStats: dry run lists what would change, confirm writes it, a second run finds nothing.
  write('users/mike', { ...store.get('users/mike'), stats: { won: 9, lost: 9 } });
  const dry = await rebuildStats({}, admin, { db: fakeDb });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.bets, settledBetsOf('mike').length + settledBetsOf('bot').length);
  assert.ok(dry.changes.some((c) => c.username === 'mike' && c.before.won === 9));
  assert.deepEqual(store.get('users/mike').stats, { won: 9, lost: 9 }, 'dry run wrote nothing');
  const done = await rebuildStats({ confirm: true }, admin, { db: fakeDb });
  assert.equal(done.skipped.length, 0);
  assert.deepEqual(pick(store.get('users/mike').stats), pick(S.statsFromBets(settledBetsOf('mike'))));
  assert.equal(store.get('users/mike').adminAdjustCents, 10000);
  assert.equal(store.get('users/bot').adminAdjustCents, 10000);
  const again = await rebuildStats({ confirm: true }, admin, { db: fakeDb });
  assert.equal(again.changes.length, 0, 'idempotent');
  assert.equal(again.written, 0);
});
