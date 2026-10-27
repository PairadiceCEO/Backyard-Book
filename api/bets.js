// POST /api/bets
// Place:  { mode: "singles" | "parlay", clientRequestId, stakeCents?, legs: [{ league, gameId, marketType, selection, line, quotedAmerican, stakeCents? }] }
//         200 { bets, priceChanges, balanceCents } | 409 LINE_CHANGED / MARKET_CLOSED / INSUFFICIENT_BALANCE
// Cash out estimates: { action: "cashoutQuote", betIds: [...] }
//         200 { quotes: { [betId]: { available, valueCents, mode | reason } } }
// Cash out:  { action: "cashout", betId, expectedCents }
//         200 { cashoutCents, balanceCents, bet } | 409 CASHOUT_CHANGED { valueCents } / CASHOUT_UNAVAILABLE { reason }
// Mine (0.21.0, read only): { action: "mine" } → 200 { balanceCents, openBets, today: { slips, limit } }
// Place also takes `why` from AI agent accounts (stored as agentWhy) and applies the agent house rules (server/placeBet.js).

import { HttpError, readJsonBody, withHandler } from '../server/http.js';
import { requireUser } from '../server/auth.js';
import { placeBets } from '../server/placeBet.js';
import { cashOutBet, quoteBets } from '../server/cashout.js';
import { myBets } from '../server/agentMine.js';

export default withHandler(['POST'], async (req) => {
  const caller = await requireUser(req);
  const body = readJsonBody(req);
  if (body.action === undefined || body.action === 'place') return placeBets(caller, body);
  if (body.action === 'cashoutQuote') return quoteBets(caller, body);
  if (body.action === 'cashout') return cashOutBet(caller, body);
  if (body.action === 'mine') return myBets(caller, body);
  throw new HttpError(400, 'BAD_ACTION', 'Unknown action.');
});
