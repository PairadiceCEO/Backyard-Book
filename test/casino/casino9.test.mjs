// npm run test:casino  (or: node --experimental-test-module-mocks --test test/casino/casino9.test.mjs)
// 0.24.0: side bets at the real engines against the in-memory Firestore. Blackjack 21+3 (charged with the bet, settled right
// after the opening deal, before insurance or play, one deterministic payout entry); Baccarat's six side spots (charged with
// the bet, paid with the coup in the seat's one payout entry). A side bet needs a main bet; the $1,000,000 ceiling applies per
// spot; the wallet always equals the start plus the ledger.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFakeDb } from './fakeFirestore.mjs';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;
const fake = makeFakeDb();
mock.module(url('server/firebaseAdmin.js'), {
  namedExports: { adminDb: () => fake.db, adminAuth: () => ({}), normalizePrivateKey: (k) => k },
});

const { handleTableAction } = await import(url('server/casino/tables.js'));
const C = await import(url('shared/casino/cards.js'));
const K = await import(url('shared/casino/constants.js'));
const S = await import(url('shared/casino/sideBets.js'));

const T0 = 1_800_000_000_000;
const UIDS = ['p1', 'p2'];
const START = 100_000; // $1,000
function seed(balanceCents = START) {
  fake.reset();
  for (const uid of UIDS) fake.write(`users/${uid}`, { username: uid, displayName: uid.toUpperCase(), balanceCents, stats: { won: 0, lost: 0 }, disabled: false });
}
const callerOf = (uid) => ({ uid, token: {}, user: fake.get(`users/${uid}`) });
let rng = (max) => Math.floor(Math.random() * max);
const act = (game, uid, action, fields = {}, now = T0) => handleTableAction(callerOf(uid), { game, action, ...fields }, { now, randomInt: (m) => rng(m) });
let n = 0;
const rid = () => `c9-req-${String(++n).padStart(6, '0')}`;
const wallet = (uid) => fake.get(`users/${uid}`).balanceCents;
const table = (game) => fake.get(`casinoTables/${game}`);
const ledger = () => [...fake.store].filter(([k]) => k.startsWith('ledger/')).map(([k, v]) => ({ id: k.slice(7), ...v }));
const err = async (p, code, message) => {
  await assert.rejects(p, (e) => {
    assert.equal(e.code, code, e.message);
    if (message) assert.equal(e.message, message);
    return true;
  });
};
function moneyAddsUp(start = START) {
  for (const uid of UIDS) {
    const total = ledger().filter((e) => e.uid === uid).reduce((s, e) => s + e.amountCents, 0);
    assert.equal(start + total, wallet(uid), `${uid}: wallet = start + ledger`);
  }
}

// Blackjack: these cards on top of the 6-deck shoe, drawn in order (one seat: card 1, dealer up, card 2, hole card).
function stackBlackjack(cards) {
  const used = {};
  const ids = cards.map((c) => {
    used[c] = (used[c] ?? -1) + 1;
    return `${c}${used[c]}`;
  });
  const rest = C.buildShoe(6).filter((c) => !ids.includes(c));
  fake.write('casinoTables/blackjack/private/shoe', { cards: [...ids, ...rest], dealt: 0, shuffles: 0, holeCard: null });
  rng = () => 0;
}
// Baccarat: these cards on top of the 8-deck shoe (Player, Banker, Player, Banker, Player's third, Banker's third).
function stackBaccarat(ranks) {
  const ids = ranks.map((r, i) => `${r}${'SHDC'[i % 4]}${i % 8}`);
  const rest = C.buildShoe(8).filter((c) => !ids.includes(c));
  fake.write('casinoTables/baccarat/private/shoe', { cards: [...ids, ...rest], dealt: 0, shuffles: 0 });
  rng = () => 0;
}

