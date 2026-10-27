// Admin player management: create, edit, disable/enable, reset password, adjust wallet.

import { randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from '../firebaseAdmin.js';
import { HttpError } from '../http.js';
import { applyWalletChange } from '../wallet.js';
import {
  DISPLAY_NAME_MAX_LENGTH,
  MAX_WALLET_CHANGE_CENTS,
  PASSWORD_MIN_LENGTH,
  USERNAME_RULES,
  isValidUsername,
  normalizeUsername,
  usernameToEmail,
} from '../../shared/constants.js';
import { cleanAgentProfile } from '../../shared/agents.js';

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'MISSING_FIELD', `Missing "${field}".`);
  }
  return value.trim();
}

function cleanDisplayName(raw, fallback) {
  const name = String(raw ?? '').trim() || fallback;
  if (name.length > DISPLAY_NAME_MAX_LENGTH) {
    throw new HttpError(400, 'BAD_DISPLAY_NAME', `Display name must be ${DISPLAY_NAME_MAX_LENGTH} characters or fewer.`);
  }
  return name;
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    throw new HttpError(400, 'BAD_PASSWORD', `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  return password;
}

function checkCents(value, { field, allowZero, allowNegative }) {
  if (!Number.isInteger(value)) {
    throw new HttpError(400, 'BAD_AMOUNT', `"${field}" must be a whole number of cents.`);
  }
  if (!allowZero && value === 0) {
    throw new HttpError(400, 'BAD_AMOUNT', `"${field}" can't be zero.`);
  }
  if (!allowNegative && value < 0) {
    throw new HttpError(400, 'BAD_AMOUNT', `"${field}" can't be negative.`);
  }
  if (Math.abs(value) > MAX_WALLET_CHANGE_CENTS) {
    throw new HttpError(400, 'BAD_AMOUNT', `"${field}" can be at most $${(MAX_WALLET_CHANGE_CENTS / 100).toLocaleString('en-US')}.`);
  }
  return value;
}

async function loadUser(uid) {
  const snap = await adminDb().collection('users').doc(uid).get();
  if (!snap.exists) throw new HttpError(404, 'USER_NOT_FOUND', 'That player does not exist.');
  return snap.data();
}

export async function createUser(body, caller) {
  const username = normalizeUsername(body.username);
  if (!isValidUsername(username)) {
    throw new HttpError(400, 'BAD_USERNAME', `Username must be ${USERNAME_RULES}`);
  }
  const password = checkPassword(body.password);
  const displayName = cleanDisplayName(body.displayName, username);
  const startingBalanceCents = checkCents(body.startingBalanceCents ?? 0, {
    field: 'startingBalanceCents',
    allowZero: true,
    allowNegative: false,
  });

  // An AI agent player (0.21.0): { provider, label }, or a normal player.
  let agent = null;
  if (body.agent !== undefined && body.agent !== null && body.agent !== false) {
    try {
      agent = cleanAgentProfile(body.agent);
    } catch (err) {
      throw new HttpError(400, 'BAD_AGENT', err.message);
    }
  }

  const db = adminDb();
  const auth = adminAuth();

  const takenSnap = await db.collection('usernames').doc(username).get();
  if (takenSnap.exists) {
    throw new HttpError(409, 'USERNAME_TAKEN', `The username "${username}" is already taken.`);
  }

  let uid = null;
  try {
    const record = await auth.createUser({
      email: usernameToEmail(username),
      password,
      displayName,
      disabled: false,
    });
    uid = record.uid;

    const now = Timestamp.now();
    const batch = db.batch();
    batch.create(db.collection('usernames').doc(username), { uid });
    batch.create(db.collection('users').doc(uid), {
      username,
      displayName,
      role: 'player',
      disabled: false,
      balanceCents: startingBalanceCents,
      adminAdjustCents: startingBalanceCents,
      stats: { won: 0, lost: 0, stakedCents: 0, returnedCents: 0, settledBets: 0, byLeague: {} },
      ...(agent ? { agent } : {}),
      createdAt: now,
    });
    if (startingBalanceCents > 0) {
      batch.create(db.collection('ledger').doc(`start_${uid}`), {
        uid,
        type: 'admin_adjust',
        amountCents: startingBalanceCents,
        balanceAfterCents: startingBalanceCents,
        betId: null,
        note: 'Starting balance',
        by: caller.uid,
        createdAt: now,
      });
    }
    await batch.commit();
  } catch (err) {
    if (uid) {
      await auth.deleteUser(uid).catch((cleanupErr) => {
        console.error('Could not remove half-created login:', cleanupErr);
      });
    }
    if (err instanceof HttpError) throw err;
    if (err?.code === 'auth/email-already-exists') {
      throw new HttpError(409, 'USERNAME_TAKEN', `The username "${username}" is already taken.`);
    }
    // Firestore ALREADY_EXISTS (gRPC code 6): someone claimed the username at the same moment.
    if (err?.code === 6) {
      throw new HttpError(409, 'USERNAME_TAKEN', `The username "${username}" is already taken.`);
    }
    throw err;
  }

  return { ok: true, uid, username, agent };
}

