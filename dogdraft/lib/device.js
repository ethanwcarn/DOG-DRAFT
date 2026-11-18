/**
 * "One entry per device" support.
 *
 * The first time a browser saves an entry, the server gives it a random
 * device id in a long-lived HttpOnly cookie and stores that id with the
 * entry. A browser that already has an entry cannot create a second one
 * under a different name (it can still edit its own entry).
 *
 * Limits (accepted by design, see README): clearing cookies, a private/
 * incognito window, or a second device gets around this. The admin page's
 * Remove button is the backstop for duplicates.
 */
import crypto from 'node:crypto';

const COOKIE = 'dd_device';
const MAX_AGE = 120 * 24 * 3600; // ~4 months, well past Thanksgiving
const ID_RE = /^[a-f0-9]{32}$/;

/** The device id from the request cookie, or null if absent/malformed. */
export function readDeviceId(req) {
  const raw = String(req.headers.cookie || '');
  const pair = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  const value = pair ? pair.slice(COOKIE.length + 1) : '';
  return ID_RE.test(value) ? value : null;
}

export function newDeviceId() {
  return crypto.randomBytes(16).toString('hex');
}

/** Set-Cookie header value for a device id. Path=/api: only the API ever sees it. */
export function deviceCookie(id) {
  return `${COOKIE}=${id}; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`;
}
