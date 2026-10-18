// npm run test:challenges  (or: node --experimental-test-module-mocks --test test/challenges/challenges.test.mjs)
// Challenges: posting, admin approve / reject / edit (logged), betting (fresh odds, close time on the
// server clock, one leg per Challenge, the poster's own bets flagged by the server), settling and voiding
// through normal settlement (win rate counts), cash out, and the custom-game edit log.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFakeDb } from '../casino/fakeFirestore.mjs';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;

const fake = makeFakeDb();
mock.module(url('server/firebaseAdmin.js'), {
  namedExports: { adminDb: () => fake.db, adminAuth: () => ({}), normalizePrivateKey: (k) => k },
});

const C = await import(url('shared/challenges.js'));
const S = await import(url('server/challenges.js'));
const { placeBets } = await import(url('server/placeBet.js'));
const { createPricingContext } = await import(url('server/pricing.js'));
const { settleOpenBets } = await import(url('server/settlement.js'));
const { quoteBets, createCashoutContext, clearEstimateCache } = await import(url('server/cashout.js'));
const customAdmin = await import(url('server/admin/customGames.js'));
const { buildCustomBoard } = await import(url('server/board.js'));
const { NO_CASHOUT_REASON } = await import(url('shared/betRules.js'));

// Saturday 2026-10-18 10:00 CDT. Betting closes 7:00 PM CDT (= 2026-10-19 00:00 UTC).
const T0 = new Date('2026-10-18T15:00:00.000Z');
const CLOSE = { closeDate: '2026-10-18', closeClock: '19:00' };
const CLOSE_MS = Date.parse('2026-10-19T00:00:00.000Z');
const later = (ms) => new Date(T0.getTime() + ms);
const H = 3600e3;
const UIDS = ['mike', 'will', 'dan'];
const START = 10_000;

const caller = (uid) => ({ uid, token: {}, user: fake.get(`users/${uid}`) });
const admin = { uid: 'boss', token: { admin: true }, user: { username: 'boss', displayName: 'Boss' } };
const wallet = (uid) => fake.get(`users/${uid}`).balanceCents;
const challenge = (id) => fake.get(`challenges/${id}`);
const bet = (id) => fake.get(`bets/${id}`);
const err = async (p, code, re) => {
  await assert.rejects(p, (e) => {
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });
};
let n = 0;
const rid = () => `chal-req-${String(++n).padStart(6, '0')}`;

beforeEach(() => {
  fake.reset();
  clearEstimateCache();
  for (const uid of UIDS) fake.write(`users/${uid}`, { username: uid, displayName: uid[0].toUpperCase() + uid.slice(1), balanceCents: START, stats: { won: 0, lost: 0 } });
});

const FIVE_K = { title: 'Will Mike finish a 5K under 25 minutes?', description: 'Saturday park run, chip time.', outcomes: [{ label: 'Yes', american: '+150' }, { label: 'No', american: '-180' }] };

async function post(uid = 'mike', body = FIVE_K, now = T0) {
  const res = await S.postChallenge(caller(uid), { clientRequestId: rid(), ...body, ...CLOSE }, { now });
  return res.challengeId;
}
async function approve(id, fields = {}, now = T0) {
  return S.approveChallenge({ challengeId: id, ...fields }, admin, { now });
}
const leg = (id, outcome, american) => ({ league: 'challenge', gameId: `challenge:${id}`, marketType: 'challenge', selection: outcome, line: null, quotedAmerican: american });
const single = (uid, legs, stake = 1000, now = T0) =>
  placeBets(caller(uid), { mode: 'singles', clientRequestId: rid(), legs: legs.map((l) => ({ ...l, stakeCents: stake })) }, { now });
const parlay = (uid, legs, stake = 1000, now = T0) => placeBets(caller(uid), { mode: 'parlay', clientRequestId: rid(), stakeCents: stake, legs }, { now });

// ---------- rules ----------

