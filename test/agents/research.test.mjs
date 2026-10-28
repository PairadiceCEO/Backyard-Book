// npm run test:agents — the 0.22.0 research tools (agents/lib/research.mjs, exposed in agents/lib/tools.mjs) on mocked ESPN
// and splits sources (no network): each tool's shape and size cap, failed / empty sources returning safe values, the sharp
// signals, get_my_history, the 75% decision switch and a full mocked run where the model researches and then bets.
// The fixtures follow the shapes ESPN's public endpoints returned when this was written (odds, schedule, summary, statistics,
// standings, roster, gamelog); the parsers are defensive, so a field that is missing just drops out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;
const R = await import(url('agents/lib/research.mjs'));
const { createTools, estimateTokens, RESEARCH_TOOLS } = await import(url('agents/lib/tools.mjs'));
const { runAgent } = await import(url('agents/lib/runner.mjs'));

const NOW = new Date('2026-10-28T15:00:00Z');
const START = NOW.getTime() + 3 * 3600e3;
const DAY = 24 * 3600e3;
const CAP = R.MAX_RESULT_TOKENS;

// ---------- ESPN fixtures ----------
const TEAMS = [
  { id: '1', abbreviation: 'BOS', displayName: 'Boston Celtics', shortDisplayName: 'Celtics', name: 'Celtics', location: 'Boston' },
  { id: '2', abbreviation: 'MIL', displayName: 'Milwaukee Bucks', shortDisplayName: 'Bucks', name: 'Bucks', location: 'Milwaukee' },
  { id: '3', abbreviation: 'CHA', displayName: 'Charlotte Hornets', shortDisplayName: 'Hornets', name: 'Hornets', location: 'Charlotte' },
];
const teamsJson = { sports: [{ leagues: [{ teams: TEAMS.map((team) => ({ team })) }] }] };

// 12 completed games for a team, one a day, the last `lastDaysAgo` days before NOW. results[i] = [pf, pa]; home alternates.
function scheduleJson(teamId, oppId, results, lastDaysAgo, extraFuture = true) {
  const opp = TEAMS.find((t) => t.id === oppId);
  const me = TEAMS.find((t) => t.id === teamId);
  const events = results.map(([pf, pa], i) => {
    const home = i % 2 === 0;
    const date = new Date(NOW.getTime() - (lastDaysAgo + (results.length - 1 - i)) * DAY).toISOString();
    const side = (t, score, h) => ({ homeAway: h ? 'home' : 'away', team: { id: t.id, abbreviation: t.abbreviation }, score: { value: score, displayValue: String(score) } });
    return { id: `e${teamId}${i}`, date, seasonType: { type: 2 }, competitions: [{ status: { type: { completed: true } }, competitors: [side(me, pf, home), side(opp, pa, !home)] }] };
  });
  // a scheduled game without scores (as ESPN lists the future) must be ignored
  if (extraFuture) events.push({ id: 'future', date: new Date(START).toISOString(), seasonType: { type: 2 }, competitions: [{ status: { type: { completed: false } }, competitors: [{ homeAway: 'home', team: { id: teamId, abbreviation: me.abbreviation } }, { homeAway: 'away', team: { id: oppId, abbreviation: opp.abbreviation } }] }] });
  return { events };
}
const AWAY_RESULTS = [[110, 100], [95, 101], [120, 99], [104, 98], [99, 110], [108, 90], [101, 100], [115, 105], [97, 103], [112, 102], [118, 100], [109, 107]]; // BOS: 9-3? counted in the test
const HOME_RESULTS = [[100, 95], [105, 110], [99, 90], [101, 104], [120, 100], [88, 99], [102, 100], [111, 109], [96, 94], [107, 100], [93, 101], [115, 98]];

