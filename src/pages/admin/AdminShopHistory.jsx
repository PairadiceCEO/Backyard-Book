// Every shop purchase for the life of the site, grouped by player (disabled players included).
// Reads ledger entries with type "shop" once, plus a Refresh button, to keep Firestore reads low.

import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { formatCentralDateTime, formatMoney } from '../../lib/format.js';
import { groupShopPurchases } from '../../lib/shopHistory.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/StatusViews.jsx';

export default function AdminShopHistory() {
  const [reloadKey, setReloadKey] = useState(0);
  const [data, setData] = useState({ status: 'loading', entries: [], users: [], error: '' });
  const [expanded, setExpanded] = useState({}); // uid -> true

  // Loads when the tab opens and again on each Refresh (reloadKey changes only on click).
  useEffect(() => {
    if (!db) return undefined;
    let cancelled = false;
    setData((prev) => ({ ...prev, status: 'loading', error: '' }));

    Promise.all([
      getDocs(query(collection(db, 'ledger'), where('type', '==', 'shop'))),
      getDocs(collection(db, 'users')),
    ])
      .then(([ledgerSnap, usersSnap]) => {
        if (cancelled) return;
        setData({
          status: 'ready',
          entries: ledgerSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
          users: usersSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
          error: '',
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setData((prev) => ({ ...prev, status: 'error', error: err.message || 'Could not load purchases.' }));
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const summary = useMemo(() => groupShopPurchases(data.entries, data.users), [data.entries, data.users]);

  function toggle(uid) {
    setExpanded((prev) => ({ ...prev, [uid]: !prev[uid] }));
  }

  return (
    <div className="page">
      <div className="card shop-summary">
        <div>
          <div className="muted small">Total purchases</div>
          <div className="summary-number">{summary.totalCount}</div>
        </div>
        <div>
          <div className="muted small">Total amount</div>
          <div className="summary-number wallet-amount">{formatMoney(summary.totalCents)}</div>
        </div>
        <button
          type="button"
          className="btn small"
          onClick={() => setReloadKey((k) => k + 1)}
          disabled={data.status === 'loading'}
        >
          {data.status === 'loading' ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {data.status === 'loading' && summary.players.length === 0 ? <LoadingState label="Loading purchases…" rows={2} /> : null}
      {data.status === 'error' ? <ErrorState title="Couldn't load purchases" message={data.error} onRetry={() => setReloadKey((k) => k + 1)} /> : null}

      {data.status === 'ready' && summary.players.length === 0 ? (
        <EmptyState icon="🛒" title="No shop purchases yet">Purchases appear here when players add money from the Shop.</EmptyState>
      ) : null}

      {summary.players.length > 0 ? (
        <div className="card">
          <ul className="player-list">
            {summary.players.map((player) => {
              const open = expanded[player.uid] === true;
              return (
                <li key={player.uid} className="player-row">
                  <button
                    type="button"
                    className="history-toggle"
                    aria-expanded={open}
                    onClick={() => toggle(player.uid)}
                  >
                    <span className="history-name">
                      <span className="chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
                      <strong>{player.displayName}</strong>{' '}
                      <span className="muted small">@{player.username}</span>
                      {player.disabled ? <span className="badge badge-danger">disabled</span> : null}
                    </span>
                    <span className="history-totals">
                      <span className="muted small">
                        {player.count} purchase{player.count === 1 ? '' : 's'}
                      </span>
                      <span className="wallet-amount">{formatMoney(player.totalCents)}</span>
                    </span>
                  </button>
                  {open ? (
                    <table className="table history-table">
                      <thead>
                        <tr>
                          <th>Date and time (CT)</th>
                          <th className="num">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {player.purchases.map((purchase) => (
                          <tr key={purchase.id}>
                            <td>{purchase.atMs ? formatCentralDateTime(purchase.atMs) : 'Unknown time'}</td>
                            <td className="num">{formatMoney(purchase.amountCents)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
