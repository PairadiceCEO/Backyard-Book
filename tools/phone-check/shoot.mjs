// node shoot.mjs <outDir> [scenario-filter]
// Drives the real app (mocked Firebase + /api) at phone widths: screenshots, horizontal overflow, small tap targets.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as F from './fixtures.mjs';

const BASE = 'http://localhost:5199';
const out = process.argv[2];
const only = process.argv[3] ? new RegExp(process.argv[3]) : null;
mkdirSync(out, { recursive: true });

const fsDefault = { users: F.users, bets: F.bets, ledger: F.ledger, customGames: F.customGames, battles: F.battles, challenges: F.challenges };
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function routeApi(page, mode) {
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const body = req.postDataJSON?.() ?? null;
    if (mode.apiDown) return json(route, 502, { error: { code: 'UPSTREAM_UNAVAILABLE', message: "ESPN didn't answer. Try again in a moment." } });
    if (u.pathname === '/api/board') {
      if (u.searchParams.get('league') === 'crypto') {
        if (u.searchParams.get('game')) return json(route, 200, F.cryptoCoin(u.searchParams.get('game'), { noChart: Boolean(mode.noChart) }));
        return json(route, 200, F.cryptoBoard());
      }
      if (u.searchParams.get('game')) return json(route, 200, F.gameDetail(u.searchParams.get('game')));
      if (u.searchParams.get('league') === 'custom') return json(route, 200, F.customBoard());
      if (u.searchParams.get('league') === 'live') return json(route, 200, F.liveBoard(Boolean(mode.noLive)));
      return json(route, 200, F.board(u.searchParams.get('league')));
    }
    if (u.pathname === '/api/settle') return json(route, 200, body?.preview || body?.force ? F.settlePreview : { ran: false });
    if (u.pathname === '/api/casino') {
      if (body?.action === 'bet' || body?.action === 'bets') await new Promise((r) => setTimeout(r, 4000)); // chips stay 'pending' on screen
      if (body?.action !== 'spin') return json(route, 200, { ok: true, applied: false, seat: 1, seated: true, serverNow: Date.now() });
      return json(route, 200, { ok: true, duplicate: false, stops: [14, 5, 4], symbols: ['R7', 'R7', 'R7'], line: { id: 'red7x3', label: 'Red 7 · Red 7 · Red 7', pays: 300 }, betCents: 200, winCents: 60000, balanceCents: 69440, serverNow: Date.now() });
    }
    if (u.pathname === '/api/bets' && body?.mode && mode.oddsChanged) {
      const changes = (body.legs ?? []).slice(0, 2).map((l, i) => ({ legId: l.legId, oldAmerican: l.quotedAmerican, newAmerican: i ? -175 : 165, quote: { american: i ? -175 : 165, decimal: i ? 1.5714 : 2.65, line: l.line ?? null, source: 'espn', ref: null } }));
      return json(route, 409, { error: { code: 'ODDS_CHANGED', message: 'Some odds moved. Accept the new odds or remove the picks.', oddsChanges: changes, lineChanges: [], closedLegs: [] } });
    }
    if (u.pathname === '/api/bets' && body?.action === 'cashoutQuote') {
      return json(route, 200, { ok: true, quotes: {
        b1: { available: true, valueCents: mode.quoteCents ?? 2147, mode: 'live' },
        b2: { available: false, valueCents: null, reason: 'Cash out closes once a custom game starts.' },
      } });
    }
    if (u.pathname === '/api/bets' && body?.action === 'cashout') {
      mode.cashoutCalls = (mode.cashoutCalls ?? 0) + 1;
      if (mode.changed && body.expectedCents !== 2098) return json(route, 409, { error: { code: 'CASHOUT_CHANGED', message: 'The cash out value changed to $20.98.', valueCents: 2098 } });
      if (mode.unavailable) return json(route, 409, { error: { code: 'CASHOUT_UNAVAILABLE', message: 'Cash out unavailable right now', reason: 'Cash out unavailable right now' } });
      return json(route, 200, { ok: true, duplicate: false, cashoutCents: body.expectedCents, balanceCents: 14287, bet: { id: body.betId } });
    }
    if (u.pathname === '/api/shop') return json(route, 200, { ok: true, balanceCents: 12140 });
    if (u.pathname === '/api/battles' && body?.action === 'postChallenge') return json(route, 200, { ok: true, challengeId: 'c-pend', duplicate: false });
    if (u.pathname === '/api/battles') return json(route, 200, { ok: true, battleId: 'b-inv', balanceCents: 7640 });
    if (u.pathname === '/api/admin' && /^challenge(Settle|Void)$/.test(body?.action ?? '')) return json(route, 200, body.confirm ? { ok: true, settlement: { settled: 6, stillOpen: 1 } } : F.challengeSettlePreview);
    if (u.pathname === '/api/admin' && /^challenge/.test(body?.action ?? '')) return json(route, 200, { ok: true, challengeId: body.challengeId });
    if (u.pathname === '/api/admin' && /^battle/.test(body?.action ?? '')) return json(route, 200, F.battlePreview);
    if (u.pathname === '/api/admin') {
      if (body?.action === 'gradeBet' || body?.action === 'setLegResult') return json(route, 200, F.regradePreview);
      return json(route, 200, { ok: true, admin: true, username: 'will' });
    }
    return json(route, 404, { error: { code: 'NOT_FOUND', message: 'nope' } });
  });
}

