// The 7s slot: three 32-stop reels, one payline (the middle row), and the paytable.
// RTP is exactly 29,493 / 32,768 = 90.0055% (see computeRtp; a test enumerates every stop combination).
// The server picks each stop with crypto.randomInt(32); the browser only draws the result.

export const STOPS_PER_REEL = 32;

export const SYMBOLS = {
  R7: { id: 'R7', name: 'Red 7' },
  B7: { id: 'B7', name: 'Blue 7' },
  BAR3: { id: 'BAR3', name: 'Triple BAR' },
  BAR2: { id: 'BAR2', name: 'Double BAR' },
  BAR1: { id: 'BAR1', name: 'Single BAR' },
  CH: { id: 'CH', name: 'Cherry' },
  BL: { id: 'BL', name: 'Blank' },
};

// Per reel: Red 7 1/2/2 · Blue 7 3/2/3 · Triple BAR 3/3/3 · Double BAR 4/4/2 · Single BAR 4/6/3 ·
// Cherry 5/2/1 · Blank 12/13/18. The order only spreads symbols out for looks; it can't change the RTP.
export const REELS = [
  ['BAR3', 'BAR2', 'BL', 'BAR1', 'CH', 'BL', 'BAR2', 'BL', 'B7', 'BAR3', 'BL', 'CH', 'BAR1', 'BL', 'R7', 'BL', 'BAR2', 'CH', 'BL', 'B7', 'BAR1', 'BL', 'BAR3', 'BL', 'BAR2', 'CH', 'BL', 'BAR1', 'B7', 'BL', 'CH', 'BL'],
  ['BAR3', 'BAR2', 'BL', 'BAR1', 'BL', 'R7', 'BAR2', 'BL', 'BAR1', 'BL', 'CH', 'BAR3', 'BL', 'B7', 'BL', 'BAR1', 'BAR2', 'BL', 'BAR1', 'BL', 'BAR3', 'R7', 'BL', 'BAR2', 'BL', 'BAR1', 'CH', 'BL', 'B7', 'BL', 'BAR1', 'BL'],
  ['BAR3', 'BL', 'BAR1', 'BL', 'R7', 'BL', 'B7', 'BL', 'BL', 'BAR3', 'BL', 'BAR2', 'BL', 'BAR1', 'BL', 'BL', 'CH', 'BL', 'B7', 'BL', 'BAR3', 'BL', 'R7', 'BL', 'BL', 'BAR1', 'BL', 'BAR2', 'BL', 'B7', 'BL', 'BL'],
];

const SEVENS = new Set(['R7', 'B7']);
const BARS = new Set(['BAR3', 'BAR2', 'BAR1']);
const all = (line, test) => line.every(test);
const three = (id) => (line) => all(line, (s) => s === id);
const cherries = (line) => line.filter((s) => s === 'CH').length;

// Highest line first; only the first match pays. `pays` = total returned per $1 bet (20 → a $1 spin returns $20).
export const PAYTABLE = [
  { id: 'red7x3', label: 'Red 7 · Red 7 · Red 7', pays: 300, show: ['R7', 'R7', 'R7'], matches: three('R7') },
  { id: 'blue7x3', label: 'Blue 7 · Blue 7 · Blue 7', pays: 100, show: ['B7', 'B7', 'B7'], matches: three('B7') },
  { id: 'bar3x3', label: 'Triple BAR × 3', pays: 50, show: ['BAR3', 'BAR3', 'BAR3'], matches: three('BAR3') },
  { id: 'bar2x3', label: 'Double BAR × 3', pays: 25, show: ['BAR2', 'BAR2', 'BAR2'], matches: three('BAR2') },
  { id: 'any7', label: 'Any three 7s', pays: 20, show: ['R7', 'B7', 'R7'], matches: (line) => all(line, (s) => SEVENS.has(s)) },
  { id: 'cherryx3', label: 'Cherry × 3', pays: 20, show: ['CH', 'CH', 'CH'], matches: three('CH') },
  { id: 'bar1x3', label: 'Single BAR × 3', pays: 15, show: ['BAR1', 'BAR1', 'BAR1'], matches: three('BAR1') },
  { id: 'anybar', label: 'Any three BARs', pays: 5, show: ['BAR3', 'BAR1', 'BAR2'], matches: (line) => all(line, (s) => BARS.has(s)) },
  { id: 'cherry2', label: 'Any two Cherries', pays: 5, show: ['CH', 'CH', null], matches: (line) => cherries(line) === 2 },
  { id: 'cherry1', label: 'Any one Cherry', pays: 2, show: ['CH', null, null], matches: (line) => cherries(line) === 1 },
];

export function symbolAt(reel, stop) {
  const strip = REELS[reel];
  const n = strip.length;
  return strip[((stop % n) + n) % n];
}

// The three payline symbols for a set of stops.
export function lineSymbols(stops) {
  return stops.map((stop, reel) => symbolAt(reel, stop));
}

// The winning paytable line for these payline symbols, or null.
export function lineWin(symbols) {
  for (const line of PAYTABLE) {
    if (line.matches(symbols)) return { id: line.id, label: line.label, pays: line.pays };
  }
  return null;
}

// Exact RTP over every stop combination: { returned, combos } where RTP = returned / combos.
// Also returns how many combinations hit each paytable line.
export function computeRtp() {
  const hits = Object.fromEntries(PAYTABLE.map((l) => [l.id, 0]));
  let returned = 0;
  let combos = 0;
  for (const a of REELS[0]) {
    for (const b of REELS[1]) {
      for (const c of REELS[2]) {
        combos += 1;
        const win = lineWin([a, b, c]);
        if (win) {
          returned += win.pays;
          hits[win.id] += 1;
        }
      }
    }
  }
  return { returned, combos, hits };
}
