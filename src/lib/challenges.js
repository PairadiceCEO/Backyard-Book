// Challenges on the phone: live lists (Firestore listeners; any signed-in player may read Challenges),
// the bet slip pick for an outcome, and small display helpers. The server decides everything that
// matters (status, odds, close time, the poster's-bet tag); these only display.

import { useCallback, useEffect, useState } from 'react';
import { collection, doc, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { db } from '../firebase.js';
import { makeLegId } from '../../shared/betRules.js';
import { americanToDecimal } from '../../shared/oddsMath.js';
import { CHALLENGE_LEAGUE, CHALLENGE_MARKET, CHALLENGE_PREFIX, challengeState } from '../../shared/challenges.js';
import { toMs } from './battles.js';

const MAX_CHALLENGES = 60;
const MAX_ADMIN_CHALLENGES = 200;
export const RECENT_FINISHED_MS = 3 * 24 * 60 * 60 * 1000;

// The newest Challenges, live. One listener while the screen is open; removed on unmount (and redone on retry).
export function useChallenges({ max = MAX_CHALLENGES } = {}) {
  const [state, setState] = useState({ challenges: [], error: '', loaded: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!db) return undefined;
    const q = query(collection(db, 'challenges'), orderBy('createdAt', 'desc'), limit(max));
    const unsubscribe = onSnapshot(
      q,
      (snap) => setState({ challenges: snap.docs.map((d) => ({ id: d.id, ...d.data() })), error: '', loaded: true }),
      (err) => setState({ challenges: [], error: err.message || 'Could not load Challenges.', loaded: true }),
    );
    return unsubscribe;
  }, [attempt, max]);
  const retry = useCallback(() => {
    setState({ challenges: [], error: '', loaded: false });
    setAttempt((n) => n + 1);
  }, []);
  return { ...state, loading: !state.loaded, retry };
}

export function useAllChallenges() {
  return useChallenges({ max: MAX_ADMIN_CHALLENGES });
}

// One Challenge, live.
export function useChallenge(challengeId) {
  const [state, setState] = useState({ id: null, challenge: null, error: '', loaded: false });
  useEffect(() => {
    if (!db || !challengeId) return undefined;
    const unsubscribe = onSnapshot(
      doc(db, 'challenges', challengeId),
      (snap) => setState({ id: challengeId, challenge: snap.exists() ? { id: snap.id, ...snap.data() } : null, error: '', loaded: true }),
      (err) => setState({ id: challengeId, challenge: null, error: err.message || 'Could not load the Challenge.', loaded: true }),
    );
    return unsubscribe;
  }, [challengeId]);
  const current = state.id === challengeId;
  return { challenge: current ? state.challenge : null, error: current ? state.error : '', loading: !current || !state.loaded };
}

// Current time, refreshed every 15 s so an open Challenge shows as closed on its own at the close time.
export function useNowMs(everyMs = 15000) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return nowMs;
}

export function closeMsOf(challenge) {
  return toMs(challenge?.closeTime);
}

// 'pending' | 'open' | 'closed' | 'rejected' | 'settled' | 'void'.
export function stateOf(challenge, nowMs) {
  return challengeState(challenge, nowMs, closeMsOf(challenge) ?? 0);
}

export function challengeGameId(challenge) {
  return `${CHALLENGE_PREFIX}${challenge.id}`;
}

// The slip pick for one outcome (a quote shaped like the board's, priced from the Challenge doc).
export function outcomeQuote(outcome) {
  return { american: outcome.american, decimal: americanToDecimal(outcome.american), line: null, source: 'challenge' };
}

export function makeChallengePick(challenge, outcome) {
  const gameId = challengeGameId(challenge);
  const quote = outcomeQuote(outcome);
  return {
    legId: makeLegId({ league: CHALLENGE_LEAGUE, gameId, marketType: CHALLENGE_MARKET, selection: outcome.id, line: null, source: quote.source }),
    kalshi: null,
    league: CHALLENGE_LEAGUE,
    gameId,
    marketType: CHALLENGE_MARKET,
    selection: outcome.id,
    homeName: '',
    awayName: '',
    gameLabel: challenge.title,
    line: null,
    american: quote.american,
    decimal: quote.decimal,
    source: quote.source,
    label: outcome.label,
  };
}

// Which Challenges the Custom tab lists: pending and open ones, closed ones waiting to be settled, ones
// finished in the last 3 days, and my own rejected ones (so I can read the admin's note).
export function boardChallenges(challenges, uid, nowMs) {
  return challenges.filter((c) => {
    if (c.status === 'pending' || c.status === 'open') return true;
    if (c.status === 'rejected') return c.posterUid === uid && nowMs - (toMs(c.updatedAt) ?? 0) < RECENT_FINISHED_MS;
    return nowMs - (toMs(c.settledAt) ?? toMs(c.updatedAt) ?? 0) < RECENT_FINISHED_MS;
  });
}

const STATE_ORDER = { open: 0, pending: 1, closed: 2, settled: 3, void: 3, rejected: 4 };

// Open first (closing soonest first), then pending, waiting to settle, finished.
export function sortForBoard(challenges, nowMs) {
  return [...challenges].sort((a, b) => {
    const diff = STATE_ORDER[stateOf(a, nowMs)] - STATE_ORDER[stateOf(b, nowMs)];
    if (diff !== 0) return diff;
    return (closeMsOf(a) ?? 0) - (closeMsOf(b) ?? 0);
  });
}
