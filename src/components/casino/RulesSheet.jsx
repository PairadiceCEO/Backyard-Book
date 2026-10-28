// A game's rules and paytables in a sheet (0.24.0, Blackjack and Baccarat), with a "Side bets" section. It uses the chat
// drawer's sheet styles, like the Slots paytable. Escape or the backdrop closes it; the page behind doesn't scroll while open.
//   sections: [{ id, heading, text?, rows?: [[what, pays]], note? }] (src/lib/casinoRules.js builds them from the shared paytables)
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export function RulesButton({ onClick }) {
  return (
    <button type="button" className="btn btn-ghost small rules-btn" onClick={onClick}>
      Rules & side bets
    </button>
  );
}

export default function RulesSheet({ open, onClose, title, sections }) {
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
      <section className="chat-drawer rules-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <header className="chat-head">
          <h3>{title}</h3>
          <button type="button" className="icon-button" aria-label="Close rules" onClick={onClose} ref={closeRef}>
            ×
          </button>
        </header>
        <div className="rules-body">
          {sections.map((section) => (
            <section key={section.id} className={section.side ? 'rules-section side' : 'rules-section'} data-rules={section.id}>
              {section.group ? <h4 className="rules-group">{section.group}</h4> : null}
              <h5>{section.heading}</h5>
              {section.text ? <p className="muted small">{section.text}</p> : null}
              {section.rows ? (
                <table className="rules-table">
                  <tbody>
                    {section.rows.map(([what, pays]) => (
                      <tr key={what}>
                        <td>{what}</td>
                        <td className="rules-pays">{pays}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
              {section.note ? <p className="muted small rules-note">{section.note}</p> : null}
            </section>
          ))}
        </div>
      </section>
    </>,
    document.body,
  );
}
