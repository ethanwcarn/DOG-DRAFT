/**
 * Player sign-in sessions: a signed, expiring token in an HttpOnly cookie.
 *
 * Token: "v1.<playerId>.<expiresMs>.<hmac>". The HMAC key is derived from the
 * same server secret as admin sessions but with a different label, so a
 * player token can never be used as an admin token (and vice versa).
 * Nothing secret lives in the cookie; it only proves "this browser signed in
 * as player N", and expires after 60 days.
 */
import crypto from 'node:crypto';
import { sessionSecret, safeEqual } from './security.js';

const COOKIE = 'dd_session';
export const SESSION_DAYS = 60;

function key() {
  return crypto.createHash('sha256').update(`${sessionSecret()}|player-session`).digest();
}

function sign(payload) {
  return crypto.createHmac('sha256', key()).update(payload).digest('base64url');
}

/** Set-Cookie value that signs this browser in as the player. */
export function sessionCookie(playerId) {
  const exp = Date.now() + SESSION_DAYS * 86400 * 1000;
  const payload = `v1.${Number(playerId)}.${exp}`;
  return `${COOKIE}=${payload}.${sign(payload)}; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearSessionCookie() {
  return `${COOKIE}=; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** The signed-in player's id, or null for missing, malformed, forged, or expired cookies. */
export function readSession(req) {
  const raw = String(req.headers.cookie || '');
  const pair = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  if (!pair) return null;
  const parts = pair.slice(COOKIE.length + 1).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [v, id, exp, sig] = parts;
  if (!/^\d{1,9}$/.test(id) || !/^\d{1,15}$/.test(exp)) return null;
  if (Number(exp) < Date.now()) return null;
  try {
    if (!safeEqual(sign(`${v}.${id}.${exp}`), sig)) return null;
  } catch {
    return null; // server secret not configured
  }
  return Number(id);
}
