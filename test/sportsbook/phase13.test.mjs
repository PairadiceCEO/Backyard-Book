// npm run test:sportsbook  (or: node --experimental-test-module-mocks test/sportsbook/phase13.test.mjs)
// 0.13.0 item 2: a leg whose price moved 50+ points (−100 and +100 being the same point) from the price the player
// saw is refused with ODDS_CHANGED; under 50 it's accepted at the fresh price. Every market type, each parlay leg.
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

const odds = await import(url('shared/oddsMath.js'));
const { placeBets } = await import(url('server/placeBet.js'));

const NOW = new Date('2026-10-18T15:00:00.000Z');
const LATER = '2026-10-18T23:00:00.000Z';

beforeEach(() => {
  fake.reset();
  fake.write('users/mike', { username: 'mike', displayName: 'Mike', balanceCents: 10_000, stats: { won: 0, lost: 0 } });
  // Two house games and an open Challenge, priced from their docs.
  fake.write('customGames/g1', { league: 'nfl', startTime: LATER, status: 'scheduled', home: { name: 'Bears' }, away: { name: 'Cats' }, odds: { moneyline: { home: 150, away: -180 }, spread: { homeLine: -3.5, home: -110, away: -110 } }, betCount: 0 });
  fake.write('customGames/g2', { league: 'nfl', startTime: LATER, status: 'scheduled', home: { name: 'Hawks' }, away: { name: 'Owls' }, odds: { moneyline: { home: -150, away: 130 } }, betCount: 0 });
  fake.write('challenges/u2_abcdefgh', { posterUid: 'u2', title: 'Will Dan finish?', status: 'open', closeTime: LATER, outcomes: [{ id: 'o1', label: 'Yes', american: 250 }, { id: 'o2', label: 'No', american: -300 }], betCount: 0 });
});

const caller = { uid: 'mike', token: {}, user: { username: 'mike' } };
let n = 0;
const rid = () => `odds-req-${String(++n).padStart(6, '0')}`;
const ml = (game, side, quotedAmerican) => ({ league: 'nfl', gameId: `custom:${game}`, marketType: 'moneyline', selection: side, line: null, quotedAmerican, legId: `${game}-${side}` });
const chal = (quotedAmerican) => ({ league: 'challenge', gameId: 'challenge:u2_abcdefgh', marketType: 'challenge', selection: 'o1', line: null, quotedAmerican, legId: 'chal-o1' });
const single = (legs, stake = 1000) => placeBets(caller, { mode: 'singles', clientRequestId: rid(), legs: legs.map((l) => ({ ...l, stakeCents: stake })) }, { now: NOW });
const parlay = (legs, stake = 1000) => placeBets(caller, { mode: 'parlay', clientRequestId: rid(), stakeCents: stake, legs }, { now: NOW });
const ledgerCount = () => [...fake.store.keys()].filter((k) => k.startsWith('ledger/')).length;
const betCount = () => [...fake.store.keys()].filter((k) => k.startsWith('bets/')).length;

test('distance on the continuous scale (−100 and +100 are the same point); 50 is the one named threshold', () => {
  assert.equal(odds.ODDS_CONFIRM_POINTS, 50);
  const cases = [
    [100, 150, 50, true],
    [100, -150, 50, true],
    [-110, 110, 20, false],
    [-150, -199, 49, false],
    [250, 300, 50, true],
    [-100, 100, 0, false],
    [300, 250, 50, true],
  ];
  for (const [a, b, d, ask] of cases) {
    assert.equal(odds.oddsDistance(a, b), d, `${a} → ${b}`);
    assert.equal(odds.needsOddsConfirm(a, b), ask, `${a} → ${b} asks`);
  }
});

test('placeBets: refused at exactly 50 points with ODDS_CHANGED; accepted at 49 at the fresh price', async () => {
  // Bears ML is +150 on the doc. The player saw +100 → 50 points: refused, nothing placed.
  await assert.rejects(single([ml('g1', 'home', 100)]), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.code, 'ODDS_CHANGED');
    assert.deepEqual(e.extra.oddsChanges.map((c) => [c.legId, c.oldAmerican, c.newAmerican, c.quote.american]), [['g1-home', 100, 150, 150]]);
    return true;
  });
  assert.equal(betCount(), 0);
  assert.equal(fake.get('users/mike').balanceCents, 10_000);

  // Saw +101 → 49 points: placed at +150, listed in priceChanges.
  const ok = await single([ml('g1', 'home', 101)]);
  assert.equal(ok.bets[0].legs[0].americanOdds, 150);
  assert.deepEqual(ok.priceChanges.map((c) => [c.from, c.to]), [[101, 150]]);

  // Works for a Challenge leg too (+250 on the doc; saw +200 → 50).
  await assert.rejects(single([chal(200)]), (e) => e.code === 'ODDS_CHANGED');
  assert.equal((await single([chal(201)])).bets[0].legs[0].americanOdds, 250);
});

