/**
 * Verify "Sign in with Google" ID tokens (JWTs) without extra libraries.
 *
 * Checks, per Google's guidance:
 *   - RS256 signature against Google's current public keys (cached)
 *   - iss is accounts.google.com
 *   - aud is OUR client id (GOOGLE_CLIENT_ID), so tokens minted for other
 *     sites are rejected
 *   - not expired
 * Returns the useful claims: sub (stable account id), email, names.
 */
import crypto from 'node:crypto';
import { HttpError } from './http.js';

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const CLOCK_SKEW_SEC = 60;

let cache = { keys: null, expires: 0 };
let testKeys = null;

/** Tests only: use these JWKs instead of fetching Google's. */
export function setTestGoogleKeys(keys) {
  testKeys = keys;
}

export function googleClientId() {
  const id = process.env.GOOGLE_CLIENT_ID;
  return id && /^[\w.-]+\.apps\.googleusercontent\.com$/.test(id) ? id : null;
}

async function getKeys(force = false) {
  if (testKeys) return testKeys;
  if (!force && cache.keys && Date.now() < cache.expires) return cache.keys;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(CERTS_URL, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`certs http ${r.status}`);
    const data = await r.json();
    const maxAge = Number(/max-age=(\d+)/.exec(r.headers.get('cache-control') || '')?.[1] || 3600);
    cache = { keys: Array.isArray(data.keys) ? data.keys : [], expires: Date.now() + Math.min(maxAge, 86400) * 1000 };
    return cache.keys;
  } catch (e) {
    console.error('google: could not fetch signing keys:', e.message);
    throw new HttpError(503, 'Google sign-in is temporarily unavailable. Please use your name and PIN.');
  } finally {
    clearTimeout(timer);
  }
}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

export async function verifyGoogleIdToken(token) {
  const clientId = googleClientId();
  if (!clientId) throw new HttpError(503, 'Google sign-in is not set up on this site yet. Please use your name and PIN.');
  const bad = () => new HttpError(401, 'Google sign-in failed. Please try again.');
  if (typeof token !== 'string' || token.length > 4096) throw bad();
  const parts = token.split('.');
  if (parts.length !== 3) throw bad();

  let header;
  let claims;
  try {
    header = b64json(parts[0]);
    claims = b64json(parts[1]);
  } catch {
    throw bad();
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw bad();

  let jwk = (await getKeys()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await getKeys(true)).find((k) => k.kid === header.kid); // Google rotated keys
  if (!jwk) throw bad();

  let ok = false;
  try {
    const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), pub, Buffer.from(parts[2], 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) throw bad();

  const now = Math.floor(Date.now() / 1000);
  if (!ISSUERS.has(claims.iss)) throw bad();
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw bad();
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SEC < now) {
    throw new HttpError(401, 'Your Google sign-in expired. Please try again.');
  }
  if (typeof claims.sub !== 'string' || !/^\d{1,40}$/.test(claims.sub)) throw bad();

  return {
    sub: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : null,
    given: typeof claims.given_name === 'string' ? claims.given_name : '',
    family: typeof claims.family_name === 'string' ? claims.family_name : '',
  };
}
