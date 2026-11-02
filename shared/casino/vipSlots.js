// The Pairadice VIP slot (0.28.0): 3 reels, 3 visible rows, 3 paylines (the top, middle and bottom rows), and the Golden Dice
// bonus. Pure: the server calls playVipSpin with crypto.randomInt; the phone only draws the result; tests prove the numbers.
//
// One bet B (whole dollars, $1 minimum, the casino's $1,000,000 ceiling) covers all three lines. Each winning line pays its
// multiplier × B (the total returned for that line); wins on different lines add up. Golden Dice don't pay on lines: 3 or more
// anywhere in the 3 × 3 window on a paid spin award 10 free spins on the bonus strips, every win × 3; 3 or more during the bonus
// add 10 more, up to 50 bonus spins in all. The whole bonus is resolved on the server with the paid spin.
//
// Exact numbers (every one of the 40³ = 64,000 stop combinations, all three rows; the bonus by dynamic programming over spins
// left, retriggers and the 50-spin cap; computeVipStats and test/vipSlots.test.js prove each one):
//   total RTP 209.80% = base game 123.00% (exactly 78,717 / 64,000) + bonus 86.80%.
//   Something back on 81.39% of paid spins (line wins alone 80.48%); 5× B or more on 10.62% (line wins alone 7.55%).
//   The bonus triggers on 3.375% of paid spins (exactly 27 / 800: once every 29.63 spins), lasts 10.68 spins on average
//   (a bonus spin retriggers 0.633% of the time) and is worth 25.72× B on average (one bonus spin, × 3 included: 2.409× B).
//
// Why 7.6% + the bonus for "5× or more": a paid spin's return is its line wins plus any bonus it triggers, and a bonus is worth
// about 26× B on average, so every spin that triggers one is counted (exactly: the chance the bonus adds enough).
// The 10,000× cap per paid spin can never be reached: a paid spin wins at most 50× B and a bonus spin at most 51 × 3 = 153× B,
// so 50 + 50 × 153 = 7,700× B (the server applies the cap anyway).

export const VIP_STOPS = 40;
export const VIP_ROWS = 3;
export const VIP_BONUS_SPINS = 10; // free spins per trigger (and per retrigger)
export const VIP_BONUS_MAX_SPINS = 50; // bonus spins in all, retriggers included
export const VIP_BONUS_MULT = 3; // every bonus win × 3
export const VIP_TRIGGER_DICE = 3; // Golden Dice anywhere in the window
export const VIP_MAX_WIN_TIMES = 10000; // a paid spin (bonus included) returns at most 10,000 × B

export const VIP_SYMBOLS = {
  CR: { id: 'CR', name: 'Crown' },
  G7: { id: 'G7', name: 'Gold 7' },
  DI: { id: 'DI', name: 'Diamond' },
  GB: { id: 'GB', name: 'Gold Bar' },
  BE: { id: 'BE', name: 'Bell' },
  CH: { id: 'CH', name: 'Cherry' },
  BL: { id: 'BL', name: 'Blank' },
  GD: { id: 'GD', name: 'Golden Dice' },
};

export const VIP_LINES = [
  { id: 'top', row: 0, name: 'Top line' },
  { id: 'middle', row: 1, name: 'Middle line' },
  { id: 'bottom', row: 2, name: 'Bottom line' },
];

