/**
 * Shared rules for player entries, used by both the sign-in API and the
 * picks API so they can never disagree:
 *   - creating an entry (one per device, new-entry rate limits, 100 cap)
 *   - tagging a device with the entry it signed in to
 *   - loading the signed-in player
 */
import { query } from './db.js';
import { rateLimit } from './security.js';
import { HttpError } from './http.js';
import { readDeviceId, newDeviceId, deviceCookie } from './device.js';
import { formatName, rowBisPicks } from './game.js';

export const MAX_PLAYERS = 100; // generous cap so a script can't flood the leaderboard
export const LIMITS = Object.freeze({
  attemptsPerIp: [40, 15 * 60],
  attemptsPerName: [10, 15 * 60],
  newEntriesPerIp: [20, 60 * 60],
  newEntriesSiteWide: [60, 60 * 60],
});

const PLAYER_COLS = 'id, first_name, last_name, name_key, pin_hash, picks, bis_pick, bis_picks, device_id, google_sub';

export async function playerById(id) {
  if (!Number.isInteger(id)) return null;
  return (await query(`SELECT ${PLAYER_COLS} FROM players WHERE id = $1`, [id]))[0] || null;
}

export async function playerByNameKey(key) {
  return (await query(`SELECT ${PLAYER_COLS} FROM players WHERE name_key = $1`, [key]))[0] || null;
}

export async function playerByGoogleSub(sub) {
  return (await query(`SELECT ${PLAYER_COLS} FROM players WHERE google_sub = $1`, [sub]))[0] || null;
}

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v) || {};

/** What the browser gets about the signed-in player (never the PIN hash). */
export function playerJson(row) {
  return {
    id: row.id,
    first: formatName(row.first_name),
    last: formatName(row.last_name),
    name: `${formatName(row.first_name)} ${formatName(row.last_name)}`,
    picks: parse(row.picks),
    bisPicks: rowBisPicks(row),
    hasPin: Boolean(row.pin_hash),
    google: Boolean(row.google_sub),
  };
}

/**
 * Create a new, empty entry (picks are added later on the picks page).
 * Enforces one entry per device and the new-entry limits. Returns the row.
 */
export async function createEntry(req, res, ip, { first, last, key, pinHash = null, googleSub = null }) {
  const deviceId = readDeviceId(req);
  if (deviceId) {
    const mine = (await query('SELECT first_name, last_name FROM players WHERE device_id = $1 LIMIT 1', [deviceId]))[0];
    if (mine) {
      throw new HttpError(409, `This device already has an entry for ${formatName(mine.first_name)} ${formatName(mine.last_name)}. `
        + 'Only one entry per person is allowed, so please sign in as that player. '
        + 'If you share this device with someone, they can sign up from their own phone.');
    }
  }
  const count = Number((await query('SELECT count(*)::int AS n FROM players'))[0].n);
  if (count >= MAX_PLAYERS) throw new HttpError(409, 'This game is full.');
  await rateLimit(`new-ip:${ip}`, ...LIMITS.newEntriesPerIp);
  await rateLimit('new-site', ...LIMITS.newEntriesSiteWide);

  const newDevice = deviceId || newDeviceId();
  const rows = await query(
    `INSERT INTO players (first_name, last_name, name_key, pin_hash, picks, bis_pick, bis_picks, device_id, google_sub)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, '', '[]'::jsonb, $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING ${PLAYER_COLS}`,
    [first, last, key, pinHash, newDevice, googleSub],
  );
  if (!rows.length) {
    throw new HttpError(409, 'That name was just taken. Try signing in again, or add a middle initial.');
  }
  if (newDevice !== deviceId) appendCookie(res, deviceCookie(newDevice));
  return rows[0];
}

/**
 * After signing in to (or editing) an existing entry, make sure this browser
 * carries that entry's device id, so it can't then create a second entry.
 */
export async function tagDevice(req, res, entry) {
  const deviceId = readDeviceId(req);
  const id = deviceId || entry.device_id || newDeviceId();
  if (!entry.device_id) {
    await query('UPDATE players SET device_id = $1 WHERE id = $2 AND device_id IS NULL', [id, entry.id]);
  }
  if (!deviceId) appendCookie(res, deviceCookie(id));
}

/** Add a Set-Cookie header without overwriting one already set. */
export function appendCookie(res, cookie) {
  const prev = res.getHeader ? res.getHeader('Set-Cookie') : undefined;
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  res.setHeader('Set-Cookie', [...list, cookie]);
}
