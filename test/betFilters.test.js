// npm test — My Bets → Finished: sort, filters, summary and the remembered view (src/lib/betFilters.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../src/lib/betFilters.js';

// 2026-10-18 12:00 CDT.
const NOW = Date.parse('2026-10-18T17:00:00Z');
const H = 3600e3;
const iso = (ms) => new Date(ms).toISOString();
const leg = (o) => ({ league: 'nfl', gameId: '401', marketType: 'moneyline', selection: 'home', label: 'Texans ML', gameLabel: 'Jaguars @ Texans', startTime: iso(NOW - 10 * H), result: 'win', ...o });
const bet = (id, o) => ({ id, uid: 'u1', type: 'single', stakeCents: 1000, payoutCents: 0, placedAt: iso(NOW - 20 * H), settledAt: iso(NOW - 5 * H), legs: [leg({})], ...o });

const BETS = [
  bet('won', { status: 'won', payoutCents: 1909, settledAt: iso(NOW - 1 * H) }),
  bet('lost', { status: 'lost', stakeCents: 500, settledAt: iso(NOW - 2 * H), legs: [leg({ league: 'mlb', label: 'Rays -1.5', gameLabel: 'Rays @ Guardians', marketType: 'spread' })] }),
  bet('push', { status: 'push', payoutCents: 2000, stakeCents: 2000, settledAt: iso(NOW - 3 * H), placedAt: iso(NOW - 40 * 24 * H) }),
  bet('cashed', { status: 'cashed_out', type: 'parlay', payoutCents: 2210, cashoutCents: 2210, settledAt: iso(NOW - 0.5 * H), legs: [leg({}), leg({ gameId: 'custom:abc', label: 'Backyard Bears -3.5', gameLabel: 'Lawn Lions @ Backyard Bears', marketType: 'spread' })] }),
  bet('void', { status: 'void', payoutCents: 700, stakeCents: 700, settledAt: iso(NOW - 4 * H), legs: [leg({ league: 'crypto', gameId: 'crypto:KXBTC15M-26OCT181230', marketType: 'crypto', label: 'BTC Up (≥ $81,931.55, 12:30 PM)', gameLabel: 'Bitcoin · 15 min · closes 12:30 PM', startTime: iso(NOW + H) })] }),
  bet('chal', { status: 'won', payoutCents: 3500, posterBet: true, placedAt: iso(NOW - 2 * H), settledAt: iso(NOW - 10 * H), legs: [leg({ league: 'challenge', gameId: 'challenge:u1_x', marketType: 'challenge', label: 'Yes', gameLabel: 'Will Mike run a 5K?', startTime: iso(NOW + 5 * H) })] }),
  bet('live', { status: 'lost', placedAt: iso(NOW - 8 * H), settledAt: iso(NOW - 6 * H) }), // placed after its 10-hours-ago start
];
const ids = (list) => list.map((b) => b.id);

test('profit and returned: a loss is −stake; cash outs count their cash out value', () => {
  assert.equal(F.profitCents(BETS[0]), 909);
  assert.equal(F.profitCents(BETS[1]), -500);
  assert.equal(F.profitCents(BETS[2]), 0);
  assert.equal(F.returnedCents(BETS[3]), 2210);
});

test('sorts: settled newest (default) / oldest, placed newest, stake, profit', () => {
  assert.deepEqual(ids(F.sortBets(BETS)), ['cashed', 'won', 'lost', 'push', 'void', 'live', 'chal']);
  assert.deepEqual(ids(F.sortBets(BETS, 'settledAsc')).slice(0, 2), ['chal', 'live']);
  assert.equal(F.sortBets(BETS, 'placedDesc')[0].id, 'chal');
  assert.equal(F.sortBets(BETS, 'stakeDesc')[0].id, 'push');
  assert.deepEqual(ids(F.sortBets(BETS, 'profitDesc')).slice(0, 2), ['chal', 'cashed']);
});

