/**
 * Small HTTP helpers shared by the API routes: JSON responses, consistent
 * error handling, same-origin checks for writes, client IP for rate limits.
 */

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!headers['Cache-Control']) res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

/**
 * Wrap a handler so thrown errors become clean JSON responses. Unexpected
 * errors are logged server-side and the client gets a generic message, so
 * internal details (SQL, stack traces) never leak.
 */
export function route(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof HttpError || (err && Number.isInteger(err.status) && err.status < 600)) {
        sendJson(res, err.status, { error: err.message });
      } else {
        console.error('Unhandled API error:', err);
        sendJson(res, 500, { error: 'Something went wrong on our end. Please try again.' });
      }
    }
  };
}

export function requireMethod(req, ...methods) {
  if (!methods.includes(req.method)) throw new HttpError(405, 'Method not allowed');
}

/**
 * For POST requests: require a JSON body and a same-origin Origin header.
 * Together with SameSite=Strict cookies this blocks cross-site form posts.
 */
export function readJsonBody(req) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Expected JSON');
  }
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new HttpError(403, 'Bad origin');
    }
    if (originHost !== host) throw new HttpError(403, 'Cross-site requests are not allowed');
  }
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid request body');
  return body;
}

/**
 * Client IP, used only for rate limiting. Vercel overwrites these headers
 * with the real client address (clients can't spoof them). The
 * x-vercel-forwarded-for copy is preferred because it stays correct even if
 * a proxy (e.g. Cloudflare's orange-cloud mode) is ever put in front.
 */
export function clientIp(req) {
  const fwd = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || '');
  return fwd.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}
