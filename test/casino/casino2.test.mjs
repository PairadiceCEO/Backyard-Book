// npm run test:casino  (or: node --experimental-test-module-mocks test/casino/casino2.test.mjs)
// Casino phase 2: shared tables (seats, presence, deadlines, tick) and Baccarat.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFakeDb } from './fakeFirestore.mjs';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;
const fake = makeFakeDb();
const TOKENS = { 'p1-token': { uid: 'p1' }, 'gone-token': { uid: 'p9' } };
mock.module(url('server/firebaseAdmin.js'), {
  namedExports: {
    adminDb: () => fake.db,
    adminAuth: () => ({ async verifyIdToken(t) { if (!TOKENS[t]) throw new Error('bad'); return { ...TOKENS[t] }; } }),
    normalizePrivateKey: (k) => k,
  },
});

const B = await import(url('shared/casino/baccarat.js'));
const C = await import(url('shared/casino/cards.js'));
const { handleTableAction } = await import(url('server/casino/tables.js'));
const { groupShopPurchases } = await import(url('src/lib/shopHistory.js'));
const handler = (await import(url('api/casino.js'))).default;

const UIDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
const T0 = 1_800_000_000_000;
function seed(balanceCents = 10000) {
  fake.reset();
  for (const uid of UIDS) fake.write(`users/${uid}`, { username: uid, displayName: `Player ${uid.slice(1)}`, balanceCents, stats: { won: 1, lost: 1 }, disabled: false });
}
const callerOf = (uid) => ({ uid, token: {}, user: fake.get(`users/${uid}`) });
let rng = (max) => Math.floor(Math.random() * max);
const act = (uid, action, fields = {}, now = T0) => handleTableAction(callerOf(uid), { game: 'baccarat', action, ...fields }, { now, randomInt: (m) => rng(m) });
let reqNo = 0;
const rid = () => `req-${String(++reqNo).padStart(8, '0')}`;
const bet = (uid, bets, now = T0, requestId = rid()) => act(uid, 'bet', { player: 0, banker: 0, tie: 0, ...bets, requestId }, now);
const table = () => fake.get('casinoTables/baccarat');
const shoeDoc = () => fake.get('casinoTables/baccarat/private/shoe');
const wallet = (uid) => fake.get(`users/${uid}`).balanceCents;
const ledger = () => [...fake.store].filter(([k]) => k.startsWith('ledger/')).map(([k, v]) => ({ id: k.slice(7), ...v }));
const err = async (p, code) => { await assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return true; }); };

// Puts these cards on top of the shoe (rng 0 then draws them in order).
function stackShoe(cards) {
  const full = C.buildShoe(8);
  const rest = full.filter((c) => !cards.includes(c));
  fake.write('casinoTables/baccarat/private/shoe', { cards: [...cards, ...rest], dealt: 0, shuffles: 0 });
  rng = () => 0;
}
const randomRng = () => { rng = (max) => Math.floor(Math.random() * max); };

