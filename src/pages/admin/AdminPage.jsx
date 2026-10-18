// Admin home: Players, Bets (regrades, needs review), Battles (disputes, result / payout / void),
// Challenges (approve / reject / edit, settle / void), Custom games, Settlement (preview, settle now), Shop purchases and a server access check.

import { useState } from 'react';
import { adminAction } from '../../lib/api.js';
import AdminUsers from './AdminUsers.jsx';
import AdminShopHistory from './AdminShopHistory.jsx';
import AdminSettlement from './AdminSettlement.jsx';
import AdminBets from './AdminBets.jsx';
import AdminCustomGames from './AdminCustomGames.jsx';
import AdminBattles from './AdminBattles.jsx';
import AdminChallenges from './AdminChallenges.jsx';

const SECTIONS = [
  { id: 'players', label: 'Players' },
  { id: 'bets', label: 'Bets' },
  { id: 'battles', label: 'Battles' },
  { id: 'challenges', label: 'Challenges' },
  { id: 'custom', label: 'Custom games' },
  { id: 'settlement', label: 'Settlement' },
  { id: 'shop', label: 'Shop purchases' },
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
      <p className="muted">Regrades are under Bets, player Challenges under Challenges, house games under Custom games, and Settle now / Preview under Settlement.</p>
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
      <div className="sub-tabs wrap" role="tablist" aria-label="Admin sections">
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
      {section === 'players' ? <AdminUsers /> : null}
      {section === 'bets' ? <AdminBets /> : null}
      {section === 'battles' ? <AdminBattles /> : null}
      {section === 'challenges' ? <AdminChallenges /> : null}
      {section === 'custom' ? <AdminCustomGames /> : null}
      {section === 'shop' ? <AdminShopHistory /> : null}
      {section === 'settlement' ? <AdminSettlement /> : null}
      {section === 'system' ? <SystemPanel /> : null}
    </section>
  );
}
