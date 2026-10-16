// One price cell. Without onSelect it is display-only (Phase 4); the bet slip wires onSelect in Phase 6.

import { formatAmerican } from '../lib/format.js';

export default function OddsButton({ quote, lineLabel = '', onSelect = null, selected = false, ariaLabel = '' }) {
  if (!quote) {
    return (
      <span className="odds-cell unavailable" aria-label={ariaLabel ? `${ariaLabel}: unavailable` : 'Unavailable'}>
        —
      </span>
    );
  }

  const content = (
    <>
      {lineLabel ? <span className="odds-line">{lineLabel}</span> : null}
      <span className="odds-price">{formatAmerican(quote.american)}</span>
    </>
  );

  if (!onSelect) {
    return (
      <span className="odds-cell" aria-label={ariaLabel || undefined}>
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={selected ? 'odds-cell odds-button selected' : 'odds-cell odds-button'}
      aria-pressed={selected}
      aria-label={ariaLabel || undefined}
      onClick={onSelect}
    >
      {content}
    </button>
  );
}
