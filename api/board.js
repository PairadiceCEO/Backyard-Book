// GET /api/board?league=mlb|nfl|nhl|ncaaf|nba            → the league's games that haven't finished, main lines
// GET /api/board?league=custom                            → the admin's custom games (every league), not finished
// GET /api/board?league=live                              → every ESPN game in progress, all leagues
// GET /api/board?league=crypto                            → one card per coin (Kalshi crypto markets + Coinbase price)
// GET /api/board?league=crypto&game={coin}                → one coin: full hourly ladder and 1-minute candles
//     (crypto is cached in function memory for 10 s only, never in Firestore)
// GET /api/board?league=…&game={id}                       → one game plus every posted alternate line
// All read one 30-second cache per league shared by all players. The cache keeps finished games (settlement,
// pricing and game pages from My Bets need them); only the lists leave them out.

import { HttpError, withHandler } from '../server/http.js';
import { requireUser } from '../server/auth.js';
import { getLeague } from '../server/leagues.js';
import { getOrRefresh } from '../server/cache.js';
import { CUSTOM_BOARD_ID, CUSTOM_BOARD_KEY, LIVE_BOARD_ID, buildBoard, buildCustomBoard, getLiveBoard, listedGames } from '../server/board.js';
import { getGameDetail } from '../server/gameDetail.js';
import { getCryptoBoard, getCryptoCoin } from '../server/crypto.js';
import { CRYPTO_LEAGUE } from '../shared/crypto/coins.js';

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
  const custom = leagueId === CUSTOM_BOARD_ID;
  const live = leagueId === LIVE_BOARD_ID;
  const crypto = leagueId === CRYPTO_LEAGUE;
  if (!custom && !live && !crypto && !getLeague(leagueId)) {
    throw new HttpError(400, 'BAD_LEAGUE', 'league must be one of: live, mlb, nfl, nhl, ncaaf, nba, crypto, custom.');
  }
  const gameId = readParam(req, 'game');
  if (gameId.length > 120) throw new HttpError(400, 'BAD_GAME', 'Invalid game id.');
  if (live && gameId) throw new HttpError(400, 'BAD_GAME', "A live game's page is under its own league.");

  try {
    if (crypto) return gameId ? await getCryptoCoin(gameId) : await getCryptoBoard();
    if (gameId) return await getGameDetail(leagueId, gameId);

    if (live) {
      const board = await getLiveBoard();
      return {
        league: LIVE_BOARD_ID,
        fetchedAt: new Date(board.fetchedAtMs).toISOString(),
        stale: board.stale,
        partial: board.partial,
        kalshiStatus: board.kalshiStatus,
        games: board.games,
      };
    }

    const result = custom
      ? await getOrRefresh(CUSTOM_BOARD_KEY, BOARD_TTL_MS, () => buildCustomBoard())
      : await getOrRefresh(`board_${leagueId}`, BOARD_TTL_MS, () => buildBoard(leagueId));
    return {
      league: leagueId,
      fetchedAt: new Date(result.fetchedAtMs).toISOString(),
      stale: result.stale === true,
      partial: result.value.partial === true,
      kalshiStatus: result.value.kalshiStatus || 'ok',
      // Only games that haven't finished; alternate lines stay in the cache (the game page asks for them).
      games: listedGames(result.value.games),
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(`board ${leagueId}${gameId ? ` game ${gameId}` : ''} failed:`, err);
    const message = custom
      ? 'Custom games could not be loaded. Trying again shortly.'
      : crypto
        ? 'Crypto markets could not be loaded. Trying again shortly.'
        : 'Scores could not be loaded from ESPN. Trying again shortly.';
    throw new HttpError(502, 'UPSTREAM_UNAVAILABLE', message);
  }
});
