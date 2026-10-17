// In-memory Firestore for server tests: nested collections, optimistic transactions that interleave
// and retry on conflict like the real thing, create() failing on existing docs, and "reads after writes"
// refused. Counts reads/writes per path prefix so tests can check costs, and network round trips (rpcs).
// setLatency({ rpcMs, commitMs }) makes every round trip wait, to benchmark how many a call makes in series.
export function makeFakeDb() {
  const store = new Map();
  const versions = new Map();
  const counts = { reads: 0, writes: 0, commits: 0, retries: 0, rpcs: 0, byPrefix: {} };
  const latency = { rpcMs: 0, commitMs: 0 };
  const network = async (extra = 0) => {
    counts.rpcs += 1;
    const ms = latency.rpcMs + extra;
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  };
  let clock = 0;
  const clone = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (typeof v.toMillis === 'function') return v;
    if (Array.isArray(v)) return v.map(clone);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  };
  const pause = () => new Promise((r) => setImmediate(r));
  const bump = (kind, path) => {
    counts[kind] += 1;
    const prefix = path.split('/').slice(0, path.split('/').length - 1).join('/');
    counts.byPrefix[`${kind}:${prefix}`] = (counts.byPrefix[`${kind}:${prefix}`] ?? 0) + 1;
  };
  function write(path, data) {
    if (data === undefined) store.delete(path); else store.set(path, clone(data));
    versions.set(path, ++clock);
  }
  function snap(path) {
    const d = store.get(path);
    return { exists: d !== undefined, id: path.split('/').pop(), data: () => clone(d) };
  }
  function docRef(path) {
    return {
      path,
      id: path.split('/').pop(),
      collection: (name) => collectionRef(`${path}/${name}`),
      async get() { await network(); await pause(); bump('reads', path); return snap(path); },
    };
  }
  function collectionRef(path) {
    return { path, doc: (id) => docRef(`${path}/${id}`) };
  }
  class AlreadyExists extends Error { constructor(p) { super(`ALREADY_EXISTS ${p}`); this.code = 6; } }
  const db = {
    collection: (name) => collectionRef(name),
    doc: (path) => docRef(path),
    async runTransaction(fn) {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const reads = new Map();
        const ops = [];
        const tx = {
          get: async (r) => {
            if (ops.length) throw new Error('Firestore transactions require all reads to be executed before all writes.');
            reads.set(r.path, versions.get(r.path) ?? 0);
            await network();
            await pause();
            bump('reads', r.path);
            return snap(r.path);
          },
          // One round trip for any number of docs, like the Admin SDK's batchGet.
          getAll: async (...refs) => {
            if (ops.length) throw new Error('Firestore transactions require all reads to be executed before all writes.');
            for (const r of refs) reads.set(r.path, versions.get(r.path) ?? 0);
            await network();
            await pause();
            return refs.map((r) => {
              bump('reads', r.path);
              return snap(r.path);
            });
          },
          create: (r, d) => ops.push(['create', r.path, d]),
          update: (r, d) => ops.push(['update', r.path, d]),
          set: (r, d) => ops.push(['set', r.path, d]),
          delete: (r) => ops.push(['delete', r.path]),
        };
        const result = await fn(tx);
        await network(latency.commitMs); // the commit
        await pause();
        if ([...reads].some(([p, v]) => (versions.get(p) ?? 0) !== v)) { counts.retries += 1; continue; }
        for (const [k, p] of ops) if (k === 'create' && store.has(p)) throw new AlreadyExists(p);
        for (const [k, p] of ops) if (k === 'update' && !store.has(p)) throw new Error(`NOT_FOUND ${p}`);
        for (const [k, p, d] of ops) {
          write(p, k === 'delete' ? undefined : k === 'update' ? { ...store.get(p), ...d } : d);
          bump('writes', p);
        }
        counts.commits += 1;
        return result;
      }
      throw new Error('contention');
    },
  };
  return {
    db,
    store,
    counts,
    write,
    get: (path) => clone(store.get(path)),
    reset() { store.clear(); versions.clear(); for (const k of Object.keys(counts)) counts[k] = k === 'byPrefix' ? {} : 0; },
    resetCounts() { for (const k of Object.keys(counts)) counts[k] = k === 'byPrefix' ? {} : 0; },
    setLatency({ rpcMs = 0, commitMs = 0 } = {}) { latency.rpcMs = rpcMs; latency.commitMs = commitMs; },
  };
}
