// Every active player's wallet and win rate, sorted by wallet. Reads Firestore live.

import { useEffect, useState } from 'react';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { db } from '../firebase.js';
import { useAuth } from '../context/AuthContext.jsx';
import { formatMoney, formatWinRate } from '../lib/format.js';

export default function LeaderboardPage() {
  const { authUser } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!db) return undefined;
    const q = query(collection(db, 'users'), orderBy('balanceCents', 'desc'));
    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        const players = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((p) => p.disabled !== true);
        setRows(players);
        setError('');
        setLoading(false);
      },
      (err) => {
        setError(err.message || 'Could not load the leaderboard.');
        setLoading(false);
      },
    );
    return unsubscribe;
  }, []);

  const myUid = authUser ? authUser.uid : null;

  return (
    <section className="page">
      <h2 className="section-title">Leaderboard</h2>
      {loading ? <div className="card muted">Loading…</div> : null}
      {error ? <div className="card error-text">{error}</div> : null}
      {!loading && !error ? (
        <div className="card table-card">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th className="num">Wallet</th>
                <th className="num">Win rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => (
                <tr key={p.id} className={p.id === myUid ? 'me' : undefined}>
                  <td>{i + 1}</td>
                  <td>{p.displayName || p.username}</td>
                  <td className="num">{formatMoney(p.balanceCents)}</td>
                  <td className="num">{formatWinRate(p.stats)}</td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">No players yet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
