/**
 * POST /api/picks
 *   { action: "load", firstName, lastName, pin }
 *       -> your saved picks (to edit them)
 *   { action: "save", firstName, lastName, pin, picks, bisPick }
 *       -> create your entry, or update it if the name + PIN match
 *
 * Saving is refused after the lock time. Every attempt is rate limited per
 * IP and per name so a 4-digit PIN cannot be guessed by brute force.
 */
import { route, requireMethod, readJsonBody, sendJson, clientIp, HttpError } from '../lib/http.js';
import { query } from '../lib/db.js';
import { hashPin, verifyPin, rateLimit } from '../lib/security.js';
import { cleanName, cleanPin, cleanPicks, isLocked, nameKey } from '../lib/game.js';

const MAX_PLAYERS = 100; // generous cap so a script can't flood the leaderboard

export default route(async (req, res) => {
  requireMethod(req, 'POST');
  const body = readJsonBody(req);
  const action = body.action;
  if (action !== 'load' && action !== 'save') throw new HttpError(400, 'Unknown action');

  const first = cleanName(body.firstName, 'first name');
  const last = cleanName(body.lastName, 'last name');
  const pin = cleanPin(body.pin);
  const key = nameKey(first, last);

  await rateLimit(`ip:${clientIp(req)}`, 40, 15 * 60);
  await rateLimit(`name:${key}`, 10, 15 * 60);

  const existing = (await query('SELECT id, pin_hash, picks, bis_pick FROM players WHERE name_key = $1', [key]))[0];

  if (action === 'load') {
    if (!existing || !(await verifyPin(pin, existing.pin_hash))) {
      // Same message either way so this can't be used to probe which names exist.
      throw new HttpError(404, 'No entry found for that name and PIN.');
    }
    return sendJson(res, 200, { picks: parseJson(existing.picks), bisPick: existing.bis_pick });
  }

  // ----- save -----
  if (isLocked()) throw new HttpError(423, 'Picks are locked. The show has started!');
  const { picks, bisPick } = cleanPicks(body.picks, body.bisPick);

  if (existing) {
    if (!(await verifyPin(pin, existing.pin_hash))) {
      throw new HttpError(403, 'That name is already entered. Use the same PIN you chose before to change your picks.');
    }
    await query(
      `UPDATE players SET first_name = $1, last_name = $2, picks = $3::jsonb, bis_pick = $4, updated_at = now()
        WHERE id = $5`,
      [first, last, JSON.stringify(picks), bisPick, existing.id],
    );
    return sendJson(res, 200, { ok: true, created: false });
  }

  const count = Number((await query('SELECT count(*)::int AS n FROM players'))[0].n);
  if (count >= MAX_PLAYERS) throw new HttpError(409, 'This game is full.');

  const inserted = await query(
    `INSERT INTO players (first_name, last_name, name_key, pin_hash, picks, bis_pick)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (name_key) DO NOTHING
     RETURNING id`,
    [first, last, key, await hashPin(pin), JSON.stringify(picks), bisPick],
  );
  if (!inserted.length) {
    // Someone with the same name saved a split second earlier.
    throw new HttpError(409, 'That name was just taken. Try again with the same PIN, or add a middle initial.');
  }
  return sendJson(res, 201, { ok: true, created: true });
});

function parseJson(v) {
  return typeof v === 'string' ? JSON.parse(v) : v;
}
