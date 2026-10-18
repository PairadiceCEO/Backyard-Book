// The admin's change log on a custom event (Battle, Challenge, custom game): what changed, who, when.
// `compact` is the one-line-per-change form used inside admin cards; `max` keeps only the latest few there.

import { formatCentralDateTime } from '../lib/format.js';
import { toMs } from '../lib/battles.js';

function when(at) {
  const ms = toMs(at);
  return ms === null ? '' : formatCentralDateTime(new Date(ms));
}

export default function EditLog({ edits, compact = false, max = 0, title = 'Admin changes' }) {
  const list = Array.isArray(edits) ? edits : [];
  if (list.length === 0) return null;
  if (compact) {
    const shown = max > 0 ? list.slice(-max) : list;
    const hidden = list.length - shown.length;
    return (
      <ul className="battle-log edit-log" aria-label={title}>
        {hidden > 0 ? <li className="muted small">{hidden} earlier change{hidden === 1 ? '' : 's'}</li> : null}
        {shown.map((e, i) => (
          <li key={hidden + i} className="muted small">
            {e.what} · {e.byName} · {when(e.at)}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="card">
      <h3 className="small-heading">{title}</h3>
      <ul className="battle-log edit-log">
        {list.map((e, i) => (
          <li key={i}>
            {e.what}
            <span className="muted small">
              {' '}
              · {e.byName} · {when(e.at)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
