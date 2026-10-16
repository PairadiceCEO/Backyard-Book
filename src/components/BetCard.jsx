// One bet in My Bets: type, legs with odds, stake, potential or actual payout, result.

import { formatAmerican, formatCentralDateTime, formatMoney } from '../lib/format.js';

const STATUS_LABELS = { open: 'Open', won: 'Won', lost: 'Lost', push: 'Push', void: 'Void' };
const RESULT_LABELS = { pending: '', win: 'Won', loss: 'Lost', push: 'Push', void: 'Void' };

function placedTime(placedAt) {
  if (!placedAt) return '';
  const date = typeof placedAt.toDate === 'function' ? placedAt.toDate() : new Date(placedAt);
  return formatCentralDateTime(date);
}

export default function BetCard({ bet }) {
  const isOpen = bet.status === 'open';
  return (
    <article className={`bet-card status-${bet.status}`}>
      <header className="bet-card-head">
        <strong>{bet.type === 'parlay' ? `Parlay · ${bet.legs.length} legs` : 'Single'}</strong>
        <span className={`bet-status status-${bet.status}`}>{STATUS_LABELS[bet.status] ?? bet.status}</span>
      </header>

      <ul className="bet-legs">
        {bet.legs.map((leg) => (
          <li key={leg.legId} className="bet-leg">
            <div>
              <div>{leg.label}</div>
              <div className="muted small">{leg.gameLabel}</div>
            </div>
            <div className="bet-leg-right">
              <span>{formatAmerican(leg.americanOdds)}</span>
              {RESULT_LABELS[leg.result] ? <span className={`leg-result result-${leg.result}`}>{RESULT_LABELS[leg.result]}</span> : null}
            </div>
          </li>
        ))}
      </ul>

      <footer className="bet-card-foot">
        <span>
          Stake <strong>{formatMoney(bet.stakeCents)}</strong>
          {bet.type === 'parlay' ? <span className="muted"> at {formatAmerican(bet.combinedAmerican)}</span> : null}
        </span>
        {isOpen ? (
          <span>
            To win <strong>{formatMoney(bet.potentialPayoutCents)}</strong>
          </span>
        ) : (
          <span>
            Paid <strong>{formatMoney(bet.payoutCents)}</strong>
          </span>
        )}
      </footer>
      <div className="muted small">Placed {placedTime(bet.placedAt)}</div>
    </article>
  );
}