test('posting rules: 2–6 outcomes with names and American odds, close 10 min – 60 days ahead', () => {
  const ok = { ...FIVE_K, closeMs: T0.getTime() + H };
  assert.deepEqual(C.challengeProblems(ok, T0.getTime()), []);
  assert.match(C.challengeProblems({ ...ok, outcomes: ok.outcomes.slice(0, 1) }, T0.getTime()).join(' '), /2–6 outcomes/);
  assert.match(C.challengeProblems({ ...ok, outcomes: Array.from({ length: 7 }, (_, i) => ({ label: `O${i}`, american: '+100' })) }, T0.getTime()).join(' '), /2–6/);
  assert.match(C.challengeProblems({ ...ok, outcomes: [{ label: 'Yes', american: '+150' }, { label: 'yes', american: '-150' }] }, T0.getTime()).join(' '), /different name/);
  assert.match(C.challengeProblems({ ...ok, outcomes: [{ label: 'Yes', american: '+50' }, { label: 'No', american: '-180' }] }, T0.getTime()).join(' '), /American odds/);
  assert.match(C.challengeProblems({ ...ok, closeMs: T0.getTime() + 5 * 60e3 }, T0.getTime()).join(' '), /10 minutes/);
  assert.match(C.challengeProblems({ ...ok, closeMs: T0.getTime() + 61 * 24 * H }, T0.getTime()).join(' '), /60 days/);
  assert.match(C.challengeProblems({ ...ok, title: '' }, T0.getTime()).join(' '), /title/);
  assert.equal(C.cleanAmerican('+150'), 150);
  assert.equal(C.cleanAmerican('-180'), -180);
  assert.equal(C.cleanAmerican('120'), 120);
  assert.equal(C.cleanAmerican('-99'), null);
});

// ---------- posting and approval ----------

test('a posted Challenge is pending: visible, no betting; one post per request id', async () => {
  const requestId = rid();
  const a = await S.postChallenge(caller('mike'), { clientRequestId: requestId, ...FIVE_K, ...CLOSE }, { now: T0 });
  const b = await S.postChallenge(caller('mike'), { clientRequestId: requestId, ...FIVE_K, ...CLOSE }, { now: T0 });
  assert.equal(b.duplicate, true);
  assert.equal(a.challengeId, b.challengeId);
  const c = challenge(a.challengeId);
  assert.equal(c.status, 'pending');
  assert.equal(c.posterUid, 'mike');
  assert.deepEqual(c.outcomes, [{ id: 'o1', label: 'Yes', american: 150 }, { id: 'o2', label: 'No', american: -180 }]);
  assert.equal(c.closeTime.toMillis(), CLOSE_MS);
  await err(single('dan', [leg(a.challengeId, 'o1', 150)]), 'MARKET_CLOSED', /approved/);
  await err(S.postChallenge(caller('mike'), { clientRequestId: rid(), ...FIVE_K, outcomes: [{ label: 'Yes', american: '+150' }] , ...CLOSE }, { now: T0 }), 'BAD_CHALLENGE');
});

test('admin approves (editing odds and wording first, logged), or rejects with a note', async () => {
  const id = await post();
  await approve(id, { title: 'Will Mike run a sub-25 5K?', outcomes: [{ label: 'Yes', american: '+140' }, { label: 'No', american: '-170' }] });
  const c = challenge(id);
  assert.equal(c.status, 'open');
  assert.equal(c.title, 'Will Mike run a sub-25 5K?');
  assert.deepEqual(c.outcomes.map((o) => o.american), [140, -170]);
  assert.equal(c.edits.length, 1);
  assert.equal(c.edits[0].byName, 'Boss');
  assert.match(c.edits[0].what, /Approved with edits: .*Yes \+150 → \+140; No -180 → -170/);
  await err(approve(id), 'NOT_PENDING');

  const id2 = await post('dan', { ...FIVE_K, title: 'Will Dan eat 50 wings?' });
  await err(S.rejectChallenge({ challengeId: id2, note: '' }, admin, { now: T0 }), 'BAD_NOTE');
  await S.rejectChallenge({ challengeId: id2, note: 'Unsafe' }, admin, { now: T0 });
  assert.equal(challenge(id2).status, 'rejected');
  assert.equal(challenge(id2).rejectNote, 'Unsafe');
  await err(single('mike', [leg(id2, 'o1', 150)]), 'MARKET_CLOSED', /closed/);
});