// ================= Blackjack 21+3 =================
test('21+3: charged with the bet, settled right after the opening deal (before play), paid once with its own ledger id', async () => {
  seed();
  stackBlackjack(['9H', 'JH', 'TH', '5C']); // 9♥ 10♥ + dealer J♥ = straight flush; hole 5 (no dealer blackjack)
  await act('blackjack', 'p1', 'sit', { seat: 0 });
  const reply = await act('blackjack', 'p1', 'bet', { seat: 0, amount: 10, side: 5, requestId: rid() });
  assert.deepEqual([reply.betCents, reply.sideCents], [1000, 500]);
  assert.equal(wallet('p1'), START - 1500, 'main + side charged together');
  await act('blackjack', 'p1', 'confirm', { seat: 0 });
  const t = table('blackjack');
  assert.equal(t.phase, 'playing', 'play is still going on');
  const seat = t.seats[0];
  assert.equal(seat.side.hand, 'straightFlush');
  assert.equal(seat.side.returnCents, 500 * 41);
  assert.deepEqual(seat.side.cards.map((c) => c.slice(0, 2)), ['9H', 'TH', 'JH']);
  const pay = ledger().find((e) => e.id === `cpay_blackjack_${t.roundId}_p1_s0_213`);
  assert.equal(pay?.amountCents, 20_500, '21+3 paid at once, with its own id');
  assert.equal(wallet('p1'), START - 1500 + 20_500);
  // Play the hand out: the seat's result counts the side bet too.
  await act('blackjack', 'p1', 'stand', { seat: 0, hand: 0, actionSeq: table('blackjack').seats[0].hands[0].seq });
  const done = table('blackjack').seats[0];
  assert.equal(done.result.stakeCents, 1500);
  assert.equal(done.result.returnCents, 20_500 + (done.hands[0].outcome === 'win' ? 2000 : done.hands[0].outcome === 'push' ? 1000 : 0));
  moneyAddsUp();
});

test('21+3 is settled before insurance: dealer Ace up, Q♠ K♠ A♠ straight flush, dealer blackjack still ends the hand', async () => {
  seed();
  stackBlackjack(['QS', 'AS', 'KS', 'TD']); // dealer A + 10 = blackjack
  await act('blackjack', 'p1', 'sit', { seat: 0 });
  await act('blackjack', 'p1', 'bet', { seat: 0, amount: 10, side: 2, requestId: rid() });
  await act('blackjack', 'p1', 'confirm', { seat: 0 });
  let t = table('blackjack');
  assert.equal(t.phase, 'insurance');
  assert.deepEqual([t.seats[0].side.hand, t.seats[0].side.returnCents], ['straightFlush', 200 * 41], 'shown while insurance is open');
  await act('blackjack', 'p1', 'insurance', { seat: 0, amountCents: 0 });
  t = table('blackjack');
  assert.equal(t.finish, 'dealerBlackjack');
  assert.equal(t.seats[0].result.netCents, 200 * 40 - 1000, 'side won $80, main lost $10');
  moneyAddsUp();
});

test('21+3 losing hand: no payout entry; K-A-2 is not a straight; two seats settle separately', async () => {
  seed();
  // Seat 0: K♣ 2♦ + dealer A♥ (K-A-2: nothing). Seat 1: 7♠ 7♣ + A♥ (nothing). Deal: s0, s1, dealer up, s0, s1, hole.
  stackBlackjack(['KC', '7S', 'AH', '2D', '7C', '9S']);
  await act('blackjack', 'p1', 'sit', { seat: 0 });
  await act('blackjack', 'p2', 'sit', { seat: 1 });
  await act('blackjack', 'p1', 'bet', { seat: 0, amount: 5, side: 5, requestId: rid() });
  await act('blackjack', 'p2', 'bet', { seat: 1, amount: 5, side: 1, requestId: rid() });
  await act('blackjack', 'p1', 'confirm', { seat: 0 });
  await act('blackjack', 'p2', 'confirm', { seat: 1 });
  const t = table('blackjack');
  assert.deepEqual([t.seats[0].side.hand, t.seats[0].side.returnCents], [null, 0]);
  assert.deepEqual([t.seats[1].side.hand, t.seats[1].side.returnCents], [null, 0]);
  assert.equal(ledger().filter((e) => e.id.endsWith('_213')).length, 0, 'nothing paid');
  moneyAddsUp();
});

