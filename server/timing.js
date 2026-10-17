// Per-request stage timing for /api/casino: each stage's duration goes into a Server-Timing header
// (visible in the browser's developer tools → Network → Timing) and one JSON log line in Vercel.

export function createTiming() {
  const startedAt = performance.now();
  const stages = []; // { name, dur, desc }
  let attempts = 0;

  function add(name, dur, desc = '') {
    stages.push({ name, dur: Math.round(dur * 10) / 10, desc });
  }

  return {
    add,
    // Times an async step: await timing.time('read', () => tx.getAll(...), 'table+user')
    async time(name, fn, desc = '') {
      const t0 = performance.now();
      try {
        return await fn();
      } finally {
        add(name, performance.now() - t0, desc);
      }
    },
    attempt() {
      attempts += 1;
      // A retried transaction starts its reads over; keep only the last attempt's reads.
      if (attempts > 1) for (let i = stages.length - 1; i >= 0; i -= 1) if (stages[i].name.startsWith('read')) stages.splice(i, 1);
    },
    total() {
      return Math.round((performance.now() - startedAt) * 10) / 10;
    },
    summary() {
      return { totalMs: this.total(), attempts: Math.max(1, attempts), stages: stages.map((s) => ({ ...s })) };
    },
    header() {
      const parts = stages.map((s, i) => {
        const name = s.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const unique = stages.filter((x) => x.name === s.name).length > 1 ? `${name}${i}` : name;
        return `${unique};dur=${s.dur}${s.desc ? `;desc="${s.desc.replace(/"/g, '')}"` : ''}`;
      });
      parts.push(`total;dur=${this.total()}`);
      if (attempts > 1) parts.push(`retries;desc="${attempts - 1}"`);
      return parts.join(', ');
    },
  };
}