test('filters: result, date placed (Central), category, type, market, live/pre-game, stake, text, poster — combinable', () => {
  const f = (o) => ids(F.filterBets(BETS, { ...F.DEFAULT_FILTERS, ...o }, NOW)).sort();
  assert.deepEqual(f({}), ids(BETS).sort(), 'no filters: everything');
  assert.deepEqual(f({ results: ['won', 'cashed_out'] }), ['cashed', 'chal', 'won']);
  assert.deepEqual(f({ date: 'today' }), ['chal', 'live'], 'placed since midnight Central');
  assert.ok(!f({ date: 'last30' }).includes('push'), '40 days ago is out of the last 30');
  assert.deepEqual(f({ date: 'custom', from: '2026-09-08', to: '2026-09-08' }), ['push'], 'custom dates are inclusive');
  assert.deepEqual(f({ categories: ['custom'] }), ['cashed'], 'a parlay matches if any leg does');
  assert.deepEqual(f({ categories: ['crypto', 'challenge'] }), ['chal', 'void']);
  assert.deepEqual(f({ categories: ['mlb'] }), ['lost']);
  assert.deepEqual(f({ type: 'parlay' }), ['cashed']);
  assert.deepEqual(f({ markets: ['spread'] }), ['cashed', 'lost']);
  assert.deepEqual(f({ timing: 'live' }), ['live']);
  assert.ok(!f({ timing: 'pre' }).includes('live'));
  assert.deepEqual(f({ stakeMin: '7', stakeMax: '20' }), ['cashed', 'chal', 'live', 'push', 'void', 'won']);
  assert.deepEqual(f({ stakeMax: '5' }), ['lost']);
  assert.deepEqual(f({ text: 'BACKYARD' }), ['cashed']);
  assert.deepEqual(f({ text: 'bitcoin' }), ['void']);
  assert.deepEqual(f({ text: '5k' }), ['chal']);
  assert.deepEqual(f({ posterOnly: true }), ['chal']);
  assert.deepEqual(f({ results: ['won'], categories: ['nfl'], timing: 'pre' }), ['won'], 'combined');
});

test('active filter count and the summary line', () => {
  assert.equal(F.activeFilterCount(F.DEFAULT_FILTERS), 0);
  assert.equal(F.activeFilterCount({ ...F.DEFAULT_FILTERS, results: ['won'], text: 'x', date: 'custom' }), 2, 'custom dates with no dates yet do not count');
  const s = F.summarize(BETS);
  assert.equal(s.count, 7);
  assert.equal(s.stakedCents, 1000 + 500 + 2000 + 1000 + 700 + 1000 + 1000);
  assert.equal(s.returnedCents, 1909 + 0 + 2000 + 2210 + 700 + 3500 + 0);
  assert.equal(s.netCents, s.returnedCents - s.stakedCents);
  assert.equal(s.won, 2);
  assert.equal(s.lost, 2);
  assert.equal(s.winRate, 0.5, 'pushes, voids and cash outs are left out');
  assert.equal(F.summarize([]).winRate, null);
});

test('the remembered view survives junk and keeps only known values', () => {
  assert.deepEqual(F.cleanView(null), { sort: F.DEFAULT_SORT, filters: { ...F.DEFAULT_FILTERS } });
  const v = F.cleanView({ sort: 'profitDesc', filters: { results: ['won', 'nope'], date: 'custom', from: '2026-10-01', to: 'bad', categories: ['nba', 'x'], timing: 'live', text: 7, posterOnly: 'yes' } });
  assert.equal(v.sort, 'profitDesc');
  assert.deepEqual(v.filters.results, ['won']);
  assert.deepEqual([v.filters.from, v.filters.to], ['2026-10-01', '']);
  assert.deepEqual(v.filters.categories, ['nba']);
  assert.equal(v.filters.text, '');
  assert.equal(v.filters.posterOnly, false);
  assert.equal(F.cleanView({ sort: 'evil' }).sort, F.DEFAULT_SORT);
});