test('a parlay with one leg moved 60 points is refused and nothing moves; resubmitting with the new quotedAmerican is placed', async () => {
  const legs = [ml('g1', 'home', 150), ml('g2', 'away', 190)]; // Owls are +130 now: 60 points from +190
  const ledgerBefore = ledgerCount();
  let changes = null;
  await assert.rejects(parlay(legs, 500), (e) => {
    assert.equal(e.code, 'ODDS_CHANGED');
    changes = e.extra.oddsChanges;
    return true;
  });
  assert.deepEqual(changes.map((c) => [c.legId, c.oldAmerican, c.newAmerican]), [['g2-away', 190, 130]]);
  assert.equal(fake.get('users/mike').balanceCents, 10_000, 'no wallet change');
  assert.equal(ledgerCount(), ledgerBefore, 'no ledger entry');
  assert.equal(betCount(), 0);
  assert.equal(fake.get('customGames/g2').betCount, 0);

  // "Accept new odds": the slip resubmits with quotedAmerican = the new price.
  const accepted = legs.map((l) => (l.legId === 'g2-away' ? { ...l, quotedAmerican: changes[0].newAmerican } : l));
  const res = await parlay(accepted, 500);
  assert.equal(res.bets.length, 1);
  assert.deepEqual(res.bets[0].legs.map((l) => l.americanOdds), [150, 130]);
  assert.equal(fake.get('users/mike').balanceCents, 9_500);
});

test('LINE_CHANGED and MARKET_CLOSED keep priority over ODDS_CHANGED', async () => {
  const lineMoved = { league: 'nfl', gameId: 'custom:g1', marketType: 'spread', selection: 'home', line: -2.5, quotedAmerican: -110, legId: 'g1-spread' };
  const oddsMoved = ml('g2', 'away', 190);
  await assert.rejects(single([lineMoved, oddsMoved]), (e) => e.code === 'LINE_CHANGED');
  const closed = { ...ml('gone', 'home', 100) };
  await assert.rejects(single([closed, oddsMoved]), (e) => e.code === 'MARKET_CLOSED');
  assert.equal(betCount(), 0);
});

test('slip: "Accept new odds" updates those picks\' odds and payout; "Remove pick(s)" takes them off', async () => {
  const red = await import(url('src/lib/betSlipReducer.js'));
  const rules = await import(url('shared/betRules.js'));
  const quote = (american) => ({ american, decimal: odds.roundDecimal(odds.americanToDecimal(american)), line: null, source: 'custom', ref: null });
  const game = (id) => ({ id: `custom:${id}`, league: 'nfl', home: { shortName: 'Bears' }, away: { shortName: 'Cats' } });
  let state = red.betSlipReducer(red.initialSlipState, { type: 'toggle', pick: red.makePick(game('g1'), 'moneyline', 'home', quote(100)) });
  state = red.betSlipReducer(state, { type: 'toggle', pick: red.makePick(game('g2'), 'moneyline', 'away', quote(190)) });
  const [a, b] = state.legs;
  state = red.betSlipReducer(state, { type: 'setStake', legId: a.legId, value: '10' });
  state = red.betSlipReducer(state, { type: 'acceptOdds', changes: [{ legId: a.legId, oldAmerican: 100, newAmerican: 155, quote: quote(155) }] });
  assert.equal(state.legs[0].american, 155);
  assert.equal(rules.payoutCents(1000, state.legs[0].decimal), 2550, 'payout recalculated from the new odds');
  assert.equal(state.legs[1].american, 190, 'other picks untouched');
  state = red.betSlipReducer(state, { type: 'removeMany', legIds: [b.legId] });
  assert.deepEqual(state.legs.map((l) => l.legId), [a.legId]);
});
