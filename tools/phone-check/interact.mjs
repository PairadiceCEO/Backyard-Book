// Behaviour checks in the real app (mocked Firebase + /api): chip batching, refusal rollback, the
// wallet showing pending chips, slots quick stop, the shooter's dice starting at the tap.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import * as F from './fixtures.mjs';

const BASE = 'http://localhost:5199';
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
const results = [];
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null; // ONLY='chat: Send' node interact.mjs runs just those checks
const check = async (name, fn) => {
  if (ONLY && !ONLY.test(name)) return;
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
  await page.route(/^https:\/\/(?!localhost)/, F.offlineRoute);
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

// ---------- 0.17.2: absolute totals while a batch is in flight (Blackjack, Baccarat) ----------
// A fake server that holds the real amounts, answers each bet after BET_REPLY_MS (so the next taps land while a batch is
// in flight), refuses what the real one refuses (negative or fractional dollars), carries the table in its reply, and
// pushes the new table to the page's listener a little later, like Firestore.
const BET_REPLY_MS = 500;
function chipRig(game) {
  const seatData = game === 'blackjack'
    ? { uid: 'u1', name: 'Mike', sitAt: now() - 60000, leaving: false, reqs: [], betCents: 0, stakeCents: 0, returnCents: 0, insurance: null, hands: [], result: null, ready: false }
    : seat('u1', 'Mike', { bets: { player: 0, banker: 0, tie: 0 } });
  const table = game === 'blackjack'
    ? { id: 'blackjack', game: 'blackjack', epoch: 'q', roundNo: 4, roundId: 'q-4', phase: 'betting', deadline: null, turn: null, dealer: { cards: [], holeDown: false }, lastDeal: null, shoe: { remaining: 300, total: 312, shuffles: 0 }, version: 10, updatedAt: now() - 5000, seats: [null, seatData, null, null, null] }
    : { id: 'baccarat', game: 'baccarat', epoch: 'q', roundNo: 4, roundId: 'q-4', phase: 'betting', deadline: null, coup: null, shoeResults: '', shoe: { remaining: 400, total: 416 }, version: 10, updatedAt: now() - 5000, seats: [null, seatData, null, null, null] };
  const rig = { table, sent: [], refused: [], page: null };
  rig.handler = async (route, body) => {
    if (body.action !== 'bet') return json(route, 200, { ok: true, serverNow: now() });
    rig.sent.push(body);
    await new Promise((r) => setTimeout(r, BET_REPLY_MS));
    const amounts = game === 'blackjack' ? [body.amount] : [body.player, body.banker, body.tie];
    if (amounts.some((d) => !Number.isInteger(d) || d < 0)) {
      rig.refused.push(body);
      return json(route, 400, { error: { code: 'BAD_BET', message: 'Bets are whole dollars, at least $1.' } });
    }
    const t = structuredClone(rig.table);
    if (game === 'blackjack') t.seats[1].betCents = body.amount * 100;
    else t.seats[1].bets = { player: body.player * 100, banker: body.banker * 100, tie: body.tie * 100 };
    t.version += 1;
    t.updatedAt = now();
    rig.table = t;
    // The listener catches up a little after the reply.
    setTimeout(() => rig.page?.evaluate((tt) => { window.__H.fs.casinoTables = [tt]; window.__H.emit?.(); }, t).catch(() => {}), 150);
    const reply = { ok: true, table: t, balanceCents: 9640, serverNow: now() };
    if (game === 'blackjack') reply.betCents = t.seats[1].betCents;
    else reply.betCents = t.seats[1].bets.player + t.seats[1].bets.banker + t.seats[1].bets.tie;
    return json(route, 200, reply);
  };
  return rig;
}
const serverCents = (rig, game, spot = 'player') => (game === 'blackjack' ? rig.table.seats[1].betCents : rig.table.seats[1].bets[spot]);
const sentAmounts = (rig, game) => rig.sent.map((b) => (game === 'blackjack' ? b.amount : `${b.player}/${b.banker}/${b.tie}`));

for (const game of ['blackjack', 'baccarat']) {
  const spotBtn = (page, spot = 'player') => (game === 'blackjack' ? page.locator('.bj-bet-spot, [aria-label^="Seat 2 bet"]').first() : page.getByRole('button', { name: new RegExp(`${spot === 'player' ? 'Player' : 'Banker'}, pays`) }));
  const shown = async (page, spot = 'player') => {
    if (game === 'blackjack') return /bet \$(\d[\d,]*\.\d{2})/.exec(await page.locator('[aria-label^="Seat 2 bet"]').first().getAttribute('aria-label'))?.[1];
    return /your bet \$(\d[\d,]*\.\d{2})/.exec(await page.getByRole('button', { name: new RegExp(`${spot === 'player' ? 'Player' : 'Banker'}, pays`) }).getAttribute('aria-label'))?.[1];
  };
  const open = async () => {
    const rig = chipRig(game);
    const { page, context } = await openPage(`/casino/${game}`, [rig.table], rig.handler);
    rig.page = page;
    await page.waitForTimeout(300);
    return { rig, page, context };
  };
  const errorText = (page) => page.locator('.error-text').allInnerTexts();

  await check(`${game}: Clear while a $10 bet is in flight sends 0 (never negative) and the spot ends at $0`, async () => {
    const { rig, page, context } = await open();
    await page.getByRole('radio', { name: '$10 chip' }).first().click();
    await spotBtn(page).click();
    await page.waitForTimeout(380); // the batch has gone; its reply is still 500 ms away
    assert.equal(rig.sent.length, 1, 'the $10 batch is in flight');
    await page.getByRole('button', { name: 'Clear' }).first().click();
    await page.waitForTimeout(BET_REPLY_MS * 2 + 900);
    assert.deepEqual(rig.refused, [], `nothing refused (sent ${JSON.stringify(sentAmounts(rig, game))})`);
    assert.ok(rig.sent.every((b) => [b.amount, b.player, b.banker, b.tie].every((d) => d === undefined || d >= 0)), 'never a negative total');
    assert.equal(serverCents(rig, game), 0, 'the server ends at $0');
    assert.equal(await shown(page), '0.00', 'the screen shows $0');
    assert.deepEqual((await errorText(page)).filter(Boolean), [], 'no error');
    await context.close();
  });

  await check(`${game}: $5 four times across two batches ends at $20 on the server and the screen`, async () => {
    const { rig, page, context } = await open();
    await page.getByRole('radio', { name: '$5 chip' }).first().click();
    await spotBtn(page).click();
    await spotBtn(page).click();
    await page.waitForTimeout(380);
    assert.equal(rig.sent.length, 1);
    await spotBtn(page).click();
    await spotBtn(page).click();
    await page.waitForTimeout(BET_REPLY_MS * 2 + 900);
    assert.equal(serverCents(rig, game), 2000, `server holds $20 (sent ${JSON.stringify(sentAmounts(rig, game))})`);
    assert.equal(await shown(page), '20.00');
    await context.close();
  });

  await check(`${game}: Undo while $10 is in flight leaves $5`, async () => {
    const { rig, page, context } = await open();
    await page.getByRole('radio', { name: '$5 chip' }).first().click();
    await spotBtn(page).click();
    await spotBtn(page).click();
    await page.waitForTimeout(380);
    await page.getByRole('button', { name: 'Undo' }).first().click();
    await page.waitForTimeout(BET_REPLY_MS * 2 + 900);
    assert.deepEqual(rig.refused, []);
    assert.equal(serverCents(rig, game), 500, `server holds $5 (sent ${JSON.stringify(sentAmounts(rig, game))})`);
    assert.equal(await shown(page), '5.00');
    await context.close();
  });
}

await check('baccarat: two spots — Clear in flight sends 0/0/0, and chips on Banker during a Player batch keep both', async () => {
  const rig = chipRig('baccarat');
  const { page, context } = await openPage('/casino/baccarat', [rig.table], rig.handler);
  rig.page = page;
  await page.waitForTimeout(300);
  const player = page.getByRole('button', { name: /Player, pays/ });
  const banker = page.getByRole('button', { name: /Banker, pays/ });
  await page.getByRole('radio', { name: '$10 chip' }).first().click();
  await player.click();
  await page.waitForTimeout(380);
  await page.getByRole('radio', { name: '$5 chip' }).first().click();
  await banker.click();
  await banker.click();
  await page.waitForTimeout(BET_REPLY_MS * 2 + 900);
  assert.deepEqual([rig.table.seats[1].bets.player, rig.table.seats[1].bets.banker], [1000, 1000], `Player $10 and Banker $10 (sent ${JSON.stringify(sentAmounts(rig, 'baccarat'))})`);
  await page.getByRole('radio', { name: '$25 chip' }).first().click();
  await player.click();
  await page.waitForTimeout(380);
  await page.getByRole('button', { name: 'Clear' }).first().click();
  await page.waitForTimeout(BET_REPLY_MS * 2 + 900);
  assert.deepEqual(rig.refused, [], `nothing refused (sent ${JSON.stringify(sentAmounts(rig, 'baccarat'))})`);
  assert.deepEqual(Object.values(rig.table.seats[1].bets), [0, 0, 0], 'Clear takes back every chip of the round');
  await context.close();
});

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

// ---------- 0.18.0: the real casino-style felt, upright and sideways (Craps and Crapless) ----------
// Same DOM, two layouts picked by CSS. Worst cases: my turn to shoot (Roll shows), a Point on with the countdown, Come bets
// on numbers, every spot in use.
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
const emptyBets = { pass: 0, dontPass: 0, odds: 0, dontOdds: 0, come: 0, field: 0, place: {}, hard: {}, comeOn: {} };
// My seat is empty-handed: the table's point is `point` (null = come-out).
const crapsBlank = (game, { point = null, bets = {}, shooter = 1, players = 2 } = {}) => ({
  ...crapsWorst(game), point, shooter, deadline: players > 1 ? now() + 25000 : null,
  lastRoll: { dice: [3, 2], total: 5, at: now() - 60000, kind: 'roll', pointBefore: point, seq: 9, shooter },
  seats: [null, seat('u1', 'Mike', { bets: { ...emptyBets, ...bets }, lastRoll: null }), players > 1 ? seat('u2', 'Dan', { bets: { ...emptyBets }, lastRoll: null }) : null, null, null],
});
async function openCraps(path, tables, { width = 375, height = 800, uid = 'u1', onCasino = null, trackMedia = false } = {}) {
  const phone = width <= 640 || height <= 500;
  const context = await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone });
  const page = await context.newPage();
  const calls = [];
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  if (trackMedia) {
    // Count media-query listeners added and removed (the inline-info subscription).
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
  await page.addInitScript((h) => { window.__H = h; }, { user: { uid }, admin: false, fs: { users: F.users, bets: F.bets, ledger: F.ledger, customGames: F.customGames, casinoTables: tables, ...F.chatFs() } });
  await page.route(/^https:\/\/(?!localhost)/, F.offlineRoute);
  await page.route('**/api/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/api/casino') {
      const body = route.request().postDataJSON();
      calls.push(body);
      if (onCasino) return onCasino(route, body);
      if (body.action === 'bets') await new Promise((r) => setTimeout(r, 2500)); // chips stay pending on screen
      return json(route, 200, { ok: true, serverNow: now() });
    }
    if (u.pathname === '/api/settle') return json(route, 200, { ran: false });
    return json(route, 200, { ok: true, serverNow: now() });
  });
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.craps-felt');
  await page.waitForTimeout(500);
  return { page, context, calls, pageErrors };
}

