// node --experimental-test-module-mocks tablesim.mjs <repo root>
// Blackjack and Baccarat end to end with the REAL table engine (server/casino, in-memory Firestore) behind two browser
// pages, with real timers: Will (u1) seated and betting, and a player (u2) who only watches. Every table write reaches
// both pages' listeners LISTENER_MS later, like Firestore. Optional skews reproduce real-world conditions:
//   --skew=<ms>      every /api/casino reply's serverNow is shifted (a phone whose server-clock estimate is off)
//   --tickfail=<n>   the first n ticks fail (cold starts / network)
//   --lag=<ms>       listener delay (default 150)
// Checks: after the results countdown reaches 0, within ~1 s BOTH pages show the betting phase, an empty dealer and $0
// spots. Prints a timeline for diagnosis.
import { mock } from 'node:test';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as F from './fixtures.mjs';

const root = process.argv.slice(2).find((a) => a.startsWith('/')) ?? '/home/claude/backyard-book';
const arg = (name, dflt) => Number((process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `=${dflt}`).split('=')[1]);
const SKEW = arg('skew', 0);
const TICK_FAILS = arg('tickfail', 0);
const LISTENER_MS = arg('lag', 150);
const WATCH = arg('watch', 0);
const WORK = arg('work', 0); // --work=<ms>: server processing time per request (token check + Firestore transaction)
const ONLY = process.argv.find((a) => a.startsWith('--game='))?.split('=')[1] ?? null;
const url = (p) => pathToFileURL(`${root}/${p}`).href;

const { makeFakeDb } = await import(url('test/casino/fakeFirestore.mjs'));
const fake = makeFakeDb();
mock.module(url('server/firebaseAdmin.js'), { namedExports: { adminDb: () => fake.db, adminAuth: () => ({}), normalizePrivateKey: (k) => k } });
const { handleCasinoAction } = await import(url('server/casino/router.js'));

const BASE = 'http://localhost:5199';
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
const results = [];
const t0 = Date.now();
const log = [];
const note = (who, what) => log.push(`${String(Date.now() - t0).padStart(6)} ms  ${who.padEnd(5)} ${what}`);

