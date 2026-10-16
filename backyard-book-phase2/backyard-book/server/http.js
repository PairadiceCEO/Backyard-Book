// Small helpers shared by every /api function: method checks, JSON bodies and error responses.

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function readJsonBody(req) {
  const body = req.body;
  if (body === undefined || body === null || body === '') return {};
  if (typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Falls through to the error below.
  }
  throw new HttpError(400, 'BAD_JSON', 'The request body must be a JSON object.');
}

function sendError(res, status, code, message, extra = {}) {
  res.status(status).json({ error: { code, message, ...extra } });
}

// Wraps a handler so it only accepts the listed methods and always answers with JSON.
export function withHandler(methods, handler) {
  return async function wrappedHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (!methods.includes(req.method)) {
      res.setHeader('Allow', methods.join(', '));
      sendError(res, 405, 'METHOD_NOT_ALLOWED', `Use ${methods.join(' or ')} for this endpoint.`);
      return;
    }

    try {
      const result = await handler(req, res);
      if (!res.headersSent) {
        res.status(200).json(result ?? { ok: true });
      }
    } catch (err) {
      if (res.headersSent) {
        console.error('Error after response was sent:', err);
        return;
      }
      if (err instanceof HttpError) {
        sendError(res, err.status, err.code, err.message, err.extra);
        return;
      }
      console.error('Unhandled API error:', err);
      sendError(res, 500, 'INTERNAL', 'Something went wrong on the server. Check the Vercel function logs.');
    }
  };
}