const oddsJson = {
  items: [
    { provider: { id: '58', name: 'ESPN BET' }, overUnder: 1 },
    {
      provider: { id: '100', name: 'DraftKings' },
      overUnder: 226.5,
      spread: -6,
      open: { total: { american: '228.5' } },
      current: { total: { american: '226.5' } },
      homeTeamOdds: { open: { pointSpread: { american: '-7.5' }, moneyLine: { american: '-320' } }, current: { pointSpread: { american: '-6' }, moneyLine: { american: '-260' } } },
      awayTeamOdds: { open: { pointSpread: { american: '+7.5' }, moneyLine: { american: '+260' } }, current: { pointSpread: { american: '+6' }, moneyLine: { american: '+215' } } },
    },
  ],
};
const summaryJson = {
  injuries: [
    { team: { id: '1', displayName: 'Boston Celtics' }, injuries: [{ status: 'Day-To-Day', athlete: { displayName: 'Sam Hauser' }, details: { type: 'Knee' } }, { status: 'Out', athlete: { displayName: 'Jayson Tatum' }, details: { type: 'Achilles' } }] },
    { team: { id: '2', displayName: 'Milwaukee Bucks' }, injuries: [{ status: 'Questionable', athlete: { displayName: 'Bobby Portis' }, details: { type: 'Ankle' } }] },
  ],
};
const statsJson = {
  results: {
    stats: {
      categories: [
        { name: 'general', stats: [{ name: 'avgRebounds', abbreviation: 'REB', value: 44.1, perGameValue: 44.1 }] },
        { name: 'offensive', stats: [{ name: 'avgPoints', abbreviation: 'PTS', value: 114.2 }, { name: 'threePointPct', abbreviation: '3P%', value: 37.2 }, { name: 'totalPoints', abbreviation: 'TP', value: 2284 }] },
        { name: 'defensive', stats: [{ name: 'avgBlocks', abbreviation: 'BLK', value: 5.1 }, { name: 'avgSteals', abbreviation: 'STL', value: 7.4 }] },
      ],
    },
  },
};
const standingsJson = {
  children: [{ standings: { entries: [
    { team: { id: '1' }, stats: [{ name: 'avgPointsFor', value: 114.2 }, { name: 'avgPointsAgainst', value: 106.1 }, { name: 'wins', value: 9 }, { name: 'losses', value: 3 }] },
    { team: { id: '2' }, stats: [{ name: 'avgPointsFor', value: 108.0 }, { name: 'avgPointsAgainst', value: 104.5 }, { name: 'wins', value: 7 }, { name: 'losses', value: 5 }] },
    { team: { id: '3' }, stats: [{ name: 'avgPointsFor', value: 101.0 }, { name: 'avgPointsAgainst', value: 112.0 }, { name: 'wins', value: 2 }, { name: 'losses', value: 10 }] },
  ] } }],
};
const rosterJson = { athletes: [{ id: '900', displayName: 'Giannis Antetokounmpo', fullName: 'Giannis Antetokounmpo' }, { id: '901', displayName: 'Bobby Portis Jr.', fullName: 'Bobby Portis Jr.' }] };
// 14 games, newest first is produced by sorting dates; points by game: 30, 26, 35, 28, 31, 24, 38, 27, 29, 33, 25, 36, 30, 32
const GL_POINTS = [30, 26, 35, 28, 31, 24, 38, 27, 29, 33, 25, 36, 30, 32];
function gamelogJson() {
  const events = {};
  const catEvents = [];
  GL_POINTS.forEach((pts, i) => {
    const id = `g${i}`;
    events[id] = { gameDate: new Date(NOW.getTime() - (GL_POINTS.length - i) * 2 * DAY).toISOString(), atVs: i % 2 === 0 ? 'vs' : '@', opponent: { abbreviation: `O${i}` } };
    catEvents.push({ eventId: id, stats: ['34:30', '10-20', '50.0', `${i % 5}-9`, '33.3', '5-6', '83.3', String(8 + (i % 4)), '5', '1', '1', '2', '3', String(pts)] });
  });
  return {
    labels: ['MIN', 'FG', 'FG%', '3PT', '3P%', 'FT', 'FT%', 'REB', 'AST', 'BLK', 'STL', 'PF', 'TO', 'PTS'],
    names: ['minutes', 'fieldGoalsMade-fieldGoalsAttempted', 'fieldGoalPct', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'threePointPct', 'freeThrowsMade-freeThrowsAttempted', 'freeThrowPct', 'totalRebounds', 'assists', 'blocks', 'steals', 'fouls', 'turnovers', 'points'],
    displayNames: ['Minutes', 'Field Goals Made-Attempted', 'Field Goal Percentage', '3-Point Field Goals Made-Attempted', '3-Point Field Goal Percentage', 'Free Throws Made-Attempted', 'Free Throw Percentage', 'Rebounds', 'Assists', 'Blocks', 'Steals', 'Fouls', 'Turnovers', 'Points'],
    events,
    seasonTypes: [
      { displayName: '2026-27 Regular Season', categories: [{ displayName: 'Regular Season', events: catEvents }] },
      { displayName: '2026-27 Preseason', categories: [{ events: [{ eventId: 'pre1', stats: Array(14).fill('99') }] }] },
    ],
  };
}

// A mocked ESPN: routes by URL. `fail` = substrings that answer 500; `overrides` = [substring, json] first match wins.
function espn({ fail = [], overrides = [], throwAll = false } = {}) {
  const calls = [];
  const fetchImpl = async (u) => {
    const href = String(u);
    calls.push(href);
    if (throwAll) throw new Error('network down');
    const reply = (status, json) => ({ ok: status < 300, status, json: async () => json });
    if (fail.some((f) => href.includes(f))) return reply(500, {});
    for (const [sub, json] of overrides) if (href.includes(sub)) return reply(200, json);
    if (href.includes('/teams?limit=')) return reply(200, teamsJson);
    if (href.includes('/teams/1/schedule')) return reply(200, href.includes('seasontype=2') ? scheduleJson('1', '2', AWAY_RESULTS, 1) : { events: [] });
    if (href.includes('/teams/2/schedule')) return reply(200, href.includes('seasontype=2') ? scheduleJson('2', '1', HOME_RESULTS, 3) : { events: [] });
    if (href.includes('/teams/3/schedule')) return reply(200, { events: [] });
    if (href.includes('/summary?event=')) return reply(200, summaryJson);
    if (href.includes('/odds')) return reply(200, oddsJson);
    if (href.includes('/teams/') && href.includes('/statistics')) return reply(200, statsJson);
    if (href.includes('/standings')) return reply(200, standingsJson);
    if (href.includes('/teams/2/roster')) return reply(200, rosterJson);
    if (href.includes('/roster')) return reply(200, { athletes: [] });
    if (href.includes('/gamelog')) return reply(200, gamelogJson());
    return reply(404, {});
  };
  return { fetchImpl, calls };
}

