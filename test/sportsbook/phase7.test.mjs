// npm run test:sportsbook  (or: node --experimental-test-module-mocks test/sportsbook/phase7.test.mjs)
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;
const require = createRequire(`${root}/package.json`);
const { Timestamp } = require('firebase-admin/firestore');

// ---------- fake Firestore: optimistic transactions that really interleave and retry on conflict ----------
const store = new Map();
const versions = new Map();
let clock = 0;
let commits = 0;
const clone = (v) => {
  if (v === null || typeof v !== 'object') return v;
  if (typeof v.toMillis === 'function') return v; // keep Timestamps intact
  if (Array.isArray(v)) return v.map(clone);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
};
const tick = () => new Promise((r) => setImmediate(r));
function write(path, data) { store.set(path, clone(data)); versions.set(path, ++clock); }
function snap(path) { const d = store.get(path); return { exists: d !== undefined, id: path.split('/').pop(), data: () => clone(d) }; }
function ref(path) {
  return {
    path, id: path.split('/').pop(),
    async get() { await tick(); return snap(path); },
    async set(v, opts) { write(path, opts?.merge ? { ...(store.get(path) ?? {}), ...v } : v); },
    async update(v) { write(path, { ...store.get(path), ...v }); },
    collection: (name) => collectionOf(`${path}/${name}`), // subcollections (the casino chat prune walks them)
  };
}
const val = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v);
const OPS = { '==': (a, b) => val(a) === val(b), '<': (a, b) => a != null && val(a) < val(b), '>=': (a, b) => a != null && val(a) >= val(b) };
function makeQuery(name, filters = [], max = Infinity) {
  return {
    where: (field, op, value) => makeQuery(name, [...filters, [field, op, value]], max),
    orderBy: () => makeQuery(name, filters, max),
    limit: (n) => makeQuery(name, filters, n),
    async get() {
      await tick();
      const docs = [...store.keys()]
        .filter((p) => p.startsWith(`${name}/`) && p.split('/').length === name.split('/').length + 1)
        .filter((p) => filters.every(([f, op, v]) => OPS[op]?.(store.get(p)[f], v)))
        .slice(0, max)
        .map((p) => ({ ...snap(p), ref: ref(p) }));
      return { docs, size: docs.length, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn) };
    },
  };
}
function collectionOf(name) {
  return { doc: (id) => ref(`${name}/${id}`), where: (...a) => makeQuery(name).where(...a), limit: (n) => makeQuery(name).limit(n) };
}
class AlreadyExists extends Error { constructor() { super('ALREADY_EXISTS'); this.code = 6; } }
const fakeDb = {
  collection: (name) => collectionOf(name),
  batch() {
    const dels = [];
    return { delete: (r) => dels.push(r.path), async commit() { for (const p of dels) { store.delete(p); versions.set(p, ++clock); } } };
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
      };
      const result = await fn(tx);
      await tick();
      // Commit is atomic: if anything read has changed since, retry the whole transaction.
      if ([...reads].some(([p, v]) => (versions.get(p) ?? 0) !== v)) continue;
      for (const op of ops) if (op.kind === 'create' && store.has(op.path)) throw new AlreadyExists();
      for (const op of ops) write(op.path, op.kind === 'update' || op.kind === 'merge' ? { ...(store.get(op.path) ?? {}), ...op.data } : op.data);
      commits += 1;
      return result;
    }
    throw new Error('transaction contention');
  },
};
mock.module(url('server/firebaseAdmin.js'), { namedExports: { adminDb: () => fakeDb, adminAuth: () => ({}), normalizePrivateKey: (k) => k } });
let caller = { uid: 'u1', token: { admin: true }, user: { username: 'will' } };
mock.module(url('server/auth.js'), {
  namedExports: {
    requireUser: async () => caller,
    requireAdmin: async () => {
      if (caller.token.admin !== true) { const { HttpError } = await import(url('server/http.js')); throw new HttpError(403, 'NOT_ADMIN', 'Only the admin can do that.'); }
      return caller;
    },
  },
});

