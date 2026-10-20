// npm run test:chat  (or: node --experimental-test-module-mocks --test test/chat/chat.test.mjs)
// 0.17.0 casino chat: rooms never mixed, validation, disabled players, the rate limit (2 s and 20 a minute, across
// rooms), one post per requestId, admin delete (admin only), the 24 h prune, and firestore.rules (clients never write).
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Timestamp } from 'firebase-admin/firestore';
import { makeFakeDb } from '../casino/fakeFirestore.mjs';
import { loadRules } from './rulesEval.mjs';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const url = (p) => pathToFileURL(`${root}/${p}`).href;
const fake = makeFakeDb();
mock.module(url('server/firebaseAdmin.js'), { namedExports: { adminDb: () => fake.db, adminAuth: () => ({}), normalizePrivateKey: (k) => k } });

// Sign-in stand-in: the request header says who is calling; requireAdmin refuses anyone but "admin".
class AuthError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const { HttpError } = await import(url('server/http.js'));
mock.module(url('server/auth.js'), {
  namedExports: {
    requireToken: async (req) => ({ uid: req.headers.uid, token: {}, user: null }),
    requireUser: async (req) => ({ uid: req.headers.uid, token: {}, user: fake.get(`users/${req.headers.uid}`) }),
    requireAdmin: async (req) => {
      if (req.headers.uid !== 'admin') throw new HttpError(403, 'NOT_ADMIN', 'Only the admin can do that.');
      return { uid: 'admin', token: { admin: true }, user: fake.get('users/admin') };
    },
    checkProfile: (snap) => {
      if (!snap.exists) throw new HttpError(403, 'NO_PROFILE', 'No player profile exists for this login.');
      const user = snap.data();
      if (user.disabled === true) throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account has been disabled.');
      return user;
    },
  },
});
void AuthError;

const chat = await import(url('shared/casino/chat.js'));
const { sendChat, deleteChatMessage } = await import(url('server/casinoChat.js'));
const { pruneCasinoChat, PRUNE_BATCH } = await import(url('server/casinoChatPrune.js'));
const { handleCasinoAction } = await import(url('server/casino/router.js'));
const adminHandler = (await import(url('api/admin.js'))).default;

const T0 = Date.parse('2026-10-20T20:00:00Z');
const at = (ms) => new Date(T0 + ms);
let n = 0;
const rid = () => `chat-req-${String(++n).padStart(6, '0')}`;
const caller = (uid) => ({ uid, token: {}, user: null });
const send = (uid, game, text, ms = 0, requestId = rid()) => sendChat(caller(uid), { game, text, requestId }, { now: at(ms) });
const roomDocs = (game) =>
  [...fake.store.keys()].filter((k) => k.startsWith(`casinoChat/${game}/messages/`)).map((k) => ({ id: k.split('/').pop(), ...fake.get(k) }));
const allMessages = () => [...fake.store.keys()].filter((k) => k.startsWith('casinoChat/'));
const rejects = (p, code, message) =>
  assert.rejects(p, (e) => e.code === code && (message === undefined || e.message === message) ? true : assert.fail(`${e.code}: ${e.message}`));

beforeEach(() => {
  fake.reset();
  fake.write('users/mike', { username: 'mike', displayName: 'Mike the Bookie Slayer', balanceCents: 1000, disabled: false });
  fake.write('users/dan', { username: 'dan', displayName: '', balanceCents: 1000, disabled: false });
  fake.write('users/sam', { username: 'sam', displayName: 'Sam', balanceCents: 0, disabled: true });
  fake.write('users/admin', { username: 'will', displayName: 'Will', balanceCents: 0, disabled: false, role: 'admin' });
});