const GAME = { id: '4001', startTime: new Date(START).toISOString(), away: { id: '1', name: 'Boston Celtics', abbr: 'BOS' }, home: { id: '2', name: 'Milwaukee Bucks', abbr: 'MIL' } };
const lookupGame = async (league, id) => (id === '4001' ? GAME : null);
const make = (opts = {}) => {
  const world = espn(opts.espn);
  return { world, research: R.createResearch({ fetchImpl: world.fetchImpl, now: () => NOW, lookupGame, splitsSource: opts.splitsSource ?? null }) };
};
const compactJson = (o) => JSON.stringify(o);
const record = (rows, home) => {
  const mine = rows.filter((_, i) => (home === undefined ? true : (i % 2 === 0) === home));
  const w = mine.filter(([a, b]) => a > b).length;
  return `${w}-${mine.length - w}`;
};

// ---------- get_matchup ----------
test('get_matchup: form, records, scoring, rest, head-to-head, injuries and DraftKings line movement; compact and under the cap', async () => {
  const { research } = make();
  const m = await research.matchup('nba', '4001');
  assert.equal(m.game, 'BOS @ MIL');
  assert.equal(m.a.rec, record(AWAY_RESULTS));
  assert.equal(m.a.hm, record(AWAY_RESULTS, true));
  assert.equal(m.a.rd, record(AWAY_RESULTS, false));
  assert.equal(m.h.rec, record(HOME_RESULTS));
  assert.equal(m.a.l10.length, 10);
  assert.match(m.a.l10.at(-1), /^\d+-\d+ (vs|@)\w+ [WLT]\d+-\d+$/);
  const last5 = AWAY_RESULTS.slice(-5);
  const last10 = AWAY_RESULTS.slice(-10);
  assert.equal(m.a.pf5, Math.round((last5.reduce((n, r) => n + r[0], 0) / 5) * 10) / 10);
  assert.equal(m.a.pa10, Math.round((last10.reduce((n, r) => n + r[1], 0) / 10) * 10) / 10);
  assert.equal(m.a.rest, 0, 'BOS played yesterday: a back-to-back');
  assert.equal(m.h.rest, 2, 'MIL last played 3 days ago: 2 days off');
  assert.ok(Array.isArray(m.h2h) && m.h2h.length <= 3);
  // injuries: most serious first, short statuses
  assert.deepEqual(m.inj.a, ['Jayson Tatum out (Achilles)', 'Sam Hauser dtd (Knee)']);
  assert.deepEqual(m.inj.h, ['Bobby Portis q (Ankle)']);
  // DraftKings (provider 100), not the first item
  assert.deepEqual(m.mv.sp, { o: -7.5, c: -6 });
  assert.deepEqual(m.mv.tot, { o: 228.5, c: 226.5 });
  assert.deepEqual(m.mv.ml, { h: { o: -320, c: -260 }, a: { o: 260, c: 215 } });
  assert.equal(m.sharp, undefined, 'no splits source: no sharp flags');
  assert.ok(estimateTokens(m) <= CAP, `${estimateTokens(m)} tokens`);
  assert.ok(!compactJson(m).includes('\n') && !compactJson(m).includes('  '), 'no pretty-printing');
  assert.ok(!('wx' in m) && !('prob' in m), 'nothing for the NBA: no weather, no probables');
});

test('get_matchup: unknown game, every source down, one source down, a game with no history', async () => {
  const { research } = make();
  assert.deepEqual(await research.matchup('nba', 'nope'), { available: false, error: 'Unknown game: use a gameId from get_board.' });
  assert.equal((await research.matchup('xyz', '4001')).available, false);
  const down = make({ espn: { throwAll: true } }).research;
  const out = await down.matchup('nba', '4001');
  assert.equal(out.available, false);
  assert.ok(estimateTokens(out) < 100);
  // only the odds feed answers: movement is returned, form is just missing
  const partial = make({ espn: { fail: ['/schedule', '/summary'] } }).research;
  const p = await partial.matchup('nba', '4001');
  assert.deepEqual(p.mv.sp, { o: -7.5, c: -6 });
  assert.equal(p.a.rec, '0-0');
  // empty / garbage bodies
  const junk = make({ espn: { overrides: [['/schedule', { events: 'x' }], ['/summary', []], ['/odds', { items: null }]] } }).research;
  assert.equal((await junk.matchup('nba', '4001')).available ?? true, true);
});

test('research results are cached for the run: the second call reads nothing new', async () => {
  const { research, world } = make();
  await research.matchup('nba', '4001');
  const n = world.calls.length;
  assert.ok(n > 0 && new Set(world.calls).size === n, 'each URL was read once');
  await research.matchup('nba', '4001');
  assert.equal(world.calls.length, n);
});

test('get_matchup: a huge injury list and long logs still fit the cap', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ status: 'Out', athlete: { displayName: `Player Number${i} With A Long Name` }, details: { type: 'Something very long here' } }));
  const { research } = make({ espn: { overrides: [['/summary', { injuries: [{ team: { id: '1' }, injuries: many }, { team: { id: '2' }, injuries: many }] }]] } });
  const m = await research.matchup('nba', '4001');
  assert.ok(estimateTokens(m) <= CAP, `${estimateTokens(m)} tokens`);
  assert.ok(m.inj.a.length <= 6);
});