// Every card-shaped string in the public doc must be out of the shoe; nothing is ever duplicated or lost.
function assertShoeSecret(where) {
  const pub = table();
  const shoe = shoeDoc();
  if (!pub || !shoe) return;
  const inShoe = new Set(shoe.cards);
  const publicCards = [];
  const walk = (v) => {
    if (typeof v === 'string' && C.isCard(v)) publicCards.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(pub);
  for (const c of publicCards) assert.ok(!inShoe.has(c), `${where}: public doc shows ${c}, which is still in the shoe`);
  assert.equal(new Set(shoe.cards).size, shoe.cards.length, `${where}: duplicate card in shoe`);
  assert.equal(shoe.cards.length + shoe.dealt, 416, `${where}: cards lost or invented`);
  assert.equal(JSON.stringify(pub).includes('"cards"'), false, `${where}: shoe array leaked`);
  if (pub.shoe) assert.equal(pub.shoe.remaining, shoe.cards.length);
}

// ---------- rules ----------
test('Banker tableau: every Banker total against every Player third card (and Player standing)', () => {
  // Rows: Banker two-card total 0–7. Columns: Player third card value 0–9. D = draw, S = stand.
  const chart = {
    0: 'DDDDDDDDDD', 1: 'DDDDDDDDDD', 2: 'DDDDDDDDDD',
    3: 'DDDDDDDDSD', 4: 'SSDDDDDDSS', 5: 'SSSSDDDDSS', 6: 'SSSSSSDDSS', 7: 'SSSSSSSSSS',
  };
  for (let b = 0; b <= 7; b += 1) {
    for (let p = 0; p <= 9; p += 1) assert.equal(B.bankerDraws(b, p), chart[b][p] === 'D', `banker ${b}, player third ${p}`);
    assert.equal(B.bankerDraws(b, null), b <= 5, `banker ${b}, player stood`);
  }
  for (let t = 0; t <= 7; t += 1) assert.equal(B.playerDraws(t), t <= 5);
  assert.equal(B.baccaratValue('AS0'), 1);
  assert.equal(B.baccaratValue('9H1'), 9);
  for (const r of 'TJQK') assert.equal(B.baccaratValue(`${r}D2`), 0);
  assert.equal(B.handTotal(['9S0', '8S0']), 7);
});

test('scripted coups: naturals stand, Player 0–5 draws, Banker follows the tableau', () => {
  const coup = (cards) => { let i = 0; const r = B.playCoup(() => cards[i++]); assert.equal(i, r.player.length + r.banker.length); return r; };
  // P 9 natural vs B 6: nobody draws.
  let r = coup(['9S0', '3H0', 'KS0', '3D0']);
  assert.deepEqual([r.player.length, r.banker.length, r.natural, r.winner, r.playerTotal, r.bankerTotal], [2, 2, true, 'player', 9, 6]);
  // B natural 8 vs P 0: Player does not draw.
  r = coup(['KS0', '4H0', 'QS0', '4D0']);
  assert.deepEqual([r.player.length, r.banker.length, r.winner], [2, 2, 'banker']);
  // P 6 stands; B 5 draws (Player stood → Banker draws 0–5).
  r = coup(['3S0', '2H0', '3D0', '3C0', '4S0']);
  assert.deepEqual([r.player.length, r.banker.length, r.playerTotal, r.bankerTotal, r.winner], [2, 3, 6, 9, 'banker']);
  // P 7 stands; B 6 stands → Player wins.
  r = coup(['4S0', '3H0', '3D0', '3C0']);
  assert.deepEqual([r.player.length, r.banker.length, r.winner], [2, 2, 'player']);
  // P 5 draws an 8; B 3 stands on a Player 8.
  r = coup(['2S0', '2H0', '3D0', 'AC0', '8S0']);
  assert.deepEqual([r.player.length, r.banker.length, r.playerTotal, r.bankerTotal], [3, 2, 3, 3]);
  assert.equal(r.winner, 'tie');
  // P 0 draws a 7; B 6 draws on a Player 6/7.
  r = coup(['KS0', '3H0', 'QD0', '3C0', '7S0', '2D0']);
  assert.deepEqual([r.player.length, r.banker.length, r.playerTotal, r.bankerTotal, r.winner], [3, 3, 7, 8, 'banker']);
  // P 2 draws a 9; B 4 stands on a Player 9.
  r = coup(['AS0', '2H0', 'AD0', '2C0', '9S0']);
  assert.deepEqual([r.player.length, r.banker.length, r.playerTotal, r.bankerTotal, r.winner], [3, 2, 1, 4, 'banker']);
  assert.deepEqual(B.revealOrder(['a', 'b', 'c'], ['x', 'y']).map((o) => `${o.hand[0]}${o.index}`), ['p0', 'b0', 'p1', 'b1', 'p2']);
});

test('exact 8-deck odds from the real playCoup: Banker 45.8597%, Player 44.6247%, Tie 9.5156%', () => {
  const RANK_FOR = ['K', 'A', '2', '3', '4', '5', '6', '7', '8', '9'];
  const counts = [128, 32, 32, 32, 32, 32, 32, 32, 32, 32];
  const totals = { player: 0, banker: 0, tie: 0 };
  class Need extends Error {}
  function explore(prefix, prob, left, n) {
    let i = 0;
    let result;
    try {
      result = B.playCoup(() => { if (i >= prefix.length) throw new Need(); return `${RANK_FOR[prefix[i++]]}S0`; });
    } catch (e) {
      if (!(e instanceof Need)) throw e;
      for (let v = 0; v < 10; v += 1) {
        if (!left[v]) continue;
        const p = left[v] / n;
        left[v] -= 1;
        explore([...prefix, v], prob * p, left, n - 1);
        left[v] += 1;
      }
      return;
    }
    totals[result.winner] += prob;
  }
  explore([], 1, counts.slice(), 416);
  assert.ok(Math.abs(totals.player + totals.banker + totals.tie - 1) < 1e-12);
  assert.ok(Math.abs(totals.banker - 0.458597) < 5e-6, `banker ${totals.banker}`);
  assert.ok(Math.abs(totals.player - 0.446247) < 5e-6, `player ${totals.player}`);
  assert.ok(Math.abs(totals.tie - 0.095156) < 5e-6, `tie ${totals.tie}`);
  // House edge with these payouts: Banker 1.06%, Player 1.24%, Tie 14.36%.
  const edgeBanker = -(totals.banker * 0.95 - totals.player);
  const edgePlayer = -(totals.player - totals.banker);
  const edgeTie = -(totals.tie * 8 - (1 - totals.tie));
  assert.ok(Math.abs(edgeBanker - 0.0106) < 0.0001 && Math.abs(edgePlayer - 0.0124) < 0.0001 && Math.abs(edgeTie - 0.1436) < 0.0001);
});

test('payouts: Player 1:1, Banker 0.95:1 ($3 returns $5.85), Tie 8:1, Tie pushes Player and Banker', () => {
  assert.equal(B.spotReturnCents('player', 500, 'player'), 1000);
  assert.equal(B.spotReturnCents('banker', 300, 'banker'), 585);
  assert.equal(B.spotReturnCents('banker', 100, 'banker'), 195);
  assert.equal(B.spotReturnCents('banker', 1000, 'banker'), 1950);
  assert.equal(B.spotReturnCents('tie', 100, 'tie'), 900);
  assert.equal(B.spotReturnCents('player', 500, 'tie'), 500, 'push');
  assert.equal(B.spotReturnCents('banker', 700, 'tie'), 700, 'push');
  assert.equal(B.spotReturnCents('player', 500, 'banker'), 0);
  assert.equal(B.spotReturnCents('tie', 500, 'player'), 0);
  assert.deepEqual(B.settleBaccaratBets({ player: 0, banker: 300, tie: 100 }, 'banker'), { stakeCents: 400, returnCents: 585, netCents: 185 });
  assert.deepEqual(B.settleBaccaratBets({ player: 500, banker: 0, tie: 100 }, 'tie'), { stakeCents: 600, returnCents: 1400, netCents: 800 });
  for (let d = 1; d <= 10; d += 1) assert.ok(Number.isInteger(B.spotReturnCents('banker', d * 100, 'banker')));
});

// ---------- seats ----------
test('sit, watch, leave: seat numbers, a second seat for the same player, full table, names in the public doc', async () => {
  seed();
  const r = await act('p1', 'sit', { seat: 0 });
  assert.equal(r.seat, 0);
  assert.equal((await act('p1', 'sit', { seat: 0 })).already, true);
  const second = await act('p1', 'sit', { seat: 2 });
  assert.deepEqual([second.seat, second.mySeats], [2, [0, 2]], 'Baccarat allows several seats per player');
  const gone = await act('p1', 'leave', { seat: 2 });
  assert.deepEqual([gone.freedSeats, table().seats[2], table().seats[0].uid], [[2], null, 'p1'], 'leaving one seat keeps the other');
  await err(act('p2', 'sit', { seat: 0 }), 'SEAT_TAKEN');
  await err(act('p2', 'sit', { seat: 5 }), 'BAD_SEAT');
  await act('p2', 'sit', { seat: 2 });
  assert.deepEqual(table().seats.map((s) => s?.name ?? null), ['Player 1', null, 'Player 2', null, null]);
  for (const uid of ['p3', 'p4', 'p5']) await act(uid, 'sit');
  assert.deepEqual(table().seats.map((s) => s.uid), ['p1', 'p3', 'p2', 'p4', 'p5']);
  await err(act('p6', 'sit'), 'TABLE_FULL');
  // Watching: p6 can see the doc but can't bet or confirm.
  await err(bet('p6', { player: 5 }), 'NOT_SEATED');
  await err(act('p6', 'confirm'), 'NOT_SEATED');
  assert.equal((await act('p6', 'heartbeat')).seated, false);
  // Leaving with nothing in play frees the seat at once.
  assert.equal((await act('p4', 'leave')).left, true);
  assert.equal(table().seats[3], null);
  assert.ok(fake.get('casinoTables/baccarat/presence/p1').at === T0, 'sitting writes presence');
  assert.equal(table().roundNo, 1);
});

test('presence is written at most every 30 s; any action counts as a heartbeat', async () => {
  seed();
  await act('p1', 'sit', { seat: 0 }, T0);
  const writes = () => fake.counts.byPrefix['writes:casinoTables/baccarat/presence'] ?? 0;
  fake.resetCounts();
  assert.equal((await act('p1', 'heartbeat', {}, T0 + 20_000)).wrote, false);
  assert.equal(writes(), 0, 'heartbeat under 30 s: no write');
  assert.equal((await act('p1', 'heartbeat', {}, T0 + 30_000)).wrote, true);
  assert.equal(writes(), 1);
  assert.equal(fake.counts.byPrefix['writes:casinoTables'] ?? 0, 0, 'heartbeats never rewrite the table doc');
  await bet('p1', { player: 1 }, T0 + 61_000);
  assert.equal(fake.get('casinoTables/baccarat/presence/p1').at, T0 + 61_000, 'a bet refreshes presence');
});

// ---------- baccarat round ----------
test('a full round: bets start a 15 s clock, both confirm → dealt at once, paid, scoreboard updated', async () => {
  seed(10000);
  await act('p1', 'sit', { seat: 0 });
  await act('p2', 'sit', { seat: 2 });
  assert.equal(table().deadline, null, 'no timer before the first bet');
  // P 4+3 = 7, B 2+3 = 5 → B draws on 5? Player stood (7), Banker 5 draws: give a 3 → Banker 8.
  stackShoe(['4S0', '2H0', '3D0', '3C0', '3S1']);
  await bet('p1', { player: 5 }, T0 + 1000);
  assert.equal(table().deadline, T0 + 1000 + 15_000);
  assert.equal(wallet('p1'), 9500);
  await bet('p2', { banker: 3, tie: 1 }, T0 + 4000);
  assert.equal(table().deadline, T0 + 16_000, 'later bets do not move the clock');
  assert.equal(wallet('p2'), 9600);
  await act('p2', 'confirm', {}, T0 + 5000);
  assert.equal(table().phase, 'betting', 'still waiting for seat 1');
  assertShoeSecret('before deal');
  const r = await act('p1', 'confirm', {}, T0 + 6000);
  assert.equal(r.dealt, true, 'betting closed the moment everyone confirmed');
  const t = table();
  assert.equal(t.phase, 'results');
  assert.deepEqual([t.coup.player, t.coup.banker, t.coup.playerTotal, t.coup.bankerTotal, t.coup.winner], [['4S0', '3D0'], ['2H0', '3C0', '3S1'], 7, 8, 'banker']);
  assert.equal(t.deadline, T0 + 6000 + 4500 + B.BACCARAT_SETTLE_MS + 5000, 'results stay 5 s after the last card turns (third card at 4.5 s)');
  assert.deepEqual(B.coupRevealTimes(t.coup.player, t.coup.banker), [0, 1000, 2000, 3000, 4500], 'opening cards 1 s apart, 1.5 s before the third card');
  assert.equal(t.coup.dealtAt, T0 + 6000, 'phones time the cards from the server deal time');
  assert.equal(wallet('p1'), 9500, 'Player lost');
  assert.equal(wallet('p2'), 9600 + 585, '$3 Banker returns $5.85');
  assert.deepEqual(t.seats[2].result, { stakeCents: 400, returnCents: 585, netCents: 185 });
  assert.equal(t.shoeResults, 'B');
  assert.equal(t.history, undefined);
  assertShoeSecret('after deal');
  const pays = ledger().filter((e) => e.type === 'casino_payout');
  assert.deepEqual(pays.map((e) => [e.id, e.uid, e.amountCents, e.game]), [[`cpay_baccarat_${t.roundId}_p2_s2_end`, 'p2', 585, 'baccarat']]);
  assert.deepEqual(fake.get('users/p2').stats, { won: 1, lost: 1 }, 'win rate stays sportsbook-only');
  // Betting is closed during results.
  await err(bet('p1', { player: 1 }, T0 + 7000), 'PHASE');
  // Tick too early: nothing happens, nothing written.
  fake.resetCounts();
  assert.equal((await act('p1', 'tick', {}, t.deadline - 1)).applied, false);
  assert.equal(fake.counts.writes, 0);
  // At the deadline: next round, bets cleared.
  assert.equal((await act('p2', 'tick', {}, t.deadline)).applied, true);
  const n = table();
  assert.deepEqual([n.phase, n.roundNo, n.coup, n.deadline], ['betting', 2, null, null]);
  assert.deepEqual(n.seats[0].bets, { player: 0, banker: 0, tie: 0 });
  assert.equal(n.seats[0].ready, false);
  assert.equal(n.shoeResults, 'B');
});

test('tie: Player and Banker bets push, Tie pays 8:1', async () => {
  seed(10000);
  await act('p1', 'sit', { seat: 0 });
  stackShoe(['4S0', '4H0', '3D0', '3C0']); // 7 v 7, both stand
  await bet('p1', { player: 5, banker: 2, tie: 1 });
  await act('p1', 'confirm');
  assert.equal(table().coup.winner, 'tie');
  assert.equal(wallet('p1'), 10000 - 800 + 500 + 200 + 900);
  assert.equal(table().shoeResults, 'T');
});

test('changing bets charges or refunds the difference; a retry is applied once; limits enforced', async () => {
  seed(1500);
  await act('p1', 'sit', { seat: 0 });
  await bet('p1', { player: 5 }, T0, 'req-change-01');
  assert.equal(wallet('p1'), 1000);
  assert.equal((await bet('p1', { player: 5 }, T0, 'req-change-01')).duplicate, true);
  assert.equal(wallet('p1'), 1000, 'retry not charged');
  await bet('p1', { player: 8, tie: 2 }, T0, 'req-change-02');
  assert.equal(wallet('p1'), 500);
  await bet('p1', { player: 2 }, T0, 'req-change-03');
  assert.equal(wallet('p1'), 1300, 'lowered: $8 back');
  assert.equal((await bet('p1', { banker: 10 }, T0, 'req-change-03')).duplicate, true, 'a replayed refund request does nothing');
  assert.equal(wallet('p1'), 1300);
  await err(bet('p1', { player: 11 }), 'BAD_BET');
  await err(bet('p1', { player: 2.5 }), 'BAD_BET');
  await err(bet('p1', { player: -1 }), 'BAD_BET');
  await err(act('p1', 'bet', { player: 1 }), 'BAD_REQUEST_ID');
  await err(bet('p1', { player: 10, banker: 10, tie: 10 }), 'INSUFFICIENT_BALANCE');
  assert.equal(wallet('p1'), 1300, 'refused change wrote nothing');
  assert.deepEqual(table().seats[0].bets, { player: 200, banker: 0, tie: 0 });
  const types = ledger().map((e) => [e.type, e.amountCents]).sort();
  assert.deepEqual(types, [['casino_bet', -500], ['casino_bet', -500], ['casino_refund', 800]].sort(), '$5, then +$5 to reach $10, then $8 back');
  const sum = ledger().reduce((s, e) => s + e.amountCents, 0);
  assert.equal(1500 + sum, wallet('p1'), 'ledger adds up to the wallet');
  // Confirm locks bets; confirm without a bet is refused.
  await act('p2', 'sit');
  await err(act('p2', 'confirm'), 'NO_BET');
  await act('p1', 'confirm');
  await err(bet('p1', { player: 3 }), 'CONFIRMED');
  assert.equal((await act('p1', 'confirm')).ready, true, 'confirm twice is fine');
});

test('five players betting at the same moment are serialized: every bet lands, no money lost', async () => {
  seed(10000);
  for (const [i, uid] of ['p1', 'p2', 'p3', 'p4', 'p5'].entries()) await act(uid, 'sit', { seat: i });
  fake.resetCounts();
  const amounts = { p1: 1, p2: 2, p3: 5, p4: 10, p5: 7 };
  await Promise.all(Object.entries(amounts).map(([uid, d]) => bet(uid, { banker: d }, T0 + 500)));
  assert.ok(fake.counts.retries > 0, 'transactions really collided and retried');
  const t = table();
  for (const [i, [uid, d]] of Object.entries(amounts).entries()) {
    assert.equal(t.seats[i].bets.banker, d * 100);
    assert.equal(wallet(uid), 10000 - d * 100);
  }
  assert.equal(t.deadline, T0 + 500 + 15_000);
  // All five confirm at once: dealt exactly once.
  randomRng();
  await Promise.all(['p1', 'p2', 'p3', 'p4', 'p5'].map((uid) => act(uid, 'confirm', {}, T0 + 2000)));
  assert.equal(table().phase, 'results');
  assert.equal(table().shoeResults.length, 1);
  assertShoeSecret('five confirms');
  const payouts = ledger().filter((e) => e.type === 'casino_payout');
  assert.ok(payouts.length === 0 || payouts.length === 5);
});

test('a timeout applies exactly once when five phones tick together', async () => {
  seed(10000);
  for (const [i, uid] of ['p1', 'p2', 'p3', 'p4', 'p5'].entries()) await act(uid, 'sit', { seat: i });
  await bet('p1', { player: 2 }, T0);
  await bet('p2', { banker: 2 }, T0);
  const deadline = table().deadline;
  randomRng();
  const ticks = await Promise.all(['p1', 'p2', 'p3', 'p4', 'p6'].map((uid) => act(uid, 'tick', {}, deadline + 300)));
  assert.equal(ticks.filter((r) => r.applied).length, 1, 'one tick applies the default');
  assert.equal(table().phase, 'results');
  assert.equal(table().shoeResults.length, 1);
  const pays = ledger().filter((e) => e.type === 'casino_payout');
  assert.equal(new Set(pays.map((e) => e.uid)).size, pays.length, 'nobody paid twice');
  assert.equal(pays.length, 1 + (table().coup.winner === 'tie' ? 1 : 0), 'one seat wins (both push on a tie)');
  // Five ticks for the results deadline: next round opens once.
  const resultsDeadline = table().deadline;
  const again = await Promise.all(UIDS.slice(0, 5).map((uid) => act(uid, 'tick', {}, resultsDeadline + 10)));
  assert.equal(again.filter((r) => r.applied).length, 1);
  assert.equal(table().roundNo, 2);
  // Betting closes by itself at 0 even with nobody confirming; with no bets, nothing is dealt.
  await bet('p3', { tie: 1 }, resultsDeadline + 20);
  await bet('p3', { tie: 0 }, resultsDeadline + 30);
  assert.equal((await act('p6', 'tick', {}, resultsDeadline + 20 + 15_000)).applied, true);
  assert.deepEqual([table().phase, table().deadline, table().shoeResults.length], ['betting', null, 1]);
});

test('stale seats free only at round end; bets of a player who went quiet still settle', async () => {
  seed(10000);
  randomRng();
  await act('p1', 'sit', { seat: 0 }, T0);
  await act('p3', 'sit', { seat: 2 }, T0);
  // p3 bets once and then their phone goes away (no more heartbeats).
  await bet('p3', { banker: 4 }, T0 + 1000);
  await bet('p1', { player: 1 }, T0 + 1000);
  let now = T0 + 1000;
  const p3Start = wallet('p3');
  // Run rounds for p1 only: p1 bets every round and heartbeats; p3 stays silent.
  let freedAt = null;
  for (let round = 0; round < 8 && freedAt === null; round += 1) {
    const t = table();
    if (t.phase === 'betting' && t.deadline) {
      now = t.deadline;
      await act('p1', 'tick', {}, now); // deal
      assert.equal(table().phase, 'results');
      assert.ok(table().seats[2], 'never freed while their bets are on the felt or results are up');
      now = table().deadline;
      await act('p1', 'tick', {}, now); // next round
      if (!table().seats[2]) freedAt = now;
      else await bet('p1', { player: 1 }, now + 1000);
      now += 1000;
    }
  }
  assert.ok(freedAt !== null, 'seat 3 was freed');
  // p3's last presence write was when they sat (T0); their bet a second later was under 30 s after it.
  assert.equal(fake.get('casinoTables/baccarat/presence/p3').at, T0);
  assert.ok(freedAt - T0 > 60_000, 'not before 60 s of silence');
  assert.ok(freedAt - T0 <= 60_000 + 30_000, 'within one round of the 60 s mark');
  assert.equal(table().phase, 'betting', 'freed when a round opened');
  const p3Paid = ledger().filter((e) => e.uid === 'p3' && e.type === 'casino_payout').reduce((s, e) => s + e.amountCents, 0);
  assert.equal(wallet('p3'), p3Start + p3Paid, 'their bet settled normally');
  assert.ok(table().seats[0], 'the active player keeps their seat');
});

test('leaving: with bets it is marked leaving and plays out; without bets it frees and can close betting', async () => {
  seed(10000);
  randomRng();
  await act('p1', 'sit', { seat: 0 });
  await act('p2', 'sit', { seat: 1 });
  await act('p3', 'sit', { seat: 2 });
  await bet('p1', { player: 2 });
  await bet('p2', { banker: 2 });
  await act('p1', 'confirm');
  const r = await act('p2', 'leave');
  assert.deepEqual([r.left, r.leaving], [false, true]);
  assert.equal(table().seats[1].leaving, true);
  await err(bet('p2', { banker: 3 }), 'LEAVING');
  assert.equal(table().phase, 'betting', 'p3 has not bet or left yet');
  await act('p3', 'leave'); // nothing in play: frees, and now everyone left is ready → deal
  assert.equal(table().seats[2], null);
  assert.equal(table().phase, 'results', 'p1 confirmed and p2 left with bets: betting closed');
  assert.ok(table().seats[1].result, 'the leaving seat was settled');
  await act('p1', 'tick', {}, table().deadline);
  assert.equal(table().seats[1], null, 'the leaving seat freed when the next round opened');
  assert.ok(table().seats[0]);
});

test('idle table: a heartbeat frees a seat gone quiet for 60 s; a new player can take over a stale seat', async () => {
  seed(10000);
  await act('p1', 'sit', { seat: 0 }, T0);
  await act('p2', 'sit', { seat: 1 }, T0);
  await act('p1', 'heartbeat', {}, T0 + 30_000);
  assert.ok(table().seats[1], 'p2 only 30 s quiet');
  await act('p1', 'heartbeat', {}, T0 + 61_000);
  assert.equal(table().seats[1], null, 'p2 freed by p1\'s heartbeat on an idle table');
  // Take-over: p3 sits at T0, goes quiet; p4 asks for that exact seat after 61 s.
  await act('p3', 'sit', { seat: 3 }, T0 + 62_000);
  await err(act('p4', 'sit', { seat: 3 }, T0 + 100_000), 'SEAT_TAKEN');
  assert.equal((await act('p4', 'sit', { seat: 3 }, T0 + 62_000 + 61_000)).seat, 3);
  assert.equal(table().seats[3].uid, 'p4');
});

test('the shoe never reaches the public doc: 300 real crypto rounds, reshuffle at 85%, money adds up', async () => {
  seed(1_000_000);
  rng = (await import(url('server/casino/rng.js'))).randomInt;
  await act('p1', 'sit', { seat: 0 });
  await act('p2', 'sit', { seat: 4 });
  let now = T0;
  let shuffles = 0;
  const winners = { P: 0, B: 0, T: 0 };
  let resultsSoFar = '';
  for (let round = 0; round < 300; round += 1) {
    await bet('p1', { player: 1 + (round % 10), tie: round % 3 === 0 ? 1 : 0 }, now);
    await bet('p2', { banker: 10 - (round % 10) }, now);
    assertShoeSecret(`round ${round} betting`);
    await act('p1', 'confirm', {}, now);
    await act('p2', 'confirm', {}, now);
    assertShoeSecret(`round ${round} results`);
    const t = table();
    winners[t.shoeResults.at(-1)] += 1;
    if (t.coup.reshuffled) assert.equal(t.shoeResults.length, 1, 'a new shoe starts the scoreboard over');
    else resultsSoFar += t.shoeResults.at(-1);
    if (t.coup.reshuffled) resultsSoFar = t.shoeResults;
    assert.equal(t.shoeResults, resultsSoFar, 'every result of this shoe, in order');
    const dealt = shoeDoc().dealt;
    assert.ok(dealt <= 354 + 6, 'reshuffled once 354 cards were dealt');
    if (t.coup.reshuffled) shuffles += 1;
    now = t.deadline;
    await act('p2', 'tick', {}, now);
    now += 1000;
  }
  assert.ok(shuffles >= 3, `reshuffled ${shuffles} times`);
  assert.equal(table().shoe.shuffles, shuffles);
  assert.ok(winners.P > 80 && winners.B > 80 && winners.T > 5, JSON.stringify(winners));
  for (const uid of ['p1', 'p2']) {
    const sum = ledger().filter((e) => e.uid === uid).reduce((s, e) => s + e.amountCents, 0);
    assert.equal(1_000_000 + sum, wallet(uid), `${uid}: wallet = start + ledger`);
    const entries = ledger().filter((e) => e.uid === uid);
    assert.ok(entries.every((e) => ['casino_bet', 'casino_payout', 'casino_refund'].includes(e.type) && e.game === 'baccarat'));
  }
  assert.equal(groupShopPurchases(ledger(), []).totalCount, 0, 'no casino entry in Shop purchases');
  assert.equal(table().roundNo, 301);
});

test('/api/casino: baccarat open, other tables still closed, game errors are clear', async () => {
  seed();
  const call = async (body, token = 'p1-token') => {
    const res = { headers: {}, statusCode: 0, body: null, headersSent: false, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } };
    await handler({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body }, res);
    return res;
  };
  let r = await call({ action: 'sit', game: 'baccarat', seat: 1 });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.seat, 1);
  assert.equal(typeof r.body.serverNow, 'number');
  assert.equal(Object.keys(r.body).some((k) => ['state', 'seats', 'coup', 'shoe'].includes(k)), false, 'replies carry no table state');
  r = await call({ action: 'sit', game: 'roulette' });
  assert.deepEqual([r.statusCode, r.body.error.code], [400, 'BAD_GAME']);
  r = await call({ action: 'roll', game: 'baccarat' });
  assert.equal(r.body.error.code, 'UNKNOWN_ACTION');
  r = await call({ action: 'hit', game: 'baccarat' });
  assert.deepEqual([r.statusCode, r.body.error.code], [400, 'UNKNOWN_ACTION']);
  r = await call({ action: 'sit', game: 'poker' });
  assert.equal(r.body.error.code, 'BAD_GAME');
  r = await call({ action: 'sit', game: 'baccarat' }, 'gone-token');
  assert.equal(r.statusCode, 403);
  r = await call({ action: 'tick', game: 'baccarat' });
  assert.deepEqual([r.statusCode, r.body.applied], [200, false]);
  r = await call({ action: 'spin', amount: 1, requestId: 'spin-still-works' });
  assert.equal(r.statusCode, 200, 'slots unaffected');
});

