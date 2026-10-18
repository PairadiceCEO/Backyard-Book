// Fake Firestore reads: window.__H.fs[collection] = [{ id, ...data }] or { error: 'msg' }; window.__H.fsDelay ms.
const H = () => window.__H || {};
const ts = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? { toDate: () => new Date(v), toMillis: () => Date.parse(v), seconds: Date.parse(v) / 1000 } : v);
function hydrate(obj) {
  if (Array.isArray(obj)) return obj.map(hydrate);
  if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, hydrate(v)]));
  return ts(obj);
}
export function getFirestore() { return {}; }
export function collection(db, name) { return { kind: 'collection', name }; }
export function doc(db, name, id) { return { kind: 'doc', name, id }; }
export function where(field, op, value) { return { type: 'where', field, op, value }; }
export function orderBy(field, dir = 'asc') { return { type: 'orderBy', field, dir }; }
export function limit(n) { return { type: 'limit', n }; }
export function startAfter(docSnap) { return { type: 'startAfter', id: docSnap?.id }; }
export function query(c, ...constraints) { return { ...c, constraints }; }
function rows(target) {
  const src = (H().fs || {})[target.name];
  if (src && src.error) return { error: src.error };
  let list = (src || []).map((d) => ({ ...d }));
  for (const c of target.constraints || []) {
    if (c.type === 'where' && c.op === '==') list = list.filter((d) => d[c.field] === c.value);
    if (c.type === 'where' && c.op === 'array-contains') list = list.filter((d) => Array.isArray(d[c.field]) && d[c.field].includes(c.value));
    if (c.type === 'orderBy') list.sort((a, b) => (a[c.field] < b[c.field] ? -1 : a[c.field] > b[c.field] ? 1 : 0) * (c.dir === 'desc' ? -1 : 1));
    if (c.type === 'startAfter') { const i = list.findIndex((d) => d.id === c.id); list = i >= 0 ? list.slice(i + 1) : list; }
    if (c.type === 'limit') list = list.slice(0, c.n);
  }
  return { list };
}
function docSnap(d, id) { return { id, exists: () => Boolean(d), data: () => (d ? hydrate(Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'id'))) : undefined) }; }
function snapshotFor(target) {
  if (target.kind === 'doc') {
    const src = (H().fs || {})[target.name];
    if (src && src.error) return { error: src.error };
    const d = (src || []).find((x) => x.id === target.id);
    return { snap: docSnap(d, target.id) };
  }
  const r = rows(target);
  if (r.error) return r;
  const docs = r.list.map((d) => docSnap(d, d.id));
  return { snap: { docs, size: docs.length, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn) } };
}
export function onSnapshot(target, next, error) {
  const t = setTimeout(() => {
    const r = snapshotFor(target);
    if (r.error) error?.(Object.assign(new Error(r.error), { code: 'permission-denied' }));
    else next(r.snap);
  }, H().fsDelay ?? 30);
  return () => clearTimeout(t);
}
export async function getDocs(target) {
  window.__H.getDocsCalls = (window.__H.getDocsCalls ?? 0) + 1; // the phone check counts one-off reads
  const r = snapshotFor(target);
  if (r.error) throw new Error(r.error);
  return r.snap;
}
