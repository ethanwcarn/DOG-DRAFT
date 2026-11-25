/**
 * POST /api/picks
 *
 * Signed in (session cookie, see /api/auth):
 *   { action: "load" }                          -> your saved picks
 *   { action: "save", picks, bisPicks }         -> save your picks
 *
 * Legacy, for pages loaded before sign-in existed (name + PIN each time):
 *   { action: "load", firstName, lastName, pin }
 *   { action: "save", firstName, lastName, pin, picks, bisPicks }
 *
 * Saving is refused after the lock time. Anti-bot limits (rate limits,
 * honeypot, one entry per device, new-entry limits) live in lib/players.js
 * and are shared with the sign-in API.
 */
import { route, requireMethod, readJsonBody, sendJson, clientIp, HttpError } from '../lib/http.js';
import { query } from '../lib/db.js';
import { hashPin, verifyPin, rateLimit } from '../lib/security.js';
import { cleanName, cleanPin, cleanPicks, isLocked, nameKey } from '../lib/game.js';
import { readSession, clearSessionCookie } from '../lib/session.js';
import { LIMITS, playerById, playerByNameKey, playerJson, createEntry, tagDevice, appendCookie } from '../lib/players.js';

export { LIMITS }; // tests import the limits from here

export default route(async (req, res) => {
  requireMethod(req, 'POST');
  const body = readJsonBody(req);
  const action = body.action;
  if (action !== 'load' && action !== 'save') throw new HttpError(400, 'Unknown action');

  // Honeypot: the page sends this hidden field empty. Anything else is a bot.
  if (body.hp !== undefined && body.hp !== '') {
    console.warn('picks: honeypot triggered from', clientIp(req));
    throw new HttpError(400, 'Something went wrong. Please refresh the page and try again.');
  }
  const ip = clientIp(req);

  // ---------- Signed in ----------
  const sessionId = readSession(req);
  const usingSession = sessionId !== null && body.firstName === undefined;
  if (usingSession) {
    const me = await playerById(sessionId);
    if (!me) {
      appendCookie(res, clearSessionCookie());
      throw new HttpError(401, 'Please sign in again.');
    }
    await rateLimit(`ip:${ip}`, ...LIMITS.attemptsPerIp);
    if (action === 'load') return sendJson(res, 200, playerJson(me));
    if (isLocked()) throw new HttpError(423, 'Picks are locked. The show has started!');
    const { picks, bisPicks } = cleanPicks(body.picks, body.bisPicks);
    await savePicks(me.id, picks, bisPicks);
    return sendJson(res, 200, { ok: true, created: false });
  }

  // ---------- Legacy: name + PIN on every request ----------
  const first = cleanName(body.firstName, 'first name');
  const last = cleanName(body.lastName, 'last name');
  const pin = cleanPin(body.pin);
  const key = nameKey(first, last);
  await rateLimit(`ip:${ip}`, ...LIMITS.attemptsPerIp);
  await rateLimit(`name:${key}`, ...LIMITS.attemptsPerName);

  const existing = await playerByNameKey(key);

  if (action === 'load') {
    if (!existing || !existing.pin_hash || !(await verifyPin(pin, existing.pin_hash))) {
      // Same message either way so this can't be used to probe which names exist.
      throw new HttpError(404, 'No entry found for that name and PIN.');
    }
    await tagDevice(req, res, existing);
    const p = playerJson(existing);
    return sendJson(res, 200, { picks: p.picks, bisPicks: p.bisPicks });
  }

  if (isLocked()) throw new HttpError(423, 'Picks are locked. The show has started!');
  const { picks, bisPicks } = cleanPicks(body.picks, body.bisPicks);

  if (existing) {
    if (!existing.pin_hash || !(await verifyPin(pin, existing.pin_hash))) {
      throw new HttpError(403, 'That name is already entered. Use the same PIN you chose before to change your picks.');
    }
    await savePicks(existing.id, picks, bisPicks, { first, last });
    await tagDevice(req, res, existing);
    return sendJson(res, 200, { ok: true, created: false });
  }

  const row = await createEntry(req, res, ip, { first, last, key, pinHash: await hashPin(pin) });
  await savePicks(row.id, picks, bisPicks);
  return sendJson(res, 201, { ok: true, created: true });
});

async function savePicks(id, picks, bisPicks, names = null) {
  if (names) {
    await query(
      `UPDATE players SET first_name = $1, last_name = $2, picks = $3::jsonb, bis_pick = $4, bis_picks = $5::jsonb,
              updated_at = now() WHERE id = $6`,
      [names.first, names.last, JSON.stringify(picks), bisPicks[0], JSON.stringify(bisPicks), id],
    );
  } else {
    await query(
      `UPDATE players SET picks = $1::jsonb, bis_pick = $2, bis_picks = $3::jsonb, updated_at = now() WHERE id = $4`,
      [JSON.stringify(picks), bisPicks[0], JSON.stringify(bisPicks), id],
    );
  }
}
