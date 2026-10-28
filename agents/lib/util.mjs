// Small helpers shared by the agent tools (0.22.0).

export const r1 = (x) => Math.round(x * 10) / 10;

// A rough token count of a tool result or request text (about 4 characters per token). A real tokenizer counts compact JSON
// like ours roughly 2.7-3x higher (seen in the 0.21.3 runs), so this is for comparing results with each other and for the size caps.
export const estimateTokens = (value) => Math.ceil((typeof value === 'string' ? value : JSON.stringify(value) ?? '').length / 4);

export const mean = (values) => {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

export const round1 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : r1(x));

// Lowercase letters and digits only: "C.J. Stroud Jr." → "cjstroudjr".
export const norm = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Drops keys whose value is null / undefined / an empty array or object, recursively (keeps 0 and false).
export function compact(value) {
  if (Array.isArray(value)) return value.map(compact).filter((v) => v !== undefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const c = compact(v);
      if (c === undefined || c === null) continue;
      if (Array.isArray(c) && c.length === 0) continue;
      if (typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === 0) continue;
      out[k] = c;
    }
    return out;
  }
  return value === undefined ? undefined : value;
}
