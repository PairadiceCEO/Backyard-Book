// One coin, like a game's alternate-lines page: the current Coinbase price in big text, this hour's 1-minute
// chart (15-min target and hourly main strike as labeled lines, both close times marked), the 15-minute
// Up / Down market and every hourly strike with Above / Below. Refreshes every 10 s.

import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import UpdatedAgo from '../../components/UpdatedAgo.jsx';
import CryptoChart from '../../components/crypto/CryptoChart.jsx';
import CryptoPick from '../../components/crypto/CryptoPick.jsx';
import { FifteenMarket } from '../../components/crypto/CoinMarkets.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/StatusViews.jsx';
import { countdownText, sectionOpen, useCryptoData, useServerNow } from '../../lib/crypto.js';
import { formatCloseClock, formatCryptoPrice, formatStrike, hourlyStrikeValue } from '../../../shared/crypto/coins.js';

function HourlyLadder({ coin, section, nowMs }) {
  if (!section) {
    return coin.kinds.includes('hourly') ? <p className="muted small">Next market opens soon.</p> : null;
  }
  const open = sectionOpen(section, nowMs);
  const left = countdownText(section.closeTime, nowMs);
  const rows = [...(section.ladder ?? [])].reverse(); // highest strike first
  return (
    <div className="card">
      <h3>
        Hourly · Above or Below <span className="muted small">· closes {formatCloseClock(section.closeTime)}</span>
      </h3>
      <p className={open ? 'crypto-countdown' : 'crypto-countdown closed'}>{left ? `${left} left` : 'Closed'}</p>
      {rows.length === 0 ? <p className="muted small">No strike is trading right now.</p> : null}
      <div className="totals-ladder crypto-ladder">
        {rows.length ? (
          <div className="totals-row totals-head muted small">
            <span>Price at {formatCloseClock(section.closeTime)}</span>
            <span>Above</span>
            <span>Below</span>
          </div>
        ) : null}
        {rows.map((row) => (
          <div key={row.ticker} className={row.ticker === section.main?.ticker ? 'totals-row main-strike' : 'totals-row'}>
            <span className="totals-line">{formatStrike('hourly', row.strike)}</span>
            <CryptoPick coin={coin} section={section} row={row} side="yes" label="Above" open={open} />
            <CryptoPick coin={coin} section={section} row={row} side="no" label="Below" open={open} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CryptoCoinPage() {
  const { coin: coinId } = useParams();
  const { data, offsetMs, error, notFound, loading, retry } = useCryptoData(coinId);
  const nowMs = useServerNow(offsetMs);
  const coin = data?.coin ?? null;
  const chart = data?.chart ?? null;

  // Stable inputs for the chart (it re-renders every second for the countdowns).
  const fifteen = coin?.fifteen ?? null;
  const hourly = coin?.hourly ?? null;
  const levels = useMemo(() => {
    const list = [];
    if (fifteen?.market?.strike != null) list.push({ value: fifteen.market.strike, label: '15-min target', kind: 'target' });
    if (hourly?.main?.strike != null) list.push({ value: hourlyStrikeValue(hourly.main.strike), label: 'Hourly', kind: 'strike' });
    return list;
  }, [fifteen?.market?.strike, hourly?.main?.strike]);
  const marks = useMemo(() => {
    const list = [];
    if (fifteen?.closeTime) list.push({ t: Date.parse(fifteen.closeTime), label: `15m ${formatCloseClock(fifteen.closeTime)}`, kind: 'target' });
    if (hourly?.closeTime) list.push({ t: Date.parse(hourly.closeTime), label: `Hourly ${formatCloseClock(hourly.closeTime)}`, kind: 'strike' });
    return list;
  }, [fifteen?.closeTime, hourly?.closeTime]);

  return (
    <section className="page">
      <div className="detail-top">
        <Link to="/sportsbook" className="btn btn-ghost small">
          ‹ Back to board
        </Link>
        <UpdatedAgo timestamp={data?.fetchedAt ?? null} />
      </div>

      {loading ? <LoadingState label="Loading…" rows={3} /> : null}
      {!loading && notFound ? (
        <EmptyState
          icon="🪙"
          title="This coin isn't offered"
          action={
            <Link to="/sportsbook" className="btn btn-primary">
              Back to board
            </Link>
          }
        />
      ) : null}
      {!loading && error && !notFound && !coin ? <ErrorState title="Couldn't load this coin" message={error} onRetry={retry} /> : null}

      {coin ? (
        <>
          <div className="crypto-hero">
            <div>
              <h2 className="section-title">{coin.name}</h2>
              <span className="muted small">{coin.symbol} · Coinbase</span>
            </div>
            <div className="crypto-hero-price">{coin.price !== null ? formatCryptoPrice(coin.price) : '—'}</div>
          </div>
          <div className="card crypto-chart-card">
            <CryptoChart chart={chart} levels={levels} marks={marks} />
            {chart ? <p className="muted small">1-minute closes this hour · refreshes every 10 s</p> : null}
          </div>
          <div className="card">
            <FifteenMarket coin={coin} section={fifteen} nowMs={nowMs} />
          </div>
          <HourlyLadder coin={coin} section={hourly} nowMs={nowMs} />
          <p className="muted small">
            Singles only. Betting closes 60 seconds before each market closes. Kalshi&apos;s own result settles every bet; the
            chart is for reference.
          </p>
        </>
      ) : null}
    </section>
  );
}
