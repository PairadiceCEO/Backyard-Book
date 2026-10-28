// The agent's tools (0.21.0). The same for every provider; each runs against our own /api with the agent's ID token, so an
// agent can do nothing a player can't. Picks are shown to the model with short ids ("p7"); place_bet takes those ids and
// this file builds exactly the legs the app's bet slip would send (src/components/BetSlip.jsx), so the model can't send a
// malformed or invented market.
//
//   get_leagues()              leagues with games not started yet: upcoming count, how many start within 36 h, how many have Kalshi
//   get_board(league)          main lines (DraftKings, or Kalshi where DraftKings has none) for games not started yet
//   get_game(league, gameId)   alternate spreads and totals (Kalshi), compared with the DraftKings main line
//   get_props(league, gameId)  player props (Kalshi, pre-game only)
// 0.21.2: results are compact (short keys, no pretty-printing, no-vig fair probabilities worked out here) so a board costs about
// 2-3k tokens instead of 10-15k. Keys are explained once in each result's "keys" note.
//   get_my_bets()              balance, open bets, today's slips   (/api/bets action "mine")
//   place_bet({ mode, legs: [{ pick, stakeCents }], stakeCents, why })   /api/bets place; LINE_CHANGED / ODDS_CHANGED come back
//                              to the model with the new price (the catalog is updated, nothing is re-sent automatically)
//   web_search(query)          the provider's own search, at most N per run (the runner counts them)
// 0.22.0: research tools (agents/lib/research.mjs, ESPN public data, nothing stored), each result at most ~1,500 tokens:
//   get_matchup(league, gameId)                  form, records, rest, head-to-head, injuries, probables, weather, DraftKings line movement
//   get_team_stats(league, team)                 offense / defense values and ranks, points for and against, last 10 game totals
//   get_player_trends(league, player, stat, line?)  last-10 game log of a stat, home / away averages, games over the line
//   get_betting_splits(league)                   public bets% / money% with sharp flags, or { available: false, hint } (see research.mjs)
//   get_my_history()                             the agent's own settled bets of the last 14 days (/api/bets action "mine" with history)
// Once the runner closes research (75% of the input budget used) the research tools and web_search answer researchClosed and the
// agent has to decide; get_board / get_game / get_props / get_my_bets / get_my_history / place_bet keep working.

import { randomUUID } from 'node:crypto';
import { createResearch } from './research.mjs';
import { estimateTokens, r1 } from './util.mjs';

export { estimateTokens };

export const LEAGUES = ['nfl', 'nba', 'mlb', 'nhl', 'ncaaf'];
const TOO_SOON_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BOARD_GAMES = 30;
const MAX_PROP_PLAYERS = 25;
const hasKalshi = (g) => Boolean(g.kalshi);
export const RESEARCH_TOOLS = ['get_matchup', 'get_team_stats', 'get_player_trends', 'get_betting_splits', 'web_search'];
export const RESEARCH_CLOSED_MESSAGE = 'Research budget used (75%). Decide now: place_bet for the candidates that clear the edge, or pass and say why. get_board, get_game, get_props, get_my_bets, get_my_history and place_bet still work.';
const HISTORY_SHOWN = 25;

