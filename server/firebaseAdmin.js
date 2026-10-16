// Firebase Admin SDK, initialized once per function instance from Vercel environment variables.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { HttpError } from './http.js';

// Accepts the private key with real line breaks or with literal "\n" sequences,
// and tolerates quotes copied from the JSON file around the value.
export function normalizePrivateKey(raw) {
  let key = String(raw ?? '').trim();
  const quoted =
    (key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"));
  if (quoted && key.length >= 2) {
    key = key.slice(1, -1);
  }
  key = key.replace(/\\r/g, '').replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
  if (!key.endsWith('\n')) key += '\n';
  return key;
}

function readServiceAccount() {
  const projectId = (process.env.FIREBASE_PROJECT_ID || '').trim();
  const clientEmail = (process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const rawKey = process.env.FIREBASE_PRIVATE_KEY || '';

  const missing = [];
  if (!projectId) missing.push('FIREBASE_PROJECT_ID');
  if (!clientEmail) missing.push('FIREBASE_CLIENT_EMAIL');
  if (!rawKey.trim()) missing.push('FIREBASE_PRIVATE_KEY');
  if (missing.length > 0) {
    throw new HttpError(
      500,
      'SERVER_NOT_CONFIGURED',
      `Missing Vercel environment variables: ${missing.join(', ')}. Add them, then redeploy.`,
    );
  }

  const privateKey = normalizePrivateKey(rawKey);
  if (!privateKey.includes('-----BEGIN PRIVATE KEY-----') || !privateKey.includes('-----END PRIVATE KEY-----')) {
    throw new HttpError(
      500,
      'SERVER_NOT_CONFIGURED',
      'FIREBASE_PRIVATE_KEY does not look like a private key. Paste the whole private_key value, including the BEGIN and END lines.',
    );
  }

  return { projectId, clientEmail, privateKey };
}

function adminApp() {
  const existing = getApps();
  if (existing.length > 0) return existing[0];
  try {
    return initializeApp({ credential: cert(readServiceAccount()) });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error('Firebase Admin initialization failed:', err);
    throw new HttpError(
      500,
      'SERVER_NOT_CONFIGURED',
      'Firebase Admin could not start. Check FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in Vercel.',
    );
  }
}

export function adminAuth() {
  return getAuth(adminApp());
}

export function adminDb() {
  return getFirestore(adminApp());
}
