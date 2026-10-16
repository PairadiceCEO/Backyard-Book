// POST /api/bets
// { mode: "singles" | "parlay", clientRequestId, stakeCents?, legs: [{ league, gameId, marketType, selection, line, quotedAmerican, stakeCents? }] }
// 200 { bets, priceChanges, balanceCents } | 409 LINE_CHANGED / MARKET_CLOSED / INSUFFICIENT_BALANCE

import { readJsonBody, withHandler } from '../server/http.js';
import { requireUser } from '../server/auth.js';
import { placeBets } from '../server/placeBet.js';

export default withHandler(['POST'], async (req) => {
  const caller = await requireUser(req);
  const body = readJsonBody(req);
  return placeBets(caller, body);
});
