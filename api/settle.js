// /api/settle
//   POST {}                 any signed-in player (app open, My Bets). Skipped if settlement ran in the last 60 s.
//   POST { force: true }    admin "Settle now": always runs.
//   POST { preview: true }  admin "Preview settlement": what settlement would do right now; changes nothing.
//   GET                     daily Vercel cron; must carry "Authorization: Bearer <CRON_SECRET>".

import { timingSafeEqual } from 'node:crypto';
import { HttpError, readJsonBody, withHandler } from '../server/http.js';
import { requireAdmin, requireUser } from '../server/auth.js';
import { settleOpenBets } from '../server/settlement.js';

function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) throw new HttpError(500, 'CRON_NOT_CONFIGURED', 'CRON_SECRET is not set in Vercel environment variables.');
  const header = String(req.headers?.authorization || req.headers?.Authorization || '');
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export default withHandler(['GET', 'POST'], async (req) => {
  if (req.method === 'GET') {
    if (!cronAuthorized(req)) throw new HttpError(401, 'NOT_CRON', 'This address is only for the scheduled settlement job.');
    return settleOpenBets({ trigger: 'cron', force: true });
  }

  const body = readJsonBody(req);
  if (body.preview === true) {
    await requireAdmin(req);
    return settleOpenBets({ trigger: 'admin', dryRun: true });
  }
  if (body.force === true) {
    await requireAdmin(req);
    return settleOpenBets({ trigger: 'admin', force: true });
  }
  await requireUser(req);
  return settleOpenBets({ trigger: 'player' });
});
