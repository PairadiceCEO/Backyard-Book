// npm run test:battles  (or: node --experimental-test-module-mocks --test test/battles/battles.test.mjs)
// Battles: payout math (places, ties, teams, rounding), and every server flow against an in-memory
// Firestore — create, accept, decline, cancel, 48 h expiry, result, dispute, admin fixes, pay-once.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFakeDb } from '../casino/fakeFirestore.mjs';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;

const fake = makeFakeDb();
const TOKENS = { 'will-token': { uid: 'will' }, 'nope-token': null };
mock.module(url('server/firebaseAdmin.js'), {
  namedExports: {
    adminDb: () => fake.db,
    adminAuth: () => ({ async verifyIdToken(t) { if (!TOKENS[t]) throw new Error('bad'); return { ...TOKENS[t] }; } }),
    normalizePrivateKey: (k) => k,
  },
});

const R = await import(url('shared/battles.js'));
const B = await import(url('server/battles.js'));
const { groupShopPurchases } = await import(url('src/lib/shopHistory.js'));
const handler = (await import(url('api/battles.js'))).default;

const T0 = new Date('2026-10-18T15:00:00.000Z');
const later = (ms) => new Date(T0.getTime() + ms);
const H = 60 * 60 * 1000;
const UIDS = ['will', 'mike', 'dan', 'ann', 'bo', 'cy', 'di', 'ed', 'fay'];
const START = 10_000; // $100.00 each

const caller = (uid) => ({ uid, token: {}, user: fake.get(`users/${uid}`) });
const admin = { uid: 'boss', token: { admin: true }, user: { username: 'boss', displayName: 'Boss' } };
const wallet = (uid) => fake.get(`users/${uid}`).balanceCents;
const battle = (id) => fake.get(`battles/${id}`);
const ledger = () => [...fake.store].filter(([k]) => k.startsWith('ledger/')).map(([k, v]) => ({ id: k.slice(7), ...v }));
const err = async (p, code) => {
  await assert.rejects(p, (e) => {
    assert.equal(e.code, code, e.message);
    return true;
  });
};
let reqNo = 0;
const rid = () => `battle-req-${String(++reqNo).padStart(6, '0')}`;

beforeEach(() => {
  fake.reset();
  for (const uid of UIDS) fake.write(`users/${uid}`, { username: uid, displayName: uid[0].toUpperCase() + uid.slice(1), balanceCents: START, stats: { won: 3, lost: 2 }, disabled: false });
});

// Free-for-all among `uids` (creator first).
async function ffa(uids, { stake = 10, payout = [10000], title = 'Golf', now = T0, requestId = rid() } = {}) {
  const res = await B.createBattle(caller(uids[0]), { clientRequestId: requestId, title, description: 'Nine holes', format: 'ffa', stakeDollars: stake, payoutBps: payout, players: uids.map((uid) => ({ uid })) }, { now });
  return res.battleId;
}
async function acceptAll(id, uids, now = T0) {
  for (const uid of uids) await B.acceptBattle(caller(uid), { battleId: id }, { now });
}
// The whole battle's ledger adds up to zero once it's paid out (the pot goes back out in full).
function battleNet(id) {
  return ledger().filter((e) => e.battleId === id).reduce((s, e) => s + e.amountCents, 0);
}

// ---------- pure rules ----------

