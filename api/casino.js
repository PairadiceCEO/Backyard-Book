// POST /api/casino  { action, game?, … }
// Every casino action: slot spins, and table actions (sit, leave, heartbeat, tick, bet, confirm, …).
// Signed-in, non-disabled players only. Replies always include serverNow.

import { readJsonBody, withHandler } from '../server/http.js';
import { requireUser } from '../server/auth.js';
import { handleCasinoAction } from '../server/casino/router.js';

export default withHandler(['POST'], async (req) => {
  const caller = await requireUser(req);
  const body = readJsonBody(req);
  return handleCasinoAction(caller, body);
});
