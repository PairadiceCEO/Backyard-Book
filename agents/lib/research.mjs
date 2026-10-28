// Research tools for the AI agents (0.22.0): what a serious bettor looks at before a bet, read straight from ESPN's public site
// and core APIs (the same family server/ uses) inside the runner on GitHub Actions. No Firestore, no /api, nothing stored.
//
//   matchup(league, gameId)                  form, records, rest, head-to-head, injuries, probables, weather, DraftKings line movement
//   teamStats(league, team)                  offense / defense values and ranks, points for and against, last 10 game totals
//   playerTrends(league, player, stat, line) a player's last-10 game log for a stat, home / away averages, how many went over `line`
//   bettingSplits(league)                    public bets% / money% per side when a permitted source is configured (none is, see below)
//
// Every result is compact JSON (short keys), cached in memory for the run, at most MAX_RESULT_TOKENS (chars / 4), and a source that
// fails or comes back empty gives a safe value (never an exception). All times in the output are Central.
//
// Betting splits: no public source is read. DK Network's terms forbid automated collection ("any software or automated means"),
// and VSiN's splits page loads its data by script from an undocumented endpoint, shows only part of it without VSiN Pro, and its
// terms page could not be read; robots.txt alone is not enough. So bettingSplits answers { available: false, hint } unless a
// `splitsSource` is injected (a permitted feed, or tests). The sharp-signal maths (money% vs bets% gap, reverse line movement) is
// implemented and tested on that interface, so a licensed source can be plugged in later without touching anything else.

import { LEAGUE_CONFIG } from '../../server/leagues.js';
import { compact, estimateTokens, mean, norm, r1, round1 } from './util.mjs';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const CORE = 'https://sports.core.api.espn.com/v2/sports';
const WEB = 'https://site.web.api.espn.com/apis/common/v3/sports';
export const MAX_RESULT_TOKENS = 1500;
const DAY_MS = 24 * 60 * 60 * 1000;
export const SPLITS_HINT = 'use web_search for public and sharp betting splits';
export const SHARP_GAP_POINTS = 15;
const BETS_MAJORITY = 55;
const MOVE_MIN = { spread: 0.5, total: 0.5, ml: 2 }; // points of line, or of implied probability for the moneyline

const centralDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
const centralShort = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'numeric', day: 'numeric' });
const dayNumber = (ms) => Math.round(Date.parse(`${centralDay.format(new Date(ms))}T00:00:00Z`) / DAY_MS);
const mdy = (ms) => centralShort.format(new Date(ms)).replace('/', '-');

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/^\+/, ''));
  return Number.isFinite(n) ? n : null;
};
const scoreOf = (v) => (v && typeof v === 'object' ? num(v.value ?? v.displayValue) : num(v));
const impliedPct = (american) => {
  const a = num(american);
  if (a === null || a === 0) return null;
  return (a < 0 ? -a / (-a + 100) : 100 / (a + 100)) * 100;
};

// ---------- compact result fitting ----------
// Applies the reducers in order until the result is within the token cap; the last resort cuts the result to a notice.
function fit(result, reducers = []) {
  let out = compact(result);
  for (const reduce of reducers) {
    if (estimateTokens(out) <= MAX_RESULT_TOKENS) break;
    reduce(out);
    out = compact(out);
  }
  if (estimateTokens(out) > MAX_RESULT_TOKENS) out = { truncated: true, note: 'Too much data for one result; ask for something narrower.' };
  return out;
}

// ---------- ESPN reading ----------
export function createHttp({ fetchImpl = fetch, timeoutMs = 12_000 } = {}) {
  const cache = new Map();
  return {
    // The parsed JSON, or null for any failure (network, timeout, non-2xx, bad JSON). Cached for the run, failures too.
    getJson(url) {
      if (!cache.has(url)) {
        cache.set(
          url,
          (async () => {
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), timeoutMs);
            try {
              const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: ctl.signal });
              if (!res.ok) return null;
              return await res.json();
            } catch {
              return null;
            } finally {
              clearTimeout(timer);
            }
          })(),
        );
      }
      return cache.get(url);
    },
  };
}

const pathOf = (league) => LEAGUE_CONFIG[league]?.espnPath ?? null;
const sportLeague = (league) => (pathOf(league) ?? '').split('/');

