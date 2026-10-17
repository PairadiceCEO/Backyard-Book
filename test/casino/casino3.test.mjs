// npm run test:casino  (or: node --experimental-test-module-mocks test/casino/casino3.test.mjs)
// Casino phase 3: Blackjack (rules, scripted shoes, double-tap guards, hole card secrecy, money).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFakeDb } from './fakeFirestore.mjs';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;
const fake = makeFakeDb();
mock.module(url('server/firebaseAdmin.js'), {
  namedExports: {
    adminDb: () => fake.db,
    adminAuth: () => ({ async verifyIdToken() { throw new Error('unused'); } }),
    normalizePrivateKey: (k) => k,
  },
});

const BJ = await import(url('shared/casino/blackjack.js'));
const C = await import(url('shared/casino/cards.js'));
const { handleTableAction } = await import(url('server/casino/tables.js'));
const { groupShopPurchases } = await import(url('src/lib/shopHistory.js'));

const UIDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
const T0 = 1_800_000_000_000;
function seed(balanceCents = 10000) {
  fake.reset();
  for (const uid of UIDS) fake.write(`users/${uid}`, { username: uid, displayName: `P${uid.slice(1)}`, balanceCents, stats: { won: 2, lost: 3 }, disabled: false });
}
const callerOf = (uid) => ({ uid, token: {}, user: fake.get(`users/${uid}`) });
let rng = (max) => Math.floor(Math.random() * max);
const act = (uid, action, fields = {}, now = T0) => handleTableAction(callerOf(uid), { game: 'blackjack', action, ...fields }, { now, randomInt: (m) => rng(m) });
let reqNo = 0;
// chips: set this hand's bet (absolute, like stacking chips). bet: chips + Confirm (locks it in).
const chips = (uid, amount, now = T0, requestId = `bj-req-${String(++reqNo).padStart(6, '0')}`) => act(uid, 'bet', { amount, requestId }, now);
const bet = async (uid, amount, now = T0) => {
  await chips(uid, amount, now);
  return act(uid, 'confirm', {}, now);
};
const table = () => fake.get('casinoTables/blackjack');
const shoeDoc = () => fake.get('casinoTables/blackjack/private/shoe');
const wallet = (uid) => fake.get(`users/${uid}`).balanceCents;
const ledger = () => [...fake.store].filter(([k]) => k.startsWith('ledger/')).map(([k, v]) => ({ id: k.slice(7), ...v }));
const err = async (p, code) => { await assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); return true; }); };
const seatOf = (uid) => table().seats.findIndex((s) => s && s.uid === uid);
const handOf = (uid, h = 0) => table().seats[seatOf(uid)].hands[h];
const move = (uid, action, h = 0, now = T0, seq = handOf(uid, h).seq) => act(uid, action, { hand: h, actionSeq: seq }, now);

// Puts these cards on top of the shoe in this order ("AS", "KH", …; deck digits are added).
function stackShoe(cards, { dealt = 0, extra = true } = {}) {
  const used = {};
  const ids = cards.map((c) => { used[c] = (used[c] ?? -1) + 1; return `${c}${used[c]}`; });
  const rest = extra ? C.buildShoe(6).filter((c) => !ids.includes(c)) : [];
  fake.write('casinoTables/blackjack/private/shoe', { cards: [...ids, ...rest], dealt, shuffles: 0, holeCard: null });
  rng = () => 0;
  return ids;
}

// Nothing secret in the public doc, ever: no card still in the shoe, and no hole card while it's down.
function assertSecret(where) {
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
  for (const c of publicCards) assert.ok(!inShoe.has(c), `${where}: ${c} is public and still in the shoe`);
  if (pub.dealer?.holeDown) {
    assert.ok(shoe.holeCard, `${where}: hole card kept in private/shoe`);
    assert.ok(!JSON.stringify(pub).includes(shoe.holeCard), `${where}: hole card ${shoe.holeCard} leaked while face down`);
    assert.equal(pub.dealer.cards.length, 1, `${where}: only the up card is public`);
  }
  const all = [...shoe.cards, ...publicCards, ...(pub.dealer?.holeDown ? [shoe.holeCard] : [])];
  assert.equal(new Set(all).size, all.length, `${where}: a card is in two places`);
  assert.equal(shoe.cards.length + shoe.dealt, 312, `${where}: cards lost or invented`);
}

async function sitAll(uids) {
  for (const [i, uid] of uids.entries()) await act(uid, 'sit', { seat: i });
}

