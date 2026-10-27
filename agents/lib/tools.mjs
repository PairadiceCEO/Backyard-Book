// The agent's tools (0.21.0). The same for every provider; each runs against our own /api with the agent's ID token, so an
// agent can do nothing a player can't. Picks are shown to the model with short ids ("p7"); place_bet takes those ids and
// this file builds exactly the legs the app's bet slip would send (src/components/BetSlip.jsx), so the model can't send a
// malformed or invented market.
//
//   get_leagues()              which leagues have games starting today or tomorrow (Central), from each league's board
//   get_board(league)          main lines (DraftKings, or Kalshi where DraftKings has none) for games not started yet
//   get_game(league, gameId)   alternate spreads and totals (Kalshi)
//   get_props(league, gameId)  player props (Kalshi, pre-game only)
//   get_my_bets()              balance, open bets, today's slips   (/api/bets action "mine")
//   place_bet({ mode, legs: [{ pick, stakeCents }], stakeCents, why })   /api/bets place; LINE_CHANGED / ODDS_CHANGED come back
//                              to the model with the new price (the catalog is updated, nothing is re-sent automatically)
//   web_search(query)          the provider's own search, at most N per run (the runner counts them)

import { randomUUID } from 'node:crypto';

export const LEAGUES = ['nfl', 'nba', 'mlb', 'nhl', 'ncaaf'];
const TOO_SOON_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const TOOL_DEFS = [
  {
    name: 'get_leagues',
    description: 'Which leagues have games that have not started yet, with how many start in the next 36 hours. Call this first.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_board',
    description: "One league's upcoming games with their main lines: moneyline, spread and total, each side with a pick id, American odds and the source (espn = DraftKings, kalshi = Kalshi). Games starting within 10 minutes are left out.",
    parameters: { type: 'object', properties: { league: { type: 'string', enum: LEAGUES } }, required: ['league'] },
  },
  {
    name: 'get_game',
    description: "One game's alternate spreads and totals (Kalshi prices), each with a pick id. Useful to compare with DraftKings' main line.",
    parameters: { type: 'object', properties: { league: { type: 'string', enum: LEAGUES }, gameId: { type: 'string' } }, required: ['league', 'gameId'] },
  },
  {
    name: 'get_props',
    description: "One game's player props (Kalshi, pre-game only): for each player and stat, thresholds with yes / no picks.",
    parameters: { type: 'object', properties: { league: { type: 'string', enum: LEAGUES }, gameId: { type: 'string' } }, required: ['league', 'gameId'] },
  },
  {
    name: 'get_my_bets',
    description: 'Your balance, your open bets and how many bet slips you have placed today (of 10).',
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
    description: 'Search the web (news, injuries, lineups, weather, form). At most 5 searches in a session; returns a short summary with sources.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
];

const centralFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export function centralTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${centralFmt.format(d)} CT`;
}

function pct(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || a === 0) return null;
  const p = a < 0 ? -a / (-a + 100) : 100 / (a + 100);
  return Math.round(p * 1000) / 10;
}

// The tools' state and executor. api: { get(path), post(path, body) } that throw { code, message, status, details }.
export function createTools({ api, now = () => new Date(), search, limits }) {
  const picks = new Map(); // id → { leg, label, game, start }
  let nextPick = 1;
  const boards = new Map();
  const log = { bets: [], refusals: [], searches: 0, searchFailures: 0, toolErrors: 0 };

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
    return { pick: id, odds: quote.american, impliedPct: pct(quote.american), line: quote.line ?? null, source: quote.source };
  }

  function describePick(game, marketType, selection, line) {
    const team = selection === 'home' ? game.home?.shortName : game.away?.shortName;
    if (marketType === 'moneyline') return `${team} moneyline`;
    if (marketType === 'spread') return `${team} ${line > 0 ? '+' : ''}${line}`;
    if (marketType === 'total') return `${selection === 'over' ? 'Over' : 'Under'} ${line}`;
    return `${marketType} ${selection}`;
  }

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
          if (games.length) out.push({ league, upcomingGames: games.length, startingWithin36h: soon.length, firstStart: centralTime(games[0].startTime) });
        } catch (err) {
          out.push({ league, error: err.message });
        }
      }
      return { now: centralTime(now().toISOString()), leagues: out };
    },

    async get_board({ league }) {
      if (!LEAGUES.includes(league)) return { error: `league must be one of ${LEAGUES.join(', ')}` };
      const b = await board(league);
      const games = upcoming(b.games ?? []).slice(0, 40);
      return {
        league,
        note: 'Picks are ids for place_bet. impliedPct includes the vig.',
        games: games.map((g) => {
          const m = g.markets ?? {};
          return {
            gameId: g.id,
            game: `${g.away?.shortName} @ ${g.home?.shortName}`,
            away: g.away?.name ?? g.away?.shortName,
            home: g.home?.name ?? g.home?.shortName,
            start: centralTime(g.startTime),
            minutesToStart: Math.round((new Date(g.startTime).getTime() - now().getTime()) / 60000),
            moneyline: { home: addPick(g, 'moneyline', 'home', m.moneyline?.home), away: addPick(g, 'moneyline', 'away', m.moneyline?.away) },
            spread: { home: addPick(g, 'spread', 'home', m.spread?.home), away: addPick(g, 'spread', 'away', m.spread?.away) },
            total: { over: addPick(g, 'total', 'over', m.total?.over), under: addPick(g, 'total', 'under', m.total?.under) },
            note: g.oddsNote ?? undefined,
          };
        }),
      };
    },

    async get_game({ league, gameId }) {
      const d = await api.get(`/api/board?league=${encodeURIComponent(league)}&game=${encodeURIComponent(gameId)}`);
      const g = { ...d.game, league };
      if (!upcoming([g]).length) return { error: 'This game has started or starts within 10 minutes: AI players bet pre-game only.' };
      const lad = d.ladders ?? { spreads: { home: [], away: [] }, totals: [] };
      return {
        gameId,
        game: `${g.away?.shortName} @ ${g.home?.shortName}`,
        start: centralTime(g.startTime),
        alternateSpreads: {
          home: (lad.spreads?.home ?? []).map((q) => addPick(g, 'spread', 'home', q)).filter(Boolean),
          away: (lad.spreads?.away ?? []).map((q) => addPick(g, 'spread', 'away', q)).filter(Boolean),
        },
        alternateTotals: (lad.totals ?? []).map((row) => ({ line: row.line, over: addPick(g, 'total', 'over', row.over), under: addPick(g, 'total', 'under', row.under) })),
        hasProps: (d.propsCount ?? 0) > 0,
      };
    },

    async get_props({ league, gameId }) {
      const d = await api.get(`/api/board?league=${encodeURIComponent(league)}&game=${encodeURIComponent(gameId)}&props=1`);
      const g = { ...d.game, league };
      if (!d.props?.open) return { open: false, reason: d.props?.reason ?? 'No props.' };
      return {
        gameId,
        game: `${g.away?.shortName} @ ${g.home?.shortName}`,
        props: (d.props.tabs ?? []).map((tab) => ({
          stat: tab.stat,
          players: tab.players.slice(0, 25).map((p) => ({
            player: p.name,
            team: p.team,
            thresholds: p.rows.map((row) => {
              const make = (side) => {
                const q = row[side];
                if (!q) return null;
                const prop = { series: tab.series, stat: tab.stat, anytime: tab.anytime, player: p.name, team: p.team, threshold: row.threshold };
                return addPick(g, 'prop', side, { ...q, line: row.strike, ref: { ticker: row.ticker, side } }, { leg: { playerName: p.name }, label: `${p.name} ${side === 'yes' ? `${row.threshold}+` : `under ${row.threshold}`} ${tab.stat}`, prop });
              };
              return { atLeast: row.threshold, yes: make('yes'), no: make('no') };
            }),
          })),
        })),
      };
    },

    async get_my_bets() {
      return api.post('/api/bets', { action: 'mine' });
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
              moved.push({ pick: c.legId, was, now: { line: c.quote.line ?? null, odds: c.quote.american, impliedPct: pct(c.quote.american) } });
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
    try {
      return await handler(args && typeof args === 'object' ? args : {});
    } catch (err) {
      log.toolErrors += 1;
      return { error: err.message ?? String(err), code: err.code };
    }
  }

  return { run, log, picks };
}
