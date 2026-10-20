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
  // The wallet re-renders a moment after the third tap (well before the 400 ms reply): give it up to 300 ms.
  let shown = await wallet(page);
  for (let i = 0; i < 6 && !/\$90\.40/.test(shown); i += 1) { await page.waitForTimeout(50); shown = await wallet(page); }
  assert.match(shown, /\$90\.40/, `wallet shows the $6 pending (shows ${shown})`);
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
  let betRequests = 0;
  const { page, context } = await openPage('/casino/baccarat', [table], async (route, body) => {
    if (body.action === 'bet') {
      betRequests += 1;
      return json(route, 409, { error: { code: 'PHASE', message: 'Betting is closed for this hand.' } });
    }
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
  // No maximum (0.16.0): the wallet is checked at the tap. A $100 chip with $96.40 in the wallet is refused at once,
  // with the reason and without a request.
  const sent = betRequests;
  await page.getByRole('radio', { name: '$100 chip' }).click();
  await banker.click();
  assert.match(await page.locator('.bac-help').innerText(), /Not enough in your wallet \(\$96\.40\)/);
  assert.doesNotMatch(await banker.innerText(), /\$100/, 'the chip never went down');
  await page.waitForTimeout(500);
  assert.equal(betRequests, sent, 'no request for a chip the wallet cannot cover');
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

// ---------- 0.15.0: Craps / Crapless without scrolling ----------
// At scrollY 0, with the app's nav showing, the Roll button, the chip rack, Take down, Undo / Clear and every betting
// spot must be fully inside the visible area (below the sticky top bar, above the phone's bottom nav). At 320×568 only
// the docked bar (chips, Take down, Roll) is checked: it must sit fully on screen above the bottom nav.
const SIZES = [[375, 667], [390, 844], [414, 896], [1280, 720], [1440, 900], [320, 568]];
// Worst cases: my turn to shoot (Roll shows), a Point on with the countdown, Come bets on numbers, every spot in use.
const crapsWorst = (game) => {
  const crapless = game === 'crapless';
  const bets = crapless
    ? { pass: 500, odds: 1000, dontPass: 0, dontOdds: 0, come: 300, field: 200, place: { 2: 200, 12: 200, 6: 600 }, hard: { 4: 100, 10: 100 }, comeOn: { 3: { bet: 300, odds: 300 }, 9: { bet: 200, odds: 0 }, 11: { bet: 100, odds: 0 } } }
    : { pass: 500, odds: 1000, dontPass: 0, dontOdds: 0, come: 300, field: 200, place: { 6: 600, 8: 600 }, hard: { 6: 100, 8: 100 }, comeOn: { 5: { bet: 300, odds: 600 }, 9: { bet: 200, odds: 0 }, 10: { bet: 100, odds: 0 } } };
  const point = crapless ? 11 : 6;
  return { id: game, game, epoch: 'z', rollSeq: 9, point, shooter: 1, deadline: now() + 25000, waiting: false, lap: 0, moneySeq: 0, version: 9, updatedAt: now() - 1000,
    rolls: [8, 6, 7, 4, 9, 9, 5, 11, 7, 6, 8, 3].map((t) => ({ d: [Math.min(6, t - 1), Math.max(1, t - Math.min(6, t - 1))], t, k: t === 7 ? 'sevenOut' : 'roll' })),
    lastRoll: { dice: crapless ? [5, 6] : [5, 1], total: point, at: now() - 60000, kind: 'point', pointBefore: null, seq: 9, shooter: 1 },
    seats: [seat('u0', 'Will', { bets: { pass: 500, dontPass: 0, odds: 0, field: 0, place: {} }, lastRoll: null }), seat('u1', 'Mike the Bookie Slayer', { bets, lastRoll: null }), null, seat('u2', 'Dan', { bets: { pass: 0, dontPass: 0, odds: 0, field: 300, place: {} }, lastRoll: null }), null] };
};
async function openCraps(path, tables, { width = 375, height = 800, uid = 'u1', onCasino = null, trackMedia = false } = {}) {
  const phone = width <= 640;
  const context = await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone });
  const page = await context.newPage();
  if (trackMedia) {
    // Count media-query listeners added and removed (the dock's subscription).
    await page.addInitScript(() => {
      const orig = window.matchMedia;
      window.__mq = { added: 0, removed: 0 };
      window.matchMedia = (q) => {
        const list = orig.call(window, q);
        const add = list.addEventListener.bind(list);
        const remove = list.removeEventListener.bind(list);
        list.addEventListener = (...a) => { window.__mq.added += 1; add(...a); };
        list.removeEventListener = (...a) => { window.__mq.removed += 1; remove(...a); };
        return list;
      };
    });
  }
  await page.addInitScript((h) => { window.__H = h; }, { user: { uid }, admin: false, fs: { users: F.users, bets: F.bets, ledger: F.ledger, customGames: F.customGames, casinoTables: tables } });
  await page.route(/^https:\/\/(?!localhost)/, (r) => r.abort());
  await page.route('**/api/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/api/casino' && onCasino) return onCasino(route, route.request().postDataJSON());
    if (u.pathname === '/api/settle') return json(route, 200, { ran: false });
    return json(route, 200, { ok: true, serverNow: now() });
  });
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.craps-bar');
  await page.waitForTimeout(500);
  return { page, context };
}
// Boxes of the must-see controls and whether each is fully inside the visible area at scrollY 0.
function measureCraps(page, dockedOnly) {
  return page.evaluate((dockedOnly) => {
    window.scrollTo(0, 0);
    const nav = document.querySelector('.navbar')?.getBoundingClientRect();
    const bottomNav = document.querySelector('.bottom-nav');
    const bn = bottomNav && getComputedStyle(bottomNav).display !== 'none' ? bottomNav.getBoundingClientRect() : null;
    const top = nav ? nav.bottom : 0;
    const bottom = bn ? bn.top : window.innerHeight;
    const scope = dockedOnly ? '.craps-dock ' : '';
    const pick = (sel, label) => [...document.querySelectorAll(scope + sel)].map((el, i) => ({ el, label: `${label}${i ? ` #${i + 1}` : ''}` }));
    const items = [
      ...pick('.craps-roll-btn', 'Roll'),
      ...pick('[role=radio][aria-label$="chip"]', 'chip'),
      ...pick('.take-down', 'Take down'),
      ...(dockedOnly ? [] : [...document.querySelectorAll('.craps-tools .btn')].map((el) => ({ el, label: el.textContent.trim() }))),
      ...(dockedOnly ? [] : [...document.querySelectorAll('.craps-felt .craps-spot')].map((el) => ({ el, label: el.getAttribute('aria-label') }))),
    ];
    const out = items.map(({ el, label }) => {
      const r = el.getBoundingClientRect();
      return { label, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height), inside: r.top >= top - 0.5 && r.bottom <= bottom + 0.5 && r.left >= -0.5 && r.right <= window.innerWidth + 0.5 && r.height > 0 };
    });
    return { area: [Math.round(top), Math.round(bottom)], scrollY: window.scrollY, out, docked: Boolean(document.querySelector('.craps-dock')) };
  }, dockedOnly);
}

for (const game of ['craps', 'crapless']) {
  await check(`${game}: Roll, chips, Take down, Undo/Clear and every spot on screen at scrollY 0 (375×667, 390×844, 414×896, 1280×720, 1440×900); docked bar at 320×568`, async () => {
    const report = [];
    for (const [width, height] of SIZES) {
      const { page, context } = await openCraps(`/casino/${game}`, [crapsWorst(game)], { width, height });
      const dockedOnly = width === 320;
      const m = await measureCraps(page, dockedOnly);
      assert.equal(m.scrollY, 0);
      assert.equal(m.docked, dockedOnly, `${width}×${height}: the docked bar shows only on the short screen`);
      const need = dockedOnly ? ['Roll', 'chip', 'Take down'] : ['Roll', 'chip', 'Take down', 'Undo', 'Clear'];
      for (const label of need) assert.ok(m.out.some((o) => o.label.startsWith(label)), `${width}×${height}: ${label} present`);
      assert.equal(m.out.filter((o) => o.label.startsWith('chip')).length, 6, `${width}×${height}: all six chips ($1–$100) measured`);
      const spots = m.out.filter((o) => !['Roll', 'chip', 'Take down', 'Undo', 'Clear'].some((l) => o.label.startsWith(l)));
      if (!dockedOnly) // craps: Pass, Odds, Don't, Don't Odds, Come, Field, 6 Place, 3 Come bets, 4 Hard = 19; crapless: 2 + 2 + 10 + 3 + 4 = 21.
      assert.equal(spots.length, game === 'crapless' ? 21 : 19, `${width}×${height}: every spot measured`);
      const outside = m.out.filter((o) => !o.inside);
      assert.deepEqual(outside.map((o) => `${o.label} [${o.top}–${o.bottom}]`), [], `${width}×${height}: outside the visible area ${m.area.join('–')}`);
      const short = m.out.filter((o) => o.h < 44);
      assert.deepEqual(short.map((o) => `${o.label} ${o.h}px`), [], `${width}×${height}: tap targets at least 44 px tall`);
      const lowest = Math.max(...m.out.map((o) => o.bottom));
      report.push(`${width}×${height}${dockedOnly ? ' docked' : ''}: lowest ${lowest}/${m.area[1]}`);
      await context.close();
    }
    results.push(`     (${game} ${report.join(' · ')})`);
  });
}

await check('craps: "Sit down" takes the first open seat; "Table full" when all 5 are taken; an empty seat below still seats; the dock listener goes away on leave', async () => {
  const sits = [];
  const t = crapsWorst('craps');
  const { page, context } = await openCraps('/casino/craps', [t], { uid: 'u4', onCasino: async (route, body) => {
    if (body.action === 'sit') sits.push(body.seat);
    return json(route, 200, { ok: true, serverNow: now() });
  } });
  await page.getByRole('button', { name: 'Sit down' }).click();
  await page.waitForTimeout(200);
  assert.deepEqual(sits, [2], 'first open seat is seat 3 (index 2)');
  await page.getByRole('button', { name: 'Sit in seat 5' }).click();
  await page.waitForTimeout(200);
  assert.deepEqual(sits, [2, 4], 'tapping an empty seat below still works');
  const seatsTop = await page.locator('.seat-row').evaluate((el) => el.getBoundingClientRect().top);
  const barBottom = await page.locator('.craps-bar').evaluate((el) => el.getBoundingClientRect().bottom);
  assert.ok(seatsTop > barBottom, 'seats are below the top bar');
  await context.close();

  const full = { ...crapsWorst('craps'), seats: ['u0', 'u1', 'u2', 'u3', 'u5'].map((u, i) => seat(u, ['Will', 'Mike', 'Dan', 'Ann', 'Bo'][i], { bets: { pass: 0, dontPass: 0, odds: 0, field: 0, place: {} }, lastRoll: null })) };
  const second = await openCraps('/casino/craps', [full], { uid: 'u4' });
  assert.equal(await second.page.getByRole('button', { name: 'Sit down' }).count(), 0);
  assert.equal(await second.page.locator('.craps-full').innerText(), 'Table full');
  await second.context.close();

  // The short-screen dock follows the media query both ways, and its subscription is removed on unmount.
  const third = await openCraps('/casino/craps', [crapsWorst('craps')], { width: 320, height: 568, trackMedia: true });
  assert.ok((await third.page.evaluate(() => window.__mq.added)) >= 1, 'the page subscribed to the media query');
  assert.equal(await third.page.locator('.craps-dock').count(), 1);
  await third.page.setViewportSize({ width: 320, height: 800 });
  await third.page.waitForTimeout(200);
  assert.equal(await third.page.locator('.craps-dock').count(), 0, 'taller screen: no dock, Roll back in the top bar');
  assert.equal(await third.page.locator('.craps-bar .craps-roll-btn').count(), 1);
  // Go to the lobby (unmounts the page): every listener added after the patch is removed.
  await third.page.evaluate(() => { window.history.pushState({}, '', '/casino'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await third.page.waitForTimeout(300);
  const mq = await third.page.evaluate(() => window.__mq);
  assert.equal(mq.added, mq.removed, `media-query listeners cleaned up (${mq.added} added, ${mq.removed} removed)`);
  await third.context.close();
});

// ---------- 0.16.0: no maximum bets; $25 and $100 chips on every game ----------
// A rich player ($10,000) on every casino game: six chips; $100 + $100 + $25 on one spot goes to the server as one
// $225 total (an amount built from chips); no "up to $10" / "$1–$10" / "$60" text anywhere; the new help line shows.
async function openRich(path, tables, onCasino) {
  const context = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const users = F.users.map((u) => (u.id === 'u1' ? { ...u, balanceCents: 1_000_000 } : u));
  await page.addInitScript((h) => { window.__H = h; }, { user: { uid: 'u1' }, admin: false, fs: { users, bets: F.bets, ledger: F.ledger, customGames: F.customGames, casinoTables: tables } });
  await page.route(/^https:\/\/(?!localhost)/, (r) => r.abort());
  await page.route('**/api/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/api/casino') return onCasino(route, route.request().postDataJSON());
    if (u.pathname === '/api/settle') return json(route, 200, { ran: false });
    return json(route, 200, { ok: true, serverNow: now() });
  });
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  return { page, context };
}
const OLD_LIMIT_TEXT = /up to \$10\b|\$1[–-]\$10\b|\$1[–-]\$20|\$1[–-]\$30|\$60\b|of \$60|Room \$/;
async function chipsAndText(page, where) {
  const labels = await page.getByRole('radio', { name: /chip$/ }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  assert.deepEqual([...new Set(labels)], ['$1 chip', '$2 chip', '$5 chip', '$10 chip', '$25 chip', '$100 chip'], `${where}: six chips`);
  const text = await page.evaluate(() => document.body.innerText);
  assert.ok(!OLD_LIMIT_TEXT.test(text), `${where}: old limit wording left: ${(text.match(OLD_LIMIT_TEXT) ?? [])[0]}`);
  assert.match(text, /Minimum \$1\. Bet as much as your wallet holds\./, `${where}: new help text`);
}
const tapChips = async (page, spot) => {
  await page.getByRole('radio', { name: '$100 chip' }).first().click();
  await spot.click();
  await spot.click();
  await page.getByRole('radio', { name: '$25 chip' }).first().click();
  await spot.click();
};

await check('no maximum bets: $100 + $100 + $25 chips on Blackjack, Baccarat, Craps, Crapless and Slots arrive as a $225 bet; no old limit text', async () => {
  const sent = {};
  const record = (game) => async (route, body) => {
    if (['bet', 'bets', 'spin'].includes(body.action)) (sent[game] ??= []).push(body);
    if (body.action === 'spin') {
      return json(route, 200, { ok: true, duplicate: false, stops: [1, 2, 3], symbols: ['BL', 'B1', 'CH'], line: null, betCents: body.amount * 100, winCents: 0, balanceCents: 1_000_000 - body.amount * 100, serverNow: now() });
    }
    return json(route, 200, { ok: true, serverNow: now() });
  };
  const bjSeat = (uid, name) => ({ uid, name, sitAt: now() - 60000, leaving: false, reqs: [], betCents: 0, stakeCents: 0, returnCents: 0, insurance: null, hands: [], result: null, ready: false });
  const bj = { id: 'blackjack', game: 'blackjack', epoch: 'y', roundNo: 7, roundId: 'y-7', phase: 'betting', deadline: null, turn: null, dealer: { cards: [], holeDown: false }, lastDeal: null, shoe: { remaining: 248, total: 312, shuffles: 0 }, version: 30, updatedAt: now() - 5000, seats: [null, bjSeat('u1', 'Mike'), null, null, null] };
  let { page, context } = await openRich('/casino/blackjack', [bj], record('blackjack'));
  await chipsAndText(page, 'Blackjack');
  await tapChips(page, page.getByRole('button', { name: /Seat 2 bet .*Tap to add/ }));
  await page.waitForTimeout(700);
  assert.equal(sent.blackjack.at(-1).amount, 225, 'Blackjack: $225 on the seat');
  await context.close();

  const bac = { id: 'baccarat', game: 'baccarat', epoch: 'x', roundNo: 3, roundId: 'x-3', phase: 'betting', deadline: null, coup: null, shoeResults: '', shoe: { remaining: 400, total: 416 }, version: 5, updatedAt: now() - 5000, seats: [null, seat('u1', 'Mike', { bets: { player: 0, banker: 0, tie: 0 } }), null, null, null] };
  ({ page, context } = await openRich('/casino/baccarat', [bac], record('baccarat')));
  await chipsAndText(page, 'Baccarat');
  await tapChips(page, page.getByRole('button', { name: /Banker, pays/ }));
  await page.waitForTimeout(700);
  assert.equal(sent.baccarat.at(-1).banker, 225, 'Baccarat: $225 on Banker (was capped at $10)');
  await context.close();

  for (const game of ['craps', 'crapless']) {
    const t = { ...crapsWorst(game), seats: [null, seat('u1', 'Mike', { bets: { pass: 0, dontPass: 0, odds: 0, dontOdds: 0, come: 0, field: 0, place: {}, hard: {}, comeOn: {} }, lastRoll: null }), null, null, null], point: null, deadline: null };
    ({ page, context } = await openRich(`/casino/${game}`, [t], record(game)));
    await chipsAndText(page, game);
    await tapChips(page, page.getByRole('button', { name: /^Pass/ }));
    // The chips show at once (the mock table doc never changes, so read the meter before the reply clears them).
    assert.match(await page.locator('.craps-meter').innerText(), /^On the felt \$225\.00$/);
    await page.waitForTimeout(700);
    const total = sent[game].flatMap((b) => b.changes ?? []).filter((c) => c.kind === 'pass').reduce((a, c) => a + c.cents, 0);
    assert.equal(total, 22_500, `${game}: $225 on Pass (was capped at $20)`);
    await context.close();
  }

  ({ page, context } = await openRich('/casino/slots', [], record('slots')));
  await chipsAndText(page, 'Slots');
  await page.getByRole('button', { name: 'Clear' }).click();
  await tapChips(page, page.getByRole('button', { name: /^Bet \$/ }));
  await page.getByRole('button', { name: /^Spin/ }).click();
  await page.waitForTimeout(400);
  assert.equal(sent.slots.at(-1).amount, 225, 'Slots: a $225 spin (was capped at $10)');
  await context.close();
});

// ---------- My Bets → Finished: every finished bet, sort, filters, remembered view ----------
await check('My Bets: a player with 263 bets sees all 260 finished (one extra query past the listener\'s 200); filters and sort are remembered', async () => {
  const context = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const bets = F.heavyBets('u7', 260);
  await page.addInitScript((h) => { window.__H = window.__H ?? h; }, { user: { uid: 'u7' }, admin: false, fs: { users: [...F.users, F.heavyUser], bets, ledger: [], customGames: F.customGames, battles: [] } });
  await page.route(/^https:\/\/(?!localhost)/, (r) => r.abort());
  await page.route('**/api/**', (route) => json(route, 200, { ok: true, ran: false, quotes: {} }));
  await page.goto(BASE + '/my-bets', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.finished-summary')?.textContent.startsWith('260 bets'), null, { timeout: 4000 });
  assert.equal(await page.evaluate(() => window.__H.getDocsCalls ?? 0), 1, 'one history query (60 bets after the 200 the listener holds)');
  assert.equal(await page.locator('.finished-bets .bet-card').count(), 50, 'the list shows 50 at a time');
  const lost = bets.filter((b) => b.status === 'lost').length;
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.locator('.filters-panel').getByRole('button', { name: 'Lost', exact: true }).click();
  await page.waitForFunction((n) => document.querySelector('.finished-summary')?.textContent.startsWith(`${n} bets`), lost, { timeout: 2000 });
  assert.match(await page.locator('.finished-summary').innerText(), /Net −\$/, 'losses only: net is negative');
  assert.match(await page.locator('.finished-summary').innerText(), /Win rate 0%/);
  await page.getByLabel('Sort finished bets').selectOption('stakeDesc');
  const firstStake = await page.locator('.finished-bets .bet-card').first().innerText();
  assert.match(firstStake, /Stake \$7\.00/, 'biggest stake first');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction((n) => document.querySelector('.finished-summary')?.textContent.startsWith(`${n} bets`), lost, { timeout: 4000 });
  assert.equal(await page.locator('.filter-badge').innerText(), '1', 'filters remembered for the session');
  assert.equal(await page.getByLabel('Sort finished bets').inputValue(), 'stakeDesc', 'sort remembered');
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.getByRole('button', { name: 'Clear all' }).click();
  await page.waitForFunction(() => document.querySelector('.finished-summary')?.textContent.startsWith('260 bets'), null, { timeout: 2000 });
  await context.close();
});

await check('My Bets: a player under 200 bets costs no extra reads', async () => {
  const { page, context } = await openPage('/my-bets', [], () => {});
  await page.waitForSelector('.finished-summary', { timeout: 3000 });
  assert.equal(await page.evaluate(() => window.__H.getDocsCalls ?? 0), 0);
  await context.close();
});

// ---------- Crypto chart scrubber ----------
await check('crypto chart: touch-drag scrubs (time + price + target), keeps its minute through the 10 s refresh, moves to the oldest point once its minute rolls off, lifts away; mouse hover too', async () => {
  const context = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const first = F.cryptoCoin('btc');
  // A full window of 1-minute closes (the last 60 minutes, ending now), so the right-edge flip is always exercised.
  const hourFrom = Date.parse(first.chart.from);
  first.chart.points = Array.from({ length: 61 }, (_, i) => ({ t: hourFrom + i * 60000, c: 81900 + 120 * Math.sin(i / 6) + i }));
  // Put the 15-min target right on one minute's close, so scrubbing there shows "Target $X".
  const onTarget = first.chart.points[Math.floor(first.chart.points.length / 2)];
  first.coin.fifteen.market.strike = Number(onTarget.c.toFixed(2));
  let answers = 0;
  await page.addInitScript((h) => { window.__H = h; }, { user: { uid: 'u1' }, admin: false, fs: { users: F.users, bets: F.bets, ledger: [], customGames: [], battles: [] } });
  await page.route(/^https:\/\/(?!localhost)/, (r) => r.abort());
  await page.route('**/api/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/api/board' && u.searchParams.get('league') === 'crypto') {
      answers += 1;
      // The refresh drops the minute being scrubbed (and nudges every price): the scrubber moves to the nearest minute.
      if (answers === 1) return json(route, 200, first);
      if (!page.__rolled) {
        const scrubbed = Number(page.__scrubbedT);
        const points = first.chart.points.filter((p) => p.t !== scrubbed).map((p) => ({ ...p, c: p.c + 1 }));
        return json(route, 200, { ...first, serverNow: Date.now(), chart: { ...first.chart, points } });
      }
      // Later refreshes roll the window 10 minutes forward: the held minute scrolls off the left edge.
      const shift = 10 * 60000;
      const kept = first.chart.points.filter((p) => p.t >= hourFrom + shift);
      const added = Array.from({ length: 10 }, (_, i) => ({ t: kept[kept.length - 1].t + (i + 1) * 60000, c: 81950 + i }));
      return json(route, 200, { ...first, serverNow: Date.now(), chart: { from: new Date(hourFrom + shift).toISOString(), to: new Date(Date.parse(first.chart.to) + shift).toISOString(), points: [...kept, ...added] } });
    }
    return json(route, 200, { ok: true, ran: false });
  });
  await page.goto(BASE + '/sportsbook/crypto/btc', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('svg.crypto-chart');
  const fire = (type, frac, pointerType = 'touch') =>
    page.evaluate(({ type, frac, pointerType }) => {
      const svg = document.querySelector('svg.crypto-chart');
      const r = svg.getBoundingClientRect();
      svg.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType, isPrimary: true, relatedTarget: type === 'pointerout' ? document.body : null, clientX: r.left + (r.width * (8 + frac * 324)) / 340, clientY: r.top + r.height / 2 }));
    }, { type, frac, pointerType });
  const label = () => page.locator('.chart-scrub text').allTextContents(); // SVG text has no innerText

  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('svg.crypto-chart')).touchAction), 'pan-y');
  assert.equal(await page.locator('.chart-scrub').count(), 0, 'hidden until touched');
  await fire('pointerdown', 0.05);
  let texts = await label();
  assert.match(texts[0], /^\d{1,2}:\d{2} [AP]M$/, `time first (${texts[0]})`);
  assert.match(texts[1], /^\$\d{2},\d{3}\.\d{2}/, `price second (${texts[1]})`);
  const atStart = texts[0];
  await fire('pointermove', 0.12);
  texts = await label();
  assert.notEqual(texts[0], atStart, 'dragging moves it');

  // Near the right edge the label flips to the left of the line.
  const pts = first.chart.points;
  const lastFrac = (pts[pts.length - 1].t - Date.parse(first.chart.from)) / (Date.parse(first.chart.to) - Date.parse(first.chart.from));
  await fire('pointermove', 0.99);
  const box = await page.evaluate(() => ({ box: Number(document.querySelector('.scrub-box').getAttribute('x')), w: Number(document.querySelector('.scrub-box').getAttribute('width')), line: Number(document.querySelector('.scrub-line').getAttribute('x1')) }));
  assert.ok(lastFrac > 0.9 && box.box + box.w <= box.line, 'flipped left of the line near the right edge');
  assert.ok(box.box >= 0 && box.box + box.w <= 340, 'inside the chart');
  const fracOf = (t) => (t - Date.parse(first.chart.from)) / (Date.parse(first.chart.to) - Date.parse(first.chart.from));
  await fire('pointermove', fracOf(onTarget.t));
  texts = await label();
  assert.ok(texts.some((t) => /^Target \$/.test(t)), `on the 15-min target the label shows it (${texts.join(' | ')})`);
  await fire('pointermove', fracOf(first.chart.points[0].t));

  // Hold on one minute through the 10-second refresh, which drops that minute: it moves to the nearest one.
  const from = Date.parse(first.chart.from);
  const span = Date.parse(first.chart.to) - from;
  const target = from + 0.05 * span;
  page.__scrubbedT = pts.reduce((best, p) => (Math.abs(p.t - target) < Math.abs(best.t - target) ? p : best), pts[0]).t;
  await fire('pointermove', 0.05);
  const held = (await label())[0];
  const before = await label();
  await page.waitForTimeout(10600); // the coin page refreshes every 10 s
  assert.ok(answers >= 2, 'refreshed');
  const after = await label();
  assert.ok(after.length >= 2, 'still showing after the refresh');
  const minutes = (s) => { const [hm, ap] = s.split(' '); const [h, m] = hm.split(':').map(Number); return ((h % 12) + (ap === 'PM' ? 12 : 0)) * 60 + m; };
  assert.ok(Math.abs(minutes(after[0]) - minutes(held)) <= 1, `stayed on its minute or the nearest (${held} → ${after[0]})`);
  assert.notEqual(after[1], before[1], 'shows the refreshed price');

  // The window rolls on: once the held minute has scrolled off the left edge, the scrubber sits on the oldest point.
  page.__rolled = true;
  await page.waitForTimeout(10600);
  const rolled = await label();
  const oldest = new Date(hourFrom + 10 * 60000).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
  assert.equal(rolled[0], oldest, `moved to the oldest point (${held} → ${rolled[0]})`);

  await fire('pointerup', 0.05);
  assert.equal(await page.locator('.chart-scrub').count(), 0, 'lifting the finger hides it');

  // Mouse: follows the hover, hides when the mouse leaves.
  await fire('pointermove', 0.08, 'mouse');
  assert.equal(await page.locator('.chart-scrub').count(), 1, 'hover shows it');
  await fire('pointerout', 0.08, 'mouse'); // how a browser reports the mouse leaving (React turns it into onPointerLeave)
  assert.equal(await page.locator('.chart-scrub').count(), 0, 'leaving hides it');
  await context.close();
});