// ---------- pure rules ----------
test('hand values, soft totals, naturals, the dealer hitting soft 17, split and double rules, payouts in cents', () => {
  const v = (...cards) => BJ.handValue(cards.map((c) => `${c}0`));
  assert.deepEqual(v('A', '6'), { total: 17, soft: true });
  assert.deepEqual(v('A', '6', 'K'), { total: 17, soft: false });
  assert.deepEqual(v('A', 'A', '9'), { total: 21, soft: true });
  assert.deepEqual(v('A', 'A', 'A', 'K', '9'), { total: 22, soft: false });
  assert.equal(BJ.isBlackjack(['AS0', 'KH0']), true);
  assert.equal(BJ.isBlackjack(['AS0', 'KH0'], true), false, '21 after a split is not blackjack');
  assert.equal(BJ.isBlackjack(['7S0', '7H0', '7D0']), false);
  const hits = (...cards) => BJ.dealerHits(cards.map((c) => `${c}0`));
  assert.equal(hits('A', '6'), true, 'soft 17 hits');
  assert.equal(hits('5', 'A', 'A'), true, 'soft 17 again');
  assert.equal(hits('A', '7'), false);
  assert.equal(hits('T', '7'), false, 'hard 17 stands');
  assert.equal(hits('T', '6'), true);
  assert.equal(BJ.canSplit({ cards: ['KS0', 'QH0'] }, 1), true, 'two 10-value cards');
  assert.equal(BJ.canSplit({ cards: ['8S0', '8H0'] }, 1), true);
  assert.equal(BJ.canSplit({ cards: ['8S0', '9H0'] }, 1), false);
  assert.equal(BJ.canSplit({ cards: ['8S0', '8H0'] }, 2), false, 'one split per seat');
  assert.equal(BJ.canDouble({ cards: ['5S0', '6H0'] }), true);
  assert.equal(BJ.canDouble({ cards: ['5S0', '6H0', '2C0'] }), false);
  assert.equal(BJ.canDouble({ cards: ['AS0', '6H0'], splitAces: true }), false);
  assert.equal(BJ.naturalReturnCents(500), 1250, '$5 blackjack returns $12.50');
  assert.equal(BJ.naturalReturnCents(100), 250);
  assert.equal(BJ.naturalReturnCents(300), 750);
  assert.equal(BJ.naturalReturnCents(700), 1750);
  assert.equal(BJ.insuranceReturnCents(250), 750, 'insurance 2:1');
  assert.equal(BJ.maxInsuranceCents(500), 250);
  assert.equal(BJ.maxInsuranceCents(300), 150);
  assert.equal(BJ.dealerPeeks('AS0') && BJ.dealerPeeks('QS0') && !BJ.dealerPeeks('9S0'), true);
});

// ---------- a plain hand ----------
test('a full hand: everyone bet → dealt at once in seat order, hit, stand, dealer plays, paid', async () => {
  seed();
  await sitAll(['p1', 'p2']);
  // p1: T 6 (16), p2: 9 9 (18); dealer: 9 up, 7 hole (16) → hits a 5 → 21. p1 hits a 3 → 19.
  const ids = stackShoe(['TS', '9H', '9C', '6D', '9D', '7S', '3H', '5C']);
  await bet('p1', 5);
  assert.deepEqual([table().phase, table().deadline], ['betting', T0 + 15_000]);
  await bet('p2', 10);
  let t = table();
  assert.equal(t.phase, 'playing', 'everyone bet: dealt without waiting');
  assert.deepEqual(t.seats[0].hands[0].cards, [ids[0], ids[3]]);
  assert.deepEqual(t.seats[1].hands[0].cards, [ids[1], ids[4]]);
  assert.deepEqual(t.dealer, { cards: [ids[2]], holeDown: true });
  assert.equal(shoeDoc().holeCard, ids[5]);
  assert.deepEqual(t.lastDeal.cards.map((c) => c.to), ['0-0', '1-0', 'd', '0-0', '1-0', 'd'], 'dealt clockwise, dealer last');
  assert.deepEqual(t.turn, { seat: 0, hand: 0 });
  assertSecret('after deal');
  await err(move('p2', 'hit'), 'NOT_YOUR_TURN');
  await move('p1', 'hit');
  assert.deepEqual(handOf('p1').cards.length, 3);
  assert.equal(handOf('p1').seq, 1);
  assertSecret('after hit');
  await move('p1', 'stand');
  assert.deepEqual(table().turn, { seat: 1, hand: 0 });
  await move('p2', 'stand');
  t = table();
  assert.equal(t.phase, 'results');
  assert.deepEqual(t.dealer.cards, [ids[2], ids[5], ids[7]], 'hole card turned over, then a hit');
  assert.equal(t.dealer.holeDown, false);
  assert.equal(shoeDoc().holeCard, null);
  assert.deepEqual([handOf('p1').outcome, handOf('p2').outcome], ['lose', 'lose'], '19 and 18 lose to 21');
  assert.deepEqual([wallet('p1'), wallet('p2')], [9500, 9000]);
  assert.deepEqual(t.seats[0].result, { stakeCents: 500, returnCents: 0, netCents: -500 });
  assertSecret('results');
  assert.deepEqual(fake.get('users/p1').stats, { won: 2, lost: 3 }, 'win rate stays sportsbook-only');
  // Next hand opens after the results deadline.
  await act('p2', 'tick', {}, t.deadline);
  t = table();
  assert.deepEqual([t.phase, t.roundNo, t.dealer.cards.length, t.seats[0].hands.length, t.seats[0].betCents], ['betting', 2, 0, 0, 0]);
});

test('dealer beats nobody: win pays 1:1, push returns the bet, dealer busts', async () => {
  seed();
  await sitAll(['p1', 'p2', 'p3']);
  // p1 T 9 (19) · p2 T 7 (17) · p3 T 8 (18); dealer 7 up, T hole (17) → stands. 19 wins, 17 pushes, 18 wins.
  stackShoe(['TS', 'TH', 'TD', '7C', '9S', '7H', '8D', 'TC']);
  await bet('p1', 4);
  await bet('p2', 6);
  await bet('p3', 2);
  for (const uid of ['p1', 'p2', 'p3']) await move(uid, 'stand');
  assert.deepEqual(['p1', 'p2', 'p3'].map((u) => handOf(u).outcome), ['win', 'push', 'win']);
  assert.deepEqual(['p1', 'p2', 'p3'].map(wallet), [10400, 10000, 10200]);
  // Dealer bust: 6 up, T hole (16) → hits a T.
  seed();
  await sitAll(['p1']);
  stackShoe(['TS', '6H', '2D', 'TC', 'TH']);
  await bet('p1', 3);
  await move('p1', 'stand');
  assert.equal(handOf('p1').outcome, 'win');
  assert.equal(wallet('p1'), 10300);
});

