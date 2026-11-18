/**
 * Scoring rules. Pure functions only (no I/O) so they are easy to test and
 * the same numbers are used everywhere.
 *
 * Result "slots":
 *   "<group>:1" .. "<group>:4"  group placements (1 = group winner)
 *   "RBIS"                       Reserve Best in Show
 *   "BIS"                        Best in Show
 *
 * Only REVEALED slots ever reach these functions from public endpoints.
 * A slot that was never entered simply does not exist, which scores 0. That
 * is how the optional 2nd-4th placements are "skippable".
 */
import { GROUP_KEYS } from './breeds.js';

export const PICKS_PER_GROUP = 3;

export const POINTS = Object.freeze({
  place: { 1: 6, 2: 3, 3: 2, 4: 1 },
  reserveBestInShow: 10,
  bestInShow: 15,
  bestInShowCallBonus: 10,
});

/** A breed picked by this many players or fewer is an underdog (points x2). */
export const UNDERDOG_MAX_PICKERS = 2;
export const UNDERDOG_MULTIPLIER = 2;

export const ALL_SLOTS = [
  ...GROUP_KEYS.flatMap((g) => [1, 2, 3, 4].map((p) => `${g}:${p}`)),
  'RBIS',
  'BIS',
];

/** Parse "hound:2" into { group: 'hound', place: 2 }, or null for BIS/RBIS. */
export function parseGroupSlot(slot) {
  const m = /^([a-z-]+):([1-4])$/.exec(slot);
  if (!m || !GROUP_KEYS.includes(m[1])) return null;
  return { group: m[1], place: Number(m[2]) };
}

/**
 * Base points per breed from the revealed results (before underdog bonus).
 * @param {Record<string,string>} results slot -> breedId (revealed only)
 * @returns {Map<string,{points:number, awards:string[]}>}
 */
export function breedPoints(results) {
  const out = new Map();
  const add = (breedId, pts, award) => {
    if (!breedId) return;
    const cur = out.get(breedId) || { points: 0, awards: [] };
    cur.points += pts;
    cur.awards.push(award);
    out.set(breedId, cur);
  };
  for (const [slot, breedId] of Object.entries(results)) {
    const gs = parseGroupSlot(slot);
    if (gs) add(breedId, POINTS.place[gs.place], gs.place === 1 ? 'Group winner' : `Group ${ordinal(gs.place)}`);
    else if (slot === 'RBIS') add(breedId, POINTS.reserveBestInShow, 'Reserve Best in Show');
    else if (slot === 'BIS') add(breedId, POINTS.bestInShow, 'Best in Show');
  }
  return out;
}

/** How many players picked each breed. */
export function pickCounts(players) {
  const counts = new Map();
  for (const p of players) {
    for (const ids of Object.values(p.picks || {})) {
      for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return counts;
}

/**
 * Score every player and return them ranked.
 * Tiebreakers: more group winners picked, then whoever entered first.
 * Players with identical total AND group-winner count share a rank.
 *
 * @param {Array<{id:number,name:string,picks:Record<string,string[]>,bisPick:string|null,createdAt:string}>} players
 * @param {Record<string,string>} results revealed slot -> breedId
 */
export function scorePlayers(players, results) {
  const bp = breedPoints(results);
  const counts = pickCounts(players);
  const groupWinners = new Set(
    Object.entries(results).filter(([s]) => parseGroupSlot(s)?.place === 1).map(([, b]) => b),
  );

  const scored = players.map((p) => {
    let total = 0;
    let winnersPicked = 0;
    const breakdown = [];
    for (const ids of Object.values(p.picks || {})) {
      for (const id of ids) {
        const base = bp.get(id)?.points || 0;
        const underdog = (counts.get(id) || 0) <= UNDERDOG_MAX_PICKERS;
        const pts = underdog ? base * UNDERDOG_MULTIPLIER : base;
        total += pts;
        if (groupWinners.has(id)) winnersPicked += 1;
        if (pts > 0) breakdown.push({ breedId: id, points: pts, underdog, awards: bp.get(id).awards });
      }
    }
    const bisCorrect = Boolean(results.BIS && p.bisPick === results.BIS);
    if (bisCorrect) total += POINTS.bestInShowCallBonus;
    return { ...p, total, winnersPicked, bisCorrect, breakdown };
  });

  scored.sort(
    (a, b) =>
      b.total - a.total ||
      b.winnersPicked - a.winnersPicked ||
      String(a.createdAt).localeCompare(String(b.createdAt)),
  );

  // Shared ranks for true ties (same total and same tiebreaker).
  scored.forEach((p, i) => {
    const prev = scored[i - 1];
    p.rank = prev && prev.total === p.total && prev.winnersPicked === p.winnersPicked ? prev.rank : i + 1;
  });
  return { players: scored, pickCounts: Object.fromEntries(counts) };
}

function ordinal(n) {
  return { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' }[n] || `${n}th`;
}
