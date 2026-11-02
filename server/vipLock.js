// The Pairadice VIP slot's lock (0.28.0). Server-authoritative; the password is never stored or logged in plain text.
//
//   meta/vipSlots        { hash, salt, version, updatedAt }  server-only (the rules' catch-all). hash = scrypt(password, salt), hex.
//                        version goes up by one on every change, so every pass made before it stops working at once.
//   vipRate/{uid}        { fails: [ms…], lastSpinAt }        server-only: wrong-password tries in the last 15 minutes (at most 5)
//                        and the last paid VIP spin (at most one every 2 s).
//
// A VIP pass is a token the server signs with HMAC-SHA256 over { uid, version, expiresAt } (2 hours). Its key is derived from the
// stored hash and salt, so a new password also changes the key. The phone keeps the pass in React state only; every VIP spin sends
// it and verifyVipPass checks the signature, the uid, the expiry and the current version before anything else.

import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from './firebaseAdmin.js';
import { HttpError } from './http.js';
import { checkProfile } from './auth.js';

const scrypt = promisify(scryptCb);

export const VIP_META_PATH = ['meta', 'vipSlots'];
export const VIP_RATE_COLLECTION = 'vipRate';
export const VIP_PASS_MS = 2 * 60 * 60 * 1000; // a pass lasts 2 hours
export const VIP_UNLOCK_TRIES = 5; // wrong tries allowed …
export const VIP_UNLOCK_WINDOW_MS = 15 * 60 * 1000; // … per 15 minutes per player
export const VIP_SPIN_GAP_MS = 2000; // at most one paid VIP spin every 2 s per player
export const VIP_PASSWORD_MIN = 6;
export const VIP_PASSWORD_MAX = 128;
const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const VIP_NOT_SET_UP_MESSAGE = "VIP isn't set up yet";
export const VIP_WRONG_MESSAGE = 'Wrong password';
export const VIP_TOO_MANY_MESSAGE = 'Too many tries, wait a few minutes';
export const VIP_LOCKED_MESSAGE = 'VIP is locked. Enter the password to play.';

export function vipMetaRef(db) {
  return db.collection(VIP_META_PATH[0]).doc(VIP_META_PATH[1]);
}

export function vipRateRef(db, uid) {
  return db.collection(VIP_RATE_COLLECTION).doc(uid);
}

export async function hashVipPassword(password, saltHex) {
  const key = await scrypt(String(password).normalize('NFC'), Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN, SCRYPT_OPTIONS);
  return key.toString('hex');
}

// Constant-time comparison of scrypt(password) with the stored hash.
export async function vipPasswordMatches(password, meta) {
  if (typeof password !== 'string' || !password || !meta?.hash || !meta?.salt) return false;
  const candidate = Buffer.from(await hashVipPassword(password, meta.salt), 'hex');
  const stored = Buffer.from(meta.hash, 'hex');
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

function isSetUp(meta) {
  return Boolean(meta && typeof meta.hash === 'string' && meta.hash && typeof meta.salt === 'string' && Number.isInteger(meta.version));
}

// The signing key: derived from the stored hash and salt (never sent anywhere).
function passKey(meta) {
  return createHmac('sha256', Buffer.from(meta.hash, 'hex')).update(`pairadice-vip-pass:${meta.salt}:${meta.version}`).digest();
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');

export function signVipPass(meta, uid, expiresAt) {
  const payload = b64(JSON.stringify({ uid, version: meta.version, expiresAt }));
  const sig = b64(createHmac('sha256', passKey(meta)).update(payload).digest());
  return `${payload}.${sig}`;
}

function locked() {
  return new HttpError(403, 'VIP_LOCKED', VIP_LOCKED_MESSAGE);
}

// Throws 403 VIP_LOCKED unless `pass` is a pass this server signed for `uid` with the current password version, not expired.
export function verifyVipPass(pass, meta, uid, nowMs) {
  if (!isSetUp(meta)) throw locked();
  if (typeof pass !== 'string' || pass.length > 1000) throw locked();
  const [payload, sig, extra] = pass.split('.');
  if (!payload || !sig || extra !== undefined) throw locked();
  const expected = createHmac('sha256', passKey(meta)).update(payload).digest();
  let given;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    throw locked();
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw locked();
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw locked();
  }
  if (!data || data.uid !== uid || data.version !== meta.version || !Number.isFinite(data.expiresAt) || data.expiresAt <= nowMs) throw locked();
  return data;
}

function passwordProblem(password) {
  if (typeof password !== 'string') return 'Enter the new password.';
  if (password.length < VIP_PASSWORD_MIN) return `Use at least ${VIP_PASSWORD_MIN} characters.`;
  if (password.length > VIP_PASSWORD_MAX) return `Use at most ${VIP_PASSWORD_MAX} characters.`;
  return '';
}

function recentFails(rate, nowMs) {
  const fails = Array.isArray(rate?.fails) ? rate.fails : [];
  return fails.filter((ms) => Number.isFinite(ms) && nowMs - ms < VIP_UNLOCK_WINDOW_MS);
}

// ---------- /api/admin ----------

// vipSetPassword { password, repeat }: stores a new salted scrypt hash and bumps the version (every pass stops working).
export async function setVipPassword(body, _caller, { now = new Date() } = {}) {
  const password = body?.password;
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, 'BAD_PASSWORD', problem);
  if (password !== body?.repeat) throw new HttpError(400, 'PASSWORDS_DIFFER', "The two passwords don't match.");
  const salt = randomBytes(16).toString('hex');
  const hash = await hashVipPassword(password, salt);
  const db = adminDb();
  const ref = vipMetaRef(db);
  const version = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const previous = snap.exists ? Number(snap.data().version) || 0 : 0;
    const next = previous + 1;
    tx.set(ref, { hash, salt, version: next, updatedAt: Timestamp.fromDate(now) });
    return next;
  });
  return { ok: true, setUp: true, version, updatedAt: now.toISOString() };
}

