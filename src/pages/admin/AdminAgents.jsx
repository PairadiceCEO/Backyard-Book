// Admin → Agents (0.21.0): one card per AI agent plus the admin's own row, to compare results.
//   Sportsbook profit (stats.returnedCents − stats.stakedCents: the main number, rows sorted by it) · Amount bet · ROI
//   ((returned − staked) ÷ staked) · Settled bets · Win rate (won ÷ (won + lost), as everywhere) · Balance · per league on tap.
//   "Wallet change" (balance − adminAdjustCents: every admin adjustment, starting balance included) stays underneath in small text:
//   it includes casino, shop and Battles money, so it is not comparable between players (0.21.2).
// Reads: one users query (agent != null) and the admin's own users doc, on open and on Refresh. Also the one-time
// "Rebuild stats" tool (dry run first), for bets settled before 0.21.0 kept the new totals.

import { useCallback, useEffect, useState } from 'react';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { adminAction } from '../../lib/api.js';
import { formatMoney, formatWinRate } from '../../lib/format.js';
import { ErrorState, LoadingState } from '../../components/StatusViews.jsx';
import { AgentBadge, AgentLabel } from '../../components/AgentBadge.jsx';
import { roi } from '../../../shared/perfStats.js';

const LEAGUE_NAMES = { nfl: 'NFL', nba: 'NBA', mlb: 'MLB', nhl: 'NHL', ncaaf: 'NCAAF', mixed: 'Parlays across leagues', challenge: 'Challenges', crypto: 'Crypto', other: 'Other' };

