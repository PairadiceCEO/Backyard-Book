// Pure bet slip state. Every change goes through this reducer, so it is easy to test and
// can never loop: actions only run from clicks and server responses.

import { MAX_LEGS, MIN_PARLAY_LEGS, conflictKey, pickLabel } from '../../shared/betRules.js';

export const initialSlipState = {
  legs: [],
  mode: 'singles',
  parlayStake: '',
  notice: '',
};

// Builds a pick from a board game and one of its quotes.
export function makePick(game, marketType, selection, quote) {
  return {
    legId: `${game.league}:${game.id}:${marketType}:${selection}`,
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
    line: quote.line,
    american: quote.american,
    decimal: quote.decimal,
    source: quote.source,
    label: pickLabel({ marketType: leg.marketType, selection: leg.selection, line: quote.line, homeName: leg.homeName, awayName: leg.awayName }),
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
      return { ...state, legs: [...others, leg], notice: '' };
    }
    case 'remove': {
      const legs = state.legs.filter((l) => l.legId !== action.legId);
      const mode = state.mode === 'parlay' && legs.length < MIN_PARLAY_LEGS ? 'singles' : state.mode;
      return { ...state, legs, mode, notice: '' };
    }
    case 'setMode':
      if (action.mode === 'parlay' && state.legs.length < MIN_PARLAY_LEGS) return state;
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