test('payouts: places, ties covering positions, team shares, round down with leftover to the top winner', () => {
  const players = (uids) => uids.map((uid) => ({ uid, status: 'accepted' }));
  const ffaB = (uids, bps) => ({ format: 'ffa', payoutBps: bps, participants: players(uids) });

  // Winner takes all.
  assert.deepEqual(R.computeBattlePayouts(ffaB(['a', 'b', 'c'], [10000]), 3000, { a: 2, b: 1, c: 3 }).byUid, { a: 0, b: 3000, c: 0 });
  // 70 / 30.
  assert.deepEqual(R.computeBattlePayouts(ffaB(['a', 'b', 'c', 'd'], [7000, 3000]), 4000, { a: 1, b: 2, c: 3, d: 4 }).byUid, { a: 2800, b: 1200, c: 0, d: 0 });
  // Two tied for 1st split 1st + 2nd (70 + 30 = 100 → 50 each), whether written 1,1,3 or 1,1,2.
  for (const places of [{ a: 1, b: 1, c: 3, d: 4 }, { a: 1, b: 1, c: 2, d: 3 }]) {
    assert.deepEqual(R.computeBattlePayouts(ffaB(['a', 'b', 'c', 'd'], [7000, 3000]), 4000, places).byUid, { a: 2000, b: 2000, c: 0, d: 0 });
  }
  // Tie for 2nd: positions 2 and 3 → 30% + 0% split → 15% each.
  assert.deepEqual(R.computeBattlePayouts(ffaB(['a', 'b', 'c', 'd'], [7000, 3000]), 4000, { a: 1, b: 2, c: 2, d: 4 }).byUid, { a: 2800, b: 600, c: 600, d: 0 });
  // Everyone tied: the whole pot split evenly.
  assert.deepEqual(R.computeBattlePayouts(ffaB(['a', 'b', 'c'], [10000]), 3000, { a: 1, b: 1, c: 1 }).byUid, { a: 1000, b: 1000, c: 1000 });

  // Rounding: $1 × 7 players, 33.33 / 33.33 / 33.34 → 233.31, 233.31, 233.38 → 233 each, 1¢ left to 1st.
  const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const r = R.computeBattlePayouts(ffaB(seven, [3333, 3333, 3334]), 700, Object.fromEntries(seven.map((u, i) => [u, i + 1])));
  assert.deepEqual([r.byUid.a, r.byUid.b, r.byUid.c], [234, 233, 233]);
  assert.equal(Object.values(r.byUid).reduce((s, v) => s + v, 0), 700, 'the whole pot is paid');
  assert.equal(r.leftoverTo, 'a');
  // Three-way tie for 1st of $1 × 3 at 100%: 100 each, nothing left over.
  assert.deepEqual(R.computeBattlePayouts(ffaB(['a', 'b', 'c'], [10000]), 300, { a: 1, b: 1, c: 1 }).byUid, { a: 100, b: 100, c: 100 });
  // Two-way tie at 100% of an odd pot: 50.5 → 50 each, 1¢ to the first of the tied winners.
  assert.deepEqual(R.computeBattlePayouts(ffaB(['a', 'b', 'c'], [10000]), 101, { a: 2, b: 1, c: 1 }).byUid, { a: 0, b: 51, c: 50 });

  // Teams: the team's share split evenly among its members; uneven teams.
  const teams = {
    format: 'teams',
    payoutBps: [10000],
    teams: [{ id: 't1', name: 'Red' }, { id: 't2', name: 'Blue' }],
    participants: [
      { uid: 'a', team: 't1' }, { uid: 'b', team: 't1' }, { uid: 'c', team: 't1' },
      { uid: 'd', team: 't2' }, { uid: 'e', team: 't2' },
    ],
  };
  const t = R.computeBattlePayouts(teams, 500, { t1: 1, t2: 2 });
  // $5 to Red's 3 players: 166.67 → 166 each, the 2¢ left over to the first of them.
  assert.deepEqual(t.byUid, { a: 168, b: 166, c: 166, d: 0, e: 0 });
  assert.equal(Object.values(t.byUid).reduce((s, v) => s + v, 0), 500);
  const t2 = R.computeBattlePayouts(teams, 500, { t1: 2, t2: 1 });
  assert.deepEqual(t2.byUid, { a: 0, b: 0, c: 0, d: 250, e: 250 });
});