// Where everything is, at the current size: stage scroll, the felt and rail boxes, every felt button's size, what sticks out.
const FELT_BUTTON_EXCEPTION = '^comeOdds:'; // the Come-odds chip inside a 47–60 px number box on the shortest screens keeps 44 wide
function measureCraps(page) {
  return page.evaluate((exception) => {
    const re = new RegExp(exception);
    const st = document.querySelector('.craps-stage');
    const box = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; };
    const felt = box(document.querySelector('.craps-felt'));
    const rail = box(document.querySelector('.cs-rail'));
    const small = [...document.querySelectorAll('.craps-felt button:not([data-part="strip"])')].filter((b) => b.getBoundingClientRect().width > 0).filter((b) => { const r = b.getBoundingClientRect(); return (r.width < 43.5 || r.height < 43.5) && !re.test(b.dataset.spot ?? ''); }).map((b) => `${b.dataset.spot} ${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`);
    const must = [...document.querySelectorAll('.cs-top button, .cs-top a, .cs-rail button, .cs-rail [role=radio], .craps-felt button:not([data-part="strip"])')].filter((b) => b.getBoundingClientRect().width > 0);
    const outside = must.filter((b) => { const r = b.getBoundingClientRect(); return r.right > innerWidth + 0.5 || r.left < -0.5 || r.top < -0.5 || r.bottom > innerHeight + 0.5; }).map((b) => b.dataset.spot ?? b.getAttribute('aria-label') ?? b.textContent.trim().slice(0, 12));
    const rackBoxes = [...document.querySelectorAll('.cs-rack [role=radio]')].map((b) => Math.round(b.getBoundingClientRect().width));
    return { stageScroll: st.scrollHeight - st.clientHeight, docScroll: document.documentElement.scrollHeight - innerHeight, felt, rail, small, outside, rackBoxes, orient: innerWidth > innerHeight ? 'sideways' : 'upright', buttons: must.length };
  }, FELT_BUTTON_EXCEPTION);
}

// Upright: 320×568 (may scroll below 600 px tall), 375×667, 390×844, 414×896. Sideways: 568×320, 667×375, 844×390, 932×430.
// Computers (landscape, taller than 500 px): 1280×800, 1440×900.
const FIT_SIZES = [[320, 568], [375, 667], [390, 844], [414, 896], [568, 320], [667, 375], [844, 390], [932, 430], [1280, 800], [1440, 900]];
for (const game of ['craps', 'crapless']) {
  await check(`${game}: the felt fits at every size (no page scroll where required, nothing clipped, every felt button 44×44), upright and sideways`, async () => {
    const report = [];
    for (const [width, height] of FIT_SIZES) {
      const { page, context, pageErrors } = await openCraps(`/casino/${game}`, [crapsWorst(game)], { width, height });
      const m = await measureCraps(page);
      const tag = `${width}×${height} ${m.orient}`;
      assert.deepEqual(pageErrors, [], `${tag}: no page errors`);
      assert.equal(m.orient, width > height ? 'sideways' : 'upright');
      if (m.orient === 'sideways') {
        assert.equal(m.stageScroll, 0, `${tag}: the stage does not scroll`);
        assert.equal(m.docScroll, 0, `${tag}: the page does not scroll`);
        assert.ok(m.felt.right <= m.rail.left + 1, `${tag}: felt left of the rail`);
      } else {
        // Upright: the felt sits above the dock from 600 px tall (below that the page may scroll). It fits without scrolling from 600 px tall (taller phones carry the seats
        // under the felt, so the page scrolls there, but the felt and the dock stay in view).
        if (height >= 600) assert.ok(m.felt.bottom <= m.rail.top + 1, `${tag}: felt (${m.felt.bottom}) above the dock (${m.rail.top})`);
        if (height >= 600 && height < 780) assert.equal(m.stageScroll, 0, `${tag}: no page scrolling`);
      }
      assert.deepEqual(m.small, [], `${tag}: felt buttons at least 44×44`);
      assert.deepEqual(m.outside, [], `${tag}: nothing outside the screen`);
      const rackMin = m.orient === 'sideways' ? 44 : 48;
      assert.ok(m.rackBoxes.length === 6 && m.rackBoxes.every((w) => w >= rackMin - 1), `${tag}: six rack chips of ${rackMin}+ px (${m.rackBoxes})`);
      report.push(`${tag.split(' ')[0]}${m.stageScroll ? ` scroll ${m.stageScroll}` : ''}`);
      await context.close();
    }
    results.push(`     (${game}: ${report.join(' · ')})`);
  });
}

