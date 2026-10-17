// POST /api/casino  { action, game?, … }
// Every casino action: slot spins, and table actions (sit, leave, heartbeat, tick, bet, confirm, …).
// Signed-in, non-disabled players only: the token is verified here and the profile (wallet, disabled)
// is read once, inside the action's transaction. Replies always include serverNow, and every reply
// carries a Server-Timing header (auth, reads, commit, total) that is also logged.

import { readJsonBody, withHandler } from '../server/http.js';
import { requireToken } from '../server/auth.js';
import { handleCasinoAction } from '../server/casino/router.js';
import { createTiming } from '../server/timing.js';

export default withHandler(['POST'], async (req, res) => {
  const timing = createTiming();
  const body = readJsonBody(req);
  let status = 200;
  try {
    const caller = await timing.time('auth', () => requireToken(req));
    return await handleCasinoAction(caller, body, { timing });
  } catch (err) {
    status = err?.status ?? 500;
    throw err;
  } finally {
    const header = timing.header();
    if (!res.headersSent) res.setHeader('Server-Timing', header);
    console.log(JSON.stringify({ casino: body.action ?? null, game: body.game ?? null, status, ...timing.summary() }));
  }
});
