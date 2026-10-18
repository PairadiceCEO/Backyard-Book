// The Sportsbook's Crypto tab: one card per coin with its live Coinbase price, the 15-minute Up / Down market and
// the hourly main strike. Tapping a card (anywhere but a price) opens the coin's page with the chart and the full
// hourly ladder. Refreshes every 10 s; countdowns tick on the server's clock.

import { useNavigate } from 'react-router-dom';
import UpdatedAgo from '../../components/UpdatedAgo.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/StatusViews.jsx';
import { FifteenMarket, HourlyMain } from '../../components/crypto/CoinMarkets.jsx';
import { useCryptoData, useServerNow } from '../../lib/crypto.js';
import { formatCryptoPrice } from '../../../shared/crypto/coins.js';

export function coinPath(coin) {
  return `/sportsbook/crypto/${encodeURIComponent(coin.id)}`;
}

function CoinCard({ coin, nowMs }) {
  const navigate = useNavigate();
  function open(event) {
    if (event.target.closest('button, a, input, label')) return; // price taps go to the slip
    navigate(coinPath(coin));
  }
  function openWithKey(event) {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      navigate(coinPath(coin));
    }
  }
  return (
    <article className="game-card crypto-card clickable" role="link" tabIndex={0} aria-label={`${coin.name}: chart and every strike`} onClick={open} onKeyDown={openWithKey}>
      <header className="crypto-card-head">
        <span className="crypto-coin">
          <span className="crypto-symbol">{coin.symbol}</span>
          <span className="muted small">{coin.name}</span>
        </span>
        <span className="crypto-price">{coin.price !== null ? formatCryptoPrice(coin.price) : '—'}</span>
      </header>
      <FifteenMarket coin={coin} section={coin.fifteen} nowMs={nowMs} />
      <HourlyMain coin={coin} section={coin.hourly} nowMs={nowMs} />
      <footer className="game-footer muted small">
        <span>Kalshi · price from Coinbase</span>
        <span className="more-lines">Chart and all strikes ›</span>
      </footer>
    </article>
  );
}

export default function CryptoBoard() {
  const { data, offsetMs, error, loading, retry } = useCryptoData(null);
  const nowMs = useServerNow(offsetMs);
  const coins = data?.coins ?? null;

  return (
    <>
      <div className="board-status">
        <UpdatedAgo timestamp={data?.fetchedAt ?? null} />
        {coins?.some((c) => c.kalshiError) ? <span className="warning-text small">Kalshi isn't answering for some coins; retrying.</span> : null}
      </div>
      {loading ? <LoadingState label="Loading crypto markets…" rows={3} /> : null}
      {!loading && error && !coins ? <ErrorState title="Couldn't load crypto markets" message={error} onRetry={retry} /> : null}
      {!loading && coins && coins.length === 0 ? <EmptyState icon="🪙" title="No crypto markets right now" /> : null}
      {coins ? (
        <>
          <p className="muted small">
            Bet whether a coin finishes up or down over 15 minutes, or above or below a price at the top of the hour. Singles
            only; betting closes 60 seconds before each market closes. Settled by Kalshi&apos;s result.
          </p>
          <div className="day-group">
            {coins.map((coin) => (
              <CoinCard key={coin.id} coin={coin} nowMs={nowMs} />
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
