// npm test: the 0.26.0 look, the parts that are numbers: the house chip colour table (the approved mockup), the card tilt range,
// the Baccarat band geometry (printed bands and tap shapes agree; every band is tall enough to tap on a 320 px phone) and the top
// payouts printed on the Baccarat side-bet circles (read from the paytables, never retyped).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHIP_VALUES } from '../shared/casino/constants.js';
import { DRAGON_MARGIN_PAYS, baccaratSideTopPays } from '../shared/casino/sideBets.js';
import { HOUSE_CHIP_COLORS, chipRingValue } from '../src/lib/houseChipColors.js';
import { cardTilt } from '../src/lib/cardLook.js';
import { BANDS, BAND_ORDER, CENTER, FELT_W, THICKNESS, bandPath, buttonBox, chipAnchor, clipPolygon, textOffset } from '../src/lib/baccaratBands.js';

test('house chips: every denomination has the mockup colours and the ring prints its value', () => {
  assert.deepEqual(Object.keys(HOUSE_CHIP_COLORS).map(Number), CHIP_VALUES);
  assert.deepEqual(HOUSE_CHIP_COLORS[1], { base: '#e9e5da', hi: '#ffffff', ins: '#2b5fc9', ring: '#6b4e14' });
  assert.deepEqual(HOUSE_CHIP_COLORS[100], { base: '#0b0b0d', hi: '#2c2c31', ins: '#d8b45a', ring: '#f1d283' });
  assert.deepEqual(HOUSE_CHIP_COLORS[10000], { base: '#4f1f80', hi: '#7a3fb6', ins: '#d8b45a', ring: '#f8e3a3' });
  assert.deepEqual(CHIP_VALUES.map(chipRingValue), ['$1', '$2', '$5', '$10', '$25', '$100', '$1,000', '$10,000']);
});

test('card tilt: −4° to +5°, the same card always lies the same way', () => {
  const seen = new Set();
  for (const rank of 'A23456789TJQK') {
    for (const suit of 'SHDC') {
      for (let deck = 0; deck < 8; deck += 1) {
        const t = cardTilt(`${rank}${suit}${deck}`);
        assert.ok(Number.isInteger(t) && t >= -4 && t <= 5, `${rank}${suit}${deck}: ${t}`);
        assert.equal(t, cardTilt(`${rank}${suit}${deck}`));
        seen.add(t);
      }
    }
  }
  assert.ok(seen.size >= 8, 'a spread of tilts');
});

test('baccarat bands: top to bottom TIE, BANKER, PLAYER, concentric, apart, and tall enough to tap at 320 px', () => {
  assert.deepEqual(BAND_ORDER, ['tie', 'banker', 'player']);
  assert.ok(BANDS.tie.inner > BANDS.banker.outer && BANDS.banker.inner > BANDS.player.outer, 'a gap between bands');
  for (const spot of BAND_ORDER) {
    const { outer, inner } = BANDS[spot];
    assert.equal(outer - inner, THICKNESS);
    assert.ok((THICKNESS * 320) / FELT_W >= 44, `${spot}: a band is at least 44 px tall on a 320 px phone`);
    // the button is the band's top strip, so its centre (x = the middle) is on the band
    const { top, height, fullHeight } = buttonBox(spot);
    const mid = top + height / 2;
    const radius = CENTER.y - mid;
    assert.ok(radius < outer && radius > inner, `${spot}: the button centre is on its band`);
    assert.ok(fullHeight > height, `${spot}: the tap shape runs down to the band's ends`);
    // the chip anchor sits on the band too
    const a = chipAnchor(spot);
    const r = Math.hypot(a.px - CENTER.x, CENTER.y - a.py);
    assert.ok(r < outer && r > inner, `${spot}: chips sit on the band`);
    assert.match(bandPath(spot), /^M .* Z$/);
    // the tap shape: polygon points all inside the box
    const pts = clipPolygon(spot).match(/-?\d+(\.\d+)?%/g).map((v) => Number.parseFloat(v));
    assert.ok(pts.every((v) => v >= -0.01 && v <= 100.01), `${spot}: polygon inside its box`);
    const off = textOffset(spot);
    assert.ok(off > 0.1 && off < 0.9, `${spot}: the text starts inside the arc`);
  }
});

test('baccarat side bets print their top payout, read from the paytables', () => {
  assert.equal(baccaratSideTopPays('dragonPlayer'), Math.max(...Object.values(DRAGON_MARGIN_PAYS)));
  assert.equal(baccaratSideTopPays('dragonBanker'), 30);
  assert.equal(baccaratSideTopPays('fortune7'), 40);
  assert.equal(baccaratSideTopPays('golden8'), 25);
  assert.equal(baccaratSideTopPays('heavenly9'), 75);
  assert.equal(baccaratSideTopPays('blazing7'), 200);
});
