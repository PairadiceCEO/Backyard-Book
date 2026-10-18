// Pure bet slip state. Every change goes through this reducer, so it is easy to test and
// can never loop: actions only run from clicks and server responses.

import { MAX_LEGS, MIN_PARLAY_LEGS, conflictKey, makeLegId, pickLabel } from '../../shared/betRules.js';

// Exact Kalshi market behind a quote (main or alternate line), if any.
function kalshiRef(quote) {
  if (quote?.source !== 'kalshi' || !quote.ref?.ticker) return null;
  return { ticker: quote.ref.ticker, side: quote.ref.side };
}

export const initialSlipState = {
  legs: [],
  mode: 'singles',
  parlayStake: '',
  notice: '',
};

// Builds a pick from a board game and one of its quotes.
export function makePick(game, marketType, selection, quote) {
  return {
    legId: makeLegId({ league: game.league, gameId: game.id, marketType, selection, line: quote.line, source: quote.source }),
    kalshi: kalshiRef(quote),
    league: game.league,
    gameId: game.id,
    marketType,
    selection,
    homeName: game.home.shortName,
    awayName: game.away.shortName,
    gameLabel: `${game.away.shortName} @ ${game.home.shortName}`,
    line: quote.line,
    american: quote.american,
    decimal: quote.decimal,
    source: quote.source,
    label: pickLabel({ marketType, selection, line: quote.line, homeName: game.home.shortName, awayName: game.away.shortName }),
  };
}

function applyQuote(leg, quote) {
  return {
    ...leg,
    legId: makeLegId({ league: leg.league, gameId: leg.gameId, marketType: leg.marketType, selection: leg.selection, line: quote.line, source: quote.source }),
    kalshi: kalshiRef(quote),
    line: quote.line,
    american: quote.american,
    decimal: quote.decimal,
    source: quote.source,
    label: pickLabel({ marketType: leg.marketType, selection: leg.selection, line: quote.line, homeName: leg.homeName, awayName: leg.awayName, crypto: leg.crypto ?? null }),
    flag: null,
  };
}

export function betSlipReducer(state, action) {
  switch (action.type) {
    case 'toggle': {
      const pick = action.pick;
      if (state.legs.some((l) => l.legId === pick.legId)) {
        return { ...state, legs: state.legs.filter((l) => l.legId !== pick.legId), notice: '' };
      }
      // Picking the other side of the same game + market replaces the old pick.
      const key = conflictKey(pick);
      const others = state.legs.filter((l) => conflictKey(l) !== key);
      if (others.length >= MAX_LEGS) {
        return { ...state, notice: `A slip can hold at most ${MAX_LEGS} picks.` };
      }
      const replaced = state.legs.find((l) => conflictKey(l) === key);
      const leg = { ...pick, stake: replaced ? replaced.stake : '', flag: null };
      // Crypto picks are singles only: adding one turns a parlay slip back into singles.
      const mode = pick.marketType === 'crypto' ? 'singles' : state.mode;
      return { ...state, legs: [...others, leg], mode, notice: '' };
    }
    case 'remove': {
      const legs = state.legs.filter((l) => l.legId !== action.legId);
      const mode = state.mode === 'parlay' && legs.length < MIN_PARLAY_LEGS ? 'singles' : state.mode;
      return { ...state, legs, mode, notice: '' };
    }
    case 'setMode':
      if (action.mode === 'parlay' && state.legs.length < MIN_PARLAY_LEGS) return state;
      if (action.mode === 'parlay' && state.legs.some((l) => l.marketType === 'crypto')) return state; // crypto: singles only
      return { ...state, mode: action.mode, notice: '' };
    case 'setStake':
      return { ...state, legs: state.legs.map((l) => (l.legId === action.legId ? { ...l, stake: action.value } : l)) };
    case 'setParlayStake':
      return { ...state, parlayStake: action.value };
    case 'serverRejected': {
      // 409 LINE_CHANGED / MARKET_CLOSED: flag the affected picks; the user must accept or remove them.
      const changes = new Map((action.lineChanges ?? []).map((c) => [c.legId, c]));
      const closedLegs = new Map((action.closedLegs ?? []).map((c) => [c.legId, c]));
      return {
        ...state,
        legs: state.legs.map((l) => {
          if (closedLegs.has(l.legId)) return { ...l, flag: { type: 'closed', reason: closedLegs.get(l.legId).reason } };
          if (changes.has(l.legId)) {
            const c = changes.get(l.legId);
            return { ...l, flag: { type: 'lineChanged', oldLine: c.oldLine, newLine: c.newLine, newAmerican: c.newAmerican, quote: c.quote } };
          }
          return l;
        }),
      };
    }
    case 'accept':
      return {
        ...state,
        legs: state.legs.map((l) => (l.legId === action.legId && l.flag?.type === 'lineChanged' ? applyQuote(l, l.flag.quote) : l)),
      };
    case 'acceptOdds': {
      // ODDS_CHANGED: the player accepted the new odds for these picks (same line, new price).
      const byLeg = new Map((action.changes ?? []).map((c) => [c.legId, c]));
      return {
        ...state,
        legs: state.legs.map((l) => {
          const c = byLeg.get(l.legId);
          if (!c) return l;
          const decimal = Number.isFinite(c.quote?.decimal) ? c.quote.decimal : l.decimal;
          return { ...l, american: c.newAmerican, decimal, flag: null };
        }),
      };
    }
    case 'removeMany': {
      const gone = new Set(action.legIds ?? []);
      const legs = state.legs.filter((l) => !gone.has(l.legId));
      const mode = state.mode === 'parlay' && legs.length < MIN_PARLAY_LEGS ? 'singles' : state.mode;
      return { ...state, legs, mode, notice: '' };
    }
    case 'acceptAll':
      return { ...state, legs: state.legs.map((l) => (l.flag?.type === 'lineChanged' ? applyQuote(l, l.flag.quote) : l)) };
    case 'clear':
      return { ...initialSlipState };
    case 'dismissNotice':
      return { ...state, notice: '' };
    default:
      return state;
  }
}