function pct(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const p = value * 100;
  return `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
}

function signedMoney(cents) {
  if (cents > 0) return `+${formatMoney(cents)}`;
  if (cents < 0) return `−${formatMoney(-cents)}`;
  return formatMoney(0);
}

export function agentRow(id, user, isAdmin = false) {
  const s = user.stats ?? {};
  const staked = Number(s.stakedCents) || 0;
  const returned = Number(s.returnedCents) || 0;
  const hasAdjust = Number.isFinite(Number(user.adminAdjustCents)) && user.adminAdjustCents !== undefined;
  return {
    id,
    isAdmin,
    name: user.displayName || user.username || id,
    username: user.username,
    agent: user.agent ?? null,
    balanceCents: Number(user.balanceCents) || 0,
    sportsbookCents: returned - staked,
    walletChangeCents: hasAdjust ? (Number(user.balanceCents) || 0) - Number(user.adminAdjustCents) : null,
    stakedCents: staked,
    returnedCents: returned,
    roi: roi(staked, returned),
    settledBets: Number(s.settledBets) || 0,
    stats: s,
    byLeague: Object.entries(s.byLeague ?? {})
      .map(([league, v]) => ({ league, staked: Number(v.staked) || 0, returned: Number(v.returned) || 0, won: Number(v.won) || 0, lost: Number(v.lost) || 0 }))
      .filter((l) => l.staked > 0 || l.won + l.lost > 0)
      .sort((a, b) => b.staked - a.staked),
  };
}

function AgentCard({ row, open, onToggle }) {
  return (
    <li className={row.isAdmin ? 'card agent-card me' : 'card agent-card'}>
      <button type="button" className="agent-card-head" onClick={onToggle} aria-expanded={open}>
        <span className="agent-card-name">
          <strong>{row.name}</strong> {row.isAdmin ? <span className="badge">you</span> : <AgentBadge agent={row.agent} />}
          {row.agent ? <AgentLabel agent={row.agent} /> : <small className="agent-label muted">Person (admin)</small>}
        </span>
        <span className={row.sportsbookCents > 0 ? 'agent-card-profit win' : row.sportsbookCents < 0 ? 'agent-card-profit lose' : 'agent-card-profit'}>
          {signedMoney(row.sportsbookCents)}
          <small>Sportsbook profit</small>
        </span>
      </button>
      <dl className="agent-stats">
        <div>
          <dt>Bet</dt>
          <dd>{formatMoney(row.stakedCents)}</dd>
        </div>
        <div>
          <dt>ROI</dt>
          <dd className={row.roi > 0 ? 'win' : row.roi < 0 ? 'lose' : ''}>{pct(row.roi)}</dd>
        </div>
        <div>
          <dt>Settled</dt>
          <dd>{row.settledBets}</dd>
        </div>
        <div>
          <dt>Win rate</dt>
          <dd>{formatWinRate(row.stats)}</dd>
        </div>
        <div>
          <dt>Balance</dt>
          <dd>{formatMoney(row.balanceCents)}</dd>
        </div>
      </dl>
      <p className="agent-wallet muted small">Wallet change {row.walletChangeCents === null ? '—' : signedMoney(row.walletChangeCents)}</p>
      {open ? (
        row.byLeague.length ? (
          <table className="table agent-leagues">
            <thead>
              <tr>
                <th>League</th>
                <th className="num">Bet</th>
                <th className="num">ROI</th>
                <th className="num">W–L</th>
              </tr>
            </thead>
            <tbody>
              {row.byLeague.map((l) => (
                <tr key={l.league}>
                  <td>{LEAGUE_NAMES[l.league] ?? l.league.toUpperCase()}</td>
                  <td className="num">{formatMoney(l.staked)}</td>
                  <td className="num">{pct(roi(l.staked, l.returned))}</td>
                  <td className="num">
                    {l.won}–{l.lost}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted small">No settled bets yet.</p>
        )
      ) : null}
    </li>
  );
}

function RebuildStats({ onDone }) {
  const [busy, setBusy] = useState('');
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');

  async function run(confirm) {
    setBusy(confirm ? 'apply' : 'dry');
    setError('');
    try {
      const r = await adminAction('rebuildStats', { confirm });
      setReport(r);
      if (confirm) onDone();
    } catch (err) {
      setError(err.message || 'Could not rebuild the stats.');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="card rebuild-card">
      <h3>Rebuild stats</h3>
      <p className="muted small">
        Recomputes everyone's amount bet, returns, settled bets, per-league totals, record and admin adjustments from their settled bets and the
        ledger. Bets settled before 0.21.0 never added to these, so run it once. Dry run first: it changes nothing.
      </p>
      <div className="row-actions">
        <button type="button" className="btn" onClick={() => run(false)} disabled={Boolean(busy)}>
          {busy === 'dry' ? 'Checking…' : 'Dry run'}
        </button>
        <button type="button" className="btn btn-primary" onClick={() => run(true)} disabled={Boolean(busy) || !report?.dryRun}>
          {busy === 'apply' ? 'Rebuilding…' : 'Rebuild now'}
        </button>
      </div>
      {error ? <p className="error-text">{error}</p> : null}
      {report ? (
        <div className="small rebuild-report" role="status">
          <p>
            {report.dryRun ? 'Dry run: ' : 'Done: '}
            {report.bets} settled bets, {report.users} players, {report.changes.length} {report.changes.length === 1 ? 'player' : 'players'} to update
            {report.dryRun ? '' : ` (${report.written} written${report.skipped?.length ? `; skipped because a bet settled meanwhile: ${report.skipped.join(', ')} (run it again)` : ''})`}.
          </p>
          {report.changes.length ? (
            <ul className="rebuild-list">
              {report.changes.map((c) => (
                <li key={c.uid}>
                  <strong>{c.username}</strong>: {c.before.won}–{c.before.lost}, bet {formatMoney(c.before.stakedCents)} → {c.after.won}–{c.after.lost}, bet {formatMoney(c.after.stakedCents)}, returned{' '}
                  {formatMoney(c.after.returnedCents)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function AdminAgents() {
  const { authUser } = useAuth();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  const adminUid = authUser?.uid ?? null;

  useEffect(() => {
    if (!db || !adminUid) return undefined;
    let live = true;
    Promise.all([getDocs(query(collection(db, 'users'), where('agent', '!=', null))), getDoc(doc(db, 'users', adminUid))])
      .then(([agents, me]) => {
        if (!live) return;
        const list = agents.docs.map((d) => agentRow(d.id, d.data())).slice();
        if (me.exists()) list.push(agentRow(me.id, me.data(), true));
        list.sort((a, b) => b.sportsbookCents - a.sportsbookCents || b.balanceCents - a.balanceCents);
        setRows(list);
        setError('');
      })
      .catch((err) => {
        if (live) setError(err.message || 'Could not load the agents.');
      });
    return () => {
      live = false;
    };
  }, [adminUid, attempt]);

  if (error) return <ErrorState title="Couldn't load the agents" message={error} onRetry={refresh} />;
  if (!rows) return <LoadingState label="Loading the agents…" rows={3} />;
  const agentCount = rows.filter((r) => !r.isAdmin).length;

  return (
    <div className="agents-panel">
      <div className="row-actions agents-top">
        <p className="muted small">
          {agentCount} AI {agentCount === 1 ? 'agent' : 'agents'} and you, best sportsbook profit first. Sportsbook profit = returned − bet on settled sportsbook bets. Wallet change
          (balance − starting balance − admin adjustments) also counts casino, shop and Battles money, so it is not comparable. Tap a card for its leagues.
        </p>
        <button type="button" className="btn small" onClick={refresh}>
          Refresh
        </button>
      </div>
      {agentCount === 0 ? <p className="muted">No AI agents yet: create them under Players with "AI agent" ticked.</p> : null}
      <ul className="agent-list">
        {rows.map((row) => (
          <AgentCard key={row.id} row={row} open={open === row.id} onToggle={() => setOpen((v) => (v === row.id ? null : row.id))} />
        ))}
      </ul>
      <RebuildStats onDone={refresh} />
    </div>
  );
}
