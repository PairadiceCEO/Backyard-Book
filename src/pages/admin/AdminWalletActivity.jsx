// Admin → Wallet activity (0.17.0): pick a player and see every wallet change of the last 24 hours (the ledger, read
// only), with the balance after each one, a 24 h summary, filters, and a balance check: walking from oldest to newest,
// each entry's balance after must be the previous one's plus its amount (entries written in one transaction are checked
// as a group), and the newest must equal the wallet now.
//
// Reads: the players list once (as Shop purchases does); then /api/admin walletActivity (50 entries a page, summary by
// aggregation queries on the server). Hooks: each effect loads once per player / refresh and ignores late answers.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { adminAction } from '../../lib/api.js';
import { formatCentralDay, formatCentralSeconds, formatMoney } from '../../lib/format.js';
import { EmptyState, ErrorState, LoadingState, friendlyError } from '../../components/StatusViews.jsx';
import {
  CASINO_GAME_IDS,
  CASINO_GAME_NAMES,
  CREDIT_TYPES,
  DEBIT_TYPES,
  FILTERS,
  categoryOf,
  checkBalances,
  matchesFilter,
  whereOf,
} from '../../../shared/walletActivity.js';

function signed(cents) {
  if (cents > 0) return `+${formatMoney(cents)}`;
  if (cents < 0) return `−${formatMoney(-cents)}`;
  return formatMoney(0);
}

function NetCell({ cents }) {
  return <span className={cents > 0 ? 'net-pos' : cents < 0 ? 'net-neg' : 'muted'}>{signed(cents)}</span>;
}

function SummaryRow({ label, bucket, sub = false }) {
  return (
    <tr className={sub ? 'sub' : undefined}>
      <th scope="row">{label}</th>
      <td>{bucket.count}</td>
      <td>{bucket.wageredCents ? formatMoney(bucket.wageredCents) : '—'}</td>
      <td>{bucket.wonCents ? formatMoney(bucket.wonCents) : '—'}</td>
      <td>{bucket.adjustedCents ? signed(bucket.adjustedCents) : '—'}</td>
      <td>
        <NetCell cents={bucket.netCents} />
      </td>
    </tr>
  );
}

function Summary({ summary }) {
  return (
    <div className="card activity-summary">
      <h3 className="small-heading">Last 24 hours</h3>
      <div className="activity-summary-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Where</th>
              <th scope="col">Entries</th>
              <th scope="col">Wagered</th>
              <th scope="col">Won / returned</th>
              <th scope="col">Admin</th>
              <th scope="col">Net</th>
            </tr>
          </thead>
          <tbody>
            <SummaryRow label="Sportsbook" bucket={summary.sportsbook} />
            <SummaryRow label="Casino" bucket={summary.casino} />
            {CASINO_GAME_IDS.filter((g) => summary.casino.games[g].count > 0).map((g) => (
              <SummaryRow key={g} label={CASINO_GAME_NAMES[g]} bucket={summary.casino.games[g]} sub />
            ))}
            <SummaryRow label="Other" bucket={summary.other} />
            {['battles', 'shop', 'admin']
              .filter((k) => summary.other.parts[k].count > 0)
              .map((k) => (
                <SummaryRow key={k} label={{ battles: 'Battles', shop: 'Shop', admin: 'Admin' }[k]} bucket={summary.other.parts[k]} sub />
              ))}
            <SummaryRow label="Total" bucket={summary.all} />
          </tbody>
        </table>
      </div>
      {summary.unclassified.count ? (
        <p className="warning-text small">
          {summary.unclassified.count} entr{summary.unclassified.count === 1 ? 'y' : 'ies'} of a type this screen doesn't know ({signed(summary.unclassified.netCents)}): see the
          list below.
        </p>
      ) : null}
    </div>
  );
}

