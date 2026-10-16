// Shared cache: memory (this function instance) → Firestore cache/{key} (all instances) → rebuild.
// If a rebuild fails, the newest older copy is returned and marked stale.

import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from './firebaseAdmin.js';

const memory = new Map(); // key -> { fetchedAtMs, value }
const inflight = new Map(); // key -> Promise

// Firestore rejects undefined values; a JSON round-trip drops them.
function toStorable(value) {
  return JSON.parse(JSON.stringify(value));
}

export async function getOrRefresh(key, ttlMs, builder, { now = Date.now } = {}) {
  const startedAt = now();
  const mem = memory.get(key);
  if (mem && startedAt - mem.fetchedAtMs < ttlMs) {
    return { fetchedAtMs: mem.fetchedAtMs, value: mem.value, stale: false, cacheHit: 'memory' };
  }

  if (inflight.has(key)) return inflight.get(key);

  const work = (async () => {
    const ref = adminDb().collection('cache').doc(key);

    let stored = null;
    try {
      const snap = await ref.get();
      if (snap.exists) {
        const data = snap.data();
        if (Number.isFinite(data.fetchedAtMs) && data.value !== undefined) {
          stored = { fetchedAtMs: data.fetchedAtMs, value: data.value };
        }
      }
    } catch (err) {
      console.error(`cache read ${key} failed:`, err.message);
    }

    if (stored && startedAt - stored.fetchedAtMs < ttlMs) {
      memory.set(key, stored);
      return { ...stored, stale: false, cacheHit: 'firestore' };
    }

    try {
      const value = toStorable(await builder());
      const fetchedAtMs = now();
      const entry = { fetchedAtMs, value };
      memory.set(key, entry);
      try {
        await ref.set({ fetchedAtMs, fetchedAt: Timestamp.fromMillis(fetchedAtMs), value });
      } catch (err) {
        console.error(`cache write ${key} failed:`, err.message);
      }
      return { ...entry, stale: false, cacheHit: 'none' };
    } catch (err) {
      const fallback = [mem, stored].filter(Boolean).sort((a, b) => b.fetchedAtMs - a.fetchedAtMs)[0];
      if (fallback) {
        console.error(`rebuild ${key} failed, serving stale copy:`, err.message);
        return { fetchedAtMs: fallback.fetchedAtMs, value: fallback.value, stale: true, cacheHit: 'stale' };
      }
      throw err;
    }
  })();

  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}

// Test helper: forget this instance's memory copies.
export function clearMemoryCache() {
  memory.clear();
  inflight.clear();
}