async function runGame(game) {
  fake.reset();
  log.length = 0;
  for (const u of F.users) fake.write(`users/${u.id}`, { ...u, balanceCents: 100_000, disabled: false });
  let tickCount = 0;
  const pages = [];
  // Push table writes to every page's listener, LISTENER_MS later (in commit order).
  let lastVersion = null;
  const poll = setInterval(() => {
    const t = fake.get(`casinoTables/${game}`);
    if (!t || t.version === lastVersion) return;
    lastVersion = t.version;
    const copy = { id: game, ...structuredClone(t) };
    setTimeout(() => {
      for (const { page } of pages) page.evaluate((tt) => { window.__H.fs.casinoTables = [tt]; window.__H.emit?.(); }, copy).catch(() => {});
      note('fs', `listener → v${copy.version} ${copy.phase}${copy.deadline ? ` deadline +${copy.deadline - Date.now()} ms` : ''}`);
    }, LISTENER_MS);
  }, 20);

  async function openAs(uid) {
    const context = await browser.newContext({ viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.addInitScript((h) => { window.__H = h; }, { user: { uid }, admin: false, fs: { users: F.users, bets: [], ledger: [], customGames: [], casinoTables: fake.get(`casinoTables/${game}`) ? [{ id: game, ...fake.get(`casinoTables/${game}`) }] : [] } });
    await page.route(/^https:\/\/(?!localhost)/, F.offlineRoute);
    await page.route('**/api/**', async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname !== '/api/casino') return json(route, 200, { ok: true, ran: false });
      const body = route.request().postDataJSON() ?? {};
      if (body.action === 'tick') {
        tickCount += 1;
        if (tickCount <= TICK_FAILS) {
          note(uid, `tick #${tickCount} → network error (forced)`);
          return route.abort();
        }
      }
      try {
        const startedAt = Date.now();
        // Like Vercel: the action starts now, the transaction takes WORK ms, then the router stamps serverNow.
        const reply = await handleCasinoAction({ uid, token: {}, user: null }, body, { now: startedAt });
        if (WORK) await new Promise((r) => setTimeout(r, WORK));
        if (body.action !== 'heartbeat') note(uid, `${body.action}${body.action === 'tick' ? ` #${tickCount}` : ''} → ${reply.applied === false ? 'not yet' : 'ok'}${reply.table ? ` v${reply.table.version} ${reply.table.phase}` : ''}`);
        const routerStamp = reply.serverStart !== undefined ? { serverStart: startedAt + SKEW } : {};
        return json(route, 200, { ...reply, ...routerStamp, serverNow: Date.now() + SKEW });
      } catch (err) {
        note(uid, `${body.action} → ${err.code ?? err.message}`);
        return json(route, err.status ?? 500, { error: { code: err.code ?? 'ERR', message: err.message } });
      }
    });
    await page.goto(`${BASE}/casino/${game}`, { waitUntil: 'domcontentloaded' });
    const entry = { page, context, uid };
    pages.push(entry);
    return entry;
  }

  // Will sits (through the real engine), then both pages open; the watcher never sits.
  await handleCasinoAction({ uid: 'u1', token: {}, user: null }, { action: 'sit', game, seat: 0 }, { now: Date.now() });
  const will = await openAs('u1');
  const watcher = await openAs('u2');
  await will.page.waitForTimeout(800);

  const status = async (page) =>
    page.evaluate(() => {
      const el = document.querySelector('.table-status');
      const phase = [...(el?.classList ?? [])].find((c) => c.startsWith('phase-'))?.slice(6) ?? null;
      const labels = [...document.querySelectorAll('[aria-label*=" bet $"], [aria-label*="your bet $"]')].map((b) => b.getAttribute('aria-label'));
      return { phase, text: el?.innerText.replace(/\s+/g, ' ').trim() ?? '', cards: document.querySelectorAll('.bjt-felt .pcard, .bact-felt .pcard').length, labels };
    });

  // Bet $10 and confirm.
  await will.page.getByRole('radio', { name: '$10 chip' }).first().click();
  if (game === 'blackjack') await will.page.locator('[aria-label^="Seat 1 bet"]').first().click();
  else await will.page.getByRole('button', { name: /Player, pays/ }).click();
  await will.page.waitForTimeout(700);
  await will.page.getByRole('button', { name: game === 'blackjack' ? /^Deal me in/ : /^Confirm/ }).click();
  note('test', 'confirmed');

  // Blackjack: stand as soon as it's my move (or let the 15 s clock stand for me).
  if (game === 'blackjack') {
    const stand = will.page.getByRole('button', { name: /^Stand/ });
    await stand.waitFor({ state: 'visible', timeout: 30000 }).then(() => stand.click()).catch(() => note('test', 'no Stand (dealt a blackjack or dealer blackjack)'));
    note('test', 'stood');
  }

  // Wait for the results phase on Will's page, then for its countdown to hit 0.
  await will.page.waitForFunction(() => document.querySelector('.table-status')?.classList.contains('phase-results'), null, { timeout: 30000 });
  note('test', 'results on screen');
  const deadline = fake.get(`casinoTables/${game}`).deadline;
  await will.page.waitForFunction(() => /Next hand in 0s/.test(document.querySelector('.table-status')?.innerText ?? '') || !document.querySelector('.table-status')?.classList.contains('phase-results'), null, { timeout: 30000 });
  const zeroAt = Date.now();
  note('test', `countdown 0 on Will's screen (server deadline ${deadline - zeroAt >= 0 ? '+' : ''}${deadline - zeroAt} ms from now)`);

  // Within ~1 s (plus the listener) both screens: betting, no cards, $0.
  const okBy = async (entry) => {
    try {
      await entry.page.waitForFunction(() => document.querySelector('.table-status')?.classList.contains('phase-betting'), null, { timeout: 1500 });
      return Date.now() - zeroAt;
    } catch {
      return null;
    }
  };
  const [willMs, watchMs] = await Promise.all([okBy(will), okBy(watcher)]);
  // --watch=<ms>: keep watching to see whether (and when) a late screen ever moves on.
  if (WATCH && (willMs === null || watchMs === null)) {
    const until = async (entry, who) => {
      const start = Date.now();
      try {
        await entry.page.waitForFunction(() => document.querySelector('.table-status')?.classList.contains('phase-betting'), null, { timeout: WATCH });
        note('test', `${who}'s screen reached betting ${Date.now() - zeroAt} ms after 0`);
      } catch {
        note('test', `${who}'s screen STILL on results ${Date.now() - start + 1500} ms after 0`);
      }
    };
    await Promise.all([until(will, 'Will'), until(watcher, 'watcher')]);
  }
  const sWill = await status(will.page);
  const sWatch = await status(watcher.page);
  note('test', `Will: ${JSON.stringify(sWill)}`);
  note('test', `watcher: ${JSON.stringify(sWatch)}`);
  const server = fake.get(`casinoTables/${game}`);
  note('test', `server: v${server.version} ${server.phase}`);
  clearInterval(poll);
  for (const p of pages) await p.context.close();

  const name = `${game}: results countdown 0 → next hand on both screens within ~1 s (skew ${SKEW} ms, ${TICK_FAILS} failed ticks)`;
  try {
    assert.ok(willMs !== null, "Will's screen wasn't on the next hand within 1.5 s of 0");
    assert.ok(watchMs !== null, "the watcher's screen wasn't on the next hand within 1.5 s of 0");
    for (const [who, s] of [['Will', sWill], ['watcher', sWatch]]) {
      assert.equal(s.cards, 0, `${who}: dealer and hands empty`);
      assert.ok(s.labels.every((l) => /\$0\.00/.test(l)), `${who}: spots at $0 (${s.labels.join(' | ')})`);
    }
    results.push(`ok   ${name} (Will ${willMs} ms, watcher ${watchMs} ms)`);
    if (process.argv.includes('--verbose')) results.push(...log.map((l) => `       ${l}`));
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message.split('\n')[0]}`);
    results.push(...log.map((l) => `       ${l}`));
  }
}

for (const game of ['blackjack', 'baccarat']) if (!ONLY || ONLY === game) await runGame(game);
await browser.close();
console.log(results.join('\n'));
if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);
