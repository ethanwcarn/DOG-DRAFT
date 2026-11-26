/**
 * Admin API (results entry). All actions except login require the signed
 * admin cookie.
 *
 * GET  /api/admin                         -> full state incl. hidden results
 * POST /api/admin { action: "login", password }
 * POST /api/admin { action: "logout" }
 * POST /api/admin { action: "set", slot, breedId, reveal }   save a result
 * POST /api/admin { action: "reveal", slots: [...] }          reveal saved results
 * POST /api/admin { action: "clear", slot }                   remove one result
 * POST /api/admin { action: "resetResults", confirm: "RESET" }
 * POST /api/admin { action: "deletePlayer", id }
 * POST /api/admin { action: "resetPin", id, pin }              give a player a new 4-digit PIN
 */
import { route, requireMethod, readJsonBody, sendJson, clientIp, HttpError } from '../lib/http.js';
import { query } from '../lib/db.js';
import { createAdminCookie, clearAdminCookie, requireAdmin, rateLimit, safeEqual, hashPin, clearRateLimit } from '../lib/security.js';
import { BREED_BY_ID, GROUPS } from '../lib/breeds.js';
import { ALL_SLOTS, parseGroupSlot, scorePlayers, UNDERDOG_MAX_PICKERS } from '../lib/scoring.js';
import { isLocked, lockAt, loadPlayers, loadResults, cleanPin } from '../lib/game.js';

export default route(async (req, res) => {
  requireMethod(req, 'GET', 'POST');

  if (req.method === 'GET') {
    requireAdmin(req);
    return sendJson(res, 200, await adminState());
  }

  const body = readJsonBody(req);
  switch (body.action) {
    case 'login': {
      await rateLimit(`admin-login:${clientIp(req)}`, 10, 15 * 60);
      const expected = process.env.ADMIN_PASSWORD;
      if (!expected || expected.length < 8) throw new HttpError(503, 'Admin password is not configured.');
      if (!safeEqual(String(body.password ?? ''), expected)) throw new HttpError(401, 'Wrong password.');
      res.setHeader('Set-Cookie', createAdminCookie());
      return sendJson(res, 200, { ok: true });
    }
    case 'logout':
      res.setHeader('Set-Cookie', clearAdminCookie());
      return sendJson(res, 200, { ok: true });
    default:
      break;
  }

  requireAdmin(req);

  switch (body.action) {
    case 'set': {
      const slot = String(body.slot ?? '');
      const breedId = String(body.breedId ?? '');
      await validateResult(slot, breedId);
      await query(
        `INSERT INTO results (slot, breed_id, revealed, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (slot) DO UPDATE SET breed_id = EXCLUDED.breed_id, revealed = EXCLUDED.revealed, updated_at = now()`,
        [slot, breedId, body.reveal === true],
      );
      break;
    }
    case 'reveal': {
      const slots = Array.isArray(body.slots) ? body.slots.map(String) : [];
      if (!slots.length || slots.some((s) => !ALL_SLOTS.includes(s))) throw new HttpError(400, 'Unknown result slot.');
      await query('UPDATE results SET revealed = true, updated_at = now() WHERE slot = ANY($1::text[])', [slots]);
      break;
    }
    case 'clear': {
      const slot = String(body.slot ?? '');
      if (!ALL_SLOTS.includes(slot)) throw new HttpError(400, 'Unknown result slot.');
      await query('DELETE FROM results WHERE slot = $1', [slot]);
      break;
    }
    case 'resetResults': {
      if (body.confirm !== 'RESET') throw new HttpError(400, 'Type RESET to confirm.');
      await query('DELETE FROM results');
      break;
    }
    case 'deletePlayer': {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid player.');
      await query('DELETE FROM players WHERE id = $1', [id]);
      break;
    }
    case 'resetPin': {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid player.');
      const pinHash = await hashPin(cleanPin(body.pin));
      const rows = await query('UPDATE players SET pin_hash = $1, updated_at = now() WHERE id = $2 RETURNING name_key', [pinHash, id]);
      if (!rows.length) throw new HttpError(404, 'That player no longer exists.');
      // They may have locked themselves out guessing; let the new PIN work right away.
      await clearRateLimit(`name:${rows[0].name_key}`);
      break;
    }
    default:
      throw new HttpError(400, 'Unknown action');
  }
  return sendJson(res, 200, await adminState());
});