test('validation: formats, team sizes, payout places and 100%', () => {
  const base = { title: 'Darts', description: '', format: 'ffa', stakeDollars: 5, payoutBps: [10000], players: [{ uid: 'will' }, { uid: 'mike' }] };
  assert.deepEqual(R.battleProblems(base, 'will'), []);
  assert.match(R.battleProblems({ ...base, players: [{ uid: 'will' }] }, 'will').join(' '), /1–7 invited/);
  assert.match(R.battleProblems({ ...base, players: UIDS.map((uid) => ({ uid })) }, 'will').join(' '), /1–7 invited/, '9 players is too many');
  assert.match(R.battleProblems({ ...base, players: [{ uid: 'mike' }, { uid: 'dan' }] }, 'will').join(' '), /own Battle/);
  assert.match(R.battleProblems({ ...base, payoutBps: [7000, 3000] }, 'will').join(' '), /at most 1 place/);
  assert.match(R.battleProblems({ ...base, payoutBps: [9000] }, 'will').join(' '), /exactly 100%/);
  assert.match(R.battleProblems({ ...base, stakeDollars: 2.5 }, 'will').join(' '), /whole dollars/);
  assert.match(R.battleProblems({ ...base, title: '' }, 'will').join(' '), /title/);
  const teams = { ...base, format: 'teams', teams: [{ id: 't1', name: 'Red' }, { id: 't2', name: 'Blue' }], players: [{ uid: 'will', team: 't1' }, { uid: 'mike', team: 't1' }, { uid: 'dan', team: 't2' }, { uid: 'ann', team: 't2' }] };
  assert.deepEqual(R.battleProblems(teams, 'will'), []);
  assert.match(R.battleProblems({ ...teams, players: teams.players.slice(0, 3) }, 'will').join(' '), /Blue needs 2–4/);
  assert.match(R.battleProblems({ ...teams, players: [...teams.players.slice(0, 3), { uid: 'ann', team: null }] }, 'will').join(' '), /on a team/);
  assert.match(R.battleProblems({ ...teams, teams: [{ id: 't1', name: 'Red' }] }, 'will').join(' '), /2–4 teams/);
  assert.equal(R.percentToBps('33.33'), 3333);
  assert.equal(R.percentToBps('100'), 10000);
  assert.equal(R.percentToBps('33.333'), null);
  assert.equal(R.percentToBps('0'), null);
});

// ---------- create, accept, go live ----------

test('create takes the creator’s stake once (double tap); invites wait; everyone accepting makes it live', async () => {
  const requestId = rid();
  const id = await ffa(['will', 'mike', 'dan'], { stake: 10, requestId });
  const again = await B.createBattle(caller('will'), { clientRequestId: requestId, title: 'Golf', description: 'Nine holes', format: 'ffa', stakeDollars: 10, payoutBps: [10000], players: [{ uid: 'will' }, { uid: 'mike' }, { uid: 'dan' }] }, { now: T0 });
  assert.equal(again.duplicate, true);
  assert.equal(again.battleId, id);
  assert.equal(wallet('will'), START - 1000, 'stake taken once');
  const b = battle(id);
  assert.equal(b.status, 'pending');
  assert.deepEqual(b.participantUids, ['will', 'mike', 'dan'], 'uids array for the array-contains query the rules allow');
  assert.deepEqual(b.participants.map((p) => [p.uid, p.status]), [['will', 'accepted'], ['mike', 'invited'], ['dan', 'invited']]);
  assert.equal(b.potCents, 3000);
  assert.equal(fake.get(`ledger/bstake_${id}_will_1`).type, 'battle_stake');

  const r1 = await B.acceptBattle(caller('mike'), { battleId: id }, { now: later(H) });
  assert.equal(r1.live, false);
  assert.equal(r1.balanceCents, START - 1000);
  assert.equal((await B.acceptBattle(caller('mike'), { battleId: id }, { now: later(H) })).duplicate, true, 'double tap');
  assert.equal(wallet('mike'), START - 1000, 'charged once');
  const r2 = await B.acceptBattle(caller('dan'), { battleId: id }, { now: later(2 * H) });
  assert.equal(r2.live, true);
  assert.equal(battle(id).status, 'live');
  await err(B.acceptBattle(caller('ann'), { battleId: id }, { now: later(2 * H) }), 'NOT_IN_BATTLE');
  assert.deepEqual(fake.get('users/mike').stats, { won: 3, lost: 2 }, 'win rate untouched');
});

test('stakes need the money: create and accept refuse a short wallet', async () => {
  fake.write('users/mike', { ...fake.get('users/mike'), balanceCents: 500 });
  await err(ffa(['mike', 'will'], { stake: 10 }), 'INSUFFICIENT_BALANCE');
  const id = await ffa(['will', 'mike'], { stake: 10 });
  await err(B.acceptBattle(caller('mike'), { battleId: id }, { now: T0 }), 'INSUFFICIENT_BALANCE');
  assert.equal(wallet('mike'), 500);
  assert.equal(battle(id).status, 'pending');
});

