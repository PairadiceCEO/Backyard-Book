// Verifies the caller's Firebase ID token and loads their player profile.

import { adminAuth, adminDb } from './firebaseAdmin.js';
import { HttpError } from './http.js';

function readBearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : '';
}

// Verifies the ID token only (the token check is local, against Google's cached keys). Callers that
// read the users doc anyway (the casino reads it inside its transaction) check "disabled" there, so the
// profile is read once per request instead of twice.
export async function requireToken(req) {
  const idToken = readBearerToken(req);
  if (!idToken) {
    throw new HttpError(401, 'NOT_SIGNED_IN', 'Sign in to continue.');
  }
  try {
    const decoded = await adminAuth().verifyIdToken(idToken, false);
    return { uid: decoded.uid, token: decoded, user: null };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err?.code === 'auth/user-disabled') {
      throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account has been disabled.');
    }
    throw new HttpError(401, 'BAD_TOKEN', 'Your session has expired. Sign in again.');
  }
}

// The users doc as read inside a transaction: refuses missing and disabled profiles.
export function checkProfile(snap) {
  if (!snap.exists) throw new HttpError(403, 'NO_PROFILE', 'No player profile exists for this login.');
  const user = snap.data();
  if (user.disabled === true) throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account has been disabled.');
  return user;
}

export async function requireUser(req, { checkRevoked = false } = {}) {
  const idToken = readBearerToken(req);
  if (!idToken) {
    throw new HttpError(401, 'NOT_SIGNED_IN', 'Sign in to continue.');
  }

  let decoded;
  try {
    decoded = await adminAuth().verifyIdToken(idToken, checkRevoked);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err?.code === 'auth/user-disabled') {
      throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account has been disabled.');
    }
    throw new HttpError(401, 'BAD_TOKEN', 'Your session has expired. Sign in again.');
  }

  const snap = await adminDb().collection('users').doc(decoded.uid).get();
  if (!snap.exists) {
    throw new HttpError(403, 'NO_PROFILE', 'No player profile exists for this login.');
  }
  const user = snap.data();
  if (user.disabled === true) {
    throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account has been disabled.');
  }

  return { uid: decoded.uid, token: decoded, user };
}

export async function requireAdmin(req) {
  const caller = await requireUser(req, { checkRevoked: true });
  if (caller.token.admin !== true) {
    throw new HttpError(403, 'NOT_ADMIN', 'Only the admin can do that.');
  }
  return caller;
}
