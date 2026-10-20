// Casino chat rules shared by /api/casino (authoritative) and the phone (counter, message cleanup, room names).
//
// One room per casino game, never mixed: casinoChat/{room}/messages/{uid}_{requestId}
//   { uid, name, text, createdAt (server time), deleted }
// Only the server writes (firestore.rules: signed-in players read, nobody writes). Messages are kept 24 hours; the
// settlement run prunes older ones (server/casinoChat.js pruneCasinoChat).

export const CHAT_ROOMS = ['slots', 'blackjack', 'baccarat', 'craps', 'crapless'];
export const CHAT_ROOM_NAMES = { slots: '7s Slots', blackjack: 'Blackjack', baccarat: 'Baccarat', craps: 'Craps', crapless: 'Crapless Craps' };

export const CHAT_MAX_CHARS = 200;
export const CHAT_KEEP_MS = 24 * 60 * 60 * 1000; // messages older than this are hidden and pruned
export const CHAT_PAGE = 30; // the drawer shows the newest 30 of the last 24 hours

// Rate limit per player across all rooms.
export const CHAT_MIN_GAP_MS = 2000; // at most 1 message per 2 s
export const CHAT_WINDOW_MS = 60 * 1000;
export const CHAT_PER_WINDOW = 20; // at most 20 per minute

export const CHAT_SLOW_MESSAGE = 'Slow down a little';
export const CHAT_TOO_LONG_MESSAGE = `Messages can be up to ${CHAT_MAX_CHARS} characters`;
export const CHAT_EMPTY_MESSAGE = 'Type a message first';
export const CHAT_ROOM_MESSAGE = "That chat room doesn't exist.";
export const CHAT_REMOVED_TEXT = 'Message removed';

export function isChatRoom(room) {
  return typeof room === 'string' && CHAT_ROOMS.includes(room);
}

// "Craps chat"
export function chatRoomTitle(room) {
  return `${CHAT_ROOM_NAMES[room] ?? 'Casino'} chat`;
}

// Tabs, new lines and other whitespace controls become a space; every other control character (C0, DEL, C1) is
// dropped; then trimmed. Plain text only: nothing here is ever rendered as HTML.
export function cleanChatText(raw) {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    if (code === 9 || code === 10 || code === 11 || code === 12 || code === 13) out += ' ';
    else if (code < 32 || (code >= 127 && code <= 159)) continue;
    else out += ch;
  }
  return out.trim();
}

// Length as a person counts it: one per character (an emoji is one), not UTF-16 units.
export function chatLength(text) {
  return [...String(text ?? '')].length;
}

// '' when the cleaned text can be sent, else the refusal.
export function chatTextProblem(cleaned) {
  const n = chatLength(cleaned);
  if (n === 0) return CHAT_EMPTY_MESSAGE;
  if (n > CHAT_MAX_CHARS) return CHAT_TOO_LONG_MESSAGE;
  return '';
}

// Rate limit: `recent` = this player's send times (ms) as kept in chatRate/{uid}. Returns '' or CHAT_SLOW_MESSAGE.
export function chatRateProblem(recent, nowMs) {
  const times = (Array.isArray(recent) ? recent : []).filter((t) => Number.isFinite(t) && t <= nowMs);
  const last = times.length ? Math.max(...times) : null;
  if (last !== null && nowMs - last < CHAT_MIN_GAP_MS) return CHAT_SLOW_MESSAGE;
  const inWindow = times.filter((t) => nowMs - t < CHAT_WINDOW_MS).length;
  if (inWindow >= CHAT_PER_WINDOW) return CHAT_SLOW_MESSAGE;
  return '';
}

// The times to keep after a send: the ones still inside the minute, plus now (at most CHAT_PER_WINDOW).
export function nextChatRate(recent, nowMs) {
  const times = (Array.isArray(recent) ? recent : []).filter((t) => Number.isFinite(t) && t <= nowMs && nowMs - t < CHAT_WINDOW_MS);
  return [...times, nowMs].slice(-CHAT_PER_WINDOW);
}

export const CHAT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,140}$/;