test('a decline cancels the Battle and refunds every stake taken; creator cancel works only before live', async () => {
  const id = await ffa(['will', 'mike', 'dan']);
  await B.acceptBattle(caller('mike'), { battleId: id }, { now: T0 });
  await B.declineBattle(caller('dan'), { battleId: id }, { now: T0 });
  const b = battle(id);
  assert.equal(b.status, 'cancelled');
  assert.match(b.cancelReason, /Dan declined/);
  assert.deepEqual([wallet('will'), wallet('mike'), wallet('dan')], [START, START, START]);
  assert.equal(fake.get(`ledger/brefund_${id}_will_1`).type, 'battle_refund');
  await err(B.acceptBattle(caller('mike'), { battleId: id }, { now: T0 }), 'BATTLE_CLOSED');

  const id2 = await ffa(['will', 'mike']);
  await err(B.cancelBattle(caller('mike'), { battleId: id2 }, { now: T0 }), 'NOT_CREATOR');
  await B.cancelBattle(caller('will'), { battleId: id2 }, { now: T0 });
  assert.equal(battle(id2).status, 'cancelled');
  assert.equal(wallet('will'), START);
  assert.equal((await B.cancelBattle(caller('will'), { battleId: id2 }, { now: T0 })).duplicate, true);

  const id3 = await ffa(['will', 'mike']);
  await acceptAll(id3, ['mike']);
  await err(B.cancelBattle(caller('will'), { battleId: id3 }, { now: T0 }), 'BATTLE_LIVE');
});

test('48 hours without everyone accepting: cancelled and refunded (on the next action, or by the settlement sweep)', async () => {
  const id = await ffa(['will', 'mike', 'dan']);
  await B.acceptBattle(caller('mike'), { battleId: id }, { now: later(47 * H) });
  await err(B.acceptBattle(caller('dan'), { battleId: id }, { now: later(48 * H) }), 'BATTLE_EXPIRED');
  assert.equal(battle(id).status, 'cancelled');
  assert.deepEqual([wallet('will'), wallet('mike'), wallet('dan')], [START, START, START]);

  const id2 = await ffa(['will', 'ann']);
  const id3 = await ffa(['will', 'bo'], { now: later(10 * H) });
  assert.equal(await B.sweepExpiredBattles({ now: later(49 * H) }), 1, 'only the one past 48 h');
  assert.equal(battle(id2).status, 'cancelled');
  assert.equal(battle(id3).status, 'pending');
  assert.equal(await B.sweepExpiredBattles({ now: later(49 * H) }), 0, 'twice = once');
  assert.equal(wallet('will'), START - 1000, 'only id3’s stake still held');
});

// ---------- result and payout ----------

test('the creator’s result pays out at once (ties split), once; only the creator, only when live', async () => {
  const uids = ['will', 'mike', 'dan', 'ann'];
  const id = await ffa(uids, { stake: 10, payout: [7000, 3000] });
  await err(B.setBattleResult(caller('will'), { battleId: id, places: { will: 1, mike: 2, dan: 3, ann: 4 } }, { now: T0 }), 'NOT_LIVE');
  await acceptAll(id, ['mike', 'dan', 'ann']);
  await err(B.setBattleResult(caller('mike'), { battleId: id, places: { will: 1, mike: 2, dan: 3, ann: 4 } }, { now: T0 }), 'NOT_CREATOR');
  await err(B.setBattleResult(caller('will'), { battleId: id, places: { will: 1, mike: 2 } }, { now: T0 }), 'BAD_RESULT');
  // Mike and Dan tie for 1st: they split 70% + 30% of $40 → $20 each.
  const res = await B.setBattleResult(caller('will'), { battleId: id, places: { will: 3, mike: 1, dan: 1, ann: 4 } }, { now: later(H) });
  assert.deepEqual(res.payouts, { will: 0, mike: 2000, dan: 2000, ann: 0 });
  assert.deepEqual([wallet('will'), wallet('mike'), wallet('dan'), wallet('ann')], [START - 1000, START + 1000, START + 1000, START - 1000]);
  const b = battle(id);
  assert.equal(b.status, 'settled');
  assert.deepEqual(b.credited, { will: 0, mike: 2000, dan: 2000, ann: 0 });
  assert.equal(fake.get(`ledger/bpay_${id}_mike`).type, 'battle_payout');
  assert.equal(battleNet(id), 0, 'the whole pot went back out');
  await err(B.setBattleResult(caller('will'), { battleId: id, places: { will: 1, mike: 2, dan: 3, ann: 4 } }, { now: later(H) }), 'ALREADY_SETTLED');
  assert.deepEqual(fake.get('users/mike').stats, { won: 3, lost: 2 }, 'Battles never count toward win rate');
  assert.equal(groupShopPurchases(ledger(), []).totalCount, 0, 'never in Shop purchases');
});

