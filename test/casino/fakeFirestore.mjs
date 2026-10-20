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
    return { exists: d !== undefined, id: path.split('/').pop(), ref: { path }, data: () => clone(d) };
  }
  function docRef(path) {
    return {
      path,
      id: path.split('/').pop(),
      collection: (name) => collectionRef(`${path}/${name}`),
      async get() { await network(); await pause(); bump('reads', path); return snap(path); },
      // Single writes outside a transaction.
      async set(data, opts = {}) { await network(); write(path, opts.merge ? { ...(store.get(path) ?? {}), ...data } : data); bump('writes', path); },
      async update(data) { await network(); if (!store.has(path)) throw new Error(`NOT_FOUND ${path}`); write(path, { ...store.get(path), ...data }); bump('writes', path); },
      async delete() { await network(); write(path, undefined); bump('writes', path); },
    };
  }
  // Queries outside transactions (direct children only): where (==, !=, <, <=, >, >=, in), chained; orderBy (asc /
  // desc, then document id); limit; startAfter(docSnapshot); get(); aggregate({ alias: count() | sum(field) }).get()
  // (one read per 1,000 matches, at least one, like Firestore). Timestamps compare by toMillis().
  const cmpVal = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v);
  const OPS = {
    '==': (a, b) => cmpVal(a) === cmpVal(b),
    '!=': (a, b) => a !== undefined && cmpVal(a) !== cmpVal(b),
    '<': (a, b) => a !== undefined && a !== null && cmpVal(a) < cmpVal(b),
    '<=': (a, b) => a !== undefined && a !== null && cmpVal(a) <= cmpVal(b),
    '>': (a, b) => a !== undefined && a !== null && cmpVal(a) > cmpVal(b),
    '>=': (a, b) => a !== undefined && a !== null && cmpVal(a) >= cmpVal(b),
    in: (a, b) => Array.isArray(b) && b.some((x) => cmpVal(x) === cmpVal(a)),
  };
  function query(path, spec = { filters: [], orders: [], max: Infinity, after: null }) {
    const next = (patch) => query(path, { ...spec, ...patch });
    const matches = () => {
      let rows = [...store.entries()]
        .filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
        .filter(([, d]) => spec.filters.every(([f, op, v]) => OPS[op](d?.[f], v)));
      if (spec.orders.length) {
        const cmp = (a, b) => {
          for (const [f, dir] of spec.orders) {
            const x = cmpVal(a[1]?.[f]);
            const y = cmpVal(b[1]?.[f]);
            if (x < y) return dir === 'desc' ? 1 : -1;
            if (x > y) return dir === 'desc' ? -1 : 1;
          }
          const last = spec.orders[spec.orders.length - 1][1];
          return (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) * (last === 'desc' ? -1 : 1);
        };
        rows.sort(cmp);
      }
      if (spec.after) {
        const i = rows.findIndex(([p]) => p === spec.after);
        rows = i >= 0 ? rows.slice(i + 1) : rows;
      }
      return rows;
    };
    return {
      where: (field, op, value) => {
        if (!OPS[op]) throw new Error(`fake Firestore: unsupported operator ${op}`);
        return next({ filters: [...spec.filters, [field, op, value]] });
      },
      orderBy: (field, dir = 'asc') => next({ orders: [...spec.orders, [field, dir]] }),
      limit: (n) => next({ max: n }),
      startAfter: (snapOrRef) => next({ after: snapOrRef?.ref?.path ?? snapOrRef?.path ?? null }),
      async get() {
        await network();
        await pause();
        const docs = matches()
          .slice(0, spec.max)
          .map(([p, d]) => {
            bump('reads', p);
            return { id: p.split('/').pop(), exists: true, ref: docRef(p), data: () => clone(d) };
          });
        return { docs, size: docs.length, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn) };
      },
      aggregate: (aggSpec) => ({
        async get() {
          await network();
          await pause();
          const rows = matches().slice(0, spec.max);
          counts.reads += Math.max(1, Math.ceil(rows.length / 1000));
          counts.aggregations = (counts.aggregations ?? 0) + 1;
          const out = {};
          for (const [alias, field] of Object.entries(aggSpec)) {
            const kind = field?.aggregateType ?? field?._aggregateType ?? field?.type;
            const fieldName = field?._field ?? field?.field ?? field?._fieldPath?.toString?.() ?? field?.fieldPath;
            if (kind === 'count') out[alias] = rows.length;
            else if (kind === 'sum') out[alias] = rows.reduce((sum, [, d]) => sum + (Number(d?.[String(fieldName)]) || 0), 0);
            else throw new Error(`fake Firestore: unsupported aggregate ${JSON.stringify(field)}`);
          }
          return { data: () => out };
        },
      }),
    };
  }
  function collectionRef(path) {
    const q = query(path);
    return {
      path,
      doc: (id) => docRef(`${path}/${id}`),
      where: q.where,
      orderBy: q.orderBy,
      limit: q.limit,
      get: () => q.get(),
      aggregate: q.aggregate,
    };
  }
  class AlreadyExists extends Error { constructor(p) { super(`ALREADY_EXISTS ${p}`); this.code = 6; } }
  const db = {
    collection: (name) => collectionRef(name),
    doc: (path) => docRef(path),
    // Outside a transaction: one round trip for any number of docs.
    async getAll(...refs) {
      await network();
      await pause();
      return refs.map((r) => {
        bump('reads', r.path);
        return snap(r.path);
      });
    },
    // Batched writes: all applied together on commit.
    batch() {
      const ops = [];
      return {
        create: (r, d) => ops.push(['create', r.path, d]),
        set: (r, d, opts = {}) => ops.push([opts.merge ? 'merge' : 'set', r.path, d]),
        update: (r, d) => ops.push(['update', r.path, d]),
        delete: (r) => ops.push(['delete', r.path]),
        async commit() {
          await network();
          await pause();
          for (const [k, p] of ops) if (k === 'create' && store.has(p)) throw new AlreadyExists(p);
          for (const [k, p, d] of ops) {
            write(p, k === 'delete' ? undefined : k === 'update' || k === 'merge' ? { ...(store.get(p) ?? {}), ...d } : d);
            bump('writes', p);
          }
          counts.commits += 1;
        },
      };
    },
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
