// POST /api/admin  { action, ...fields }
// Phase 2 actions: setupStatus and bootstrap (no login needed), ping (admin only).

import { HttpError, readJsonBody, withHandler } from '../server/http.js';
import { requireAdmin } from '../server/auth.js';
import { bootstrapAdmin, getSetupStatus } from '../server/admin/bootstrap.js';

export default withHandler(['POST'], async (req) => {
  const body = readJsonBody(req);
  const action = typeof body.action === 'string' ? body.action : '';

  // Public actions used by the one-time /setup page.
  if (action === 'setupStatus') return getSetupStatus();
  if (action === 'bootstrap') return bootstrapAdmin(body);

  // Everything below requires a signed-in admin.
  const caller = await requireAdmin(req);

  if (action === 'ping') {
    return { ok: true, admin: true, username: caller.user.username };
  }

  throw new HttpError(400, 'UNKNOWN_ACTION', action ? `Unknown admin action: ${action}` : 'Missing "action".');
});