const g = await import(url('server/grading.js'));
const { loadGameResults } = await import(url('server/gameResults.js'));
const { settleOpenBets } = await import(url('server/settlement.js'));
const { normalizeEspnEvent } = await import(url('server/sources/espn.js'));
const { payoutCents, combinedDecimal, combinedAmerican } = await import(url('shared/betRules.js'));

// ---------- ESPN fixtures ----------
function espnEvent(id, date, { state = 'post', name = 'STATUS_FINAL', completed = state === 'post', detail = 'Final', home = ['CLE', 'Cleveland', 'Guardians', 5], away = ['TB', 'Tampa Bay', 'Rays', 2] } = {}) {
  const team = ([abbr, loc, nick]) => ({ id: abbr, abbreviation: abbr, displayName: `${loc} ${nick}`, shortDisplayName: nick, name: nick, location: loc });
  return {
    id, date,
    status: { type: { state, name, completed, shortDetail: detail } },
    competitions: [{ id, date, status: { type: { state, name, completed, shortDetail: detail } }, competitors: [
      { homeAway: 'home', score: String(home[3]), team: team(home) },
      { homeAway: 'away', score: String(away[3]), team: team(away) },
    ] }],
  };
}
const NHL_TEAMS = { home: ['COL', 'Colorado', 'Avalanche', 4], away: ['PIT', 'Pittsburgh', 'Penguins', 3] };
const NBA_TEAMS = { home: ['PHI', 'Philadelphia', '76ers', 51], away: ['BOS', 'Boston', 'Celtics', 48] };
const SCOREBOARDS = {
  'baseball/mlb|20261015': [espnEvent('g15', '2026-10-15T22:00:00Z', { home: ['CLE', 'Cleveland', 'Guardians', 1], away: ['TB', 'Tampa Bay', 'Rays', 7] })],
  'baseball/mlb|20261016': [
    espnEvent('g16', '2026-10-16T22:00:00Z', { detail: 'Final/10' }), // Rays 2 @ Guardians 5, extra innings
    espnEvent('pp', '2026-10-16T17:00:00Z', { state: 'post', name: 'STATUS_POSTPONED', completed: false, detail: 'Postponed', home: ['NYY', 'New York', 'Yankees', 0], away: ['BOS', 'Boston', 'Red Sox', 0] }),
  ],
  'baseball/mlb|20261017': [espnEvent('g17', '2026-10-17T17:10:00Z', { state: 'pre', name: 'STATUS_SCHEDULED', detail: '12:10 PM' })],
  'hockey/nhl|20261017': [espnEvent('n1', '2026-10-17T02:30:00Z', { detail: 'Final/OT', ...NHL_TEAMS })], // ESPN dates it Oct 17; Central date is Oct 16
  'basketball/nba|20261016': [espnEvent('nba1', '2026-10-16T23:30:00Z', { state: 'in', name: 'STATUS_HALFTIME', completed: false, detail: 'Halftime', ...NBA_TEAMS })],
  'basketball/nba|20261013': [espnEvent('nba2', '2026-10-14T00:00:00Z', { state: 'post', name: 'STATUS_SUSPENDED', completed: false, detail: 'Suspended', ...NBA_TEAMS })],
};
const SUMMARIES = { sf: espnEvent('sf', '2026-10-16T20:00:00Z', { home: ['MIA', 'Miami', 'Marlins', 3], away: ['ATL', 'Atlanta', 'Braves', 4] }) };
let espnCalls = [];
async function espnFetch(u) {
  const p = new URL(u);
  espnCalls.push(p.pathname + p.search);
  const path = p.pathname.replace('/apis/site/v2/sports/', '').replace(/\/(scoreboard|summary)$/, '');
  if (p.pathname.endsWith('/scoreboard')) {
    return { ok: true, status: 200, json: async () => ({ events: SCOREBOARDS[`${path}|${p.searchParams.get('dates')}`] ?? [] }) };
  }
  if (p.pathname.endsWith('/summary')) {
    const ev = SUMMARIES[p.searchParams.get('event')];
    if (!ev) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ header: { id: ev.id, competitions: ev.competitions } }) };
  }
  throw new Error(`unexpected ${u}`);
}

