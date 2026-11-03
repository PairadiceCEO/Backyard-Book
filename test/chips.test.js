// npm test: chipsFor (src/components/casino/Chips.jsx logic, kept in shared form here) breaks amounts into the eight chips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHIP_VALUES } from '../shared/casino/constants.js';

const LARGEST_FIRST = [...CHIP_VALUES].sort((a, b) => b - a);
// The same algorithm as chipsFor in src/components/casino/Chips.jsx (that file imports JSX, which node can't load).
function chipsFor(cents, limit = Infinity) {
  let left = Math.floor(Math.max(0, cents) / 100);
  const out = [];
  for (const d of LARGEST_FIRST) {
    const n = Math.floor(left / d);
    for (let i = 0; i < n && out.length < limit; i += 1) out.push(d);
    left -= n * d;
  }
  return out;
}

test('0.28.2 chips: $1, $5, $10, $25, $100, $1,000, $10,000, $100,000 (no $2; still eight)', () => {
  assert.deepEqual(CHIP_VALUES, [1, 5, 10, 25, 100, 1000, 10000, 100000]);
  assert.equal(CHIP_VALUES.length, 8, 'racks keep their layouts');
  assert.ok(!CHIP_VALUES.includes(2));
});

test('chipsFor uses the $1,000, $10,000 and $100,000 chips (fewest chips, largest first)', () => {
  assert.deepEqual(chipsFor(1_213_000), [10000, 1000, 1000, 100, 25, 5]);
  assert.deepEqual(chipsFor(100_000), [1000]);
  assert.deepEqual(chipsFor(99_900), [100, 100, 100, 100, 100, 100, 100, 100, 100, 25, 25, 25, 10, 10, 1, 1, 1, 1]);
  assert.deepEqual(chipsFor(2_000_000, 1), [10000], 'the colour of a $20,000 spot: the $10,000 chip');
  assert.deepEqual(chipsFor(1_000_000), [10000]);
  assert.deepEqual(chipsFor(10_000_000), [100000]);
  assert.deepEqual(chipsFor(11_213_000), [100000, 10000, 1000, 1000, 100, 25, 5]);
  assert.deepEqual(chipsFor(1_000_000_000, 1), [100000], 'a $10,000,000 spot is coloured by the $100,000 chip');
  assert.equal(chipsFor(1_000_000_000).length, 100, '$10,000,000 = 100 × $100,000');
});

test('chipsFor still splits ANY whole-dollar amount without a $2 chip ($3 = $1+$1+$1, $7 = $5+$1+$1), and every split adds up', () => {
  assert.deepEqual(chipsFor(300), [1, 1, 1]);
  assert.deepEqual(chipsFor(700), [5, 1, 1]);
  assert.deepEqual(chipsFor(200), [1, 1]);
  assert.deepEqual(chipsFor(800), [5, 1, 1, 1]);
  assert.deepEqual(chipsFor(13_700), [100, 25, 10, 1, 1]);
  for (let dollars = 1; dollars <= 3000; dollars += 1) {
    const list = chipsFor(dollars * 100);
    assert.equal(list.reduce((s, d) => s + d, 0), dollars, `$${dollars} adds up`);
    assert.ok(list.every((d) => CHIP_VALUES.includes(d)), `$${dollars} uses only real chips`);
  }
  for (const dollars of [99_999, 123_456, 9_999_999, 10_000_000]) {
    assert.equal(chipsFor(dollars * 100).reduce((s, d) => s + d, 0), dollars, `$${dollars} adds up`);
  }
});

test('Chips.jsx still builds chipsFor from CHIP_VALUES (no list of its own)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/components/casino/Chips.jsx', import.meta.url), 'utf8');
  assert.match(src, /const LARGEST_FIRST = \[\.\.\.CHIP_VALUES\]\.sort\(\(a, b\) => b - a\);/);
  // 0.26.0: the house chip's colours come from one table with an entry for every chip value (HouseChip.jsx draws from it)
  const { HOUSE_CHIP_COLORS } = await import('../src/lib/houseChipColors.js');
  for (const d of CHIP_VALUES) assert.ok(HOUSE_CHIP_COLORS[d], `the house chip table colours the $${d} chip`);
  assert.match(readFileSync(new URL('../src/components/casino/HouseChip.jsx', import.meta.url), 'utf8'), /HOUSE_CHIP_COLORS\[/);
});