/**
 * Sanity checks so a mis-tap during the live show can't corrupt scoring:
 *  - group placements must be a breed from that group, not already placed
 *    elsewhere in the same group
 *  - BIS / Reserve BIS must be a group winner, and not the same dog
 */
async function validateResult(slot, breedId) {
  if (!ALL_SLOTS.includes(slot)) throw new HttpError(400, 'Unknown result slot.');
  const breed = BREED_BY_ID.get(breedId);
  if (!breed) throw new HttpError(400, 'Unknown breed.');

  const { results } = await loadResults({ revealedOnly: false });
  const gs = parseGroupSlot(slot);
  if (gs) {
    if (breed.group !== gs.group) throw new HttpError(400, `${breed.name} is not in that group.`);
    for (let p = 1; p <= 4; p += 1) {
      const other = `${gs.group}:${p}`;
      if (other !== slot && results[other] === breedId) {
        throw new HttpError(409, `${breed.name} already has another placement in this group. Clear it first.`);
      }
    }
    return;
  }
  // BIS or RBIS
  if (results[`${breed.group}:1`] !== breedId) {
    throw new HttpError(400, `${breed.name} must be entered as its group winner first.`);
  }
  const otherTop = slot === 'BIS' ? 'RBIS' : 'BIS';
  if (results[otherTop] === breedId) {
    throw new HttpError(409, 'Best in Show and Reserve Best in Show must be different dogs.');
  }
}

async function adminState() {
  const [players, all, pub] = await Promise.all([
    loadPlayers(),
    loadResults({ revealedOnly: false }),
    loadResults({ revealedOnly: true }),
  ]);
  const scored = scorePlayers(players, pub.results);
  return {
    lockAt: lockAt().toISOString(),
    locked: isLocked(),
    results: all.results,
    revealed: all.revealed,
    players: scored.players.map((p) => ({
      id: p.id, name: p.name, total: p.total, rank: p.rank, createdAt: p.createdAt,
      hasPicks: Object.values(p.picks || {}).some((ids) => ids.length),
    })),
    pickStats: pickStats(players),
  };
}

/**
 * Admin-only pick statistics (players' picks stay hidden from everyone else
 * until the lock). Counts only, no names: per group, every breed picked by
 * at least one player, most popular first; plus Best in Show call counts.
 */
function pickStats(players) {
  const groupCounts = new Map(GROUPS.map((g) => [g.key, new Map()]));
  const bisCounts = new Map();
  for (const p of players) {
    for (const [g, ids] of Object.entries(p.picks || {})) {
      const m = groupCounts.get(g);
      if (!m) continue;
      for (const id of ids) m.set(id, (m.get(id) || 0) + 1);
    }
    for (const id of p.bisPicks || []) bisCounts.set(id, (bisCounts.get(id) || 0) + 1);
  }
  const sorted = (m) => [...m].map(([breedId, count]) => ({ breedId, count }))
    .sort((a, b) => b.count - a.count || a.breedId.localeCompare(b.breedId));
  return {
    playerCount: players.length,
    underdogMaxPickers: UNDERDOG_MAX_PICKERS,
    groups: GROUPS.map((g) => {
      const list = sorted(groupCounts.get(g.key));
      return {
        key: g.key,
        breeds: list,
        distinct: list.length,
        underdogs: list.filter((x) => x.count <= UNDERDOG_MAX_PICKERS).length,
      };
    }),
    bisCalls: sorted(bisCounts),
  };
}
