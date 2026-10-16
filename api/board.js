// GET /api/board?league=mlb|nfl|nhl|ncaaf|nba            → the league's games and main lines
// GET /api/board?league=…&game={id}                       → one game plus every posted alternate line
// Both read one 30-second cache shared by all players.

import { HttpError, withHandler } from '../server/http.js';
import { requireUser } from '../server/auth.js';
import { getLeague } from '../server/leagues.js';
import { getOrRefresh } from '../server/cache.js';
import { buildBoard } from '../server/board.js';
import { getGameDetail } from '../server/gameDetail.js';

const BOARD_TTL_MS = 30 * 1000;

function readParam(req, name) {
  let raw = req.query?.[name];
  if (raw === undefined && req.url) {
    raw = new URL(req.url, 'http://localhost').searchParams.get(name);
  }
  return String(Array.isArray(raw) ? raw[0] : raw ?? '').trim();
}

export default withHandler(['GET'], async (req) => {
  await requireUser(req);

  const leagueId = readParam(req, 'league').toLowerCase();
  if (!getLeague(leagueId)) {
    throw new HttpError(400, 'BAD_LEAGUE', 'league must be one of: mlb, nfl, nhl, ncaaf, nba.');
  }
  const gameId = readParam(req, 'game');
  if (gameId.length > 120) throw new HttpError(400, 'BAD_GAME', 'Invalid game id.');

  try {
    if (gameId) return await getGameDetail(leagueId, gameId);

    const result = await getOrRefresh(`board_${leagueId}`, BOARD_TTL_MS, () => buildBoard(leagueId));
    return {
      league: leagueId,
      fetchedAt: new Date(result.fetchedAtMs).toISOString(),
      stale: result.stale === true,
      partial: result.value.partial === true,
      kalshiStatus: result.value.kalshiStatus || 'ok',
      games: result.value.games, // alternate lines stay in the cache; the game page asks for them
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(`board ${leagueId}${gameId ? ` game ${gameId}` : ''} failed:`, err);
    throw new HttpError(502, 'UPSTREAM_UNAVAILABLE', 'Scores could not be loaded from ESPN. Trying again shortly.');
  }
});
