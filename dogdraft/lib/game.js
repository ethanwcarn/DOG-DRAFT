/**
 * Game rules that touch the database: the pick lock, input validation, and
 * loading players/results.
 */
import { BREED_BY_ID, GROUP_KEYS } from './breeds.js';
import { PICKS_PER_GROUP } from './scoring.js';
import { query } from './db.js';
import { HttpError } from './http.js';

/**
 * When picks lock. Default: noon Mountain Time on Thanksgiving 2026
 * (Nov 26, 12:00 MST = 19:00 UTC). Override with the LOCK_AT env var
 * (any ISO 8601 timestamp, e.g. "2026-11-26T17:00:00Z").
 */
export function lockAt() {
  const fromEnv = process.env.LOCK_AT ? new Date(process.env.LOCK_AT) : null;
  if (fromEnv && !Number.isNaN(fromEnv.getTime())) return fromEnv;
  return new Date('2026-11-26T19:00:00Z');
}

export function isLocked(now = new Date()) {
  return now.getTime() >= lockAt().getTime();
}

// Letters (any language), spaces, apostrophes, hyphens, periods. 1-30 chars.
const NAME_RE = /^[\p{L}][\p{L}\p{M} .'’-]{0,29}$/u;

export function cleanName(value, label) {
  const v = String(value ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!NAME_RE.test(v)) {
    throw new HttpError(400, `Please enter a valid ${label} (letters only, up to 30 characters).`);
  }
  return v;
}

/** Case- and accent-insensitive key so "jane doe" and "Jane Doe" are one player. */
export function nameKey(first, last) {
  return `${first} ${last}`.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function cleanPin(value) {
  const v = String(value ?? '').trim();
  if (!/^\d{4}$/.test(v)) throw new HttpError(400, 'Your PIN must be exactly 4 digits.');
  return v;
}

/**
 * Validate a full set of picks: exactly PICKS_PER_GROUP distinct, real breeds
 * from each group, and a Best in Show call that is one of the player's picks.
 * Returns a normalized copy (only known keys, in a fixed order).
 */
export function cleanPicks(picks, bisPick) {
  if (!picks || typeof picks !== 'object' || Array.isArray(picks)) {
    throw new HttpError(400, 'Picks are missing.');
  }
  const out = {};
  for (const g of GROUP_KEYS) {
    const list = picks[g];
    if (!Array.isArray(list) || list.length !== PICKS_PER_GROUP) {
      throw new HttpError(400, `Pick exactly ${PICKS_PER_GROUP} breeds in every group.`);
    }
    const ids = list.map((x) => String(x));
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'You picked the same breed twice.');
    for (const id of ids) {
      const breed = BREED_BY_ID.get(id);
      if (!breed || breed.group !== g) throw new HttpError(400, 'One of your picks is not a valid breed for its group.');
    }
    out[g] = ids;
  }
  const extra = Object.keys(picks).filter((k) => !GROUP_KEYS.includes(k));
  if (extra.length) throw new HttpError(400, 'Unknown group in picks.');

  const bis = String(bisPick ?? '');
  if (!Object.values(out).flat().includes(bis)) {
    throw new HttpError(400, 'Choose your Best in Show pick from your own breeds.');
  }
  return { picks: out, bisPick: bis };
}

/** All players, newest data, without PIN hashes. */
export async function loadPlayers() {
  const rows = await query(
    `SELECT id, first_name, last_name, picks, bis_pick, created_at
       FROM players ORDER BY created_at ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: `${r.first_name} ${r.last_name}`,
    picks: typeof r.picks === 'string' ? JSON.parse(r.picks) : r.picks,
    bisPick: r.bis_pick,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/**
 * Results as { slot: breedId }. Public callers must pass revealedOnly=true so
 * pre-entered (hidden) placements never leak to players' browsers.
 */
export async function loadResults({ revealedOnly }) {
  const rows = await query(
    revealedOnly
      ? 'SELECT slot, breed_id, revealed FROM results WHERE revealed = true'
      : 'SELECT slot, breed_id, revealed FROM results',
  );
  const results = {};
  const revealed = {};
  for (const r of rows) {
    results[r.slot] = r.breed_id;
    revealed[r.slot] = r.revealed;
  }
  return { results, revealed };
}
