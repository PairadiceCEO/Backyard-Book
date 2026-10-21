// node dealcheck.mjs — watches the real Blackjack and Baccarat pages deal (mocked Firebase + /api) and
// checks, by sampling the screen between card times, that cards turn over one at a time at the
// server-timed moments from shared/casino/timing.js, and that a phone opening mid-deal shows the
// cards already dealt.
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

async function openPage(path, table) {
  const context = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.addInitScript((h) => { window.__H = h; }, { user: { uid: 'u1' }, admin: false, fs: { users: F.users, bets: F.bets, ledger: F.ledger, customGames: F.customGames, casinoTables: [table] } });
  await page.route(/^https:\/\/(?!localhost)/, F.offlineRoute);
  await page.route('**/api/**', (route) => json(route, 200, { ok: true, applied: false }));
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  return { page, context };
}

// Counts the cards on screen at `atMs` after `start` (wall clock), for each sample time.
async function sample(page, start, times, selector) {
  const counts = [];
  for (const t of times) {
    const wait = start + t - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    counts.push(await page.locator(selector).count());
  }
  return counts;
}

const bjSeat = (uid, name, betCents, cards) => ({ uid, name, sitAt: Date.now() - 60000, leaving: false, reqs: [], betCents, stakeCents: betCents, returnCents: 0, insurance: null, hands: betCents ? [{ cards, betCents, status: 'playing', seq: 0, fromSplit: false, splitAces: false, doubled: false, outcome: null }] : [], result: null });

function bjDeal(at) {
  // Seats 1, 2, 3, 5 bet; seat 4 is seated without a bet. Dealer A up (insurance), hole card down.
  const order = ['0-0', '1-0', '2-0', '4-0', 'd', '0-0', '1-0', '2-0', '4-0', 'd'];
  const cards = order.map((to, k) => ({ to, i: k < 5 ? 0 : 1, t: k * 1000, opening: true }));
  return {
    id: 'blackjack', game: 'blackjack', epoch: 'y', roundNo: 8, roundId: 'y-8', phase: 'insurance', deadline: at + 9000 + 700 + 15000, turn: null,
    dealer: { cards: ['AH0'], holeDown: true }, lastDeal: { at, cards }, shoe: { remaining: 240, total: 312, shuffles: 0 }, version: 31,
    seats: [bjSeat('u0', 'Will', 500, ['5S0', '9C0']), bjSeat('u1', 'Mike', 500, ['6S0', '6H0']), bjSeat('u2', 'Dan', 500, ['7S0', 'TC0']), bjSeat('u4', 'Ann', 0, []), bjSeat('u5', 'Bo', 500, ['8S0', '2C0'])],
  };
}

await check('Blackjack: 10 opening cards turn over one at a time, 1 s apart (seat 1, 2, 3, 5, dealer, twice)', async () => {
  const at = Date.now() + 1500; // the deal lands 1.5 s after the page opens
  const { page, context } = await openPage('/casino/blackjack', bjDeal(at));
  // On screen: the dealer's cards and "Your hand" (seat 2). Deal order seat 1, 2, 3, 5, dealer, twice,
  // 1 s apart → my cards at 1 s and 6 s, the dealer's at 4 s and 9 s (face down).
  const times = [-500, 500, 1500, 3500, 4500, 5500, 6500, 8500, 9500];
  const counts = await sample(page, at, times, '.bj-cards .pcard');
  assert.deepEqual(counts, [0, 0, 1, 1, 2, 2, 3, 3, 4], `cards on screen at ${times.join(', ')} ms: ${counts.join(', ')}`);
  await context.close();
});

await check('Blackjack: every seat gets its card in turn (seat totals: 1 → 2 → 3 → 5, seat 4 has no bet)', async () => {
  const at = Date.now() + 1500;
  const { page, context } = await openPage('/casino/blackjack', bjDeal(at));
  const seatText = async () => (await page.locator('.bjt-seats').innerText()).replace(/\s+/g, ' ').trim();
  const snaps = [];
  for (const t of [500, 1500, 2500, 3500, 5500, 6500, 7500, 8500]) {
    await page.waitForTimeout(Math.max(0, at + t - Date.now()));
    snaps.push(await seatText());
  }
  const totals = snaps.map((line) => [...line.matchAll(/(Will|Mike|Dan|Bo) (\d+)/gi)].map((m) => Number(m[2])));
  assert.deepEqual(totals, [
    [5, 0, 0, 0], [5, 6, 0, 0], [5, 6, 7, 0], [5, 6, 7, 8],
    [14, 6, 7, 8], [14, 12, 7, 8], [14, 12, 17, 8], [14, 12, 17, 10],
  ], snaps.join(' || '));
  assert.ok(snaps.every((line) => /ann —/i.test(line)), 'seat 4 (no bet) gets no cards');
  await page.waitForTimeout(Math.max(0, at + 9500 - Date.now()));
  assert.equal(await page.locator('.bj-cards .pcard.back').count(), 1, 'the hole card is face down');
  await context.close();
});

