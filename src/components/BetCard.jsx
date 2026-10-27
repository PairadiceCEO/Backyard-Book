// One bet in My Bets: type, legs with odds, stake, potential or actual payout, result.
// Finished bets show each leg's result and its game's final score, and what was paid.
// Open bets show the server's cash out estimate (cashout prop) with a "Cash out $X" button.

import { formatAmerican, formatCentralDateTime, formatMoney } from '../lib/format.js';

const STATUS_LABELS = { open: 'Open', won: 'Won', lost: 'Lost', push: 'Push', void: 'Void', cashed_out: 'Cashed out' };
const RESULT_LABELS = { win: 'Won', loss: 'Lost', push: 'Push', void: 'Void' };

function asDate(value) {
  if (!value) return null;
  const date = typeof value.toDate === 'function' ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function LegResult({ leg, finished }) {
  const label = RESULT_LABELS[leg.result];
  if (label) return <span className={`leg-result result-${leg.result}`}>{label}</span>;
  // A lost parlay stops grading its other legs.
  if (finished) return <span className="leg-result muted">Not graded</span>;
  return null;
}

function paidNote(bet) {
  if (bet.status === 'push' || bet.status === 'void') return 'Stake returned';
  if (bet.status === 'won' && bet.type === 'parlay' && bet.droppedLegs > 0 && Number.isFinite(bet.settledAmerican)) {
    return `${bet.droppedLegs} leg${bet.droppedLegs === 1 ? '' : 's'} pushed/voided · paid at ${formatAmerican(bet.settledAmerican)}`;
  }
  return '';
}

function CashoutRow({ bet, cashout, onCashOut }) {
  if (!onCashOut) return null;
  if (!cashout) return <div className="cashout-row muted small">Checking cash out…</div>;
  if (!cashout.available) {
    return <div className="cashout-row muted small">{cashout.reason || 'Cash out unavailable right now'}</div>;
  }
  return (
    <div className="cashout-row">
      <span className="muted small">{cashout.mode === 'live' ? 'Live cash out value' : 'Cash out before the game'}</span>
      <button type="button" className="btn btn-primary btn-cashout" onClick={() => onCashOut(bet, cashout.valueCents)}>
        Cash out {formatMoney(cashout.valueCents)}
      </button>
    </div>
  );
}

export default function BetCard({ bet, cashout = null, onCashOut = null }) {
  const isOpen = bet.status === 'open';
  const isCashedOut = bet.status === 'cashed_out';
  const placed = asDate(bet.placedAt);
  const settled = asDate(bet.cashedOutAt ?? bet.settledAt);
  const note = isOpen || isCashedOut ? '' : paidNote(bet);

  return (
    <article className={`bet-card status-${bet.status}`}>
      <header className="bet-card-head">
        <strong>
          {bet.type === 'parlay' ? `Parlay · ${bet.legs.length} legs` : 'Single'}
          {bet.posterBet ? <span className="tag tag-poster">Poster's bet</span> : null}
        </strong>
        <span className={`bet-status status-${bet.status}`}>{STATUS_LABELS[bet.status] ?? bet.status}</span>
      </header>

      <ul className="bet-legs">
        {bet.legs.map((leg) => (
          <li key={leg.legId} className="bet-leg">
            <div>
              <div>{leg.label}</div>
              <div className="muted small">{leg.gameLabel}</div>
              {leg.scoreText ? <div className="small leg-score">{leg.scoreText}</div> : null}
            </div>
            <div className="bet-leg-right">
              <span>{formatAmerican(leg.americanOdds)}</span>
              <LegResult leg={leg} finished={!isOpen && !isCashedOut} />
            </div>
          </li>
        ))}
      </ul>
      {bet.agentWhy ? <p className="agent-why">AI: “{bet.agentWhy}”</p> : null}

      <footer className="bet-card-foot">
        <span>
          Stake <strong>{formatMoney(bet.stakeCents)}</strong>
          {bet.type === 'parlay' ? <span className="muted"> at {formatAmerican(bet.combinedAmerican)}</span> : null}
        </span>
        {isOpen ? (
          <span>
            To win <strong>{formatMoney(bet.potentialPayoutCents)}</strong>
          </span>
        ) : isCashedOut ? (
          <span>
            Cashed out <strong>{formatMoney(bet.cashoutCents ?? bet.payoutCents)}</strong>
          </span>
        ) : (
          <span>
            Paid <strong>{formatMoney(bet.payoutCents)}</strong>
          </span>
        )}
      </footer>
      {isOpen ? <CashoutRow bet={bet} cashout={cashout} onCashOut={onCashOut} /> : null}
      {note ? <div className="muted small">{note}</div> : null}
      {isOpen && bet.needsReview ? <div className="warning-text small">Waiting on the admin to check this result.</div> : null}
      <div className="muted small">
        Placed {placed ? formatCentralDateTime(placed) : ''}
        {settled ? ` · ${isCashedOut ? 'Cashed out' : 'Settled'} ${formatCentralDateTime(settled)}` : ''}
      </div>
    </article>
  );
}