// Season results of one team from its schedule: completed games with scores, oldest first.
export function parseSchedule(json, teamId) {
  const out = [];
  for (const ev of Array.isArray(json?.events) ? json.events : []) {
    const comp = ev?.competitions?.[0];
    const competitors = comp?.competitors ?? [];
    const me = competitors.find((c) => String(c?.team?.id) === String(teamId));
    const opp = competitors.find((c) => c !== me);
    if (!me || !opp) continue;
    const completed = ev?.status?.type?.completed ?? comp?.status?.type?.completed ?? false;
    const pf = scoreOf(me.score);
    const pa = scoreOf(opp.score);
    const date = Date.parse(ev.date ?? comp?.date);
    const type = num(ev?.seasonType?.type ?? ev?.season?.type);
    if (!Number.isFinite(date)) continue;
    out.push({
      id: String(ev.id),
      date,
      type,
      home: me.homeAway === 'home',
      oppId: opp.team?.id ? String(opp.team.id) : null,
      opp: opp.team?.abbreviation ?? opp.team?.shortDisplayName ?? '?',
      completed: Boolean(completed) && pf !== null && pa !== null,
      pf,
      pa,
    });
  }
  return out.sort((a, b) => a.date - b.date);
}

const resultOf = (g) => (g.pf > g.pa ? 'W' : g.pf < g.pa ? 'L' : 'T');
const recordOf = (games) => {
  const w = games.filter((g) => g.pf > g.pa).length;
  const l = games.filter((g) => g.pf < g.pa).length;
  const t = games.length - w - l;
  return t ? `${w}-${l}-${t}` : `${w}-${l}`;
};

// Form numbers from completed games (oldest first) before `beforeMs`.
export function formOf(schedule, beforeMs) {
  const done = schedule.filter((g) => g.completed && g.type !== 1 && g.date < beforeMs);
  const last10 = done.slice(-10);
  const last5 = done.slice(-5);
  const lastGame = done.at(-1);
  return {
    games: done.length,
    rec: recordOf(done),
    hm: recordOf(done.filter((g) => g.home)),
    rd: recordOf(done.filter((g) => !g.home)),
    l10: last10.map((g) => `${mdy(g.date)} ${g.home ? 'vs' : '@'}${g.opp} ${resultOf(g)}${g.pf}-${g.pa}`),
    pf5: round1(mean(last5.map((g) => g.pf))),
    pa5: round1(mean(last5.map((g) => g.pa))),
    pf10: round1(mean(last10.map((g) => g.pf))),
    pa10: round1(mean(last10.map((g) => g.pa))),
    pf: round1(mean(done.map((g) => g.pf))),
    pa: round1(mean(done.map((g) => g.pa))),
    tot10: last10.map((g) => g.pf + g.pa),
    rest: lastGame ? Math.max(0, dayNumber(beforeMs) - dayNumber(lastGame.date) - 1) : null,
  };
}

const STATUS_SHORT = { out: 'out', 'day-to-day': 'dtd', questionable: 'q', doubtful: 'd', probable: 'p', suspension: 'susp', 'injured reserve': 'ir' };
const statusWord = (s) => {
  const k = String(s ?? '').toLowerCase().trim();
  return STATUS_SHORT[k] ?? (k.length > 10 ? k.slice(0, 10) : k);
};
const statusRank = (s) => ({ out: 0, ir: 0, susp: 0, d: 1, q: 2, dtd: 3, p: 4 }[statusWord(s)] ?? 5);

// Injuries from a game summary, per side: ["Name out (ankle)", …], most serious first, at most `max` each.
export function parseInjuries(summary, awayTeam, homeTeam, max = 6) {
  const sides = { a: [], h: [] };
  for (const entry of Array.isArray(summary?.injuries) ? summary.injuries : []) {
    const id = String(entry?.team?.id ?? '');
    const name = norm(entry?.team?.displayName);
    const side = id && id === String(awayTeam.id) ? 'a' : id && id === String(homeTeam.id) ? 'h' : name && name === norm(awayTeam.name) ? 'a' : name && name === norm(homeTeam.name) ? 'h' : null;
    if (!side) continue;
    for (const inj of Array.isArray(entry.injuries) ? entry.injuries : []) {
      const who = inj?.athlete?.displayName ?? inj?.athlete?.shortName;
      if (!who) continue;
      const kind = inj?.details?.type ?? inj?.type?.description;
      sides[side].push({ rank: statusRank(inj.status), text: `${who} ${statusWord(inj.status)}${kind ? ` (${String(kind).slice(0, 14)})` : ''}` });
    }
  }
  return { a: sides.a.sort((x, y) => x.rank - y.rank).slice(0, max).map((x) => x.text), h: sides.h.sort((x, y) => x.rank - y.rank).slice(0, max).map((x) => x.text) };
}