// Base game: Crown 1/1/1 · Gold 7 1/1/1 · Diamond 2/3/3 · Gold Bar 2/3/3 · Bell 11/12/12 · Cherry 5/4/5 · Golden Dice 4/5/4 ·
// Blank 14/11/11 (of 40). The order spreads symbols out; it is part of the proof (the three rows are neighbouring stops).
export const VIP_REELS = [
  ['BL', 'BL', 'BL', 'BL', 'BE', 'CR', 'BL', 'GD', 'BE', 'CH', 'BL', 'BE', 'BL', 'CH', 'GD', 'BL', 'BE', 'DI', 'GB', 'BE', 'DI', 'BL', 'BE', 'BL', 'BL', 'BE', 'CH', 'G7', 'BE', 'GD', 'BL', 'CH', 'BE', 'BL', 'GD', 'CH', 'BE', 'BL', 'GB', 'BE'],
  ['BL', 'GD', 'BE', 'CH', 'BL', 'BE', 'CH', 'GB', 'BE', 'DI', 'BL', 'BE', 'BL', 'GB', 'DI', 'BE', 'CH', 'DI', 'BE', 'CR', 'BL', 'BE', 'BL', 'GD', 'BE', 'GB', 'GD', 'BL', 'BE', 'BL', 'G7', 'BE', 'BL', 'GD', 'BL', 'CH', 'BE', 'GD', 'BL', 'BE'],
  ['BL', 'BE', 'BL', 'GD', 'BE', 'BL', 'CR', 'DI', 'BE', 'BL', 'GB', 'BE', 'CH', 'G7', 'BE', 'GD', 'BL', 'BL', 'BE', 'CH', 'BL', 'BE', 'BL', 'GB', 'BE', 'DI', 'GB', 'BL', 'GD', 'BE', 'CH', 'GD', 'BE', 'BL', 'CH', 'BE', 'BL', 'CH', 'BE', 'DI']
];

// Bonus ("juiced"): more premiums and fewer blanks on every reel: Crown 3/3/2 · Gold 7 2/9/6 · Diamond 6/4/7 · Gold Bar 3/6/6 ·
// Bell 8/4/5 · Cherry 0/3/1 · Golden Dice 5/1/3 · Blank 13/10/10. Each Crown has no other premium within two stops, so a bonus spin
// can't stack a Crown line on another big line.
export const VIP_BONUS_REELS = [
  ['BL', 'GD', 'CR', 'BL', 'BL', 'CR', 'GD', 'BL', 'DI', 'BE', 'BL', 'GD', 'BE', 'DI', 'BL', 'BL', 'BL', 'BL', 'CR', 'BL', 'GD', 'BE', 'DI', 'GB', 'G7', 'DI', 'BE', 'G7', 'BL', 'BE', 'DI', 'BL', 'BE', 'GB', 'BL', 'BE', 'DI', 'GD', 'GB', 'BE'],
  ['BL', 'BL', 'CR', 'BL', 'BL', 'CR', 'CH', 'BL', 'DI', 'G7', 'GB', 'BE', 'G7', 'GB', 'DI', 'G7', 'BE', 'BL', 'G7', 'GB', 'DI', 'CH', 'G7', 'GB', 'CH', 'G7', 'GB', 'DI', 'BE', 'G7', 'BL', 'GD', 'CR', 'BL', 'BL', 'G7', 'BL', 'BE', 'GB', 'G7'],
  ['GB', 'DI', 'G7', 'BL', 'BL', 'GB', 'BE', 'BL', 'BL', 'BL', 'CR', 'BL', 'BL', 'BE', 'G7', 'GD', 'GB', 'DI', 'BE', 'BL', 'GD', 'CR', 'CH', 'BL', 'DI', 'BE', 'GB', 'DI', 'G7', 'GD', 'DI', 'G7', 'GB', 'DI', 'G7', 'GB', 'DI', 'G7', 'BL', 'BE']
];

const MIXED = new Set(['DI', 'GB', 'BE']);
const triple = (id) => (s) => s[0] === id && s[1] === id && s[2] === id;
const cherries = (s) => s.filter((x) => x === 'CH').length;

// Highest first; a line pays its first match. tenths = the line's pay × 10 (5 = 0.5 × B), so cents stay whole.
export const VIP_PAYTABLE = [
  { id: 'crown3', label: 'Crown × 3', tenths: 500, show: ['CR', 'CR', 'CR'], matches: triple('CR') },
  { id: 'gold7x3', label: 'Gold 7 × 3', tenths: 250, show: ['G7', 'G7', 'G7'], matches: triple('G7') },
  { id: 'diamond3', label: 'Diamond × 3', tenths: 150, show: ['DI', 'DI', 'DI'], matches: triple('DI') },
  { id: 'bar3', label: 'Gold Bar × 3', tenths: 100, show: ['GB', 'GB', 'GB'], matches: triple('GB') },
  { id: 'bell3', label: 'Bell × 3', tenths: 60, show: ['BE', 'BE', 'BE'], matches: triple('BE') },
  { id: 'cherry3', label: 'Cherry × 3', tenths: 30, show: ['CH', 'CH', 'CH'], matches: triple('CH') },
  { id: 'mixed3', label: 'Any 3 Diamonds, Gold Bars or Bells', tenths: 15, show: ['DI', 'BE', 'GB'], matches: (s) => s.every((x) => MIXED.has(x)) },
  { id: 'cherry2', label: 'Any 2 Cherries', tenths: 10, show: ['CH', 'CH', null], matches: (s) => cherries(s) === 2 },
  { id: 'cherry1', label: 'Any 1 Cherry', tenths: 5, show: ['CH', null, null], matches: (s) => cherries(s) === 1 },
];

