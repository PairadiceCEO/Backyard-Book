// POST /api/shop  { amount: 5 | 25 | 50 | 100, clientRequestId? }
// Adds free play money to the caller's own wallet.

import { HttpError, readJsonBody, withHandler } from '../server/http.js';
import { requireUser } from '../server/auth.js';
import { applyWalletChange } from '../server/wallet.js';
import { REQUEST_ID_PATTERN, SHOP_AMOUNTS_DOLLARS } from '../shared/constants.js';
import { randomUUID } from 'node:crypto';

export default withHandler(['POST'], async (req) => {
  const caller = await requireUser(req);
  const body = readJsonBody(req);

  const amount = Number(body.amount);
  if (!SHOP_AMOUNTS_DOLLARS.includes(amount)) {
    throw new HttpError(400, 'BAD_AMOUNT', `Amount must be one of: ${SHOP_AMOUNTS_DOLLARS.map((a) => `$${a}`).join(', ')}.`);
  }

  let requestId = randomUUID();
  if (body.clientRequestId !== undefined) {
    if (typeof body.clientRequestId !== 'string' || !REQUEST_ID_PATTERN.test(body.clientRequestId)) {
      throw new HttpError(400, 'BAD_REQUEST_ID', 'clientRequestId must be 8–64 letters, numbers, "-" or "_".');
    }
    requestId = body.clientRequestId;
  }

  const result = await applyWalletChange({
    uid: caller.uid,
    deltaCents: amount * 100,
    ledgerId: `shop_${caller.uid}_${requestId}`,
    type: 'shop',
    note: `Shop +$${amount}`,
    by: caller.uid,
  });

  return { ok: true, amount, balanceCents: result.balanceCents, duplicate: result.duplicate };
});
