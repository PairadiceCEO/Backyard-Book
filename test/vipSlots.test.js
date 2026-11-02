// npm test: the Pairadice VIP slot (0.28.0), shared/casino/vipSlots.js. The exact proof (every stop combination, the bonus by
// dynamic programming), the targets Will set, the numbers printed in the file header (VIP_STATS), the strips (juiced bonus
// strips on every reel), spins and bonuses with a scripted random source, the 10,000× cap, and a 1,000,000-spin simulation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIP_BONUS_MAX_SPINS,
  VIP_BONUS_MULT,
  VIP_BONUS_REELS,
  VIP_BONUS_SPINS,
  VIP_MAX_WIN_TIMES,
  VIP_PAYTABLE,
  VIP_REELS,
  VIP_STATS,
  VIP_STOPS,
  computeVipStats,
  evaluateVipWindow,
  playVipSpin,
  vipCapBonus,
  vipCents,
  vipLineWin,
  vipWindow,
} from '../shared/casino/vipSlots.js';

const stats = computeVipStats();
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('VIP proof: the targets (total 200–220%, base ≥ 120%, ≥ 70% something back, ≥ 10% at 5×+, bonus every 20–30 spins)', () => {
  assert.equal(stats.combos, VIP_STOPS ** 3);
  const total = stats.totalRtp.toNumber();
  assert.ok(total >= 2 && total <= 2.2, `total ${total}`);
  assert.ok(stats.baseRtp.toNumber() >= 1.2, `base ${stats.baseRtp.toNumber()}`);
  assert.ok(stats.hitRate.toNumber() >= 0.7, `hit ${stats.hitRate.toNumber()}`);
  assert.ok(stats.bigRate.toNumber() >= 0.1, `5×+ ${stats.bigRate.toNumber()}`);
  const every = 1 / stats.trigger.toNumber();
  assert.ok(every >= 20 && every <= 30, `bonus every ${every}`);
  // exact values
  assert.equal(`${stats.baseRtp.n}/${stats.baseRtp.d}`, '78717/64000');
  assert.equal(`${stats.trigger.n}/${stats.trigger.d}`, '27/800');
  assert.equal(stats.totalRtp.cmp(stats.baseRtp.add(stats.bonusRtp)), 0);
});

test('VIP proof: the numbers in the file header and VIP_STATS are the proven ones', () => {
  for (const key of ['totalRtp', 'baseRtp', 'bonusRtp', 'hitRate', 'bigRate', 'trigger', 'bonusValueTimes', 'bonusSpins', 'bonusSpinRtp', 'retrigger']) {
    assert.ok(close(VIP_STATS[key], stats[key].toNumber()), `${key}: ${VIP_STATS[key]} vs ${stats[key].toNumber()}`);
  }
  assert.equal(VIP_STATS.maxPaidSpinTimes, stats.maxPaidSpinTimes);
  assert.equal(VIP_STATS.combos, stats.combos);
  assert.ok(close(VIP_STATS.triggerEvery, 1 / stats.trigger.toNumber(), 0.006));
});

test('VIP proof: the 10,000× cap can never be reached, so the bonus value needs no cap term (it is exact)', () => {
  assert.equal(stats.maxBaseTimes, 50);
  assert.equal(stats.maxBonusSpinTimes, 153);
  assert.ok(stats.maxPaidSpinTimes <= VIP_MAX_WIN_TIMES, `${stats.maxPaidSpinTimes}×`);
  // and the cap itself, when it would apply
  assert.equal(vipCapBonus(100, 5000, 10_000_000), 10000 * 100 - 5000);
  assert.equal(vipCapBonus(100, 5000, 20000), 20000);
  assert.equal(vipCapBonus(100, 2_000_000, 500), 0);
});

test('VIP strips: 40 stops, the bonus strips are juiced on every reel (more premiums, fewer blanks), Crowns stand alone on them', () => {
  const PREM = ['CR', 'G7', 'DI', 'GB', 'BE'];
  const count = (strip, ids) => strip.filter((s) => ids.includes(s)).length;
  for (let r = 0; r < 3; r += 1) {
    assert.equal(VIP_REELS[r].length, VIP_STOPS);
    assert.equal(VIP_BONUS_REELS[r].length, VIP_STOPS);
    assert.ok(count(VIP_BONUS_REELS[r], PREM) > count(VIP_REELS[r], PREM), `reel ${r} premiums`);
    assert.ok(count(VIP_BONUS_REELS[r], ['BL']) < count(VIP_REELS[r], ['BL']), `reel ${r} blanks`);
    const strip = VIP_BONUS_REELS[r];
    strip.forEach((s, i) => {
      if (s !== 'CR') return;
      for (const d of [-2, -1, 1, 2]) assert.ok(!PREM.includes(strip[(i + d + VIP_STOPS) % VIP_STOPS]), `reel ${r} crown at ${i}`);
    });
  }
});

test('VIP paytable: 0.5× (one Cherry) up to 50× (three Crowns); Golden Dice never pay on a line', () => {
  const pays = Object.fromEntries(VIP_PAYTABLE.map((l) => [l.id, l.tenths / 10]));
  assert.deepEqual(pays, { crown3: 50, gold7x3: 25, diamond3: 15, bar3: 10, bell3: 6, cherry3: 3, mixed3: 1.5, cherry2: 1, cherry1: 0.5 });
  assert.equal(vipLineWin(['GD', 'GD', 'GD']), null);
  assert.equal(vipLineWin(['CH', 'GD', 'BL']).id, 'cherry1');
  assert.equal(vipLineWin(['BE', 'DI', 'GB']).id, 'mixed3');
  assert.equal(vipLineWin(['CR', 'G7', 'BE']), null); // Crowns and Gold 7s pay only three of a kind
  assert.equal(vipLineWin(['CH', 'BL', 'CH']).id, 'cherry2');
});