// ---------- bet fixtures ----------
const americanToDec = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
function leg(o) {
  const dec = Math.round(americanToDec(o.americanOdds ?? -110) * 10000) / 10000;
  return {
    legId: `${o.league ?? 'mlb'}:${o.gameId}:${o.marketType}:${o.selection}:${o.line ?? ''}`,
    league: 'mlb', gameLabel: 'Rays @ Guardians', startTime: '2026-10-16T22:00:00.000Z', line: null, americanOdds: -110,
    decimalOdds: dec, source: 'espn', sourceRef: null, result: 'pending', label: `${o.selection} ${o.line ?? ''}`, ...o, decimalOdds: dec,
  };
}
function bet(id, uid, legs, stakeCents) {
  const decs = legs.map((l) => l.decimalOdds);
  return [`bets/${id}`, {
    uid, username: uid === 'u1' ? 'will' : 'mike', type: legs.length > 1 ? 'parlay' : 'single', stakeCents, legs,
    combinedDecimal: combinedDecimal(decs), combinedAmerican: combinedAmerican(decs), potentialPayoutCents: payoutCents(stakeCents, combinedDecimal(decs)),
    status: 'open', payoutCents: 0, settledBy: null, settledAt: null, version: 0, placedAt: Timestamp.fromDate(new Date('2026-10-16T18:00:00Z')), requestId: id,
  }];
}
const ML_CLE = leg({ gameId: 'g16', marketType: 'moneyline', selection: 'home', americanOdds: -150, label: 'Guardians ML' });
const ML_TB = leg({ gameId: 'g16', marketType: 'moneyline', selection: 'away', americanOdds: 130, label: 'Rays ML' });
const NBA_LIVE = leg({ league: 'nba', gameId: 'nba1', gameLabel: 'Celtics @ 76ers', startTime: '2026-10-16T23:30:00.000Z', marketType: 'moneyline', selection: 'home', americanOdds: -200 });
const POSTPONED = leg({ gameId: 'pp', gameLabel: 'Red Sox @ Yankees', startTime: '2026-10-16T17:00:00.000Z', marketType: 'total', selection: 'over', line: 8.5 });
const PUSH_TB3 = leg({ gameId: 'g16', marketType: 'spread', selection: 'away', line: 3, americanOdds: -110, label: 'Rays +3' });
const NOW = new Date('2026-10-17T15:00:00Z');

