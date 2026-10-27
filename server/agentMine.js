// POST /api/bets { action: "mine" } (0.21.0), any signed-in player, read only:
//   { balanceCents, openBets: [the caller's unsettled bets], today: { slips, limit } }
// One query (bets where uid == caller and status == "open": two equality filters, served by Firestore's single-field
// indexes, no composite index needed) plus, for an AI agent, its agentDaily counter doc. The AI agent runner uses it
// to see its bankroll and what it already has riding.

import { adminDb } from './firebaseAdmin.js';
import { AGENT_DAILY_LIMIT, agentDailyId, centralDay, isAgent } from '../shared/agents.js';

const MAX_OPEN = 200;

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

export async function myBets(caller, _body, { now = new Date(), db = adminDb() } = {}) {
  const agent = isAgent(caller.user);
  const [snap, daily] = await Promise.all([
    db.collection('bets').where('uid', '==', caller.uid).where('status', '==', 'open').limit(MAX_OPEN).get(),
    agent ? db.collection('agentDaily').doc(agentDailyId(caller.uid, centralDay(now))).get() : Promise.resolve(null),
  ]);
  const openBets = snap.docs.map((d) => compactOpenBet(d.id, d.data())).sort((a, b) => String(a.placedAt).localeCompare(String(b.placedAt)));
  return {
    ok: true,
    balanceCents: Number(caller.user?.balanceCents) || 0,
    openBets,
    today: { slips: daily?.exists ? Number(daily.data().count) || 0 : 0, limit: agent ? AGENT_DAILY_LIMIT : null, day: centralDay(now) },
  };
}
