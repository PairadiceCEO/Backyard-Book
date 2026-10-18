// Shown when the server answers ODDS_CHANGED: one or more picks' odds moved 50+ points since the player saw them.
// Lists each as "Old +100 → New +155". "Accept new odds" updates those picks (the player then taps Place again);
// "Remove pick(s)" takes them off the slip. Escape or tapping outside closes it and leaves the slip as it was.

import { useEffect } from 'react';
import { formatAmerican } from '../lib/format.js';

export default function OddsChangedModal({ changes, onAccept, onRemove, onClose }) {
  // Close with Escape. Re-subscribes only if onClose changes; sets no state.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const many = changes.length > 1;
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal card" role="dialog" aria-modal="true" aria-labelledby="odds-changed-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="odds-changed-title" className="card-title">
          {many ? 'Odds changed on some picks' : 'The odds changed'}
        </h2>
        <p className="muted small">Nothing was placed. Accept the new odds and tap Place again, or remove {many ? 'these picks' : 'this pick'}.</p>
        <ul className="confirm-list">
          {changes.map((c) => (
            <li key={c.legId} className="confirm-leg odds-change">
              <div>
                <div>{c.label}</div>
                {c.gameLabel ? <div className="muted small">{c.gameLabel}</div> : null}
              </div>
              <div className="confirm-odds">
                <span className="muted small">Old</span> <span className="old-price">{formatAmerican(c.oldAmerican)}</span> →{' '}
                <span className="muted small">New</span> <strong>{formatAmerican(c.newAmerican)}</strong>
              </div>
            </li>
          ))}
        </ul>
        <div className="confirm-footer odds-change-actions">
          <button type="button" className="btn" onClick={onRemove}>
            {many ? 'Remove picks' : 'Remove pick'}
          </button>
          <button type="button" className="btn btn-primary" onClick={onAccept}>
            Accept new odds
          </button>
        </div>
      </div>
    </div>
  );
}