function seed() {
  store.clear(); versions.clear();
  write('users/u1', { username: 'will', balanceCents: 10000, stats: { won: 0, lost: 0 } });
  write('users/u2', { username: 'mike', balanceCents: 5000, stats: { won: 2, lost: 1 } });
  write('customGames/cg1', { league: 'nfl', status: 'final', startTime: Timestamp.fromDate(new Date('2026-10-16T17:00:00Z')), home: { name: 'Backyard Bears' }, away: { name: 'Lawn Lions' }, finalScore: { home: 10, away: 7 } });
  const bets = [
    bet('b1', 'u1', [ML_CLE], 1000), // win → 1666
    bet('b2', 'u1', [leg({ gameId: 'g16', marketType: 'spread', selection: 'home', line: -2.5, americanOdds: 120, source: 'kalshi', label: 'Guardians -2.5' })], 500), // won by 3 → 1100
    bet('b3', 'u1', [leg({ gameId: 'g16', marketType: 'spread', selection: 'home', line: -3.5, americanOdds: 200, source: 'kalshi', label: 'Guardians -3.5' })], 500), // loss
    bet('b4', 'u1', [PUSH_TB3], 1000), // 2+3 = 5 → push, stake back
    bet('b5', 'u1', [leg({ gameId: 'g16', marketType: 'total', selection: 'over', line: 7.5, label: 'Over 7.5' })], 500), // 7 → loss
    bet('b6', 'u1', [leg({ gameId: 'g16', marketType: 'total', selection: 'under', line: 7, label: 'Under 7' })], 300), // 7 → push
    bet('b7', 'u1', [ML_CLE, NBA_LIVE], 1000), // NBA still at halftime → stays open
    bet('b8', 'u1', [ML_TB, NBA_LIVE], 1000), // Rays lost → parlay lost now
    bet('b9', 'u1', [ML_CLE, POSTPONED, PUSH_TB3], 1000), // void + push drop out → pays at Guardians ML only
    bet('b10', 'u2', [POSTPONED, PUSH_TB3], 2000), // all push/void → push, stake back
    bet('b11', 'u2', [leg({ gameId: 'g17', startTime: '2026-10-17T17:10:00.000Z', marketType: 'moneyline', selection: 'home' })], 500), // not started
    bet('b12', 'u2', [leg({ league: 'nfl', gameId: 'custom:cg1', gameLabel: 'Lawn Lions @ Backyard Bears', startTime: '2026-10-16T17:00:00.000Z', marketType: 'spread', selection: 'home', line: -2.5, source: 'custom' })], 1000), // 10-7 → win
    bet('b13', 'u2', [leg({ league: 'nhl', gameId: 'n1', gameLabel: 'Penguins @ Avalanche', startTime: '2026-10-17T02:30:00.000Z', marketType: 'moneyline', selection: 'home', americanOdds: -125, source: 'kalshi' })], 1000), // OT win
    bet('b14', 'u2', [leg({ gameId: 'sf', gameLabel: 'Braves @ Marlins', startTime: '2026-10-16T20:00:00.000Z', marketType: 'total', selection: 'over', line: 6.5 })], 1000), // summary fallback: 7 → win
    bet('b15', 'u2', [leg({ league: 'nba', gameId: 'nba2', gameLabel: 'Celtics @ 76ers', startTime: '2026-10-14T00:00:00.000Z', marketType: 'moneyline', selection: 'away' })], 500), // suspended > 72 h
    bet('b16', 'u2', [leg({ gameId: 'g99', gameLabel: 'Rays @ Guardians', startTime: '2026-10-16T22:00:00.000Z', marketType: 'moneyline', selection: 'home' })], 500), // id unknown to ESPN
  ];
  for (const [p, d] of bets) write(p, d);
}