// ---------- betting ----------

test('betting: fresh odds, one leg per Challenge in a parlay, closes at the close time (server clock)', async () => {
  const id = await post();
  await approve(id);
  const id2 = await post('dan', { ...FIVE_K, title: 'Will Dan bench 225?' });
  await approve(id2);

  const r = await single('dan', [leg(id, 'o1', 150)], 1000);
  const placed = r.bets[0];
  assert.equal(placed.legs[0].gameLabel, FIVE_K.title);
  assert.equal(placed.legs[0].label, 'Yes');
  assert.equal(placed.legs[0].americanOdds, 150);
  assert.equal(placed.potentialPayoutCents, 2500);
  assert.equal(placed.posterBet, undefined, 'not the poster');
  assert.equal(wallet('dan'), START - 1000);
  assert.equal(challenge(id).betCount, 1);

  await err(parlay('dan', [leg(id, 'o1', 150), leg(id, 'o2', -180)]), 'BAD_SLIP', /one pick per game/);
  const p = await parlay('will', [leg(id, 'o2', -180), leg(id2, 'o1', 150)], 1000);
  assert.equal(p.bets[0].legs.length, 2, 'two different Challenges can share a parlay');

  await err(single('will', [leg(id, 'o1', 150)], 1000, new Date(CLOSE_MS)), 'MARKET_CLOSED', /close time/);
  await err(single('will', [leg(id, 'o3', 150)]), 'MARKET_CLOSED', /no longer offered/);
});

test('a Challenge the admin closes between pricing and the write refuses the bet; nothing is charged', async () => {
  const id = await post();
  await approve(id);
  const ctx = createPricingContext({ now: T0 });
  const read = ctx.challenge;
  ctx.challenge = async (docId) => {
    const data = await read(docId); // priced while open…
    fake.write(`challenges/${id}`, { ...challenge(id), status: 'void' }); // …then the admin voids it
    return data;
  };
  await err(placeBets(caller('dan'), { mode: 'singles', clientRequestId: rid(), legs: [{ ...leg(id, 'o1', 150), stakeCents: 1000 }] }, { now: T0, ctx }), 'MARKET_CLOSED', /just closed/);
  assert.equal(wallet('dan'), START);
  assert.equal(challenge(id).betCount, 0);
});

test("the poster bets on their own approved Challenge: accepted, posterBet true (set by the server), listed publicly, graded normally", async () => {
  const id = await post('mike');
  await err(single('mike', [leg(id, 'o1', 150)]), 'MARKET_CLOSED', /approved/, 'not before approval, for the poster too');
  await approve(id);
  // The browser can't set the flag: an extra posterBet field is ignored, the server decides.
  const r = await placeBets(caller('mike'), { mode: 'singles', clientRequestId: rid(), posterBet: false, legs: [{ ...leg(id, 'o2', -180), stakeCents: 1800, posterBet: false }] }, { now: T0 });
  const b = r.bets[0];
  assert.equal(b.posterBet, true);
  assert.equal(bet(b.id).posterBet, true);
  const c = challenge(id);
  assert.equal(c.posterBets.length, 1);
  assert.deepEqual([c.posterBets[0].betId, c.posterBets[0].outcomeId, c.posterBets[0].label, c.posterBets[0].stakeCents], [b.id, 'o2', 'No', 1800]);
  // A non-poster's bet is not flagged.
  const other = await single('dan', [leg(id, 'o1', 150)], 1000);
  assert.equal(bet(other.bets[0].id).posterBet, undefined);
  assert.equal(challenge(id).posterBets.length, 1);

  // Settled normally: "No" wins → Mike's poster bet wins at -180 (1800 → 2800); Dan's loses.
  await S.settleChallenge({ challengeId: id, winner: 'o2', confirm: true }, admin, { now: later(H) });
  assert.equal(bet(b.id).status, 'won');
  assert.equal(bet(b.id).payoutCents, 2800);
  assert.equal(wallet('mike'), START - 1800 + 2800);
  assert.equal(bet(other.bets[0].id).status, 'lost');
  assert.deepEqual(fake.get('users/mike').stats, { won: 1, lost: 0 }, 'Challenge bets count toward win rate');
  assert.deepEqual(fake.get('users/dan').stats, { won: 0, lost: 1 });
  assert.equal(bet(b.id).legs[0].scoreText, 'Winner: No');
});

