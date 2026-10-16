// Confirmation for every admin action that can move money: shows what changes and each player's
// wallet before → after, and does nothing until "Confirm" is pressed.

import { useEffect } from 'react';
import { formatMoney } from '../../lib/format.js';

function signedMoney(cents) {
  if (cents === 0) return formatMoney(0);
  return `${cents > 0 ? '+' : '−'}${formatMoney(Math.abs(cents))}`;
}

export function WalletChanges({ changes }) {
  const moving = (changes ?? []).filter((c) => c.deltaCents !== 0);
  if (moving.length === 0) return <p className="muted small">No wallet changes.</p>;
  return (
    <ul className="wallet-changes">
      {moving.map((c) => (
        <li key={c.uid} className="wallet-change">
          <span>
            <strong>{c.username}</strong>
            {c.bets ? <span className="muted small"> · {c.bets} bet{c.bets === 1 ? '' : 's'}</span> : null}
          </span>
          <span className={c.deltaCents > 0 ? 'success-text' : 'error-text'}>
            <strong>{signedMoney(c.deltaCents)}</strong>
          </span>
          <span className={c.balanceAfterCents < 0 ? 'error-text small' : 'muted small'}>
            Wallet {formatMoney(c.balanceBeforeCents)} → {formatMoney(c.balanceAfterCents)}
            {c.balanceAfterCents < 0 ? ' (below $0)' : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function MoneyConfirmModal({
  title,
  children,
  walletChanges,
  confirmLabel = 'Confirm',
  danger = false,
  canConfirm = true,
  busy,
  error,
  onConfirm,
  onCancel,
}) {
  // Escape closes unless a request is running. Re-subscribes when busy/onCancel change; sets no state.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={busy ? undefined : onCancel}>
      <div className="modal card" role="dialog" aria-modal="true" aria-labelledby="money-confirm-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="money-confirm-title" className="card-title">
          {title}
        </h2>
        {children}
        <div>
          <h3 className="small-heading">Wallet changes</h3>
          <WalletChanges changes={walletChanges} />
        </div>
        {error ? <p className="error-text">{error}</p> : null}
        <div className="button-row">
          <button type="button" className={danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={onConfirm} disabled={busy || !canConfirm}>
            {busy ? 'Working…' : confirmLabel}
          </button>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
