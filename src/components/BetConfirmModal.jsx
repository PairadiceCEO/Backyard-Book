// Shown after bets are placed: final odds (with any price changes), stake, potential payout, new balance.

import { useEffect } from 'react';
import { formatAmerican, formatMoney } from '../lib/format.js';

export default function BetConfirmModal({ result, onClose }) {
  // Close with Escape. Re-subscribes only if onClose changes; sets no state.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const changes = new Map((result.priceChanges ?? []).map((c) => [c.legId, c]));
  const totalStake = result.bets.reduce((sum, b) => sum + b.stakeCents, 0);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bet-confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="bet-confirm-title" className="card-title">
          {result.bets.length === 1 ? 'Bet placed' : `${result.bets.length} bets placed`}
        </h2>
        {changes.size > 0 ? (
          <p className="warning-text small">Some prices moved before your bet was placed. Final odds are shown below.</p>
        ) : null}

        <ul className="confirm-list">
          {result.bets.map((bet) => (
            <li key={bet.id} className="confirm-bet">
              <div className="confirm-bet-head">
                <strong>{bet.type === 'parlay' ? `Parlay · ${bet.legs.length} legs` : 'Single'}</strong>
                {bet.type === 'parlay' ? <span>{formatAmerican(bet.combinedAmerican)}</span> : null}
              </div>
              {bet.legs.map((leg) => {
                const change = changes.get(leg.legId);
                return (
                  <div key={leg.legId} className="confirm-leg">
                    <div>
                      <div>{leg.label}</div>
                      <div className="muted small">{leg.gameLabel}</div>
                    </div>
                    <div className="confirm-odds">
                      {change ? <span className="old-price">{formatAmerican(change.from)}</span> : null}
                      <strong>{formatAmerican(leg.americanOdds)}</strong>
                    </div>
                  </div>
                );
              })}
              <div className="confirm-money">
                <span>Stake {formatMoney(bet.stakeCents)}</span>
                <span>
                  To win <strong>{formatMoney(bet.potentialPayoutCents)}</strong>
                </span>
              </div>
            </li>
          ))}
        </ul>

        <div className="confirm-footer">
          <span className="muted small">
            {formatMoney(totalStake)} taken from your wallet · new balance {formatMoney(result.balanceCents)}
          </span>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