test('tick and heartbeat on a table nobody has opened write nothing', async () => {
  seed();
  fake.resetCounts();
  assert.equal((await act('p1', 'tick')).applied, false);
  assert.equal((await act('p1', 'heartbeat')).seated, false);
  await err(act('p1', 'confirm'), 'NOT_SEATED');
  assert.equal(fake.counts.writes, 0);
  assert.equal(table(), undefined);
});

test('coup timing: Player, Banker, Player, Banker 1 s apart, 1.5 s before each third card (values from timing.js)', async () => {
  const TIMING = await import(url('shared/casino/timing.js'));
  assert.deepEqual([TIMING.BACCARAT_OPENING_GAP_MS, TIMING.BACCARAT_THIRD_CARD_GAP_MS], [1000, 1500]);
  assert.equal(B.BACCARAT_OPENING_GAP_MS, TIMING.BACCARAT_OPENING_GAP_MS, 'baccarat.js uses the shared timing file');
  assert.deepEqual(B.revealOrder(['a', 'b'], ['c', 'd']), [
    { hand: 'player', index: 0 }, { hand: 'banker', index: 0 }, { hand: 'player', index: 1 }, { hand: 'banker', index: 1 },
  ], 'one card at a time: Player, Banker, Player, Banker');
  assert.deepEqual(B.coupRevealTimes(['a', 'b'], ['c', 'd']), [0, 1000, 2000, 3000]);
  assert.deepEqual(B.coupRevealTimes(['a', 'b', 'e'], ['c', 'd']), [0, 1000, 2000, 3000, 4500]);
  assert.deepEqual(B.coupRevealTimes(['a', 'b', 'e'], ['c', 'd', 'f']), [0, 1000, 2000, 3000, 4500, 6000]);
  assert.deepEqual(B.coupRevealTimes(['a', 'b'], ['c', 'd', 'f']), [0, 1000, 2000, 3000, 4500], 'Player stands, Banker draws');
  assert.equal(B.coupRevealMs(['a', 'b'], ['c', 'd']), 3000 + B.BACCARAT_SETTLE_MS);
  assert.equal(B.coupRevealMs(['a', 'b', 'e'], ['c', 'd', 'f']), 6000 + B.BACCARAT_SETTLE_MS);
});