test('get_matchup (MLB): probable pitchers and weather come from the scoreboard event when the summary has none; indoor venues have no weather', async () => {
  const board = (indoor) => ({ events: [{ id: '4001', weather: { displayValue: 'Mostly clear', temperature: 78 }, competitions: [{ venue: { indoor }, competitors: [
    { homeAway: 'home', probables: [{ athlete: { displayName: 'Griffin Jax' }, statistics: [{ abbreviation: 'ERA', displayValue: '6.00' }] }] },
    { homeAway: 'away', probables: [{ athlete: { displayName: 'Freddy Peralta' }, statistics: [{ abbreviation: 'ERA', displayValue: '3.10' }] }] },
  ] }] }] });
  const open = make({ espn: { overrides: [['/scoreboard', board(false)]] } }).research;
  const m = await open.matchup('mlb', '4001');
  assert.deepEqual(m.prob, { h: 'Griffin Jax (ERA 6.00)', a: 'Freddy Peralta (ERA 3.10)' });
  assert.equal(m.wx, '78F Mostly clear');
  const dome = make({ espn: { overrides: [['/scoreboard', board(true)]] } }).research;
  assert.equal((await dome.matchup('mlb', '4001')).wx, undefined);
});

// ---------- get_team_stats ----------
test('get_team_stats: per-game scoring, league ranks, last-10 totals, ESPN stats; resolves abbreviations and names; unknown team is safe', async () => {
  const { research } = make();
  const t = await research.teamStats('nba', 'bos');
  assert.equal(t.team, 'BOS');
  assert.deepEqual(t.rk, { pf: 1, pa: 2, of: 3 });
  assert.equal(t.tot10.length, 10);
  assert.equal(t.tot10.at(-1), AWAY_RESULTS.at(-1)[0] + AWAY_RESULTS.at(-1)[1]);
  assert.equal(t.avgTot10, Math.round((AWAY_RESULTS.slice(-10).reduce((n, r) => n + r[0] + r[1], 0) / 10) * 10) / 10);
  assert.ok(t.off.some((x) => x.k === 'PTS' && x.v === 114.2));
  assert.ok(t.def.some((x) => x.k === 'STL'));
  assert.ok(estimateTokens(t) <= CAP);
  assert.equal((await research.teamStats('nba', 'Milwaukee Bucks')).team, 'MIL');
  assert.equal((await research.teamStats('nba', 'Bucks')).team, 'MIL');
  const none = await research.teamStats('nba', 'Zzz');
  assert.equal(none.available, false);
  const down = make({ espn: { throwAll: true } }).research;
  assert.equal((await down.teamStats('nba', 'bos')).available, false, 'no teams list → unknown team, no crash');
  const noStats = make({ espn: { fail: ['/statistics', '/schedule', '/standings'] } }).research;
  assert.equal((await noStats.teamStats('nba', 'bos')).available, false);
});

// ---------- get_player_trends ----------
test('get_player_trends: last 10 newest first with home / away and opponent, averages, games over the line; names match like get_props', async () => {
  const { research } = make();
  research.notePlayer('nba', 'Giannis Antetokounmpo', 'MIL');
  const t = await research.playerTrends('nba', 'Giannis Antetokounmpo', 'points', 30);
  const newest10 = GL_POINTS.slice(-10).reverse();
  assert.equal(t.n, 10);
  assert.equal(t.avg10, Math.round((newest10.reduce((n, x) => n + x, 0) / 10) * 10) / 10);
  assert.equal(t.avg, Math.round((GL_POINTS.reduce((n, x) => n + x, 0) / GL_POINTS.length) * 10) / 10, 'the preseason row (99) is left out');
  assert.equal(t.over, `${newest10.filter((x) => x > 30).length}/10 over 30`);
  assert.equal(t.log.length, 10);
  assert.match(t.log[0], /^\d+-\d+ (vs|@)O\d+ 32$/, 'newest game first');
  const home = GL_POINTS.filter((_, i) => i % 2 === 0);
  assert.equal(t.hAvg, Math.round((home.reduce((n, x) => n + x, 0) / home.length) * 10) / 10);
  assert.ok(t.aAvg > 0);
  assert.ok(estimateTokens(t) <= CAP);
  // "Jr." and punctuation do not matter; a stat given as made-attempted ("3PT" 1-9) reads the made number; minutes as m:ss
  const threes = await research.playerTrends('nba', 'bobby portis', 'threes');
  assert.equal(threes.player, 'Bobby Portis Jr.');
  assert.equal(threes.over, undefined, 'no line → no over count');
  assert.equal((await research.playerTrends('nba', 'Giannis Antetokounmpo', 'rebounds', 9)).n, 10);
  assert.ok(Math.abs((await research.playerTrends('nba', 'Giannis Antetokounmpo', 'minutes')).avg - 34.5) < 0.01);
});