export async function updateUser(body) {
  const uid = requireString(body.uid, 'uid');
  const existing = await loadUser(uid);
  const displayName = cleanDisplayName(body.displayName, existing.username);
  const update = { displayName };
  // 0.21.0: `agent` in the body sets ({ provider, label }) or clears (null) the AI agent profile; absent = unchanged.
  if (Object.prototype.hasOwnProperty.call(body, 'agent')) {
    if (existing.role === 'admin' && body.agent) throw new HttpError(400, 'BAD_AGENT', "The admin account can't be an AI agent.");
    try {
      update.agent = cleanAgentProfile(body.agent);
    } catch (err) {
      throw new HttpError(400, 'BAD_AGENT', err.message);
    }
  }

  await adminAuth().updateUser(uid, { displayName });
  await adminDb().collection('users').doc(uid).update(update);
  return { ok: true, uid, displayName, ...(Object.prototype.hasOwnProperty.call(update, 'agent') ? { agent: update.agent } : {}) };
}

export async function setDisabled(body, caller) {
  const uid = requireString(body.uid, 'uid');
  if (typeof body.disabled !== 'boolean') {
    throw new HttpError(400, 'MISSING_FIELD', 'Missing "disabled" (true or false).');
  }
  if (uid === caller.uid) {
    throw new HttpError(400, 'CANNOT_DISABLE_SELF', "You can't disable your own admin account.");
  }
  await loadUser(uid);

  const auth = adminAuth();
  await auth.updateUser(uid, { disabled: body.disabled });
  if (body.disabled) {
    await auth.revokeRefreshTokens(uid);
  }
  await adminDb().collection('users').doc(uid).update({ disabled: body.disabled });
  return { ok: true, uid, disabled: body.disabled };
}

export async function resetPassword(body, caller) {
  const uid = requireString(body.uid, 'uid');
  const newPassword = checkPassword(body.newPassword);
  await loadUser(uid);

  const auth = adminAuth();
  await auth.updateUser(uid, { password: newPassword });
  // Sign the player out everywhere so the old password stops working at once.
  // Skipped for your own account so you stay signed in here.
  if (uid !== caller.uid) {
    await auth.revokeRefreshTokens(uid);
  }
  return { ok: true, uid };
}

export async function adjustWallet(body, caller) {
  const uid = requireString(body.uid, 'uid');
  const deltaCents = checkCents(body.deltaCents, { field: 'deltaCents', allowZero: false, allowNegative: true });
  const note = typeof body.note === 'string' ? body.note.trim() : '';

  const result = await applyWalletChange({
    uid,
    deltaCents,
    ledgerId: `adjust_${uid}_${randomUUID()}`,
    type: 'admin_adjust',
    note: note || 'Admin adjustment',
    by: caller.uid,
    trackAdminAdjust: true,
  });
  return { ok: true, uid, balanceCents: result.balanceCents };
}
