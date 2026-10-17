// Casino latency benchmark: node --experimental-test-module-mocks test/casino/bench.mjs [rpcMs] [commitMs]
// Runs real /api/casino calls (auth included) against the in-memory Firestore, with every network round
// trip delayed by rpcMs (and each commit by rpcMs + commitMs), and prints the wall time of each call.
// The delays are a model; the count of round trips made one after another is what the code controls.
import { mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFakeDb } from './fakeFirestore.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;
const rpcMs = Number(process.argv[2] ?? 30);
const commitMs = Number(process.argv[3] ?? 20);
const fake = makeFakeDb();
const TOKENS = {};
for (let i = 1; i <= 5; i += 1) TOKENS[`t${i}`] = { uid: `p${i}` };
mock.module(url('server/firebaseAdmin.js'), {
  namedExports: {
    adminDb: () => fake.db,
    // Token checks are local (cached Google keys): no round trip.
    adminAuth: () => ({ async verifyIdToken(t) { if (!TOKENS[t]) throw new Error('bad'); return { ...TOKENS[t] }; } }),
    normalizePrivateKey: (k) => k,
  },
});
const handler = (await import(url('api/casino.js'))).default;

let reqNo = 0;
const rid = () => `bench-${String(++reqNo).padStart(8, '0')}`;
async function call(player, body) {
  const res = { headers: {}, statusCode: 0, body: null, headersSent: false, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } };
  await handler({ method: 'POST', headers: { authorization: `Bearer t${player}` }, body }, res);
  if (res.statusCode !== 200) throw new Error(`${body.action}: ${JSON.stringify(res.body)}`);
  return res;
}
async function timed(label, player, body, results) {
  fake.setLatency({ rpcMs, commitMs });
  fake.resetCounts();
  const start = performance.now();
  const res = await call(player, body);
  const ms = performance.now() - start;
  fake.setLatency({});
  results.push({ label, ms: Math.round(ms), rpcs: fake.counts.rpcs, serverTiming: res.headers['server-timing'] ?? '' });
  return res;
}
function seed() {
  fake.reset();
  for (let i = 1; i <= 5; i += 1) fake.write(`users/p${i}`, { username: `p${i}`, displayName: `P${i}`, balanceCents: 1_000_000, stats: {}, disabled: false });
}

const results = [];
for (let round = 0; round < 3; round += 1) {
  seed();
  await timed('slots spin', 1, { action: 'spin', amount: 1, requestId: rid() }, results);
  // Baccarat: two seated players.
  await call(1, { action: 'sit', game: 'baccarat', seat: 0 });
  await call(2, { action: 'sit', game: 'baccarat', seat: 1 });
  await timed('baccarat bet', 1, { action: 'bet', game: 'baccarat', player: 5, banker: 0, tie: 0, requestId: rid() }, results);
  await call(2, { action: 'bet', game: 'baccarat', player: 0, banker: 3, tie: 0, requestId: rid() });
  await call(1, { action: 'confirm', game: 'baccarat' });
  await timed('baccarat confirm → deal + pay', 2, { action: 'confirm', game: 'baccarat' }, results);
  await timed('heartbeat', 1, { action: 'heartbeat', game: 'baccarat' }, results);
  await timed('tick (nothing due)', 1, { action: 'tick', game: 'baccarat' }, results);
  // Blackjack: three players.
  for (let p = 1; p <= 3; p += 1) await call(p, { action: 'sit', game: 'blackjack', seat: p - 1 });
  for (let p = 1; p <= 3; p += 1) {
    const r = await call(p, { action: 'bet', game: 'blackjack', amount: 5, requestId: rid() });
    void r;
  }
  for (let guard = 0; guard < 50; guard += 1) {
    const t = fake.get('casinoTables/blackjack');
    if (t.phase === 'insurance') {
      for (let p = 1; p <= 3; p += 1) if (fake.get('casinoTables/blackjack').phase === 'insurance') await call(p, { action: 'insurance', game: 'blackjack', amountCents: 0 }).catch(() => {});
      continue;
    }
    if (t.phase !== 'playing') break;
    const seat = t.seats[t.turn.seat];
    const hand = seat.hands[t.turn.hand];
    const player = Number(seat.uid.slice(1));
    const moves = t.seats.filter(Boolean).flatMap((s) => s.hands).filter((h) => h.status === 'playing').length;
    const label = moves === 1 ? 'blackjack stand → dealer plays + pays' : 'blackjack stand';
    await timed(label, player, { action: 'stand', game: 'blackjack', hand: t.turn.hand, actionSeq: hand.seq }, results);
  }
  // Craps: three players, point on.
  for (let p = 1; p <= 3; p += 1) await call(p, { action: 'sit', game: 'craps', seat: p - 1 });
  for (let p = 1; p <= 3; p += 1) await call(p, { action: 'bet', game: 'craps', kind: 'pass', amount: 5, requestId: rid() });
  for (let guard = 0; guard < 20 && fake.get('casinoTables/craps').point === null; guard += 1) {
    const t = fake.get('casinoTables/craps');
    const shooter = Number(t.seats[t.shooter].uid.slice(1));
    if (!t.seats[t.shooter].bets.pass) await call(shooter, { action: 'bet', game: 'craps', kind: 'pass', amount: 1, requestId: rid() });
    await call(shooter, { action: 'roll', game: 'craps', rollSeq: t.rollSeq });
  }
  await timed('craps place bet', 2, { action: 'bet', game: 'craps', kind: 'field', amount: 1, requestId: rid() }, results);
  const t = fake.get('casinoTables/craps');
  await timed('craps roll → settle 3 players', Number(t.seats[t.shooter].uid.slice(1)), { action: 'roll', game: 'craps', rollSeq: t.rollSeq }, results);
}

const byLabel = new Map();
for (const r of results) {
  if (!byLabel.has(r.label)) byLabel.set(r.label, []);
  byLabel.get(r.label).push(r);
}
console.log(`model: ${rpcMs} ms per round trip, commit ${rpcMs + commitMs} ms`);
for (const [label, list] of byLabel) {
  const ms = list.map((r) => r.ms).sort((a, b) => a - b);
  const median = ms[Math.floor(ms.length / 2)];
  console.log(`${label.padEnd(40)} ${String(median).padStart(5)} ms   round trips ${list[0].rpcs}   ${list[0].serverTiming}`);
}