test('rooms never mix: each message lands in its own game room with name, text, server time, not deleted', async () => {
  await send('mike', 'craps', 'Point is 6, press it', 0);
  await send('dan', 'blackjack', 'dealer always has 20', 0);
  await send('mike', 'crapless', 'eleven!', 5000);
  const craps = roomDocs('craps');
  assert.equal(craps.length, 1);
  assert.deepEqual({ ...craps[0], createdAt: craps[0].createdAt.toMillis() }, {
    id: craps[0].id, uid: 'mike', name: 'Mike the Bookie Slayer', text: 'Point is 6, press it', createdAt: T0, deleted: false,
  });
  assert.match(craps[0].id, /^mike_chat-req-\d+$/, 'message id is {uid}_{requestId}');
  assert.deepEqual(roomDocs('blackjack').map((m) => [m.name, m.text]), [['dan', 'dealer always has 20']], 'no displayName → username');
  assert.deepEqual(roomDocs('crapless').map((m) => m.text), ['eleven!']);
  assert.equal(roomDocs('baccarat').length + roomDocs('slots').length, 0);
  // Through /api/casino's router too, seated or not (nobody here has a seat).
  const r = await handleCasinoAction(caller('dan'), { action: 'chat', game: 'slots', text: 'spin to win', requestId: rid() }, { now: at(9000) });
  assert.equal(r.ok, true);
  assert.equal(typeof r.serverNow, 'number');
  // Unknown rooms are refused before anything is read or written.
  for (const game of ['poker', 'Craps', '', undefined, '../users', 'casinoTables']) {
    await rejects(send('mike', game, 'hi', 20000), 'BAD_ROOM', chat.CHAT_ROOM_MESSAGE);
  }
  assert.equal(allMessages().length, 4);
});

test('validation: empty, 200 vs 201 characters, control characters removed, emoji count as one', async () => {
  for (const text of ['', '   ', '\n\t', '\u0000\u0007', undefined, 42]) {
    await rejects(send('mike', 'craps', text), 'EMPTY_MESSAGE', chat.CHAT_EMPTY_MESSAGE);
  }
  await rejects(send('mike', 'craps', 'x'.repeat(201)), 'MESSAGE_TOO_LONG', 'Messages can be up to 200 characters');
  assert.equal(allMessages().length, 0);
  await send('mike', 'craps', 'x'.repeat(200), 0);
  await send('mike', 'craps', `  hi\u0007\u0000 there\nnew\tline\u009b\u007f  `, 3000);
  await send('mike', 'craps', '🎲'.repeat(200), 6000); // 200 characters (400 UTF-16 units)
  const texts = roomDocs('craps').map((m) => m.text).sort((a, b) => a.length - b.length);
  assert.ok(texts.includes('hi there new line'), JSON.stringify(texts));
  assert.ok(texts.includes('x'.repeat(200)));
  assert.ok(texts.includes('🎲'.repeat(200)));
  await rejects(send('mike', 'craps', '🎲'.repeat(201), 9000), 'MESSAGE_TOO_LONG');
  // Plain text is stored as typed (escaping is the screen's job; nothing is ever rendered as HTML).
  await send('mike', 'craps', '<b>bold</b> https://example.com', 12000);
  assert.ok(roomDocs('craps').some((m) => m.text === '<b>bold</b> https://example.com'));
});

test('a disabled player (or no profile) is refused and nothing is written', async () => {
  await rejects(send('sam', 'craps', 'hello', 0), 'ACCOUNT_DISABLED');
  await rejects(send('ghost', 'craps', 'hello', 0), 'NO_PROFILE');
  assert.equal(allMessages().length, 0);
  assert.equal(fake.get('chatRate/sam'), undefined);
});

test('rate limit: 1 message per 2 s and 20 a minute per player, across every room', async () => {
  await send('mike', 'craps', 'one', 0);
  await rejects(send('mike', 'blackjack', 'two', 1999), 'SLOW_DOWN', 'Slow down a little');
  await send('dan', 'craps', 'other players are not affected', 500);
  await send('mike', 'blackjack', 'two', 2000);
  // 20 in a minute: messages at 0, 2, 4 … 38 s fill it; the 21st (40 s) is refused; once the first is a minute old it frees.
  for (let i = 2; i < 20; i += 1) await send('mike', ['craps', 'baccarat', 'slots'][i % 3], `m${i}`, i * 2000);
  await rejects(send('mike', 'crapless', 'twenty-first', 40000), 'SLOW_DOWN', 'Slow down a little');
  await rejects(send('mike', 'crapless', 'still the minute', 59999), 'SLOW_DOWN');
  await send('mike', 'crapless', 'a minute after the first', 60000);
  assert.equal(allMessages().filter((k) => k.includes('/mike_')).length, 21);
  assert.ok(fake.get('chatRate/mike').recent.length <= chat.CHAT_PER_WINDOW, 'the counter keeps at most 20 times');
  // The counter is written in the same transaction as the message: a refused send writes neither.
  const before = JSON.stringify(fake.get('chatRate/mike'));
  await rejects(send('mike', 'craps', 'too soon', 61000), 'SLOW_DOWN');
  assert.equal(JSON.stringify(fake.get('chatRate/mike')), before);
});