test('get_player_trends: unknown player, unknown stat, empty or failed gamelog are safe', async () => {
  const { research } = make();
  assert.equal((await research.playerTrends('nba', 'Nobody Here', 'points')).available, false);
  assert.equal((await research.playerTrends('nba', 'Giannis Antetokounmpo', 'sneezes')).available, false);
  assert.equal((await research.playerTrends('nba', '', 'points')).available, false);
  const empty = make({ espn: { overrides: [['/gamelog', { names: ['points'], seasonTypes: [{ displayName: 'Regular Season', categories: [{ events: [] }] }] }]] } }).research;
  assert.equal((await empty.playerTrends('nba', 'Giannis Antetokounmpo', 'points')).n, 0);
  const failed = make({ espn: { fail: ['/gamelog'] } }).research;
  assert.equal((await failed.playerTrends('nba', 'Giannis Antetokounmpo', 'points')).available, false);
});

// ---------- betting splits and sharp signals ----------
test('get_betting_splits: no permitted source → { available: false, hint }; never reads the network', async () => {
  const { research, world } = make();
  assert.deepEqual(await research.bettingSplits('nba', [GAME]), { available: false, hint: R.SPLITS_HINT });
  assert.equal(world.calls.length, 0);
});

const SPLITS = { games: [{ away: 'BOS', home: 'MIL', sp: { a: { b: 38, m: 61 }, h: { b: 62, m: 39 } }, tot: { o: { b: 70, m: 66 }, u: { b: 30, m: 34 } }, ml: { a: { b: 30, m: 33 }, h: { b: 70, m: 67 } } }] };

test('get_betting_splits with a source: per game splits plus sharp flags; get_matchup carries the flags too', async () => {
  const { research } = make({ splitsSource: async () => SPLITS });
  const s = await research.bettingSplits('nba', [GAME]);
  assert.equal(s.available, true);
  assert.equal(s.games.length, 1);
  assert.deepEqual(s.games[0].sp.a, { b: 38, m: 61 });
  assert.ok(s.games[0].sharp.some((f) => /^BOS spread: money 61% vs bets 38%/.test(f)));
  assert.ok(s.games[0].sharp.some((f) => f.startsWith('RLM spread: MIL has 62% of bets but the home line moved -7.5 → -6')));
  assert.ok(s.games[0].sharp.some((f) => f.startsWith('RLM total: over has 70% of bets but the total moved 228.5 → 226.5')));
  assert.ok(s.games[0].sharp.some((f) => f.startsWith('RLM moneyline: MIL has 70% of bets')));
  assert.ok(estimateTokens(s) <= CAP);
  const m = await research.matchup('nba', '4001');
  assert.deepEqual(m.sharp, s.games[0].sharp);
});

test('get_betting_splits: a source that throws, returns junk or has no matching game gives safe values', async () => {
  assert.deepEqual(await make({ splitsSource: async () => { throw new Error('boom'); } }).research.bettingSplits('nba', [GAME]), { available: false, hint: R.SPLITS_HINT });
  assert.deepEqual(await make({ splitsSource: async () => 'junk' }).research.bettingSplits('nba', [GAME]), { available: false, hint: R.SPLITS_HINT });
  const none = await make({ splitsSource: async () => ({ games: [{ away: 'XXX', home: 'YYY' }] }) }).research.bettingSplits('nba', [GAME]);
  assert.deepEqual(none.games, []);
  const m = await make({ splitsSource: async () => { throw new Error('boom'); } }).research.matchup('nba', '4001');
  assert.equal(m.sharp, undefined);
});

test('sharp signals: money% 15+ points above bets%, and reverse line movement only when the line really moves against the crowd', () => {
  const flags = (splits, mv) => R.sharpFlags({ splits, mv, away: 'AWY', home: 'HOM' });
  // the gap: exactly 15 counts, 14 does not
  assert.equal(flags({ sp: { a: { b: 40, m: 55 }, h: { b: 60, m: 45 } } }).length, 1);
  assert.equal(flags({ sp: { a: { b: 40, m: 54 }, h: { b: 60, m: 46 } } }).length, 0);
  assert.match(flags({ sp: { a: { b: 40, m: 55 }, h: { b: 60, m: 45 } } })[0], /^AWY spread: money 55% vs bets 40% \(\+15\)$/);
  assert.match(flags({ ml: { a: { b: 20, m: 40 }, h: { b: 80, m: 60 } } })[0], /^AWY ML: money 40% vs bets 20%/);
  assert.match(flags({ tot: { o: { b: 30, m: 50 }, u: { b: 70, m: 50 } } })[0], /^over total/);
  // spread RLM: most bets on the home team (-7 → -6 means the home team is asked to lay less: moved against them)
  const homeCrowd = { sp: { a: { b: 40, m: 41 }, h: { b: 60, m: 59 } } };
  assert.match(flags(homeCrowd, { sp: { o: -7, c: -6 } })[0], /^RLM spread: HOM has 60% of bets/);
  assert.deepEqual(flags(homeCrowd, { sp: { o: -6, c: -7 } }), [], 'line moved with the crowd: not reverse');
  assert.equal(flags(homeCrowd, { sp: { o: -7, c: -6.5 } }).length, 1, 'a half-point move counts');
  assert.equal(flags(homeCrowd, { sp: { o: -7, c: -6.8 } }).length, 0, 'less than a half-point does not');
  assert.deepEqual(flags({ sp: { a: { b: 52, m: 50 }, h: { b: 48, m: 50 } } }, { sp: { o: -7, c: -5 } }), [], 'no side has a 55% majority');
  const awayCrowd = { sp: { a: { b: 65, m: 60 }, h: { b: 35, m: 40 } } };
  assert.match(flags(awayCrowd, { sp: { o: -6, c: -7 } })[0], /^RLM spread: AWY/);
  // total RLM: the crowd is on the over and the total falls
  assert.match(flags({ tot: { o: { b: 68, m: 60 }, u: { b: 32, m: 40 } } }, { tot: { o: 220, c: 218.5 } })[0], /^RLM total: over has 68%/);
  assert.deepEqual(flags({ tot: { o: { b: 68, m: 60 }, u: { b: 32, m: 40 } } }, { tot: { o: 220, c: 221.5 } }), []);
  // moneyline RLM: the price on the crowd's side got longer by 2+ implied points
  assert.match(flags({ ml: { a: { b: 30, m: 32 }, h: { b: 70, m: 68 } } }, { ml: { h: { o: -300, c: -250 }, a: { o: 250, c: 215 } } })[0], /^RLM moneyline: HOM has 70%/);
  assert.deepEqual(flags({ ml: { a: { b: 30, m: 32 }, h: { b: 70, m: 68 } } }, { ml: { h: { o: -250, c: -300 }, a: { o: 215, c: 250 } } }), []);
  // missing or partial data never throws
  assert.deepEqual(flags(undefined, undefined), []);
  assert.deepEqual(flags({ sp: { a: { b: 'x' } } }, { sp: { o: null } }), []);
});