// ---------- Line wheel: alternate lines and player props ----------
await check('line wheel: starts on the main line, centered; tap / arrow key / swipe select; slip dot; a refresh keeps the line or moves to the nearest without jumping; props rows', async () => {
  const context = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const first = F.gameDetail('401');
  let answers = 0;
  let dropLine = null;
  await page.addInitScript((h) => { window.__H = h; }, { user: { uid: 'u1' }, admin: false, fs: { users: F.users, bets: F.bets, ledger: [], customGames: [], battles: [] } });
  await page.route(/^https:\/\/(?!localhost)/, (r) => r.abort());
  await page.route('**/api/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/api/board' && u.searchParams.get('props')) return json(route, 200, F.propsPage('401'));
    if (u.pathname === '/api/board' && u.searchParams.get('game')) {
      answers += 1;
      if (answers === 1 || dropLine === null) return json(route, 200, first);
      // A refresh that drops the selected total and nudges every price.
      const totals = first.ladders.totals.filter((r) => r.line !== dropLine).map((r) => ({ ...r, over: { ...r.over, american: r.over.american - 5 }, under: { ...r.under, american: r.under.american + 5 } }));
      return json(route, 200, { ...first, fetchedAt: new Date().toISOString(), ladders: { ...first.ladders, totals } });
    }
    return json(route, 200, { ok: true, ran: false });
  });
  await page.goto(BASE + '/sportsbook/nfl/401', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.line-wheel');
  await page.waitForTimeout(400);
  const wheel = (i) => page.locator('.line-wheel').nth(i);
  const selected = (i) => wheel(i).locator('.wheel-chip.selected').innerText();
  const buttons = (i) => wheel(i).locator('.wheel-buttons .odds-cell').allInnerTexts();
  const centered = (i) =>
    page.evaluate((i) => {
      const track = document.querySelectorAll('.line-wheel .wheel-track')[i];
      const chip = track.querySelector('.wheel-chip.selected');
      const t = track.getBoundingClientRect();
      const c = chip.getBoundingClientRect();
      return Math.abs(c.left + c.width / 2 - (t.left + t.width / 2));
    }, i);

  assert.equal(await selected(0), '-2.5', 'spread starts on the main board line (home side)');
  assert.equal(await selected(1), '42.5', 'total starts on the main line');
  assert.ok((await centered(0)) < 4 && (await centered(1)) < 4, 'both start centered');
  const spreadButtons = await buttons(0);
  assert.match(spreadButtons[0], /Texans -2\.5/);
  assert.match(spreadButtons[1], /Jaguars \+2\.5/);
  const chipTexts = await wheel(0).locator('.wheel-chip').allInnerTexts();
  const values = chipTexts.map(Number);
  assert.deepEqual([...values].sort((a, b) => a - b), values, 'spread chips lowest to highest');
  const css = await page.evaluate(() => {
    const track = document.querySelector('.wheel-track');
    return { touch: getComputedStyle(track).touchAction, snap: getComputedStyle(track).scrollSnapType, chipH: document.querySelector('.wheel-chip').getBoundingClientRect().height };
  });
  assert.ok(!/^pan-x$/.test(css.touch) && /pan-y|auto/.test(css.touch), `vertical swipes still scroll the page (${css.touch})`);
  assert.match(css.snap, /x mandatory/);
  assert.ok(css.chipH >= 44, `chips at least 44 px tall (${css.chipH})`);
  const arrowsInside = await page.evaluate(() =>
    [...document.querySelectorAll('.line-wheel')].every((w) => {
      const card = w.closest('.card').getBoundingClientRect();
      return [...w.querySelectorAll('.wheel-arrow')].every((a) => { const r = a.getBoundingClientRect(); return r.left >= card.left - 0.5 && r.right <= card.right + 0.5; });
    }));
  assert.ok(arrowsInside, '‹ › buttons stay inside the card');
  assert.match(await wheel(1).locator('.wheel-chip.selected').getAttribute('aria-label'), /^Total 42\.5, Over [−-]?\+?\d+, Under /);

  // Tap a chip: it becomes the line and glides to the middle.
  await wheel(1).locator('.wheel-chip', { hasText: '47.5' }).click();
  await page.waitForTimeout(700);
  assert.equal(await selected(1), '47.5');
  assert.ok((await centered(1)) < 4, 'tapped chip centered');
  assert.match((await buttons(1))[0], /Over 47\.5/);
  // Arrow key on the focused wheel.
  await wheel(1).locator('.wheel-track').focus();
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(700);
  assert.equal(await selected(1), '44.5', 'left arrow steps one line lower');
  // Swipe: scroll the track so 50.5 sits in the middle; the selection follows once scrolling stops.
  await page.evaluate(() => {
    const track = document.querySelectorAll('.line-wheel .wheel-track')[1];
    const chip = [...track.querySelectorAll('.wheel-chip')].find((c) => c.textContent.trim() === '50.5');
    track.scrollTo({ left: chip.offsetLeft - (track.clientWidth - chip.offsetWidth) / 2, behavior: 'auto' });
  });
  await page.waitForTimeout(600);
  assert.equal(await selected(1), '50.5', 'a swipe that stops on a chip selects it');

  // A pick in the slip: its button stays highlighted, its chip carries a dot when the wheel moves away.
  await wheel(1).locator('.wheel-chip', { hasText: '44.5' }).click();
  await page.waitForTimeout(600);
  await wheel(1).locator('.wheel-buttons .odds-button').first().click();
  assert.equal(await wheel(1).locator('.wheel-buttons .odds-button').first().getAttribute('aria-pressed'), 'true');
  await wheel(1).getByRole('button', { name: /^Higher/ }).click();
  await page.waitForTimeout(600);
  assert.equal(await selected(1), '47.5');
  assert.equal(await wheel(1).locator('.wheel-chip', { hasText: '44.5' }).locator('.chip-dot').count(), 1, 'dot on the picked line');

  // Refresh (every 30 s) that drops the selected line 47.5: the wheel moves to the nearest line, still centered.
  dropLine = 47.5;
  const before = answers;
  await page.waitForTimeout(31000);
  assert.ok(answers > before, 'refreshed');
  const now = await selected(1);
  assert.ok(now === '44.5' || now === '50.5', `moved to the nearest remaining line (${now})`);
  assert.ok((await centered(1)) < 4, 'and stays centered (no jump)');
  assert.equal(await selected(0), '-2.5', 'the other wheel kept its line');

  // Player props page: a wheel per multi-threshold player, starting on the YES ask nearest $0.50; single threshold = two buttons.
  await page.goto(BASE + '/sportsbook/nfl/401/props', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.prop-player');
  await page.waitForTimeout(400);
  const etienne = page.locator('.prop-player').first();
  assert.match(await etienne.innerText(), /Travis Etienne Jr\./);
  assert.equal(await etienne.locator('.wheel-chip.selected').innerText(), '50+', 'starts on the threshold nearest $0.50');
  const propButtons = await etienne.locator('.wheel-buttons .odds-cell').allInnerTexts();
  assert.match(propButtons[0], /^50\+/);
  assert.match(propButtons[1], /^Under 50/);
  await page.getByRole('tab', { name: 'TD' }).click();
  const td = page.locator('.prop-player').first();
  assert.equal(await td.locator('.line-wheel').count(), 0, 'single threshold: no wheel');
  assert.match((await td.locator('.odds-cell').allInnerTexts()).join(' | '), /1\+ TD.*No TD/s);
  await page.getByLabel('Search players').fill('etienne');
  assert.equal(await page.locator('.prop-player').count(), 1, 'search filters players');
  await context.close();
});