test('21+3 needs a main bet; it can be lowered or cleared; the ceiling applies to it; a retry is applied once', async () => {
  seed(300_000_000);
  await act('blackjack', 'p1', 'sit', { seat: 0 });
  await err(act('blackjack', 'p1', 'bet', { seat: 0, amount: 0, side: 5, requestId: rid() }), 'SIDE_NEEDS_MAIN', S.SIDE_BET_NEEDS_MAIN);
  await act('blackjack', 'p1', 'bet', { seat: 0, amount: 10, side: 5, requestId: rid() });
  await err(act('blackjack', 'p1', 'bet', { seat: 0, amount: 0, side: 5, requestId: rid() }), 'SIDE_NEEDS_MAIN', S.SIDE_BET_KEEPS_MAIN);
  // Leaving `side` out keeps it (an older page that only sends the main bet).
  await act('blackjack', 'p1', 'bet', { seat: 0, amount: 20, requestId: rid() });
  assert.deepEqual([table('blackjack').seats[0].betCents, table('blackjack').seats[0].sideCents], [2000, 500]);
  const same = rid();
  await act('blackjack', 'p1', 'bet', { seat: 0, amount: 20, side: 7, requestId: same });
  assert.equal((await act('blackjack', 'p1', 'bet', { seat: 0, amount: 20, side: 7, requestId: same })).duplicate, true);
  await act('blackjack', 'p1', 'bet', { seat: 0, amount: 20, side: 0, requestId: rid() });
  assert.equal(table('blackjack').seats[0].sideCents, 0);
  assert.ok(ledger().some((e) => e.type === 'casino_refund' && e.amountCents === 700), 'clearing 21+3 refunded it');
  await err(act('blackjack', 'p1', 'bet', { seat: 0, amount: 20, side: 1_000_001, requestId: rid() }), 'BET_TOO_LARGE');
  await act('blackjack', 'p1', 'bet', { seat: 0, amount: 1_000_000, side: 1_000_000, requestId: rid() });
  assert.equal(table('blackjack').seats[0].sideCents, 100_000_000, 'the ceiling is per bet: $1M main + $1M side');
  moneyAddsUp(300_000_000);
});

// ================= Baccarat side bets =================
test('Baccarat: side spots charged with the bet and paid with the coup in the seat\'s one payout entry', async () => {
  seed();
  stackBaccarat(['K', 'K', 'Q', 'J', '9', 'K']); // Player 3-card 9 beats Banker 0: non-natural win by 9
  await act('baccarat', 'p1', 'sit', { seat: 0 });
  await act('baccarat', 'p1', 'bet', { seat: 0, player: 10, banker: 0, tie: 0, dragonPlayer: 5, dragonBanker: 1, heavenly9: 2, fortune7: 3, golden8: 1, blazing7: 1, requestId: rid() });
  assert.equal(wallet('p1'), START - 2300);
  assert.deepEqual(table('baccarat').seats[0].bets, { player: 1000, banker: 0, tie: 0, dragonPlayer: 500, dragonBanker: 100, fortune7: 300, heavenly9: 200, golden8: 100, blazing7: 100 });
  await act('baccarat', 'p1', 'confirm', { seat: 0 });
  const t = table('baccarat');
  assert.equal(t.coup.winner, 'player');
  const r = t.seats[0].result;
  assert.deepEqual(r.sides, {
    dragonPlayer: { stakeCents: 500, returnCents: 500 * 31 },
    dragonBanker: { stakeCents: 100, returnCents: 0 },
    fortune7: { stakeCents: 300, returnCents: 0 },
    heavenly9: { stakeCents: 200, returnCents: 200 * 11 },
    golden8: { stakeCents: 100, returnCents: 0 },
    blazing7: { stakeCents: 100, returnCents: 0 },
  });
  assert.deepEqual([r.stakeCents, r.returnCents], [2300, 2000 + 15_500 + 2200]);
  const pays = ledger().filter((e) => e.type === 'casino_payout' && e.uid === 'p1');
  assert.deepEqual(pays.map((e) => [e.id, e.amountCents]), [[`cpay_baccarat_${t.roundId}_p1_s0_end`, 19_700]]);
  assert.match(pays[0].note, /Dragon Bonus Player \$5/);
  moneyAddsUp();
});

