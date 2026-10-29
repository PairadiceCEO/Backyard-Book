// node --experimental-test-module-mocks tapcheck.mjs <repo root> [--work=1500] [--lag=150] [--game=craps] [--verbose]
// 0.23.0 "every chip tap counts": 10 quick taps of a $5 chip on one spot within 2 s, on every game, with the REAL engines
// (server/casino behind an in-memory Firestore) and the real client, and real timers. Each run checks that the screen and the
// server end at exactly $50 on that spot (Slots: the bet picker shows $50 and the spin sends $50).
//   --work=<ms>   server time per request (a slow reply: taps land while a batch is in flight). Default: both 0 and 1500.
//   --lag=<ms>    how long after a write the table and wallet reach the page's listeners (default 150)
// Taps are touch taps (hasTouch) with `force`, so a button that is disabled at that moment loses the tap, as on a phone.
import { mock } from 'node:test';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as F from './fixtures.mjs';

const root = process.argv.slice(2).find((a) => a.startsWith('/')) ?? '/home/claude/backyard-book';
const opt = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const LAG = Number(opt('lag') ?? 150);
const WORKS = opt('work') !== undefined ? [Number(opt('work'))] : [0, 1500];
const ONLY = opt('game') ?? null;
const VERBOSE = process.argv.includes('--verbose');
const TAPS = 10;
const TAP_GAP_MS = Number(opt("gap") ?? 180); // 10 taps in about 1.6 s by default; --gap=<ms> for faster bursts
const url = (p) => pathToFileURL(`${root}/${p}`).href;

const { makeFakeDb } = await import(url('test/casino/fakeFirestore.mjs'));
const fake = makeFakeDb();
mock.module(url('server/firebaseAdmin.js'), { namedExports: { adminDb: () => fake.db, adminAuth: () => ({}), normalizePrivateKey: (k) => k } });
const { handleCasinoAction } = await import(url('server/casino/router.js'));

const BASE = 'http://localhost:5199';
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
const results = [];

const START_CENTS = 1_000_000; // $10,000

// Each game: the spot that is tapped (a CSS selector) and how the server holds it. The screen is read from the spot's
// aria-label. Craps and Crapless also run with another player's roll landing in the middle of the taps (`roll`): the taps
// go on Place 6 (on a come-out since 0.23.0; the forced roll is a 7, which never touches a Place bet on a come-out).
const seatOf = (game, uid) => fake.get(`casinoTables/${game}`).seats.find((s) => s?.uid === uid);
const GAMES = {
  blackjack: { sel: '.bj-bet-spot', label: /bet \$([\d,]+\.\d{2})/, server: () => seatOf('blackjack', 'u1').betCents },
  baccarat: { sel: '.bac-spot.player', label: /your bet \$([\d,]+\.\d{2})/, server: () => seatOf('baccarat', 'u1').bets.player },
  craps: { sel: '.craps-felt [data-spot="pass"]:not([data-part="strip"])', label: /\$([\d,]+\.\d{2}) on it/, server: () => seatOf('craps', 'u1').bets.pass },
  crapless: { sel: '.craps-felt [data-spot="place:6"]', label: /\$([\d,]+\.\d{2}) on it/, server: () => seatOf('crapless', 'u1').bets.place?.[6] ?? 0 },
  slots: { sel: '.slot-bet', label: /^Bet \$([\d,]+(?:\.\d{2})?)/, server: null }, // the bet is local until Spin: the spin carries it
};
const PLACE6 = { sel: '.craps-felt [data-spot="place:6"]', label: /\$([\d,]+\.\d{2}) on it/ };