// ---------- every area is a button that places a chip on its bet ----------
const spot = (page, key) => page.locator(`.craps-felt [data-spot="${key}"]:not([data-part="strip"])`);
const stripSpot = (page, key) => page.locator(`.craps-felt [data-spot="${key}"][data-part="strip"]`);
const chipText = async (btn) => (await btn.locator('.fa-chip').count()) ? (await btn.locator('.fa-chip').first().innerText()).trim() : '';
const lastBets = (calls) => calls.filter((c) => c.action === 'bets');

for (const game of ['craps', 'crapless']) {
  await check(`${game}: every felt area is a button with a clear label; tapping a free area puts a chip on that bet (come-out: Pass, Don't Pass, Field, Hard ways; with a Point: Place, Come, Odds)`, async () => {
    const crapless = game === 'crapless';
    // Come-out, nothing on the felt yet.
    let { page, context, calls } = await openCraps(`/casino/${game}`, [crapsBlank(game, { point: null })], { width: 844, height: 390 });
    await page.getByRole('radio', { name: '$5 chip' }).click();
    const comeOutSpots = [...(crapless ? [] : ['dontPass']), 'pass', 'field', ...[...(crapless ? [4, 10] : [6, 8, 4, 10])].map((n) => `hard:${n}`)];
    for (const key of comeOutSpots) {
      await spot(page, key).first().click();
      assert.equal(await chipText(spot(page, key).first()), '$5', `${key}: a $5 chip on the area`);
      assert.match((await spot(page, key).first().getAttribute('aria-label')) ?? '', /, \$5\.00 on it$/, `${key}: label says what is on it`);
    }
    // Blocked on the come-out: Come, Place, Odds. Tapping says why and puts nothing there.
    for (const key of ['come', 'odds', 'place:6']) {
      assert.ok(await spot(page, key).evaluate((el) => el.classList.contains('blocked')), `${key}: blocked look on the come-out`);
      await spot(page, key).click();
      assert.equal(await chipText(spot(page, key)), '', `${key}: no chip`);
      assert.ok((await page.locator('.cs-msg.error').innerText()).length > 5, `${key}: says why`);
    }
    if (crapless) {
      assert.equal(await page.locator('.craps-felt [data-spot="dontPass"], .craps-felt [data-spot="dontOdds"]').count(), 0, 'Crapless: no Don\'t Pass anywhere');
    }
    // Everything goes to the server as the same bet changes the old felt sent.
    await page.waitForTimeout(700);
    const kinds = lastBets(calls).flatMap((c) => c.changes).map((c) => `${c.kind}${c.number ? `:${c.number}` : ''}=${c.cents}`).sort();
    assert.deepEqual(kinds, comeOutSpots.map((k) => `${k}=500`).sort(), 'one $5 change per area');
    await context.close();

    // A Point is on: Place numbers, Come, Odds (behind my Pass), Don't Odds (behind my Don't Pass).
    const point = crapless ? 11 : 6;
    ({ page, context, calls } = await openCraps(`/casino/${game}`, [crapsBlank(game, { point, bets: { pass: 1000, dontPass: crapless ? 0 : 1000 } })], { width: 844, height: 390 }));
    await page.getByRole('radio', { name: '$2 chip' }).click();
    const nums = crapless ? [2, 3, 4, 5, 6, 8, 9, 10, 11, 12] : [4, 5, 6, 8, 9, 10];
    for (const key of [...nums.map((n) => `place:${n}`), 'come', 'odds', ...(crapless ? [] : ['dontOdds'])]) {
      await spot(page, key).click();
      assert.equal(await chipText(spot(page, key)), '$2', `${key}: a $2 chip`);
    }
    // The Pass strip and the Pass row are the same bet: a tap on either adds to it. (Pass is up: with a point it's blocked, so
    // check the shared amount instead: both show the $10.)
    assert.equal(await chipText(spot(page, 'pass')), '$10');
    assert.equal(await chipText(stripSpot(page, 'pass')), '$10', 'the strip shows the same Pass bet');
    await context.close();
  });
}

await check('craps: the Pass strip (sideways) and the Pass row reach the same bet; taking it off one takes it off the other', async () => {
  const { page, context } = await openCraps('/casino/craps', [crapsBlank('craps', { point: null })], { width: 844, height: 390 });
  assert.equal(await stripSpot(page, 'pass').isVisible(), true, 'the strip shows sideways');
  assert.equal(await stripSpot(page, 'pass').getAttribute('aria-hidden'), 'true', 'hidden from screen readers (the row is the labelled one)');
  await page.getByRole('radio', { name: '$5 chip' }).click();
  await stripSpot(page, 'pass').click();
  await spot(page, 'pass').click();
  assert.equal(await chipText(spot(page, 'pass')), '$10', 'row: $5 from the strip + $5 from the row');
  assert.equal(await chipText(stripSpot(page, 'pass')), '$10', 'strip: the same bet');
  await page.getByRole('button', { name: 'Undo' }).click();
  assert.equal(await chipText(stripSpot(page, 'pass')), '$5');
  assert.equal(await chipText(spot(page, 'pass')), '$5');
  // Upright: the strips are not drawn.
  await page.setViewportSize({ width: 375, height: 667 });
  await page.waitForTimeout(250);
  assert.equal(await stripSpot(page, 'pass').isVisible(), false, 'no strip upright');
  assert.equal(await spot(page, 'pass').isVisible(), true);
  assert.equal(await chipText(spot(page, 'pass')), '$5', 'the chip is still there after rotating');
  await context.close();
});

await check('craps: Odds stop at 2× the Pass bet (message on the felt), Undo and Clear work', async () => {
  const { page, context } = await openCraps('/casino/craps', [crapsBlank('craps', { point: 6, bets: { pass: 500 } })], { width: 844, height: 390 });
  await page.getByRole('radio', { name: '$5 chip' }).click();
  await spot(page, 'odds').click();
  await spot(page, 'odds').click();
  assert.equal(await chipText(spot(page, 'odds')), '$10', '2× of $5');
  await spot(page, 'odds').click();
  assert.equal(await chipText(spot(page, 'odds')), '$10', 'the third chip is refused');
  assert.match(await page.locator('.cs-msg').innerText(), /Odds can be up to 2× your Pass bet \(\$10\)/);
  await page.getByRole('button', { name: 'Undo' }).click();
  assert.equal(await chipText(spot(page, 'odds')), '$5', 'Undo takes the last chip');
  await spot(page, 'place:8').click();
  await spot(page, 'field').click();
  await page.getByRole('button', { name: 'Clear' }).click();
  for (const key of ['odds', 'place:8', 'field']) assert.equal(await chipText(spot(page, key)), '', `${key} cleared`);
  await context.close();
});