// Probable starters from a list of competitors (ESPN's scoreboard event or the summary header): { a, h } "Name (ERA 3.10 ...)".
export function parseProbables(source) {
  const competitors = Array.isArray(source) ? source : source?.header?.competitions?.[0]?.competitors ?? [];
  const out = {};
  for (const c of competitors) {
    const p = (Array.isArray(c?.probables) ? c.probables : [])[0];
    const who = p?.athlete?.displayName ?? p?.athlete?.fullName;
    if (!who) continue;
    const stat = (p.statistics ?? []).map((x) => (x?.abbreviation && x?.displayValue ? `${x.abbreviation} ${x.displayValue}` : x?.displayValue)).filter(Boolean).slice(0, 3).join(' ');
    out[c.homeAway === 'home' ? 'h' : 'a'] = `${who}${stat ? ` (${stat})` : ''}`;
  }
  return out;
}

// Weather for outdoor leagues: the summary's gameInfo.weather, else the scoreboard event's weather. Indoor venues have none.
export function parseWeather(summary, league, event = null) {
  if (!['nfl', 'mlb', 'ncaaf'].includes(league)) return null;
  const venue = summary?.gameInfo?.venue ?? event?.competitions?.[0]?.venue ?? summary?.header?.competitions?.[0]?.venue;
  if (venue?.indoor === true || event?.competitions?.[0]?.venue?.indoor === true) return null;
  const w = summary?.gameInfo?.weather ?? event?.weather ?? event?.competitions?.[0]?.weather ?? summary?.header?.competitions?.[0]?.weather;
  if (!w) return null;
  const temp = num(w.temperature ?? w.highTemperature);
  const wind = num(w.windSpeed ?? w.gust);
  const rain = num(w.precipitation);
  const text = [temp !== null ? `${temp}F` : null, w.displayValue ?? w.conditionDescription, wind !== null ? `wind ${wind}` : null, rain ? `precip ${rain}%` : null].filter(Boolean).join(' ');
  return text || null;
}

export function parseAts(summary, awayTeam, homeTeam) {
  const out = {};
  for (const entry of Array.isArray(summary?.againstTheSpread) ? summary.againstTheSpread : []) {
    const id = String(entry?.team?.id ?? '');
    const side = id === String(awayTeam.id) ? 'a' : id === String(homeTeam.id) ? 'h' : null;
    if (!side) continue;
    const rows = (Array.isArray(entry.records) ? entry.records : []).map((r) => `${r?.type ?? r?.name ?? r?.abbreviation ?? ''} ${r?.summary ?? r?.displayValue ?? ''}`.trim()).filter((t) => /\d/.test(t)).slice(0, 3);
    if (rows.length) out[side] = rows.join(', ');
  }
  return out;
}

// DraftKings' opening and current numbers from ESPN's core odds feed: { sp: { o, c } (home spread), tot: { o, c }, ml: { h: { o, c }, a: { o, c } } }.
export function parseLineMovement(json) {
  const items = Array.isArray(json?.items) ? json.items : [];
  const dk = items.find((i) => String(i?.provider?.id) === '100' || /draftkings/i.test(i?.provider?.name ?? '')) ?? items[0];
  if (!dk) return null;
  const home = dk.homeTeamOdds ?? {};
  const away = dk.awayTeamOdds ?? {};
  const cur = (o) => o?.current ?? o?.close;
  const pair = (o, c) => (o === null && c === null ? null : { o, c });
  const sp = pair(num(home.open?.pointSpread?.american), num(cur(home)?.pointSpread?.american ?? dk.spread));
  const tot = pair(num(dk.open?.total?.american ?? dk.open?.total?.alternateDisplayValue), num(cur(dk)?.total?.american ?? dk.overUnder));
  const mlH = pair(num(home.open?.moneyLine?.american), num(cur(home)?.moneyLine?.american ?? home.moneyLine));
  const mlA = pair(num(away.open?.moneyLine?.american), num(cur(away)?.moneyLine?.american ?? away.moneyLine));
  const out = compact({ sp, tot, ml: { h: mlH, a: mlA } });
  return Object.keys(out).length ? out : null;
}

