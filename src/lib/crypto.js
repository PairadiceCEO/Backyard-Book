// Crypto markets on the phone: polling the Crypto board / one coin, a 1-second clock on the server's time for
// countdowns, and the bet slip pick for a market side. The server decides prices and whether betting is open;
// this only displays and builds picks (they are re-priced fresh when placed).

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from './api.js';
import { usePolling } from '../hooks/usePolling.js';
import { makeLegId, pickLabel } from '../../shared/betRules.js';
import { CRYPTO_LEAGUE, CRYPTO_MARKET, cryptoGameLabel } from '../../shared/crypto/coins.js';

export const CRYPTO_POLL_MS = 10 * 1000;

// Polls /api/board?league=crypto (coinId null) or one coin (&game={coinId}) every 10 s while visible.
// Answers for a screen the user already left are dropped; the last good answer stays on a failed refresh.
export function useCryptoData(coinId = null) {
  const key = coinId ? `coin:${coinId}` : 'board';
  const [result, setResult] = useState({ key: null, data: null, offsetMs: 0, error: '', notFound: false });
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
      const path = coinId ? `/api/board?league=crypto&game=${encodeURIComponent(coinId)}` : '/api/board?league=crypto';
      const data = await apiRequest(path);
      if (currentKeyRef.current === target) {
        const offsetMs = Number.isFinite(data?.serverNow) ? data.serverNow - Date.now() : 0;
        setResult({ key: target, data, offsetMs, error: '', notFound: false });
      }
    } catch (err) {
      if (currentKeyRef.current === target) {
        setResult((prev) => ({
          key: target,
          data: prev.key === target ? prev.data : null,
          offsetMs: prev.key === target ? prev.offsetMs : 0,
          error: err.message || 'Could not load crypto markets.',
          notFound: err.status === 404,
        }));
      }
    } finally {
      if (inFlightRef.current === target) inFlightRef.current = null;
    }
  }, [key, coinId]);

  usePolling(load, CRYPTO_POLL_MS, key);

  const current = result.key === key;
  return {
    data: current ? result.data : null,
    offsetMs: current ? result.offsetMs : 0,
    error: current ? result.error : '',
    notFound: current ? result.notFound : false,
    loading: !current || (!result.data && !result.error),
    retry: load,
  };
}

// The server's clock (ms), re-rendering once a second for countdowns. One interval, cleared on unmount.
export function useServerNow(offsetMs) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now + (Number.isFinite(offsetMs) ? offsetMs : 0);
}

// "4:07" until `iso` (minutes:seconds; hours shown as h:mm:ss), or null once it has passed.
export function countdownText(iso, nowMs) {
  const left = Date.parse(iso) - nowMs;
  if (!Number.isFinite(left) || left <= 0) return null;
  const total = Math.ceil(left / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Betting on a section is open until 60 s before its close (the server's bettingClosesAt).
export function sectionOpen(section, nowMs) {
  return Boolean(section?.bettingOpen) && Date.parse(section.bettingClosesAt) > nowMs;
}

// The slip pick for one side of one market. coin: { name, symbol }; section: fifteen / hourly; row: { ticker, strike, yes, no }.
export function makeCryptoPick(coin, section, row, side) {
  const quote = row?.[side];
  if (!quote) return null;
  const gameId = section.gameId;
  const crypto = { symbol: coin.symbol, kind: section.kind, closeTime: section.closeTime };
  return {
    legId: makeLegId({ league: CRYPTO_LEAGUE, gameId, marketType: CRYPTO_MARKET, selection: side, line: row.strike, source: quote.source }),
    kalshi: { ticker: row.ticker, side },
    league: CRYPTO_LEAGUE,
    gameId,
    marketType: CRYPTO_MARKET,
    selection: side,
    homeName: '',
    awayName: '',
    gameLabel: cryptoGameLabel({ name: coin.name, kind: section.kind, closeTime: section.closeTime }),
    line: row.strike,
    american: quote.american,
    decimal: quote.decimal,
    source: quote.source,
    crypto,
    label: pickLabel({ marketType: CRYPTO_MARKET, selection: side, line: row.strike, crypto }),
  };
}