function MissingIndexes({ list }) {
  return (
    <div className="card notice-card missing-index" role="alert">
      <strong>Firestore needs {list.length === 1 ? 'an index' : `${list.length} indexes`} for this</strong>
      {list.map((m) => (
        <div key={m.id} className="missing-index-item">
          <p className="small">
            Collection <code>{m.collection}</code>: {m.fields.map(([f, dir]) => `${f} ${dir}`).join(', ')} (used for {m.usedFor}).
            {m.building ? ' It exists but is still building: try again in a few minutes.' : ''}
          </p>
          <p className="muted small">
            Firebase console → Firestore Database → Indexes → Composite → Create index → collection {m.collection}, fields in this order, scope
            Collection → Create. Building takes a few minutes; then press Refresh.
          </p>
          {m.link ? (
            <a className="btn small" href={m.link} target="_blank" rel="noreferrer">
              Open Firebase's ready-made link
            </a>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function CheckCell({ row }) {
  if (!row) return null;
  if (row.status === 'ok') return <span className="check-ok" aria-label="Balance adds up">✓</span>;
  if (row.status === 'first') return <span className="muted small">start of 24 h</span>;
  if (row.status === 'unchecked') return <span className="muted small">load more to check</span>;
  return (
    <span className="check-jump">
      Balance jump: expected {formatMoney(row.expectedCents)}, ledger says {formatMoney(row.ledgerCents)}
    </span>
  );
}

export default function AdminWalletActivity({ onOpenBet }) {
  const [players, setPlayers] = useState({ status: 'loading', list: [], error: '' });
  const [uid, setUid] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [data, setData] = useState({ status: 'idle', uid: '', player: null, entries: [], nextCursor: null, summary: null, missingIndexes: [], error: '' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState('all');
  const [game, setGame] = useState('all');

  // Players: once.
  useEffect(() => {
    if (!db) return undefined;
    let cancelled = false;
    getDocs(collection(db, 'users'))
      .then((snap) => {
        if (cancelled) return;
        const list = snap.docs
          .map((d) => ({ uid: d.id, name: d.data().displayName || d.data().username || d.id, username: d.data().username ?? '', disabled: d.data().disabled === true }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setPlayers({ status: 'ready', list, error: '' });
      })
      .catch((err) => {
        if (!cancelled) setPlayers({ status: 'error', list: [], error: friendlyError(err.message) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The player's first page + summary: when the pick or Refresh changes.
  useEffect(() => {
    if (!uid) return undefined;
    let cancelled = false;
    setData((prev) => ({ ...prev, status: 'loading', uid, error: '' }));
    adminAction('walletActivity', { uid })
      .then((r) => {
        if (cancelled) return;
        setData({ status: 'ready', uid, player: r.player, entries: r.entries ?? [], nextCursor: r.nextCursor, summary: r.summary, missingIndexes: r.missingIndexes ?? [], error: '', entriesMissing: r.entries === null });
      })
      .catch((err) => {
        if (!cancelled) setData((prev) => ({ ...prev, status: 'error', uid, error: friendlyError(err.message) }));
      });
    return () => {
      cancelled = true;
    };
  }, [uid, reloadKey]);

  const loadMore = useCallback(async () => {
    if (!data.nextCursor || loadingMore) return;
    const forUid = data.uid;
    setLoadingMore(true);
    try {
      const r = await adminAction('walletActivity', { uid: forUid, cursor: data.nextCursor });
      setData((prev) => (prev.uid === forUid ? { ...prev, entries: [...prev.entries, ...(r.entries ?? [])], nextCursor: r.nextCursor } : prev));
    } catch (err) {
      setData((prev) => (prev.uid === forUid ? { ...prev, error: friendlyError(err.message) } : prev));
    } finally {
      setLoadingMore(false);
    }
  }, [data.nextCursor, data.uid, loadingMore]);

  const check = useMemo(
    () => checkBalances(data.entries, { complete: !data.nextCursor, currentBalanceCents: data.player?.balanceCents ?? null }),
    [data.entries, data.nextCursor, data.player],
  );
  const shown = useMemo(() => data.entries.filter((e) => matchesFilter(e, filter, game)), [data.entries, filter, game]);
  const today = formatCentralDay(Date.now());
  const ready = data.status === 'ready' && data.uid === uid;

  return (
    <div className="page wallet-activity">
      <div className="card filter-row">
        <label className="field">
          <span>Player</span>
          <select value={uid} onChange={(e) => setUid(e.target.value)} disabled={players.status !== 'ready'}>
            <option value="">{players.status === 'loading' ? 'Loading players…' : 'Pick a player'}</option>
            {players.list.map((p) => (
              <option key={p.uid} value={p.uid}>
                {p.name}
                {p.username && p.username !== p.name ? ` (${p.username})` : ''}
                {p.disabled ? ' · disabled' : ''}
              </option>
            ))}
          </select>
        </label>
        {uid ? (
          <button type="button" className="btn small" onClick={() => setReloadKey((k) => k + 1)} disabled={data.status === 'loading'}>
            Refresh
          </button>
        ) : null}
      </div>
      {players.status === 'error' ? <ErrorState title="Couldn't load players" message={players.error} /> : null}
      {!uid ? (
        <EmptyState icon="🧾" title="Pick a player">
          Every wallet change of the last 24 hours, with the balance after each one and a check that they add up.
        </EmptyState>
      ) : null}
      {uid && data.status === 'loading' ? <LoadingState label="Loading wallet activity…" rows={4} /> : null}
      {uid && data.status === 'error' ? <ErrorState title="Couldn't load wallet activity" message={data.error} onRetry={() => setReloadKey((k) => k + 1)} /> : null}

      {ready ? (
        <>
          {data.missingIndexes.length ? <MissingIndexes list={data.missingIndexes} /> : null}
          {data.summary ? <Summary summary={data.summary} /> : null}

          {!data.entriesMissing ? (
            <div className={check.jumps || check.walletMismatch ? 'card balance-check bad' : 'card balance-check'} role="status">
              {check.jumps === 0 ? (
                <span className="check-ok">
                  ✓ Every balance adds up ({data.entries.length} entr{data.entries.length === 1 ? 'y' : 'ies'}
                  {data.nextCursor ? ' loaded so far' : ''}).
                </span>
              ) : (
                <span className="check-jump">
                  {check.jumps} balance jump{check.jumps === 1 ? '' : 's'}: see the red rows.
                </span>
              )}
              {check.walletMismatch ? (
                <span className="check-jump">
                  Wallet now {formatMoney(check.walletMismatch.walletCents)}, but the newest entry says {formatMoney(check.walletMismatch.expectedCents)}.
                </span>
              ) : data.entries.length ? (
                <span className="muted small">The newest entry matches the wallet ({formatMoney(data.player.balanceCents)}).</span>
              ) : (
                <span className="muted small">Wallet now {formatMoney(data.player.balanceCents)}.</span>
              )}
            </div>
          ) : null}

          <div className="sub-tabs wrap" role="tablist" aria-label="Show">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={filter === f.id}
                className={filter === f.id ? 'sub-tab active' : 'sub-tab'}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          {filter === 'casino' ? (
            <label className="field activity-game">
              <span>Game</span>
              <select value={game} onChange={(e) => setGame(e.target.value)}>
                <option value="all">All games</option>
                {CASINO_GAME_IDS.map((g) => (
                  <option key={g} value={g}>
                    {CASINO_GAME_NAMES[g]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {!data.entriesMissing && data.entries.length === 0 ? <EmptyState title="No wallet changes in the last 24 hours" /> : null}
          {data.entries.length > 0 && shown.length === 0 ? <p className="muted small">Nothing of this kind in what's loaded.</p> : null}

          {shown.length ? (
            <ol className="activity-list" aria-label="Wallet changes, newest first">
              <li className="activity-row activity-head" aria-hidden="true">
                <span>Time</span>
                <span>Where</span>
                <span>What</span>
                <span className="num">Wagered</span>
                <span className="num">Won</span>
                <span className="num">Balance after</span>
                <span>Check</span>
              </li>
              {shown.map((e) => {
                const row = check.rows.get(e.id);
                const debit = DEBIT_TYPES.includes(e.type) || (!CREDIT_TYPES.includes(e.type) && e.amountCents < 0);
                const day = e.createdAt ? formatCentralDay(e.createdAt) : '';
                return (
                  <li key={e.id} className={row?.status === 'jump' ? 'activity-row jump' : 'activity-row'}>
                    <span className="activity-time">
                      {e.createdAt ? formatCentralSeconds(e.createdAt) : '—'}
                      {day && day !== today ? <span className="muted small"> · {day}</span> : null}
                    </span>
                    <span className="activity-where">{whereOf(e)}</span>
                    <span className="activity-what">
                      {e.note || e.type}
                      {categoryOf(e.type) === 'sportsbook' && e.betId && onOpenBet ? (
                        <button type="button" className="link-button" onClick={() => onOpenBet(e.betId)}>
                          Open bet ›
                        </button>
                      ) : null}
                    </span>
                    <span className="num activity-wagered">
                      {debit ? (
                        <>
                          <span className="activity-label">Wagered </span>
                          {formatMoney(-e.amountCents)}
                        </>
                      ) : null}
                    </span>
                    <span className="num activity-won">
                      {!debit ? (
                        <>
                          <span className="activity-label">Won </span>
                          {signed(e.amountCents)}
                        </>
                      ) : null}
                    </span>
                    <span className="num activity-balance">
                      <span className="activity-label">Balance after </span>
                      {formatMoney(e.balanceAfterCents)}
                    </span>
                    <span className="activity-check">
                      <CheckCell row={row} />
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : null}

          {data.nextCursor ? (
            <button type="button" className="btn" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          ) : null}
          {data.error ? <p className="error-text small">{data.error}</p> : null}
        </>
      ) : null}
    </div>
  );
}