// vipStatus: whether a password is set and when (never the password or its hash).
export async function vipAdminStatus() {
  const snap = await vipMetaRef(adminDb()).get();
  const meta = snap.exists ? snap.data() : null;
  if (!isSetUp(meta)) return { ok: true, setUp: false, updatedAt: null };
  const at = meta.updatedAt?.toDate ? meta.updatedAt.toDate().toISOString() : null;
  return { ok: true, setUp: true, updatedAt: at };
}

// ---------- /api/casino ----------

// vipUnlock { password } → { pass, expiresAt }. Wrong → 403 "Wrong password" (the try is counted); 5 wrong tries in 15 minutes
// → 429 until the oldest one is 15 minutes old. Not set up → 409. A right password doesn't count as a try.
export async function vipUnlock(caller, body, { now = new Date() } = {}) {
  const password = typeof body?.password === 'string' ? body.password : '';
  const db = adminDb();
  const userRef = db.collection('users').doc(caller.uid);
  const metaRef = vipMetaRef(db);
  const rateRef = vipRateRef(db, caller.uid);
  const nowMs = now.getTime();

  const outcome = await db.runTransaction(async (tx) => {
    const [userSnap, metaSnap, rateSnap] = await tx.getAll(userRef, metaRef, rateRef);
    checkProfile(userSnap); // missing or disabled → refused
    const meta = metaSnap.exists ? metaSnap.data() : null;
    if (!isSetUp(meta)) return { status: 'notSetUp' };
    const rate = rateSnap.exists ? rateSnap.data() : {};
    const fails = recentFails(rate, nowMs);
    if (fails.length >= VIP_UNLOCK_TRIES) return { status: 'tooMany' };
    if (await vipPasswordMatches(password, meta)) return { status: 'ok', meta };
    tx.set(rateRef, { ...rate, fails: [...fails, nowMs], updatedAt: Timestamp.fromDate(now) });
    return { status: 'wrong' };
  });

  if (outcome.status === 'notSetUp') throw new HttpError(409, 'VIP_NOT_SET_UP', VIP_NOT_SET_UP_MESSAGE);
  if (outcome.status === 'tooMany') throw new HttpError(429, 'VIP_TOO_MANY_TRIES', VIP_TOO_MANY_MESSAGE);
  if (outcome.status === 'wrong') throw new HttpError(403, 'VIP_WRONG_PASSWORD', VIP_WRONG_MESSAGE);
  const expiresAt = nowMs + VIP_PASS_MS;
  return { ok: true, pass: signVipPass(outcome.meta, caller.uid, expiresAt), expiresAt };
}

// vipStatus (players): only whether VIP is set up, so the page can say "VIP isn't set up yet" before asking for a password.
export async function vipPlayerStatus() {
  const snap = await vipMetaRef(adminDb()).get();
  return { ok: true, setUp: isSetUp(snap.exists ? snap.data() : null) };
}

export { isSetUp as vipIsSetUp };
