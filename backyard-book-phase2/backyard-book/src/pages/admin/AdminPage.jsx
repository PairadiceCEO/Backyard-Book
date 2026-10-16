// Admin home. Phase 2 only checks that the server recognizes your admin access.

import { useState } from 'react';
import { adminAction } from '../../lib/api.js';

export default function AdminPage() {
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
    <section className="page">
      <h2 className="section-title">Admin</h2>
      <div className="card">
        <p className="muted">
          Player accounts arrive in Phase 3; bet grading, custom games and "Settle now" arrive in Phase 8.
        </p>
        <button type="button" className="btn btn-primary" onClick={checkAccess} disabled={checking}>
          {checking ? 'Checking…' : 'Check admin access'}
        </button>
        {result ? <p className="success-text">{result}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
      </div>
    </section>
  );
}
