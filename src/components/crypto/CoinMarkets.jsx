// A coin's 15-minute market (target, countdown, Up / Down) and its hourly main strike (Above / Below, countdown).
// Shared by the Crypto tab's cards and the coin page.

import CryptoPick from './CryptoPick.jsx';
import { countdownText, sectionOpen } from '../../lib/crypto.js';
import { formatCloseClock, formatStrike } from '../../../shared/crypto/coins.js';

function Countdown({ section, nowMs }) {
  const open = sectionOpen(section, nowMs);
  const left = countdownText(section.closeTime, nowMs);
  return (
    <span className={open ? 'crypto-countdown' : 'crypto-countdown closed'}>
      {left ? `${left} left · closes ${formatCloseClock(section.closeTime)}` : `Closed at ${formatCloseClock(section.closeTime)}`}
    </span>
  );
}

function NextSoon({ title }) {
  return (
    <div className="crypto-market">
      <div className="crypto-market-head">
        <strong>{title}</strong>
        <span className="muted small">Next market opens soon</span>
      </div>
    </div>
  );
}

export function FifteenMarket({ coin, section, nowMs }) {
  if (!section) return coin.kinds?.includes('15m') ? <NextSoon title="15 min · Up or Down" /> : null;
  const row = section.market;
  const open = sectionOpen(section, nowMs);
  return (
    <div className="crypto-market">
      <div className="crypto-market-head">
        <strong>15 min · Up or Down</strong>
        <Countdown section={section} nowMs={nowMs} />
      </div>
      <div className="muted small">Target {formatStrike('15m', row.strike)}</div>
      <div className="crypto-picks">
        <CryptoPick coin={coin} section={section} row={row} side="yes" label="Up" open={open} />
        <CryptoPick coin={coin} section={section} row={row} side="no" label="Down" open={open} />
      </div>
    </div>
  );
}

export function HourlyMain({ coin, section, nowMs }) {
  if (!section) return coin.kinds?.includes('hourly') ? <NextSoon title="Hourly · Above or Below" /> : null;
  const row = section.main;
  const open = sectionOpen(section, nowMs) && Boolean(row);
  return (
    <div className="crypto-market">
      <div className="crypto-market-head">
        <strong>Hourly · {row ? formatStrike('hourly', row.strike) : 'Above or Below'}</strong>
        <Countdown section={section} nowMs={nowMs} />
      </div>
      {row ? (
        <div className="crypto-picks">
          <CryptoPick coin={coin} section={section} row={row} side="yes" label="Above" open={open} />
          <CryptoPick coin={coin} section={section} row={row} side="no" label="Below" open={open} />
        </div>
      ) : (
        <p className="muted small">No strike is trading right now.</p>
      )}
    </div>
  );
}
