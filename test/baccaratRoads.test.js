// npm test: the Baccarat scoreboard (shared/casino/baccaratRoads.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  beadPlate,
  bigRoadColumns,
  buildRoads,
  derivedColors,
  placeStreaks,
  shoeSummary,
  streaksOf,
} from '../shared/casino/baccaratRoads.js';

const at = (cells) => cells.map((c) => `${c.col},${c.row}`);

// ---------- Published reference ----------
// Wizard of Odds, "Baccarat Score Boards" (wizardofodds.com/games/baccarat/history/): the Big Eye Boy
// play-by-play for a real shoe. Each row: Big Eye Boy cell, the Big Road cell that produced it, color.
// Cells are column letter(s) + 1-based row. ("HI" on the page is a typo for H1.)
const WOO_BIG_EYE_BOY = `
A1 C1 R|B1 C2 B|B2 D1 B|B3 E1 B|B4 E2 B|C1 E3 R|C2 E4 R|D1 F1 B|D2 G1 B|E1 H1 R|E2 I1 R|F1 I2 B|F2 J1 B
G1 J2 R|H1 J3 B|H2 K1 B|I1 K2 R|I2 K3 R|I3 L1 R|I4 L2 R|J1 M1 B|J2 N1 B|J3 N2 B|K1 N3 R|L1 O1 B|M1 O2 R
N1 P1 B|O1 P2 R|O2 Q1 R|P1 R1 B|Q1 S1 R|R1 S2 B|S1 S3 R|T1 T1 B|U1 T2 R|U2 T3 R|U3 U1 R|U4 U2 R|V1 V1 R
W1 V2 R|W2 W1 B|X1 X1 B|Y1 Y1 R|Z1 Y2 B|AA1 Y3 R|AB1 Z1 B|AB2 AA1 B|AB3 AA2 B|AB4 AB1 B|AB5 AC1 B|AB6 AC2 B
AC1 AC3 R|AD1 AD1 B|AD2 AE1 B|AD3 AE2 B|AE1 AE3 R|AE2 AE4 R|AF1 AF1 B|AF2 AG1 B|AG1 AH1 R|AG2 AI1 R|AG3 AJ1 R
AH1 AJ2 B|AI1 AJ3 R|AJ1 AK1 B|AJ2 AL1 B`
  .trim()
  .split(/[|\n]/)
  .map((row) => row.trim().split(' '));

