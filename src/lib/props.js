// Player props on the phone: polling a game's props page and building slip picks. The server decides prices and
// whether props are open (pre-game only); these only display and build picks, which are re-priced when placed.

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from './api.js';
import { usePolling } from '../hooks/usePolling.js';
import { makeLegId, pickLabel } from '../../shared/betRules.js';
import { PROP_MARKET } from '../../shared/props.js';

export const PROPS_POLL_MS = 30 * 1000;

// Polls /api/board?league=…&game={id}&props=1 every 30 s while visible; answers for a game the user left are dropped.
export function usePropsData(league, gameId) {
  const key = `${league}/${gameId}`;
  const [result, setResult] = useState({ key: null, data: null, error: '', notFound: false });
  const currentKeyRef = useRef(key);
  const inFlightRef = useRef(null);

  useEffect(() => {
    currentKeyRef.current = key;
    return () => {
      currentKeyRef.current = null;
    };
  }, [key]);

  const load = useCallback(async () => {
    const target = key;
    if (inFlightRef.current === target) return;
    inFlightRef.current = target;
    try {
      const data = await apiRequest(`/api/board?league=${encodeURIComponent(league)}&game=${encodeURIComponent(gameId)}&props=1`);
      if (currentKeyRef.current === target) setResult({ key: target, data, error: '', notFound: false });
    } catch (err) {
      if (currentKeyRef.current === target) {
        setResult((prev) => ({
          key: target,
          data: prev.key === target ? prev.data : null,
          error: err.message || 'Could not load player props.',
          notFound: err.status === 404,
        }));
      }
    } finally {
      if (inFlightRef.current === target) inFlightRef.current = null;
    }
  }, [key, league, gameId]);

  usePolling(load, PROPS_POLL_MS, key);

  const current = result.key === key;
  const data = current ? result.data : null;
  return {
    game: data?.game ?? null,
    props: data?.props ?? null,
    fetchedAt: data?.fetchedAt ?? null,
    error: current ? result.error : '',
    notFound: current ? result.notFound : false,
    loading: !current || (!result.data && !result.error),
    retry: load,
  };
}

// The slip pick for one side of one threshold. tab: { series, stat, anytime }; player: { name, team }; row: { ticker, threshold, strike, yes, no }.
export function makePropPick(game, tab, player, row, side) {
  const quote = row?.[side];
  if (!quote) return null;
  const prop = { series: tab.series, stat: tab.stat, anytime: tab.anytime, player: player.name, team: player.team, threshold: row.threshold };
  return {
    legId: makeLegId({ league: game.league, gameId: game.id, marketType: PROP_MARKET, selection: side, line: row.strike, source: quote.source, ticker: row.ticker }),
    kalshi: { ticker: row.ticker, side },
    league: game.league,
    gameId: game.id,
    marketType: PROP_MARKET,
    selection: side,
    homeName: game.home.shortName,
    awayName: game.away.shortName,
    gameLabel: `${game.away.shortName} @ ${game.home.shortName}`,
    line: row.strike,
    american: quote.american,
    decimal: quote.decimal,
    source: quote.source,
    prop,
    label: pickLabel({ marketType: PROP_MARKET, selection: side, prop }),
  };
}
