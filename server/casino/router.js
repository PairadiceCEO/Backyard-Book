// Routes POST /api/casino { action, game?, … } to the right handler.
// Every reply carries serverNow so phones can count down against the server's clock.

import { HttpError } from '../http.js';
import { spinSlots } from './slots.js';
import { casinoGame } from '../../shared/casino/constants.js';

const ACTIONS = {
  spin: spinSlots,
};

// Table actions arrive with the table phases; until then they answer clearly instead of "unknown".
const TABLE_ACTIONS = new Set([
  'sit', 'leave', 'heartbeat', 'tick', 'bet', 'removeBet', 'confirm', 'insurance', 'hit', 'stand', 'double', 'split', 'roll',
]);

export async function handleCasinoAction(caller, body, options = {}) {
  const action = typeof body.action === 'string' ? body.action : '';
  const handler = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;

  if (!handler) {
    if (TABLE_ACTIONS.has(action)) {
      const game = casinoGame(String(body.game ?? ''));
      const when = game?.opensIn ? ` It opens in casino phase ${game.opensIn}.` : '';
      throw new HttpError(400, 'TABLE_NOT_OPEN', `The table games aren't open yet.${when}`);
    }
    throw new HttpError(400, 'UNKNOWN_ACTION', action ? `Unknown casino action: ${action}` : 'Missing "action".');
  }

  const result = await handler(caller, body, options);
  return { ...result, serverNow: Date.now() };
}