// Baccarat table docs (casinoTables/baccarat) for each screen state.
const seat = (uid, name, extra = {}) => ({ uid, name, sitAt: Date.now() - 60000, leaving: false, ready: false, bets: { player: 0, banker: 0, tie: 0 }, result: null, reqs: [], ...extra });
const shoeResults = 'TBPPBTBBPBPPBBBPTPBPBBBBBBBBBPPBPTBPPPBBPBTPPBPBBPPPPPPPBPBTBBPBPBPPBBBBPBPTTPBBPB';
const bacTable = (extra) => ({ id: 'baccarat', game: 'baccarat', epoch: 'x', roundNo: 41, roundId: 'x-41', phase: 'betting', deadline: null, coup: null, shoeResults, shoe: { remaining: 211, total: 416, shuffles: 1 }, version: 9, seats: [null, null, null, null, null], ...extra });
const coup = (dealtAgoMs) => ({ player: ['KS0', '4H2', '3D1'], banker: ['9C3', 'QD0'], playerTotal: 7, bankerTotal: 9, winner: 'banker', natural: true, dealtAt: Date.now() - dealtAgoMs });
const tables = {
  lobby: () => bacTable({ deadline: Date.now() + 9000, seats: [seat('u0', 'Will', { bets: { player: 500, banker: 0, tie: 0 } }), null, seat('u2', 'Dan'), null, null] }),
  watch: () => bacTable({ deadline: Date.now() + 12000, seats: [seat('u0', 'Will', { bets: { player: 500, banker: 0, tie: 0 }, ready: true }), null, seat('u2', 'Dan', { bets: { player: 0, banker: 300, tie: 100 } }), null, seat('u4', 'Alexandra the Great')] }),
  betting: () => bacTable({ deadline: Date.now() + 12000, seats: [seat('u0', 'Will', { bets: { player: 500, banker: 0, tie: 0 }, ready: true }), seat('u1', 'Mike the Bookie Slayer', { bets: { player: 0, banker: 300, tie: 100 } }), seat('u2', 'Dan'), null, null] }),
  results: () => bacTable({ phase: 'results', deadline: Date.now() + 4000, coup: coup(60000), seats: [seat('u0', 'Will', { bets: { player: 500, banker: 0, tie: 0 }, ready: true, result: { stakeCents: 500, returnCents: 0, netCents: -500 } }), seat('u1', 'Mike', { bets: { player: 0, banker: 300, tie: 100 }, ready: true, result: { stakeCents: 400, returnCents: 585, netCents: 185 } }), seat('u2', 'Dan'), null, null] }),
  dealing: () => bacTable({ phase: 'results', deadline: Date.now() + 9000, coup: coup(800), seats: [null, seat('u1', 'Mike', { bets: { player: 0, banker: 300, tie: 0 }, ready: true, result: { stakeCents: 300, returnCents: 585, netCents: 285 } }), null, null, null] }),
  full: () => bacTable({ seats: ['u0', 'u2', 'u4', 'u5', 'u6'].map((u, i) => seat(u, ['Will', 'Dan', 'Ann', 'Bo', 'Cy'][i])) }),
};
// Blackjack table docs (casinoTables/blackjack).
const bjSeat = (uid, name, extra = {}) => ({ uid, name, sitAt: Date.now() - 60000, leaving: false, reqs: [], betCents: 0, stakeCents: 0, returnCents: 0, insurance: null, hands: [], result: null, ...extra });
const hand = (cards, extra = {}) => ({ cards, betCents: 500, status: 'playing', seq: 0, fromSplit: false, splitAces: false, doubled: false, outcome: null, ...extra });
const oldDeal = () => ({ at: Date.now() - 60000, cards: [] });
const bjTable = (extra) => ({ id: 'blackjack', game: 'blackjack', epoch: 'y', roundNo: 7, roundId: 'y-7', phase: 'betting', deadline: null, turn: null, dealer: { cards: [], holeDown: false }, lastDeal: null, shoe: { remaining: 248, total: 312, shuffles: 0 }, version: 30, seats: [null, null, null, null, null], ...extra });
const bj = {
  betting: () => bjTable({ deadline: Date.now() + 11000, seats: [bjSeat('u0', 'Will', { betCents: 500, stakeCents: 500 }), bjSeat('u1', 'Mike the Bookie Slayer'), null, bjSeat('u2', 'Dan'), null] }),
  insurance: () => bjTable({ phase: 'insurance', deadline: Date.now() + 12000, lastDeal: oldDeal(), dealer: { cards: ['AS0'], holeDown: true }, seats: [bjSeat('u0', 'Will', { betCents: 500, stakeCents: 500, hands: [hand(['TS1', '9H0'])] }), bjSeat('u1', 'Mike', { betCents: 500, stakeCents: 500, hands: [hand(['8C0', '8D2'])] }), null, null, null] }),
  myTurn: () => bjTable({ phase: 'playing', deadline: Date.now() + 9000, lastDeal: oldDeal(), turn: { seat: 1, hand: 0 }, dealer: { cards: ['6H0'], holeDown: true }, seats: [bjSeat('u0', 'Will', { betCents: 500, hands: [hand(['TS1', '9H0'], { status: 'stood' })] }), bjSeat('u1', 'Mike', { betCents: 500, stakeCents: 500, hands: [hand(['8C0', '8D2'])] }), null, bjSeat('u2', 'Dan', { betCents: 200, hands: [hand(['AS3', 'KD1'], { status: 'blackjack', outcome: 'blackjack', betCents: 200 })] }), null] }),
  split: () => bjTable({ phase: 'playing', deadline: Date.now() + 9000, lastDeal: oldDeal(), turn: { seat: 1, hand: 1 }, dealer: { cards: ['6H0'], holeDown: true }, seats: [null, bjSeat('u1', 'Mike', { betCents: 500, stakeCents: 1500, hands: [hand(['8C0', '3D2', 'TS4'], { status: 'stood', fromSplit: true, betCents: 1000, doubled: true }), hand(['8D2', '9S0'], { fromSplit: true, seq: 0 })] }), null, null, null] }),
  otherTurn: () => bjTable({ phase: 'playing', deadline: Date.now() + 6000, lastDeal: oldDeal(), turn: { seat: 0, hand: 0 }, dealer: { cards: ['9H3'], holeDown: true }, seats: [bjSeat('u0', 'Will', { betCents: 500, hands: [hand(['5S1', '4H0', '2C0'], { seq: 1 })] }), bjSeat('u1', 'Mike', { betCents: 500, hands: [hand(['QC0', '7D2'])] }), null, null, null] }),
  results: () => bjTable({ phase: 'results', deadline: Date.now() + 4000, finish: 'played', lastDeal: oldDeal(), dealer: { cards: ['6H0', 'TC1', '8D0'], holeDown: false }, seats: [bjSeat('u0', 'Will', { betCents: 500, hands: [hand(['TS1', '9H0'], { status: 'done', outcome: 'win' })], result: { stakeCents: 500, returnCents: 1000, netCents: 500 } }), bjSeat('u1', 'Mike', { betCents: 500, hands: [hand(['8C0', '3D2', 'TS4'], { status: 'done', outcome: 'win', fromSplit: true, betCents: 1000 }), hand(['8D2', '9S0', 'KH1'], { status: 'done', outcome: 'bust', fromSplit: true })], result: { stakeCents: 1500, returnCents: 2000, netCents: 500 } }), null, null, null] }),
  dealing: () => bjTable({ phase: 'playing', deadline: Date.now() + 18000, turn: { seat: 0, hand: 0 }, lastDeal: { at: Date.now() - 1300, cards: [{ to: '0-0', i: 0 }, { to: '1-0', i: 0 }, { to: 'd', i: 0 }, { to: '0-0', i: 1 }, { to: '1-0', i: 1 }, { to: 'd', i: 1 }] }, dealer: { cards: ['KH0'], holeDown: true }, seats: [bjSeat('u0', 'Will', { betCents: 500, hands: [hand(['5S1', '4H0'])] }), bjSeat('u1', 'Mike', { betCents: 500, hands: [hand(['QC0', '7D2'])] }), null, null, null] }),
};
// Craps / Crapless table docs.
const crSeat = (uid, name, bets = {}, extra = {}) => ({ uid, name, sitAt: Date.now() - 60000, leaving: false, reqs: [], bets: { pass: 0, dontPass: 0, odds: 0, field: 0, place: {}, ...bets }, lastRoll: null, ...extra });
const crRolls = [8, 6, 7, 4, 9, 9, 5, 11, 7, 6, 8, 3, 6, 10, 2, 6, 7, 12, 8, 6].map((t, i) => ({ d: [Math.min(6, t - 1), Math.max(1, t - Math.min(6, t - 1))], t, k: t === 7 ? 'sevenOut' : i % 5 === 0 ? 'pointMade' : 'roll' }));
const crTable = (game, extra) => ({ id: game, game, epoch: 'z', rollSeq: 57, point: null, shooter: 1, deadline: null, waiting: false, lap: 0, rolls: crRolls, moneySeq: 3, lastRoll: { dice: [4, 2], total: 6, at: Date.now() - 60000, kind: 'pointMade', pointBefore: 6, seq: 57, shooter: 1 }, version: 80, seats: [null, null, null, null, null], ...extra });
const cr = {
  comeout: () => crTable('craps', { deadline: Date.now() + 12000, seats: [crSeat('u0', 'Will', { dontPass: 500 }), crSeat('u1', 'Mike the Bookie Slayer', { pass: 500, place: { 6: 600 } }, { lastRoll: { seq: 57, netCents: 1083, profitCents: 1083, lostCents: 0, returnCents: 1583 } }), null, crSeat('u2', 'Dan', { field: 200 }), null] }),
  point: () => crTable('craps', { point: 6, deadline: Date.now() + 9000, lastRoll: { dice: [5, 1], total: 6, at: Date.now() - 60000, kind: 'point', pointBefore: null, seq: 57, shooter: 1 }, seats: [crSeat('u0', 'Will', { dontPass: 500 }), crSeat('u1', 'Mike', { pass: 500, odds: 1000, place: { 6: 600, 8: 600, 5: 500 }, field: 100 }), null, crSeat('u2', 'Dan', { place: { 4: 500 } }), null] }),
  rolling: () => crTable('craps', { point: null, deadline: null, lastRoll: { dice: [3, 4], total: 7, at: Date.now() - 200, kind: 'sevenOut', pointBefore: 6, seq: 57, shooter: 1 }, shooter: 3, seats: [crSeat('u0', 'Will'), crSeat('u1', 'Mike'), null, crSeat('u2', 'Dan'), null] }),
  crapless: () => ({ ...crTable('crapless', { point: 11, deadline: Date.now() + 9000, seats: [null, crSeat('u1', 'Mike', { pass: 500, odds: 500, place: { 2: 200, 12: 200, 6: 600 } }), crSeat('u0', 'Will', { pass: 100 }), null, null] }) }),
  watch: () => crTable('craps', { point: 8, deadline: Date.now() + 9000, shooter: 0, seats: [crSeat('u0', 'Will', { pass: 500 }), null, crSeat('u2', 'Dan', { field: 300 }), null, null] }),
};
const withTable = (make) => () => ({ ...fsDefault, casinoTables: make ? [make()] : [] });
// Several seats per player (Mike = u1) and the new craps bets.
const bjTwo = {
  betting: () => bjTable({ deadline: Date.now() + 11000, seats: [bjSeat('u0', 'Will', { betCents: 500, stakeCents: 500, ready: true }), bjSeat('u1', 'Mike the Bookie Slayer', { betCents: 300, stakeCents: 300 }), null, bjSeat('u1', 'Mike the Bookie Slayer'), null] }),
  myTurn: () => bjTable({ phase: 'playing', deadline: Date.now() + 9000, lastDeal: oldDeal(), turn: { seat: 3, hand: 0 }, dealer: { cards: ['6H0'], holeDown: true }, seats: [bjSeat('u0', 'Will', { betCents: 500, hands: [hand(['TS1', '9H0'], { status: 'stood' })] }), bjSeat('u1', 'Mike', { betCents: 500, stakeCents: 500, hands: [hand(['8C0', '8D2'], { status: 'stood' })] }), null, bjSeat('u1', 'Mike', { betCents: 1000, stakeCents: 1000, hands: [hand(['5C0', '6D2'], { betCents: 1000 })] }), null] }),
};
const bacTwo = () => bacTable({ deadline: Date.now() + 12000, seats: [seat('u0', 'Will', { bets: { player: 500, banker: 0, tie: 0 }, ready: true }), seat('u1', 'Mike', { bets: { player: 0, banker: 300, tie: 100 } }), null, seat('u1', 'Mike', { bets: { player: 1000, banker: 0, tie: 0 } }), null] });
const crNew = () => crTable('craps', { point: 6, deadline: Date.now() + 9000, lastRoll: { dice: [5, 1], total: 6, at: Date.now() - 60000, kind: 'point', pointBefore: null, seq: 57, shooter: 1 }, seats: [crSeat('u0', 'Will', { dontPass: 500, dontOdds: 1000 }), crSeat('u1', 'Mike', { pass: 1000, odds: 2000, come: 500, comeOn: { 5: { bet: 500, odds: 1000 }, 9: { bet: 300, odds: 0 } }, hard: { 6: 200, 8: 200 }, place: { 8: 600 }, field: 100 }), null, crSeat('u2', 'Dan', { place: { 4: 500 } }), null] });
// One player at the table: no shooter clock (deadline null), even with a point on.
const crSolo = () => crTable('craps', { point: 8, deadline: null, shooter: 1, seats: [null, crSeat('u1', 'Mike', { pass: 500, odds: 1000 }), null, null, null] });
const crDont = () => crTable('craps', { point: 4, deadline: Date.now() + 9000, seats: [null, crSeat('u1', 'Mike', { dontPass: 1000, dontOdds: 500 }), null, null, null] });


