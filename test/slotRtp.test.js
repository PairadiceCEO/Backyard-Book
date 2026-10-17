// npm test — the 7s slot's return to player, counted exactly over every reel-stop combination.
// Fails if any change to the reel strips or the paytable moves RTP outside 89.5%–90.5%.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REELS, STOPS_PER_REEL, computeRtp } from '../shared/casino/slotMachine.js';

test('every reel has 32 stops', () => {
  for (const reel of REELS) assert.equal(reel.length, STOPS_PER_REEL);
});

test('RTP over all 32,768 stop combinations is 29,493 / 32,768 and stays within 89.5%–90.5%', () => {
  const { returned, combos } = computeRtp();
  assert.equal(combos, STOPS_PER_REEL ** 3);
  const rtp = returned / combos;
  assert.ok(rtp >= 0.895 && rtp <= 0.905, `RTP is ${(rtp * 100).toFixed(4)}%, outside 89.5%–90.5%`);
  assert.equal(returned, 29493, 'the designed figure; update the plan if you change the reels on purpose');
});