// ---------- 0.15.0: player props in the game page's tab ----------
await check('props tab: game page alone fetches no props; tab opens them; remembered for the session; gone at the start; old URL redirects; no tab without props', async () => {
  const context = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const detail = F.gameDetail('401');
  let started = false;
  let propsCalls = 0;
  let detailCalls = 0;
  await page.addInitScript((h) => { window.__H = h; }, { user: { uid: 'u1' }, admin: false, fs: { users: F.users, bets: F.bets, ledger: [], customGames: [], battles: [] } });
  await page.route(/^https:\/\/(?!localhost)/, (r) => r.abort());
  await page.route('**/api/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/api/board' && u.searchParams.get('props')) { propsCalls += 1; return json(route, 200, F.propsPage(u.searchParams.get('game'))); }
    if (u.pathname === '/api/board' && u.searchParams.get('game')) {
      detailCalls += 1;
      const id = u.searchParams.get('game');
      if (id !== '401') return json(route, 200, F.gameDetail(id));
      if (!started) return json(route, 200, detail);
      // Kickoff: ESPN says in progress and the server reports no props any more.
      return json(route, 200, { ...detail, fetchedAt: new Date().toISOString(), propsCount: 0, game: { ...detail.game, state: 'in', statusText: '1st Qtr 14:10', bettingClosed: false } });
    }
    return json(route, 200, { ok: true, ran: false });
  });
  const tab = (name) => page.getByRole('tab', { name });
  const saved = () => page.evaluate(() => { try { return sessionStorage.getItem('bb.gameSection'); } catch { return 'blocked'; } });
  const refresh = async () => { const n = detailCalls; await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); for (let i = 0; i < 40 && detailCalls === n; i++) await page.waitForTimeout(50); await page.waitForTimeout(300); };

  await page.goto(BASE + '/sportsbook/nfl/401', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.line-wheel');
  await page.waitForTimeout(1200);
  assert.equal(propsCalls, 0, 'opening the game page alone asks for no props');
  assert.equal(await tab('Game lines').getAttribute('aria-selected'), 'true', 'Game lines is the default');
  assert.equal(await page.getByRole('link', { name: /Player props/ }).count(), 0, 'the old "Player props (N players) ›" button is gone');
  const tabsBelowHeader = await page.evaluate(() => {
    const card = document.querySelector('.game-card').getBoundingClientRect();
    const tabs = document.querySelector('.section-tabs').getBoundingClientRect();
    const wheel = document.querySelector('.line-wheel').getBoundingClientRect();
    return tabs.top >= card.bottom - 1 && tabs.bottom <= wheel.top + 1;
  });
  assert.ok(tabsBelowHeader, 'section tabs sit between the score header and the alternate lines');

  await tab('Player props').click();
  await page.waitForSelector('.prop-player');
  assert.equal(propsCalls, 1, 'opening the tab loads props once');
  assert.equal(await page.locator('.line-wheel .wheel-chip', { hasText: '-2.5' }).count(), 0, 'alternate lines hidden on Player props');
  assert.match(await page.locator('.prop-player').first().innerText(), /Travis Etienne Jr\./);
  assert.equal(await page.locator('.prop-player').first().locator('.wheel-chip.selected').innerText(), '50+');
  assert.equal(await saved(), 'props', 'chosen section saved for the session');

  // Back to Game lines: the props poll stops (the section unmounts), and a refresh asks for none.
  await tab('Game lines').click();
  await page.waitForSelector('.line-wheel .wheel-chip');
  assert.equal(await saved(), 'lines');
  const callsOnLines = propsCalls;
  await refresh();
  assert.equal(propsCalls, callsOnLines, 'no props request while Game lines is open');

  // The session remembers Player props across a reload.
  await tab('Player props').click();
  await page.waitForSelector('.prop-player');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.prop-player');
  assert.equal(await tab('Player props').getAttribute('aria-selected'), 'true', 'reopened on Player props');

  // Kickoff: on the next refresh the tab disappears and the page is back on Game lines.
  started = true;
  await refresh();
  assert.equal(await page.getByRole('tab', { name: 'Player props' }).count(), 0, 'Player props tab gone once the game starts');
  assert.equal(await page.locator('.section-tabs').count(), 0, 'no section tabs at all');
  assert.equal(await page.locator('.prop-player').count(), 0);
  assert.ok((await page.locator('.line-wheel').count()) >= 1, 'Game lines shown');
  const callsAfterStart = propsCalls;
  await refresh();
  assert.equal(propsCalls, callsAfterStart, 'no props request after the start');
  started = false;

  // A game with no props: no tabs at all.
  await page.goto(BASE + '/sportsbook/nfl/404', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.game-card');
  await page.waitForTimeout(600);
  assert.equal(await page.locator('.section-tabs').count(), 0, 'no tabs on a game without props');

  // Old /props links: the game page with Player props selected, and the URL cleaned up.
  await page.evaluate(() => { try { sessionStorage.removeItem('bb.gameSection'); } catch { /* blocked */ } });
  await page.goto(BASE + '/sportsbook/nfl/401/props', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.prop-player');
  assert.equal(new URL(page.url()).pathname, '/sportsbook/nfl/401');
  assert.equal(new URL(page.url()).search, '', 'the section parameter leaves the URL');
  assert.equal(await tab('Player props').getAttribute('aria-selected'), 'true');
  assert.equal(await saved(), 'props');
  await context.close();
});

// Storage blocked (sessionStorage throws): the tabs still work, nothing crashes.
await check('props tab works with sessionStorage blocked', async () => {
  const context = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('blocked'); } }); });
  await page.addInitScript((h) => { window.__H = h; }, { user: { uid: 'u1' }, admin: false, fs: { users: F.users, bets: F.bets, ledger: [], customGames: [], battles: [] } });
  await page.route(/^https:\/\/(?!localhost)/, (r) => r.abort());
  await page.route('**/api/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/api/board' && u.searchParams.get('props')) return json(route, 200, F.propsPage('401'));
    if (u.pathname === '/api/board' && u.searchParams.get('game')) return json(route, 200, F.gameDetail('401'));
    return json(route, 200, { ok: true, ran: false });
  });
  await page.goto(BASE + '/sportsbook/nfl/401', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.line-wheel');
  await page.getByRole('tab', { name: 'Player props' }).click();
  await page.waitForSelector('.prop-player');
  await page.getByRole('tab', { name: 'Game lines' }).click();
  await page.waitForSelector('.line-wheel .wheel-chip');
  assert.deepEqual(errors, []);
  await context.close();
});

await browser.close();
console.log(results.join('\n'));
if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);
