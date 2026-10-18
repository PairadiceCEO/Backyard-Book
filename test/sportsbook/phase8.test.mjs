// npm run test:sportsbook  (or: node --experimental-test-module-mocks test/sportsbook/phase8.test.mjs)
import { test, mock } from 'node:test';
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
function snap(path) { const d = store.get(path); return { exists: d !== undefined, id: path.split('/').pop(), data: () => clone(d) }; }
function ref(path) {
  return {
    path, id: path.split('/').pop(),
    async get() { await tick(); return snap(path); },
    async set(v, opts) { write(path, opts?.merge ? { ...(store.get(path) ?? {}), ...v } : v); },
    async update(v) { if (!store.has(path)) throw new Error(`NOT_FOUND ${path}`); write(path, { ...store.get(path), ...v }); },
    async delete() { write(path, undefined); },
  };
}
function makeQuery(name, filters = [], max = Infinity) {
  return {
    where: (field, op, value) => makeQuery(name, [...filters, [field, op, value]], max),
    limit: (n) => makeQuery(name, filters, n),
    async get() {
      await tick();
      const docs = [...store.keys()]
        .filter((p) => p.startsWith(`${name}/`) && p.split('/').length === 2)
        .filter((p) => filters.every(([f, op, v]) => op === '==' && store.get(p)[f] === v))
        .slice(0, max)
        .map(snap);
      return { docs, size: docs.length, forEach: (fn) => docs.forEach(fn) };
    },
  };
}
class AlreadyExists extends Error { constructor() { super('ALREADY_EXISTS'); this.code = 6; } }
const fakeDb = {
  collection: (name) => ({
    doc: (id) => ref(`${name}/${id ?? `auto${++autoId}`}`),
    where: (...a) => makeQuery(name).where(...a),
    limit: (n) => makeQuery(name).limit(n),
  }),
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
const admin = { uid: 'admin1', token: { admin: true }, user: { username: 'will' } };
mock.module(url('server/auth.js'), { namedExports: { requireUser: async () => admin, requireAdmin: async () => admin } });

const cg = await import(url('server/admin/customGames.js'));
const rg = await import(url('server/admin/bets.js'));
const { placeBets } = await import(url('server/placeBet.js'));
const { priceLeg } = await import(url('server/pricing.js'));
const { normalizeCustomGame } = await import(url('server/board.js'));
const { settleOpenBets } = await import(url('server/settlement.js'));
const { centralWallParts } = await import(url('shared/time.js'));

// ---------- helpers ----------
const ct = (offsetMs) => {
  const p = centralWallParts(new Date(Date.now() + offsetMs));
  return { startDate: p.date, startClock: p.clock };
};
const HOUR = 3600 * 1000;
const gameBody = (o = {}) => ({
  league: 'nfl',
  home: { name: 'Backyard Bears', abbr: 'bb', logoUrl: '' },
  away: { name: 'Lawn Lions', abbr: 'LL', logoUrl: '' },
  ...ct(2 * HOUR),
  odds: {
    moneyline: { home: '-150', away: '+130' },
    spread: { homeLine: '-3.5', home: '-110', away: '-110' },
    total: { line: '44.5', over: '-110', under: '-110' },
  },
  ...o,
});
const ctx = () => ({
  now: new Date(),
  board: async () => ({ games: [] }),
  freshEspnGames: async () => [],
  freshKalshiForGames: async () => new Map(),
  market: async () => null,
  customGame: async (id) => (store.has(`customGames/${id}`) ? clone(store.get(`customGames/${id}`)) : null),
});
let reqN = 0;
const place = (uid, username, legs, mode = 'singles', stakeCents) =>
  placeBets({ uid, token: {}, user: { username } }, { mode, clientRequestId: `req-${String(++reqN).padStart(6, '0')}`, stakeCents, legs }, { ctx: ctx() });
const L = (gameId, marketType, selection, line, quotedAmerican, stakeCents) => ({ league: 'nfl', gameId, marketType, selection, line, quotedAmerican, stakeCents });
const bal = (uid) => store.get(`users/${uid}`).balanceCents;
const stats = (uid) => store.get(`users/${uid}`).stats;
const dump = () => JSON.stringify([...store].filter(([k]) => !k.startsWith('cache/')));
function recount(uid) {
  const bets = [...store].filter(([k, v]) => k.startsWith('bets/') && v.uid === uid).map(([, v]) => v);
  return { won: bets.filter((b) => b.status === 'won').length, lost: bets.filter((b) => b.status === 'lost').length };
}
function ledgerSum(uid) {
  return [...store].filter(([k, v]) => k.startsWith('ledger/') && v.uid === uid).reduce((s, [, v]) => s + v.amountCents, 0);
}
function seed() {
  store.clear(); versions.clear();
  for (const [uid, username] of [['u1', 'mike'], ['u2', 'dan']]) {
    write(`users/${uid}`, { username, balanceCents: 10000, stats: { won: 0, lost: 0 } });
    write(`ledger/start_${uid}`, { uid, type: 'admin_adjust', amountCents: 10000 });
  }
}

// ---------- validation ----------
test('custom game input: blanks mean "not offered"; bad odds, lines and times are refused', () => {
  const blank = cg.cleanOdds({ moneyline: { home: '', away: '' }, spread: { homeLine: '', home: '', away: '' }, total: { line: '', over: '', under: '' } });
  assert.deepEqual(blank, { moneyline: { home: null, away: null }, spread: { homeLine: null, home: null, away: null }, total: { line: null, over: null, under: null } });
  assert.throws(() => cg.cleanOdds({ moneyline: { home: '-50' } }), /American odds/);
  assert.throws(() => cg.cleanOdds({ moneyline: { home: '1.9' } }), /American odds/);
  assert.throws(() => cg.cleanOdds({ spread: { homeLine: '-3.25', home: '-110' } }), /half number/);
  assert.throws(() => cg.cleanOdds({ spread: { home: '-110' } }), /home line/);
  assert.throws(() => cg.cleanOdds({ total: { line: '44.5' } }), /at least one price/);
  assert.throws(() => cg.cleanOdds({ total: { line: '-3', over: '-110' } }), /above 0/);
  assert.equal(cg.cleanOdds({ moneyline: { home: '+150' } }).moneyline.home, 150);

  // Board: blank markets show as unavailable ("—"); a blank line is never read as 0.
  const g = normalizeCustomGame('x', { league: 'nfl', status: 'scheduled', startTime: Timestamp.fromMillis(Date.now() + HOUR), home: { name: 'A', abbr: 'A' }, away: { name: 'B', abbr: 'B' }, odds: { ...blank, moneyline: { home: -120, away: null } } }, new Date());
  assert.equal(g.markets.moneyline.home.american, -120);
  assert.equal(g.markets.moneyline.away, null);
  assert.deepEqual(g.markets.spread, { home: null, away: null });
  assert.deepEqual(g.markets.total, { over: null, under: null });
});

// ---------- custom game end to end ----------
test('custom game: create → bets → edit start/odds → preview final → settle → payouts once', async () => {
  seed();
  await assert.rejects(cg.createCustomGame(gameBody({ startDate: '2026-02-30' }), admin), /valid start/);
  await assert.rejects(cg.createCustomGame(gameBody({ home: { name: 'X', abbr: 'TOOLONG' } }), admin), /abbreviation/);
  await assert.rejects(cg.createCustomGame(gameBody({ home: { name: 'X', abbr: 'X', logoUrl: 'http://x.com/a.png' } }), admin), /https/);

  const { gameId } = await cg.createCustomGame(gameBody(), admin);
  const { gameId: otherId } = await cg.createCustomGame(gameBody({ home: { name: 'Patio Pumas', abbr: 'PP' }, away: { name: 'Deck Ducks', abbr: 'DD' } }), admin);
  const doc = store.get(`customGames/${gameId.slice(7)}`);
  assert.equal(doc.home.abbr, 'BB', 'abbreviations upper-cased');
  assert.equal(doc.status, 'scheduled');
  assert.ok(Math.abs(doc.startTime.toMillis() - (Date.now() + 2 * HOUR)) < 60 * 1000, 'Central Time entry stored as the right instant');

  // Bets. u1: Bears -3.5 $10 (-110); parlay Bears ML + Over 44.5 $5. u2: Lions ML $20 (+130); parlay Bears ML + other game ML $10.
  await place('u1', 'mike', [L(gameId, 'spread', 'home', -3.5, -110, 1000)]);
  await place('u1', 'mike', [L(gameId, 'moneyline', 'home', null, -150), L(gameId, 'total', 'over', 44.5, -110)], 'parlay', 500);
  await place('u2', 'dan', [L(gameId, 'moneyline', 'away', null, 130, 2000)]);
  await place('u2', 'dan', [L(gameId, 'moneyline', 'home', null, -150), L(otherId, 'moneyline', 'away', null, 130)], 'parlay', 1000);
  assert.equal(store.get(`customGames/${gameId.slice(7)}`).betCount, 4);
  assert.equal(store.get(`customGames/${otherId.slice(7)}`).betCount, 1);
  assert.equal(bal('u1'), 10000 - 1500);
  assert.equal(bal('u2'), 10000 - 3000);

  // Delete refused while bets exist.
  await assert.rejects(cg.deleteCustomGame({ gameId }), (e) => e.code === 'HAS_BETS');

  // Edit odds: placed bets keep theirs.
  const edited = gameBody({ odds: { moneyline: { home: '-300', away: '+250' }, spread: { homeLine: '-7.5', home: '-110', away: '-110' }, total: { line: '', over: '', under: '' } } });
  await cg.updateCustomGame({ gameId, ...edited });
  const u1single = [...store].find(([k, v]) => k.startsWith('bets/') && v.uid === 'u1' && v.type === 'single')[1];
  assert.equal(u1single.legs[0].line, -3.5);
  assert.equal(u1single.legs[0].americanOdds, -110);
  assert.equal(normalizeCustomGame('x', store.get(`customGames/${gameId.slice(7)}`), new Date()).markets.total.over, null, 'cleared total no longer offered');

  // Start time earlier than now closes betting at once; later reopens it.
  const r1 = await cg.updateCustomGame({ gameId, ...edited, ...ct(-5 * 60 * 1000) });
  assert.equal(r1.bettingOpen, false);
  const closed = await priceLeg({ league: 'nfl', gameId, marketType: 'moneyline', selection: 'home', line: null }, ctx());
  assert.equal(closed.status, 'closed');
  await assert.rejects(place('u1', 'mike', [L(gameId, 'moneyline', 'home', null, -300, 100)]), (e) => e.code === 'MARKET_CLOSED');
  const r2 = await cg.updateCustomGame({ gameId, ...edited, ...ct(HOUR) });
  assert.equal(r2.bettingOpen, true);
  assert.equal((await priceLeg({ league: 'nfl', gameId, marketType: 'moneyline', selection: 'home', line: null }, ctx())).status, 'ok');
  await assert.rejects(cg.updateCustomGame({ gameId, ...edited, league: 'mlb' }), (e) => e.code === 'HAS_BETS', 'league locked once bet on');

  // Preview the final score: shows wallet changes, writes nothing.
  const before = dump();
  const preview = await cg.finalizeCustomGame({ gameId, homeScore: 27, awayScore: 20 }, admin);
  assert.equal(dump(), before, 'preview changed nothing');
  assert.equal(preview.preview, true);
  assert.equal(preview.wouldSettle.length, 3, 'u2 parlay waits on the other game');
  assert.equal(preview.staysOpen.length, 1);
  const w = Object.fromEntries(preview.walletChanges.map((c) => [c.username, c]));
  // Bears win by 7: -3.5 wins (1000 × 1.9091 = 1909); parlay ML + over: 27+20 = 47 > 44.5 → 500 × 1.6667 × 1.9091 = 1590; Lions ML loses.
  assert.equal(w.mike.deltaCents, 1909 + 1590);
  assert.equal(w.mike.balanceAfterCents, 8500 + 3499);
  assert.equal(w.dan.deltaCents, 0, 'Lions ML lost → no money moves for dan');

  // Confirm: settles right away.
  const done = await cg.finalizeCustomGame({ gameId, homeScore: 27, awayScore: 20, confirm: true }, admin);
  assert.equal(done.settlement.settled, 3);
  assert.equal(bal('u1'), 8500 + 3499);
  assert.equal(bal('u2'), 7000);
  assert.deepEqual(stats('u1'), { won: 2, lost: 0 });
  assert.deepEqual(stats('u2'), { won: 0, lost: 1 });
  await assert.rejects(cg.finalizeCustomGame({ gameId, homeScore: 1, awayScore: 0, confirm: true }, admin), (e) => e.code === 'GAME_FINISHED');
  await assert.rejects(cg.updateCustomGame({ gameId, ...edited }), (e) => e.code === 'GAME_FINISHED');

  // Settling again (players, cron, admin) never pays twice.
  for (let i = 0; i < 4; i += 1) await settleOpenBets({ trigger: 'admin', force: true });
  await Promise.all([1, 2, 3].map(() => settleOpenBets({ trigger: 'admin', force: true })));
  assert.equal(bal('u1'), 8500 + 3499);
  assert.equal(ledgerSum('u1'), bal('u1'), 'ledger adds up to the wallet');

  // dan's parlay (Bears ML won + other game) is still open. Cancel the other game: its leg voids and the
  // parlay pays at the remaining leg (Bears ML -150): 1000 × 1.6667 = 1666.
  const parlayBefore = [...store].find(([k, v]) => k.startsWith('bets/') && v.uid === 'u2' && v.type === 'parlay')[1];
  assert.equal(parlayBefore.status, 'open');
  const cancelPreview = await cg.cancelCustomGame({ gameId: otherId }, admin);
  assert.deepEqual(cancelPreview.walletChanges.map((c) => [c.username, c.deltaCents]), [['dan', 1666]]);
  await cg.cancelCustomGame({ gameId: otherId, confirm: true }, admin);
  assert.equal(bal('u2'), 7000 + 1666);
  const parlay = [...store].find(([k, v]) => k.startsWith('bets/') && v.uid === 'u2' && v.type === 'parlay')[1];
  assert.deepEqual([parlay.status, parlay.legs.map((l) => l.result), parlay.droppedLegs], ['won', ['win', 'void'], 1]);
  assert.deepEqual(stats('u2'), { won: 1, lost: 1 });
  assert.equal(ledgerSum('u2'), bal('u2'));
});

test('cancel: voids legs like a postponed game — singles refunded, parlays drop the leg', async () => {
  seed();
  const { gameId: a } = await cg.createCustomGame(gameBody(), admin);
  const { gameId: b } = await cg.createCustomGame(gameBody({ home: { name: 'Patio Pumas', abbr: 'PP' }, away: { name: 'Deck Ducks', abbr: 'DD' } }), admin);
  await place('u1', 'mike', [L(b, 'moneyline', 'home', null, -150, 1000)]); // single on b
  await place('u2', 'dan', [L(a, 'moneyline', 'away', null, 130), L(b, 'moneyline', 'away', null, 130)], 'parlay', 1000);
  await cg.finalizeCustomGame({ gameId: a, homeScore: 10, awayScore: 14, confirm: true }, admin); // Lions win
  const preview = await cg.cancelCustomGame({ gameId: b }, admin);
  const w = Object.fromEntries(preview.walletChanges.map((c) => [c.username, c.deltaCents]));
  assert.equal(w.mike, 1000, 'single stake back');
  assert.equal(w.dan, 2300, 'parlay pays at the Lions +130 leg only');
  await cg.cancelCustomGame({ gameId: b, confirm: true }, admin);
  assert.equal(bal('u1'), 10000);
  assert.equal(bal('u2'), 10000 - 1000 + 2300);
  assert.deepEqual(stats('u1'), { won: 0, lost: 0 }, 'void never counts');
  assert.deepEqual(stats('u2'), { won: 1, lost: 0 });
  const single = [...store].find(([k, v]) => k.startsWith('bets/') && v.uid === 'u1')[1];
  assert.deepEqual([single.status, single.legs[0].result, single.legs[0].scoreText], ['void', 'void', 'Canceled']);

  // Delete: only a game nobody bet on.
  const { gameId: c } = await cg.createCustomGame(gameBody(), admin);
  await cg.deleteCustomGame({ gameId: c });
  assert.equal(store.has(`customGames/${c.slice(7)}`), false);
  await assert.rejects(cg.deleteCustomGame({ gameId: b }), (e) => e.code === 'HAS_BETS');
});

// ---------- regrades ----------
async function setupSettled() {
  seed();
  const { gameId: a } = await cg.createCustomGame(gameBody(), admin);
  const { gameId: b } = await cg.createCustomGame(gameBody({ home: { name: 'Patio Pumas', abbr: 'PP' }, away: { name: 'Deck Ducks', abbr: 'DD' } }), admin);
  await place('u1', 'mike', [L(a, 'moneyline', 'away', null, 130, 1000)]); // will lose
  await place('u1', 'mike', [L(a, 'spread', 'home', -3.5, -110, 1000)]); // will win 1909
  await place('u1', 'mike', [L(a, 'moneyline', 'home', null, -150), L(a, 'total', 'over', 44.5, -110)], 'parlay', 500); // over loses → lost
  await place('u1', 'mike', [L(a, 'moneyline', 'away', null, 130), L(b, 'moneyline', 'home', null, -150)], 'parlay', 500); // lost, b pending
  await place('u1', 'mike', [L(b, 'moneyline', 'away', null, 130, 700)]); // open
  await cg.finalizeCustomGame({ gameId: a, homeScore: 24, awayScore: 10, confirm: true }, admin); // Bears by 14, total 34
  const bets = Object.fromEntries([...store].filter(([k]) => k.startsWith('bets/')).map(([k, v]) => [k.slice(5), v]));
  const find = (fn) => Object.entries(bets).find(([, v]) => fn(v))[0];
  return {
    a, b,
    lostSingle: find((v) => v.type === 'single' && v.legs[0].marketType === 'moneyline' && v.legs[0].gameId === a),
    wonSingle: find((v) => v.type === 'single' && v.legs[0].marketType === 'spread'),
    lostParlay: find((v) => v.type === 'parlay' && v.legs[1].marketType === 'total'),
    reopenParlay: find((v) => v.type === 'parlay' && v.legs[1].gameId === b),
    openSingle: find((v) => v.type === 'single' && v.legs[0].gameId === b),
  };
}

test('force-grade: open and settled bets; only the difference moves; ledger + record follow', async () => {
  const ids = await setupSettled();
  const start = bal('u1');
  assert.deepEqual(stats('u1'), { won: 1, lost: 3 });

  // Preview changes nothing and shows the wallet change.
  const before = dump();
  const p = await rg.gradeBet({ betId: ids.lostSingle, outcome: 'win' }, admin);
  assert.equal(dump(), before);
  assert.deepEqual([p.from.status, p.to.status, p.deltaCents, p.balanceAfterCents], ['lost', 'won', 2300, start + 2300]);
  assert.deepEqual([p.statsBefore, p.statsAfter], [{ won: 1, lost: 3 }, { won: 2, lost: 2 }]);

  // Confirm requires the previewed version; applying it twice fails the second time.
  await assert.rejects(rg.gradeBet({ betId: ids.lostSingle, outcome: 'win', confirm: true }, admin), /expectedVersion/);
  const applied = await rg.gradeBet({ betId: ids.lostSingle, outcome: 'win', confirm: true, expectedVersion: p.version }, admin);
  assert.equal(applied.deltaCents, 2300);
  await assert.rejects(rg.gradeBet({ betId: ids.lostSingle, outcome: 'win', confirm: true, expectedVersion: p.version }, admin), (e) => e.code === 'BET_CHANGED');
  assert.equal(bal('u1'), start + 2300);
  const entry = store.get(`ledger/regrade_${ids.lostSingle}_v${p.version + 1}`);
  assert.deepEqual([entry.type, entry.amountCents], ['admin_regrade', 2300]);
  assert.equal(store.get(`bets/${ids.lostSingle}`).settledBy, 'admin');

  // Won single → void: takes back winnings above the stake (1909 → 1000).
  const v = await rg.gradeBet({ betId: ids.wonSingle, outcome: 'void' }, admin);
  assert.equal(v.deltaCents, 1000 - 1909);
  await rg.gradeBet({ betId: ids.wonSingle, outcome: 'void', confirm: true, expectedVersion: v.version }, admin);
  assert.deepEqual(stats('u1'), { won: 1, lost: 2 }, 'void leaves won and lost');

  // Open single → lose: no money, counts as a loss; settlement leaves it alone afterwards.
  const l = await rg.gradeBet({ betId: ids.openSingle, outcome: 'lose' }, admin);
  assert.equal(l.deltaCents, 0);
  await rg.gradeBet({ betId: ids.openSingle, outcome: 'lose', confirm: true, expectedVersion: l.version }, admin);
  assert.deepEqual(stats('u1'), { won: 1, lost: 3 });

  // Nothing-to-change is refused.
  const same = await rg.gradeBet({ betId: ids.openSingle, outcome: 'lose' }, admin);
  assert.equal(same.noChange, true);
  await assert.rejects(rg.gradeBet({ betId: ids.openSingle, outcome: 'lose', confirm: true, expectedVersion: same.version }, admin), (e) => e.code === 'NO_CHANGE');

  assert.deepEqual(stats('u1'), recount('u1'), 'record always matches the bets');
  assert.equal(ledgerSum('u1'), bal('u1'), 'ledger adds up to the wallet');
});

test('leg override: recompute the parlay from all legs; reopening works and settles once later', async () => {
  const ids = await setupSettled();
  const start = bal('u1');

  // Lost parlay (Bears ML won, Over 44.5 lost at 34). Override the over to push → pays at Bears ML only.
  const p = await rg.setLegResult({ betId: ids.lostParlay, legIndex: 1, result: 'push' }, admin);
  assert.deepEqual([p.from.status, p.to.status, p.to.payoutCents, p.deltaCents], ['lost', 'won', 833, 833]);
  await rg.setLegResult({ betId: ids.lostParlay, legIndex: 1, result: 'push', confirm: true, expectedVersion: p.version }, admin);
  const bet = store.get(`bets/${ids.lostParlay}`);
  assert.deepEqual(bet.legs.map((l) => l.result), ['win', 'push']);
  assert.equal(bet.legs[1].overriddenBy, 'admin');
  assert.equal(bal('u1'), start + 833);

  // Parlay lost on its Lions leg with the other game still to play. Fix that leg → the bet reopens.
  const r = await rg.setLegResult({ betId: ids.reopenParlay, legIndex: 0, result: 'win' }, admin);
  assert.deepEqual([r.from.status, r.to.status, r.deltaCents], ['lost', 'open', 0]);
  await rg.setLegResult({ betId: ids.reopenParlay, legIndex: 0, result: 'win', confirm: true, expectedVersion: r.version }, admin);
  assert.equal(store.get(`bets/${ids.reopenParlay}`).status, 'open');
  assert.deepEqual(stats('u1'), recount('u1'));

  // Game b ends (Pumas win) → the reopened parlay settles normally, exactly once.
  await cg.finalizeCustomGame({ gameId: ids.b, homeScore: 3, awayScore: 1, confirm: true }, admin);
  const reopened = store.get(`bets/${ids.reopenParlay}`);
  // 500 × 2.3 × 1.6667 = 1916
  assert.deepEqual([reopened.status, reopened.payoutCents], ['won', 1916]);
  const paidAfter = bal('u1');
  await Promise.all([1, 2, 3, 4].map(() => settleOpenBets({ trigger: 'admin', force: true })));
  assert.equal(bal('u1'), paidAfter, 'no double payment after a reopen');
  assert.ok(store.has(`ledger/payout_${ids.reopenParlay}_v${reopened.version}`), 'versioned payout entry');

  // Undo the push override with a loss → bet back to lost, payout taken back.
  const back = await rg.setLegResult({ betId: ids.lostParlay, legIndex: 1, result: 'loss' }, admin);
  assert.deepEqual([back.to.status, back.deltaCents], ['lost', -833]);
  await rg.setLegResult({ betId: ids.lostParlay, legIndex: 1, result: 'loss', confirm: true, expectedVersion: back.version }, admin);

  await assert.rejects(rg.setLegResult({ betId: ids.lostParlay, legIndex: 5, result: 'win' }, admin), (e) => e.code === 'BAD_LEG');
  await assert.rejects(rg.setLegResult({ betId: ids.lostParlay, legIndex: 0, result: 'maybe' }, admin), (e) => e.code === 'BAD_RESULT');
  assert.deepEqual(stats('u1'), recount('u1'));
  assert.equal(ledgerSum('u1'), bal('u1'));
});

test('a regrade previewed before settlement can\'t be applied after it', async () => {
  seed();
  const { gameId } = await cg.createCustomGame(gameBody(), admin);
  await place('u1', 'mike', [L(gameId, 'moneyline', 'home', null, -150, 1000)]);
  const betId = [...store.keys()].find((k) => k.startsWith('bets/')).slice(5);
  const p = await rg.gradeBet({ betId, outcome: 'void' }, admin);
  await cg.finalizeCustomGame({ gameId, homeScore: 7, awayScore: 3, confirm: true }, admin); // settles as a win
  await assert.rejects(rg.gradeBet({ betId, outcome: 'void', confirm: true, expectedVersion: p.version }, admin), (e) => e.code === 'BET_CHANGED');
  assert.equal(bal('u1'), 10000 - 1000 + 1666);
});

test('/api/admin routes the new actions', async () => {
  seed();
  const handler = (await import(url('api/admin.js'))).default;
  const res = () => ({ statusCode: 200, headers: {}, body: null, headersSent: false, setHeader(a, b) { this.headers[a] = b; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } });
  let r = res();
  await handler({ method: 'POST', headers: {}, body: { action: 'createCustomGame', ...gameBody() } }, r);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const gameId = r.body.gameId;
  for (const [action, extra, code] of [
    ['finalizeCustomGame', { gameId, homeScore: 1, awayScore: 0 }, 200],
    ['cancelCustomGame', { gameId }, 200],
    ['gradeBet', { betId: 'nope', outcome: 'win' }, 404],
    ['setLegResult', { betId: 'nope', legIndex: 0, result: 'win' }, 404],
    ['deleteCustomGame', { gameId }, 200],
  ]) {
    r = res();
    await handler({ method: 'POST', headers: {}, body: { action, ...extra } }, r);
    assert.equal(r.statusCode, code, `${action}: ${JSON.stringify(r.body)}`);
  }
});
