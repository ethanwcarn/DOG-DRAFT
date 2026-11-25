/**
 * Sign-in API. Players stay signed in for 60 days with an HttpOnly cookie.
 *
 * GET  /api/auth                     -> { signedIn, player?, googleClientId, locked }
 * POST /api/auth { action: "pin", firstName, lastName, pin, hp }
 *        Existing name: PIN must match. New name: creates an entry (before
 *        the lock only). Either way the browser is signed in.
 * POST /api/auth { action: "google", credential, firstName?, lastName? }
 *        Known Google account: signed in. New account: creates an entry, or
 *        asks to link when an entry with the same name already exists
 *        ({ needsLink }), or asks for a name if Google didn't give one
 *        ({ needsName }).
 * POST /api/auth { action: "link", credential, firstName, lastName, pin }
 *        Connect a Google account to an existing name+PIN entry (proves
 *        ownership with the PIN once).
 * POST /api/auth { action: "logout" }
 *
 * Same anti-bot protections as the picks API: rate limits, honeypot, one
 * entry per device, new-entry limits.
 */
import { route, requireMethod, readJsonBody, sendJson, clientIp, HttpError } from '../lib/http.js';
import { hashPin, verifyPin, rateLimit } from '../lib/security.js';
import { cleanName, cleanPin, isLocked, nameKey, formatName } from '../lib/game.js';
import { readSession, sessionCookie, clearSessionCookie } from '../lib/session.js';
import { verifyGoogleIdToken, googleClientId } from '../lib/google.js';
import { query } from '../lib/db.js';
import {
  LIMITS, playerById, playerByNameKey, playerByGoogleSub, playerJson, createEntry, tagDevice, appendCookie,
} from '../lib/players.js';

const LOCKED_NEW = 'Picks are locked, so new players can’t join now. You can still watch the leaderboard!';

export default route(async (req, res) => {
  requireMethod(req, 'GET', 'POST');

  if (req.method === 'GET') {
    const id = readSession(req);
    const row = id ? await playerById(id) : null;
    if (id && !row) appendCookie(res, clearSessionCookie()); // entry was removed by the admin
    return sendJson(res, 200, {
      signedIn: Boolean(row),
      player: row ? playerJson(row) : null,
      googleClientId: googleClientId(),
      locked: isLocked(),
    });
  }

  const body = readJsonBody(req);
  if (body.hp !== undefined && body.hp !== '') {
    console.warn('auth: honeypot triggered from', clientIp(req));
    throw new HttpError(400, 'Something went wrong. Please refresh the page and try again.');
  }
  const ip = clientIp(req);

  switch (body.action) {
    case 'logout':
      appendCookie(res, clearSessionCookie());
      return sendJson(res, 200, { ok: true });

    case 'pin': {
      const first = cleanName(body.firstName, 'first name');
      const last = cleanName(body.lastName, 'last name');
      const pin = cleanPin(body.pin);
      const key = nameKey(first, last);
      await rateLimit(`ip:${ip}`, ...LIMITS.attemptsPerIp);
      await rateLimit(`name:${key}`, ...LIMITS.attemptsPerName);

      const existing = await playerByNameKey(key);
      if (existing) {
        if (!existing.pin_hash) {
          throw new HttpError(403, `${formatName(existing.first_name)} ${formatName(existing.last_name)} signs in with Google. Please use the Google button.`);
        }
        if (!(await verifyPin(pin, existing.pin_hash))) {
          throw new HttpError(403, 'That name is already entered and the PIN doesn’t match. Use the PIN you chose before.');
        }
        await tagDevice(req, res, existing);
        return signIn(res, existing, false);
      }
      if (isLocked()) throw new HttpError(423, LOCKED_NEW);
      const row = await createEntry(req, res, ip, { first, last, key, pinHash: await hashPin(pin) });
      return signIn(res, row, true);
    }

    case 'google': {
      await rateLimit(`ip:${ip}`, ...LIMITS.attemptsPerIp);
      const g = await verifyGoogleIdToken(body.credential);
      const known = await playerByGoogleSub(g.sub);
      if (known) {
        await tagDevice(req, res, known);
        return signIn(res, known, false);
      }
      const names = googleNames(g, body);
      if (!names) {
        return sendJson(res, 200, { needsName: true, suggested: { first: g.given || '', last: g.family || '' } });
      }
      const existing = await playerByNameKey(names.key);
      if (existing) {
        if (existing.google_sub) {
          throw new HttpError(409, `${formatName(existing.first_name)} ${formatName(existing.last_name)} is already connected to a different Google account. Sign in with that account, or use a slightly different name.`);
        }
        // Same name already entered with a PIN: prove it's you once.
        return sendJson(res, 200, { needsLink: true, first: names.first, last: names.last, hasPin: Boolean(existing.pin_hash) });
      }
      if (isLocked()) throw new HttpError(423, LOCKED_NEW);
      const row = await createEntry(req, res, ip, { first: names.first, last: names.last, key: names.key, googleSub: g.sub });
      return signIn(res, row, true);
    }

    case 'link': {
      await rateLimit(`ip:${ip}`, ...LIMITS.attemptsPerIp);
      const g = await verifyGoogleIdToken(body.credential);
      if (await playerByGoogleSub(g.sub)) throw new HttpError(409, 'This Google account is already connected to an entry. Just sign in with Google.');
      const names = googleNames(g, body);
      if (!names) throw new HttpError(400, 'Please enter your first and last name.');
      await rateLimit(`name:${names.key}`, ...LIMITS.attemptsPerName);
      const pin = cleanPin(body.pin);
      const existing = await playerByNameKey(names.key);
      if (!existing || existing.google_sub || !existing.pin_hash || !(await verifyPin(pin, existing.pin_hash))) {
        throw new HttpError(403, 'That PIN doesn’t match. Use the 4-digit PIN you chose when you first entered.');
      }
      const updated = await query('UPDATE players SET google_sub = $1 WHERE id = $2 AND google_sub IS NULL RETURNING id', [g.sub, existing.id]);
      if (!updated.length) throw new HttpError(409, 'This entry was just connected to another Google account.');
      await tagDevice(req, res, existing);
      return signIn(res, { ...existing, google_sub: g.sub }, false);
    }

    default:
      throw new HttpError(400, 'Unknown action');
  }
});

/** Names for a Google sign-in: the ones the player typed, else Google's. Null if unusable. */
function googleNames(g, body) {
  const pick = (typed, fallback) => (typeof typed === 'string' && typed.trim() ? typed : fallback);
  try {
    const first = cleanName(pick(body.firstName, g.given), 'first name');
    const last = cleanName(pick(body.lastName, g.family), 'last name');
    return { first, last, key: nameKey(first, last) };
  } catch {
    return null;
  }
}

function signIn(res, row, created) {
  appendCookie(res, sessionCookie(row.id));
  return sendJson(res, created ? 201 : 200, { signedIn: true, created, player: playerJson(row) });
}