// ---------- sharp signals ----------
// splits (per game): { sp: { a: { b, m }, h: { b, m } }, tot: { o, u }, ml: { a, h } } with b = % of bets and m = % of money.
// mv: parseLineMovement output. Flags:
//   "$ ≥ tickets": the money% of a side is at least 15 points above its bets% (money on the side the tickets aren't)
//   "RLM": reverse line movement, the line moved against the side that has most of the bets
export function sharpFlags({ splits, mv, away = 'A', home = 'H' }) {
  const flags = [];
  const label = { a: away, h: home, o: 'over', u: 'under' };
  const markets = { sp: ['a', 'h'], tot: ['o', 'u'], ml: ['a', 'h'] };
  const name = { sp: 'spread', tot: 'total', ml: 'ML' };
  for (const [m, sides] of Object.entries(markets)) {
    for (const s of sides) {
      const x = splits?.[m]?.[s];
      if (x && Number.isFinite(x.b) && Number.isFinite(x.m) && x.m - x.b >= SHARP_GAP_POINTS) flags.push(`${label[s]} ${name[m]}: money ${x.m}% vs bets ${x.b}% (+${r1(x.m - x.b)})`);
    }
  }
  const majority = (m, a, b) => {
    const x = splits?.[m]?.[a]?.b;
    const y = splits?.[m]?.[b]?.b;
    if (Number.isFinite(x) && x >= BETS_MAJORITY && x > (y ?? 0)) return a;
    if (Number.isFinite(y) && y >= BETS_MAJORITY && y > (x ?? 0)) return b;
    return null;
  };
  // Spread: mv.sp is the home spread. A rise (e.g. -7 → -6) is the line moving toward the away side.
  const spMove = mv?.sp && Number.isFinite(mv.sp.o) && Number.isFinite(mv.sp.c) ? mv.sp.c - mv.sp.o : null;
  const spSide = majority('sp', 'a', 'h');
  if (spMove !== null && spSide && Math.abs(spMove) >= MOVE_MIN.spread) {
    const towardAway = spMove > 0;
    if ((spSide === 'h' && towardAway) || (spSide === 'a' && !towardAway)) flags.push(`RLM spread: ${label[spSide]} has ${splits.sp[spSide].b}% of bets but the home line moved ${mv.sp.o} → ${mv.sp.c}`);
  }
  const totMove = mv?.tot && Number.isFinite(mv.tot.o) && Number.isFinite(mv.tot.c) ? mv.tot.c - mv.tot.o : null;
  const totSide = majority('tot', 'o', 'u');
  if (totMove !== null && totSide && Math.abs(totMove) >= MOVE_MIN.total) {
    if ((totSide === 'o' && totMove < 0) || (totSide === 'u' && totMove > 0)) flags.push(`RLM total: ${label[totSide]} has ${splits.tot[totSide].b}% of bets but the total moved ${mv.tot.o} → ${mv.tot.c}`);
  }
  const mlSide = majority('ml', 'a', 'h');
  if (mlSide && mv?.ml) {
    const k = mlSide === 'h' ? 'h' : 'a';
    const o = impliedPct(mv.ml[k]?.o);
    const c = impliedPct(mv.ml[k]?.c);
    if (o !== null && c !== null && o - c >= MOVE_MIN.ml) flags.push(`RLM moneyline: ${label[mlSide]} has ${splits.ml[mlSide].b}% of bets but the price moved ${mv.ml[k].o} → ${mv.ml[k].c}`);
  }
  return flags;
}

// ---------- player stats ----------
const STAT_ALIASES = {
  pts: ['points'], points: ['points'], reb: ['rebounds', 'totalrebounds'], rebounds: ['rebounds', 'totalrebounds'], ast: ['assists'], assists: ['assists'],
  threes: ['threepointfieldgoalsmadethreepointfieldgoalsattempted', 'threepointfieldgoalsmade', '3pt'], '3pm': ['threepointfieldgoalsmadethreepointfieldgoalsattempted', '3pt'], threepointers: ['threepointfieldgoalsmadethreepointfieldgoalsattempted', '3pt'],
  stl: ['steals'], steals: ['steals'], blk: ['blocks'], blocks: ['blocks'], to: ['turnovers'], turnovers: ['turnovers'],
  passingyards: ['passingyards', 'netpassingyards'], passyards: ['passingyards'], rushingyards: ['rushingyards'], receivingyards: ['receivingyards'], receptions: ['receptions'],
  passingtds: ['passingtouchdowns'], passtds: ['passingtouchdowns'], rushingtds: ['rushingtouchdowns'], receivingtds: ['receivingtouchdowns'], completions: ['completions'],
  hits: ['hits'], strikeouts: ['strikeouts', 'k'], ks: ['strikeouts'], totalbases: ['totalbases', 'tb'], homeruns: ['homeruns', 'hr'], rbis: ['rbis', 'rbi'], runs: ['runs'],
  goals: ['goals'], shots: ['shotstotal', 'shots', 'sog'], shotsongoal: ['shotstotal', 'shots', 'sog'], saves: ['saves'], points2: ['points'],
};

const parseCell = (text, made) => {
  const s = String(text ?? '').trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const dash = /^(\d+)-(\d+)$/.exec(s);
  if (dash) return made ? Number(dash[1]) : null;
  const clock = /^(\d+):(\d\d)$/.exec(s);
  if (clock) return Number(clock[1]) + Number(clock[2]) / 60;
  return null;
};

