// npm test: the 0.27.0 rename and look, the parts that are checkable without a screen: the app's name where users see it, the icons
// (sizes), the Spotlight pick, and the contrast of the theme's text colours on the surfaces they sit on (4.5:1, 3:1 for large text).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_NAME } from '../shared/constants.js';
import { liveProgress, spotlightGame } from '../src/lib/board.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the name: Pairadice Casino everywhere users see it', () => {
  assert.equal(APP_NAME, 'Pairadice Casino');
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  assert.equal(manifest.name, 'Pairadice Casino');
  assert.equal(manifest.short_name, 'Pairadice');
  assert.equal(manifest.theme_color, '#060608');
  assert.equal(manifest.background_color, '#060608');
  assert.equal(manifest.start_url, '/sportsbook');
  const html = read('index.html');
  assert.match(html, /<title>Pairadice Casino<\/title>/);
  assert.match(html, /name="apple-mobile-web-app-title" content="Pairadice"/);
  assert.match(html, /name="application-name" content="Pairadice"/);
  assert.match(html, /rel="icon" href="\/favicon\.ico"/);
  assert.match(html, /rel="apple-touch-icon" sizes="180x180"/);
  assert.match(html, /family=Inter:wght@400;500;600;700;800/);
  assert.match(html, /display=swap/);
  for (const file of ['index.html', 'public/manifest.webmanifest', 'src/components/StatusViews.jsx', 'src/components/RequireAuth.jsx', 'src/components/NavBar.jsx', 'src/pages/LoginPage.jsx']) {
    assert.doesNotMatch(read(file), /Backyard/i, `${file} still says Backyard`);
  }
});