// ---------- the tools: get_my_history, the research gate ----------
function fakeApi(handler) {
  const calls = [];
  return { calls, get: async (p) => handler('GET', p), post: async (p, b) => { calls.push({ p, b }); return handler('POST', p, b); } };
}
const boardGame = { ...GAME, league: 'nba', state: 'pre', bettingClosed: false, home: { ...GAME.home, shortName: 'Bucks' }, away: { ...GAME.away, shortName: 'Celtics' }, markets: {} };

test('get_my_history: one /api/bets "mine" call with history, a won / lost summary, at most 25 bets shown; unavailable says so', async () => {
  const bets = Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, pick: `Pick ${i}`, league: 'nba', odds: -110, stakeCents: 500, result: i % 3 === 0 ? 'won' : i % 3 === 1 ? 'lost' : 'push', returnCents: i % 3 === 0 ? 950 : i % 3 === 2 ? 500 : 0, why: 'because', settled: '2026-10-27T05:00:00.000Z' }));
  const api = fakeApi(() => ({ balanceCents: 1, openBets: [], history: { available: true, days: 14, bets } }));
  const tools = createTools({ api, now: () => NOW, limits: { maxSearches: 5 }, research: {} });
  const h = await tools.run('get_my_history', {});
  assert.deepEqual(api.calls, [{ p: '/api/bets', b: { action: 'mine', history: true } }]);
  assert.deepEqual({ n: h.n, won: h.won, lost: h.lost, stakedCents: h.stakeCents ?? h.stakedCents, more: h.more }, { n: 40, won: 14, lost: 13, stakedCents: 20000, more: 15 });
  assert.equal(h.bets.length, 25);
  assert.equal(h.returnedCents, 14 * 950 + 13 * 500);
  assert.ok(estimateTokens(h) <= CAP, `${estimateTokens(h)} tokens`);
  const missing = createTools({ api: fakeApi(() => ({ history: { available: false, reason: 'History is not available yet.' } })), now: () => NOW, limits: { maxSearches: 5 }, research: {} });
  assert.deepEqual(await missing.run('get_my_history', {}), { available: false, note: 'History is not available yet.' });
  const old = createTools({ api: fakeApi(() => ({ balanceCents: 1 })), now: () => NOW, limits: { maxSearches: 5 }, research: {} });
  assert.equal((await old.run('get_my_history', {})).available, false, 'an older server without history');
});

test('the research tools run through createTools (matchup looks the game up on the board); bad leagues and a closed gate are answered, not thrown', async () => {
  const world = espn();
  const api = fakeApi((m, p) => (p.includes('/api/board') ? { games: [boardGame] } : {}));
  const tools = createTools({ api, now: () => NOW, limits: { maxSearches: 5 }, fetchImpl: world.fetchImpl });
  const m = await tools.run('get_matchup', { league: 'nba', gameId: '4001' });
  assert.equal(m.game, 'BOS @ MIL');
  assert.equal((await tools.run('get_matchup', { league: 'nba', gameId: 'zzz' })).available, false);
  assert.match((await tools.run('get_matchup', { league: 'cricket', gameId: '1' })).error, /league must be one of/);
  assert.equal((await tools.run('get_team_stats', { league: 'nba', team: 'MIL' })).team, 'MIL');
  assert.deepEqual(await tools.run('get_betting_splits', { league: 'nba' }), { available: false, hint: R.SPLITS_HINT });
  // closed: all research tools and web_search answer researchClosed; the others keep working
  tools.setResearchOpen(false);
  for (const name of RESEARCH_TOOLS) {
    const r = await tools.run(name, { league: 'nba', gameId: '4001', team: 'MIL', player: 'x', stat: 'points', query: 'q' });
    assert.equal(r.researchClosed, true, name);
    assert.match(r.message, /Decide now/);
  }
  assert.equal(tools.log.searches, 0, 'a closed search is not counted');
  assert.equal((await tools.run('get_board', { league: 'nba' })).league, 'nba');
  assert.equal((await tools.run('get_my_history', {})).available, false);
  tools.setResearchOpen(true);
  assert.equal((await tools.run('get_matchup', { league: 'nba', gameId: '4001' })).game, 'BOS @ MIL');
});