test('admin edits odds after bets: old bets keep their odds, new bets get the new ones; wording is fixed; all logged', async () => {
  const id = await post();
  await approve(id);
  const first = await single('dan', [leg(id, 'o1', 150)], 1000);
  await err(S.editChallenge({ challengeId: id, title: 'Different question' }, admin, { now: T0 }), 'WORDING_FIXED');
  await err(S.editChallenge({ challengeId: id, outcomes: [{ label: 'Maybe', american: '+150' }, { label: 'No', american: '-180' }] }, admin, { now: T0 }), 'WORDING_FIXED');
  await S.editChallenge({ challengeId: id, outcomes: [{ american: '+120' }, { american: '-150' }] }, admin, { now: T0 });
  const second = await single('will', [leg(id, 'o1', 120)], 1000);
  assert.equal(bet(first.bets[0].id).legs[0].americanOdds, 150, 'kept');
  assert.equal(bet(second.bets[0].id).legs[0].americanOdds, 120, 'new odds');
  // A slip still holding the old price is re-priced (a price change on the same line is accepted).
  const third = await single('will', [leg(id, 'o1', 150)], 1000);
  assert.equal(third.bets[0].legs[0].americanOdds, 120);
  assert.deepEqual(third.priceChanges.map((c) => [c.from, c.to]), [[150, 120]]);
  // The close time can move too.
  await S.editChallenge({ challengeId: id, closeDate: '2026-10-18', closeClock: '12:00' }, admin, { now: T0 });
  await err(single('will', [leg(id, 'o1', 120)], 1000, later(2 * H + 1)), 'MARKET_CLOSED');
  const edits = challenge(id).edits.map((e) => e.what);
  assert.equal(edits.length, 3);
  assert.match(edits[1], /Yes \+150 → \+120; No -180 → -150/);
  assert.match(edits[2], /closes Oct 18, 7:00 PM → Oct 18, 12:00 PM/);
});

test('settle: a preview shows every wallet change; void refunds every leg and leaves win rate alone', async () => {
  const id = await post();
  await approve(id);
  const yes = await single('dan', [leg(id, 'o1', 150)], 1000);
  const no = await single('will', [leg(id, 'o2', -180)], 1800);
  await err(S.settleChallenge({ challengeId: id, winner: 'o9' }, admin, { now: T0 }), 'BAD_WINNER');
  const preview = await S.settleChallenge({ challengeId: id, winner: 'o1' }, admin, { now: later(H) });
  assert.equal(preview.preview, true);
  assert.equal(preview.winnerLabel, 'Yes');
  assert.deepEqual(preview.walletChanges.map((w) => [w.uid, w.deltaCents]), [['dan', 2500], ['will', 0]]);
  assert.equal(bet(yes.bets[0].id).status, 'open', 'preview changes nothing');
  assert.equal(challenge(id).status, 'open');

  const id2 = await post('dan', { ...FIVE_K, title: 'Will it rain?' });
  await approve(id2);
  const r = await single('will', [leg(id2, 'o1', 150)], 1000);
  await S.voidChallenge({ challengeId: id2, confirm: true }, admin, { now: later(H) });
  assert.equal(bet(r.bets[0].id).status, 'void');
  assert.equal(wallet('will'), START - 1800, 'void stake back; only the other Challenge’s $18 still out');
  assert.deepEqual(fake.get('users/will').stats, { won: 0, lost: 0 });
  assert.equal(challenge(id2).status, 'void');
  await err(S.voidChallenge({ challengeId: id2 }, admin, { now: T0 }), 'CHALLENGE_CLOSED');
  assert.ok(no);
});

