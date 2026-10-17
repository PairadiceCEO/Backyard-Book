// The Baccarat scoreboard ("roads"), built from the shoe's results in order: 'B' Banker, 'P' Player,
// 'T' Tie. One pure function, buildRoads(results), returns every grid as cells, so the server, the
// phone and the tests all agree. Columns and rows in cells are 0-based; the grids are 6 rows tall.
//
//   Bead Plate     every hand, top to bottom, then the next column.
//   Big Road       Banker/Player streaks: same winner goes down, a change starts a new column at the top.
//                  Ties are a slash (with a count) on the latest circle; ties before the first B/P of the
//                  shoe go on that first circle once it appears.
//   Derived roads  Big Eye Boy (k = 1), Small Road (k = 2), Cockroach Pig (k = 3). Read the Big Road's
//                  logical columns (streak lengths, not where a dragon tail is drawn). Red = repeating,
//                  blue = choppy (nothing to do with Banker/Player).
//
// Dragon tail (Big Road and the derived roads): a streak that would pass row 6, or whose next cell
// down is taken, turns right and continues along that row.

export const ROAD_ROWS = 6;
export const DERIVED_ROADS = [
  { id: 'bigEyeBoy', name: 'Big Eye Boy', k: 1 },
  { id: 'smallRoad', name: 'Small Road', k: 2 },
  { id: 'cockroachPig', name: 'Cockroach Pig', k: 3 },
];

export function normalizeResults(results) {
  const list = typeof results === 'string' ? results.split('') : Array.isArray(results) ? results : [];
  return list.filter((r) => r === 'B' || r === 'P' || r === 'T');
}

export function shoeSummary(results) {
  const list = normalizeResults(results);
  const count = (w) => list.filter((r) => r === w).length;
  return { banker: count('B'), player: count('P'), tie: count('T'), hands: list.length };
}

export function beadPlate(results, rows = ROAD_ROWS) {
  return normalizeResults(results).map((result, i) => ({ col: Math.floor(i / rows), row: i % rows, result, hand: i + 1 }));
}

// Big Road logical columns: [[{ winner, ties, hand }]], plus ties seen before any Banker/Player win.
export function bigRoadColumns(results) {
  const columns = [];
  let leadingTies = 0;
  normalizeResults(results).forEach((result, i) => {
    const lastColumn = columns[columns.length - 1];
    if (result === 'T') {
      if (lastColumn) lastColumn[lastColumn.length - 1].ties += 1;
      else leadingTies += 1;
      return;
    }
    const entry = { winner: result, ties: 0, hand: i + 1 };
    if (!lastColumn) {
      entry.ties = leadingTies; // ties before the first B/P show on the first circle
      leadingTies = 0;
      columns.push([entry]);
    } else if (lastColumn[0].winner === result) {
      lastColumn.push(entry);
    } else {
      columns.push([entry]);
    }
  });
  return { columns, leadingTies };
}

// Places streaks on a grid with dragon tails. streaks: [[item, …], …]. Returns
// { cells: [{ col, row, item, streak, index }], cols } where cols is the number of grid columns used.
export function placeStreaks(streaks, rows = ROAD_ROWS) {
  const taken = new Set();
  const key = (c, r) => `${c},${r}`;
  const cells = [];
  let lastStart = -1;
  let cols = 0;

  streaks.forEach((streak, s) => {
    let col = lastStart + 1;
    while (taken.has(key(col, 0))) col += 1;
    lastStart = col;
    let row = 0;
    let turned = false;
    streak.forEach((item, index) => {
      if (index > 0) {
        if (!turned && row + 1 < rows && !taken.has(key(col, row + 1))) {
          row += 1;
        } else {
          turned = true;
          col += 1;
          while (taken.has(key(col, row))) col += 1;
        }
      }
      taken.add(key(col, row));
      cells.push({ col, row, item, streak: s, index });
      cols = Math.max(cols, col + 1);
    });
  });
  return { cells, cols };
}

// One derived road's colors, in order, from the Big Road's column lengths. 'R' red, 'B' blue.
// Entry at column c, row r (1-based):
//   it exists from column k+1 row 2 on (or column k+2 row 1 when column k+1 has a single entry);
//   r = 1: columns c-1 and c-1-k equal in length → red, else blue;
//   r > 1: column c-k has row r → red; its length is exactly r-1 → blue; shorter than r-1 → red.
export function derivedColors(lengths, k) {
  const colors = [];
  for (let c = 1; c <= lengths.length; c += 1) {
    for (let r = 1; r <= lengths[c - 1]; r += 1) {
      const started = (c === k + 1 && r >= 2) || c >= k + 2;
      if (!started) continue;
      if (r === 1) {
        colors.push(lengths[c - 2] === lengths[c - 2 - k] ? 'R' : 'B');
      } else {
        const compare = lengths[c - 1 - k];
        colors.push(compare === r - 1 ? 'B' : 'R');
      }
    }
  }
  return colors;
}

// Same color goes down; a color change starts a new column.
export function streaksOf(values) {
  const streaks = [];
  for (const v of values) {
    const last = streaks[streaks.length - 1];
    if (last && last[0] === v) last.push(v);
    else streaks.push([v]);
  }
  return streaks;
}

export function buildRoads(results, rows = ROAD_ROWS) {
  const list = normalizeResults(results);
  const bead = beadPlate(list, rows);
  const { columns, leadingTies } = bigRoadColumns(list);
  const big = placeStreaks(columns, rows);
  const lengths = columns.map((column) => column.length);

  const derived = {};
  for (const road of DERIVED_ROADS) {
    const colors = derivedColors(lengths, road.k);
    const placed = placeStreaks(streaksOf(colors), rows);
    derived[road.id] = {
      colors,
      cells: placed.cells.map(({ col, row, item }) => ({ col, row, color: item })),
      cols: placed.cols,
    };
  }

  return {
    summary: shoeSummary(list),
    bead: { cells: bead, cols: bead.length ? bead[bead.length - 1].col + 1 : 0 },
    bigRoad: {
      cells: big.cells.map(({ col, row, item, streak, index }) => ({ col, row, winner: item.winner, ties: item.ties, hand: item.hand, column: streak + 1, depth: index + 1 })),
      cols: big.cols,
      columns: lengths,
      pendingTies: leadingTies,
    },
    ...derived,
  };
}