const S = (name, path, opts = {}) => ({ name, path, user: 'u0', admin: true, fs: fsDefault, ...opts });
const scenarios = [
  S('login', '/login', { user: null }),
  S('sportsbook', '/sportsbook', { admin: false, user: 'u1' }),
  S('sportsbook-slip-bar', '/sportsbook', { admin: false, user: 'u1', act: async (p) => { await clickPrices(p, 3); } }),
  S('sportsbook-slip-open', '/sportsbook', { admin: false, user: 'u1', act: async (p) => { await clickPrices(p, 3); await openSlip(p); } }),
  S('sportsbook-slip-parlay', '/sportsbook', { admin: false, user: 'u1', act: async (p) => { await clickPrices(p, 3); await openSlip(p); await p.getByRole('tab', { name: 'Parlay' }).click(); } }),
  S('sportsbook-odds-changed', '/sportsbook', { admin: false, user: 'u1', oddsChanged: true, act: async (p) => { await clickPrices(p, 2); await openSlip(p); for (const input of await p.locator('.stake-field input').all()) await input.fill('5'); await p.getByRole('button', { name: /^Place/ }).click(); await p.waitForTimeout(400); } }),
  S('sportsbook-empty', '/sportsbook', { admin: false, user: 'u1', act: async (p) => { await p.getByRole('tab', { name: 'NBA' }).click(); await p.waitForTimeout(300); } }),
  S('sportsbook-error', '/sportsbook', { admin: false, user: 'u1', apiDown: true }),
  S('game-detail', '/sportsbook/nfl/401', { admin: false, user: 'u1' }),
  S('my-bets', '/my-bets', { admin: false, user: 'u1' }),
  S('my-bets-cashout-confirm', '/my-bets', { admin: false, user: 'u1', act: async (p) => { await p.getByRole('button', { name: 'Cash out $21.47' }).click(); await p.waitForTimeout(200); } }),
  S('my-bets-cashout-changed', '/my-bets', { admin: false, user: 'u1', changed: true, act: async (p) => { await p.getByRole('button', { name: 'Cash out $21.47' }).click(); await p.getByRole('dialog').getByRole('button', { name: 'Cash out $21.47' }).click(); await p.waitForTimeout(300); } }),
  S('my-bets-cashout-unavailable', '/my-bets', { admin: false, user: 'u1', unavailable: true, act: async (p) => { await p.getByRole('button', { name: 'Cash out $21.47' }).click(); await p.getByRole('dialog').getByRole('button', { name: 'Cash out $21.47' }).click(); await p.waitForTimeout(300); } }),
  S('my-bets-cashout-done', '/my-bets', { admin: false, user: 'u1', act: async (p) => { await p.getByRole('button', { name: 'Cash out $21.47' }).click(); await p.getByRole('dialog').getByRole('button', { name: 'Cash out $21.47' }).click(); await p.waitForTimeout(300); } }),
  S('my-bets-filters', '/my-bets', { admin: false, user: 'u1', act: async (p) => { await p.getByRole('button', { name: /^Filters/ }).click(); await p.locator('.filters-panel').getByRole('button', { name: 'Won', exact: true }).click(); await p.locator('.filters-panel').getByRole('button', { name: 'NFL', exact: true }).click(); await p.waitForTimeout(150); } }),
  S('my-bets-filters-dates', '/my-bets', { admin: false, user: 'u1', act: async (p) => { await p.getByRole('button', { name: /^Filters/ }).click(); await p.getByLabel('Date placed').selectOption('custom'); await p.getByPlaceholder('Team, game, Challenge or coin').fill('zzz'); await p.waitForTimeout(150); } }),
  S('my-bets-history', '/my-bets', { admin: false, user: 'u7', fs: { ...fsDefault, users: [...F.users, F.heavyUser], bets: F.heavyBets('u7', 260) }, act: async (p) => { await p.waitForTimeout(500); } }),
  S('my-bets-empty', '/my-bets', { admin: false, user: 'u9', fs: { ...fsDefault, users: [...F.users, { id: 'u9', username: 'newbie', balanceCents: 10000, stats: { won: 0, lost: 0 } }] } }),
  S('my-bets-error', '/my-bets', { admin: false, user: 'u1', fs: { ...fsDefault, bets: { error: 'The query requires an index.' } } }),
  S('leaderboard', '/leaderboard', { admin: false, user: 'u1' }),
  S('leaderboard-error', '/leaderboard', { admin: false, user: 'u1', fs: { ...fsDefault, users: { error: 'Missing or insufficient permissions.' } } }),
  S('shop', '/shop', { admin: false, user: 'u1' }),
  S('casino-lobby', '/casino', { admin: false, user: 'u1', fs: withTable(tables.lobby) }),
  S('casino-lobby-seated', '/casino', { admin: false, user: 'u1', fs: withTable(tables.betting) }),
  S('bac-empty', '/casino/baccarat', { admin: false, user: 'u1', fs: withTable(null) }),
  S('bac-watch', '/casino/baccarat', { admin: false, user: 'u1', fs: withTable(tables.watch) }),
  S('bac-betting', '/casino/baccarat', { admin: false, user: 'u1', fs: withTable(tables.betting) }),
  S('bac-betting-chip', '/casino/baccarat', { admin: false, user: 'u1', fs: withTable(tables.betting), act: async (p) => { await p.getByRole('radio', { name: '$5' }).click(); await p.getByRole('button', { name: /Player, pays/ }).click(); await p.waitForTimeout(150); } }),
  S('bac-dealing', '/casino/baccarat', { admin: false, user: 'u1', fs: withTable(tables.dealing) }),
  S('bac-results', '/casino/baccarat', { admin: false, user: 'u1', fs: withTable(tables.results) }),
  S('bac-roads-derived', '/casino/baccarat', { admin: false, user: 'u1', fs: withTable(tables.watch), act: async (p) => { await p.getByRole('tab', { name: 'Derived roads' }).click(); await p.waitForTimeout(150); } }),
  S('bac-new-shoe', '/casino/baccarat', { admin: false, user: 'u1', fs: withTable(() => ({ ...tables.watch(), shoeResults: '' })) }),
  S('bj-lobby', '/casino', { admin: false, user: 'u1', fs: () => ({ ...fsDefault, casinoTables: [bj.betting(), tables.lobby()] }) }),
  S('bj-betting', '/casino/blackjack', { admin: false, user: 'u1', fs: withTable(bj.betting) }),
  S('bj-betting-chips', '/casino/blackjack', { admin: false, user: 'u1', fs: withTable(bj.betting), act: async (p) => { await p.getByRole('radio', { name: '$5 chip' }).click(); await p.locator('.bj-bet-spot').click(); await p.getByRole('radio', { name: '$2 chip' }).click(); await p.locator('.bj-bet-spot').click(); await p.getByRole('radio', { name: '$1 chip' }).click(); await p.locator('.bj-bet-spot').click(); await p.waitForTimeout(100); } }),
  S('bj-insurance', '/casino/blackjack', { admin: false, user: 'u1', fs: withTable(bj.insurance) }),
  S('bj-my-turn', '/casino/blackjack', { admin: false, user: 'u1', fs: withTable(bj.myTurn) }),
  S('bj-split', '/casino/blackjack', { admin: false, user: 'u1', fs: withTable(bj.split) }),
  S('bj-other-turn', '/casino/blackjack', { admin: false, user: 'u1', fs: withTable(bj.otherTurn) }),
  S('bj-dealing', '/casino/blackjack', { admin: false, user: 'u1', fs: withTable(bj.dealing) }),
  S('bj-results', '/casino/blackjack', { admin: false, user: 'u1', fs: withTable(bj.results) }),
  S('bj-watch', '/casino/blackjack', { admin: false, user: 'u9', fs: () => ({ ...withTable(bj.otherTurn)(), users: [...F.users, { id: 'u9', username: 'newbie', displayName: 'Newbie', balanceCents: 10000, stats: { won: 0, lost: 0 } }] }) }),
  S('cr-lobby', '/casino', { admin: false, user: 'u1', fs: () => ({ ...fsDefault, casinoTables: [bj.betting(), tables.lobby(), cr.point(), cr.crapless()] }) }),
  S('cr-comeout', '/casino/craps', { admin: false, user: 'u1', fs: withTable(cr.comeout) }),
  S('cr-point', '/casino/craps', { admin: false, user: 'u1', fs: withTable(cr.point) }),
  S('cr-takedown', '/casino/craps', { admin: false, user: 'u1', fs: withTable(cr.point), act: async (p) => { await p.getByRole('button', { name: 'Take down' }).click(); await p.waitForTimeout(100); } }),
  S('cr-chips', '/casino/craps', { admin: false, user: 'u1', fs: withTable(cr.point), act: async (p) => { await p.getByRole('radio', { name: '$5 chip' }).click(); await p.locator('.craps-place .craps-spot').nth(2).click(); await p.locator('.craps-place .craps-spot').nth(2).click(); await p.getByRole('radio', { name: '$2 chip' }).click(); await p.locator('.craps-spot.band.odds').click(); await p.waitForTimeout(100); } }),
  S('cr-rolling', '/casino/craps', { admin: false, user: 'u1', fs: withTable(cr.rolling) }),
  S('cr-crapless', '/casino/crapless', { admin: false, user: 'u1', fs: withTable(cr.crapless) }),
  S('cr-watch', '/casino/craps', { admin: false, user: 'u1', fs: withTable(cr.watch) }),
  S('bac-full', '/casino/baccarat', { admin: false, user: 'u1', fs: withTable(tables.full) }),
  S('casino-slots', '/casino/slots', { admin: false, user: 'u1' }),
  S('casino-slots-chips', '/casino/slots', { admin: false, user: 'u1', act: async (p) => { await p.getByRole('radio', { name: '$5 chip' }).click(); await p.locator('.slot-bet').click(); await p.getByRole('radio', { name: '$2 chip' }).click(); await p.locator('.slot-bet').click(); await p.waitForTimeout(100); } }),
  S('casino-slots-spinning', '/casino/slots', { admin: false, user: 'u1', act: async (p) => { await p.getByRole('button', { name: /^Spin/ }).click(); await p.waitForTimeout(300); } }),
  S('casino-slots-win', '/casino/slots', { admin: false, user: 'u1', act: async (p) => { await p.getByRole('radio', { name: '$1 chip' }).click(); await p.locator('.slot-bet').click(); await p.getByRole('button', { name: /^Spin/ }).click(); await p.waitForTimeout(2200); } }),
  
  S('admin-players', '/admin'),
  S('bj-two-seats-betting', '/casino/blackjack', { admin: false, user: 'u1', fs: withTable(bjTwo.betting) }),
  S('bj-two-seats-turn', '/casino/blackjack', { admin: false, user: 'u1', fs: withTable(bjTwo.myTurn) }),
  S('bac-two-seats', '/casino/baccarat', { admin: false, user: 'u1', fs: withTable(bacTwo) }),
  S('bac-two-seats-tab2', '/casino/baccarat', { admin: false, user: 'u1', fs: withTable(bacTwo), act: async (p) => { await p.getByRole('tab', { name: /Seat 4/ }).click(); await p.waitForTimeout(150); } }),
  S('cr-come-hard', '/casino/craps', { admin: false, user: 'u1', fs: withTable(crNew) }),
  S('cr-dont-odds', '/casino/craps', { admin: false, user: 'u1', fs: withTable(crDont) }),
  S('sportsbook-live', '/sportsbook', { admin: false, user: 'u1', act: async (p) => { await p.getByRole('tab', { name: 'Live' }).click(); await p.waitForTimeout(400); } }),
  S('sportsbook-live-empty', '/sportsbook', { admin: false, user: 'u1', noLive: true, act: async (p) => { await p.getByRole('tab', { name: 'Live' }).click(); await p.waitForTimeout(400); } }),
  S('sportsbook-crypto', '/sportsbook', { admin: false, user: 'u1', act: async (p) => { await p.getByRole('tab', { name: 'Crypto' }).click(); await p.waitForTimeout(400); } }),
  S('sportsbook-crypto-pick', '/sportsbook', { admin: false, user: 'u1', act: async (p) => { await p.getByRole('tab', { name: 'Crypto' }).click(); await p.waitForTimeout(400); await p.locator('.crypto-card .odds-button').first().click(); await openSlip(p); } }),
  S('crypto-coin', '/sportsbook/crypto/btc', { admin: false, user: 'u1' }),
  S('crypto-coin-scrub', '/sportsbook/crypto/btc', { admin: false, user: 'u1', act: async (p) => { await p.evaluate(() => { const svg = document.querySelector('svg.crypto-chart'); const r = svg.getBoundingClientRect(); for (const [type, f] of [['pointerdown', 0.1], ['pointermove', 0.2]]) svg.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 3, pointerType: 'touch', isPrimary: true, clientX: r.left + r.width * f, clientY: r.top + r.height / 2 })); }); await p.waitForTimeout(150); } }),
  S('crypto-coin-pick', '/sportsbook/crypto/btc', { admin: false, user: 'u1', act: async (p) => { await p.locator('.crypto-ladder .odds-button').nth(3).click(); await p.waitForTimeout(200); } }),
  S('crypto-coin-closing', '/sportsbook/crypto/eth', { admin: false, user: 'u1' }),
  S('crypto-coin-15m-only', '/sportsbook/crypto/near', { admin: false, user: 'u1' }),
  S('crypto-coin-no-chart', '/sportsbook/crypto/sol', { admin: false, user: 'u1', noChart: true }),
  S('cr-solo', '/casino/craps', { admin: false, user: 'u1', fs: withTable(crSolo) }),
  S('sportsbook-custom', '/sportsbook', { admin: false, user: 'u1', act: async (p) => { await p.getByRole('tab', { name: /^Custom/ }).click(); await p.waitForTimeout(400); } }),
  S('battle-new', '/sportsbook/battles/new', { admin: false, user: 'u1', act: async (p) => { await p.getByLabel('Title').fill('Saturday golf'); await p.getByRole('button', { name: 'Dan' }).click(); await p.getByRole('button', { name: 'Ann' }).click(); await p.getByRole('button', { name: '70 / 30' }).click(); await p.waitForTimeout(150); } }),
  S('battle-new-teams', '/sportsbook/battles/new', { admin: false, user: 'u1', act: async (p) => { await p.getByLabel('Title').fill('Cornhole'); await p.getByRole('radio', { name: 'Teams' }).click(); for (const n of ['Dan', 'Ann', 'Bo']) await p.getByRole('button', { name: n }).click(); await p.waitForTimeout(150); } }),
  S('battle-new-confirm', '/sportsbook/battles/new', { admin: false, user: 'u1', act: async (p) => { await p.getByLabel('Title').fill('Saturday golf'); await p.getByRole('button', { name: 'Dan' }).click(); await p.getByRole('button', { name: 'Review and create' }).click(); await p.waitForTimeout(150); } }),
  S('battle-invite', '/sportsbook/battles/b-inv', { admin: false, user: 'u1' }),
  S('battle-payout-notice', '/sportsbook/battles/b-pc', { admin: false, user: 'u1' }),
  S('battle-live-creator', '/sportsbook/battles/b-live', { admin: false, user: 'u1', act: async (p) => { await p.getByLabel('Place for Bag Tossers').selectOption('1'); await p.getByLabel('Place for Hole Hunters').selectOption('2'); await p.waitForTimeout(150); } }),
  S('battle-settled', '/sportsbook/battles/b-done', { admin: false, user: 'u1', act: async (p) => { await p.getByRole('button', { name: 'Dispute this result' }).click(); await p.waitForTimeout(150); } }),
  S('battle-cancelled', '/sportsbook/battles/b-cx', { admin: false, user: 'u1' }),
  S('admin-battles', '/admin', { act: async (p) => { await p.getByRole('tab', { name: 'Battles' }).click(); await p.waitForTimeout(400); } }),
  S('admin-battles-preview', '/admin', { act: async (p) => { await p.getByRole('tab', { name: 'Battles' }).click(); await p.waitForTimeout(400); await p.getByRole('button', { name: 'Change result' }).first().click(); await p.getByRole('button', { name: 'Preview result' }).click(); await p.waitForTimeout(400); } }),
  S('challenge-pick', '/sportsbook', { admin: false, user: 'u2', act: async (p) => { await p.getByRole('tab', { name: /^Custom/ }).click(); await p.waitForTimeout(400); await p.locator('.challenge-card .odds-button').first().click(); await openSlip(p); } }),
  S('challenge-new', '/sportsbook/challenges/new', { admin: false, user: 'u1', act: async (p) => { await p.getByLabel('Question').fill('Will Mike run a 5K under 25 minutes?'); await p.getByLabel('Outcome 1 odds').fill('+150'); await p.getByLabel('Outcome 2 odds').fill('-180'); await p.getByRole('button', { name: 'Add an outcome' }).click(); await p.getByLabel('Outcome 3 name').fill('He doesn’t show up'); await p.getByLabel('Outcome 3 odds').fill('+900'); await p.waitForTimeout(150); } }),
  S('challenge-new-empty', '/sportsbook/challenges/new', { admin: false, user: 'u1' }),
  S('challenge-open', '/sportsbook/challenges/c-open', { admin: false, user: 'u2', act: async (p) => { await p.locator('.outcome-grid .odds-button').nth(1).click(); await p.waitForTimeout(150); } }),
  S('challenge-pending', '/sportsbook/challenges/c-pend', { admin: false, user: 'u2' }),
  S('challenge-closed', '/sportsbook/challenges/c-closed', { admin: false, user: 'u1' }),
  S('challenge-settled', '/sportsbook/challenges/c-settled', { admin: false, user: 'u1' }),
  S('challenge-rejected', '/sportsbook/challenges/c-rej', { admin: false, user: 'u1' }),
  S('challenge-missing', '/sportsbook/challenges/nope', { admin: false, user: 'u1' }),
  S('game-detail-custom', '/sportsbook/custom/custom:abc', { admin: false, user: 'u1' }),
  S('admin-challenges', '/admin', { act: async (p) => { await p.getByRole('tab', { name: 'Challenges' }).click(); await p.waitForTimeout(400); } }),
  S('admin-challenges-edit', '/admin', { act: async (p) => { await p.getByRole('tab', { name: 'Challenges' }).click(); await p.waitForTimeout(400); await p.getByRole('button', { name: 'Edit', exact: true }).first().click(); await p.getByLabel('Outcome 3 odds').fill('+400'); await p.waitForTimeout(150); } }),
  S('admin-challenges-reject', '/admin', { act: async (p) => { await p.getByRole('tab', { name: 'Challenges' }).click(); await p.waitForTimeout(400); await p.getByRole('button', { name: 'Reject', exact: true }).first().click(); await p.getByLabel(/Why it's rejected/).fill('Too hard to judge fairly.'); await p.waitForTimeout(150); } }),
  S('admin-challenges-open', '/admin', { act: async (p) => { await p.getByRole('tab', { name: 'Challenges' }).click(); await p.waitForTimeout(400); await p.getByRole('tab', { name: /^Open/ }).click(); await p.getByRole('button', { name: 'Edit odds / close' }).first().click(); await p.waitForTimeout(150); } }),
  S('admin-challenges-settle-preview', '/admin', { act: async (p) => { await p.getByRole('tab', { name: 'Challenges' }).click(); await p.waitForTimeout(400); await p.getByRole('tab', { name: /^To settle/ }).click(); await p.getByRole('button', { name: 'Settle', exact: true }).first().click(); await p.getByLabel('Winning outcome').selectOption('o2'); await p.getByRole('button', { name: 'Preview payouts' }).click(); await p.waitForTimeout(400); } }),
  S('admin-challenges-finished', '/admin', { act: async (p) => { await p.getByRole('tab', { name: 'Challenges' }).click(); await p.waitForTimeout(400); await p.getByRole('tab', { name: /^Finished/ }).click(); await p.waitForTimeout(150); } }),
  S('admin-bets', '/admin', { act: async (p) => { await p.getByRole('tab', { name: 'Bets' }).click(); await p.waitForTimeout(300); } }),
  S('admin-bets-cashed', '/admin', { act: async (p) => { await p.getByRole('tab', { name: 'Bets' }).click(); await p.waitForTimeout(300); await p.locator('select').filter({ hasText: 'Cashed out' }).selectOption('cashed_out'); await p.waitForTimeout(200); } }),
  S('admin-bets-confirm', '/admin', { act: async (p) => { await p.getByRole('tab', { name: 'Bets' }).click(); await p.waitForTimeout(300); await p.getByRole('button', { name: 'Force win' }).first().click(); await p.waitForTimeout(300); } }),
  S('admin-custom', '/admin', { act: async (p) => { await p.getByRole('tab', { name: 'Custom games' }).click(); await p.waitForTimeout(300); } }),
  S('admin-custom-form', '/admin', { act: async (p) => { await p.getByRole('tab', { name: 'Custom games' }).click(); await p.getByRole('button', { name: 'New custom game' }).click(); await p.waitForTimeout(200); } }),
  S('admin-settlement', '/admin', { act: async (p) => { await p.getByRole('tab', { name: 'Settlement' }).click(); await p.getByRole('button', { name: 'Preview settlement' }).click(); await p.waitForTimeout(300); } }),
  S('admin-shop', '/admin', { act: async (p) => { await p.getByRole('tab', { name: 'Shop purchases' }).click(); await p.waitForTimeout(300); } }),
  S('admin-system', '/admin', { act: async (p) => { await p.getByRole('tab', { name: 'System' }).click(); await p.waitForTimeout(200); } }),
];

async function clickPrices(p, n) {
  const buttons = p.locator('.game-card .odds-button');
  for (const i of [0, 8, 12].slice(0, n)) await buttons.nth(i).click();
  await p.waitForTimeout(200);
}
async function openSlip(p) {
  await p.locator('.slip-bar').click();
  await p.waitForTimeout(250);
}

// Elements sticking out past the right edge, and tappable things smaller than a thumb.
async function measure(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const doc = document.documentElement;
    const overflowPx = Math.max(doc.scrollWidth, document.body.scrollWidth) - vw;
    const offenders = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.position === 'fixed' && r.right <= vw + 1) continue;
      if (r.right > vw + 1 || r.left < -1) {
        // Skip children of horizontally scrollable containers (intentional tab strips).
        let p = el.parentElement;
        let scroller = false;
        while (p) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth) { scroller = true; break; } p = p.parentElement; }
        if (!scroller) offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')} right=${Math.round(r.right)}`);
      }
    }
    const small = [];
    for (const el of document.querySelectorAll('button, a, select, input:not([type=hidden]), [role=link], [role=tab], summary')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.closest('.game-card') && el.matches('.game-card[role=link]')) continue;
      const min = el.matches('input[type=checkbox]') ? 20 : 40;
      if (r.height < min || r.width < min) small.push(`${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ').join('.') : ''} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return { overflowPx, offenders: [...new Set(offenders)].slice(0, 12), small: [...new Set(small)].slice(0, 15), smallCount: small.length };
  });
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
const report = {};
for (const sc of scenarios) {
  if (only && !only.test(sc.name)) continue;
  report[sc.name] = {};
  for (const width of [320, 375, 414]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: width === 375 ? 2 : 1, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errors.push(m.text()); });
    await page.addInitScript((h) => { window.__H = h; }, { user: sc.user ? { uid: sc.user } : null, admin: sc.admin, fs: typeof sc.fs === 'function' ? sc.fs() : sc.fs });
    await routeApi(page, sc);
    await page.route(/^https:\/\/(?!localhost)/, (r) => r.abort());
    await page.goto(BASE + sc.path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);
    if (sc.act) await sc.act(page);
    await page.waitForTimeout(250);
    const m = await measure(page);
    report[sc.name][width] = { ...m, errors };
    if (width === 375) await page.screenshot({ path: `${out}/${sc.name}.png`, fullPage: !/slip|confirm|preview/.test(sc.name) });
    await context.close();
  }
}
await browser.close();
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
for (const [name, byWidth] of Object.entries(report)) {
  const worst = Object.entries(byWidth).map(([w, m]) => `${w}:${m.overflowPx > 0 ? `OVERFLOW ${m.overflowPx}px` : 'ok'}/${m.smallCount} small${m.errors.length ? `/ERR ${m.errors.length}` : ''}`).join('  ');
  console.log(`${name.padEnd(24)} ${worst}`);
}