export function findStatColumn(names, labels, displayNames, stat) {
  const q = norm(stat);
  const candidates = [q, ...(STAT_ALIASES[q] ?? [])];
  const cols = names.map((n, i) => ({ i, name: norm(n), label: norm(labels?.[i]), display: norm(displayNames?.[i]) }));
  for (const c of candidates) {
    const exact = cols.find((x) => x.name === c || x.label === c || x.display === c);
    if (exact) return exact.i;
  }
  for (const c of candidates) {
    const loose = cols.find((x) => c.length >= 3 && (x.name.startsWith(c) || x.display.includes(c)));
    if (loose) return loose.i;
  }
  return -1;
}

// A gamelog → rows { date, home, opp, value } newest first, for the stat; null when the stat isn't in the log.
export function parseGamelog(json, stat) {
  if (!json || typeof json !== 'object') return null;
  const meta = json.events && typeof json.events === 'object' ? json.events : {};
  const rows = new Map();
  let found = false;
  const seasons = Array.isArray(json.seasonTypes) ? json.seasonTypes : [];
  for (const st of seasons) {
    if (/pre/i.test(String(st?.displayName ?? st?.name ?? '')) && !/post/i.test(String(st?.displayName ?? st?.name ?? ''))) continue;
    for (const cat of Array.isArray(st?.categories) ? st.categories : []) {
      const names = cat.names ?? json.names ?? [];
      const idx = findStatColumn(names, cat.labels ?? json.labels, cat.displayNames ?? json.displayNames, stat);
      if (idx < 0) continue;
      found = true;
      const made = String(names[idx]).includes('-') || /made/i.test(String(names[idx]));
      for (const ev of Array.isArray(cat.events) ? cat.events : []) {
        const m = meta[ev.eventId];
        const value = parseCell(ev.stats?.[idx], made);
        const date = Date.parse(m?.gameDate);
        if (value === null || !Number.isFinite(date)) continue;
        rows.set(String(ev.eventId), { date, home: m?.atVs !== '@', opp: m?.opponent?.abbreviation ?? m?.opponent?.displayName ?? '?', value });
      }
    }
  }
  if (!found) return null;
  return [...rows.values()].sort((a, b) => b.date - a.date);
}

export function trendsFrom(rows, line) {
  const last10 = rows.slice(0, 10);
  const homeRows = rows.filter((r) => r.home);
  const awayRows = rows.filter((r) => !r.home);
  const L = num(line);
  return {
    n: last10.length,
    avg10: round1(mean(last10.map((r) => r.value))),
    avg: round1(mean(rows.map((r) => r.value))),
    hAvg: round1(mean(homeRows.map((r) => r.value))),
    aAvg: round1(mean(awayRows.map((r) => r.value))),
    over: L === null ? undefined : `${last10.filter((r) => r.value > L).length}/${last10.length} over ${L}`,
    log: last10.map((r) => `${mdy(r.date)} ${r.home ? 'vs' : '@'}${r.opp} ${r1(r.value)}`),
  };
}

const flattenRoster = (json) => {
  const out = [];
  for (const a of Array.isArray(json?.athletes) ? json.athletes : []) {
    if (Array.isArray(a?.items)) out.push(...a.items);
    else out.push(a);
  }
  return out.filter((a) => a?.id && (a.displayName || a.fullName));
};

const nameKey = (n) => norm(String(n ?? '').replace(/\b(jr|sr|ii|iii|iv)\b\.?/gi, ''));

