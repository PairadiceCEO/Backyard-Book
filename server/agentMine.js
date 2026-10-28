// POST /api/bets { action: "mine" } (0.21.0), any signed-in player, read only:
//   { balanceCents, openBets: [the caller's unsettled bets], today: { slips, limit } }
// One query (bets where uid == caller and status == "open": two equality filters, served by Firestore's single-field
// indexes, no composite index needed) plus, for an AI agent, its agentDaily counter doc. The AI agent runner uses it
// to see its bankroll and what it already has riding.
// 0.22.0: with { history: true } the answer also has `history`: the caller's settled bets (won / lost / push / void / cashed out) of the
// last 14 days, newest first, at most 50, each cut down to { pick, league, odds, stakeCents, result, returnCents, why (120), settled }.
// One more query, up to 50 reads: bets where uid == caller and settledAt >= cutoff, ordered by settledAt desc. It needs the composite
// index bets (uid ascending, settledAt descending); until that exists `history` is { available: false } and nothing else fails.

import { adminDb } from './firebaseAdmin.js';
import { AGENT_DAILY_LIMIT, agentDailyId, centralDay, isAgent } from '../shared/agents.js';

const MAX_OPEN = 200;
export const HISTORY_DAYS = 14;
export const HISTORY_MAX = 50;
export const HISTORY_WHY_MAX = 120;

function iso(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function compactOpenBet(id, bet) {
  return {
    id,
    type: bet.type,
    stakeCents: bet.stakeCents,
    americanOdds: bet.combinedAmerican ?? null,
    potentialPayoutCents: bet.potentialPayoutCents ?? null,
    placedAt: iso(bet.placedAt),
    why: bet.agentWhy ?? null,
    legs: (bet.legs ?? []).map((l) => ({
      league: l.league,
      gameId: l.gameId,
      game: l.gameLabel ?? null,
      startTime: iso(l.startTime),
      marketType: l.marketType,
      selection: l.selection,
      line: l.line ?? null,
      pick: l.label,
      americanOdds: l.americanOdds,
      result: l.result ?? 'pending',
    })),
  };
}

export function compactSettledBet(id, bet) {
  const legs = bet.legs ?? [];
  const why = typeof bet.agentWhy === 'string' ? bet.agentWhy.replace(/\s+/g, ' ').trim() : '';
  return {
    id,
    pick: legs.map((l) => l.label).filter(Boolean).join(' + ') || bet.type || 'bet',
    league: [...new Set(legs.map((l) => l.league).filter(Boolean))].join('+') || null,
    odds: bet.combinedAmerican ?? null,
    stakeCents: Number(bet.stakeCents) || 0,
    result: bet.status ?? null,
    returnCents: Number(bet.payoutCents) || 0,
    why: why ? why.slice(0, HISTORY_WHY_MAX) : null,
    settled: iso(bet.settledAt),
  };
}

async function settledHistory(db, uid, now) {
  const cutoff = new Date(now.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
  try {
    const snap = await db.collection('bets').where('uid', '==', uid).where('settledAt', '>=', cutoff).orderBy('settledAt', 'desc').limit(HISTORY_MAX).get();
    return { available: true, days: HISTORY_DAYS, bets: snap.docs.map((d) => compactSettledBet(d.id, d.data())).slice(0, HISTORY_MAX) };
  } catch (err) {
    // Most likely the composite index is not created yet (FAILED_PRECONDITION): the rest of "mine" still answers.
    console.error('agent history query failed:', err?.message);
    return { available: false, reason: 'History is not available yet.' };
  }
}

export async function myBets(caller, body, { now = new Date(), db = adminDb() } = {}) {
  const agent = isAgent(caller.user);
  const [snap, daily, history] = await Promise.all([
    db.collection('bets').where('uid', '==', caller.uid).where('status', '==', 'open').limit(MAX_OPEN).get(),
    agent ? db.collection('agentDaily').doc(agentDailyId(caller.uid, centralDay(now))).get() : Promise.resolve(null),
    body?.history === true ? settledHistory(db, caller.uid, now) : Promise.resolve(null),
  ]);
  const openBets = snap.docs.map((d) => compactOpenBet(d.id, d.data())).sort((a, b) => String(a.placedAt).localeCompare(String(b.placedAt)));
  return {
    ok: true,
    balanceCents: Number(caller.user?.balanceCents) || 0,
    openBets,
    today: { slips: daily?.exists ? Number(daily.data().count) || 0 : 0, limit: agent ? AGENT_DAILY_LIMIT : null, day: centralDay(now) },
    ...(history ? { history } : {}),
  };
}
