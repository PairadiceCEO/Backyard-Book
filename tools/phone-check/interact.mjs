// Behaviour checks in the real app (mocked Firebase + /api): chip batching, refusal rollback, the
// wallet showing pending chips, slots quick stop, the shooter's dice starting at the tap.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import * as F from './fixtures.mjs';

const BASE = 'http://localhost:5199';
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message.split('\n')[0]}`);
  }
};

const seat = (uid, name, extra = {}) => ({ uid, name, sitAt: Date.now() - 1000, leaving: false, ready: false, reqs: [], result: null, ...extra });
const now = () => Date.now();

async function openPage(path, tables, onCasino) {
  const context = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.addInitScript((h) => { window.__H = h; }, { user: { uid: 'u1' }, admin: false, fs: { users: F.users, bets: F.bets, ledger: F.ledger, customGames: F.customGames, casinoTables: tables } });
  await page.route(/^https:\/\/(?!localhost)/, (r) => r.abort());
  await page.route('**/api/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/api/casino') return onCasino(route, route.request().postDataJSON());
    if (u.pathname === '/api/settle') return json(route, 200, { ran: false });
    return json(route, 200, { ok: true });
  });
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  return { page, context };
}
const wallet = (page) => page.locator('.wallet').innerText();

// ---------- Baccarat: batching + instant chips + pending wallet ----------
await check('three quick taps on Player: chips show at once, one request carries all three, wallet shows them as spent', async () => {
  const bets = [];
  const table = { id: 'baccarat', game: 'baccarat', epoch: 'x', roundNo: 3, roundId: 'x-3', phase: 'betting', deadline: null, coup: null, shoeResults: '', shoe: { remaining: 400, total: 416 }, version: 5, updatedAt: now() - 5000, seats: [null, seat('u1', 'Mike', { bets: { player: 0, banker: 0, tie: 0 } }), null, null, null] };
  const { page, context } = await openPage('/casino/baccarat', [table], async (route, body) => {
    if (body.action === 'bet') {
      bets.push(body);
      await new Promise((r) => setTimeout(r, 400));
      const t = structuredClone(table);
      t.seats[1].bets = { player: body.player * 100, banker: body.banker * 100, tie: body.tie * 100 };
      t.version = 6;
      t.updatedAt = now();
      return json(route, 200, { ok: true, table: t, balanceCents: 9640 - body.player * 100, serverNow: now() });
    }
    return json(route, 200, { ok: true, serverNow: now() });
  });
  const before = await wallet(page);
  await page.getByRole('radio', { name: '$2 chip' }).click();
  const player = page.getByRole('button', { name: /Player, pays/ });
  await player.click();
  await player.click();
  await player.click();
  const shownAt = Date.now();
  assert.match(await player.innerText(), /\$6\.00/, 'all three chips on the spot at once');
  assert.notEqual(await wallet(page), before);
  assert.match(await wallet(page), /\$90\.40/, `wallet shows the $6 pending (shows ${await wallet(page)})`);
  assert.ok(Date.now() - shownAt < 200);
  await page.waitForTimeout(1200);
  assert.equal(bets.length, 1, `taps within 300 ms → one request (got ${bets.length})`);
  assert.equal(bets[0].player, 6);
  assert.match(await player.innerText(), /\$6\.00/, 'still there after the reply');
  assert.match(await wallet(page), /\$90\.40/, 'wallet from the reply');
  await context.close();
});

await check('a refused chip comes back off and the reason is shown', async () => {
  const table = { id: 'baccarat', game: 'baccarat', epoch: 'x', roundNo: 3, roundId: 'x-3', phase: 'betting', deadline: null, coup: null, shoeResults: '', shoe: { remaining: 400, total: 416 }, version: 5, updatedAt: now() - 5000, seats: [null, seat('u1', 'Mike', { bets: { player: 0, banker: 0, tie: 0 } }), null, null, null] };
  const { page, context } = await openPage('/casino/baccarat', [table], async (route, body) => {
    if (body.action === 'bet') return json(route, 409, { error: { code: 'PHASE', message: 'Betting is closed for this hand.' } });
    return json(route, 200, { ok: true, serverNow: now() });
  });
  const banker = page.getByRole('button', { name: /Banker, pays/ });
  await page.getByRole('radio', { name: '$5 chip' }).click();
  await banker.click();
  assert.match(await banker.innerText(), /\$5\.00/);
  await page.waitForTimeout(900);
  assert.doesNotMatch(await banker.innerText(), /\$5\.00/, 'chip removed');
  assert.match(await page.locator('.bac-help').innerText(), /Betting is closed/);
  assert.match(await wallet(page), /\$96\.40/, 'wallet back');
  // The limit is checked at the tap: $10 + $1 is refused without a request.
  await page.getByRole('radio', { name: '$10 chip' }).click();
  await banker.click();
  await page.getByRole('radio', { name: '$1 chip' }).click();
  await banker.click();
  assert.match(await page.locator('.bac-help').innerText(), /up to \$10/);
  await context.close();
});

await check('Undo takes back the last chip, Clear takes back the rest', async () => {
  const sent = [];
  let server = { player: 0, banker: 0, tie: 0 };
  const base = { id: 'baccarat', game: 'baccarat', epoch: 'x', roundNo: 3, roundId: 'x-3', phase: 'betting', deadline: null, coup: null, shoeResults: '', shoe: { remaining: 400, total: 416 }, version: 5, updatedAt: now() - 5000, seats: [null, seat('u1', 'Mike', { bets: server }), null, null, null] };
  let v = 6;
  const { page, context } = await openPage('/casino/baccarat', [base], async (route, body) => {
    if (body.action === 'bet') {
      sent.push(body);
      server = { player: body.player * 100, banker: body.banker * 100, tie: body.tie * 100 };
      const t = structuredClone(base);
      t.seats[1].bets = server;
      t.version = v++;
      t.updatedAt = now();
      return json(route, 200, { ok: true, table: t, serverNow: now() });
    }
    return json(route, 200, { ok: true, serverNow: now() });
  });
  const player = page.getByRole('button', { name: /Player, pays/ });
  const tie = page.getByRole('button', { name: /Tie, pays/ });
  await page.getByRole('radio', { name: '$5 chip' }).click();
  await player.click();
  await page.waitForTimeout(500);
  await page.getByRole('radio', { name: '$1 chip' }).click();
  await tie.click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Undo' }).click();
  assert.doesNotMatch(await tie.innerText(), /\$1\.00/, 'Undo removes the $1 on Tie at once');
  await page.waitForTimeout(500);
  assert.deepEqual([sent.at(-1).player, sent.at(-1).tie], [5, 0]);
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.waitForTimeout(600);
  assert.deepEqual([sent.at(-1).player, sent.at(-1).tie], [0, 0]);
  assert.doesNotMatch(await player.innerText(), /\$5\.00/);
  await context.close();
});

// ---------- Leaving the table page gives up every seat ----------
await check('leaving the table page sends one leave-all; opening it never does', async () => {
  const calls = [];
  const bjSeat = (uid, name) => ({ uid, name, sitAt: now() - 1000, leaving: false, reqs: [], betCents: 0, stakeCents: 0, returnCents: 0, insurance: null, hands: [], result: null, ready: false });
  const table = { id: 'blackjack', game: 'blackjack', epoch: 'y', roundNo: 3, roundId: 'y-3', phase: 'betting', deadline: null, turn: null, dealer: { cards: [], holeDown: false }, lastDeal: null, shoe: { remaining: 300, total: 312, shuffles: 0 }, version: 5, updatedAt: now() - 5000, seats: [null, bjSeat('u1', 'Mike'), null, bjSeat('u1', 'Mike'), null] };
  const { page, context } = await openPage('/casino/blackjack', [table], async (route, body) => {
    calls.push(body);
    return json(route, 200, { ok: true, serverNow: now() });
  });
  await page.waitForTimeout(900);
  assert.equal(calls.filter((c) => c.action === 'leave').length, 0, 'no leave while on the page (React dev double-mount included)');
  assert.equal(await page.getByRole('tab', { name: /Seat/ }).count(), 2, 'one tab per seat I hold');
  await page.getByRole('link', { name: /Casino/ }).first().click();
  await page.waitForTimeout(900);
  const leaves = calls.filter((c) => c.action === 'leave');
  assert.equal(leaves.length, 1, `one leave (got ${leaves.length})`);
  assert.deepEqual([leaves[0].game, leaves[0].all], ['blackjack', true]);
  await context.close();
});

// ---------- Slots quick stop ----------
await check('slots: a second tap stops the reels on the result at once and never spins again', async () => {
  let spins = 0;
  const { page, context } = await openPage('/casino/slots', [], async (route, body) => {
    if (body.action === 'spin') {
      spins += 1;
      await new Promise((r) => setTimeout(r, 300));
      return json(route, 200, { ok: true, duplicate: false, stops: [14, 5, 4], symbols: ['R7', 'R7', 'R7'], line: { id: 'red7x3', label: 'Red 7 · Red 7 · Red 7', pays: 300 }, betCents: 100, winCents: 30000, balanceCents: 39540, serverNow: now() });
    }
    return json(route, 200, { ok: true, serverNow: now() });
  });
  const spin = page.locator('.spin-btn');
  await spin.click();
  await page.waitForTimeout(80);
  await spin.click(); // before the result arrives: stops the moment it does
  await page.waitForTimeout(420);
  assert.equal(await page.locator('.reel.spinning').count(), 0, 'all reels stopped right after the result arrived');
  assert.match(await page.locator('.slot-result').innerText(), /win/i);
  await spin.click();
  await page.waitForTimeout(150);
  await spin.click(); // after the result: stops at once
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.reel.spinning').count(), 0);
  assert.equal(spins, 2, 'two spins for four taps');
  // Without a second tap the full animation plays.
  await spin.click();
  await page.waitForTimeout(500);
  assert.ok((await page.locator('.reel.spinning').count()) > 0, 'still spinning after 0.5 s');
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('.reel.spinning').count(), 0);
  assert.equal(spins, 3);
  await context.close();
});

// ---------- Craps: the shooter's dice ----------
await check('craps: the shooter\'s dice tumble from the tap and land on the reply\'s dice', async () => {
  const table = { id: 'craps', game: 'craps', epoch: 'z', rollSeq: 4, point: 6, shooter: 1, deadline: now() + 10000, waiting: false, lap: 0, rolls: [], moneySeq: 0, lastRoll: { dice: [3, 3], total: 6, at: now() - 60000, kind: 'point', pointBefore: null, seq: 4, shooter: 1 }, version: 9, updatedAt: now() - 10000, seats: [null, seat('u1', 'Mike', { bets: { pass: 500, dontPass: 0, odds: 0, field: 0, place: {} }, lastRoll: null }), null, null, null] };
  let rollBody = null;
  const { page, context } = await openPage('/casino/craps', [table], async (route, body) => {
    if (body.action === 'roll') {
      rollBody = body;
      await new Promise((r) => setTimeout(r, 350));
      const t = structuredClone(table);
      t.rollSeq = 5;
      t.lastRoll = { dice: [5, 6], total: 11, at: now() - 200, kind: 'roll', pointBefore: 6, seq: 5, shooter: 1 };
      t.version = 10;
      t.updatedAt = now();
      return json(route, 200, { ok: true, rollSeq: 5, total: 11, dice: [5, 6], table: t, serverNow: now() });
    }
    return json(route, 200, { ok: true, serverNow: now() });
  });
  const tap = Date.now();
  await page.locator('.craps-roll-btn').click();
  await page.waitForTimeout(60);
  assert.equal(await page.locator('.die.rolling').count(), 2, 'tumbling at once');
  await page.waitForFunction(() => document.querySelector('.craps-roll-text')?.textContent.startsWith('11'), null, { timeout: 2000 });
  const shown = Date.now() - tap;
  assert.ok(shown < 1500, `result visible ${shown} ms after the tap`);
  assert.equal(rollBody.rollSeq, 4);
  results.push(`     (dice result visible ${shown} ms after tapping Roll, with a 350 ms reply)`);
  await context.close();
});

await browser.close();
console.log(results.join('\n'));
if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);