function pngSize(path) {
  const buf = readFileSync(new URL(`../${path}`, import.meta.url));
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

test('icons: the PNGs are rendered at the sizes the manifest and index.html name', () => {
  assert.deepEqual(pngSize('public/icons/icon-512.png'), [512, 512]);
  assert.deepEqual(pngSize('public/icons/icon-192.png'), [192, 192]);
  assert.deepEqual(pngSize('public/icons/icon-maskable-512.png'), [512, 512]);
  assert.deepEqual(pngSize('public/icons/apple-touch-icon.png'), [180, 180]);
  assert.deepEqual(pngSize('public/icons/favicon-32.png'), [32, 32]);
  const ico = readFileSync(new URL('../public/favicon.ico', import.meta.url));
  assert.equal(ico.readUInt16LE(2), 1); // an icon file
  assert.equal(ico[6], 32);
  assert.equal(ico[7], 32);
  const svg = read('public/icon.svg');
  assert.match(svg, /#050506/);
  assert.match(svg, /#1d1a14/);
  assert.match(svg, /rx="40"/);
  assert.match(read('tools/render-icons.mjs'), /stroke-width|small \? 3\.6 : 2\.4/);
});

const game = (id, o = {}) => ({
  id,
  league: 'nba',
  state: 'pre',
  startTime: '2026-10-29T00:00:00.000Z',
  statusText: '',
  markets: { moneyline: { home: { american: -110 }, away: { american: -110 } } },
  ...o,
});

test('Spotlight: the next upcoming game with both moneylines; the live game closest to finishing on the Live tab; none → null', () => {
  const later = game('b', { startTime: '2026-10-29T03:00:00.000Z' });
  const soon = game('a', { startTime: '2026-10-29T01:00:00.000Z' });
  const noPrice = game('c', { startTime: '2026-10-28T23:00:00.000Z', markets: { moneyline: { home: null, away: null } } });
  const closed = game('d', { startTime: '2026-10-28T22:00:00.000Z', bettingClosed: true });
  assert.equal(spotlightGame([later, noPrice, closed, soon]).id, 'a');
  assert.equal(spotlightGame([noPrice, closed]), null);
  assert.equal(spotlightGame([]), null);
  assert.equal(spotlightGame(null), null);

  const q2 = game('q2', { state: 'in', statusText: '5:00 - 2nd' });
  const q4 = game('q4', { state: 'in', statusText: '1:10 - 4th' });
  const q3 = game('q3', { state: 'in', statusText: '8:00 - 3rd' });
  assert.equal(spotlightGame([q2, q4, q3], { live: true }).id, 'q4');
  assert.equal(spotlightGame([game('x')], { live: true }), null, 'a game that has not started is not a live spotlight');
  assert.ok(liveProgress(q4) > liveProgress(q3) && liveProgress(q3) > liveProgress(q2));
  const mlbMid = { league: 'mlb', statusText: 'Bot 5th' };
  const mlbLate = { league: 'mlb', statusText: 'Top 8th' };
  assert.ok(liveProgress(mlbLate) > liveProgress(mlbMid));
  assert.equal(liveProgress({ league: 'nba', statusText: 'Halftime' }), 0.5);
});

// ----- contrast -----
function hex(c) {
  const h = c.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function over(fg, alpha, bg) {
  return fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));
}
function lum([r, g, b]) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('contrast: every text colour of the theme is at least 4.5:1 on the surfaces it sits on (3:1 for large text)', () => {
  const page = hex('#060608');
  const glowPeak = over(hex('#d4aa50'), 0.26, page); // the strongest corner glow
  const glowSide = over(hex('#d4aa50'), 0.12, page); // the left glow, 38% down the page
  const card = over([255, 255, 255], 0.085, page); // the top of a glass card, its lightest point
  const solid = hex('#141416');
  const spotlight = over(hex('#d4aa50'), 0.22, card); // the Spotlight's gold-tinted glass at its strongest
  const chip = over([255, 255, 255], 0.06, card); // an odds button on a card
  const surfaces = { page, glowPeak, glowSide, card, solid, spotlight, chip };
  const text = { ivory: '#f4efe2', muted: '#b9b2a0', 'muted-2': '#8f887a', tag: '#a89f8a', 'gold-text': '#e7c46a', white: '#ffffff' };
  for (const [sname, surface] of Object.entries(surfaces)) {
    for (const [tname, color] of Object.entries(text)) {
      // muted-2 is only for small print on cards and the page below the top glow: never on the Spotlight or under the top bar
      if (tname === 'muted-2' && (sname === 'spotlight' || sname === 'glowPeak' || sname === 'chip')) continue;
      if (tname === 'tag' && sname === 'spotlight') continue; // the tag line is only in the top bar and on the login page
      assert.ok(ratio(hex(color), surface) >= 4.5, `${tname} on ${sname}: ${ratio(hex(color), surface).toFixed(2)}`);
    }
  }
  // status colours
  for (const c of ['#57d68d', '#ff6b6b', '#ff8a8e']) assert.ok(ratio(hex(c), card) >= 4.5, `${c} on card`);
  const livePill = over(hex('#ff5a5f'), 0.14, card);
  assert.ok(ratio(hex('#ff8a8e'), livePill) >= 4.5, 'LIVE pill text');
  // ink on gold (buttons, selected prices, the count badge, the avatar)
  for (const c of ['#f1d283', '#c49a3c', '#e2bd62']) assert.ok(ratio(hex('#1d1404'), hex(c)) >= 4.5, `ink on ${c}`);
  // the focus ring on the page and on gold
  assert.ok(ratio(hex('#fff3c4'), page) >= 3);
});

test('theme.css: the spec tokens are there', () => {
  const css = read('src/styles/theme.css');
  for (const token of ['--bg: #060608', '--text: #f4efe2', '--text-muted: #b9b2a0', '--muted-2: #8f887a', '--win: #57d68d', '--loss: #ff6b6b', '--live: #ff5a5f', '--focus: #fff3c4', '--gold-ink: #1d1404']) {
    assert.ok(css.includes(token), token);
  }
  assert.match(css, /radial-gradient\(520px 320px at 85% -8%, rgba\(212, 170, 80, 0\.26\), transparent 70%\)/);
  assert.match(css, /radial-gradient\(420px 360px at -15% 38%, rgba\(212, 170, 80, 0\.12\), transparent 70%\)/);
  assert.match(css, /prefers-reduced-transparency: reduce/);
  assert.match(css, /@supports not/);
});
