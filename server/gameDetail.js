// One game with its main lines and every posted Kalshi alternate line.
// Reads the same 30-second board cache, so viewing a game adds no Kalshi requests.
// Only if the board's alternate copy was dropped for size does it fetch this game's two events
// (cached per game for 30 seconds).

import { HttpError } from './http.js';
import { getOrRefresh } from './cache.js';
import { CUSTOM_BOARD_ID, CUSTOM_BOARD_KEY, buildBoard, buildCustomBoard } from './board.js';
import { buildLadders, compactFromEvents, fetchEvent } from './sources/kalshi.js';
import { loadGameProps } from './props.js';
import { propsOpen } from '../shared/props.js';

const TTL_MS = 30 * 1000;

function emptyLadders() {
  return { spreads: { home: [], away: [] }, totals: [] };
}

// props: true → the game's player props page instead of its alternate lines (pre-game only; Kalshi, 30 s memory cache).
export async function getGameDetail(leagueId, gameId, { fetchImpl = fetch, now = () => new Date(), props = false } = {}) {
  const boardResult =
    leagueId === CUSTOM_BOARD_ID
      ? await getOrRefresh(CUSTOM_BOARD_KEY, TTL_MS, () => buildCustomBoard({ now: now() }))
      : await getOrRefresh(`board_${leagueId}`, TTL_MS, () => buildBoard(leagueId, { now: now(), fetchImpl }));
  const board = boardResult.value;
  const game = board.games.find((g) => g.id === String(gameId));
  if (!game) throw new HttpError(404, 'GAME_NOT_FOUND', 'That game is no longer on the board.');
  const base = {
    league: leagueId,
    fetchedAt: new Date(boardResult.fetchedAtMs).toISOString(),
    stale: boardResult.stale === true,
    kalshiStatus: board.kalshiStatus || 'ok',
    game,
  };
  const nowMs = now().getTime();
  if (props) {
    const loaded = await loadGameProps(game, { nowMs, fetchImpl });
    return { ...base, props: loaded, serverNow: nowMs };
  }

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

  // The game page shows a "Player props" button only before the game and when at least one prop is tradable.
  let propsCount = 0;
  if (game.source === 'espn' && propsOpen(game, nowMs) && game.kalshi?.gameEvent) {
    try {
      const loaded = await loadGameProps(game, { nowMs, fetchImpl });
      // Distinct players (one player usually has several stat tabs).
      propsCount = new Set(loaded.tabs.flatMap((tab) => tab.players.map((p) => `${p.team ?? ''}|${p.name}`))).size;
    } catch (err) {
      console.error(`props count ${leagueId}/${gameId} failed:`, err.message);
    }
  }

  return { ...base, ladders, propsCount };
}