await check('Blackjack: "Dealing…" while cards turn over; the insurance clock only shows after the last card', async () => {
  const at = Date.now() + 1000;
  const { page, context } = await openPage('/casino/blackjack', bjDeal(at));
  await page.waitForTimeout(at + 4500 - Date.now());
  assert.match(await page.locator('main').innerText(), /Dealing/);
  assert.equal(await page.locator('.countdown').count(), 0, 'no clock while dealing');
  await page.waitForTimeout(at + 9800 - Date.now());
  assert.ok((await page.locator('.countdown').count()) > 0, 'clock shows once the cards are down');
  await context.close();
});

await check('Blackjack: a phone that opens mid-deal shows the cards already dealt, then the rest on time', async () => {
  const at = Date.now() - 4500; // 5 cards (t = 0…4 s) were already dealt
  const { page, context } = await openPage('/casino/blackjack', bjDeal(at));
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.bj-cards .pcard').count(), 2, 'my first card and the dealer up card are already down');
  const counts = await sample(page, at, [5500, 6500, 8500, 9500], '.bj-cards .pcard');
  assert.deepEqual(counts, [2, 3, 3, 4]);
  await context.close();
});

function bacCoup(dealtAt) {
  return {
    id: 'baccarat', game: 'baccarat', epoch: 'x', roundNo: 42, roundId: 'x-42', phase: 'results', deadline: dealtAt + 6000 + 700 + 5000,
    coup: { player: ['KS0', '4H2', '3D1'], banker: ['2C0', '3H1', '4S2'], playerTotal: 7, bankerTotal: 9, winner: 'banker', natural: false, dealtAt },
    shoeResults: 'PBB', shoe: { remaining: 300, total: 416, shuffles: 1 }, version: 10,
    seats: [null, { uid: 'u1', name: 'Mike', sitAt: Date.now() - 60000, leaving: false, ready: true, bets: { player: 0, banker: 300, tie: 0 }, reqs: [], result: { stakeCents: 300, returnCents: 585, netCents: 285 } }, null, null, null],
  };
}

await check('Baccarat: Player, Banker, Player, Banker 1 s apart, third cards 1.5 s later', async () => {
  const at = Date.now() + 1500;
  const { page, context } = await openPage('/casino/baccarat', bacCoup(at));
  // Cards at 0, 1000, 2000, 3000, 4500, 6000.
  const times = [-500, 500, 1500, 2500, 3500, 4200, 5000, 5800, 6500];
  const counts = await sample(page, at, times, '.pcard');
  assert.deepEqual(counts, [0, 1, 2, 3, 4, 4, 5, 5, 6], `cards on screen at ${times.join(', ')} ms: ${counts.join(', ')}`);
  await context.close();
});

await check('Baccarat: the first two cards are one Player card and one Banker card (one at a time)', async () => {
  const at = Date.now() + 1000;
  const { page, context } = await openPage('/casino/baccarat', bacCoup(at));
  await page.waitForTimeout(at + 1500 - Date.now());
  const hands = await page.evaluate(() => [...document.querySelectorAll('.pcard')].map((c) => c.closest('[class*="player"], [class*="banker"]')?.className ?? '?'));
  assert.equal(hands.length, 2);
  assert.ok(/player/i.test(hands[0]) || /player/i.test(hands.join()), `first card in the Player hand (${hands.join(' | ')})`);
  assert.ok(hands.some((h) => /banker/i.test(h)), `second card in the Banker hand (${hands.join(' | ')})`);
  await context.close();
});

// 0.19.0: each card slides out of the shoe (about 250 ms) at the moment it turns face up; when it shows is unchanged.
await check('Blackjack: a card that turns over slides from the shoe (an animation runs right after it shows), and is still on time', async () => {
  const at = Date.now() + 2500;
  const { page, context } = await openPage('/casino/blackjack', bjDeal(at));
  await page.waitForTimeout(Math.max(0, at + 1000 + 40 - Date.now())); // my first card shows at +1 s
  const info = await page.locator('.seat-panel .bj-cards .pcard').first().evaluate((el) => ({ n: el.getAnimations().length, timing: el.getAnimations().map((a) => a.effect.getComputedTiming().duration) }));
  assert.ok(info.n >= 1, 'a slide animation is running');
  assert.ok(info.timing.includes(250), `a 250 ms slide (${info.timing})`);
  await page.waitForTimeout(400);
  const cards = await page.locator('.bj-cards .pcard').count();
  assert.equal(cards, 1, 'still exactly the cards that are due (the dealer\'s first card is at 4 s)');
  await context.close();
});

await check('Baccarat: the first card slides from the shoe; a phone that opens later just shows the cards', async () => {
  const at = Date.now() + 2500;
  const { page, context } = await openPage('/casino/baccarat', bacCoup(at));
  await page.waitForTimeout(Math.max(0, at + 40 - Date.now()));
  assert.ok((await page.locator('.bact-box .pcard').first().evaluate((el) => el.getAnimations().length)) >= 1, 'sliding');
  await context.close();
  const late = await openPage('/casino/baccarat', bacCoup(Date.now() - 20000));
  await late.page.waitForTimeout(300);
  assert.equal(await late.page.locator('.bact-box .pcard').count(), 6);
  assert.equal(await late.page.locator('.bact-box .pcard').first().evaluate((el) => el.getAnimations().filter((a) => a.effect.getComputedTiming().duration === 250).length), 0, 'no slide for cards already on the table');
  await late.context.close();
});

await browser.close();
console.log(results.join('\n'));
if (results.some((r) => r.startsWith('FAIL'))) process.exitCode = 1;