test('teams: the winning team’s share split evenly among its members', async () => {
  const res = await B.createBattle(caller('will'), {
    clientRequestId: rid(),
    title: 'Cornhole',
    description: '',
    format: 'teams',
    stakeDollars: 5,
    payoutBps: [10000],
    teams: [{ id: 't1', name: 'Red' }, { id: 't2', name: 'Blue' }],
    players: [{ uid: 'will', team: 't1' }, { uid: 'mike', team: 't1' }, { uid: 'dan', team: 't2' }, { uid: 'ann', team: 't2' }, { uid: 'bo', team: 't2' }],
  }, { now: T0 });
  const id = res.battleId;
  await acceptAll(id, ['mike', 'dan', 'ann', 'bo']);
  await err(B.setBattleResult(caller('will'), { battleId: id, places: { will: 1, mike: 2 } }, { now: T0 }), 'BAD_RESULT');
  const out = await B.setBattleResult(caller('will'), { battleId: id, places: { t1: 2, t2: 1 } }, { now: T0 });
  // Pot $25 to Blue's 3 players: 833.33 → 833 each, 1¢ to the first of them.
  assert.deepEqual(out.payouts, { will: 0, mike: 0, dan: 834, ann: 833, bo: 833 });
  assert.equal(battleNet(id), 0);
});

test('disputes: any player, with a note, within 48 h of the result; flagged for the admin', async () => {
  const id = await ffa(['will', 'mike']);
  await acceptAll(id, ['mike']);
  await err(B.disputeBattle(caller('mike'), { battleId: id, note: 'I won' }, { now: T0 }), 'NO_RESULT');
  await B.setBattleResult(caller('will'), { battleId: id, places: { will: 1, mike: 2 } }, { now: T0 });
  await err(B.disputeBattle(caller('mike'), { battleId: id, note: '' }, { now: T0 }), 'BAD_NOTE');
  await err(B.disputeBattle(caller('ann'), { battleId: id, note: 'x' }, { now: T0 }), 'NOT_IN_BATTLE');
  await B.disputeBattle(caller('mike'), { battleId: id, note: 'I won by two strokes' }, { now: later(47 * H) });
  const b = battle(id);
  assert.equal(b.disputed, true);
  assert.deepEqual(b.disputes.map((d) => [d.uid, d.note]), [['mike', 'I won by two strokes']]);
  assert.equal((await B.disputeBattle(caller('mike'), { battleId: id, note: 'again' }, { now: later(47 * H) })).duplicate, true);
  await err(B.disputeBattle(caller('will'), { battleId: id, note: 'late' }, { now: later(49 * H) }), 'DISPUTE_CLOSED');
});

// ---------- admin ----------