test('VIP window: the stop is the middle row, wins on different lines add up, cents round down', () => {
  const w = vipWindow([5, 0, 0]);
  assert.deepEqual(w.map((row) => row[0]), [VIP_REELS[0][4], VIP_REELS[0][5], VIP_REELS[0][6]]);
  const triple = [['BE', 'BE', 'BE'], ['CH', 'BL', 'BL'], ['DI', 'GB', 'BE']];
  const r = evaluateVipWindow(triple);
  assert.deepEqual(r.lines.map((l) => [l.line, l.id, l.tenths]), [['top', 'bell3', 60], ['middle', 'cherry1', 5], ['bottom', 'mixed3', 15]]);
  assert.equal(r.tenths, 80);
  assert.equal(vipCents(100, 5), 50); // $1 × 0.5 = 50¢
  assert.equal(vipCents(300, 15, 3), 1350); // $3 × 1.5 × 3
  assert.equal(vipCents(101, 5), 50); // never rounds up
});

// A scripted random source: plays back `values`, then zeros.
function scripted(values) {
  let i = 0;
  return (n) => {
    const v = i < values.length ? values[i] : 0;
    i += 1;
    assert.ok(Number.isInteger(v) && v >= 0 && v < n);
    return v;
  };
}

function stopsWithDice(reels, wanted) {
  // the first stop on each reel whose column shows a Golden Dice (wanted) or none (!wanted)
  return reels.map((strip) => strip.findIndex((_, s) => [s - 1, s, s + 1].some((x) => strip[(x + VIP_STOPS) % VIP_STOPS] === 'GD') === wanted));
}

test('VIP spin: a trigger plays 10 bonus spins × 3 on the bonus strips; a retrigger adds 10; never more than 50 in all', () => {
  const trigger = stopsWithDice(VIP_REELS, true);
  const plain = stopsWithDice(VIP_BONUS_REELS, false);
  const retrig = stopsWithDice(VIP_BONUS_REELS, true);
  // trigger, then 9 plain bonus spins, then a retrigger on spin 10, then plain
  const values = [...trigger, ...Array(9).fill(plain).flat(), ...retrig, ...Array(10).fill(plain).flat()];
  const spin = playVipSpin(scripted(values), 500);
  assert.ok(spin.dice >= 3);
  assert.equal(spin.bonus.awarded, 20);
  assert.equal(spin.bonus.spins.length, 20);
  assert.equal(spin.bonus.spins[9].added, 10);
  for (const s of spin.bonus.spins) {
    const r = evaluateVipWindow(vipWindow(s.stops, VIP_BONUS_REELS));
    assert.equal(s.cents, vipCents(500, r.tenths, VIP_BONUS_MULT));
  }
  assert.equal(spin.bonus.cents, spin.bonus.spins.reduce((a, s) => a + s.cents, 0));
  assert.equal(spin.winCents, spin.baseCents + spin.bonus.cents);

  // retrigger every bonus spin: stops at 50
  const always = playVipSpin(scripted([...trigger, ...Array(60).fill(retrig).flat()]), 100);
  assert.equal(always.bonus.awarded, VIP_BONUS_MAX_SPINS);
  assert.equal(always.bonus.spins.length, VIP_BONUS_MAX_SPINS);
  assert.equal(always.bonus.spins.filter((s) => s.added > 0).length, (VIP_BONUS_MAX_SPINS - VIP_BONUS_SPINS) / VIP_BONUS_SPINS);

  // no trigger: no bonus
  const none = playVipSpin(scripted(stopsWithDice(VIP_REELS, false)), 100);
  assert.equal(none.bonus, null);
  assert.equal(none.winCents, none.baseCents);
});

test('VIP simulation: 1,000,000 paid spins agree with the exact numbers', () => {
  // xorshift128+ with a fixed seed: the same run every time
  let s0 = 0x9e3779b97f4a7c15n;
  let s1 = 0xbf58476d1ce4e5b9n;
  const mask = (1n << 64n) - 1n;
  const next = () => {
    let x = s0;
    const y = s1;
    s0 = y;
    x ^= (x << 23n) & mask;
    s1 = x ^ y ^ (x >> 17n) ^ (y >> 26n);
    return Number(((s1 + y) & mask) >> 11n) / 2 ** 53;
  };
  const rnd = (n) => Math.floor(next() * n);
  const SPINS = 1_000_000;
  let returned = 0;
  let hits = 0;
  let big = 0;
  let triggers = 0;
  for (let i = 0; i < SPINS; i += 1) {
    const r = playVipSpin(rnd, 100);
    returned += r.winCents;
    if (r.winCents > 0) hits += 1;
    if (r.winCents >= 500) big += 1;
    if (r.bonus) triggers += 1;
  }
  const rtp = returned / (SPINS * 100);
  assert.ok(Math.abs(rtp - stats.totalRtp.toNumber()) < 0.03, `simulated RTP ${rtp}`);
  assert.ok(Math.abs(hits / SPINS - stats.hitRate.toNumber()) < 0.003, `hit ${hits / SPINS}`);
  assert.ok(Math.abs(big / SPINS - stats.bigRate.toNumber()) < 0.003, `5×+ ${big / SPINS}`);
  assert.ok(Math.abs(triggers / SPINS - stats.trigger.toNumber()) < 0.001, `trigger ${triggers / SPINS}`);
});