await check('craps: a Come bet that moved to a number shows as a chip marked C with its Odds beside it; tapping it adds Come Odds (capped at 2×)', async () => {
  const { page, context, calls } = await openCraps('/casino/craps', [crapsBlank('craps', { point: 6, bets: { pass: 500, comeOn: { 5: { bet: 500, odds: 500 }, 9: { bet: 300, odds: 0 } } } })], { width: 375, height: 667 });
  const five = spot(page, 'comeOdds:5');
  assert.equal((await five.locator('.come-chip').innerText()).trim(), 'C');
  assert.equal((await five.locator('.odds-chip').innerText()).trim(), '$5', 'its Odds chip');
  assert.match((await five.getAttribute('aria-label')) ?? '', /^Come bet \$5\.00 on 5, Odds \$5\.00; tap for Odds/);
  assert.equal(await spot(page, 'comeOdds:9').locator('.odds-chip').count(), 0, 'no Odds yet on 9');
  await page.getByRole('radio', { name: '$5 chip' }).click();
  await five.click();
  assert.equal((await five.locator('.odds-chip').innerText()).trim(), '$10', 'Odds on 5 now $10 (2× the $5 Come bet)');
  await five.click();
  assert.match(await page.locator('.cs-msg').innerText(), /2× your Come 5 bet/);
  await spot(page, 'comeOdds:9').click();
  await page.waitForTimeout(700);
  const sent = lastBets(calls).flatMap((c) => c.changes).map((c) => `${c.kind}:${c.number}=${c.cents}`).sort();
  assert.deepEqual(sent, ['comeOdds:5=500', 'comeOdds:9=500']);
  await context.close();
});

await check('craps: Take down removes a bet (and Odds off) with the same remove action as before', async () => {
  const { page, context, calls } = await openCraps('/casino/craps', [crapsBlank('craps', { point: 6, bets: { pass: 500, odds: 1000, place: { 8: 600 }, field: 100 } })], { width: 844, height: 390 });
  await page.getByRole('button', { name: 'Take down' }).click();
  assert.equal(await page.locator('.craps-felt.taking-down').count(), 1);
  assert.ok(await spot(page, 'place:6').evaluate((el) => el.classList.contains('blocked')), 'areas with nothing on them look blocked');
  await spot(page, 'place:8').click();
  await spot(page, 'odds').click();
  await spot(page, 'pass').click(); // stays up with a Point
  assert.match(await page.locator('.cs-msg').innerText(), /stays up until the Point is decided/);
  await page.waitForTimeout(300);
  const removes = calls.filter((c) => c.action === 'removeBet').map((c) => `${c.kind}${c.number ? `:${c.number}` : ''}`);
  assert.deepEqual(removes, ['place:8', 'odds']);
  await context.close();
});

await check('craps vs Crapless: 6 number boxes in the order 4 5 SIX 8 NINE 10 and Don\'t Pass; Crapless has 10 boxes (2 3 4 5 SIX 8 NINE 10 11 12 as two rows of five) and no Don\'t Pass; labels, hard-way pays and the Odds note', async () => {
  const texts = (page) => page.locator('.craps-felt .fn-main .fn-num').allInnerTexts();
  let { page, context } = await openCraps('/casino/craps', [crapsWorst('craps')], { width: 375, height: 667 });
  assert.deepEqual(await texts(page), ['4', '5', 'SIX', '8', 'NINE', '10']);
  assert.equal(await page.locator('.craps-felt [data-spot="dontPass"]:not([data-part="strip"])').count(), 1);
  assert.equal(await page.locator('.craps-felt [data-spot="dontOdds"]').count(), 1);
  assert.equal(await spot(page, 'place:6').getAttribute('aria-label'), 'Place Six, pays 7:6, $6.00 on it');
  assert.equal(await spot(page, 'place:9').getAttribute('aria-label'), 'Place Nine, pays 7:5');
  assert.deepEqual(await page.locator('.craps-felt .fh-box .fh-pay').allTextContents(), ['8 to 1', '6 to 1', '8 to 1', '6 to 1'], 'hard ways 6, 10, 8, 4 (8:1 and 6:1 are deliberate)');
  assert.deepEqual(await page.locator('.craps-felt .fh-box').evaluateAll((els) => els.map((e) => e.dataset.spot)), ['hard:6', 'hard:10', 'hard:8', 'hard:4']);
  assert.match(await page.locator('.craps-felt .fh-note').innerText(), /Odds pay true odds/i);
  assert.match(await page.locator('.craps-felt .a-field').innerText(), /FIELD|Field/);
  assert.equal(await page.locator('.craps-felt .a-field .ring').count(), 2, '2 and 12 are circled');
  const main = await page.locator('.craps-felt .fn-main').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  assert.equal(new Set(main).size, 1, 'one row of six');
  await context.close();

  ({ page, context } = await openCraps('/casino/crapless', [crapsWorst('crapless')], { width: 375, height: 667 }));
  assert.deepEqual(await texts(page), ['2', '3', '4', '5', 'SIX', '8', 'NINE', '10', '11', '12']);
  const tops = await page.locator('.craps-felt .fn-main').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  assert.equal(new Set(tops).size, 2, 'two rows');
  assert.equal(tops.filter((t) => t === tops[0]).length, 5, 'five across');
  assert.equal(await page.locator('.craps-felt [data-spot="dontPass"], .craps-felt [data-spot="dontOdds"]').count(), 0, 'no Don\'t Pass');
  assert.equal(await page.locator('.craps-felt .a-dont, .craps-felt .a-dodds').count(), 0);
  assert.equal(await spot(page, 'place:2').getAttribute('aria-label'), 'Place 2, pays 9:2, $2.00 on it');
  await context.close();
});

await check('craps: the lettering font loads once from Google Fonts (preconnect + display=swap), only on a craps table; areas are real buttons with focus rings', async () => {
  const { page, context } = await openCraps('/casino/craps', [crapsWorst('craps')], { width: 375, height: 667 });
  const links = await page.evaluate(() => [...document.head.querySelectorAll('link[data-felt-font]')].map((l) => `${l.rel} ${l.href}`));
  assert.equal(links.length, 3);
  assert.ok(links.some((l) => /^preconnect https:\/\/fonts\.googleapis\.com/.test(l)) && links.some((l) => /^preconnect https:\/\/fonts\.gstatic\.com/.test(l)));
  assert.ok(links.some((l) => /^stylesheet .*family=Oswald:wght@500;600;700&display=swap$/.test(l)), links.join('\n'));
  assert.equal(await page.locator('.craps-felt .fa').evaluateAll((els) => els.every((e) => e.tagName === 'BUTTON')), true, 'every area is a <button>');
  // Keyboard focus shows a gold ring.
  let ringed = null;
  for (let i = 0; i < 40 && !ringed; i += 1) {
    await page.keyboard.press('Tab');
    ringed = await page.evaluate(() => { const el = document.activeElement; if (!el?.classList.contains('fa')) return null; const s = getComputedStyle(el); return { outline: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor, spot: el.dataset.spot }; });
  }
  assert.ok(ringed, 'a felt area took keyboard focus');
  assert.notEqual(ringed.outline, 'none', 'focus ring drawn');
  assert.match(ringed.color, /rgb\(245, 196, 81\)/, `gold ring (${ringed.color})`);
  await context.close();
  // The sportsbook never loads it.
  const other = await openPage('/casino/baccarat', [], async (route) => json(route, 200, { ok: true, serverNow: now() }));
  assert.equal(await other.page.evaluate(() => document.head.querySelectorAll('link[data-felt-font]').length), 0, 'only craps tables add the font');
  await other.context.close();
});

