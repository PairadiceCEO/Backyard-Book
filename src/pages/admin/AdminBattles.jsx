// Admin → Battles: every Battle (disputed first). The admin can change the result, change the payout
// structure, or void it. Each change is previewed with every player's wallet before → after (a wallet may
// go below $0, shown in red) and applied only on Confirm; only the differences move (admin_regrade).

import { useCallback, useEffect, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { adminAction } from '../../lib/api.js';
import { formatCentralDateTime, formatMoney } from '../../lib/format.js';
import { toMs } from '../../lib/battles.js';
import MoneyConfirmModal from './MoneyConfirmModal.jsx';
import EditLog from '../../components/EditLog.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/StatusViews.jsx';
import { BATTLE_STATUS_LABELS, FORMAT_LABELS, bpsText, ordinal, payoutProblems, percentToBps, placeUnits, resultProblems } from '../../../shared/battles.js';

const MAX_BATTLES = 200;
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'disputed', label: 'Disputed' },
  { id: 'pending', label: 'Waiting' },
  { id: 'live', label: 'Live' },
  { id: 'settled', label: 'Paid out' },
  { id: 'closed', label: 'Cancelled / void' },
];

function useAllBattles() {
  const [state, setState] = useState({ battles: [], error: '', loaded: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!db) return undefined;
    const q = query(collection(db, 'battles'), orderBy('createdAt', 'desc'), limit(MAX_BATTLES));
    const unsubscribe = onSnapshot(
      q,
      (snap) => setState({ battles: snap.docs.map((d) => ({ id: d.id, ...d.data() })), error: '', loaded: true }),
      (err) => setState({ battles: [], error: err.message || 'Could not load Battles.', loaded: true }),
    );
    return unsubscribe;
  }, [attempt]);
  const retry = useCallback(() => {
    setState({ battles: [], error: '', loaded: false });
    setAttempt((n) => n + 1);
  }, []);
  return { ...state, retry };
}

function unitLabel(battle, unit) {
  if (battle.format === 'teams') return battle.teams.find((t) => t.id === unit)?.name ?? unit;
  return battle.participants.find((p) => p.uid === unit)?.name ?? unit;
}

