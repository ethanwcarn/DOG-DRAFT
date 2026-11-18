/**
 * GET /api/state - everything the public screens need, polled every few
 * seconds: lock status, revealed results, and the leaderboard.
 *
 * Before the lock: only player names are shown (no picks), so nobody can copy
 * a friend's team or game the underdog bonus.
 * After the lock: everyone's picks, pick counts, and scores are public.
 *
 * The response is identical for every visitor, so the CDN may cache it for a
 * couple of seconds to keep database load tiny.
 */
import { route, requireMethod, sendJson } from '../lib/http.js';
import { isLocked, lockAt, loadPlayers, loadResults } from '../lib/game.js';
import { scorePlayers } from '../lib/scoring.js';

export default route(async (req, res) => {
  requireMethod(req, 'GET');
  const [players, { results }] = await Promise.all([loadPlayers(), loadResults({ revealedOnly: true })]);
  const locked = isLocked();

  let leaderboard;
  let pickCounts = null;
  if (locked) {
    const scored = scorePlayers(players, results);
    pickCounts = scored.pickCounts;
    leaderboard = scored.players.map((p) => ({
      id: p.id,
      name: p.name,
      rank: p.rank,
      total: p.total,
      winnersPicked: p.winnersPicked,
      bisCorrect: p.bisCorrect,
      picks: p.picks,
      bisPick: p.bisPick,
      breakdown: p.breakdown,
    }));
  } else {
    leaderboard = players.map((p) => ({ id: p.id, name: p.name, rank: null, total: 0 }));
  }

  sendJson(
    res,
    200,
    {
      serverTime: new Date().toISOString(),
      lockAt: lockAt().toISOString(),
      locked,
      results,
      playerCount: players.length,
      pickCounts,
      leaderboard,
    },
    {
      // Browsers: always ask again (no reuse of old standings during the show).
      'Cache-Control': 'no-cache',
      // Vercel's CDN only: share one copy for 2 seconds to keep database load tiny.
      'Vercel-CDN-Cache-Control': 'max-age=2, stale-while-revalidate=3',
    },
  );
});
