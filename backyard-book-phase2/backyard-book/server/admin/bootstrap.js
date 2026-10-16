// One-time creation of the admin account from the /setup page.
// Requires SETUP_SECRET and refuses to run once an admin exists.

import { createHash, timingSafeEqual } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from '../firebaseAdmin.js';
import { HttpError } from '../http.js';
import {
  DISPLAY_NAME_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_RULES,
  isValidUsername,
  normalizeUsername,
  usernameToEmail,
} from '../../shared/constants.js';

const STALE_RESERVATION_MS = 2 * 60 * 1000;

function secretsMatch(given, expected) {
  const a = createHash('sha256').update(String(given)).digest();
  const b = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

async function adminAlreadyExists(db) {
  const setupSnap = await db.doc('meta/setup').get();
  if (setupSnap.exists && setupSnap.data().status === 'done') return true;
  const admins = await db.collection('users').where('role', '==', 'admin').limit(1).get();
  return !admins.empty;
}

export async function getSetupStatus() {
  const db = adminDb();
  return { done: await adminAlreadyExists(db) };
}

function validateInput(body) {
  const username = normalizeUsername(body.username);
  const password = typeof body.password === 'string' ? body.password : '';
  const displayName = String(body.displayName ?? '').trim() || username;

  if (!isValidUsername(username)) {
    throw new HttpError(400, 'BAD_USERNAME', `Username must be ${USERNAME_RULES}`);
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new HttpError(400, 'BAD_PASSWORD', `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    throw new HttpError(400, 'BAD_DISPLAY_NAME', `Display name must be ${DISPLAY_NAME_MAX_LENGTH} characters or fewer.`);
  }
  return { username, password, displayName };
}

export async function bootstrapAdmin(body) {
  const expectedSecret = process.env.SETUP_SECRET || '';
  if (!expectedSecret.trim()) {
    throw new HttpError(503, 'SETUP_DISABLED', 'SETUP_SECRET is not set in Vercel. Add it, redeploy, and try again.');
  }
  if (typeof body.setupSecret !== 'string' || !secretsMatch(body.setupSecret, expectedSecret)) {
    throw new HttpError(401, 'BAD_SETUP_SECRET', 'That setup secret is not correct.');
  }

  const { username, password, displayName } = validateInput(body);
  const db = adminDb();
  const auth = adminAuth();
  const setupRef = db.doc('meta/setup');

  if (await adminAlreadyExists(db)) {
    throw new HttpError(409, 'ALREADY_SET_UP', 'Setup is already complete. Sign in instead.');
  }

  // Reserve the setup slot so two submissions can't both create an admin.
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(setupRef);
    if (snap.exists) {
      const data = snap.data();
      if (data.status === 'done') {
        throw new HttpError(409, 'ALREADY_SET_UP', 'Setup is already complete. Sign in instead.');
      }
      const startedMs = data.startedAt?.toMillis?.() ?? 0;
      if (Date.now() - startedMs < STALE_RESERVATION_MS) {
        throw new HttpError(409, 'SETUP_IN_PROGRESS', 'Setup is already running. Wait a minute and refresh.');
      }
    }
    tx.set(setupRef, { status: 'in_progress', startedAt: Timestamp.now() });
  });

  let createdUid = null;
  try {
    const userRecord = await auth.createUser({
      email: usernameToEmail(username),
      password,
      displayName,
      disabled: false,
    });
    createdUid = userRecord.uid;

    await auth.setCustomUserClaims(createdUid, { admin: true });

    const now = Timestamp.now();
    const batch = db.batch();
    batch.create(db.collection('users').doc(createdUid), {
      username,
      displayName,
      role: 'admin',
      disabled: false,
      balanceCents: 0,
      stats: { won: 0, lost: 0 },
      createdAt: now,
    });
    batch.create(db.collection('usernames').doc(username), { uid: createdUid });
    batch.set(setupRef, { status: 'done', adminUid: createdUid, createdAt: now });
    await batch.commit();

    return { ok: true, username };
  } catch (err) {
    // Undo partial work so setup can be retried cleanly.
    if (createdUid) {
      await auth.deleteUser(createdUid).catch((cleanupErr) => {
        console.error('Could not remove the half-created admin login:', cleanupErr);
      });
    }
    await setupRef.delete().catch((cleanupErr) => {
      console.error('Could not clear the setup reservation:', cleanupErr);
    });

    if (err instanceof HttpError) throw err;
    if (err?.code === 'auth/email-already-exists') {
      throw new HttpError(409, 'USERNAME_TAKEN', 'That username is already used by another login.');
    }
    if (err?.code === 'auth/invalid-password') {
      throw new HttpError(400, 'BAD_PASSWORD', `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
    }
    throw err;
  }
}