test('get_props registers the players so get_player_trends finds them on the right team', async () => {
  const world = espn();
  const propsGame = { ...boardGame };
  const api = fakeApi((m, p) => {
    if (p.includes('props=1')) return { game: propsGame, props: { open: true, tabs: [{ stat: 'Points', series: 'KXNBAPTS', players: [{ name: 'Giannis Antetokounmpo', team: 'MIL', rows: [{ threshold: 30, strike: 29.5, ticker: 'T-30', yes: { american: -120 }, no: { american: 100 } }] }] }] } };
    return { games: [boardGame] };
  });
  const tools = createTools({ api, now: () => NOW, limits: { maxSearches: 5 }, fetchImpl: world.fetchImpl });
  await tools.run('get_props', { league: 'nba', gameId: '4001' });
  world.calls.length = 0;
  const t = await tools.run('get_player_trends', { league: 'nba', player: 'Giannis Antetokounmpo', stat: 'points', line: 29.5 });
  assert.equal(t.team, 'MIL');
  assert.ok(world.calls.some((c) => c.includes('/teams/2/roster')));
  assert.ok(!world.calls.some((c) => c.includes('/teams/1/roster')), 'only his own roster was read');
});

// ---------- the 75% switch and a full run ----------
const ENV = { AGENT_CLAUDE_BIG_USERNAME: 'claude-big', AGENT_CLAUDE_BIG_PASSWORD: 'hunter2-very-secret', ANTHROPIC_API_KEY: 'sk-ant-api03-SECRETKEYVALUE123', VITE_FIREBASE_API_KEY: 'AIzaSyD-fakeFirebaseWebKey12345', BB_SITE_URL: 'https://bb.example.app/' };
const PRICES = { anthropic: { 'claude-sonnet-5-5': { input: 3, output: 15 }, _search_per_1000: 10 } };
const nbaGame = (id) => ({
  id, league: 'nba', state: 'pre', bettingClosed: false, startTime: new Date(START).toISOString(),
  away: { id: '1', name: 'Boston Celtics', shortName: 'Celtics', abbr: 'BOS' }, home: { id: '2', name: 'Milwaukee Bucks', shortName: 'Bucks', abbr: 'MIL' },
  markets: {
    moneyline: { home: { american: -150, decimal: 1.6667, line: null, source: 'espn' }, away: { american: 130, decimal: 2.3, line: null, source: 'espn' } },
    spread: { home: { american: -110, decimal: 1.9091, line: -3.5, source: 'espn' }, away: { american: -110, decimal: 1.9091, line: 3.5, source: 'espn' } },
    total: { over: { american: -110, decimal: 1.9091, line: 226.5, source: 'espn' }, under: { american: -110, decimal: 1.9091, line: 226.5, source: 'espn' } },
  },
});
function runWorld() {
  const places = [];
  const fetchImpl = async (u, init = {}) => {
    const href = String(u);
    const body = init.body ? JSON.parse(init.body) : null;
    const reply = (status, json) => ({ ok: status < 300, status, json: async () => json });
    if (href.startsWith('https://identitytoolkit.googleapis.com/')) return reply(200, { idToken: 'eyJhbGciOiJSUzI1NiJ9.eyJ1aWQiOiJib3QiLCJ4IjoxfQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ' });
    if (href.includes('/api/board?league=nba')) return reply(200, { games: [nbaGame('4001')] });
    if (href.includes('/api/board?league=')) return reply(200, { games: [] });
    if (href.endsWith('/api/bets') && body.action === 'mine') return reply(200, { balanceCents: 100000, openBets: [], today: { slips: 0, limit: 10 }, ...(body.history ? { history: { available: true, days: 14, bets: [{ id: 'h1', pick: 'Old pick', league: 'nba', odds: -110, stakeCents: 1000, result: 'lost', returnCents: 0, why: 'old', settled: '2026-10-26T05:00:00.000Z' }] } } : {}) });
    if (href.endsWith('/api/bets')) {
      places.push(body);
      return reply(200, { ok: true, balanceCents: 99000, bets: body.legs.map((l, i) => ({ id: `b${places.length}_${i}`, stakeCents: l.stakeCents, combinedAmerican: l.quotedAmerican, potentialPayoutCents: 2 * l.stakeCents, agentWhy: body.why, legs: [{ league: l.league, label: `pick ${l.legId}` }] })), priceChanges: [] });
    }
    return reply(404, { error: { code: 'NOT_FOUND', message: 'no route' } });
  };
  return { fetchImpl, places };
}
function scripted(steps, usage) {
  const seen = [];
  let n = 0;
  return {
    seen, provider: 'anthropic', model: 'claude-sonnet-5-5', retries: 0,
    async turn(results, firstText) {
      seen.push(firstText ? { firstText } : { results });
      const step = steps[Math.min(n, steps.length - 1)];
      n += 1;
      const out = typeof step === 'function' ? step(results, n) : step;
      return { calls: [], text: '', usage: typeof usage === 'function' ? usage(n) : usage ?? { input: 1000, output: 100 }, ...out };
    },
    async search(q) { return { summary: `news ${q}`, sources: [], usage: { input: 10, output: 5 } }; },
  };
}
const call = (name, args = {}, id = `c${Math.random().toString(36).slice(2, 8)}`) => ({ id, name, args });