test('cash out on a Challenge bet (0.11.0): never, before or after the close', async () => {
  const id = await post();
  await approve(id);
  const r = await single('dan', [leg(id, 'o1', 150)], 1000);
  const betId = r.bets[0].id;
  const q1 = await quoteBets(caller('dan'), { betIds: [betId] }, { now: later(H), makeContext: (o) => createCashoutContext({ ...o, getBoard: async () => ({ games: [] }) }) });
  assert.deepEqual(q1.quotes[betId], { available: false, valueCents: null, reason: NO_CASHOUT_REASON });
  clearEstimateCache();
  const q2 = await quoteBets(caller('dan'), { betIds: [betId] }, { now: new Date(CLOSE_MS + 60e3), makeContext: (o) => createCashoutContext({ ...o, getBoard: async () => ({ games: [] }) }) });
  assert.deepEqual(q2.quotes[betId], { available: false, valueCents: null, reason: NO_CASHOUT_REASON });
});

test('settlement grades Challenge legs from the doc; an unsettled Challenge stays open', async () => {
  const id = await post();
  await approve(id);
  const r = await single('dan', [leg(id, 'o1', 150)], 1000);
  const run1 = await settleOpenBets({ trigger: 'admin', force: true, now: new Date(CLOSE_MS + H) });
  assert.equal(run1.settled, 0);
  assert.equal(bet(r.bets[0].id).status, 'open');
  fake.write(`challenges/${id}`, { ...challenge(id), status: 'settled', winner: 'o1' });
  const run2 = await settleOpenBets({ trigger: 'admin', force: true, now: new Date(CLOSE_MS + 2 * H) });
  assert.equal(run2.settled, 1);
  assert.equal(bet(r.bets[0].id).status, 'won');
  assert.equal(wallet('dan'), START - 1000 + 2500);
});

// ---------- section 6: custom-game edits are logged ----------

test('custom games: every admin change is logged (who, what, when) and carried to the board', async () => {
  const body = {
    league: 'nfl',
    home: { name: 'Backyard Bears', abbr: 'BB' },
    away: { name: 'Lawn Lions', abbr: 'LL' },
    startDate: '2026-10-25',
    startClock: '12:00',
    odds: { moneyline: { home: '-150', away: '+130' }, spread: { homeLine: '-3.5', home: '-110', away: '-110' }, total: { line: '', over: '', under: '' } },
  };
  const { gameId } = await customAdmin.createCustomGame(body, admin);
  await customAdmin.updateCustomGame({ ...body, gameId, odds: { ...body.odds, moneyline: { home: '-160', away: '+140' } } }, admin);
  const doc = fake.get(`customGames/${gameId.slice(7)}`);
  assert.deepEqual(doc.edits.map((e) => e.what), ['Created', 'Edited: Home ML -150 → -160; Away ML +130 → +140']);
  assert.equal(doc.edits[1].byName, 'Boss');
  const board = await buildCustomBoard({ now: T0 });
  assert.deepEqual(board.games[0].edits.map((e) => e.what), ['Created', 'Edited: Home ML -150 → -160; Away ML +130 → +140']);
  assert.ok(board.games[0].edits[1].at);
});
