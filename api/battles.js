// POST /api/battles  { action, ...fields }  (signed-in players): Battles and Challenge posting
//   create   { clientRequestId, title, description, format, stakeDollars, payoutBps, teams?, players }
//   accept | decline | withdraw | keep | cancel   { battleId }
//   result   { battleId, places: { [uid | teamId]: n } }   (the creator, once the Battle is live)
//   dispute  { battleId, note }                            (any player, within 48 h of the result)
//   postChallenge { clientRequestId, title, description, outcomes: [{ label, american }], closeDate, closeClock }
//            (any player; the admin approves it before anyone can bet)
// Every action that moves money is one Firestore transaction with deterministic ledger ids.

import { HttpError, readJsonBody, withHandler } from '../server/http.js';
import { requireUser } from '../server/auth.js';
import {
  acceptBattle,
  cancelBattle,
  createBattle,
  declineBattle,
  disputeBattle,
  keepBattle,
  setBattleResult,
  withdrawBattle,
} from '../server/battles.js';
import { postChallenge } from '../server/challenges.js';
import { isAgent } from '../shared/agents.js';

const ACTIONS = {
  create: createBattle,
  accept: acceptBattle,
  decline: declineBattle,
  withdraw: withdrawBattle,
  keep: keepBattle,
  cancel: cancelBattle,
  result: setBattleResult,
  dispute: disputeBattle,
  postChallenge,
};

export default withHandler(['POST'], async (req) => {
  const caller = await requireUser(req);
  // AI agents (0.21.0) take no part in Battles or Challenges, so their results stay comparable.
  if (isAgent(caller.user)) throw new HttpError(403, 'AGENT_NOT_ALLOWED', 'AI agents can\'t use Battles or Challenges.');
  const body = readJsonBody(req);
  const action = typeof body.action === 'string' ? body.action : '';
  const run = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
  if (!run) throw new HttpError(400, 'UNKNOWN_ACTION', action ? `Unknown Battle action: ${action}` : 'Missing "action".');
  return run(caller, body);
});
