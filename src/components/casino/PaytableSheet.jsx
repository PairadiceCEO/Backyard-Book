// The Slots paytable (0.20.0): a sheet with every winning line, read from shared/casino/slotMachine.js PAYTABLE (never
// retyped), and what each pays for the current bet. It uses the chat drawer's sheet styles. Escape or the backdrop closes it;
// the page behind doesn't scroll while it is open.
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import SlotSymbol from './SlotSymbol.jsx';
import { PAYTABLE } from '../../../shared/casino/slotMachine.js';
import { formatMoney } from '../../lib/format.js';

export default function PaytableSheet({ open, onClose, betDollars, hitId = null }) {
  const closeRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <>
      <div className="chat-backdrop" role="presentation" onClick={onClose} />
      <section className="chat-drawer paytable-sheet" role="dialog" aria-modal="true" aria-label="Paytable">
        <header className="chat-head">
          <h3>Paytable</h3>
          <button type="button" className="icon-button" aria-label="Close paytable" onClick={onClose} ref={closeRef}>
            ×
          </button>
        </header>
        <p className="muted small paytable-note">
          One payline (the middle row). Highest line only. Pays shown are what comes back for your {formatMoney(betDollars * 100)} bet.
        </p>
        <ul className="paytable-list">
          {PAYTABLE.map((line) => (
            <li key={line.id} className={hitId === line.id ? 'paytable-row hit' : 'paytable-row'} data-line={line.id}>
              <span className="paytable-symbols" aria-hidden="true">
                {line.show.map((id, i) => (
                  <SlotSymbol key={i} id={id} small />
                ))}
              </span>
              <span className="paytable-label">{line.label}</span>
              <span className="paytable-pays">
                <span className="paytable-times">{line.pays}×</span>
                <strong className="paytable-amount">{formatMoney(line.pays * betDollars * 100)}</strong>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>,
    document.body,
  );
}
