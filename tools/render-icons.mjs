// Renders the Pairadice app icons from one description (0.27.0). Run by hand when the mark changes:
//   node tools/render-icons.mjs
// (needs Playwright with Chromium, e.g. the one in tools/phone-check/node_modules). It writes
//   public/icon.svg                      the source icon (the dice mark on a dark radial square, radius 40/180)
//   public/icons/icon-512.png, icon-192.png, icon-maskable-512.png, apple-touch-icon.png (180), favicon-32.png
//   public/favicon.ico                   one 32 × 32 PNG image inside an ICO container
//   public/icons/favicon.svg             the small-size variant (thicker strokes and pips)
// The mark is the 0.26.0 dice mark (src/components/casino/HouseChip.jsx, PairadiceMarkShapes): two equal dice, 5 and 2.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'tools/phone-check/package.json'));
const { chromium } = require('playwright');

const GOLD = `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f8e3a3"/><stop offset="0.5" stop-color="#e2bd62"/><stop offset="1" stop-color="#a97b2c"/></linearGradient>`;

// The mark in a 64 × 64 box. small = the thicker variant for 32 px and smaller (stroke 3.6, pips 3.3).
function mark(small) {
  const sw = small ? 3.6 : 2.4;
  const r = small ? 3.3 : 2.7;
  const die = (x, y, rot, cx, cy, pips) =>
    `<g transform="rotate(${rot} ${cx} ${cy})"><rect x="${x}" y="${y}" width="30" height="30" rx="7" fill="#0d0d10" stroke="url(#g)" stroke-width="${sw}"/>` +
    pips.map(([px, py]) => `<circle cx="${px}" cy="${py}" r="${r}" fill="url(#g)"/>`).join('') +
    `</g>`;
  return (
    die(5, 21, -12, 20, 36, [[13, 29], [27, 29], [20, 36], [13, 43], [27, 43]]) +
    die(29, 13, 12, 44, 28, [[37, 21], [51, 35]])
  );
}

// Icon on a 180 × 180 canvas. mode: 'any' (rounded square, faint gold inner border), 'maskable' (full bleed, mark inside the
// safe zone), 'small' (favicon: no border, the mark fills more of the square).
function iconSvg(mode) {
  const full = mode === 'maskable';
  const small = mode === 'small';
  const scale = small ? 2.7 : full ? 1.9 : 2.2;
  const bg = full ? `<rect width="180" height="180" fill="url(#bg)"/>` : `<rect width="180" height="180" rx="40" fill="url(#bg)"/>`;
  const border = mode === 'any' ? `<rect x="3" y="3" width="174" height="174" rx="37" fill="none" stroke="#d4aa50" stroke-opacity="0.28" stroke-width="1.5"/>` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180" width="180" height="180">` +
    `<defs><radialGradient id="bg" cx="50%" cy="36%" r="80%"><stop offset="0" stop-color="#1d1a14"/><stop offset="1" stop-color="#050506"/></radialGradient>${GOLD}</defs>` +
    bg +
    border +
    `<g transform="translate(90 90) scale(${scale}) translate(-32 -33)">${mark(small)}</g></svg>\n`
  );
}

function icoFromPng(png) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  header[6] = 32; // width
  header[7] = 32; // height
  header[8] = 0; // palette
  header[9] = 0;
  header.writeUInt16LE(1, 10); // planes
  header.writeUInt16LE(32, 12); // bits per pixel
  header.writeUInt32LE(png.length, 14); // image size
  header.writeUInt32LE(22, 18); // offset
  return Buffer.concat([header, png]);
}

mkdirSync(join(root, 'public/icons'), { recursive: true });
writeFileSync(join(root, 'public/icon.svg'), iconSvg('any'));
writeFileSync(join(root, 'public/icons/favicon.svg'), iconSvg('small'));

const browser = await chromium.launch();
async function png(svg, size, transparent = true) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px">${svg.replace('width="180" height="180"', `width="${size}" height="${size}"`)}</div></body></html>`);
  const buf = await page.screenshot({ omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  return buf;
}

const out = (p, buf) => writeFileSync(join(root, p), buf);
out('public/icons/icon-512.png', await png(iconSvg('any'), 512));
out('public/icons/icon-192.png', await png(iconSvg('any'), 192));
out('public/icons/icon-maskable-512.png', await png(iconSvg('maskable'), 512));
// iOS rounds the corners itself, so the touch icon is a full square (no transparent corners).
out('public/icons/apple-touch-icon.png', await png(iconSvg('maskable').replace('scale(1.9)', 'scale(2.2)'), 180, false));
const fav = await png(iconSvg('small'), 32);
out('public/icons/favicon-32.png', fav);
out('public/favicon.ico', icoFromPng(fav));
await browser.close();
console.log('icons written');