await check('craps: rotating upright → sideways → upright mid-bet keeps the seat, the chip, the unsent chips and the open chat drawer; nothing leaves or re-sits', async () => {
  const { page, context, calls } = await openCraps('/casino/craps', [crapsBlank('craps', { point: null })], { width: 375, height: 667 });
  await page.getByRole('radio', { name: '$5 chip' }).click();
  await spot(page, 'field').click();
  await spot(page, 'field').click();
  await spot(page, 'pass').click();
  await page.getByRole('button', { name: /^Chat/ }).first().click();
  await page.waitForSelector('.chat-drawer');
  const state = async () => ({
    field: await chipText(spot(page, 'field')),
    pass: await chipText(spot(page, 'pass')),
    chip: await page.getByRole('radio', { name: '$5 chip' }).getAttribute('aria-checked'),
    seated: (await page.getByRole('button', { name: 'Sit down' }).count()) === 0 && (await page.getByRole('button', { name: 'Undo' }).count()) === 1,
    drawer: await page.locator('.chat-drawer').count(),
    meter: (await page.locator('.craps-meter').innerText()).replace(/\s+/g, ' '),
  });
  const before = await state();
  assert.deepEqual(before, { field: '$10', pass: '$5', chip: 'true', seated: true, drawer: 1, meter: 'On the felt $15.00' });
  await page.setViewportSize({ width: 667, height: 375 });
  await page.waitForTimeout(350);
  assert.deepEqual(await state(), before, 'sideways: same seat, chips and drawer');
  assert.equal((await measureCraps(page)).orient, 'sideways');
  await page.setViewportSize({ width: 375, height: 667 });
  await page.waitForTimeout(350);
  assert.deepEqual(await state(), before, 'and back upright');
  assert.equal(calls.filter((c) => ['leave', 'sit'].includes(c.action)).length, 0, 'no leave or sit sent by rotating');
  await context.close();
});

await check('craps: the Table sheet (seats, last rolls, Leave seat, help, rules) opens from the top bar sideways and closes (×, Escape, backdrop) without moving the felt; upright tall screens show it under the felt instead', async () => {
  const { page, context } = await openCraps('/casino/craps', [crapsWorst('craps')], { width: 667, height: 375 });
  const feltBox = () => page.locator('.craps-felt').evaluate((el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10)); });
  const before = await feltBox();
  assert.equal(await page.locator('.cs-info').count(), 0, 'sideways: no inline info');
  const tableBtn = page.getByRole('button', { name: 'Table', exact: true });
  for (const how of ['x', 'escape', 'backdrop']) {
    await tableBtn.click();
    const sheet = page.getByRole('dialog', { name: /Craps table/ });
    await sheet.waitFor();
    assert.equal(await tableBtn.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await feltBox(), before, 'the felt did not move while the sheet is open');
    const text = await sheet.innerText();
    assert.match(text, /Last rolls/);
    assert.match(text, /Leave seat/);
    assert.match(text, /Minimum \$1\. Bet as much as your wallet holds\./);
    assert.match(text, /Come-out: 7 or 11 wins/);
    assert.ok((await sheet.locator('.seat-row button, .seat-row [role=button], .seat-row > *').count()) >= 5, 'five seats');
    if (how === 'x') await page.getByRole('button', { name: 'Close table' }).click();
    else if (how === 'escape') await page.keyboard.press('Escape');
    else await page.locator('.chat-backdrop').click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(200);
    assert.equal(await page.getByRole('dialog', { name: /Craps table/ }).count(), 0, `closed by ${how}`);
    assert.deepEqual(await feltBox(), before, 'the felt did not move after closing');
    assert.equal(await page.evaluate(() => document.body.classList.contains('no-scroll')), false, 'scroll lock released');
  }
  // Tall upright: the same content sits under the felt and there is no Table button.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  assert.equal(await page.getByRole('button', { name: 'Table', exact: true }).count(), 0);
  assert.equal(await page.locator('.cs-info .craps-rolls').count(), 1);
  await context.close();
});

await check('craps: "Sit down" takes the first open seat; "Table full" when all 5 are taken; an empty seat in the Table sheet still seats; the media-query listener goes away on leave', async () => {
  const sits = [];
  const onCasino = async (route, body) => {
    if (body.action === 'sit') sits.push(body.seat);
    return json(route, 200, { ok: true, serverNow: now() });
  };
  const t = crapsWorst('craps');
  const first = await openCraps('/casino/craps', [t], { uid: 'u4', onCasino, width: 390, height: 844 });
  await first.page.getByRole('button', { name: 'Sit down' }).click();
  await first.page.waitForTimeout(200);
  assert.deepEqual(sits, [2], 'first open seat is seat 3 (index 2)');
  await first.page.getByRole('button', { name: 'Sit in seat 5' }).click();
  await first.page.waitForTimeout(200);
  assert.deepEqual(sits, [2, 4], 'tapping an empty seat below the felt still works');
  const seatsTop = await first.page.locator('.seat-row').evaluate((el) => el.getBoundingClientRect().top);
  const feltBottom = await first.page.locator('.craps-felt').evaluate((el) => el.getBoundingClientRect().bottom);
  assert.ok(seatsTop > feltBottom, 'seats are below the felt');
  await first.context.close();

  // Sideways: the seats are in the Table sheet.
  sits.length = 0;
  const side = await openCraps('/casino/craps', [t], { uid: 'u4', onCasino, width: 844, height: 390 });
  await side.page.getByRole('button', { name: 'Table', exact: true }).click();
  await side.page.getByRole('button', { name: 'Sit in seat 5' }).click();
  await side.page.waitForTimeout(200);
  assert.deepEqual(sits, [4], 'an empty seat in the Table sheet seats');
  await side.context.close();

  const full = { ...crapsWorst('craps'), seats: ['u0', 'u1', 'u2', 'u3', 'u5'].map((u, i) => seat(u, ['Will', 'Mike', 'Dan', 'Ann', 'Bo'][i], { bets: { pass: 0, dontPass: 0, odds: 0, field: 0, place: {} }, lastRoll: null })) };
  const second = await openCraps('/casino/craps', [full], { uid: 'u4' });
  assert.equal(await second.page.getByRole('button', { name: 'Sit down' }).count(), 0);
  assert.equal(await second.page.locator('.craps-full').innerText(), 'Table full');
  await second.context.close();

  // The inline-info decision follows the media query both ways, and its subscription is removed on unmount.
  const third = await openCraps('/casino/craps', [crapsWorst('craps')], { width: 375, height: 667, trackMedia: true });
  assert.ok((await third.page.evaluate(() => window.__mq.added)) >= 1, 'the page subscribed to the media query');
  assert.equal(await third.page.locator('.cs-info').count(), 0);
  assert.equal(await third.page.getByRole('button', { name: 'Table', exact: true }).count(), 1);
  await third.page.setViewportSize({ width: 375, height: 800 });
  await third.page.waitForTimeout(250);
  assert.equal(await third.page.locator('.cs-info').count(), 1, 'taller upright screen: the info moves under the felt');
  assert.equal(await third.page.getByRole('button', { name: 'Table', exact: true }).count(), 0);
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
  await page.route(/^https:\/\/(?!localhost)/, F.offlineRoute);
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
    await tapChips(page, page.locator('.craps-felt [data-spot="pass"]:not([data-part="strip"])'));
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
  await page.route(/^https:\/\/(?!localhost)/, F.offlineRoute);
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
  await page.route(/^https:\/\/(?!localhost)/, F.offlineRoute);
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
  await page.route(/^https:\/\/(?!localhost)/, F.offlineRoute);
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
  await page.route(/^https:\/\/(?!localhost)/, F.offlineRoute);
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
  await page.route(/^https:\/\/(?!localhost)/, F.offlineRoute);
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

// ---------- 0.17.0: casino chat ----------
// One page with chat: returns the page plus every /api/casino body it sent.
async function openChatPage(path, { uid = 'u1', admin = false, fs = {}, width = 375, height = 800, onChat = null, tables = [] } = {}) {
  const phone = width <= 640;
  const context = await browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone });
  const page = await context.newPage();
  const calls = [];
  const adminCalls = [];
  await page.addInitScript((h) => { window.__H = h; }, { user: { uid }, admin, fs: { users: F.users, bets: F.bets, ledger: F.ledger, customGames: F.customGames, casinoTables: tables, ...F.chatFs(), ...fs } });
  await page.route(/^https:\/\/(?!localhost)/, F.offlineRoute);
  await page.route('**/api/**', async (route) => {
    const u = new URL(route.request().url());
    const body = route.request().postDataJSON?.() ?? {};
    if (u.pathname === '/api/casino') {
      calls.push(body);
      if (body.action === 'chat' && onChat) return onChat(route, body);
      return json(route, 200, { ok: true, serverNow: now() });
    }
    if (u.pathname === '/api/admin') {
      adminCalls.push(body);
      return json(route, 200, body.action === 'ping' ? { ok: true, admin: true, username: 'will' } : { ok: true });
    }
    if (u.pathname === '/api/settle') return json(route, 200, { ran: false });
    return json(route, 200, { ok: true });
  });
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  return { page, context, calls, adminCalls };
}
const chatListeners = (page) => page.evaluate(() => window.__H.liveListeners().filter((l) => l.path.startsWith('casinoChat/')));
const chatButton = (page) => page.getByRole('button', { name: /^Chat/ }).first();
const freshMessage = (id, uid, name, text, agoMs = 1000) => ({ id, uid, name, text, deleted: false, createdAt: new Date(Date.now() - agoMs).toISOString() });

