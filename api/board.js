// GET /api/board?league=mlb|nfl|nhl|ncaaf|nba
// Returns the league's games and pre-game odds, shared across all players through a 30-second cache.

import { HttpError, withHandler } from '../server/http.js';
import { requireUser } from '../server/auth.js';
import { getLeague } from '../server/leagues.js';
import { getOrRefresh } from '../server/cache.js';
import { buildBoard } from '../server/board.js';

const BOARD_TTL_MS = 30 * 1000;

function readLeague(req) {
  let raw = req.query?.league;
  if (raw === undefined && req.url) {
    raw = new URL(req.url, 'http://localhost').searchParams.get('league');
  }
  return String(Array.isArray(raw) ? raw[0] : raw ?? '').trim().toLowerCase();
}

export default withHandler(['GET'], async (req) => {
  await requireUser(req);

  const leagueId = readLeague(req);
  if (!getLeague(leagueId)) {
    throw new HttpError(400, 'BAD_LEAGUE', 'league must be one of: mlb, nfl, nhl, ncaaf, nba.');
  }

  let result;
  try {
    result = await getOrRefresh(`board_${leagueId}`, BOARD_TTL_MS, () => buildBoard(leagueId));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(`board ${leagueId} failed:`, err);
    throw new HttpError(502, 'UPSTREAM_UNAVAILABLE', 'Scores could not be loaded from ESPN. Trying again shortly.');
  }

  return {
    league: leagueId,
    fetchedAt: new Date(result.fetchedAtMs).toISOString(),
    stale: result.stale === true,
    partial: result.value.partial === true,
    kalshiStatus: result.value.kalshiStatus || 'ok',
    games: result.value.games,
  };
});
