// Admin home: Players (Phase 3) and a server access check.

import { useState } from 'react';
import { adminAction } from '../../lib/api.js';
import AdminUsers from './AdminUsers.jsx';

const SECTIONS = [
  { id: 'players', label: 'Players' },
  { id: 'system', label: 'System' },
];

function SystemPanel() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');

  async function checkAccess() {
    setChecking(true);
    setResult('');
    setError('');
    try {
      const data = await adminAction('ping');
      setResult(`Server confirms admin access for "${data.username}".`);
    } catch (err) {
      setError(`${err.message} (${err.code})`);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="card">
      <p className="muted">Bet grading, custom games and "Settle now" arrive in Phase 8.</p>
      <button type="button" className="btn btn-primary" onClick={checkAccess} disabled={checking}>
        {checking ? 'Checking…' : 'Check admin access'}
      </button>
      {result ? <p className="success-text">{result}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}
    </div>
  );
}

export default function AdminPage() {
  const [section, setSection] = useState('players');

  return (
    <section className="page">
      <h2 className="section-title">Admin</h2>
      <div className="sub-tabs" role="tablist" aria-label="Admin sections">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={s.id === section}
            className={s.id === section ? 'sub-tab active' : 'sub-tab'}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      {section === 'players' ? <AdminUsers /> : <SystemPanel />}
    </section>
  );
}