await check('chat: each game page listens to its own room only; closed = newest 1, open = newest 30, back to 1 on close, none after leaving', async () => {
  for (const [path, room] of [['/casino/blackjack', 'blackjack'], ['/casino/baccarat', 'baccarat'], ['/casino/craps', 'craps'], ['/casino/crapless', 'crapless']]) {
    const { page, context } = await openChatPage(path);
    let l = await chatListeners(page);
    assert.deepEqual(l, [{ path: `casinoChat/${room}/messages`, limit: 1 }], `${room}: closed`);
    await chatButton(page).click();
    await page.waitForSelector('.chat-drawer .chat-msg');
    l = await chatListeners(page);
    assert.deepEqual(l, [{ path: `casinoChat/${room}/messages`, limit: 30 }], `${room}: open`);
    assert.equal(await page.locator('.chat-drawer h3').innerText(), `${{ blackjack: 'Blackjack', baccarat: 'Baccarat', craps: 'Craps', crapless: 'Crapless Craps' }[room]} chat`);
    await page.getByRole('button', { name: 'Close chat' }).click();
    await page.waitForTimeout(100);
    assert.deepEqual(await chatListeners(page), [{ path: `casinoChat/${room}/messages`, limit: 1 }], `${room}: closed again`);
    await page.evaluate(() => { window.history.pushState({}, '', '/my-bets'); window.dispatchEvent(new PopStateEvent('popstate')); });
    await page.waitForTimeout(250);
    assert.deepEqual(await chatListeners(page), [], `${room}: listener removed when the page goes away`);
    await context.close();
  }
});

await check('chat drawer: last 24 h only, oldest on top, names and Central times, mine marked, plain text, removed message, badge and unread memory', async () => {
  const { page, context } = await openChatPage('/casino/craps');
  await page.waitForSelector('.chat-badge');
  assert.equal(await page.locator('.chat-badge').innerText(), '7', 'all 7 of the last 24 h are unread on a first visit (the 25 h old one is not)');
  await chatButton(page).click();
  await page.waitForSelector('.chat-drawer .chat-msg');
  const texts = await page.locator('.chat-msg .chat-msg-text').allInnerTexts();
  assert.equal(texts.length, 7);
  assert.ok(!texts.some((t) => t.includes('must not show')), 'nothing older than 24 h');
  assert.equal(texts[0], 'Anyone else running cold tonight?', 'oldest at the top');
  assert.equal(texts[6], 'gl all', 'newest at the bottom');
  assert.equal(texts[5], 'Message removed');
  assert.equal(await page.locator('.chat-msg.mine').count(), 2);
  assert.equal(await page.locator('.chat-msg.mine .chat-msg-name').first().innerText(), 'You');
  assert.match(await page.locator('.chat-msg-time').first().innerText(), /^\d{1,2}:\d{2} [AP]M$/, '"8:42 PM" style, Central');
  assert.equal(await page.locator('.chat-drawer a').count(), 0, 'links are not clickable');
  assert.equal(await page.locator('.chat-drawer b').count(), 0, 'HTML is shown as text');
  assert.ok(texts[2].includes('<b>not bold</b>'));
  assert.equal(await page.locator('.chat-badge').count(), 0, 'open: no badge');
  // Opened at the bottom.
  const atBottom = () => page.evaluate(() => { const l = document.querySelector('.chat-list'); return l.scrollHeight - l.scrollTop - l.clientHeight < 2; });
  assert.ok(await atBottom(), 'opens at the newest');
  // A new message while I'm at the bottom: it scrolls to it.
  await page.evaluate((m) => { window.__H.fs['casinoChat/craps/messages'].push(m); window.__H.emit(); }, freshMessage('u2_new1', 'u2', 'Dan', 'new one '.repeat(20), 500));
  await page.waitForTimeout(200);
  assert.ok(await atBottom(), 'followed the new message');
  // Scrolled up: a new message does not yank me down.
  await page.evaluate(() => { const l = document.querySelector('.chat-list'); l.scrollTop = 0; l.dispatchEvent(new Event('scroll')); });
  await page.evaluate((m) => { window.__H.fs['casinoChat/craps/messages'].push(m); window.__H.emit(); }, freshMessage('u2_new2', 'u2', 'Dan', 'another', 200));
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => document.querySelector('.chat-list').scrollTop), 0, 'stayed where I was reading');
  // Close: everything shown is seen; a new message from someone else → badge 1 (one count query).
  await page.getByRole('button', { name: 'Close chat' }).click();
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.chat-badge').count(), 0, 'nothing unread after reading');
  const seen = await page.evaluate(() => { try { return Number(localStorage.getItem('bb.chatSeen.craps')); } catch { return -1; } });
  assert.ok(seen > Date.now() - 5000, 'last seen kept per room in localStorage');
  await page.evaluate((m) => { window.__H.fs['casinoChat/craps/messages'].push(m); window.__H.emit(); }, freshMessage('u4_new3', 'u4', 'Ann', 'you there?', 0));
  await page.waitForSelector('.chat-badge');
  assert.equal(await page.locator('.chat-badge').innerText(), '1');
  assert.equal(await chatButton(page).getAttribute('aria-label'), 'Chat, 1 unread');
  // Remembered across a reload (the page's fake data resets to the 7 fixtures, all older than what I saw): no badge until
  // someone writes again, then 1, not 8.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.chat-badge').count(), 0, 'seen survives a reload');
  await page.evaluate((m) => { window.__H.fs['casinoChat/craps/messages'].push(m); window.__H.emit(); }, freshMessage('u4_new4', 'u4', 'Ann', 'hello again', 0));
  await page.waitForSelector('.chat-badge');
  assert.equal(await page.locator('.chat-badge').innerText(), '1');
  await context.close();
});