async function run(game, work, mode = 'plain') {
  fake.reset();
  for (const u of F.users) fake.write(`users/${u.id}`, { ...u, balanceCents: START_CENTS, disabled: false });
  const log = [];
  const t0 = Date.now();
  const note = (what) => log.push(`${String(Date.now() - t0).padStart(6)} ms  ${what}`);
  const spins = [];
  let page;
  // Push table + wallet writes to the page's listeners LAG ms later, in commit order.
  let lastSeen = '';
  const poll = setInterval(() => {
    const t = fake.get(`casinoTables/${game}`);
    const u = fake.get('users/u1');
    const key = `${t?.version ?? '-'}/${u?.balanceCents}`;
    if (key === lastSeen || !page) return;
    lastSeen = key;
    const tables = t ? [{ id: game, ...structuredClone(t) }] : [];
    const users = F.users.map((x) => ({ ...x, ...(fake.get(`users/${x.id}`) ?? {}), id: x.id }));
    setTimeout(() => {
      page?.evaluate(([tt, uu]) => { window.__H.fs.casinoTables = tt; window.__H.fs.users = uu; window.__H.emit?.(); }, [tables, users]).catch(() => {});
      note(`listener → table v${t?.version ?? '-'}, wallet ${u?.balanceCents}`);
    }, LAG);
  }, 15);

  const server = (uid, body, dice = null) => {
    const queue = dice ? [...dice] : [];
    return handleCasinoAction({ uid, token: {}, user: null }, body, { now: Date.now(), randomInt: (m) => (m === 6 && queue.length ? queue.shift() - 1 : Math.floor(Math.random() * m)) });
  };
  if (mode === 'roll') {
    // u2 sits first and bets Pass, so u2 has the dice; Will (u1) sits next to them.
    await server('u2', { action: 'sit', game, seat: 0 });
    await server('u2', { action: 'bets', game, seat: 0, changes: [{ kind: 'pass', cents: 500 }], requestId: 'tapcheck-u2-pass-1' });
    await server('u1', { action: 'sit', game, seat: 1 });
  } else if (game !== 'slots') await server('u1', { action: 'sit', game, seat: 0 });
  const context = await browser.newContext({ viewport: { width: 375, height: 760 }, isMobile: true, hasTouch: true });
  page = await context.newPage();
  const initial = fake.get(`casinoTables/${game}`);
  const users0 = F.users.map((x) => ({ ...x, balanceCents: START_CENTS }));
  await page.addInitScript((h) => { window.__H = h; try { window.sessionStorage.setItem('backyardbook.slotBet', '0'); } catch { /* blocked */ } }, { user: { uid: 'u1' }, admin: false, fs: { users: users0, bets: [], ledger: [], customGames: [], casinoTables: initial ? [{ id: game, ...initial }] : [] } });
  await page.route(/^https:\/\/(?!localhost)/, F.offlineRoute);
  await page.route('**/api/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname !== '/api/casino') return json(route, 200, { ok: true, ran: false });
    const body = route.request().postDataJSON() ?? {};
    if (body.action === 'spin') {
      spins.push(body);
      return json(route, 200, { ok: true, stops: [1, 2, 3], symbols: ['BL', 'B1', 'CH'], line: null, betCents: body.amount * 100, winCents: 0, balanceCents: START_CENTS - body.amount * 100, serverNow: Date.now() });
    }
    try {
      const reply = await server('u1', body);
      if (work) await new Promise((r) => setTimeout(r, work));
      if (!['heartbeat', 'tick'].includes(body.action)) note(`${body.action} ${JSON.stringify(body.changes ?? body.amount ?? [body.player, body.banker, body.tie])} → ok`);
      return json(route, 200, { ...reply, serverNow: Date.now() });
    } catch (err) {
      note(`${body.action} → ${err.code ?? err.message}: ${err.message}`);
      if (work) await new Promise((r) => setTimeout(r, work));
      return json(route, err.status ?? 500, { error: { code: err.code ?? 'ERR', message: err.message } });
    }
  });
  await page.goto(`${BASE}/casino/${game}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const G = mode === 'roll' ? { ...GAMES[game], ...PLACE6, server: () => seatOf(game, 'u1').bets.place?.[6] ?? 0 } : GAMES[game];
  const screen = async () => G.label.exec((await page.locator(G.sel).first().getAttribute('aria-label')) ?? '')?.[1] ?? '0.00';
  if (game === 'slots') await page.getByRole('button', { name: 'Clear' }).click().catch(() => {});
  await page.getByRole('radio', { name: '$5 chip' }).first().click();
  const spot = page.locator(G.sel).first();
  await spot.waitFor({ state: 'visible', timeout: 5000 });
  await spot.evaluate((el) => el.scrollIntoView({ block: 'center' })); // the taps are forced (no scrolling of their own); since 0.26.0 the Blackjack spot is on the felt, above the chips
  // Every control a quick tap lands on: the spot, the chips, Undo and Clear. touch-action: manipulation is what stops an
  // iPhone from taking a second quick tap as a double-tap zoom (Chromium here has no double-tap zoom on this page).
  const touch = await page.evaluate((sel) => {
    const els = [document.querySelector(sel), ...document.querySelectorAll('[role="radio"][aria-label$=" chip"]'), ...[...document.querySelectorAll('button')].filter((b) => /^(Undo|Clear)$/.test(b.innerText.trim()))];
    return els.filter(Boolean).map((e) => `${e.getAttribute('aria-label')?.slice(0, 18) ?? e.innerText.trim()}=${getComputedStyle(e).touchAction}`);
  }, G.sel);
  if (VERBOSE) {
    // what a finger on the middle of the spot actually lands on
    const hit = await spot.evaluate((el) => { const r = el.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return `${t?.tagName}.${t?.className?.baseVal ?? t?.className} inside spot: ${el.contains(t)}; spot box ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`; });
    note(`middle of the spot hits ${hit}`);
  }
  const tapStart = Date.now();
  for (let i = 0; i < TAPS; i += 1) {
    await spot.tap({ force: true, timeout: 1000 }).catch((e) => note(`tap ${i + 1} failed: ${e.message.split('\n')[0]}`));
    if (mode === 'roll' && i === 3) {
      // Another player's roll (3+4 = 7 on the come-out) lands between tap 4 and tap 5.
      await server('u2', { action: 'roll', game, seat: 0, rollSeq: fake.get(`casinoTables/${game}`).rollSeq }, [3, 4]);
      note('u2 rolled 3+4 (come-out 7)');
    }
    if (i < TAPS - 1) await page.waitForTimeout(TAP_GAP_MS);
  }
  note(`${TAPS} taps in ${Date.now() - tapStart} ms`);
  const shownRightAway = await screen();
  // Let every batch and the listener settle.
  await page.waitForTimeout(Math.max(1500, work * 4 + 1200));
  const shown = await screen();
  let serverCents = null;
  if (game === 'slots') {
    await page.getByRole('button', { name: /^Spin/ }).click();
    await page.waitForTimeout(400);
    serverCents = spins.length ? spins.at(-1).amount * 100 : 0;
  } else serverCents = G.server();
  const err = (await page.locator('.error-text').allInnerTexts().catch(() => [])).filter(Boolean);
  clearInterval(poll);
  await context.close();

  const name = `${game}: ${TAPS} quick $5 taps (server reply ${work} ms${mode === 'roll' ? ", another player's roll lands mid-taps" : ''}) → $50 on the screen and the server`;
  try {
    assert.equal(shownRightAway?.replace(/\.00$/, ''), '50', `right after the taps the screen shows $${shownRightAway}`);
    assert.equal(shown?.replace(/\.00$/, ''), '50', `the screen ends at $${shown}`);
    assert.equal(serverCents, 5000, `the server holds $${(serverCents ?? 0) / 100}`);
    assert.deepEqual(err, [], `error shown: ${err.join(' | ')}`);
    const bad = touch.filter((t) => !t.endsWith('=manipulation'));
    assert.deepEqual(bad, [], `controls without touch-action: manipulation: ${bad.join(', ')}`);
    results.push(`ok   ${name}`);
    if (VERBOSE) results.push(...log.map((l) => `       ${l}`));
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message.split('\n')[0]}`);
    results.push(...log.map((l) => `       ${l}`));
  }
}

for (const game of Object.keys(GAMES)) {
  if (ONLY && ONLY !== game) continue;
  for (const work of WORKS) {
    await run(game, work);
    if (game === 'craps' || game === 'crapless') await run(game, work, 'roll');
  }
}
await browser.close();
console.log(results.join('\n'));
if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);