test('the same requestId posts once (a retry is not rate limited and not doubled)', async () => {
  const requestId = rid();
  const first = await send('mike', 'craps', 'hello', 0, requestId);
  const again = await send('mike', 'craps', 'hello', 400, requestId);
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.messageId, first.messageId);
  assert.equal(roomDocs('craps').length, 1);
  assert.deepEqual(fake.get('chatRate/mike').recent, [T0], 'the retry used no rate');
  // Another player can't reuse it (different id anyway: {uid}_{requestId}).
  await send('dan', 'craps', 'same id, other player', 500, requestId);
  assert.equal(roomDocs('craps').length, 2);
  await rejects(sendChat(caller('mike'), { game: 'craps', text: 'x', requestId: 'bad id!' }, { now: at(9000) }), 'BAD_REQUEST_ID');
});

test('admin delete: sets deleted and clears the text; admin only through /api/admin; idempotent; 404 when gone', async () => {
  const { messageId } = await send('dan', 'baccarat', 'something rude', 0);
  const res = () => ({ statusCode: 200, headers: {}, body: null, headersSent: false, setHeader(a, b) { this.headers[a] = b; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } });
  let r = res();
  await adminHandler({ method: 'POST', headers: { uid: 'mike' }, body: { action: 'chatDelete', game: 'baccarat', messageId } }, r);
  assert.equal(r.statusCode, 403, 'a player cannot delete');
  assert.equal(fake.get(`casinoChat/baccarat/messages/${messageId}`).text, 'something rude');
  r = res();
  await adminHandler({ method: 'POST', headers: { uid: 'admin' }, body: { action: 'chatDelete', game: 'baccarat', messageId } }, r);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const doc = fake.get(`casinoChat/baccarat/messages/${messageId}`);
  assert.equal(doc.deleted, true);
  assert.equal(doc.text, '');
  assert.equal(doc.deletedBy, 'admin');
  assert.equal(doc.uid, 'dan', 'who sent it stays');
  assert.equal((await deleteChatMessage({ game: 'baccarat', messageId }, { uid: 'admin' })).already, true);
  await rejects(deleteChatMessage({ game: 'baccarat', messageId: 'nope_x' }, { uid: 'admin' }), 'MESSAGE_NOT_FOUND');
  await rejects(deleteChatMessage({ game: 'craps', messageId }, { uid: 'admin' }), 'MESSAGE_NOT_FOUND', undefined, 'another room');
  await rejects(deleteChatMessage({ game: 'poker', messageId }, { uid: 'admin' }), 'BAD_ROOM');
  await rejects(deleteChatMessage({ game: 'baccarat', messageId: '../x' }, { uid: 'admin' }), 'BAD_MESSAGE_ID');
});

test('the 24 h prune deletes only older messages, in batches of 500, the cron always and other runs once an hour', async () => {
  const now = new Date(T0);
  const put = (game, id, ageMs) =>
    fake.write(`casinoChat/${game}/messages/${id}`, { uid: 'mike', name: 'Mike', text: id, createdAt: Timestamp.fromMillis(T0 - ageMs), deleted: false });
  const DAY = chat.CHAT_KEEP_MS;
  put('craps', 'old', DAY + 1000);
  put('craps', 'edge-old', DAY + 1);
  put('craps', 'edge-new', DAY - 1);
  put('craps', 'fresh', 60 * 1000);
  put('slots', 'old-slots', 3 * DAY);
  for (let i = 0; i < 1203; i += 1) put('blackjack', `bulk${String(i).padStart(4, '0')}`, DAY + 5000 + i);
  put('blackjack', 'bj-fresh', 1000);
  fake.resetCounts();
  const first = await pruneCasinoChat({ db: fake.db, now, force: false });
  assert.deepEqual(first, { ran: true, deleted: 1203 + 3 });
  assert.deepEqual(roomDocs('craps').map((m) => m.id).sort(), ['edge-new', 'fresh']);
  assert.deepEqual(roomDocs('blackjack').map((m) => m.id), ['bj-fresh']);
  assert.equal(roomDocs('slots').length, 0);
  assert.equal(PRUNE_BATCH, 500);
  assert.ok(fake.counts.commits >= 3 + 1, 'blackjack took 3 batches (500 + 500 + 203)');
  // Another non-cron run within the hour does nothing; after an hour it runs; the cron always runs.
  put('craps', 'old2', DAY + 10);
  assert.deepEqual(await pruneCasinoChat({ db: fake.db, now: new Date(T0 + 30 * 60 * 1000), force: false }), { ran: false, deleted: 0 });
  assert.ok(roomDocs('craps').some((m) => m.id === 'old2'));
  // 30 min later 'edge-new' has crossed 24 h as well: old2 + edge-new go.
  assert.deepEqual(await pruneCasinoChat({ db: fake.db, now: new Date(T0 + 30 * 60 * 1000 + 1), force: true }), { ran: true, deleted: 2 });
  assert.deepEqual(roomDocs('craps').map((m) => m.id), ['fresh']);
  put('craps', 'old3', DAY + 10);
  assert.equal((await pruneCasinoChat({ db: fake.db, now: new Date(T0 + 60 * 60 * 1000), force: false })).ran, false, 'the cron run reset the hour');
  assert.equal((await pruneCasinoChat({ db: fake.db, now: new Date(T0 + 91 * 60 * 1000), force: false })).deleted, 1);
});