// ---------- grading ----------
test('grading: moneyline / spread (incl. alternates) / total, win-push-loss, any price source', () => {
  const final = (home, away) => ({ status: 'final', homeScore: home, awayScore: away, homeName: 'Guardians', awayName: 'Rays', statusText: 'Final' });
  const r = (o, res) => g.gradeLeg({ marketType: 'spread', selection: 'home', line: null, ...o }, res).result;
  assert.equal(r({ marketType: 'moneyline' }, final(5, 2)), 'win');
  assert.equal(r({ marketType: 'moneyline', selection: 'away' }, final(5, 2)), 'loss');
  assert.equal(r({ marketType: 'moneyline' }, final(20, 20)), 'push', 'tie');
  for (const [line, expect] of [[-1.5, 'win'], [-2.5, 'win'], [-3, 'push'], [-3.5, 'loss'], [1.5, 'win']]) {
    assert.equal(r({ line }, final(5, 2)), expect, `Guardians ${line} with a 3-run win`);
  }
  for (const [line, expect] of [[-1.5, 'loss'], [1.5, 'loss'], [2.5, 'loss'], [3, 'push'], [3.5, 'win'], [10.5, 'win']]) {
    assert.equal(r({ selection: 'away', line }, final(5, 2)), expect, `Rays ${line}`);
  }
  for (const [line, over] of [[1.5, 'win'], [6.5, 'win'], [7, 'push'], [7.5, 'loss'], [10.5, 'loss']]) {
    assert.equal(r({ marketType: 'total', selection: 'over', line }, final(5, 2)), over, `over ${line}`);
    assert.equal(r({ marketType: 'total', selection: 'under', line }, final(5, 2)), over === 'push' ? 'push' : over === 'win' ? 'loss' : 'win', `under ${line}`);
  }
  for (const source of ['espn', 'kalshi', 'custom']) assert.equal(r({ line: -2.5, source }, final(5, 2)), 'win');
  assert.equal(g.gradeLeg({ marketType: 'moneyline', selection: 'home' }, { status: 'void', statusText: 'Postponed' }).result, 'void');
  assert.equal(g.gradeLeg({ marketType: 'moneyline', selection: 'home' }, { status: 'pending', reason: 'x' }).result, 'pending');
  assert.equal(g.gradeLeg({ marketType: 'spread', selection: 'home', line: null }, final(5, 2)).result, 'pending', 'no line → never guessed');
  assert.equal(g.gradeLeg({ marketType: 'moneyline', selection: 'home' }, final(5, 2)).scoreText, 'Rays 2 @ Guardians 5 · Final');
});

test('ESPN status: only completed games grade; live, halftime, delays, suspensions wait; postponed/canceled void', () => {
  const st = (o) => g.resultFromEspnGame(normalizeEspnEvent(espnEvent('x', '2026-10-16T22:00:00Z', o), 'mlb')).status;
  assert.equal(st({}), 'final');
  assert.equal(st({ detail: 'Final/10' }), 'final');
  assert.equal(st({ state: 'in', name: 'STATUS_IN_PROGRESS', completed: false, detail: 'Top 7th' }), 'pending');
  assert.equal(st({ state: 'in', name: 'STATUS_END_PERIOD', completed: false, detail: 'End of 2nd' }), 'pending', 'intermission');
  assert.equal(st({ state: 'in', name: 'STATUS_HALFTIME', completed: false }), 'pending');
  assert.equal(st({ state: 'in', name: 'STATUS_RAIN_DELAY', completed: false, detail: 'Rain Delay' }), 'pending');
  assert.equal(st({ state: 'in', name: 'STATUS_DELAYED', completed: false }), 'pending');
  assert.equal(st({ state: 'post', name: 'STATUS_SUSPENDED', completed: false, detail: 'Suspended' }), 'pending');
  assert.equal(st({ state: 'pre', name: 'STATUS_SCHEDULED', completed: false }), 'pending');
  assert.equal(st({ state: 'post', name: 'STATUS_POSTPONED', completed: false }), 'void');
  assert.equal(st({ state: 'post', name: 'STATUS_CANCELED', completed: false }), 'void');
  assert.equal(st({ state: 'post', name: 'STATUS_FINAL', completed: false }), 'final', 'STATUS_FINAL counts even if the flag is missing');
  assert.equal(st({ state: 'post', name: 'STATUS_FORFEIT', completed: false }), 'pending', 'forfeits go to review, not guessed');
});

