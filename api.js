// Calls our /api functions, attaching the signed-in user's Firebase ID token.

import { auth } from '../firebase.js';

export class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function apiRequest(path, { method = 'GET', body, requireAuth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (requireAuth) {
    const user = auth?.currentUser;
    if (!user) throw new ApiError(401, 'NOT_SIGNED_IN', 'Sign in to continue.');
    headers.Authorization = `Bearer ${await user.getIdToken()}`;
  }

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection and try again.');
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const err = data?.error;
    throw new ApiError(
      response.status,
      err?.code || `HTTP_${response.status}`,
      err?.message || `The server answered with an error (${response.status}).`,
      err || null,
    );
  }

  return data;
}

export function adminAction(action, fields = {}, { requireAuth = true } = {}) {
  return apiRequest('/api/admin', { method: 'POST', body: { action, ...fields }, requireAuth });
}
