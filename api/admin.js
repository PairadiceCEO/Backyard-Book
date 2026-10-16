// POST /api/admin  { action, ...fields }
// Public: setupStatus, bootstrap.
// Admin only: ping, createUser, updateUser, setDisabled, resetPassword, adjustWallet,
//   gradeBet, setLegResult (preview with confirm: false, apply with confirm: true + expectedVersion),
//   createCustomGame, updateCustomGame, finalizeCustomGame, cancelCustomGame (preview / confirm), deleteCustomGame.

import { HttpError, readJsonBody, withHandler } from '../server/http.js';
import { requireAdmin } from '../server/auth.js';
import { bootstrapAdmin, getSetupStatus } from '../server/admin/bootstrap.js';
import { adjustWallet, createUser, resetPassword, setDisabled, updateUser } from '../server/admin/users.js';
import { gradeBet, setLegResult } from '../server/admin/bets.js';
import {
  cancelCustomGame,
  createCustomGame,
  deleteCustomGame,
  finalizeCustomGame,
  updateCustomGame,
} from '../server/admin/customGames.js';

const ADMIN_ACTIONS = {
  ping: async (_body, caller) => ({ ok: true, admin: true, username: caller.user.username }),
  createUser,
  updateUser,
  setDisabled,
  resetPassword,
  adjustWallet,
  gradeBet,
  setLegResult,
  createCustomGame,
  updateCustomGame,
  finalizeCustomGame,
  cancelCustomGame,
  deleteCustomGame,
};

export default withHandler(['POST'], async (req) => {
  const body = readJsonBody(req);
  const action = typeof body.action === 'string' ? body.action : '';

  // Public actions used by the one-time /setup page.
  if (action === 'setupStatus') return getSetupStatus();
  if (action === 'bootstrap') return bootstrapAdmin(body);

  // Everything below requires a signed-in admin.
  const caller = await requireAdmin(req);

  const run = Object.prototype.hasOwnProperty.call(ADMIN_ACTIONS, action) ? ADMIN_ACTIONS[action] : null;
  if (!run) {
    throw new HttpError(400, 'UNKNOWN_ACTION', action ? `Unknown admin action: ${action}` : 'Missing "action".');
  }
  return run(body, caller);
});