// ---------- the research object ----------
// lookupGame(league, gameId) → the board game ({ id, startTime, away: { id, abbr, name, shortName }, home: {…}, markets }) or null.
// splitsSource(league) → { games: [{ away, home (abbreviations), sp, tot, ml }] } or null; none by default (see the header).
export function createResearch({ fetchImpl = fetch, now = () => new Date(), lookupGame, splitsSource = null, http = createHttp({ fetchImpl }) } = {}) {
  const getJson = (url) => http.getJson(url);
  const playerHints = new Map(); // `${league}|${nameKey}` → team abbreviation, from get_props

  async function teamList(league) {
    const path = pathOf(league);
    if (!path) return [];
    const extra = league === 'ncaaf' ? '&groups=80' : '';
    const json = await getJson(`${SITE}/${path}/teams?limit=500${extra}`);
    const teams = json?.sports?.[0]?.leagues?.[0]?.teams ?? json?.teams ?? [];
    return teams.map((t) => t?.team ?? t).filter((t) => t?.id).map((t) => ({ id: String(t.id), abbr: t.abbreviation ?? null, name: t.displayName ?? t.name ?? '', short: t.shortDisplayName ?? '', nick: t.name ?? '', loc: t.location ?? '' }));
  }

  async function resolveTeam(league, query) {
    const q = norm(query);
    if (!q) return null;
    const teams = await teamList(league);
    const keys = (t) => [t.abbr, t.name, t.short, t.nick, t.loc].map(norm);
    return teams.find((t) => keys(t).includes(q)) ?? teams.find((t) => norm(t.name).includes(q) || norm(t.short).includes(q)) ?? null;
  }

  async function scheduleOf(league, teamId) {
    const path = pathOf(league);
    const [reg, post] = await Promise.all([getJson(`${SITE}/${path}/teams/${teamId}/schedule?seasontype=2`), getJson(`${SITE}/${path}/teams/${teamId}/schedule?seasontype=3`)]);
    const seen = new Set();
    return [...parseSchedule(reg, teamId), ...parseSchedule(post, teamId)].filter((g) => (seen.has(g.id) ? false : seen.add(g.id))).sort((a, b) => a.date - b.date);
  }

  async function lineMovement(league, gameId) {
    const [sport, lg] = sportLeague(league);
    if (!lg) return null;
    return parseLineMovement(await getJson(`${CORE}/${sport}/leagues/${lg}/events/${gameId}/competitions/${gameId}/odds`));
  }

  // The scoreboard event for a game (ESPN dates the scoreboard in Eastern time): probable starters and weather live there.
  const etDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  async function scoreboardEvent(league, gameId, startMs) {
    if (!['mlb', 'nhl', 'nfl', 'ncaaf'].includes(league) || !Number.isFinite(startMs)) return null;
    const extra = league === 'ncaaf' ? '&groups=80&limit=300' : '';
    const json = await getJson(`${SITE}/${pathOf(league)}/scoreboard?dates=${etDay.format(new Date(startMs)).replaceAll('-', '')}${extra}`);
    return (Array.isArray(json?.events) ? json.events : []).find((e) => String(e?.id) === String(gameId)) ?? null;
  }

  // Standings give one-call league ranks for points scored and allowed per game: { teamId: { pf, pa, of } }, 1 = best.
  async function standingsRanks(league) {
    const json = await getJson(`https://site.api.espn.com/apis/v2/sports/${pathOf(league)}/standings`);
    const entries = [];
    const walk = (node) => {
      for (const e of Array.isArray(node?.standings?.entries) ? node.standings.entries : []) entries.push(e);
      for (const c of Array.isArray(node?.children) ? node.children : []) walk(c);
    };
    walk(json);
    const rows = entries.map((e) => {
      const st = Object.fromEntries((e.stats ?? []).map((x) => [x.name, num(x.value)]));
      const gp = (st.wins ?? 0) + (st.losses ?? 0) + (st.ties ?? 0) + (st.otLosses ?? 0);
      const pf = st.avgPointsFor ?? (st.pointsFor !== null && st.pointsFor !== undefined && gp ? st.pointsFor / gp : null);
      const pa = st.avgPointsAgainst ?? (st.pointsAgainst !== null && st.pointsAgainst !== undefined && gp ? st.pointsAgainst / gp : null);
      return { id: String(e.team?.id ?? ''), pf, pa };
    }).filter((r) => r.id && r.pf !== null && r.pa !== null);
    const out = {};
    for (const r of rows) out[r.id] = { pf: 1 + rows.filter((x) => x.pf > r.pf).length, pa: 1 + rows.filter((x) => x.pa < r.pa).length, of: rows.length };
    return out;
  }

  async function splitsFor(league) {
    if (typeof splitsSource !== 'function') return null;
    try {
      const raw = await splitsSource(league);
      return Array.isArray(raw?.games) ? raw : null;
    } catch {
      return null;
    }
  }

  const unavailable = (why) => ({ available: false, error: why });

  return {
    notePlayer(league, name, team) {
      if (name && team) playerHints.set(`${league}|${nameKey(name)}`, String(team));
    },

    async matchup(league, gameId) {
      const path = pathOf(league);
      if (!path) return unavailable(`league must be one of ${Object.keys(LEAGUE_CONFIG).join(', ')}`);
      const game = await lookupGame?.(league, gameId);
      if (!game) return unavailable('Unknown game: use a gameId from get_board.');
      const start = Date.parse(game.startTime);
      const [awaySched, homeSched, summary, mv] = await Promise.all([
        game.away?.id ? scheduleOf(league, game.away.id) : [],
        game.home?.id ? scheduleOf(league, game.home.id) : [],
        getJson(`${SITE}/${path}/summary?event=${encodeURIComponent(gameId)}`),
        lineMovement(league, gameId),
      ]);
      const needsBoard = !Object.keys(parseProbables(summary)).length && ['mlb', 'nhl'].includes(league);
      const needsWeather = !parseWeather(summary, league) && ['nfl', 'mlb', 'ncaaf'].includes(league);
      const event = needsBoard || needsWeather ? await scoreboardEvent(league, gameId, start) : null;
      const a = formOf(awaySched, start);
      const h = formOf(homeSched, start);
      const side = (f) => ({ rec: f.rec, hm: f.hm, rd: f.rd, l10: f.l10, pf5: f.pf5, pa5: f.pa5, pf10: f.pf10, pa10: f.pa10, rest: f.rest });
      const awayTeam = { id: game.away?.id, name: game.away?.name };
      const homeTeam = { id: game.home?.id, name: game.home?.name };
      const inj = parseInjuries(summary, awayTeam, homeTeam);
      const h2h = homeSched
        .filter((g) => g.completed && g.type !== 1 && String(g.oppId) === String(game.away?.id) && g.date < start)
        .slice(-3)
        .map((g) => `${mdy(g.date)} ${g.home ? game.home?.abbr : game.away?.abbr} ${g.pf}-${g.pa} ${g.home ? game.away?.abbr : game.home?.abbr}`);
      const splits = await splitsFor(league);
      const sg = splits?.games?.find((x) => norm(x.away) === norm(game.away?.abbr) && norm(x.home) === norm(game.home?.abbr));
      const flags = sg ? sharpFlags({ splits: sg, mv, away: game.away?.abbr, home: game.home?.abbr }) : undefined;
      const result = {
        gameId: String(gameId),
        game: `${game.away?.abbr ?? 'A'} @ ${game.home?.abbr ?? 'H'}`,
        a: side(a),
        h: side(h),
        h2h,
        inj,
        prob: Object.keys(parseProbables(summary)).length ? parseProbables(summary) : parseProbables(event?.competitions?.[0]?.competitors ?? []),
        wx: parseWeather(summary, league, event),
        ats: parseAts(summary, awayTeam, homeTeam),
        mv: mv ?? undefined,
        sharp: flags,
        keys: 'a away, h home. rec season record, hm home record, rd road record, l10 last 10 results (oldest first), pf5/pa5/pf10/pa10 points (runs, goals) for / against per game over the last 5 / 10, rest = days off since the last game (0 = back-to-back), h2h this season (home team first), inj injuries (out, dtd, q = questionable), mv DraftKings opening (o) vs current (c): sp home spread, tot total, ml moneylines, sharp = money / reverse-line-movement flags (only with a splits source).',
      };
      if (!awaySched.length && !homeSched.length && !summary && !mv && !event) return unavailable('ESPN returned no data for this game right now.');
      return fit(result, [
        (o) => { if (o.ats) delete o.ats; },
        (o) => { if (o.h2h) o.h2h = o.h2h.slice(-1); },
        (o) => { for (const k of ['a', 'h']) if (o[k]?.l10) o[k].l10 = o[k].l10.slice(-6); },
        (o) => { if (o.inj) o.inj = { a: (o.inj.a ?? []).slice(0, 4), h: (o.inj.h ?? []).slice(0, 4) }; },
        (o) => { delete o.keys; },
        (o) => { for (const k of ['a', 'h']) if (o[k]) delete o[k].l10; },
      ]);
    },

    async teamStats(league, team) {
      const path = pathOf(league);
      if (!path) return unavailable(`league must be one of ${Object.keys(LEAGUE_CONFIG).join(', ')}`);
      const t = await resolveTeam(league, team);
      if (!t) return unavailable(`No ${league} team matches "${team}". Use the abbreviation from get_board.`);
      const [stats, sched, ranks] = await Promise.all([getJson(`${SITE}/${path}/teams/${t.id}/statistics`), scheduleOf(league, t.id), standingsRanks(league)]);
      const f = formOf(sched, now().getTime() + 365 * DAY_MS);
      // ESPN's team statistics come in categories (general / offensive / defensive); take per-game and percentage stats first.
      const pick = (re) => {
        const rows = [];
        for (const cat of (stats?.results?.stats?.categories ?? stats?.stats?.categories ?? [])) {
          if (!re.test(String(cat?.name ?? ''))) continue;
          for (const x of Array.isArray(cat?.stats) ? cat.stats : []) {
            const value = num(x?.perGameValue ?? x?.value);
            if (value === null) continue;
            rows.push({ k: x.abbreviation ?? x.shortDisplayName ?? x.name, name: String(x.name ?? ''), v: r1(value) });
          }
        }
        const score = (x) => (/^avg|pergame|pct|percent|rate|efficiency/i.test(x.name) ? 0 : 1);
        return rows.sort((p, q) => score(p) - score(q)).slice(0, 6).map(({ k, v }) => ({ k, v }));
      };
      const off = pick(/offens|general|scoring|batting|passing|rushing|attack/i);
      const def = pick(/defens|pitching|goalie|goalkeeping/i);
      const rk = ranks[t.id];
      if (!f.games && !off.length && !def.length && !rk) return unavailable('ESPN returned no stats for this team right now.');
      const result = {
        team: t.abbr ?? t.name,
        name: t.short || t.name,
        gp: f.games,
        pf: f.pf,
        pa: f.pa,
        pf10: f.pf10,
        pa10: f.pa10,
        rk: rk ? { pf: rk.pf, pa: rk.pa, of: rk.of } : undefined,
        tot10: f.tot10,
        avgTot10: round1(mean(f.tot10)),
        off,
        def,
        keys: 'pf / pa points (runs, goals) for / against per game this season and over the last 10; rk league rank (1 = best) out of "of" teams for scoring (pf) and for allowing points (pa); tot10 the last 10 game totals (compare with today\'s total line); off / def ESPN team stats: k name, v value (per game or percentage).',
      };
      return fit(result, [(o) => { o.off = (o.off ?? []).slice(0, 4); o.def = (o.def ?? []).slice(0, 4); }, (o) => { delete o.keys; }, (o) => { delete o.off; delete o.def; }]);
    },

    async playerTrends(league, player, stat, line) {
      const path = pathOf(league);
      if (!path) return unavailable(`league must be one of ${Object.keys(LEAGUE_CONFIG).join(', ')}`);
      const key = nameKey(player);
      if (!key || !stat) return unavailable('Give a player name (as in get_props) and a stat.');
      // The player's team: from get_props when seen there, else search the rosters of the teams that play soon.
      const hinted = playerHints.get(`${league}|${key}`);
      let teams = [];
      if (hinted) {
        const t = await resolveTeam(league, hinted);
        if (t) teams = [t];
      }
      if (!teams.length) teams = (await teamList(league)).slice(0, 40);
      let found = null;
      for (const t of teams) {
        const athletes = flattenRoster(await getJson(`${SITE}/${path}/teams/${t.id}/roster`));
        const a = athletes.find((x) => nameKey(x.displayName) === key || nameKey(x.fullName) === key);
        if (a) {
          found = { id: String(a.id), name: a.displayName ?? a.fullName, team: t.abbr ?? t.name };
          break;
        }
        if (hinted) break;
      }
      if (!found) return unavailable(`No ${league} player matches "${player}". Use the name exactly as get_props shows it.`);
      const rows = parseGamelog(await getJson(`${WEB}/${path}/athletes/${found.id}/gamelog`), stat);
      if (rows === null) return unavailable(`ESPN has no "${stat}" game log for ${found.name}.`);
      if (!rows.length) return { player: found.name, team: found.team, stat, n: 0, note: 'No games with this stat yet this season.' };
      const t = trendsFrom(rows, line);
      return fit({ player: found.name, team: found.team, stat, line: num(line) ?? undefined, ...t, keys: 'avg10 / avg last 10 / season average, hAvg / aAvg home / away averages, over = games over the line in the last 10, log newest first (date vs home / @ away, opponent, value).' }, [(o) => { o.log = (o.log ?? []).slice(0, 6); }, (o) => { delete o.keys; }]);
    },

    async bettingSplits(league, games = []) {
      const splits = await splitsFor(league);
      if (!splits) return { available: false, hint: SPLITS_HINT };
      const out = [];
      for (const g of games.slice(0, 30)) {
        const sg = splits.games.find((x) => norm(x.away) === norm(g.away?.abbr) && norm(x.home) === norm(g.home?.abbr));
        if (!sg) continue;
        const mv = await lineMovement(league, g.id);
        out.push({ gameId: String(g.id), a: g.away?.abbr, h: g.home?.abbr, sp: sg.sp, tot: sg.tot, ml: sg.ml, sharp: sharpFlags({ splits: sg, mv, away: g.away?.abbr, home: g.home?.abbr }) });
      }
      if (!out.length) return { available: true, games: [], note: 'No splits for the games on this board yet.' };
      return fit({ available: true, games: out, keys: 'Per market side b = % of bets, m = % of money (sp spread a / h, tot o / u, ml a / h). sharp = flags worth a look.' }, [(o) => { o.games = o.games.slice(0, 10); }, (o) => { o.games = o.games.slice(0, 5); }]);
    },
  };
}