await check('chat: Send and Enter post one request with the room; 200 counter; refusals shown; a retry reuses the requestId; storage blocked still works', async () => {
  let refuse = 'none';
  const { page, context, calls } = await openChatPage('/casino/blackjack', {
    onChat: async (route, body) => {
      if (refuse === 'slow') return json(route, 429, { error: { code: 'SLOW_DOWN', message: 'Slow down a little' } });
      if (refuse === 'network') return route.abort();
      return json(route, 200, { ok: true, duplicate: false, messageId: `u1_${body.requestId}`, serverNow: now() });
    },
  });
  await chatButton(page).click();
  const box = page.getByLabel('Message');
  await box.fill('hello table');
  assert.equal(await page.locator('.chat-count').innerText(), '11/200');
  await box.press('Enter');
  await page.waitForTimeout(250);
  let chat = calls.filter((c) => c.action === 'chat');
  assert.equal(chat.length, 1);
  assert.equal(chat[0].game, 'blackjack');
  assert.equal(chat[0].text, 'hello table');
  assert.match(chat[0].requestId, /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(await box.inputValue(), '', 'cleared after sending');
  // The Send button too.
  await box.fill('second');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.waitForTimeout(250);
  assert.equal(calls.filter((c) => c.action === 'chat').length, 2);
  // Over 200: the counter turns red and Send is off; nothing is sent.
  await box.fill('z'.repeat(201));
  assert.equal(await page.locator('.chat-count').innerText(), '201/200');
  assert.ok(await page.locator('.chat-count.over').count());
  assert.equal(await page.getByRole('button', { name: 'Send' }).isDisabled(), true);
  await box.press('Enter');
  await page.waitForTimeout(150);
  assert.equal(calls.filter((c) => c.action === 'chat').length, 2);
  // Rate limited: the reason shows.
  refuse = 'slow';
  await box.fill('again');
  await box.press('Enter');
  await page.waitForSelector('.chat-error');
  assert.equal(await page.locator('.chat-error').innerText(), 'Slow down a little');
  // A failed send retried with the same text keeps its requestId (so it can only post once).
  refuse = 'network';
  await box.fill('flaky');
  await box.press('Enter');
  await page.waitForTimeout(250);
  refuse = 'none';
  await box.press('Enter');
  await page.waitForTimeout(250);
  chat = calls.filter((c) => c.action === 'chat' && c.text === 'flaky');
  assert.equal(chat.length, 2);
  assert.equal(chat[0].requestId, chat[1].requestId, 'same requestId on the retry');
  await context.close();

  // localStorage blocked: the drawer and badge still work.
  const blocked = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
  const p2 = await blocked.newPage();
  const errors = [];
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }); });
  await p2.addInitScript((h) => { window.__H = h; }, { user: { uid: 'u1' }, admin: false, fs: { users: F.users, bets: F.bets, ledger: [], customGames: [], casinoTables: [], ...F.chatFs() } });
  await p2.route(/^https:\/\/(?!localhost)/, F.offlineRoute);
  await p2.route('**/api/**', (route) => json(route, 200, { ok: true, ran: false, serverNow: now() }));
  await p2.goto(BASE + '/casino/blackjack', { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('.chat-badge');
  await p2.getByRole('button', { name: /^Chat/ }).click();
  await p2.waitForSelector('.chat-drawer .chat-msg');
  await p2.getByRole('button', { name: 'Close chat' }).click();
  assert.deepEqual(errors, []);
  await blocked.close();
});

await check('chat on craps: opening and closing it never sends a leave; the drawer overlays the felt (no layout shift)', async () => {
  const t = crapsWorst('craps');
  const { page, context, calls } = await openChatPage('/casino/craps', { tables: [t] });
  await page.waitForSelector('.craps-felt');
  const feltTop = () => page.evaluate(() => document.querySelector('.craps-felt').getBoundingClientRect().top);
  const before = await feltTop();
  for (let i = 0; i < 3; i += 1) {
    await chatButton(page).click();
    await page.waitForSelector('.chat-drawer');
    assert.equal(await feltTop(), before, 'the felt did not move');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.chat-drawer').count(), 0, 'Escape closes');
  }
  await chatButton(page).click();
  await page.locator('.chat-backdrop').click({ position: { x: 10, y: 10 } });
  await page.waitForTimeout(600); // longer than the 400 ms leave delay
  assert.equal(calls.filter((c) => c.action === 'leave').length, 0, 'no leave-all from chat');
  assert.equal(await page.evaluate(() => document.body.classList.contains('no-scroll')), false, 'scroll lock removed on close');
  await context.close();
});

// ---------- 0.18.1: a failed chat load is explained, nobody sends blind, Try again subscribes again ----------
const RULES_TEXT = "Chat can't load: the Firestore rules aren't published. Firebase console → Firestore Database → Rules → Publish.";
await check('chat load failure: the admin is told the rules are not published, a player gets the plain text; the text box and Send are disabled; Try again (and closing + reopening) subscribe again', async () => {
  const broken = { 'casinoChat/craps/messages': { error: 'Missing or insufficient permissions.' } };
  const good = () => F.chatMessages('craps');
  // A player.
  let { page, context, calls } = await openChatPage('/casino/craps', { fs: broken });
  await chatButton(page).click();
  await page.waitForSelector('.chat-drawer .chat-empty.error-text');
  assert.equal((await page.locator('.chat-drawer .chat-empty').innerText()).split('\n')[0].trim(), 'Chat is unavailable right now.');
  assert.ok(!(await page.locator('.chat-drawer').innerText()).includes('Firestore'), 'players never see the rules text');
  assert.equal(await page.locator('.chat-form input').isDisabled(), true, 'text box disabled');
  assert.equal(await page.getByRole('button', { name: 'Send' }).isDisabled(), true, 'Send disabled');
  assert.equal(calls.filter((c) => c.action === 'chat').length, 0);
  // Try again with the rules fixed: it subscribes again and the messages arrive (no other trigger).
  await page.evaluate((m) => { window.__H.fs['casinoChat/craps/messages'] = m; }, good());
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.waitForSelector('.chat-drawer .chat-msg');
  assert.equal(await page.locator('.chat-form input').isDisabled(), false, 'text box back');
  await page.locator('.chat-form input').fill('hello');
  assert.equal(await page.getByRole('button', { name: 'Send' }).isDisabled(), false, 'Send back');
  assert.deepEqual(await chatListeners(page), [{ path: 'casinoChat/craps/messages', limit: 30 }], 'one listener, not two');
  await context.close();

  // Closing and reopening subscribes again.
  ({ page, context } = await openChatPage('/casino/craps', { fs: broken }));
  await chatButton(page).click();
  await page.waitForSelector('.chat-drawer .chat-empty.error-text');
  await page.evaluate((m) => { window.__H.fs['casinoChat/craps/messages'] = m; }, good());
  await page.getByRole('button', { name: 'Close chat' }).click();
  await chatButton(page).click();
  await page.waitForSelector('.chat-drawer .chat-msg');
  assert.equal(await page.locator('.chat-form input').isDisabled(), false);
  await context.close();

  // The admin: permission-denied says what to do; another code shows the player text plus the code in small type.
  ({ page, context } = await openChatPage('/casino/craps', { uid: 'u0', admin: true, fs: broken }));
  await chatButton(page).click();
  await page.waitForSelector('.chat-drawer .chat-empty.error-text');
  assert.ok((await page.locator('.chat-drawer .chat-empty').innerText()).includes(RULES_TEXT), 'admin: rules text');
  assert.equal(await page.getByRole('button', { name: 'Send' }).isDisabled(), true);
  await context.close();
  ({ page, context } = await openChatPage('/casino/craps', { uid: 'u0', admin: true, fs: { 'casinoChat/craps/messages': { error: 'The service is unavailable.', code: 'unavailable' } } }));
  await chatButton(page).click();
  await page.waitForSelector('.chat-drawer .chat-empty.error-text');
  const t = await page.locator('.chat-drawer .chat-empty').innerText();
  assert.ok(t.includes('Chat is unavailable right now.') && t.includes('(unavailable)') && !t.includes('Firestore'), t);
  assert.equal(await page.locator('.chat-drawer .chat-code').count(), 1);
  await context.close();
  ({ page, context } = await openChatPage('/casino/craps', { uid: 'u1', fs: { 'casinoChat/craps/messages': { error: 'The service is unavailable.', code: 'unavailable' } } }));
  await chatButton(page).click();
  await page.waitForSelector('.chat-drawer .chat-empty.error-text');
  assert.equal(await page.locator('.chat-drawer .chat-code').count(), 0, 'the code is for the admin only');
  await context.close();
});

