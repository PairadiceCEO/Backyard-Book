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

test('chipsFor uses the $1,000 and $10,000 chips (fewest chips, largest first)', () => {
  assert.deepEqual(chipsFor(1_213_000), [10000, 1000, 1000, 100, 25, 5]);
  assert.deepEqual(chipsFor(100_000), [1000]);
  assert.deepEqual(chipsFor(99_900), [100, 100, 100, 100, 100, 100, 100, 100, 100, 25, 25, 25, 10, 10, 2, 2]);
  assert.deepEqual(chipsFor(2_000_000, 1), [10000], 'the colour of a $20,000 spot: the $10,000 chip');
  assert.deepEqual(chipsFor(1_000_000), [10000]);
});

test('Chips.jsx still builds chipsFor from CHIP_VALUES (no list of its own)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/components/casino/Chips.jsx', import.meta.url), 'utf8');
  assert.match(src, /const LARGEST_FIRST = \[\.\.\.CHIP_VALUES\]\.sort\(\(a, b\) => b - a\);/);
  const css = readFileSync(new URL('../src/styles/chips.css', import.meta.url), 'utf8');
  for (const d of CHIP_VALUES) assert.match(css, new RegExp(`\\.fc-${d} \\{`), `chips.css colours the $${d} chip`);
});