test('a full mocked run: history first, research tools, two bets with edge-style reasons; the trace shows each research result size', async () => {
  const w = runWorld();
  const espnWorld = espn();
  const model = scripted([
    { calls: [call('get_my_history'), call('get_leagues')] },
    (r) => {
      assert.equal(r[0].output.lost, 1);
      assert.ok(r[1].output.leagues.some((l) => l.league === 'nba'));
      return { calls: [call('get_board', { league: 'nba' })] };
    },
    () => ({ calls: [call('get_matchup', { league: 'nba', gameId: '4001' }), call('get_team_stats', { league: 'nba', team: 'MIL' }), call('get_betting_splits', { league: 'nba' }), call('web_search', { query: 'Bucks injury report' })] }),
    (r) => {
      assert.equal(r[0].output.a.rest, 0);
      assert.equal(r[1].output.team, 'MIL');
      assert.equal(r[2].output.available, false);
      assert.equal(r[3].output.summary, 'news Bucks injury report');
      return { calls: [call('get_board', { league: 'nba' })] };
    },
    (r) => {
      const g = r[0].output.games[0];
      return {
        calls: [
          call('place_bet', { mode: 'singles', legs: [{ pick: g.ml.h.p, stakeCents: 2500 }], why: '62% vs 58% fair: Bucks 7-5 and rested, Celtics on a back-to-back.' }),
          call('place_bet', { mode: 'singles', legs: [{ pick: g.tot.u.p, stakeCents: 1000 }], why: '55% vs 50% fair: both sides slowing down.' }),
        ],
      };
    },
    (r) => {
      assert.equal(r[0].output.placed.length, 1);
      return { text: 'Two bets: Bucks ML and the under.' };
    },
  ]);
  const { summary, text } = await runAgent({ agentId: 'claude-big', env: ENV, fetchImpl: w.fetchImpl, researchFetch: espnWorld.fetchImpl, now: () => NOW, adapter: model, prices: PRICES });
  assert.equal(summary.outcome, 'ran');
  assert.equal(summary.bets.length, 2);
  assert.match(summary.bets[0].why, /vs .*fair/);
  assert.equal(w.places.length, 2);
  assert.match(model.seen[0].firstText, /Start with get_my_history, then get_leagues\./);
  assert.equal(summary.researchClosedAtTurn, 0);
  assert.match(text, /Research calls: 4\b/);
  const researchTurn = summary.trace[2];
  assert.deepEqual(researchTurn.tools.map((t) => t.name), ['get_matchup', 'get_team_stats', 'get_betting_splits', 'web_search']);
  assert.ok(researchTurn.tools.slice(0, 2).every((t) => t.tokens > 50 && t.tokens <= CAP), 'each research result size is in the trace and under the cap');
  assert.match(text, /get_matchup ≈\d+, get_team_stats ≈\d+/);
});

test('75% of the input budget: research closes, the agent is told to decide, and it can still bet; the run ends having decided, not on the cap', async () => {
  const w = runWorld();
  const espnWorld = espn();
  // 120k budget, 10k per turn: the gate is 90k, so the calls of turn 9 (90k used) are the first with research closed
  const research = { calls: [call('get_team_stats', { league: 'nba', team: 'BOS' })] };
  const model = scripted([
    { calls: [call('get_board', { league: 'nba' })] },
    ...Array(7).fill(research),
    (r) => {
      assert.equal(r[0].output.team, 'BOS', 'turn 8 ran at 80k: still open');
      return { calls: [call('get_matchup', { league: 'nba', gameId: '4001' }), call('get_board', { league: 'nba' })] };
    },
    (r) => {
      assert.equal(r[0].output.researchClosed, true);
      assert.match(r[0].output.message, /Decide now/);
      const g = r[1].output.games[0];
      return { calls: [call('place_bet', { mode: 'singles', legs: [{ pick: g.ml.h.p, stakeCents: 1500 }], why: '60% vs 57% fair after the research.' })] };
    },
    { text: 'Decided: one bet.' },
  ], { input: 10_000, output: 100 });
  const { summary, text } = await runAgent({ agentId: 'claude-big', env: { ...ENV, AGENT_MAX_INPUT_TOKENS: '120000', AGENT_MAX_TURNS: '25' }, fetchImpl: w.fetchImpl, researchFetch: espnWorld.fetchImpl, now: () => NOW, adapter: model, prices: PRICES });
  assert.equal(summary.researchClosedAtTurn, 9);
  assert.equal(summary.bets.length, 1);
  assert.match(summary.finalText, /Decided/);
  assert.ok(!/token cap reached/.test(summary.stopReason), summary.stopReason);
  assert.match(text, /research closed after turn 9/);
});