test('bet outcomes: singles, parlay loss with legs still playing, push/void legs drop out, all push → stake back', () => {
  const L = (dec) => ({ decimalOdds: dec });
  const d = (legs, results, stake = 1000) => g.decideBet({ stakeCents: stake, legs }, results.map((result) => ({ result })));
  assert.deepEqual([d([L(1.6667)], ['win']).status, d([L(1.6667)], ['win']).payoutCents], ['won', 1666]);
  assert.deepEqual([d([L(2)], ['loss']).status, d([L(2)], ['loss']).payoutCents], ['lost', 0]);
  assert.deepEqual([d([L(2)], ['push']).status, d([L(2)], ['push']).payoutCents], ['push', 1000]);
  assert.deepEqual([d([L(2)], ['void']).status, d([L(2)], ['void']).payoutCents], ['void', 1000]);
  assert.equal(d([L(2)], ['pending']).status, 'open');
  assert.equal(d([L(2), L(2), L(2)], ['win', 'loss', 'pending']).status, 'lost', 'any loss loses at once');
  assert.equal(d([L(2), L(2)], ['win', 'pending']).status, 'open');
  const dropped = d([L(2), L(3), L(1.9091)], ['win', 'push', 'void']);
  assert.deepEqual([dropped.status, dropped.payoutCents, dropped.droppedLegs, dropped.settledAmerican], ['won', 2000, 2, 100]);
  assert.equal(d([L(2), L(3), L(1.5)], ['win', 'win', 'win'], 500).payoutCents, payoutCents(500, 9), 'full parlay = potential payout');
  assert.deepEqual([d([L(2), L(3)], ['push', 'void']).status, d([L(2), L(3)], ['push', 'void']).payoutCents], ['push', 1000]);
  assert.equal(d([L(2), L(3)], ['void', 'void']).status, 'void');
});

test('results by ESPN game id only: same teams on other days never used; ±1 day; summary fallback; custom doc', async () => {
  seed();
  espnCalls = [];
  const legs = [
    { league: 'mlb', gameId: 'g16', startTime: '2026-10-16T22:00:00.000Z' },
    { league: 'mlb', gameId: 'g99', startTime: '2026-10-16T22:00:00.000Z' }, // Rays @ Guardians label, unknown id
    { league: 'mlb', gameId: 'g17', startTime: '2026-10-17T17:10:00.000Z' },
    { league: 'nhl', gameId: 'n1', startTime: '2026-10-17T02:30:00.000Z' },
    { league: 'mlb', gameId: 'sf', startTime: '2026-10-16T20:00:00.000Z' },
    { league: 'nfl', gameId: 'custom:cg1', startTime: '2026-10-16T17:00:00.000Z' },
  ];
  const res = await loadGameResults(legs, { now: NOW, fetchImpl: espnFetch, db: fakeDb });
  assert.deepEqual([res.get('mlb|g16').homeScore, res.get('mlb|g16').awayScore], [5, 2], 'Oct 16 game, not the Oct 15 game between the same teams (7-1)');
  assert.equal(res.get('mlb|g99').status, 'pending');
  assert.match(res.get('mlb|g99').reason, /not found/);
  assert.equal(res.get('mlb|g17').status, 'pending', 'not started');
  assert.equal(res.get('nhl|n1').status, 'final', 'found on the next day');
  assert.equal(res.get('mlb|sf').status, 'final', 'summary fallback');
  assert.deepEqual([res.get('nfl|custom:cg1').status, res.get('nfl|custom:cg1').homeScore], ['final', 10]);
  const boards = espnCalls.filter((c) => c.includes('/scoreboard'));
  assert.equal(new Set(boards).size, boards.length, 'each scoreboard fetched once per run');
  assert.ok(!espnCalls.some((c) => c.includes('20261018')), 'tomorrow\'s game not fetched before it starts');
});

// ---------- settlement end to end ----------
const EXPECTED = {
  b1: ['won', 1666], b2: ['won', 1100], b3: ['lost', 0], b4: ['push', 1000], b5: ['lost', 0], b6: ['push', 300],
  b7: ['open', 0], b8: ['lost', 0], b9: ['won', 1666], b10: ['push', 2000], b11: ['open', 0], b12: ['won', 1909],
  b13: ['won', 1800], b14: ['won', 1909], b15: ['open', 0], b16: ['open', 0],
};
const paidTo = (uid) => Object.entries(EXPECTED).filter(([id]) => store.get(`bets/${id}`)?.uid === uid).reduce((s, [, [, p]]) => s + p, 0);