function parseCell(cell) {
  const [, letters, row] = /^([A-Z]+)(\d+)$/.exec(cell);
  const col = [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  return { col, row: Number(row) - 1 };
}

// The shoe behind the example: Big Road columns A and B hold one hand each (the page: "columns A and B
// equal in length", "B1 and B2 don't match"), and every later Big Road cell appears in the table once.
function wooShoe() {
  const lengths = [1, 1];
  for (const [, bigRoadCell] of WOO_BIG_EYE_BOY) {
    const { col, row } = parseCell(bigRoadCell);
    assert.ok(col === lengths.length - 1 || col === lengths.length, `Big Road cells in order (${bigRoadCell})`);
    if (col === lengths.length) lengths.push(0);
    assert.equal(row, lengths[col], `rows in order (${bigRoadCell})`);
    lengths[col] += 1;
  }
  // Alternate the winner per column (which side starts doesn't change any derived road).
  const results = lengths.map((n, i) => (i % 2 === 0 ? 'B' : 'P').repeat(n)).join('');
  return { lengths, results };
}

test('Big Eye Boy matches the Wizard of Odds worked example: all 66 entries, colors and cells', () => {
  const { lengths, results } = wooShoe();
  assert.equal(lengths.length, 38);
  const roads = buildRoads(results);
  assert.deepEqual(roads.bigRoad.columns, lengths);
  // Every one of the 66 cells lands exactly where the page draws it.
  assert.deepEqual(
    roads.bigEyeBoy.cells.map((c) => ({ col: c.col, row: c.row })),
    WOO_BIG_EYE_BOY.map(([cell]) => parseCell(cell)),
  );
  // Colors: 64 of 66 match the page's table. The other two are typos on the page, contradicted by its
  // own cell positions: V1 starts a new column right after four reds (U1–U4), so it must be blue
  // (and the rule agrees: Big Road U has 2, T has 3 → different → blue); W2 sits under W1 (red) in the
  // same column, so it must be red (rule: V has 2, U has 2 → equal → red).
  const PAGE_TYPOS = { 38: 'B', 40: 'R' };
  const expected = WOO_BIG_EYE_BOY.map((r, i) => PAGE_TYPOS[i] ?? r[2]);
  assert.deepEqual([WOO_BIG_EYE_BOY[38][0], WOO_BIG_EYE_BOY[38][2], WOO_BIG_EYE_BOY[40][0], WOO_BIG_EYE_BOY[40][2]], ['V1', 'R', 'W2', 'B']);
  assert.equal(roads.bigEyeBoy.colors.join(''), expected.join(''));
  // And the page's positions alone imply exactly these colors: same column = same color, new column = change.
  roads.bigEyeBoy.cells.forEach((c, i) => {
    if (i === 0) return;
    const prev = roads.bigEyeBoy.cells[i - 1];
    const sameStreak = c.col === prev.col && c.row === prev.row + 1;
    assert.equal(expected[i] === expected[i - 1], sameStreak, `entry ${i + 1} (${WOO_BIG_EYE_BOY[i][0]})`);
  });
});

// ---------- Small Road and Cockroach Pig ----------
// No published play-by-play was found for these, so they're worked by hand from the rules on the same
// Wizard of Odds shoe (first 11 Big Road columns: 1 1 2 1 4 1 1 1 2 3 3).
//   Small Road (k = 2): starts at C2 (column C has 2 entries).
//     C2 col A len 1 = r-1 → B · D1 C(2)≠A(1) → B · E1 D(1)=B(1) → R · E2 C has row 2 → R · E3 C len 2 = r-1 → B
//     E4 C len 2 < 3 → R · F1 E(4)≠C(2) → B · G1 F=D → R · H1 G≠E → B · I1 H=F → R · I2 G len 1 = r-1 → B
//     J1 I(2)≠G(1) → B · J2 H len 1 = r-1 → B · J3 H len 1 < 2 → R · K1 J(3)≠H(1) → B · K2 I has row 2 → R
//     K3 I len 2 = r-1 → B
//   Cockroach Pig (k = 3): column D has 1 entry, so it starts at E1.
//     E1 D(1)=A(1) → R · E2 B len 1 = r-1 → B · E3 B len 1 < 2 → R · E4 → R · F1 E(4)≠B(1) → B · G1 F(1)≠C(2) → B
//     H1 G=D → R · I1 H(1)≠E(4) → B · I2 F len 1 = r-1 → B · J1 I(2)≠F(1) → B · J2 G len 1 → B · J3 G < 2 → R
//     K1 J(3)≠G(1) → B · K2 H len 1 = r-1 → B · K3 H len 1 < 2 → R
test('Small Road and Cockroach Pig, worked by hand on the same shoe', () => {
  const lengths = [1, 1, 2, 1, 4, 1, 1, 1, 2, 3, 3];
  assert.equal(derivedColors(lengths, 2).join(''), 'BBRRBRBRBRBBBRBRB');
  assert.equal(derivedColors(lengths, 3).join(''), 'RBRRBBRBBBBRBBR');
  const roads = buildRoads(lengths.map((n, i) => (i % 2 ? 'P' : 'B').repeat(n)).join(''));
  assert.equal(roads.smallRoad.colors.join(''), 'BBRRBRBRBRBBBRBRB');
  // Layout: same color down, change of color = new column.
  assert.deepEqual(at(roads.smallRoad.cells).slice(0, 6), ['0,0', '0,1', '1,0', '1,1', '2,0', '3,0']);
  assert.deepEqual(at(roads.cockroachPig.cells).slice(0, 5), ['0,0', '1,0', '2,0', '2,1', '3,0']);
});

test('derived roads start where the rules say, and not before', () => {
  // Column k+1 with 2+ entries: the first entry is its row 2.
  assert.deepEqual(derivedColors([1, 2], 1), ['B']); // B2: column A len 1 = r-1 → blue
  assert.deepEqual(derivedColors([1, 1], 1), []); // B has one entry: nothing yet
  assert.deepEqual(derivedColors([1, 1, 1], 1), ['R']); // so it starts at C1: B(1) = A(1)
  assert.deepEqual(derivedColors([3, 1, 1], 2), []);
  assert.deepEqual(derivedColors([3, 1, 1, 2], 2), ['B', 'B']); // D1: C(1)≠A(3); D2: B len 1 = r-1
  assert.deepEqual(derivedColors([2, 2, 2, 2], 3), ['R']); // D2: column A has row 2
  assert.deepEqual(derivedColors([2, 2, 2], 3), []);
  // Results before each road starts produce nothing.
  const early = buildRoads('BPB');
  assert.deepEqual([early.bigEyeBoy.cells.length, early.smallRoad.cells.length, early.cockroachPig.cells.length], [1, 0, 0]);
  assert.equal(buildRoads('').bigEyeBoy.cells.length, 0);
});

// ---------- Bead Plate ----------
test('Bead Plate: every hand top to bottom, six rows, then the next column', () => {
  const cells = beadPlate('BPTBBBPP');
  assert.deepEqual(at(cells), ['0,0', '0,1', '0,2', '0,3', '0,4', '0,5', '1,0', '1,1']);
  assert.deepEqual(cells.map((c) => c.result).join(''), 'BPTBBBPP');
  assert.equal(buildRoads('BPTBBBPP').bead.cols, 2);
});

// ---------- Big Road ----------
test('Big Road: streaks down, a change of winner starts a new column, ties are slashes', () => {
  const r = buildRoads('BBTPTTPB');
  assert.deepEqual(r.bigRoad.cells.map((c) => `${c.col},${c.row},${c.winner},${c.ties}`), ['0,0,B,0', '0,1,B,1', '1,0,P,2', '1,1,P,0', '2,0,B,0']);
  assert.deepEqual(r.bigRoad.columns, [2, 2, 1]);
  assert.deepEqual(r.summary, { banker: 3, player: 2, tie: 3, hands: 8 });
});

test('ties at the start of the shoe wait for the first circle, then show on it', () => {
  const pending = bigRoadColumns('TT');
  assert.deepEqual([pending.columns.length, pending.leadingTies], [0, 2]);
  assert.equal(buildRoads('TT').bigRoad.pendingTies, 2);
  const r = buildRoads('TTPT');
  assert.deepEqual(r.bigRoad.cells.map((c) => [c.winner, c.ties]), [['P', 3]]);
  assert.equal(r.bigRoad.pendingTies, 0);
  assert.equal(r.bead.cells.length, 4, 'the Bead Plate still shows every tie');
  assert.deepEqual([r.bigEyeBoy.cells.length, r.smallRoad.cells.length], [0, 0], 'ties add nothing to derived roads');
  assert.deepEqual(derivedColors(buildRoads('BTBTTPTP').bigRoad.columns, 1), derivedColors(buildRoads('BBPP').bigRoad.columns, 1));
});

test('dragon tail: past row 6 it turns right along the bottom row', () => {
  const r = buildRoads('BBBBBBBBB'); // 9 Bankers
  assert.deepEqual(at(r.bigRoad.cells), ['0,0', '0,1', '0,2', '0,3', '0,4', '0,5', '1,5', '2,5', '3,5']);
  assert.equal(r.bigRoad.cols, 4);
  assert.deepEqual(r.bigRoad.columns, [9], 'still one logical column');
});

test('dragon tail: a cell below already taken turns the streak right early (L shape)', () => {
  // 8 B (tail along row 6 into columns 2–3), then 6 P: column 2 is blocked at row 6, so P turns at row 5;
  // then B starts at the top of column 3 (one right of the P column's start).
  const r = buildRoads('BBBBBBBB' + 'PPPPPP' + 'B');
  const p = r.bigRoad.cells.filter((c) => c.column === 2);
  assert.deepEqual(at(p), ['1,0', '1,1', '1,2', '1,3', '1,4', '2,4']);
  assert.deepEqual(at(r.bigRoad.cells.filter((c) => c.column === 3)), ['2,0']);
  const cellsSeen = new Set(at(r.bigRoad.cells));
  assert.equal(cellsSeen.size, r.bigRoad.cells.length, 'no two circles share a cell');
});

test('derived roads use logical columns (streak lengths), not where the dragon tail is drawn', () => {
  // A 9-long Banker streak drawn as an L still counts as length 9.
  const tail = buildRoads('BBBBBBBBB' + 'P' + 'BBBBBBBBB' + 'P');
  assert.deepEqual(tail.bigRoad.columns, [9, 1, 9, 1]);
  assert.deepEqual(tail.bigEyeBoy.colors, derivedColors([9, 1, 9, 1], 1));
  // and long derived streaks get their own dragon tails
  const long = placeStreaks(streaksOf('RRRRRRRRB'.split('')));
  assert.deepEqual(at(long.cells), ['0,0', '0,1', '0,2', '0,3', '0,4', '0,5', '1,5', '2,5', '1,0']);
});

test('a whole shoe: every grid is consistent (no overlaps, 6 rows, counts add up)', () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const results = Array.from({ length: 85 }, () => {
    const x = rand();
    return x < 0.4586 ? 'B' : x < 0.9048 ? 'P' : 'T';
  }).join('');
  const r = buildRoads(results);
  const s = shoeSummary(results);
  assert.equal(s.hands, 85);
  assert.equal(r.bigRoad.cells.length, s.banker + s.player);
  assert.equal(r.bigRoad.cells.reduce((n, c) => n + c.ties, 0) + r.bigRoad.pendingTies, s.tie);
  for (const grid of [r.bead, r.bigRoad, r.bigEyeBoy, r.smallRoad, r.cockroachPig]) {
    assert.equal(new Set(at(grid.cells)).size, grid.cells.length);
    assert.ok(grid.cells.every((c) => c.row >= 0 && c.row < 6 && c.col >= 0 && c.col < grid.cols));
  }
  // Each derived road has one entry per Big Road entry from its start on.
  const lengths = r.bigRoad.columns;
  for (const [id, k] of [['bigEyeBoy', 1], ['smallRoad', 2], ['cockroachPig', 3]]) {
    const before = lengths.length > k ? (lengths.slice(0, k).reduce((a, b) => a + b, 0) + 1) : lengths.reduce((a, b) => a + b, 0);
    assert.equal(r[id].cells.length, Math.max(0, lengths.reduce((a, b) => a + b, 0) - before), id);
  }
});
