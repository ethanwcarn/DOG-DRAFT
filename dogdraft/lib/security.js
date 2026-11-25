/**
 * Security helpers: PIN hashing, admin sessions, rate limiting.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { query } from './db.js';
import { HttpError } from './http.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT_KEYLEN = 32;

/** Hash a PIN with a random salt. Stored as "scrypt$<salt>$<hash>" (base64). */
export async function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pin, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Constant-time PIN check. Returns false for any malformed stored value. */
export async function verifyPin(pin, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  const actual = await scrypt(pin, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Constant-time string comparison (hash both sides so lengths match). */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------------
// Admin sessions: a signed, expiring token in an HttpOnly cookie.
// ---------------------------------------------------------------------------

const COOKIE = 'dd_admin';
const SESSION_HOURS = 12;

/**
 * Key used to sign admin sessions. Uses SESSION_SECRET if set; otherwise it
 * is derived from two secrets the project already has (the admin password
 * and the database URL), so setup needs only one environment variable.
 * Changing the admin password therefore also logs out every admin session.
 */
export function sessionSecret() {
  const explicit = process.env.SESSION_SECRET;
  if (explicit && explicit.length >= 32) return explicit;
  const pw = process.env.ADMIN_PASSWORD;
  const db = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  if (!pw || pw.length < 8) throw new HttpError(503, 'Admin password is not configured.');
  return crypto.createHash('sha256').update(`dogdraft-session|${pw}|${db}`).digest('hex');
}

function sign(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

export function createAdminCookie() {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const payload = `admin.${exp}`;
  const token = `${payload}.${sign(payload)}`;
  return `${COOKIE}=${token}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`;
}

export function clearAdminCookie() {
  return `${COOKIE}=; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function isAdmin(req) {
  const raw = String(req.headers.cookie || '');
  const match = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  if (!match) return false;
  const token = match.slice(COOKIE.length + 1);
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'admin') return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  return safeEqual(sign(`${parts[0]}.${parts[1]}`), parts[2]);
}

export function requireAdmin(req) {
  if (!isAdmin(req)) throw new HttpError(401, 'Please log in as admin.');
}

// ---------------------------------------------------------------------------
// Rate limiting: fixed window counter stored in Postgres (works across all
// serverless instances). One atomic upsert per check.
// ---------------------------------------------------------------------------

/**
 * Count an attempt for `key`; throw 429 when over `limit` within `windowSec`.
 * Keys are hashed so raw IPs and names are never stored.
 */
export async function rateLimit(key, limit, windowSec) {
  const hashed = crypto.createHash('sha256').update(key).digest('hex');
  const rows = await query(
    `INSERT INTO rate_limits (key, count, window_start) VALUES ($1, 1, now())
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2)
                    THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2)
                    THEN now() ELSE rate_limits.window_start END
     RETURNING count`,
    [hashed, windowSec],
  );
  if (rows[0].count > limit) {
    throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
  }
}