test('admin preview shows what would happen and changes nothing', async () => {
  seed();
  const before = JSON.stringify([...store]);
  const p = await settleOpenBets({ trigger: 'admin', dryRun: true, now: NOW, fetchImpl: espnFetch });
  assert.equal(JSON.stringify([...store]), before, 'no writes at all');
  assert.equal(p.checked, 16);
  for (const row of [...p.wouldSettle, ...p.staysOpen]) assert.deepEqual([row.status, row.payoutCents], EXPECTED[row.id], row.id);
  const b9 = p.wouldSettle.find((r) => r.id === 'b9');
  assert.deepEqual(b9.legs.map((l) => l.result), ['win', 'void', 'push']);
  assert.equal(b9.legs[0].scoreText, 'Rays 2 @ Guardians 5 · Final/10');
  assert.equal(b9.droppedLegs, 2);
  assert.match(p.staysOpen.find((r) => r.id === 'b15').review, /72 h.*Suspended/);
  assert.match(p.staysOpen.find((r) => r.id === 'b7').legs[1].reason, /Halftime/);
  assert.equal(p.totals.payoutCents, Object.values(EXPECTED).reduce((s, [, x]) => s + x, 0));
});

test('settlement pays, records leg results + scores, stats, ledger; flags 72 h review', async () => {
  seed();
  const r = await settleOpenBets({ trigger: 'admin', force: true, now: NOW, fetchImpl: espnFetch });
  assert.equal(r.settled, 12);
  assert.equal(r.stillOpen, 4);
  assert.equal(r.needsReview, 1);
  assert.equal(r.errors, 0);
  for (const [id, [status, paid]] of Object.entries(EXPECTED)) {
    const b = store.get(`bets/${id}`);
    assert.deepEqual([b.status, b.payoutCents], [status, paid], id);
    if (status !== 'open') assert.equal(b.settledBy, 'auto');
  }
  assert.equal(store.get('users/u1').balanceCents, 10000 + paidTo('u1'));
  assert.equal(store.get('users/u2').balanceCents, 5000 + paidTo('u2'));
  assert.deepEqual(store.get('users/u1').stats, { won: 3, lost: 3 }, 'b1,b2,b9 won; b3,b5,b8 lost; pushes not counted');
  assert.deepEqual(store.get('users/u2').stats, { won: 5, lost: 1 }, 'b12,b13,b14 on top of 2-1');
  const b8 = store.get('bets/b8');
  assert.deepEqual(b8.legs.map((l) => l.result), ['loss', 'pending'], 'lost parlay; NBA leg never guessed');
  assert.equal(store.get('bets/b1').legs[0].scoreText, 'Rays 2 @ Guardians 5 · Final/10');
  assert.equal(store.get('bets/b13').legs[0].scoreText, 'Penguins 3 @ Avalanche 4 · Final/OT');
  assert.equal(store.get('ledger/payout_b1').amountCents, 1666);
  assert.equal(store.get('ledger/payout_b4').amountCents, 1000, 'push returns the stake');
  assert.equal(store.has('ledger/payout_b3'), false, 'losses move no money');
  assert.equal(store.get('bets/b15').needsReview, true);
  assert.match(store.get('bets/b15').reviewReason, /Suspended/);
  assert.equal(store.get('bets/b16').needsReview, undefined, 'unknown id but under 72 h → not flagged yet');
});

