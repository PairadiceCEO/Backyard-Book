import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import assert from 'node:assert/strict';

const root = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url));
const { normalizePrivateKey } = await import(`${root}/server/firebaseAdmin.js`);
const handler = (await import(`${root}/api/admin.js`)).default;

// 1. Private key accepted with real line breaks, literal \n, and wrapping quotes.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const literal = pem.replace(/\n/g, '\\n');
assert.equal(normalizePrivateKey(pem), pem);
assert.equal(normalizePrivateKey(literal), pem);
assert.equal(normalizePrivateKey(`"${literal}"`), pem);
assert.equal(normalizePrivateKey(literal.replace(/\\n$/, '')), pem);
console.log('ok: private key parsing (real breaks, literal \\n, quotes, missing trailing newline)');

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined, headersSent: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
  };
}
async function call(method, body, headers = {}) {
  const res = mockRes();
  await handler({ method, body, headers }, res);
  return res;
}

// 2. Method guard.
let r = await call('GET');
assert.equal(r.statusCode, 405);
assert.equal(r.headers.Allow, 'POST');
console.log('ok: GET rejected with 405');

// 3. Bad JSON string body.
r = await call('POST', '{not json');
assert.equal(r.statusCode, 400);
assert.equal(r.body.error.code, 'BAD_JSON');
console.log('ok: bad JSON rejected');

// 4. Bootstrap without SETUP_SECRET.
delete process.env.SETUP_SECRET;
r = await call('POST', { action: 'bootstrap', setupSecret: 'x', username: 'will', password: 'longpassword' });
assert.equal(r.statusCode, 503);
assert.equal(r.body.error.code, 'SETUP_DISABLED');
console.log('ok: bootstrap refused when SETUP_SECRET is unset');

// 5. Wrong secret.
process.env.SETUP_SECRET = 'correct horse battery staple';
r = await call('POST', { action: 'bootstrap', setupSecret: 'nope', username: 'will', password: 'longpassword' });
assert.equal(r.statusCode, 401);
assert.equal(r.body.error.code, 'BAD_SETUP_SECRET');
console.log('ok: wrong setup secret rejected');

// 6. Right secret, bad username / password (validated before touching Firebase).
r = await call('POST', { action: 'bootstrap', setupSecret: 'correct horse battery staple', username: 'Bad Name!', password: 'longpassword' });
assert.equal(r.statusCode, 400);
assert.equal(r.body.error.code, 'BAD_USERNAME');
r = await call('POST', { action: 'bootstrap', setupSecret: 'correct horse battery staple', username: 'will', password: 'short' });
assert.equal(r.statusCode, 400);
assert.equal(r.body.error.code, 'BAD_PASSWORD');
console.log('ok: username and password validation');

// 7. Valid input but Firebase env missing → clear configuration error, not a crash.
delete process.env.FIREBASE_PROJECT_ID;
delete process.env.FIREBASE_CLIENT_EMAIL;
delete process.env.FIREBASE_PRIVATE_KEY;
r = await call('POST', { action: 'bootstrap', setupSecret: 'correct horse battery staple', username: 'will', password: 'longpassword' });
assert.equal(r.statusCode, 500);
assert.equal(r.body.error.code, 'SERVER_NOT_CONFIGURED');
assert.match(r.body.error.message, /FIREBASE_PROJECT_ID/);
r = await call('POST', { action: 'setupStatus' });
assert.equal(r.body.error.code, 'SERVER_NOT_CONFIGURED');
console.log('ok: missing Firebase variables reported by name');

// 8. Garbage private key reported clearly.
process.env.FIREBASE_PROJECT_ID = 'demo';
process.env.FIREBASE_CLIENT_EMAIL = 'x@demo.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY = 'not a key';
r = await call('POST', { action: 'setupStatus' });
assert.equal(r.body.error.code, 'SERVER_NOT_CONFIGURED');
assert.match(r.body.error.message, /does not look like a private key/);
console.log('ok: malformed private key reported');

// 9. Admin-only action without a token.
r = await call('POST', { action: 'ping' });
assert.equal(r.statusCode, 401);
assert.equal(r.body.error.code, 'NOT_SIGNED_IN');
console.log('ok: ping requires sign-in');

console.log('ALL SERVER CHECKS PASSED');