test('dealer hits soft 17 and stands on hard 17', async () => {
  seed();
  await sitAll(['p1']);
  // p1 T 8 (18); dealer A up, 6 hole = soft 17 → must hit: 3 → 20.  (no insurance taken)
  stackShoe(['TS', 'AH', '8D', '6C', '3S']);
  await bet('p1', 5);
  assert.equal(table().phase, 'insurance');
  await act('p1', 'insurance', { amountCents: 0 });
  await move('p1', 'stand');
  assert.deepEqual(table().dealer.cards.map((c) => c[0]), ['A', '6', '3']);
  assert.equal(handOf('p1').outcome, 'lose');
  // Hard 17 (T 7) stands.
  seed();
  await sitAll(['p1']);
  stackShoe(['TS', '7H', '8D', 'TC', '3S']);
  await bet('p1', 5);
  await move('p1', 'stand');
  assert.deepEqual(table().dealer.cards.map((c) => c[0]), ['7', 'T']);
  assert.equal(handOf('p1').outcome, 'win');
});

// ---------- naturals and insurance ----------
test('dealer blackjack with insurance: insurance pays 2:1, a natural pushes, everything else loses at once', async () => {
  seed();
  await sitAll(['p1', 'p2', 'p3']);
  // p1 T 9 · p2 A K (natural) · p3 8 8; dealer A up, K hole = blackjack.
  const ids = stackShoe(['TS', 'AD', '8C', 'AH', '9S', 'KD', '8H', 'KC']);
  await bet('p1', 5);
  await bet('p2', 4);
  await bet('p3', 10);
  let t = table();
  assert.equal(t.phase, 'insurance');
  assert.equal(t.deadline, T0 + t.lastDeal.cards.at(-1).t + BJ.CARD_SETTLE_MS + 15_000, '15 s after the cards are shown');
  assertSecret('insurance phase');
  await err(move('p1', 'hit'), 'PHASE');
  await err(act('p1', 'insurance', { amountCents: 251 }), 'BAD_INSURANCE');
  await act('p1', 'insurance', { amountCents: 250 });
  assert.equal(wallet('p1'), 10000 - 500 - 250);
  assert.equal((await act('p1', 'insurance', { amountCents: 0 })).duplicate, true, 'decided once');
  await act('p2', 'insurance', { amountCents: 200 }); // a natural may insure too
  assert.equal(table().phase, 'insurance', 'p3 still deciding');
  await act('p3', 'insurance', { amountCents: 0 });
  t = table();
  assert.equal(t.phase, 'results', 'peek found blackjack: settled at once');
  assert.deepEqual(t.dealer.cards, [ids[3], ids[7]]);
  assert.deepEqual([handOf('p1').outcome, handOf('p2').outcome, handOf('p3').outcome], ['lose', 'push', 'lose']);
  assert.equal(wallet('p1'), 10000 - 500 - 250 + 750, 'lost $5, insurance $2.50 returned $7.50');
  assert.equal(wallet('p2'), 10000 - 400 - 200 + 600 + 400, 'insured natural: insurance 2:1 + push');
  assert.equal(wallet('p3'), 9000);
  const pays = ledger().filter((e) => e.type === 'casino_payout').map((e) => e.id.split('_').pop()).sort();
  assert.deepEqual(pays, ['end', 'ins', 'ins'], 'one entry per player per settlement step');
  assertSecret('dealer blackjack');
});

test('dealer shows an Ace without blackjack: insurance lost, naturals paid 3:2 right after the peek', async () => {
  seed();
  await sitAll(['p1', 'p2']);
  // p1 A K natural · p2 T 6; dealer A up, 9 hole (20).
  stackShoe(['AS', 'TH', 'AD', 'KC', '6S', '9D', 'TS']);
  await bet('p1', 5);
  await bet('p2', 2);
  await act('p2', 'insurance', { amountCents: 100 });
  assert.equal(table().phase, 'insurance');
  // p1 never decides: the timer declines for them.
  await act('p2', 'tick', {}, table().deadline);
  const t = table();
  assert.equal(t.phase, 'playing');
  assert.equal(t.seats[0].insurance, 0, 'undecided = declined');
  assert.equal(handOf('p1').outcome, 'blackjack');
  assert.equal(wallet('p1'), 10000 - 500 + 1250, '$5 natural returned $12.50 before anyone played');
  assert.ok(ledger().some((e) => e.id.endsWith('_p1_s0_natural') && e.amountCents === 1250));
  assert.equal(wallet('p2'), 10000 - 200 - 100, 'insurance lost');
  assert.deepEqual(t.turn, { seat: 1, hand: 0 }, 'the natural is skipped');
  assert.ok(t.dealer.holeDown, 'still face down');
  assertSecret('after peek');
  await move('p2', 'hit'); // T 6 + T = bust
  assert.equal(handOf('p2').outcome, 'bust');
  assert.equal(table().phase, 'results', 'no live hands: dealer just turns the hole card');
  assert.deepEqual(table().dealer.cards.length, 2);
});