export function toolDefs({ maxSearches } = {}) {
  return [
  {
    name: 'get_leagues',
    description: 'Which leagues have games that have not started yet: how many are upcoming, how many start within 36 hours and how many have a Kalshi price. Call this first.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_board',
    description: "One league's upcoming games with their main lines: moneyline (ml), spread (sp) and total (tot), each side with a pick id, American odds, the no-vig fair probability and the line. Games starting within 10 minutes are left out.",
    parameters: { type: 'object', properties: { league: { type: 'string', enum: LEAGUES } }, required: ['league'] },
  },
  {
    name: 'get_game',
    description: "One game's alternate spreads and totals (Kalshi prices) as compact rows with pick ids and fair probabilities, plus DraftKings' main line and the gap to Kalshi at that line.",
    parameters: { type: 'object', properties: { league: { type: 'string', enum: LEAGUES }, gameId: { type: 'string' } }, required: ['league', 'gameId'] },
  },
  {
    name: 'get_props',
    description: "One game's player props (Kalshi, pre-game only): for each stat and player, thresholds with yes / no picks, odds and fair probabilities.",
    parameters: { type: 'object', properties: { league: { type: 'string', enum: LEAGUES }, gameId: { type: 'string' } }, required: ['league', 'gameId'] },
  },
  {
    name: 'get_my_bets',
    description: 'Your balance, your open bets and how many bet slips you have placed today (of 10).',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_matchup',
    description: "Research one game: both teams' last-10 results, season / home / road records, points (runs, goals) for and against over the last 5 and 10, rest days, head-to-head this season, injuries, probable starters, weather and the DraftKings line movement (opening vs current), with sharp flags when splits exist.",
    parameters: { type: 'object', properties: { league: { type: 'string', enum: LEAGUES }, gameId: { type: 'string' } }, required: ['league', 'gameId'] },
  },
  {
    name: 'get_team_stats',
    description: "One team's offense and defense: per-game values and league ranks, points for and against, and the last 10 game totals to compare with a total line.",
    parameters: { type: 'object', properties: { league: { type: 'string', enum: LEAGUES }, team: { type: 'string', description: 'Abbreviation or name, as on the board.' } }, required: ['league', 'team'] },
  },
  {
    name: 'get_player_trends',
    description: "A player's last-10 game log for one stat (home / away, opponent), season average, home vs away averages and, with line, how many of the last 10 went over it. Use the player's name exactly as get_props shows it.",
    parameters: { type: 'object', properties: { league: { type: 'string', enum: LEAGUES }, player: { type: 'string' }, stat: { type: 'string', description: 'e.g. points, rebounds, assists, threes, passing yards, receptions, strikeouts, hits, shots.' }, line: { type: 'number', description: 'The threshold to count games over.' } }, required: ['league', 'player', 'stat'] },
  },
  {
    name: 'get_betting_splits',
    description: "Public betting splits (% of bets and % of money per side) with sharp flags (money 15+ points above bets, reverse line movement). Says available: false when no permitted source exists; then use web_search.",
    parameters: { type: 'object', properties: { league: { type: 'string', enum: LEAGUES } }, required: ['league'] },
  },
  {
    name: 'get_my_history',
    description: 'Your settled bets of the last 14 days (pick, odds, stake, result, your reason) with a won / lost summary: what has been working and what has not.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'place_bet',
    description:
      'Place singles (each leg its own bet with its own stakeCents) or one parlay (2+ legs, one stakeCents). Use pick ids from the other tools. stakeCents is in cents (500 = $5.00), at least 100, at most 5% of your balance per slip. why: one or two sentences with your estimated probability.',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['singles', 'parlay'] },
        legs: {
          type: 'array',
          items: { type: 'object', properties: { pick: { type: 'string' }, stakeCents: { type: 'integer' } }, required: ['pick'] },
        },
        stakeCents: { type: 'integer', description: 'The parlay stake (parlay mode only).' },
        why: { type: 'string', description: 'One or two sentences: your estimated probability and the reason.' },
      },
      required: ['mode', 'legs', 'why'],
    },
  },
  {
    name: 'web_search',
    description: `Search the web (news, injuries, lineups, weather, form). ${Number.isFinite(maxSearches) ? `At most ${maxSearches} searches in a session` : 'A limited number of searches per session'}; returns a short summary with sources.`,
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  ];
}
export const TOOL_DEFS = toolDefs();

const centralFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export function centralTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${centralFmt.format(d)} CT`;
}

// Implied probability (0..1) of American odds, vig included.
function impl(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || a === 0) return null;
  return a < 0 ? -a / (-a + 100) : 100 / (a + 100);
}

// No-vig fair probabilities (percent, one decimal) of the two sides of one market: each side's implied probability divided by
// their sum. The second is 100 minus the first, so the pair always adds up to exactly 100.0.
export function fairPair(americanA, americanB) {
  const pa = impl(americanA);
  const pb = impl(americanB);
  if (pa === null || pb === null) return [null, null];
  const fa = r1((pa / (pa + pb)) * 100);
  return [fa, r1(100 - fa)];
}

// The tools' state and executor. api: { get(path), post(path, body) } that throw { code, message, status, details }.
export function createTools({ api, now = () => new Date(), search, limits, fetchImpl, splitsSource = null, research: researchOverride }) {
  let researchOpen = true;
  const picks = new Map(); // id → { leg, label, game, start }
  let nextPick = 1;
  const boards = new Map();
  const log = { bets: [], refusals: [], searches: 0, searchFailures: 0, toolErrors: 0 };

  // Registers a pick and returns its id ("p7"), or null when the quote has no usable American price.
  function addPick(game, marketType, selection, quote, extra = {}) {
    if (!quote || !Number.isInteger(quote.american)) return null;
    const id = `p${nextPick++}`;
    const kalshi = quote.source === 'kalshi' && quote.ref?.ticker ? { kalshiTicker: quote.ref.ticker, kalshiSide: quote.ref.side } : {};
    picks.set(id, {
      // legId = the pick id: the server echoes it in LINE_CHANGED / ODDS_CHANGED, so a moved price maps back to its pick.
      leg: { legId: id, league: game.league, gameId: game.id, marketType, selection, line: quote.line ?? null, quotedAmerican: quote.american, ...kalshi, ...extra.leg },
      label: extra.label ?? describePick(game, marketType, selection, quote.line),
      game: `${game.away?.shortName ?? 'Away'} @ ${game.home?.shortName ?? 'Home'}`,
      league: game.league,
      start: game.startTime,
    });
    return id;
  }

  // One side as the model sees it: { p pick id, o American odds, f no-vig fair %, l line, s "k" when the price is Kalshi's }.
  const sideOut = (id, quote, fair, extra = {}) => {
    if (!id) return null;
    const out = { p: id, o: quote.american };
    if (fair !== null && fair !== undefined) out.f = fair;
    if (quote.line !== null && quote.line !== undefined) out.l = quote.line;
    if (quote.source === 'kalshi') out.s = 'k';
    return { ...out, ...extra };
  };

  // Two opposite sides of one market, each with its pick and the pair's no-vig fair probability.
  function pairOut(game, marketType, selA, qa, selB, qb) {
    const ida = addPick(game, marketType, selA, qa);
    const idb = addPick(game, marketType, selB, qb);
    const [fa, fb] = ida && idb ? fairPair(qa.american, qb.american) : [null, null];
    return [sideOut(ida, qa, fa), sideOut(idb, qb, fb)];
  }

  function describePick(game, marketType, selection, line) {
    const team = selection === 'home' ? game.home?.shortName : game.away?.shortName;
    if (marketType === 'moneyline') return `${team} moneyline`;
    if (marketType === 'spread') return `${team} ${line > 0 ? '+' : ''}${line}`;
    if (marketType === 'total') return `${selection === 'over' ? 'Over' : 'Under'} ${line}`;
    return `${marketType} ${selection}`;
  }

  // The board game with this id (any state), for the research tools.
  async function lookupGame(league, gameId) {
    if (!LEAGUES.includes(league)) return null;
    try {
      const b = await board(league);
      return (b.games ?? []).find((g) => String(g.id) === String(gameId)) ?? null;
    } catch {
      return null;
    }
  }
  const research = researchOverride ?? createResearch({ fetchImpl, now, lookupGame, splitsSource });

  const upcoming = (games) => games.filter((g) => g.state === 'pre' && !g.bettingClosed && new Date(g.startTime).getTime() - now().getTime() > TOO_SOON_MS);

  async function board(league) {
    if (!boards.has(league)) boards.set(league, await api.get(`/api/board?league=${encodeURIComponent(league)}`));
    return boards.get(league);
  }

  const handlers = {
    async get_leagues() {
      const out = [];
      for (const league of LEAGUES) {
        try {
          const b = await board(league);
          const games = upcoming(b.games ?? []);
          const soon = games.filter((g) => new Date(g.startTime).getTime() - now().getTime() < 1.5 * DAY_MS);
          if (games.length) out.push({ league, upcoming: games.length, within36h: soon.length, withKalshi: games.filter(hasKalshi).length, first: centralTime(games[0].startTime) });
        } catch (err) {
          out.push({ league, error: err.message });
        }
      }
      return { now: centralTime(now().toISOString()), leagues: out };
    },

    async get_board({ league }) {
      if (!LEAGUES.includes(league)) return { error: `league must be one of ${LEAGUES.join(', ')}` };
      const b = await board(league);
      const all = upcoming(b.games ?? []);
      const games = all.slice(0, MAX_BOARD_GAMES);
      return {
        league,
        keys: 'Per game: gameId, t start (CT), in minutes to start, a/h away/home abbreviation, an/hn names, k=1 when Kalshi prices it (see get_game). Markets ml moneyline, sp spread, tot total (o over, u under; h home, a away). Per side: p pick id for place_bet, o American odds, f no-vig fair % (both sides add to 100), l line, s "k" if the price is Kalshi (else DraftKings).',
        games: games.map((g) => {
          const m = g.markets ?? {};
          const [mlH, mlA] = pairOut(g, 'moneyline', 'home', m.moneyline?.home, 'away', m.moneyline?.away);
          const [spH, spA] = pairOut(g, 'spread', 'home', m.spread?.home, 'away', m.spread?.away);
          const [tO, tU] = pairOut(g, 'total', 'over', m.total?.over, 'under', m.total?.under);
          if (tU) delete tU.l; // both sides share the line: it is on the over
          const row = {
            gameId: g.id,
            t: centralTime(g.startTime),
            in: Math.round((new Date(g.startTime).getTime() - now().getTime()) / 60000),
            a: g.away?.abbr ?? g.away?.shortName,
            an: g.away?.shortName,
            h: g.home?.abbr ?? g.home?.shortName,
            hn: g.home?.shortName,
          };
          if (hasKalshi(g)) row.k = 1;
          if (mlH || mlA) row.ml = { h: mlH, a: mlA };
          if (spH || spA) row.sp = { h: spH, a: spA };
          if (tO || tU) row.tot = { o: tO, u: tU };
          return row;
        }),
        ...(all.length > games.length ? { more: all.length - games.length } : {}),
      };
    },

    async get_game({ league, gameId }) {
      const d = await api.get(`/api/board?league=${encodeURIComponent(league)}&game=${encodeURIComponent(gameId)}`);
      const g = { ...d.game, league };
      if (!upcoming([g]).length) return { error: 'This game has started or starts within 10 minutes: AI players bet pre-game only.' };
      const lad = d.ladders ?? { spreads: { home: [], away: [] }, totals: [] };
      const m = g.markets ?? {};
      // DraftKings' main line and its no-vig fair probabilities: the yardstick for Kalshi's alternate rows at the same line.
      const dkOnly = (q) => (q && q.source === 'espn' ? q : null);
      const [dkSpH, dkSpA] = dkOnly(m.spread?.home) && dkOnly(m.spread?.away) ? fairPair(m.spread.home.american, m.spread.away.american) : [null, null];
      const [dkTotO, dkTotU] = dkOnly(m.total?.over) && dkOnly(m.total?.under) ? fairPair(m.total.over.american, m.total.under.american) : [null, null];
      const dk = {};
      if (dkSpH !== null) dk.sp = { h: { l: m.spread.home.line, o: m.spread.home.american, f: dkSpH }, a: { l: m.spread.away.line, o: m.spread.away.american, f: dkSpA } };
      if (dkTotO !== null) dk.tot = { l: m.total.over.line, o: { o: m.total.over.american, f: dkTotO }, u: { o: m.total.under.american, f: dkTotU } };
      if (dkOnly(m.moneyline?.home) && dkOnly(m.moneyline?.away)) {
        const [fh, fa] = fairPair(m.moneyline.home.american, m.moneyline.away.american);
        dk.ml = { h: { o: m.moneyline.home.american, f: fh }, a: { o: m.moneyline.away.american, f: fa } };
      }
      const gap = (k, base) => (k === null || k === undefined || base === null || base === undefined ? undefined : { d: r1(k - base) });

      // Spread rows: home at line L pairs with away at -L (the two sides of one Kalshi market).
      const awayByLine = new Map((lad.spreads?.away ?? []).map((q) => [q.line, q]));
      const homeByLine = new Map((lad.spreads?.home ?? []).map((q) => [q.line, q]));
      const spreadRows = (side, own, other, dkFair, dkLine) =>
        own.map((q) => {
          const id = addPick(g, 'spread', side, q);
          const opp = other.get(-q.line);
          const k = id && opp ? fairPair(q.american, opp.american)[0] : null;
          return sideOut(id, q, k, q.line === dkLine ? gap(k, dkFair) : {});
        }).filter(Boolean);
      const totals = (lad.totals ?? []).map((row) => {
        const idO = addPick(g, 'total', 'over', row.over);
        const idU = addPick(g, 'total', 'under', row.under);
        const [kO, kU] = idO && idU ? fairPair(row.over.american, row.under.american) : [null, null];
        const same = dkTotO !== null && row.line === m.total.over.line;
        return { l: row.line, o: sideOut(idO, { ...row.over, line: null }, kO, same ? gap(kO, dkTotO) : {}), u: sideOut(idU, { ...row.under, line: null }, kU, same ? gap(kU, dkTotU) : {}) };
      }).filter((r) => r.o || r.u);
      return {
        gameId,
        game: `${g.away?.abbr ?? g.away?.shortName} @ ${g.home?.abbr ?? g.home?.shortName}`,
        t: centralTime(g.startTime),
        keys: 'dk = DraftKings main line (o odds, f no-vig fair %). alt = Kalshi alternate rows: sp.h / sp.a spreads by line l, tot rows by line l with o over / u under. Per side: p pick id, o American odds, f Kalshi no-vig fair % (when both sides exist), d = f minus the DraftKings fair % at the same line (points).',
        dk,
        alt: {
          sp: { h: spreadRows('home', lad.spreads?.home ?? [], awayByLine, dkSpH, dkOnly(m.spread?.home)?.line), a: spreadRows('away', lad.spreads?.away ?? [], homeByLine, dkSpA, dkOnly(m.spread?.away)?.line) },
          tot: totals,
        },
        props: (d.propsCount ?? 0) > 0,
      };
    },

    async get_props({ league, gameId }) {
      const d = await api.get(`/api/board?league=${encodeURIComponent(league)}&game=${encodeURIComponent(gameId)}&props=1`);
      const g = { ...d.game, league };
      if (!d.props?.open) return { open: false, reason: d.props?.reason ?? 'No props.' };
      for (const tab of d.props.tabs ?? []) for (const p of tab.players.slice(0, MAX_PROP_PLAYERS)) research.notePlayer(league, p.name, p.team);
      return {
        gameId,
        game: `${g.away?.abbr ?? g.away?.shortName} @ ${g.home?.abbr ?? g.home?.shortName}`,
        keys: 'Per stat: players (n name, t team) with rows by threshold at (the stat reaches at least that number): y yes (over) side, n no side. Per side: p pick id, o American odds, f no-vig fair % (when both sides exist).',
        props: (d.props.tabs ?? []).map((tab) => ({
          stat: tab.stat,
          players: tab.players.slice(0, MAX_PROP_PLAYERS).map((p) => ({
            n: p.name,
            t: p.team,
            r: p.rows.map((row) => {
              const make = (side) => {
                const q = row[side];
                if (!q) return null;
                const prop = { series: tab.series, stat: tab.stat, anytime: tab.anytime, player: p.name, team: p.team, threshold: row.threshold };
                const quote = { ...q, line: row.strike, ref: { ticker: row.ticker, side } };
                return { id: addPick(g, 'prop', side, quote, { leg: { playerName: p.name }, label: `${p.name} ${side === 'yes' ? `${row.threshold}+` : `under ${row.threshold}`} ${tab.stat}`, prop }), q };
              };
              const y = make('yes');
              const n = make('no');
              const [fy, fn] = y?.id && n?.id ? fairPair(y.q.american, n.q.american) : [null, null];
              const side = (x, f) => (x?.id ? { p: x.id, o: x.q.american, ...(f !== null ? { f } : {}) } : undefined);
              return { at: row.threshold, y: side(y, fy), n: side(n, fn) };
            }),
          })),
        })),
      };
    },

    async get_my_bets() {
      return api.post('/api/bets', { action: 'mine' });
    },

    async get_matchup({ league, gameId }) {
      if (!LEAGUES.includes(league)) return { error: `league must be one of ${LEAGUES.join(', ')}` };
      return research.matchup(league, String(gameId ?? ''));
    },

    async get_team_stats({ league, team }) {
      if (!LEAGUES.includes(league)) return { error: `league must be one of ${LEAGUES.join(', ')}` };
      return research.teamStats(league, team);
    },

    async get_player_trends({ league, player, stat, line }) {
      if (!LEAGUES.includes(league)) return { error: `league must be one of ${LEAGUES.join(', ')}` };
      return research.playerTrends(league, player, stat, line);
    },

    async get_betting_splits({ league }) {
      if (!LEAGUES.includes(league)) return { error: `league must be one of ${LEAGUES.join(', ')}` };
      let games = [];
      try {
        games = upcoming((await board(league)).games ?? []);
      } catch {
        games = [];
      }
      return research.bettingSplits(league, games);
    },

    async get_my_history() {
      const r = await api.post('/api/bets', { action: 'mine', history: true });
      const h = r?.history;
      if (!h?.available) return { available: false, note: h?.reason ?? 'History is not available yet.' };
      const bets = h.bets ?? [];
      const won = bets.filter((b) => b.result === 'won');
      const lost = bets.filter((b) => b.result === 'lost');
      const staked = bets.reduce((n, b) => n + (b.stakeCents ?? 0), 0);
      const returned = bets.reduce((n, b) => n + (b.returnCents ?? 0), 0);
      return {
        days: h.days,
        n: bets.length,
        won: won.length,
        lost: lost.length,
        stakedCents: staked,
        returnedCents: returned,
        keys: 'bets newest first: pick, league, odds, stakeCents, result (won, lost, push, void), returnCents, why (your earlier reason), settled.',
        bets: bets.slice(0, HISTORY_SHOWN),
        ...(bets.length > HISTORY_SHOWN ? { more: bets.length - HISTORY_SHOWN } : {}),
      };
    },

    async place_bet({ mode, legs, stakeCents, why }) {
      if (mode !== 'singles' && mode !== 'parlay') return { error: 'mode must be "singles" or "parlay".' };
      if (!Array.isArray(legs) || legs.length === 0) return { error: 'Give at least one leg.' };
      const chosen = [];
      for (const l of legs) {
        const p = picks.get(String(l?.pick ?? ''));
        if (!p) return { error: `Unknown pick "${l?.pick}". Use pick ids from get_board, get_game or get_props.` };
        chosen.push({ p, stakeCents: l.stakeCents });
      }
      const body = {
        mode,
        clientRequestId: randomUUID(),
        ...(mode === 'parlay' ? { stakeCents } : {}),
        why: typeof why === 'string' ? why : '',
        legs: chosen.map(({ p, stakeCents: s }) => ({ ...p.leg, ...(mode === 'singles' ? { stakeCents: s } : {}) })),
      };
      try {
        const r = await api.post('/api/bets', body);
        for (const bet of r.bets ?? []) {
          log.bets.push({ league: [...new Set(bet.legs.map((x) => x.league))].join('+'), pick: bet.legs.map((x) => x.label).join(' + '), odds: bet.combinedAmerican, stakeCents: bet.stakeCents, why: bet.agentWhy ?? body.why });
        }
        return { placed: (r.bets ?? []).map((b) => ({ betId: b.id, pick: b.legs.map((x) => x.label).join(' + '), odds: b.combinedAmerican, stakeCents: b.stakeCents, toWinCents: b.potentialPayoutCents })), balanceCents: r.balanceCents, priceChanges: r.priceChanges };
      } catch (err) {
        if (err.code === 'LINE_CHANGED' || err.code === 'ODDS_CHANGED') {
          // Show the model the new prices and update the picks so a re-submit uses them. Never placed for it.
          const changes = [...(err.details?.lineChanges ?? []), ...(err.details?.oddsChanges ?? [])];
          const moved = [];
          for (const c of changes) {
            const v = picks.get(String(c.legId ?? ''));
            if (v && c.quote) {
              const was = { line: v.leg.line, odds: v.leg.quotedAmerican };
              v.leg = { ...v.leg, line: c.quote.line ?? v.leg.line, quotedAmerican: c.quote.american };
              moved.push({ pick: c.legId, was, now: { line: c.quote.line ?? null, odds: c.quote.american, impliedPct: impl(c.quote.american) === null ? null : r1(impl(c.quote.american) * 100) } });
            }
          }
          log.refusals.push({ code: err.code, message: err.message });
          return { notPlaced: true, code: err.code, message: `${err.message} Nothing was placed. If you still want it at the new price, call place_bet again with the same pick ids.`, moved };
        }
        log.refusals.push({ code: err.code ?? 'ERROR', message: err.message });
        return { notPlaced: true, code: err.code ?? 'ERROR', message: err.message };
      }
    },

    async web_search({ query }) {
      if (log.searches >= limits.maxSearches) return { error: `No searches left (at most ${limits.maxSearches} per session).` };
      const q = String(query ?? '').slice(0, 300);
      if (!q.trim()) return { error: 'Give a query.' };
      log.searches += 1;
      try {
        return await search(q);
      } catch (err) {
        log.searchFailures += 1;
        return { error: err.unavailable ? err.message : `Search failed: ${err.message}` };
      }
    },
  };

  async function run(name, args) {
    const handler = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : null;
    if (!handler) return { error: `Unknown tool ${name}.` };
    if (!researchOpen && RESEARCH_TOOLS.includes(name)) return { researchClosed: true, message: RESEARCH_CLOSED_MESSAGE };
    try {
      return await handler(args && typeof args === 'object' ? args : {});
    } catch (err) {
      log.toolErrors += 1;
      return { error: err.message ?? String(err), code: err.code };
    }
  }

  return { run, log, picks, setResearchOpen: (open) => { researchOpen = Boolean(open); }, isResearchOpen: () => researchOpen };
}
