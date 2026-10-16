import { useState } from 'react';
import { LEAGUES } from '../../shared/constants.js';

export default function SportsbookPage() {
  const [league, setLeague] = useState(LEAGUES[0].id);
  const current = LEAGUES.find((l) => l.id === league) ?? LEAGUES[0];

  return (
    <section className="page">
      <div className="sub-tabs" role="tablist" aria-label="Leagues">
        {LEAGUES.map((l) => (
          <button
            key={l.id}
            type="button"
            role="tab"
            aria-selected={l.id === league}
            className={l.id === league ? 'sub-tab active' : 'sub-tab'}
            onClick={() => setLeague(l.id)}
          >
            {l.label}
          </button>
        ))}
      </div>
      <div className="card empty-state">
        <h2>{current.label}</h2>
        <p className="muted">Games and odds appear here in Phase 4.</p>
      </div>
    </section>
  );
}