await check('Slots has no Chat button and no chat listener; the page fits at 320 / 375 / 414', async () => {
  for (const width of [320, 375, 414]) {
    const { page, context } = await openChatPage('/casino/slots', { width, height: 800 });
    await page.waitForTimeout(300);
    assert.equal(await page.getByRole('button', { name: /^Chat/ }).count(), 0, `${width}: no Chat button`);
    assert.deepEqual(await chatListeners(page), [], `${width}: no chat listener`);
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0, `${width}: no sideways overflow`);
    await context.close();
  }
});

// ---------- 0.18.1: the offline banner on craps (the app's own bars are hidden there) ----------
await check('craps: offline shows the banner above the top bar without covering it or making the page scroll (375×667 upright, 844×390 sideways); it goes away online', async () => {
  for (const [width, height] of [[375, 667], [844, 390], [568, 320], [320, 568]]) {
    const { page, context } = await openCraps('/casino/craps', [crapsWorst('craps')], { width, height });
    assert.equal(await page.locator('.offline-banner').count(), 0, 'online: no banner');
    const before = await measureCraps(page);
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.waitForSelector('.craps-stage .offline-banner');
    await page.waitForTimeout(250);
    const b = await page.locator('.craps-stage .offline-banner').boundingBox();
    const top = await page.locator('.cs-top').boundingBox();
    assert.ok(b.y + b.height <= top.y + 1, `${width}×${height}: banner (${Math.round(b.y + b.height)}) above the top bar (${Math.round(top.y)})`);
    assert.ok(b.y >= -0.5 && b.x >= -0.5 && b.x + b.width <= width + 0.5, 'inside the screen');
    const m = await measureCraps(page);
    if (height >= 600 || width > height) {
      assert.equal(m.stageScroll, before.stageScroll, `${width}×${height}: no new scrolling (${before.stageScroll} → ${m.stageScroll})`);
      assert.equal(m.docScroll, 0);
    }
    assert.deepEqual(m.outside, [], `${width}×${height}: nothing pushed off screen`);
    if (width <= 667 || height >= 600) assert.deepEqual(m.small, [], `${width}×${height}: felt buttons still 44×44`);
    assert.equal(await page.locator('.offline-banner:visible').count(), 1, 'one visible banner only (not the app one too)');
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.offline-banner').count(), 0, 'back online: gone');
    await context.close();
  }
});

await check('chat admin: Delete asks to confirm, then sends chatDelete for that room and message; players see no Delete', async () => {
  const player = await openChatPage('/casino/baccarat');
  await chatButton(player.page).click();
  await player.page.waitForSelector('.chat-drawer .chat-msg');
  assert.equal(await player.page.locator('.chat-delete').count(), 0);
  await player.context.close();
  const { page, context, adminCalls } = await openChatPage('/casino/baccarat', { uid: 'u0', admin: true });
  await chatButton(page).click();
  await page.waitForSelector('.chat-drawer .chat-msg');
  assert.equal(await page.locator('.chat-delete').count(), 6, 'every message but the removed one');
  await page.getByRole('button', { name: "Delete Ann's message" }).click();
  assert.equal(adminCalls.filter((c) => c.action === 'chatDelete').length, 0, 'not before the confirm');
  await page.getByRole('button', { name: 'No' }).click();
  await page.getByRole('button', { name: "Delete Ann's message" }).click();
  await page.getByRole('button', { name: 'Yes, delete' }).click();
  await page.waitForTimeout(200);
  assert.deepEqual(adminCalls.filter((c) => c.action === 'chatDelete').map(({ game, messageId }) => ({ game, messageId })), [{ game: 'baccarat', messageId: 'u4_m2' }]);
  await context.close();
});

// ---------- 0.17.0: Admin → Wallet activity ----------
await check('wallet activity: pick a player, summary + checks; Load more sends the cursor and completes the chain; Open bet shows it in Bets', async () => {
  const full = F.walletActivity('ok');
  const pages = [
    { ...full, entries: full.entries.slice(0, 8), nextCursor: full.entries[7].id },
    { ...full, entries: full.entries.slice(8), nextCursor: null, summary: null },
  ];
  const context = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const calls = [];
  await page.addInitScript((h) => { window.__H = h; }, { user: { uid: 'u0' }, admin: true, fs: { users: F.users, bets: F.bets, ledger: F.ledger, customGames: F.customGames, battles: [], challenges: [] } });
  await page.route(/^https:\/\/(?!localhost)/, F.offlineRoute);
  await page.route('**/api/**', async (route) => {
    const u = new URL(route.request().url());
    const body = route.request().postDataJSON?.() ?? {};
    if (u.pathname === '/api/admin' && body.action === 'walletActivity') {
      calls.push(body);
      return json(route, 200, body.cursor ? pages[1] : pages[0]);
    }
    if (u.pathname === '/api/admin') return json(route, 200, { ok: true, admin: true, username: 'will' });
    return json(route, 200, { ok: true, ran: false });
  });
  await page.goto(BASE + '/admin', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Wallet activity' }).click();
  await page.getByLabel('Player').selectOption('u1');
  await page.waitForSelector('.activity-list');
  assert.deepEqual(calls.map((c) => ({ uid: c.uid, cursor: c.cursor ?? null })), [{ uid: 'u1', cursor: null }]);
  assert.equal(await page.locator('.activity-row:not(.activity-head)').count(), 8);
  assert.match(await page.locator('.activity-row:not(.activity-head)').last().innerText(), /load more to check/);
  assert.match(await page.locator('.activity-summary').innerText(), /Blackjack/);
  assert.match(await page.locator('.activity-time').first().innerText(), /^\d{1,2}:\d{2}:\d{2} [AP]M/, 'Central time with seconds');
  await page.getByRole('button', { name: 'Load more' }).click();
  await page.waitForTimeout(300);
  assert.deepEqual(calls[1], { action: 'walletActivity', uid: 'u1', cursor: full.entries[7].id });
  assert.equal(await page.locator('.activity-row:not(.activity-head)').count(), 12);
  assert.equal(await page.getByRole('button', { name: 'Load more' }).count(), 0);
  assert.match(await page.locator('.activity-row:not(.activity-head)').last().innerText(), /start of 24 h/);
  assert.match(await page.locator('.balance-check').innerText(), /Every balance adds up \(12 entries\)/);
  assert.equal(await page.locator('.activity-row.jump').count(), 0);
  // Filters: Casino → Blackjack shows the two Blackjack rows; the check still covers everything.
  await page.getByRole('tab', { name: 'Casino', exact: true }).click();
  await page.getByLabel('Game').selectOption('blackjack');
  assert.deepEqual(await page.locator('.activity-row:not(.activity-head) .activity-where').allInnerTexts(), ['Blackjack seat 3', 'Blackjack seat 3']);
  await page.getByRole('tab', { name: 'All', exact: true }).click();
  // Open bet › → Admin → Bets with that bet first.
  await page.getByRole('button', { name: 'Open bet ›' }).first().click();
  await page.waitForSelector('.focus-bet');
  assert.equal(await page.getByRole('tab', { name: 'Bets', exact: true }).getAttribute('aria-selected'), 'true');
  assert.match(await page.locator('.focus-bet').innerText(), /Bet u1_req_b2/);
  await context.close();
});

await browser.close();
console.log(results.join('\n'));
if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);
