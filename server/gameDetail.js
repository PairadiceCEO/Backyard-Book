// One game with its main lines and every posted Kalshi alternate line.
// Reads the same 30-second board cache, so viewing a game adds no Kalshi requests.
// Only if the board's alternate copy was dropped for size does it fetch this game's two events
// (cached per game for 30 seconds).

import { HttpError } from './http.js';
import { getOrRefresh } from './cache.js';
import { buildBoard } from './board.js';
import { buildLadders, compactFromEvents, fetchEvent } from './sources/kalshi.js';

const TTL_MS = 30 * 1000;

function emptyLadders() {
  return { spreads: { home: [], away: [] }, totals: [] };
}

export async function getGameDetail(leagueId, gameId, { fetchImpl = fetch, now = () => new Date() } = {}) {
  const boardResult = await getOrRefresh(`board_${leagueId}`, TTL_MS, () => buildBoard(leagueId, { now: now(), fetchImpl }));
  const board = boardResult.value;
  const game = board.games.find((g) => g.id === String(gameId));
  if (!game) throw new HttpError(404, 'GAME_NOT_FOUND', 'That game is no longer on the board.');

  let ladders = emptyLadders();
  const priced = game.source === 'espn' && game.state !== 'post' && !game.canceled && game.kalshi;
  if (priced) {
    let compact = board.alts?.[game.id] ?? null;
    if (!compact && board.altsDropped && (game.kalshi.spreadEvent || game.kalshi.totalEvent)) {
      const key = `alts_${leagueId}_${String(game.id).replace(/[^A-Za-z0-9_-]/g, '')}`;
      const result = await getOrRefresh(key, TTL_MS, async () => {
        const [spreadEvent, totalEvent] = await Promise.all([
          game.kalshi.spreadEvent ? fetchEvent(game.kalshi.spreadEvent, fetchImpl) : null,
          game.kalshi.totalEvent ? fetchEvent(game.kalshi.totalEvent, fetchImpl) : null,
        ]);
        return compactFromEvents(spreadEvent, totalEvent);
      });
      compact = result.value;
    }
    // Only show alternates from the exact events this game is mapped to (a cached copy may predate the mapping).
    if (compact) {
      compact = {
        s: compact.s && compact.s.e === game.kalshi.spreadEvent ? compact.s : null,
        t: compact.t && compact.t.e === game.kalshi.totalEvent ? compact.t : null,
      };
    }
    ladders = buildLadders(compact, game.kalshi.sideByCode);
  }

  return {
    league: leagueId,
    fetchedAt: new Date(boardResult.fetchedAtMs).toISOString(),
    stale: boardResult.stale === true,
    kalshiStatus: board.kalshiStatus || 'ok',
    game,
    ladders,
  };
}