export function vipPaysText(tenths) {
  return `${tenths / 10}×`;
}

function at(strip, stop) {
  const n = strip.length;
  return strip[((stop % n) + n) % n];
}

// The 3 × 3 window for stops (each stop is the middle row): window[row][reel].
export function vipWindow(stops, reels = VIP_REELS) {
  return [0, 1, 2].map((row) => stops.map((stop, reel) => at(reels[reel], stop + row - 1)));
}

export function vipLineWin(symbols) {
  for (const line of VIP_PAYTABLE) if (line.matches(symbols)) return line;
  return null;
}

export function goldenDiceCount(window) {
  return window.reduce((n, row) => n + row.filter((s) => s === 'GD').length, 0);
}

// Every winning line in a window: [{ line, row, id, label, tenths }], their total, and the Golden Dice count.
export function evaluateVipWindow(window) {
  const lines = [];
  let tenths = 0;
  for (const l of VIP_LINES) {
    const win = vipLineWin(window[l.row]);
    if (win) {
      lines.push({ line: l.id, row: l.row, id: win.id, label: win.label, tenths: win.tenths });
      tenths += win.tenths;
    }
  }
  return { lines, tenths, dice: goldenDiceCount(window) };
}

// Line-win cents for a bet (bet is whole dollars, so tenths × bet is whole; floor keeps it rounded down regardless).
export function vipCents(betCents, tenths, mult = 1) {
  return Math.floor((betCents * tenths * mult) / 10);
}

// The bonus a paid spin can still pay under the 10,000 × B cap (line wins + bonus ≤ 10,000 × B).
export function vipCapBonus(betCents, baseCents, bonusCents) {
  const room = Math.max(0, VIP_MAX_WIN_TIMES * betCents - baseCents);
  return Math.min(bonusCents, room);
}

function spinStops(randomInt) {
  return [randomInt(VIP_STOPS), randomInt(VIP_STOPS), randomInt(VIP_STOPS)];
}

// One paid spin with everything it wins. randomInt(n) → a whole number in [0, n) (crypto.randomInt on the server).
// Returns { stops, lines, dice, baseCents, bonus: null | { spins: [{ stops, lines, dice, cents, added }], awarded, cents, capped },
// winCents }.
export function playVipSpin(randomInt, betCents) {
  const stops = spinStops(randomInt);
  const base = evaluateVipWindow(vipWindow(stops));
  const baseCents = vipCents(betCents, base.tenths);
  let bonus = null;
  if (base.dice >= VIP_TRIGGER_DICE) {
    const spins = [];
    let awarded = VIP_BONUS_SPINS;
    let cents = 0;
    for (let i = 0; i < awarded; i += 1) {
      const s = spinStops(randomInt);
      const r = evaluateVipWindow(vipWindow(s, VIP_BONUS_REELS));
      const spinCents = vipCents(betCents, r.tenths, VIP_BONUS_MULT);
      const added = r.dice >= VIP_TRIGGER_DICE ? Math.min(VIP_BONUS_SPINS, VIP_BONUS_MAX_SPINS - awarded) : 0;
      awarded += added;
      cents += spinCents;
      spins.push({ stops: s, lines: r.lines, dice: r.dice, cents: spinCents, added });
    }
    const paid = vipCapBonus(betCents, baseCents, cents);
    bonus = { spins, awarded, cents: paid, capped: paid < cents };
  }
  return { stops, lines: base.lines, dice: base.dice, baseCents, bonus, winCents: baseCents + (bonus ? bonus.cents : 0) };
}

// ---------- the exact proof ----------

const gcd = (a, b) => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) [x, y] = [y, x % y];
  return x;
};

