// Routes POST /api/casino { action, game?, … } to the right handler.
// Every reply carries serverNow so phones can count down against the server's clock.

import { HttpError } from '../http.js';
import { spinSlots } from './slots.js';
import { spinVip, vipUnlock } from './vipSlots.js';
import { vipPlayerStatus } from '../vipLock.js';
import { sendChat } from '../casinoChat.js';
import { handleTableAction } from './tables.js';

const SLOT_ACTIONS = {
  spin: spinSlots,
  // The VIP slot (0.28.0): unlock with the password (→ a pass kept in the page's memory), spin with the pass, and whether it is set up.
  vipUnlock,
  vipSpin: spinVip,
  vipStatus: vipPlayerStatus,
};

// Chat (0.17.0): any signed-in, non-disabled player, seated or not; one room per game (body.game).
const CHAT_ACTIONS = {
  chat: sendChat,
};

// Shared seat actions plus every game's own actions. Which ones a game accepts is checked per table.
const TABLE_ACTIONS = new Set([
  'sit', 'leave', 'heartbeat', 'tick', 'bet', 'bets', 'removeBet', 'confirm', 'insurance', 'hit', 'stand', 'double', 'split', 'roll', 'working',
]);

export async function handleCasinoAction(caller, body, options = {}) {
  const serverStart = Date.now(); // with serverNow, phones take the midpoint of the server's work as its clock
  const action = typeof body.action === 'string' ? body.action : '';
  let result;

  if (Object.prototype.hasOwnProperty.call(CHAT_ACTIONS, action)) {
    result = await CHAT_ACTIONS[action](caller, body, options);
  } else if (Object.prototype.hasOwnProperty.call(SLOT_ACTIONS, action)) {
    result = await SLOT_ACTIONS[action](caller, body, options);
  } else if (TABLE_ACTIONS.has(action)) {
    result = await handleTableAction(caller, body, options);
  } else {
    throw new HttpError(400, 'UNKNOWN_ACTION', action ? `Unknown casino action: ${action}` : 'Missing "action".');
  }

  return { ...result, serverStart, serverNow: Date.now() };
}