test('dealer shows a 10: peeks at once (no insurance), natural vs natural pushes', async () => {
  seed();
  await sitAll(['p1']);
  stackShoe(['AS', 'KH', 'QD', 'AC']); // p1 A Q · dealer K up, A hole
  await bet('p1', 5);
  const t = table();
  assert.equal(t.phase, 'results');
  assert.equal(handOf('p1').outcome, 'push');
  assert.equal(wallet('p1'), 10000);
  // Dealer 10 up without blackjack: the natural is paid and the game goes on.
  seed();
  await sitAll(['p1']);
  stackShoe(['AS', 'KH', 'QD', '7C']);
  await bet('p1', 3);
  assert.equal(handOf('p1').outcome, 'blackjack');
  assert.equal(wallet('p1'), 10000 - 300 + 750);
  assert.equal(table().phase, 'results', 'only hand was a natural: dealer turns over, round ends');
});

// ---------- split, double ----------
test('split Aces get one card each and stand; 21 on a split Ace pays 1:1, not 3:2', async () => {
  seed();
  await sitAll(['p1']);
  // p1 A A; dealer 9 up, 8 hole (17). Split: A+K (21), A+5 (16).
  stackShoe(['AS', '9H', 'AD', '8C', 'KS', '5D']);
  await bet('p1', 5);
  await move('p1', 'split');
  const t = table();
  assert.equal(t.seats[0].hands.length, 2);
  assert.deepEqual(t.seats[0].hands.map((h) => h.cards.map((c) => c[0]).join('')), ['AK', 'A5']);
  assert.equal(t.phase, 'results', 'both split Aces stood by themselves');
  assert.deepEqual(t.seats[0].hands.map((h) => h.outcome), ['win', 'lose']);
  assert.equal(wallet('p1'), 10000 - 1000 + 1000, 'A+K after a split wins 1:1 ($10 back), A+5 loses');
});

test('split 8s, then double after split; money and turn order are right', async () => {
  seed();
  await sitAll(['p1', 'p2']);
  // p1 8 8 · p2 T 7; dealer 6 up, T hole (16).
  // Split: hand 0 = 8 + 3 (11) → double → + T = 21; hand 1 = 8 + 9 (17) → stand. p2 stands. Dealer hits: 5 → 21.
  stackShoe(['8S', 'TH', '6D', '8C', '7S', 'TC', '3H', '9S', 'TD', '5C']);
  await bet('p1', 4);
  await bet('p2', 2);
  await move('p1', 'split');
  let t = table();
  assert.deepEqual(t.turn, { seat: 0, hand: 0 });
  assert.equal(wallet('p1'), 10000 - 800);
  await err(move('p1', 'split'), 'CANT_SPLIT');
  await move('p1', 'double', 0);
  t = table();
  assert.deepEqual([handOf('p1', 0).betCents, handOf('p1', 0).doubled, handOf('p1', 0).status], [800, true, 'stood']);
  assert.equal(handValue(handOf('p1', 0).cards), 21);
  assert.deepEqual(t.turn, { seat: 0, hand: 1 });
  assert.equal(wallet('p1'), 10000 - 1200);
  await move('p1', 'stand', 1);
  await move('p2', 'stand');
  t = table();
  assert.equal(t.phase, 'results');
  assert.equal(handValue(t.dealer.cards), 21);
  assert.deepEqual([handOf('p1', 0).outcome, handOf('p1', 1).outcome, handOf('p2').outcome], ['push', 'lose', 'lose']);
  assert.equal(wallet('p1'), 10000 - 1200 + 800);
  assert.deepEqual(t.seats[0].result, { stakeCents: 1200, returnCents: 800, netCents: -400 });
  assert.equal(new Set(ledger().filter((e) => e.uid === 'p1').map((e) => e.id)).size, 4, 'bet, split, double, payout');
});
function handValue(cards) { return BJ.handValue(cards).total; }

test('double needs the money and two cards; a bust is collected at once and play moves on', async () => {
  seed(600);
  await sitAll(['p1', 'p2']);
  stackShoe(['5S', 'TH', '9D', '6C', '7S', '8C', 'KD', '2H']); // p1 5 6 · p2 T 7 · dealer 9 up
  await bet('p1', 5);
  await bet('p2', 1);
  await err(move('p1', 'double'), 'INSUFFICIENT_BALANCE');
  assert.equal(wallet('p1'), 100, 'refused double charged nothing');
  await move('p1', 'hit'); // 5 6 K = 21 → stands by itself
  assert.equal(handOf('p1').status, 'stood');
  assert.deepEqual(table().turn, { seat: 1, hand: 0 });
  await move('p2', 'hit'); // T 7 2 = 19
  await err(move('p2', 'double'), 'CANT_DOUBLE');
});

test('a bust is collected at once: if every hand busts, the dealer turns the hole card and draws nothing', async () => {
  seed();
  await sitAll(['p1']);
  stackShoe(['TS', '6H', '6D', 'TC', 'KH', '5S']); // p1 T 6 · dealer 6 up, T hole (16, would hit)
  await bet('p1', 5);
  await move('p1', 'hit'); // + K = 26
  const t = table();
  assert.equal(t.phase, 'results');
  assert.equal(handOf('p1').outcome, 'bust');
  assert.equal(t.dealer.cards.length, 2, 'no live hand: the dealer does not draw');
  assert.equal(wallet('p1'), 9500);
  assert.equal(ledger().filter((e) => e.type === 'casino_payout').length, 0);
});

