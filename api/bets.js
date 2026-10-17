// POST /api/bets
// Place:  { mode: "singles" | "parlay", clientRequestId, stakeCents?, legs: [{ league, gameId, marketType, selection, line, quotedAmerican, stakeCents? }] }
//         200 { bets, priceChanges, balanceCents } | 409 LINE_CHANGED / MARKET_CLOSED / INSUFFICIENT_BALANCE
// Cash out estimates: { action: "cashoutQuote", betIds: [...] }
//         200 { quotes: { [betId]: { available, valueCents, mode | reason } } }
// Cash out:  { action: "cashout", betId, expectedCents }
//         200 { cashoutCents, balanceCents, bet } | 409 CASHOUT_CHANGED { valueCents } / CASHOUT_UNAVAILABLE { reason }

import { HttpError, readJsonBody, withHandler } from '../server/http.js';
import { requireUser } from '../server/auth.js';
import { placeBets } from '../server/placeBet.js';
import { cashOutBet, quoteBets } from '../server/cashout.js';

export default withHandler(['POST'], async (req) => {
  const caller = await requireUser(req);
  const body = readJsonBody(req);
  if (body.action === undefined || body.action === 'place') return placeBets(caller, body);
  if (body.action === 'cashoutQuote') return quoteBets(caller, body);
  if (body.action === 'cashout') return cashOutBet(caller, body);
  throw new HttpError(400, 'BAD_ACTION', 'Unknown action.');
});