test('Baccarat: Fortune 7 doesn\'t change the Banker bet; Blazing 7s two-card tie; Dragon natural tie pushes', async () => {
  seed();
  stackBaccarat(['K', '2', 'Q', 'K', '5', '5']); // Banker 3-card 7 beats 5
  await act('baccarat', 'p1', 'sit', { seat: 0 });
  await act('baccarat', 'p1', 'bet', { seat: 0, player: 0, banker: 20, tie: 0, fortune7: 1, requestId: rid() });
  await act('baccarat', 'p1', 'confirm', { seat: 0 });
  let r = table('baccarat').seats[0].result;
  assert.deepEqual([r.returnCents, r.sides.fortune7.returnCents], [2000 + 1900 + 4100, 4100], 'Banker still pays 0.95:1; Fortune 7 40:1');
  // Next coup: both two-card 7s (a tie).
  await act('baccarat', 'p1', 'tick', {}, table('baccarat').deadline + 1);
  stackBaccarat(['3', '2', '4', '5']);
  await act('baccarat', 'p1', 'bet', { seat: 0, player: 0, banker: 0, tie: 1, blazing7: 2, dragonBanker: 3, requestId: rid() }, table('baccarat').deadline ?? T0 + 10_000);
  await act('baccarat', 'p1', 'confirm', { seat: 0 }, T0 + 10_000);
  r = table('baccarat').seats[0].result;
  assert.equal(table('baccarat').coup.winner, 'tie');
  assert.deepEqual([r.sides.blazing7.returnCents, r.sides.dragonBanker.returnCents], [200 * 41, 0], 'non-natural tie: Dragon loses');
  moneyAddsUp();
});

test('Baccarat side bets need a main bet; a zero side spot is not stored; the ceiling applies per spot', async () => {
  seed(300_000_000);
  await act('baccarat', 'p1', 'sit', { seat: 0 });
  await err(act('baccarat', 'p1', 'bet', { seat: 0, player: 0, banker: 0, tie: 0, golden8: 5, requestId: rid() }), 'SIDE_NEEDS_MAIN', S.SIDE_BET_NEEDS_MAIN);
  await act('baccarat', 'p1', 'bet', { seat: 0, player: 5, banker: 0, tie: 0, golden8: 5, requestId: rid() });
  await err(act('baccarat', 'p1', 'bet', { seat: 0, player: 0, banker: 0, tie: 0, golden8: 5, requestId: rid() }), 'SIDE_NEEDS_MAIN', S.SIDE_BET_KEEPS_MAIN);
  await act('baccarat', 'p1', 'bet', { seat: 0, player: 5, banker: 0, tie: 0, golden8: 0, requestId: rid() });
  assert.deepEqual(table('baccarat').seats[0].bets, { player: 500, banker: 0, tie: 0 });
  await err(act('baccarat', 'p1', 'bet', { seat: 0, player: 5, banker: 0, tie: 0, blazing7: 1_000_001, requestId: rid() }), 'BET_TOO_LARGE', K.BET_CEILING_MESSAGE);
  moneyAddsUp(300_000_000);
});
