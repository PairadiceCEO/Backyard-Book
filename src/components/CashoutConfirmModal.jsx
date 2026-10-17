// Confirms a cash out at the value the player saw. The server re-prices with fresh data; if the value
// moved it answers CASHOUT_CHANGED and this dialog shows the new value for the player to confirm again.

import { useEffect } from 'react';
import { formatMoney } from '../lib/format.js';

export default function CashoutConfirmModal({ bet, valueCents, previousCents, busy, error, unavailable, onConfirm, onClose }) {
  // Close with Escape (not while the request is in flight). Sets no state.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const title = bet.type === 'parlay' ? `Parlay · ${bet.legs.length} legs` : bet.legs[0]?.label ?? 'Bet';

  return (
    <div className="modal-backdrop" role="presentation" onClick={busy ? undefined : onClose}>
      <div className="modal card" role="dialog" aria-modal="true" aria-labelledby="cashout-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="cashout-title" className="card-title">
          Cash out this bet?
        </h2>
        <div className="confirm-bet">
          <div className="confirm-bet-head">
            <strong>{title}</strong>
          </div>
          {bet.type === 'parlay'
            ? bet.legs.map((leg) => (
                <div key={leg.legId} className="muted small">
                  {leg.label} · {leg.gameLabel}
                </div>
              ))
            : <div className="muted small">{bet.legs[0]?.gameLabel}</div>}
          <div className="confirm-money">
            <span>Stake {formatMoney(bet.stakeCents)}</span>
            <span>To win {formatMoney(bet.potentialPayoutCents)}</span>
          </div>
        </div>

        {unavailable ? (
          <p className="warning-text">{unavailable}</p>
        ) : (
          <>
            {previousCents !== null && previousCents !== undefined ? (
              <p className="warning-text small" role="status">
                The cash out value changed from {formatMoney(previousCents)} to {formatMoney(valueCents)}. Confirm again to take the new
                amount.
              </p>
            ) : null}
            <p className="cashout-amount">
              You get <strong>{formatMoney(valueCents)}</strong> now
            </p>
            <p className="muted small">The bet ends here: you keep this amount whatever happens in the game.</p>
          </>
        )}
        {error ? <p className="error-text small">{error}</p> : null}

        <div className="confirm-footer">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {unavailable ? 'Close' : 'Keep bet'}
          </button>
          {unavailable ? null : (
            <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy}>
              {busy ? 'Cashing out…' : `Cash out ${formatMoney(valueCents)}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
