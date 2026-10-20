// A small evaluator for our own firestore.rules, used because the Firestore emulator can't be downloaded in this
// environment. It understands what the file uses: nested `match` blocks with {var} and {var=**} segments, `allow
// <methods>: if <expr>;`, top-level `function f(args) { return <expr>; }`, &&, ||, !, ==, !=, `x in list`, true,
// false, null, request.auth / resource.data paths. A request is allowed when ANY allow statement of a match that
// covers the whole path grants it; an expression that errors (e.g. reading a field of null) denies, as in Firestore.
import { readFileSync } from 'node:fs';

const METHOD_GROUPS = { read: ['get', 'list'], write: ['create', 'update', 'delete'] };

function tokenizeBlocks(src) {
  const text = src.replace(/\/\/[^\n]*/g, '');
  const functions = {};
  for (const m of text.matchAll(/function\s+(\w+)\s*\(([^)]*)\)\s*\{\s*return\s+([^;]+);\s*\}/g)) {
    functions[m[1]] = { args: m[2].split(',').map((a) => a.trim()).filter(Boolean), body: m[3].trim() };
  }
  // Parse match blocks recursively by braces.
  function parseBlock(body, prefix) {
    const rules = [];
    let i = 0;
    while (i < body.length) {
      const rest = body.slice(i);
      const m = /^\s*match\s+(\S+)\s*\{/.exec(rest);
      if (m) {
        let depth = 1;
        let j = i + m[0].length;
        while (depth > 0 && j < body.length) {
          if (body[j] === '{') depth += 1;
          else if (body[j] === '}') depth -= 1;
          j += 1;
        }
        const inner = body.slice(i + m[0].length, j - 1);
        const path = [...prefix, ...m[1].split('/').filter(Boolean)];
        const allows = [...stripNested(inner).matchAll(/allow\s+([\w\s,]+):\s*if\s+([^;]+);/g)].map((a) => ({
          methods: a[1].split(',').map((x) => x.trim()),
          expr: a[2].trim(),
        }));
        rules.push({ path, allows });
        rules.push(...parseBlock(inner, path));
        i = j;
      } else {
        i += 1;
      }
    }
    return rules;
  }
  // The block's own text without nested match blocks.
  function stripNested(inner) {
    let out = '';
    let i = 0;
    while (i < inner.length) {
      const m = /^match\s+\S+\s*\{/.exec(inner.slice(i));
      if (m) {
        let depth = 1;
        let j = i + m[0].length;
        while (depth > 0 && j < inner.length) {
          if (inner[j] === '{') depth += 1;
          else if (inner[j] === '}') depth -= 1;
          j += 1;
        }
        i = j;
      } else {
        out += inner[i];
        i += 1;
      }
    }
    return out;
  }
  const service = /service\s+cloud\.firestore\s*\{([\s\S]*)\}\s*$/.exec(text)[1];
  return { functions, rules: parseBlock(service, []) };
}

function toJs(expr) {
  return expr
    .replace(/([\w.]+)\s+in\s+([\w.]+)/g, '__in($1, $2)')
    .replace(/(?<![=!<>])==(?!=)/g, '===')
    .replace(/!=(?!=)/g, '!==');
}

// Path segments against a pattern: literal, {var} (one segment) or {var=**} (the rest, one or more).
function matchPath(pattern, segments) {
  let i = 0;
  for (let p = 0; p < pattern.length; p += 1) {
    const seg = pattern[p];
    if (/^\{\w+=\*\*\}$/.test(seg)) return true; // {x=**}: zero or more remaining segments (rules_version 2)
    if (i >= segments.length) return false;
    if (/^\{\w+\}$/.test(seg)) { i += 1; continue; }
    if (seg !== segments[i]) return false;
    i += 1;
  }
  return i === segments.length;
}

export function loadRules(file) {
  const { functions, rules } = tokenizeBlocks(readFileSync(file, 'utf8'));
  const fnNames = Object.keys(functions);
  const compile = (expr, args = []) =>
    // eslint-disable-next-line no-new-func
    new Function('request', 'resource', '__in', ...fnNames, ...args, `return (${toJs(expr)});`);
  const compiledFns = {};
  return function allowed({ method, path, auth = null, data = null }) {
    const request = { auth };
    const resource = data === null ? null : { data };
    const __in = (x, list) => Array.isArray(list) && list.includes(x);
    const fns = {};
    for (const name of fnNames) {
      compiledFns[name] ??= compile(functions[name].body, functions[name].args);
      fns[name] = (...a) => compiledFns[name](request, resource, __in, ...fnNames.map((n) => fns[n]), ...a);
    }
    const segments = ['databases', '(default)', 'documents', ...path.split('/').filter(Boolean)];
    const group = Object.keys(METHOD_GROUPS).find((g) => METHOD_GROUPS[g].includes(method)) ?? method;
    for (const rule of rules) {
      if (!matchPath(rule.path, segments)) continue;
      for (const allow of rule.allows) {
        if (!allow.methods.includes(method) && !allow.methods.includes(group)) continue;
        try {
          if (compile(allow.expr)(request, resource, __in, ...fnNames.map((n) => fns[n])) === true) return true;
        } catch {
          // An error in a rule denies, as in Firestore.
        }
      }
    }
    return false;
  };
}