test('PAY EXACTLY ONCE: many runs at once and again later never pay twice', async () => {
  seed();
  const runs = await Promise.all(Array.from({ length: 6 }, () => settleOpenBets({ trigger: 'admin', force: true, now: NOW, fetchImpl: espnFetch })));
  assert.equal(runs.reduce((s, r) => s + r.settled, 0), 12, 'each decided bet settled by exactly one run');
  assert.ok(runs.reduce((s, r) => s + r.alreadySettled, 0) > 0, 'the other runs found them already settled');
  const u1 = store.get('users/u1').balanceCents;
  const u2 = store.get('users/u2').balanceCents;
  assert.equal(u1, 10000 + paidTo('u1'));
  assert.equal(u2, 5000 + paidTo('u2'));
  assert.deepEqual(store.get('users/u1').stats, { won: 3, lost: 3 }, 'stats counted once');

  for (let i = 0; i < 3; i += 1) await settleOpenBets({ trigger: 'cron', force: true, now: NOW, fetchImpl: espnFetch });
  assert.equal(store.get('users/u1').balanceCents, u1);
  assert.equal(store.get('users/u2').balanceCents, u2);
  const payouts = [...store.keys()].filter((k) => k.startsWith('ledger/payout_'));
  assert.equal(payouts.length, 9, 'one payout entry per paid bet (losses have none)');

  // Belt and braces: even if a bet were reopened by mistake, the existing payout entry blocks a second payment.
  write('bets/b1', { ...store.get('bets/b1'), status: 'open' });
  await settleOpenBets({ trigger: 'admin', force: true, now: NOW, fetchImpl: espnFetch });
  assert.equal(store.get('users/u1').balanceCents, u1, 'payout_b1 already exists → nothing paid');
});

test('player trigger throttle: once per 60 s across all players; admin force and cron always run', async () => {
  seed();
  const first = await settleOpenBets({ trigger: 'player', now: NOW, fetchImpl: espnFetch });
  assert.equal(first.ran, true);
  const at = [5, 30, 59].map((s) => new Date(NOW.getTime() + s * 1000));
  for (const t of at) assert.equal((await settleOpenBets({ trigger: 'player', now: t, fetchImpl: espnFetch })).ran, false);
  const burst = await Promise.all(Array.from({ length: 5 }, () => settleOpenBets({ trigger: 'player', now: new Date(NOW.getTime() + 61000), fetchImpl: espnFetch })));
  assert.equal(burst.filter((r) => r.ran).length, 1, 'simultaneous players: only one runs');
  assert.equal((await settleOpenBets({ trigger: 'admin', force: true, now: new Date(NOW.getTime() + 62000), fetchImpl: espnFetch })).ran, true);
});

// ---------- /api/settle ----------
const res = () => ({ statusCode: 200, headers: {}, body: null, headersSent: false, setHeader(a, b) { this.headers[a] = b; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } });

test('/api/settle: cron needs CRON_SECRET; preview and force need admin; players get the throttled run', async () => {
  seed();
  const realFetch = globalThis.fetch;
  globalThis.fetch = espnFetch;
  const handler = (await import(url('api/settle.js'))).default;
  process.env.CRON_SECRET = 'cron-secret-123';

  let r = res();
  await handler({ method: 'GET', headers: {} }, r);
  assert.equal(r.statusCode, 401);
  r = res();
  await handler({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, r);
  assert.equal(r.statusCode, 401);
  r = res();
  await handler({ method: 'GET', headers: { authorization: 'Bearer cron-secret-123' } }, r);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.ran, true);

  caller = { uid: 'u2', token: {}, user: { username: 'mike' } };
  for (const body of [{ preview: true }, { force: true }]) {
    r = res();
    await handler({ method: 'POST', headers: {}, body }, r);
    assert.equal(r.statusCode, 403, `player can't ${Object.keys(body)[0]}`);
  }
  r = res();
  await handler({ method: 'POST', headers: {}, body: {} }, r);
  assert.equal(r.statusCode, 200);

  caller = { uid: 'u1', token: { admin: true }, user: { username: 'will' } };
  r = res();
  await handler({ method: 'POST', headers: {}, body: { preview: true } }, r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.preview, true);

  delete process.env.CRON_SECRET;
  r = res();
  await handler({ method: 'GET', headers: { authorization: 'Bearer ' } }, r);
  assert.equal(r.statusCode, 500);
  assert.equal(r.body.error.code, 'CRON_NOT_CONFIGURED');
  globalThis.fetch = realFetch;
});