// ---------- the double-tap guard ----------
test('double-tap Hit: only one card is dealt; the second tap is STALE and changes nothing', async () => {
  seed();
  await sitAll(['p1']);
  stackShoe(['2S', '9H', '3D', '7C', '4S', '5S', 'TC']);
  await bet('p1', 5);
  const seq = handOf('p1').seq;
  const results = await Promise.allSettled([move('p1', 'hit', 0, T0, seq), move('p1', 'hit', 0, T0, seq)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'STALE');
  assert.equal(handOf('p1').cards.length, 3, 'one card');
  // Double-tapping Stand: the second is refused, the dealer only plays once.
  const s = handOf('p1').seq;
  const stands = await Promise.allSettled([move('p1', 'stand', 0, T0, s), move('p1', 'stand', 0, T0, s)]);
  assert.equal(stands.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(table().phase, 'results');
});

test("another player's action between loading the table and tapping never blocks the move", async () => {
  seed();
  await sitAll(['p1', 'p2']);
  stackShoe(['2S', '9H', '3D', '7C', '4S', '5S', 'TC', '6D', '2C']);
  await bet('p1', 5);
  await bet('p2', 5);
  const loaded = table(); // p1's phone loads the table here
  const seqSeen = loaded.seats[0].hands[0].seq;
  // In between: a new player sits down (table rewritten, version bumped) and p2 sends a heartbeat.
  await act('p3', 'sit', { seat: 4 }, T0 + 500);
  await act('p2', 'heartbeat', {}, T0 + 40_000 - 1);
  assert.ok(table().version > loaded.version, 'the table moved on');
  const r = await act('p1', 'hit', { hand: 0, actionSeq: seqSeen }, T0 + 1000);
  assert.equal(r.ok, true, 'the hit went through');
  assert.equal(handOf('p1').cards.length, 3);
});

test('turn timer: 15 s per hand, then it stands; five phones ticking stand it once; a late tap is STALE', async () => {
  seed();
  await sitAll(['p1', 'p2']);
  stackShoe(['2S', '9H', '3D', '7C', '4S', '5S', 'TC', '6D', '2C', '8H']);
  await bet('p1', 5);
  await bet('p2', 5);
  const deadline = table().deadline;
  const seq = handOf('p1').seq;
  assert.equal((await act('p2', 'tick', {}, deadline - 1)).applied, false, 'not before the server clock passes it');
  await move('p1', 'hit', 0, T0 + 2000);
  assert.equal(table().deadline, deadline, 'hits do not reset the hand timer');
  const ticks = await Promise.all(['p1', 'p2', 'p3', 'p4', 'p5'].map((u) => act(u, 'tick', {}, deadline + 100)));
  assert.equal(ticks.filter((r) => r.applied).length, 1);
  assert.equal(handOf('p1').status, 'stood');
  assert.deepEqual(table().turn, { seat: 1, hand: 0 }, 'one hand stood, not two');
  await err(move('p1', 'stand', 0, deadline + 200, seq + 1), 'STALE');
  assert.equal(handOf('p2').status, 'playing');
});

// ---------- betting, leaving ----------
test('betting: chips stack into one bet, a change charges or refunds the difference, Confirm locks it, the clock deals for whoever has chips down', async () => {
  seed();
  await sitAll(['p1', 'p2', 'p3']);
  rng = (m) => Math.floor(Math.random() * m);
  await chips('p1', 3, T0);
  assert.equal(table().deadline, T0 + 15_000, 'the first chip starts the clock');
  await chips('p1', 8, T0 + 5); // $5 + $2 + $1 on top of nothing: one request with the total
  assert.equal(wallet('p1'), 10000 - 800);
  await chips('p1', 6, T0 + 6); // Undo a $2 chip
  assert.equal(wallet('p1'), 10000 - 600);
  assert.ok(ledger().some((e) => e.type === 'casino_refund' && e.amountCents === 200 && e.uid === 'p1'));
  assert.equal((await chips('p1', 6, T0 + 7, 'bj-req-replay-001')).betCents, 600);
  assert.equal((await chips('p1', 9, T0 + 8, 'bj-req-replay-001')).duplicate, true, 'a retried request is applied once');
  await err(chips('p1', 11, T0 + 10), 'BAD_BET');
  await err(chips('p2', 1.5, T0 + 10), 'BAD_BET');
  await err(act('p2', 'confirm', {}, T0 + 10), 'NO_BET');
  await act('p1', 'confirm', {}, T0 + 10);
  await err(chips('p1', 2, T0 + 11), 'CONFIRMED');
  await chips('p2', 2, T0 + 20);
  assert.equal(table().phase, 'betting', 'p2 has not confirmed and p3 has no chips');
  await act('p3', 'tick', {}, T0 + 15_000);
  const t = table();
  assert.notEqual(t.phase, 'betting');
  assert.equal(t.seats[2].hands.length, 0, 'p3 sits this one out');
  assert.equal(t.seats[1].hands.length, 1, 'an unconfirmed bet still plays when the clock runs out');
  assert.equal(t.seats[0].hands[0].betCents, 600);
  await err(chips('p3', 1, T0 + 15_001), 'PHASE');
  assertSecret('sit-out deal');
  const sum = ledger().filter((e) => e.uid === 'p1').reduce((a, e) => a + e.amountCents, 0);
  assert.equal(10000 + sum, wallet('p1'), 'ledger adds up');
});

test('everyone confirmed: the cards come out at once without waiting for the clock', async () => {
  seed();
  await sitAll(['p1', 'p2']);
  stackShoe(['TS', '9H', '9C', '6D', '9D', '7S']);
  await chips('p1', 5);
  await chips('p2', 2);
  await act('p1', 'confirm');
  assert.equal(table().phase, 'betting');
  const r = await act('p2', 'confirm');
  assert.equal(r.dealt, true);
  assert.equal(table().phase, 'playing');
});

test('leaving mid-hand: the seat is marked leaving, its hand stands on the timer, the seat frees next hand', async () => {
  seed();
  await sitAll(['p1', 'p2']);
  stackShoe(['TS', '9H', '8D', '7C', '9S', '6D', '2C']); // p1 T 7 · p2 9 9 · dealer 8 up
  await bet('p1', 5);
  await bet('p2', 5);
  const r = await act('p1', 'leave');
  assert.deepEqual([r.left, r.leaving], [false, true]);
  assert.equal(table().seats[0].leaving, true);
  await act('p2', 'tick', {}, table().deadline); // p1's hand stands on its timer
  await move('p2', 'stand');
  assert.equal(table().phase, 'results');
  assert.ok(table().seats[0].result, 'the leaving player was settled');
  await act('p2', 'tick', {}, table().deadline);
  assert.equal(table().seats[0], null, 'freed when the next hand opened');
});

// ---------- the shoe ----------
test('mid-hand empty shoe: a fresh shoe from every card not on the table', async () => {
  seed();
  await sitAll(['p1', 'p2', 'p3', 'p4', 'p5']);
  // 32 cards left (280 dealt: no reshuffle yet), all Aces, 2s and 3s, so five players hitting to 21
  // need more cards than the shoe holds.
  const low = [];
  for (const r of ['2', '3', 'A']) for (const su of ['S', 'H', 'D', 'C']) for (let d = 0; d < 6; d += 1) low.push(`${r}${su}${d}`);
  const pickLow = low.filter((_, i) => i % 2 === 0).slice(0, 32);
  fake.write('casinoTables/blackjack/private/shoe', { cards: pickLow, dealt: 280, shuffles: 0, holeCard: null });
  rng = () => 0;
  for (const uid of ['p1', 'p2', 'p3', 'p4', 'p5']) await bet(uid, 2);
  assert.equal(table().reshuffled, false);
  if (table().phase === 'insurance') for (const uid of ['p1', 'p2', 'p3', 'p4', 'p5']) await act(uid, 'insurance', { amountCents: 0 });
  assertSecret('dealt');
  let refilled = false;
  let guard = 0;
  while (table().phase === 'playing' && guard < 200) {
    guard += 1;
    const t = table();
    const seat = t.seats[t.turn.seat];
    const hand = seat.hands[t.turn.hand];
    const before = shoeDoc();
    const wasEmpty = before.cards.length === 0;
    const action = BJ.handValue(hand.cards).total < 20 ? 'hit' : 'stand';
    if (wasEmpty && action === 'hit') rng = (m) => Math.floor(Math.random() * m);
    await act(seat.uid, action, { hand: t.turn.hand, actionSeq: hand.seq });
    if (wasEmpty && action === 'hit') {
      refilled = true;
      const shoe = shoeDoc();
      assert.equal(table().refilledMidHand, table().roundId);
      const onTable = [...table().seats.flatMap((s) => s.hands.flatMap((h) => h.cards)), ...table().dealer.cards, ...(shoe.holeCard ? [shoe.holeCard] : [])];
      assert.ok(onTable.every((c) => !shoe.cards.includes(c)), 'no card on the table went back into the shoe');
      assert.equal(shoe.cards.length, 312 - onTable.length, 'every other card is back');
    }
    assertSecret(`step ${guard}`);
  }
  assert.ok(refilled, 'the shoe ran dry and was refilled mid-hand');
  assert.equal(table().phase, 'results');
  assertSecret('results');
});

test('reshuffle before a hand once 281 cards (90%) are dealt', async () => {
  seed();
  await sitAll(['p1']);
  stackShoe(['TS', '9H', '8D', '7C'], { dealt: 280 });
  fake.write('casinoTables/blackjack/private/shoe', { ...shoeDoc(), cards: shoeDoc().cards.slice(0, 32), dealt: 280 });
  await bet('p1', 1);
  assert.equal(table().reshuffled, false, '280 dealt: same shoe');
  while (table().phase !== 'results') {
    const turn = table().turn;
    if (table().phase === 'insurance') { await act('p1', 'insurance', { amountCents: 0 }); continue; }
    await act('p1', 'stand', { hand: turn.hand, actionSeq: handOf('p1', turn.hand).seq });
  }
  assert.ok(shoeDoc().dealt >= 281);
  rng = (m) => Math.floor(Math.random() * m);
  await act('p1', 'tick', {}, table().deadline);
  await bet('p1', 1, table().updatedAt);
  assert.equal(table().reshuffled, true);
  assert.equal(table().shoe.shuffles, 1);
  assertSecret('fresh shoe');
});

// ---------- lots of real hands ----------
test('400 real crypto hands with random play: secrets kept, money adds up, every hand finishes', async () => {
  seed(1_000_000);
  rng = (await import(url('server/casino/rng.js'))).randomInt;
  await sitAll(['p1', 'p2', 'p3']);
  let now = T0;
  let r = 0;
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const outcomes = {};
  for (let round = 0; round < 400; round += 1) {
    now = Math.max(now, table().updatedAt);
    for (const uid of ['p1', 'p2', 'p3']) await act(uid, 'heartbeat', {}, now);
    for (const uid of ['p1', 'p2', 'p3']) if ((uid === 'p1' || Math.random() < 0.9) && table().phase === 'betting') await bet(uid, 1 + Math.floor(Math.random() * 10), now);
    if (table().phase === 'betting') { now = table().deadline ?? now; await act('p1', 'tick', {}, now); }
    for (let step = 0; step < 40 && table().phase !== 'results'; step += 1) {
      assertSecret(`round ${round} step ${step}`);
      now = Math.max(now, table().updatedAt) + 500; // phones follow the server's clock
      for (const uid of ['p1', 'p2', 'p3']) await act(uid, 'heartbeat', {}, now); // every 20 s on a real phone
      const t = table();
      if (t.phase === 'insurance') {
        for (const uid of ['p1', 'p2', 'p3']) {
          const s = table().seats[seatOf(uid)];
          if (table().phase === 'insurance' && s.betCents > 0 && s.insurance === null) await act(uid, 'insurance', { amountCents: Math.random() < 0.3 ? Math.floor(s.betCents / 2) : 0 }, now);
        }
        continue;
      }
      if (t.phase !== 'playing') break;
      if (Math.random() < 0.05) { await act('p2', 'tick', {}, t.deadline); continue; }
      const seat = t.seats[t.turn.seat];
      const hand = seat.hands[t.turn.hand];
      const options = ['hit', 'stand', 'stand'];
      if (BJ.canDouble(hand)) options.push('double');
      if (BJ.canSplit(hand, seat.hands.length)) options.push('split', 'split');
      await act(seat.uid, pick(options), { hand: t.turn.hand, actionSeq: hand.seq }, now);
      r += 1;
    }
    const t = table();
    assert.equal(t.phase, 'results', `round ${round} finished`);
    assertSecret(`round ${round} results`);
    for (const seat of t.seats.filter(Boolean)) {
      for (const hand of seat.hands) {
        assert.equal(hand.status, 'done');
        outcomes[hand.outcome] = (outcomes[hand.outcome] ?? 0) + 1;
      }
      if (seat.hands.length) assert.equal(seat.result.netCents, seat.result.returnCents - seat.result.stakeCents);
    }
    now = t.deadline;
    await act('p3', 'tick', {}, now);
  }
  for (const k of ['win', 'lose', 'push', 'bust', 'blackjack']) assert.ok(outcomes[k] > 0, `saw ${k}: ${JSON.stringify(outcomes)}`);
  for (const uid of ['p1', 'p2', 'p3']) {
    const sum = ledger().filter((e) => e.uid === uid).reduce((s, e) => s + e.amountCents, 0);
    assert.equal(1_000_000 + sum, wallet(uid), `${uid}: wallet = start + ledger`);
    assert.ok(ledger().filter((e) => e.uid === uid).every((e) => e.game === 'blackjack' && ['casino_bet', 'casino_payout'].includes(e.type)));
  }
  assert.equal(groupShopPurchases(ledger(), []).totalCount, 0);
  assert.ok(table().shoe.shuffles >= 3, 'went through several shoes');
});

test('replies carry the table and the wallet, never the hole card or the shoe', async () => {
  seed();
  await sitAll(['p1', 'p2']);
  stackShoe(['TS', '9H', '9C', '6D', '9D', '7S', '3H']);
  await chips('p1', 5);
  await chips('p2', 5);
  await act('p1', 'confirm');
  const r = await act('p2', 'confirm');
  assert.equal(r.table.phase, 'playing');
  assert.equal(r.table.dealer.holeDown, true);
  const hole = shoeDoc().holeCard;
  assert.ok(hole);
  assert.ok(!JSON.stringify(r).includes(hole), 'the hole card is not in the reply');
  for (const card of shoeDoc().cards) assert.ok(!JSON.stringify(r).includes(`"${card}"`));
  assert.equal(r.balanceCents, wallet('p2'));
  const hit = await act('p1', 'hit', { hand: 0, actionSeq: handOf('p1').seq });
  assert.equal(hit.table.seats[0].hands[0].cards.length, 3, 'the hit card is in the reply');
  assert.ok(!JSON.stringify(hit).includes(shoeDoc().holeCard));
});

test('deal timing: seat order then dealer, opening cards 1 s apart, later cards 1.5 s apart, clocks start after the cards show', async () => {
  seed();
  await sitAll(['p1', 'p2', 'p3']);
  // p1 T 2 · p2 sits out · p3 9 5; dealer 9 up, 7 hole. p1 hits a 3; p3 stands; dealer draws.
  stackShoe(['TS', '9H', '9C', '2D', '5S', '7S', '3H', '4C', '2C']);
  await chips('p1', 5, T0);
  await chips('p3', 5, T0);
  await act('p1', 'confirm', {}, T0);
  await act('p3', 'confirm', {}, T0);
  await act('p2', 'tick', {}, table().deadline); // p2 never bet: the clock deals for p1 and p3
  let t = table();
  const at = t.lastDeal.at;
  assert.deepEqual(t.lastDeal.cards.map((c) => [c.to, c.i, c.t]), [
    ['0-0', 0, 0], ['2-0', 0, 1000], ['d', 0, 2000], ['0-0', 1, 3000], ['2-0', 1, 4000], ['d', 1, 5000],
  ], 'seat 1, seat 3, dealer, then again; only seats with a bet; 1 s apart');
  assert.deepEqual(t.dealer.cards.length, 1, 'only the up card is public');
  assert.equal(t.deadline, at + 5000 + BJ.CARD_SETTLE_MS + 15_000, "the first turn's 15 s starts after the deal shows");
  const hitAt = at + 6000;
  await move('p1', 'hit', 0, hitAt);
  t = table();
  assert.deepEqual([t.lastDeal.at, t.lastDeal.cards.map((c) => c.t)], [hitAt, [0]]);
  assert.equal(t.deadline, at + 5000 + BJ.CARD_SETTLE_MS + 15_000, "a hit shows at once (t = 0) and keeps the hand's 15 s clock");
  await move('p1', 'stand', 0, hitAt + 2000);
  const standAt = hitAt + 3000;
  await move('p3', 'stand', 0, standAt);
  t = table();
  assert.equal(t.phase, 'results');
  assert.ok(t.dealer.cards.length >= 3, 'dealer drew');
  assert.deepEqual(t.lastDeal.cards.map((c) => [c.to, c.t]), t.dealer.cards.slice(1).map((_, k) => ['d', k * 1500]), 'hole card, then each draw, 1.5 s apart');
  assert.equal(t.deadline, standAt + t.lastDeal.cards.at(-1).t + BJ.CARD_SETTLE_MS + 5000);
});

test('five seats, one without a bet: one card at a time 1 → 5 then dealer, twice; insurance, double, split and dealer timing', async () => {
  const TIMING = await import(url('shared/casino/timing.js'));
  assert.deepEqual([TIMING.BLACKJACK_INITIAL_GAP_MS, TIMING.BLACKJACK_LATER_GAP_MS], [1000, 1500], 'the values live in timing.js');
  assert.equal(BJ.BLACKJACK_LATER_GAP_MS, TIMING.BLACKJACK_LATER_GAP_MS, 'blackjack.js uses the shared timing file');
  seed();
  await sitAll(['p1', 'p2', 'p3', 'p4', 'p5']);
  // Opening: p1 5 9 · p2 6 6 · p3 7 T · p4 no bet · p5 8 2 · dealer A up, 6 hole (soft 17).
  // Then: p1 doubles (4) · p2 splits 6s (2, 3) · dealer hits soft 17 (2) → 19.
  stackShoe(['5S', '6S', '7S', '8S', 'AH', '9C', '6H', 'TC', '2C', '6D', '4D', '2H', '3H', '2D']);
  for (const uid of ['p1', 'p2', 'p3', 'p5']) await chips(uid, 5, T0);
  for (const uid of ['p1', 'p2', 'p3', 'p5']) await act(uid, 'confirm', {}, T0 + 1000);
  const dealAt = table().deadline; // p4 is seated without a bet: the betting clock deals
  await act('p4', 'tick', {}, dealAt);
  let t = table();
  const at = t.lastDeal.at;
  assert.equal(at, dealAt, 'phones time the cards from the server deal time');
  assert.deepEqual(t.lastDeal.cards.map((c) => [c.to, c.i, c.t]), [
    ['0-0', 0, 0], ['1-0', 0, 1000], ['2-0', 0, 2000], ['4-0', 0, 3000], ['d', 0, 4000],
    ['0-0', 1, 5000], ['1-0', 1, 6000], ['2-0', 1, 7000], ['4-0', 1, 8000], ['d', 1, 9000],
  ], 'every card on its own, seat 4 (no bet) adds no delay');
  assert.equal(t.phase, 'insurance');
  assert.equal(t.deadline, at + 9000 + BJ.CARD_SETTLE_MS + 15_000, 'insurance clock starts after the 10th card shows');
  assertSecret('insurance');

  const insAt = at + 11_000;
  for (const uid of ['p1', 'p2', 'p3', 'p5']) await act(uid, 'insurance', { amountCents: 0 }, insAt);
  t = table();
  assert.equal(t.phase, 'playing');
  assert.deepEqual(t.turn, { seat: 0, hand: 0 });
  assert.equal(t.deadline, insAt + 15_000, 'no new cards: the turn clock starts at once');

  const dblAt = insAt + 3000;
  await move('p1', 'double', 0, dblAt);
  t = table();
  assert.deepEqual([t.lastDeal.at, t.lastDeal.cards.map((c) => [c.to, c.i, c.t])], [dblAt, [['0-0', 2, 0]]]);
  assert.deepEqual(t.turn, { seat: 1, hand: 0 });
  assert.equal(t.deadline, dblAt + BJ.CARD_SETTLE_MS + 15_000);

  const splitAt = dblAt + 4000;
  await move('p2', 'split', 0, splitAt);
  t = table();
  assert.deepEqual(t.lastDeal.cards.map((c) => [c.to, c.i, c.t]), [['1-0', 1, 0], ['1-1', 1, 1500]], 'split cards 1.5 s apart');
  assert.equal(t.deadline, splitAt + 1500 + BJ.CARD_SETTLE_MS + 15_000, "the split hand's clock starts after both cards show");

  const s1 = splitAt + 3000;
  await move('p2', 'stand', 0, s1);
  await move('p2', 'stand', 1, s1 + 500);
  await move('p3', 'stand', 0, s1 + 1000);
  const lastAt = s1 + 1500;
  await move('p5', 'stand', 0, lastAt);
  t = table();
  assert.equal(t.phase, 'results');
  assert.deepEqual(t.dealer.cards.map((c) => c.slice(0, 2)), ['AH', '6D', '2D'], 'hole card, then one draw on soft 17');
  assert.deepEqual(t.lastDeal.cards.map((c) => [c.to, c.i, c.t]), [['d', 1, 0], ['d', 2, 1500]], 'hole card reveal, then the draw 1.5 s later');
  assert.equal(t.deadline, lastAt + 1500 + BJ.CARD_SETTLE_MS + 5000, 'results stay 5 s after the last dealer card shows');
  assertSecret('results');
});
