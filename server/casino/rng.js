// Every random number in the casino (shuffles, card draws, dice, reel stops) comes from here.
// crypto.randomInt is a cryptographically secure, unbiased integer in [0, max).

import { randomInt as cryptoRandomInt } from 'node:crypto';

export function randomInt(max) {
  if (!Number.isInteger(max) || max <= 0) throw new Error(`randomInt needs a positive whole number, got ${max}`);
  return cryptoRandomInt(max);
}