test('admin changes the result: only the differences move (admin_regrade), a wallet may go below $0', async () => {
  const id = await ffa(['will', 'mike'], { stake: 50 });
  await acceptAll(id, ['mike']);
  await B.setBattleResult(caller('will'), { battleId: id, places: { will: 1, mike: 2 } }, { now: T0 });
  await B.disputeBattle(caller('mike'), { battleId: id, note: 'Will cheated' }, { now: T0 });
  // Will spends his winnings down to $5.
  fake.write('users/will', { ...fake.get('users/will'), balanceCents: 500 });

  const preview = await B.adminSetBattleResult({ battleId: id, places: { will: 2, mike: 1 } }, admin, { now: later(H) });
  assert.equal(preview.preview, true);
  const byUid = Object.fromEntries(preview.players.map((p) => [p.uid, p]));
  assert.deepEqual([byUid.will.deltaCents, byUid.will.balanceAfterCents], [-10000, 500 - 10000], 'shown going negative (red on the admin page)');
  assert.equal(byUid.mike.deltaCents, 10000);
  assert.equal(battle(id).credited.will, 10000, 'preview changes nothing');

  await err(B.adminSetBattleResult({ battleId: id, places: { will: 2, mike: 1 }, confirm: true, expectedVersion: preview.version + 1 }, admin, { now: later(H) }), 'BATTLE_CHANGED');
  const done = await B.adminSetBattleResult({ battleId: id, places: { will: 2, mike: 1 }, confirm: true, expectedVersion: preview.version }, admin, { now: later(H) });
  assert.equal(done.ok, true);
  assert.equal(wallet('will'), 500 - 10000, 'allowed below $0');
  assert.equal(wallet('mike'), START - 5000 + 10000);
  const b = battle(id);
  assert.deepEqual(b.credited, { will: 0, mike: 10000 });
  assert.equal(b.disputed, false, 'disputes resolved');
  assert.equal(b.edits.at(-1).by, 'boss');
  assert.match(b.edits.at(-1).what, /Result changed/);
  const regrades = ledger().filter((e) => e.type === 'admin_regrade' && e.battleId === id);
  assert.deepEqual(regrades.map((e) => [e.uid, e.amountCents]).sort(), [['mike', 10000], ['will', -10000]]);
  assert.equal(battleNet(id), 0);
});

test('admin payout change before live: accepted players are notified and may withdraw (refund) or keep their spot', async () => {
  const id = await ffa(['will', 'mike', 'dan'], { stake: 10, payout: [10000] });
  await B.acceptBattle(caller('mike'), { battleId: id }, { now: T0 });
  await err(B.withdrawBattle(caller('mike'), { battleId: id }, { now: T0 }), 'CANT_WITHDRAW');
  const preview = await B.adminSetBattlePayout({ battleId: id, payoutBps: [7000, 3000] }, admin, { now: T0 });
  await B.adminSetBattlePayout({ battleId: id, payoutBps: [7000, 3000], confirm: true, expectedVersion: preview.version }, admin, { now: T0 });
  let b = battle(id);
  assert.deepEqual(b.payoutBps, [7000, 3000]);
  assert.deepEqual(b.participants.map((p) => [p.uid, p.notice]), [['will', 'payoutChanged'], ['mike', 'payoutChanged'], ['dan', null]]);
  await err(B.adminSetBattlePayout({ battleId: id, payoutBps: [6000, 4000, 0] }, admin, { now: T0 }), 'BAD_PAYOUT');

  await B.keepBattle(caller('will'), { battleId: id }, { now: T0 });
  const w = await B.withdrawBattle(caller('mike'), { battleId: id }, { now: T0 });
  assert.equal(w.balanceCents, START, 'full refund');
  b = battle(id);
  assert.deepEqual(b.participants.map((p) => [p.uid, p.status, p.notice]), [['will', 'accepted', null], ['mike', 'invited', null], ['dan', 'invited', null]]);
  // Mike accepts again under the new payout: a second stake with its own ledger id.
  await B.acceptBattle(caller('mike'), { battleId: id }, { now: T0 });
  assert.ok(fake.get(`ledger/bstake_${id}_mike_2`));
  assert.ok(fake.get(`ledger/brefund_${id}_mike_1`));
  assert.equal(wallet('mike'), START - 1000);
  await B.acceptBattle(caller('dan'), { battleId: id }, { now: T0 });
  assert.equal(battle(id).status, 'live');
  await B.setBattleResult(caller('will'), { battleId: id, places: { will: 3, mike: 1, dan: 2 } }, { now: T0 });
  assert.deepEqual([wallet('will'), wallet('mike'), wallet('dan')], [START - 1000, START - 1000 + 2100, START - 1000 + 900]);
  assert.equal(battleNet(id), 0);
});

test('admin payout change after the payout: recomputed from the same places, only differences move', async () => {
  const id = await ffa(['will', 'mike', 'dan'], { stake: 10, payout: [10000] });
  await acceptAll(id, ['mike', 'dan']);
  await B.setBattleResult(caller('will'), { battleId: id, places: { will: 1, mike: 2, dan: 3 } }, { now: T0 });
  const p = await B.adminSetBattlePayout({ battleId: id, payoutBps: [5000, 5000] }, admin, { now: T0 });
  await B.adminSetBattlePayout({ battleId: id, payoutBps: [5000, 5000], confirm: true, expectedVersion: p.version }, admin, { now: T0 });
  assert.deepEqual(battle(id).credited, { will: 1500, mike: 1500, dan: 0 });
  assert.deepEqual([wallet('will'), wallet('mike'), wallet('dan')], [START + 500, START + 500, START - 1000]);
  assert.equal(battleNet(id), 0);
});