// The edit forms (result places / payout percents) for one Battle.
function BattleEditor({ battle, mode, busy, onPreview, onClose }) {
  const units = placeUnits(battle);
  const [places, setPlaces] = useState(() => ({ ...(battle.result?.places ?? {}) }));
  const [pcts, setPcts] = useState(() => battle.payoutBps.map((b) => String(b / 100)));
  if (mode === 'result') {
    const ok = resultProblems(battle, places).length === 0;
    return (
      <div className="admin-battle-editor">
        <ul className="team-assign">
          {units.map((unit) => (
            <li key={unit}>
              <span>{unitLabel(battle, unit)}</span>
              <select value={places[unit] ?? ''} aria-label={`Place for ${unitLabel(battle, unit)}`} onChange={(e) => setPlaces((m) => ({ ...m, [unit]: e.target.value ? Number(e.target.value) : undefined }))}>
                <option value="">Place…</option>
                {units.map((_, i) => (
                  <option key={i} value={i + 1}>
                    {ordinal(i + 1)}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
        <div className="button-row">
          <button type="button" className="btn btn-primary small-btn" disabled={!ok || busy} onClick={() => onPreview('battleSetResult', { places: Object.fromEntries(units.map((u) => [u, places[u]])) })}>
            Preview result
          </button>
          <button type="button" className="btn small-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }
  const bps = pcts.map(percentToBps);
  const problems = payoutProblems(bps.map((b) => b ?? 0), units.length, battle.format);
  return (
    <div className="admin-battle-editor">
      <ul className="payout-rows">
        {pcts.map((pct, i) => (
          <li key={i} className="payout-row">
            <span className="payout-place">{ordinal(i + 1)}</span>
            <span className="pct-input">
              <input inputMode="decimal" value={pct} aria-label={`${ordinal(i + 1)} place percent`} onChange={(e) => setPcts((l) => l.map((v, j) => (j === i ? e.target.value.replace(/[^\d.]/g, '').slice(0, 6) : v)))} />%
            </span>
            {pcts.length > 1 ? (
              <button type="button" className="btn btn-ghost small" onClick={() => setPcts((l) => l.filter((_, j) => j !== i))}>
                Remove
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {pcts.length < Math.max(1, units.length - 1) ? (
        <button type="button" className="btn btn-ghost small" onClick={() => setPcts((l) => [...l, ''])}>
          Add {ordinal(pcts.length + 1)} place
        </button>
      ) : null}
      {problems.length ? <p className="warning-text small">{problems[0]}</p> : null}
      <p className="muted small">
        {battle.status === 'pending'
          ? 'Players who already accepted get a notice and may withdraw for a full refund.'
          : battle.status === 'settled'
            ? 'Payouts are recomputed from the same places; only the differences move.'
            : 'Changes the payout used when the result goes in.'}
      </p>
      <div className="button-row">
        <button type="button" className="btn btn-primary small-btn" disabled={problems.length > 0 || busy} onClick={() => onPreview('battleSetPayout', { payoutBps: bps })}>
          Preview payout change
        </button>
        <button type="button" className="btn small-btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function AdminBattleCard({ battle, busy, onPreview }) {
  const [mode, setMode] = useState(null); // 'result' | 'payout'
  const open = (m) => setMode((cur) => (cur === m ? null : m));
  const created = toMs(battle.createdAt);
  const canResult = battle.status === 'live' || battle.status === 'settled';
  const canPayout = ['pending', 'live', 'settled'].includes(battle.status);
  const canVoid = !['void', 'cancelled'].includes(battle.status);
  return (
    <article className={battle.disputed ? 'card admin-battle disputed' : 'card admin-battle'}>
      <header className="bet-card-head">
        <strong>{battle.title}</strong>
        <span className={`battle-status status-${battle.disputed ? 'disputed' : battle.status}`}>{battle.disputed ? 'Disputed' : BATTLE_STATUS_LABELS[battle.status]}</span>
      </header>
      <div className="muted small">
        {FORMAT_LABELS[battle.format]} · by {battle.creatorName} · {formatMoney(battle.stakeCents)} each · pot {formatMoney(battle.potCents)} · payout{' '}
        {battle.payoutBps.map((b, i) => `${ordinal(i + 1)} ${bpsText(b)}`).join(', ')}
      </div>
      <ul className="battle-players compact">
        {battle.participants.map((p) => {
          const unit = battle.format === 'teams' ? p.team : p.uid;
          const place = battle.result?.places?.[unit];
          const credited = battle.credited?.[p.uid];
          return (
            <li key={p.uid}>
              <span className="battle-player-name">
                {place ? <span className="battle-place">{ordinal(place)}</span> : null}
                {p.name}
                {battle.format === 'teams' ? <span className="muted small"> · {unitLabel(battle, p.team)}</span> : null}
              </span>
              <span className="muted small">
                {p.status}
                {Number.isFinite(credited) ? ` · credited ${formatMoney(credited)}` : ''}
              </span>
            </li>
          );
        })}
      </ul>
      {(battle.disputes ?? []).length ? (
        <ul className="battle-log">
          {battle.disputes.map((d, i) => (
            <li key={i} className={d.resolved ? 'muted small' : 'warning-text small'}>
              {d.name}: “{d.note}”{d.resolved ? ' (resolved)' : ''}
            </li>
          ))}
        </ul>
      ) : null}
      <EditLog edits={battle.edits} compact />
      <div className="button-row">
        {canResult ? (
          <button type="button" className={mode === 'result' ? 'btn small-btn active' : 'btn small-btn'} onClick={() => open('result')} disabled={busy}>
            {battle.status === 'live' ? 'Enter result' : 'Change result'}
          </button>
        ) : null}
        {canPayout ? (
          <button type="button" className={mode === 'payout' ? 'btn small-btn active' : 'btn small-btn'} onClick={() => open('payout')} disabled={busy}>
            Change payout
          </button>
        ) : null}
        {canVoid ? (
          <button type="button" className="btn btn-danger small-btn" onClick={() => onPreview(battle, 'battleVoid', {})} disabled={busy}>
            Void
          </button>
        ) : null}
      </div>
      {mode ? <BattleEditor battle={battle} mode={mode} busy={busy} onClose={() => setMode(null)} onPreview={(action, fields) => onPreview(battle, action, fields)} /> : null}
      <div className="muted small">
        Created {created ? formatCentralDateTime(new Date(created)) : ''} · v{Number(battle.version) || 0} · {battle.id}
      </div>
    </article>
  );
}

export default function AdminBattles() {
  const { battles, error, loaded, retry } = useAllBattles();
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // { action, fields, battle, preview }
  const [actionError, setActionError] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [notice, setNotice] = useState('');

  const shown = battles
    .filter((b) => {
      if (filter === 'all') return true;
      if (filter === 'disputed') return b.disputed;
      if (filter === 'closed') return b.status === 'cancelled' || b.status === 'void';
      return b.status === filter;
    })
    .sort((a, b) => Number(Boolean(b.disputed)) - Number(Boolean(a.disputed)));

  async function preview(battle, action, fields) {
    setBusy(true);
    setActionError('');
    setNotice('');
    try {
      const data = await adminAction(action, { battleId: battle.id, ...fields });
      setConfirmError('');
      setPending({ action, fields, battle, preview: data });
    } catch (err) {
      setActionError(err.message || 'Could not prepare that change.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setConfirmError('');
    try {
      const result = await adminAction(pending.action, { battleId: pending.battle.id, ...pending.fields, confirm: true, expectedVersion: pending.preview.version });
      setNotice(`${result.title}: ${result.describe}.`);
      setPending(null);
    } catch (err) {
      setConfirmError(err.message || 'Could not apply that change.');
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <LoadingState label="Loading Battles…" rows={2} />;
  if (error) return <ErrorState title="Couldn't load Battles" message={error} onRetry={retry} />;

  const disputedCount = battles.filter((b) => b.disputed).length;

  return (
    <div className="admin-battles">
      <div className="sub-tabs wrap" role="tablist" aria-label="Battle filter">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'sub-tab active' : 'sub-tab'} onClick={() => setFilter(f.id)}>
            {f.label}
            {f.id === 'disputed' && disputedCount ? <span className="nav-badge">{disputedCount}</span> : null}
          </button>
        ))}
      </div>
      {notice ? <p className="success-text small">{notice}</p> : null}
      {actionError ? <p className="error-text small">{actionError}</p> : null}
      {shown.length === 0 ? <EmptyState title="No Battles here">Battles players create show up here, disputed ones first.</EmptyState> : null}
      {shown.map((b) => (
        <AdminBattleCard key={b.id} battle={b} busy={busy} onPreview={preview} />
      ))}
      {pending ? (
        <MoneyConfirmModal
          title={`${pending.preview.title}: ${pending.preview.describe}`}
          walletChanges={(pending.preview.players ?? []).map((p) => ({ ...p, username: p.name }))}
          confirmLabel={pending.action === 'battleVoid' ? 'Void the Battle' : 'Confirm'}
          danger={pending.action === 'battleVoid'}
          busy={busy}
          error={confirmError}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        >
          <p className="small">
            {BATTLE_STATUS_LABELS[pending.preview.status]} → {BATTLE_STATUS_LABELS[pending.preview.toStatus]}
            {pending.action === 'battleSetPayout' && pending.preview.status === 'pending' ? '. Players who already accepted will be asked to keep their spot or withdraw.' : '.'}
          </p>
        </MoneyConfirmModal>
      ) : null}
    </div>
  );
}
