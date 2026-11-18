/**
 * POST /api/picks
 *   { action: "load", firstName, lastName, pin }
 *       -> your saved picks (to edit them)
 *   { action: "save", firstName, lastName, pin, picks, bisPicks: [1st, 2nd, 3rd] }
 *       -> create your entry, or update it if the name + PIN match
 *
 * Saving is refused after the lock time. Every attempt is rate limited per
 * IP and per name so a 4-digit PIN cannot be guessed by brute force.
 *
 * Anti-bot limits (all invisible to normal players):
 *   - every load/save: 40 per IP and 10 per name per 15 minutes
 *   - NEW entries: 20 per IP per hour (a whole party shares one Wi-Fi IP),
 *     60 per hour site-wide, and 100 players total
 *   - a hidden "honeypot" form field that people never see; bots that fill
 *     it in are rejected
 *
 * One entry per device: creating a NEW entry is refused if this browser's
 * device cookie already belongs to an entry under another name. Editing an
 * existing entry (right name + PIN) always works, from any device, and tags
 * that device so it can't then create a second entry either.
 */
import { route, requireMethod, readJsonBody, sendJson, clientIp, HttpError } from '../lib/http.js';
import { query } from '../lib/db.js';
import { hashPin, verifyPin, rateLimit } from '../lib/security.js';
import { cleanName, cleanPin, cleanPicks, isLocked, nameKey, rowBisPicks, formatName } from '../lib/game.js';
import { readDeviceId, newDeviceId, deviceCookie } from '../lib/device.js';

const MAX_PLAYERS = 100; // generous cap so a script can't flood the leaderboard
export const LIMITS = Object.freeze({
  attemptsPerIp: [40, 15 * 60],
  attemptsPerName: [10, 15 * 60],
  newEntriesPerIp: [20, 60 * 60],
  newEntriesSiteWide: [60, 60 * 60],
});

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

  const first = cleanName(body.firstName, 'first name');
  const last = cleanName(body.lastName, 'last name');
  const pin = cleanPin(body.pin);
  const key = nameKey(first, last);

  const ip = clientIp(req);
  await rateLimit(`ip:${ip}`, ...LIMITS.attemptsPerIp);
  await rateLimit(`name:${key}`, ...LIMITS.attemptsPerName);

  const existing = (await query('SELECT id, pin_hash, picks, bis_pick, bis_picks, device_id FROM players WHERE name_key = $1', [key]))[0];
  const deviceId = readDeviceId(req);

  if (action === 'load') {
    if (!existing || !(await verifyPin(pin, existing.pin_hash))) {
      // Same message either way so this can't be used to probe which names exist.
      throw new HttpError(404, 'No entry found for that name and PIN.');
    }
    await tagDevice(res, deviceId, existing);
    return sendJson(res, 200, { picks: parseJson(existing.picks), bisPicks: rowBisPicks(existing) });
  }

  // ----- save -----
  if (isLocked()) throw new HttpError(423, 'Picks are locked. The show has started!');
  const { picks, bisPicks } = cleanPicks(body.picks, body.bisPicks);

  if (existing) {
    if (!(await verifyPin(pin, existing.pin_hash))) {
      throw new HttpError(403, 'That name is already entered. Use the same PIN you chose before to change your picks.');
    }
    await query(
      `UPDATE players SET first_name = $1, last_name = $2, picks = $3::jsonb, bis_pick = $4, bis_picks = $5::jsonb,
              updated_at = now()
        WHERE id = $6`,
      [first, last, JSON.stringify(picks), bisPicks[0], JSON.stringify(bisPicks), existing.id],
    );
    await tagDevice(res, deviceId, existing);
    return sendJson(res, 200, { ok: true, created: false });
  }

  // New entry: one per device
  if (deviceId) {
    const mine = (await query('SELECT first_name, last_name FROM players WHERE device_id = $1 LIMIT 1', [deviceId]))[0];
    if (mine) {
      throw new HttpError(409, `This device already has an entry for ${formatName(mine.first_name)} ${formatName(mine.last_name)}. `
        + 'Only one entry per person is allowed. To change those picks, type that name and PIN and tap "load my saved picks". '
        + 'If you share this device with someone, they can enter from their own phone.');
    }
  }
  const newId = deviceId || newDeviceId();

  const count = Number((await query('SELECT count(*)::int AS n FROM players'))[0].n);
  if (count >= MAX_PLAYERS) throw new HttpError(409, 'This game is full.');
  // New-entry limits (checked only when actually creating an entry)
  await rateLimit(`new-ip:${ip}`, ...LIMITS.newEntriesPerIp);
  await rateLimit('new-site', ...LIMITS.newEntriesSiteWide);

  const inserted = await query(
    `INSERT INTO players (first_name, last_name, name_key, pin_hash, picks, bis_pick, bis_picks, device_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8)
     ON CONFLICT (name_key) DO NOTHING
     RETURNING id`,
    [first, last, key, await hashPin(pin), JSON.stringify(picks), bisPicks[0], JSON.stringify(bisPicks), newId],
  );
  if (!inserted.length) {
    // Someone with the same name saved a split second earlier.
    throw new HttpError(409, 'That name was just taken. Try again with the same PIN, or add a middle initial.');
  }
  if (newId !== deviceId) res.setHeader('Set-Cookie', deviceCookie(newId));
  return sendJson(res, 201, { ok: true, created: true });
});

/**
 * After a successful load/edit, make sure this browser carries a device id
 * linked to that entry, so it can't be used to create a second entry.
 */
async function tagDevice(res, deviceId, entry) {
  const id = deviceId || entry.device_id || newDeviceId();
  // Entries saved before this feature existed have no device yet: claim this one.
  if (!entry.device_id) {
    await query('UPDATE players SET device_id = $1 WHERE id = $2 AND device_id IS NULL', [id, entry.id]);
  }
  if (!deviceId) res.setHeader('Set-Cookie', deviceCookie(id));
}

function parseJson(v) {
  return typeof v === 'string' ? JSON.parse(v) : v;
}