// A rational number with BigInt parts.
export class Q {
  constructor(n, d = 1n) {
    const g = gcd(n, d) || 1n;
    const s = d < 0n ? -1n : 1n;
    this.n = (s * n) / g;
    this.d = (s * d) / g;
  }
  static of(n, d = 1) {
    return new Q(BigInt(n), BigInt(d));
  }
  add(o) {
    return new Q(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o) {
    return new Q(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o) {
    return new Q(this.n * o.n, this.d * o.d);
  }
  cmp(o) {
    const l = this.n * o.d;
    const r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  toNumber() {
    // exact to ~15 digits even for huge parts
    const scale = 10n ** 18n;
    return Number((this.n * scale) / this.d) / 1e18;
  }
}

// Every stop combination of a set of strips: Map "tenths|dice≥3" → count, plus totals.
function enumerate(reels) {
  const cols = reels.map((strip) => strip.map((_, s) => [0, 1, 2].map((row) => at(strip, s + row - 1))));
  const outcomes = new Map();
  let combos = 0;
  let maxTenths = 0;
  for (const a of cols[0]) {
    for (const b of cols[1]) {
      for (const c of cols[2]) {
        const window = [0, 1, 2].map((row) => [a[row], b[row], c[row]]);
        const r = evaluateVipWindow(window);
        const key = `${r.tenths}|${r.dice >= VIP_TRIGGER_DICE ? 1 : 0}`;
        outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
        combos += 1;
        if (r.tenths > maxTenths) maxTenths = r.tenths;
      }
    }
  }
  const list = [...outcomes].map(([key, count]) => {
    const [tenths, trig] = key.split('|').map(Number);
    return { tenths, trigger: trig === 1, count };
  });
  return { list, combos, maxTenths };
}

// Exact bonus value in tenths of B (wins × 3, retriggers, the 50-spin cap): E(n, T) with n spins left and T awarded so far.
function bonusValue(bonusList, combos) {
  const N = BigInt(combos);
  let winSum = 0n;
  let retrig = 0n;
  for (const o of bonusList) {
    winSum += BigInt(o.tenths * o.count);
    if (o.trigger) retrig += BigInt(o.count);
  }
  const ew = new Q(winSum * BigInt(VIP_BONUS_MULT), N);
  const p = new Q(retrig, N);
  const notP = Q.of(1).sub(p);
  const memo = new Map();
  const E = (n, T) => {
    if (n === 0) return Q.of(0);
    const key = n * 100 + T;
    if (memo.has(key)) return memo.get(key);
    const add = Math.min(VIP_BONUS_SPINS, VIP_BONUS_MAX_SPINS - T);
    const v = ew.add(p.mul(E(n - 1 + add, T + add))).add(notP.mul(E(n - 1, T)));
    memo.set(key, v);
    return v;
  };
  const value = E(VIP_BONUS_SPINS, VIP_BONUS_SPINS);
  // expected bonus spins played
  const memoS = new Map();
  const S = (n, T) => {
    if (n === 0) return Q.of(0);
    const key = n * 100 + T;
    if (memoS.has(key)) return memoS.get(key);
    const add = Math.min(VIP_BONUS_SPINS, VIP_BONUS_MAX_SPINS - T);
    const v = Q.of(1).add(p.mul(S(n - 1 + add, T + add))).add(notP.mul(S(n - 1, T)));
    memoS.set(key, v);
    return v;
  };
  return { value, ew, p, spins: S(VIP_BONUS_SPINS, VIP_BONUS_SPINS) };
}

// P(the bonus adds less than  tenths of B), exactly, for need = 1 … 50: lowBelow[need].
function bonusLowProbabilities(bonusList, combos, maxNeed) {
  const N = BigInt(combos);
  // Group the outcomes by (win, retrigger); a win of `need` or more ends the question (it adds enough), so only smaller wins recurse.
  const grouped = new Map();
  for (const o of bonusList) {
    const w = o.tenths * VIP_BONUS_MULT;
    const key = `${Math.min(w, maxNeed)}|${o.trigger ? 1 : 0}`;
    const prev = grouped.get(key) ?? { w: Math.min(w, maxNeed), trigger: o.trigger, count: 0 };
    prev.count += o.count;
    grouped.set(key, prev);
  }
  const outcomes = [...grouped.values()].map((o) => ({ w: o.w, trigger: o.trigger, q: new Q(BigInt(o.count), N) }));
  const memo = new Map();
  // L(n, T, need): P(the remaining n spins add < need), need ≥ 1
  const L = (n, T, need) => {
    if (need <= 0) return Q.of(0);
    if (n === 0) return Q.of(1);
    const key = `${n}|${T}|${need}`;
    if (memo.has(key)) return memo.get(key);
    let v = Q.of(0);
    for (const o of outcomes) {
      if (o.w >= need) continue; // adds enough: not "less than need"
      const add = o.trigger ? Math.min(VIP_BONUS_SPINS, VIP_BONUS_MAX_SPINS - T) : 0;
      v = v.add(o.q.mul(L(n - 1 + add, T + add, need - o.w)));
    }
    memo.set(key, v);
    return v;
  };
  const out = [];
  for (let need = 0; need <= maxNeed; need += 1) out.push(L(VIP_BONUS_SPINS, VIP_BONUS_SPINS, need));
  return out;
}

// The proof: exact RTP (base, bonus, total), the share of paid spins that return something and 5× or more, how often the bonus
// triggers, the bonus value, and the largest possible win. Takes a second or two (two 64,000-combination enumerations).
export function computeVipStats() {
  const base = enumerate(VIP_REELS);
  const bonus = enumerate(VIP_BONUS_REELS);
  const N = BigInt(base.combos);
  const { value, ew, p, spins } = bonusValue(bonus.list, bonus.combos);
  const BIG = 50; // 5× B in tenths
  const low = bonusLowProbabilities(bonus.list, bonus.combos, BIG);
  let baseSum = 0n;
  let trig = 0n;
  let hit = Q.of(0);
  let big = Q.of(0);
  for (const o of base.list) {
    const q = new Q(BigInt(o.count), N);
    baseSum += BigInt(o.tenths * o.count);
    if (o.trigger) trig += BigInt(o.count);
    // something back: a line win, or a bonus that wins anything
    if (o.tenths > 0) hit = hit.add(q);
    else if (o.trigger) hit = hit.add(q.mul(Q.of(1).sub(low[1])));
    // 5× or more: the line wins alone, or with what the bonus adds
    if (o.tenths >= BIG) big = big.add(q);
    else if (o.trigger) big = big.add(q.mul(Q.of(1).sub(low[BIG - o.tenths])));
  }
  const baseRtp = new Q(baseSum, N * 10n);
  const trigger = new Q(trig, N);
  const bonusRtp = trigger.mul(value).mul(new Q(1n, 10n));
  const total = baseRtp.add(bonusRtp);
  return {
    combos: base.combos,
    baseRtp,
    bonusRtp,
    totalRtp: total,
    hitRate: hit,
    bigRate: big,
    trigger,
    bonusValueTimes: value.mul(new Q(1n, 10n)), // the bonus's average value in B
    bonusSpinRtp: ew.mul(new Q(1n, 10n)), // one bonus spin (× 3 included), in B
    retrigger: p,
    bonusSpins: spins,
    maxBaseTimes: base.maxTenths / 10,
    maxBonusSpinTimes: (bonus.maxTenths * VIP_BONUS_MULT) / 10,
    maxPaidSpinTimes: base.maxTenths / 10 + (VIP_BONUS_MAX_SPINS * bonus.maxTenths * VIP_BONUS_MULT) / 10,
  };
}

// The same numbers as plain values, kept here so the Admin tab and the paytable can show them without the 2-second proof
// (test/vipSlots.test.js checks every one against computeVipStats).
export const VIP_STATS = {
  totalRtp: 2.097977,
  baseRtp: 1.229953,
  bonusRtp: 0.868024,
  hitRate: 0.813906,
  bigRate: 0.106153,
  trigger: 0.03375,
  triggerEvery: 29.63,
  bonusValueTimes: 25.719228,
  bonusSpins: 10.675478,
  bonusSpinRtp: 2.409188,
  retrigger: 0.006328,
  baseHitRate: 0.804781,
  baseBigRate: 0.075516,
  maxPaidSpinTimes: 7700,
  combos: 64000
};