test('admin void: everyone ends up exactly even, before or after the payout', async () => {
  const id = await ffa(['will', 'mike', 'dan'], { stake: 10 });
  await acceptAll(id, ['mike', 'dan']);
  await B.setBattleResult(caller('will'), { battleId: id, places: { will: 1, mike: 2, dan: 3 } }, { now: T0 });
  const v = await B.adminVoidBattle({ battleId: id }, admin, { now: T0 });
  assert.deepEqual(v.players.map((x) => [x.uid, x.deltaCents]), [['will', -2000], ['mike', 1000], ['dan', 1000]]);
  await B.adminVoidBattle({ battleId: id, confirm: true, expectedVersion: v.version }, admin, { now: T0 });
  assert.equal(battle(id).status, 'void');
  assert.deepEqual([wallet('will'), wallet('mike'), wallet('dan')], [START, START, START]);
  await err(B.adminVoidBattle({ battleId: id }, admin, { now: T0 }), 'ALREADY_VOID');

  const pending = await ffa(['will', 'ann'], { stake: 10 });
  const pv = await B.adminVoidBattle({ battleId: pending }, admin, { now: T0 });
  await B.adminVoidBattle({ battleId: pending, confirm: true, expectedVersion: pv.version }, admin, { now: T0 });
  assert.equal(wallet('will'), START);
  assert.equal(fake.get(`ledger/brefund_${pending}_will_1`).type, 'battle_refund');
});

test('pay once: a result and an admin void racing, or two accepts racing, never double-pay', async () => {
  const id = await ffa(['will', 'mike', 'dan'], { stake: 10 });
  await Promise.all([
    B.acceptBattle(caller('mike'), { battleId: id }, { now: T0 }),
    B.acceptBattle(caller('mike'), { battleId: id }, { now: T0 }),
    B.acceptBattle(caller('dan'), { battleId: id }, { now: T0 }),
  ]);
  assert.equal(wallet('mike'), START - 1000);
  assert.equal(battle(id).status, 'live');
  const preview = await B.adminVoidBattle({ battleId: id }, admin, { now: T0 });
  const [result, voided] = await Promise.allSettled([
    B.setBattleResult(caller('will'), { battleId: id, places: { will: 1, mike: 2, dan: 3 } }, { now: T0 }),
    B.adminVoidBattle({ battleId: id, confirm: true, expectedVersion: preview.version }, admin, { now: T0 }),
  ]);
  assert.ok((result.status === 'fulfilled') !== (voided.status === 'fulfilled'), 'exactly one of them goes through');
  const b = battle(id);
  if (b.status === 'void') assert.deepEqual([wallet('will'), wallet('mike'), wallet('dan')], [START, START, START]);
  else assert.deepEqual([wallet('will'), wallet('mike'), wallet('dan')], [START + 2000, START - 1000, START - 1000]);
  assert.equal(battleNet(id), 0);
});

test('/api/battles: routes actions, needs a signed-in player', async () => {
  const call = async (body, token = 'will-token') => {
    const res = { code: 0, body: null, headers: {}, headersSent: false, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } };
    await handler({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body }, res);
    return res;
  };
  assert.equal((await call({ action: 'create' }, 'nope-token')).code, 401);
  assert.equal((await call({ action: 'explode' })).body.error.code, 'UNKNOWN_ACTION');
  const created = await call({ action: 'create', clientRequestId: rid(), title: 'Chess', description: '', format: 'ffa', stakeDollars: 3, payoutBps: [10000], players: [{ uid: 'will' }, { uid: 'mike' }] });
  assert.equal(created.code, 200, JSON.stringify(created.body));
  assert.equal(wallet('will'), START - 300);
  const bad = await call({ action: 'create', clientRequestId: rid(), title: 'Chess', format: 'ffa', stakeDollars: 3, payoutBps: [5000], players: [{ uid: 'will' }, { uid: 'mike' }] });
  assert.equal(bad.code, 400);
  assert.match(bad.body.error.message, /100%/);
});