test('settlement runs prune the chat (the daily cron always)', async () => {
  const { settleOpenBets } = await import(url('server/settlement.js'));
  fake.write('casinoChat/craps/messages/old', { uid: 'mike', name: 'Mike', text: 'old', createdAt: Timestamp.fromMillis(T0 - chat.CHAT_KEEP_MS - 1), deleted: false });
  fake.write('casinoChat/craps/messages/new', { uid: 'mike', name: 'Mike', text: 'new', createdAt: Timestamp.fromMillis(T0 - 1000), deleted: false });
  const summary = await settleOpenBets({ trigger: 'cron', force: true, now: new Date(T0), fetchImpl: async () => { throw new Error('no network'); } });
  assert.deepEqual(summary.chatPruned, { ran: true, deleted: 1 });
  assert.equal(summary.errors, 0);
  assert.deepEqual(roomDocs('craps').map((m) => m.id), ['new']);
});

test('firestore.rules: signed-in players read the chat; nobody writes it (or the rate counter) from a client', () => {
  const allowed = loadRules(`${root}/firestore.rules`);
  const player = { uid: 'mike', token: {} };
  const admin = { uid: 'will', token: { admin: true } };
  const msg = { uid: 'mike', name: 'Mike', text: 'hi', deleted: false };
  for (const room of ['craps', 'blackjack']) {
    assert.equal(allowed({ method: 'get', path: `casinoChat/${room}/messages/m1`, auth: player, data: msg }), true);
    assert.equal(allowed({ method: 'list', path: `casinoChat/${room}/messages/m1`, auth: player, data: msg }), true);
    assert.equal(allowed({ method: 'get', path: `casinoChat/${room}/messages/m1`, auth: null, data: msg }), false, 'signed out');
    for (const who of [player, admin, null]) {
      for (const method of ['create', 'update', 'delete']) {
        assert.equal(allowed({ method, path: `casinoChat/${room}/messages/mike_x`, auth: who, data: msg }), false, `${method} by ${who?.uid ?? 'nobody'}`);
      }
    }
  }
  for (const method of ['get', 'create', 'update']) assert.equal(allowed({ method, path: 'chatRate/mike', auth: player, data: { recent: [] } }), false);
  assert.equal(allowed({ method: 'get', path: 'casinoChat/craps', auth: player, data: {} }), false, 'only messages are readable');
  // The evaluator agrees with the rest of the file (known answers).
  assert.equal(allowed({ method: 'get', path: 'ledger/x', auth: player, data: { uid: 'mike' } }), true);
  assert.equal(allowed({ method: 'get', path: 'ledger/x', auth: player, data: { uid: 'dan' } }), false);
  assert.equal(allowed({ method: 'get', path: 'ledger/x', auth: admin, data: { uid: 'dan' } }), true);
  assert.equal(allowed({ method: 'update', path: 'users/mike', auth: player, data: {} }), false);
  assert.equal(allowed({ method: 'get', path: 'battles/b1', auth: player, data: { participantUids: ['mike'] } }), true);
  assert.equal(allowed({ method: 'get', path: 'battles/b1', auth: player, data: { participantUids: ['dan'] } }), false);
  assert.equal(allowed({ method: 'get', path: 'casinoTables/craps', auth: player, data: {} }), true);
  assert.equal(allowed({ method: 'get', path: 'casinoTables/craps/private/shoe', auth: admin, data: {} }), false);
});
