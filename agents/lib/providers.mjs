// Provider adapters (0.21.0): plain fetch to each REST API, no SDKs. Each one keeps its own conversation and exposes
//   turn(results)  → { calls: [{ id, name, args }], text, usage: { input, output } }
//                    `results` = [{ id, name, output }] for the previous turn's calls ([] on the first turn)
//   search(query)  → { summary, sources } with the provider's own search tool (one search), usage added to the run's
// A non-2xx answer throws ProviderError (status, kind): the runner skips the rest of the run, never retries.

export class ProviderError extends Error {
  constructor(provider, status, body) {
    const kind = status === 401 || status === 403 ? 'auth' : status === 402 ? 'billing' : status === 429 ? 'quota' : status >= 500 ? 'server' : 'request';
    const detail = typeof body?.error?.message === 'string' ? body.error.message : typeof body?.message === 'string' ? body.message : '';
    super(`${provider} API ${status} (${kind})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.kind = kind;
  }
}

async function postJson(provider, fetchImpl, url, headers, body) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  } catch (err) {
    throw new ProviderError(provider, 0, { message: `network: ${err.message}` });
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) throw new ProviderError(provider, res.status, json);
  return json ?? {};
}

const toResultText = (output) => (typeof output === 'string' ? output : JSON.stringify(output));
const SEARCH_PROMPT = (q) =>
  `Search the web for: ${q}\nAnswer in at most 120 words with the facts that matter for a sports bet (injuries, lineups, weather, form, odds news), each with its date, then list up to 3 source URLs.`;

// ---------- Anthropic (Messages API; web search = the web_search server tool, one use) ----------
export function anthropicAdapter({ apiKey, model, system, tools, maxOutputPerTurn = 2048, fetchImpl = fetch }) {
  const url = 'https://api.anthropic.com/v1/messages';
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  const toolDefs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const messages = [];
  return {
    provider: 'anthropic',
    model,
    async turn(results, firstText) {
      if (firstText) messages.push({ role: 'user', content: firstText });
      else messages.push({ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: toResultText(r.output) })) });
      const json = await postJson('anthropic', fetchImpl, url, headers, { model, max_tokens: maxOutputPerTurn, system, tools: toolDefs, messages });
      const content = Array.isArray(json.content) ? json.content : [];
      messages.push({ role: 'assistant', content });
      return {
        calls: content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} })),
        text: content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
        usage: { input: Number(json.usage?.input_tokens) || 0, output: Number(json.usage?.output_tokens) || 0 },
      };
    },
    async search(query) {
      const json = await postJson('anthropic', fetchImpl, url, headers, {
        model,
        max_tokens: 700,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
        messages: [{ role: 'user', content: SEARCH_PROMPT(query) }],
      });
      const content = Array.isArray(json.content) ? json.content : [];
      const sources = content.flatMap((b) => (b.type === 'web_search_tool_result' && Array.isArray(b.content) ? b.content.map((r) => r.url).filter(Boolean) : [])).slice(0, 5);
      return {
        summary: content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim(),
        sources,
        usage: { input: Number(json.usage?.input_tokens) || 0, output: Number(json.usage?.output_tokens) || 0 },
      };
    },
  };
}

// ---------- OpenAI (Responses API; the conversation continues with previous_response_id; web search = web_search tool) ----------
export function openaiAdapter({ apiKey, model, system, tools, maxOutputPerTurn = 4096, fetchImpl = fetch }) {
  const url = 'https://api.openai.com/v1/responses';
  const headers = { authorization: `Bearer ${apiKey}` };
  const toolDefs = tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
  let previous = null;
  const parse = (json) => {
    const output = Array.isArray(json.output) ? json.output : [];
    return {
      calls: output.filter((o) => o.type === 'function_call').map((o) => {
        let args = {};
        try {
          args = JSON.parse(o.arguments || '{}');
        } catch {
          args = {};
        }
        return { id: o.call_id, name: o.name, args };
      }),
      text: output.filter((o) => o.type === 'message').flatMap((o) => (o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text)).join('\n').trim(),
      usage: { input: Number(json.usage?.input_tokens) || 0, output: Number(json.usage?.output_tokens) || 0 },
      sources: output.filter((o) => o.type === 'message').flatMap((o) => (o.content ?? []).flatMap((c) => (c.annotations ?? []).filter((a) => a.type === 'url_citation').map((a) => a.url))),
    };
  };
  return {
    provider: 'openai',
    model,
    async turn(results, firstText) {
      const input = firstText ? [{ role: 'user', content: firstText }] : results.map((r) => ({ type: 'function_call_output', call_id: r.id, output: toResultText(r.output) }));
      const json = await postJson('openai', fetchImpl, url, headers, {
        model,
        instructions: system,
        input,
        tools: toolDefs,
        max_output_tokens: maxOutputPerTurn,
        reasoning: { effort: 'low' },
        ...(previous ? { previous_response_id: previous } : {}),
      });
      previous = json.id ?? previous;
      const { calls, text, usage } = parse(json);
      return { calls, text, usage };
    },
    async search(query) {
      const json = await postJson('openai', fetchImpl, url, headers, { model, input: SEARCH_PROMPT(query), tools: [{ type: 'web_search' }], max_output_tokens: 900, reasoning: { effort: 'low' } });
      const { text, usage, sources } = parse(json);
      return { summary: text, sources: [...new Set(sources)].slice(0, 5), usage };
    },
  };
}

// ---------- Google Gemini (generateContent; the model's parts are sent back as received, so thought signatures survive;
// web search = Grounding with Google Search, which the free tier doesn't include: then search is reported unavailable) ----------
function geminiSchema(schema) {
  // Gemini takes an OpenAPI subset: no additionalProperties.
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties') continue;
    out[k] = typeof v === 'object' ? geminiSchema(v) : v;
  }
  return out;
}

export function geminiAdapter({ apiKey, model, system, tools, maxOutputPerTurn = 4096, fetchImpl = fetch }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const headers = { 'x-goog-api-key': apiKey };
  const declarations = tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) }));
  const contents = [];
  let callN = 0;
  let searchUnavailable = false;
  const usageOf = (json) => ({ input: Number(json.usageMetadata?.promptTokenCount) || 0, output: (Number(json.usageMetadata?.candidatesTokenCount) || 0) + (Number(json.usageMetadata?.thoughtsTokenCount) || 0) });
  return {
    provider: 'google',
    model,
    async turn(results, firstText) {
      if (firstText) contents.push({ role: 'user', parts: [{ text: firstText }] });
      else contents.push({ role: 'user', parts: results.map((r) => ({ functionResponse: { ...(r.providerId ? { id: r.providerId } : {}), name: r.name, response: { result: r.output } } })) });
      const json = await postJson('google', fetchImpl, url, headers, {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [{ functionDeclarations: declarations }],
        generationConfig: { maxOutputTokens: maxOutputPerTurn },
      });
      const content = json.candidates?.[0]?.content ?? { role: 'model', parts: [] };
      contents.push({ role: 'model', parts: content.parts ?? [] });
      const parts = content.parts ?? [];
      return {
        calls: parts.filter((p) => p.functionCall).map((p) => ({ id: `g${(callN += 1)}`, providerId: p.functionCall.id, name: p.functionCall.name, args: p.functionCall.args ?? {} })),
        text: parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('\n').trim(),
        usage: usageOf(json),
      };
    },
    async search(query) {
      if (searchUnavailable) {
        const err = new Error('Web search is not available for this agent (Gemini free tier: no Google Search grounding).');
        err.unavailable = true;
        throw err;
      }
      try {
        const json = await postJson('google', fetchImpl, url, headers, { contents: [{ role: 'user', parts: [{ text: SEARCH_PROMPT(query) }] }], tools: [{ googleSearch: {} }], generationConfig: { maxOutputTokens: 900 } });
        const cand = json.candidates?.[0];
        const sources = (cand?.groundingMetadata?.groundingChunks ?? []).map((c) => c.web?.uri).filter(Boolean).slice(0, 5);
        return { summary: (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim(), sources, usage: usageOf(json) };
      } catch (err) {
        // The free tier refuses grounding (a 4xx that isn't a rate limit): say so once and stop asking.
        if (err instanceof ProviderError && err.status >= 400 && err.status < 500 && err.status !== 429) {
          searchUnavailable = true;
          const e = new Error('Web search is not available for this agent (Gemini free tier: no Google Search grounding).');
          e.unavailable = true;
          throw e;
        }
        throw err;
      }
    },
  };
}

export function makeAdapter(provider, opts) {
  if (provider === 'anthropic') return anthropicAdapter(opts);
  if (provider === 'openai') return openaiAdapter(opts);
  if (provider === 'google') return geminiAdapter(opts);
  throw new Error(`Unknown provider ${provider}`);
}
