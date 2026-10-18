// Admin → Challenges: the queue of pending Challenges (approve as posted, edit the wording and odds and
// then approve, or reject with a note), open ones (edit the odds or close time at any time: placed bets
// keep their odds), and closed ones to settle (pick the winning outcome) or void. Settling and voiding
// are previewed with every player's wallet change and applied only on Confirm. Every change is logged on
// the Challenge (who, what, when). The poster's own bets are listed with a "Poster's bet" tag.

import { useCallback, useState } from 'react';
import { adminAction } from '../../lib/api.js';
import { formatAmerican, formatCentralDateTime, formatMoney } from '../../lib/format.js';
import { toMs } from '../../lib/battles.js';
import { closeMsOf, stateOf, useAllChallenges, useNowMs } from '../../lib/challenges.js';
import MoneyConfirmModal from './MoneyConfirmModal.jsx';
import EditLog from '../../components/EditLog.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/StatusViews.jsx';
import { centralWallParts, centralWallTimeToDate } from '../../../shared/time.js';
import {
  CHALLENGE_DESCRIPTION_MAX,
  CHALLENGE_STATUS_LABELS,
  CHALLENGE_TITLE_MAX,
  OUTCOME_LABEL_MAX,
  REJECT_NOTE_MAX,
  challengeProblems,
  cleanAmerican,
  outcomeLabel,
} from '../../../shared/challenges.js';

const FILTERS = [
  { id: 'pending', label: 'Queue' },
  { id: 'open', label: 'Open' },
  { id: 'closed', label: 'To settle' },
  { id: 'finished', label: 'Finished' },
  { id: 'all', label: 'All' },
];

const americanText = (n) => (n > 0 ? `+${n}` : String(n));

function inFilter(state, filter) {
  if (filter === 'all') return true;
  if (filter === 'finished') return state === 'settled' || state === 'void' || state === 'rejected';
  return state === filter;
}

// Edit form. Pending: wording, outcomes, odds and close time. Open: odds and close time only.
function ChallengeEditor({ challenge, busy, nowMs, onSave, onApprove, onClose }) {
  const pending = challenge.status === 'pending';
  const start = centralWallParts(new Date(closeMsOf(challenge) ?? Date.now()));
  const [title, setTitle] = useState(challenge.title);
  const [description, setDescription] = useState(challenge.description ?? '');
  const [outcomes, setOutcomes] = useState(() => challenge.outcomes.map((o) => ({ label: o.label, american: americanText(o.american) })));
  const [closeDate, setCloseDate] = useState(start.date);
  const [closeClock, setCloseClock] = useState(start.clock);

  const close = centralWallTimeToDate(closeDate, closeClock);
  const closeChanged = close ? close.getTime() !== closeMsOf(challenge) : true;
  const problems = pending
    ? challengeProblems({ title, description, outcomes, closeMs: close ? close.getTime() : NaN }, nowMs)
    : [
        ...(outcomes.some((o) => cleanAmerican(o.american) === null) ? ['Give each outcome American odds like +150 or -180.'] : []),
        ...(close ? [] : ['Enter a valid close date and time.']),
      ];

  function fields() {
    const out = { outcomes: outcomes.map((o) => (pending ? { label: o.label.trim(), american: o.american.trim() } : { american: o.american.trim() })) };
    if (pending) {
      out.title = title.trim();
      out.description = description.trim();
    }
    if (closeChanged) {
      out.closeDate = closeDate;
      out.closeClock = closeClock;
    }
    return out;
  }

  return (
    <div className="admin-battle-editor challenge-editor">
      {pending ? (
        <>
          <label className="field">
            <span>Question</span>
            <input value={title} maxLength={CHALLENGE_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span>Description</span>
            <textarea value={description} maxLength={CHALLENGE_DESCRIPTION_MAX} rows={2} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </>
      ) : (
        <p className="muted small">Betting is open, so the wording is fixed. New bets get the new odds; placed bets keep theirs.</p>
      )}
      <ul className="payout-rows">
        {outcomes.map((o, i) => (
          <li key={i} className="outcome-row">
            <input
              className="outcome-name"
              value={o.label}
              maxLength={OUTCOME_LABEL_MAX}
              disabled={!pending}
              aria-label={`Outcome ${i + 1} name`}
              onChange={(e) => setOutcomes((l) => l.map((v, j) => (j === i ? { ...v, label: e.target.value } : v)))}
            />
            <input
              className="outcome-odds"
              value={o.american}
              aria-label={`Outcome ${i + 1} odds`}
              onChange={(e) => setOutcomes((l) => l.map((v, j) => (j === i ? { ...v, american: e.target.value.replace(/[^\d+-]/g, '').slice(0, 7) } : v)))}
            />
          </li>
        ))}
      </ul>
      <div className="close-time-row">
        <label className="field">
          <span>Closes (date, CT)</span>
          <input type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} />
        </label>
        <label className="field">
          <span>Time</span>
          <input type="time" value={closeClock} onChange={(e) => setCloseClock(e.target.value)} />
        </label>
      </div>
      {problems.length ? <p className="warning-text small">{problems[0]}</p> : null}
      <div className="button-row">
        {pending ? (
          <button type="button" className="btn btn-primary small-btn" disabled={busy || problems.length > 0} onClick={() => onApprove(fields())}>
            Approve with these edits
          </button>
        ) : null}
        <button type="button" className={pending ? 'btn small-btn' : 'btn btn-primary small-btn'} disabled={busy || problems.length > 0} onClick={() => onSave(fields())}>
          {pending ? 'Save, keep pending' : 'Save changes'}
        </button>
        <button type="button" className="btn small-btn" onClick={onClose} disabled={busy}>
          Close
        </button>
      </div>
    </div>
  );
}

function AdminChallengeCard({ challenge, nowMs, busy, onRun, onPreview }) {
  const [mode, setMode] = useState(null); // 'edit' | 'reject' | 'settle'
  const [note, setNote] = useState('');
  const [winner, setWinner] = useState('');
  const toggle = (m) => setMode((cur) => (cur === m ? null : m));
  const state = stateOf(challenge, nowMs);
  const closeMs = closeMsOf(challenge);
  const created = toMs(challenge.createdAt);
  const bets = Number(challenge.betCount) || 0;
  const live = challenge.status === 'open';
  const id = challenge.id;

  return (
    <article className={challenge.status === 'pending' ? 'card admin-battle admin-challenge needs-review' : 'card admin-battle admin-challenge'}>
      <header className="bet-card-head">
        <strong className="battle-title">{challenge.title}</strong>
        <span className={`battle-status status-${state}`}>{CHALLENGE_STATUS_LABELS[state] ?? state}</span>
      </header>
      {challenge.description ? <p className="battle-description small">{challenge.description}</p> : null}
      <div className="muted small">
        By {challenge.posterName} · closes {closeMs ? formatCentralDateTime(new Date(closeMs)) : '—'} · {bets} bet{bets === 1 ? '' : 's'}
      </div>
      <ul className="battle-players compact">
        {challenge.outcomes.map((o) => (
          <li key={o.id}>
            <span className="battle-player-name">
              {challenge.winner === o.id ? <span className="battle-place">Won</span> : null}
              {o.label}
            </span>
            <strong>{formatAmerican(o.american)}</strong>
          </li>
        ))}
      </ul>
      {(challenge.posterBets ?? []).length ? (
        <ul className="battle-log poster-bets">
          {challenge.posterBets.map((b) => (
            <li key={b.betId} className="small poster-bet">
              <span className="tag tag-poster">Poster's bet</span>
              <span>
                {b.label} {formatAmerican(b.americanOdds)} · {formatMoney(b.stakeCents)}
                {b.parlay ? ' (parlay)' : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {challenge.status === 'rejected' && challenge.rejectNote ? <p className="error-text small">Rejected: {challenge.rejectNote}</p> : null}
      <EditLog edits={challenge.edits} compact max={5} />

      <div className="button-row">
        {challenge.status === 'pending' ? (
          <>
            <button type="button" className="btn btn-primary small-btn" disabled={busy} onClick={() => onRun('challengeApprove', { challengeId: id }, `Approved: ${challenge.title}. Betting is open.`)}>
              Approve
            </button>
            <button type="button" className={mode === 'edit' ? 'btn small-btn active' : 'btn small-btn'} disabled={busy} onClick={() => toggle('edit')}>
              Edit
            </button>
            <button type="button" className={mode === 'reject' ? 'btn btn-danger small-btn active' : 'btn btn-danger small-btn'} disabled={busy} onClick={() => toggle('reject')}>
              Reject
            </button>
          </>
        ) : null}
        {live ? (
          <>
            <button type="button" className={mode === 'edit' ? 'btn small-btn active' : 'btn small-btn'} disabled={busy} onClick={() => toggle('edit')}>
              Edit odds / close
            </button>
            <button type="button" className={mode === 'settle' ? 'btn btn-primary small-btn active' : 'btn btn-primary small-btn'} disabled={busy} onClick={() => toggle('settle')}>
              Settle
            </button>
            <button type="button" className="btn btn-danger small-btn" disabled={busy} onClick={() => onPreview(challenge, 'challengeVoid', {})}>
              Void
            </button>
          </>
        ) : null}
      </div>

      {mode === 'edit' ? (
        <ChallengeEditor
          challenge={challenge}
          busy={busy}
          nowMs={nowMs}
          onClose={() => setMode(null)}
          onSave={(fields) => onRun('challengeEdit', { challengeId: id, ...fields }, `Saved: ${challenge.title}.`, () => setMode(null))}
          onApprove={(fields) => onRun('challengeApprove', { challengeId: id, ...fields }, `Approved with edits: ${fields.title ?? challenge.title}. Betting is open.`, () => setMode(null))}
        />
      ) : null}
      {mode === 'reject' ? (
        <div className="admin-battle-editor">
          <label className="field">
            <span>Why it's rejected (the poster sees this)</span>
            <textarea value={note} maxLength={REJECT_NOTE_MAX} rows={2} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="button-row">
            <button
              type="button"
              className="btn btn-danger small-btn"
              disabled={busy || !note.trim()}
              onClick={() => onRun('challengeReject', { challengeId: id, note: note.trim() }, `Rejected: ${challenge.title}.`, () => setMode(null))}
            >
              Reject it
            </button>
            <button type="button" className="btn small-btn" onClick={() => setMode(null)} disabled={busy}>
              Close
            </button>
          </div>
        </div>
      ) : null}
      {mode === 'settle' ? (
        <div className="admin-battle-editor">
          {state === 'open' ? <p className="warning-text small">Betting is still open until {formatCentralDateTime(new Date(closeMs))}. Settling now closes it.</p> : null}
          <label className="field">
            <span>Winning outcome</span>
            <select value={winner} onChange={(e) => setWinner(e.target.value)}>
              <option value="">Pick the winner…</option>
              {challenge.outcomes.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label} ({formatAmerican(o.american)})
                </option>
              ))}
            </select>
          </label>
          <div className="button-row">
            <button type="button" className="btn btn-primary small-btn" disabled={busy || !winner} onClick={() => onPreview(challenge, 'challengeSettle', { winner })}>
              Preview payouts
            </button>
            <button type="button" className="btn small-btn" onClick={() => setMode(null)} disabled={busy}>
              Close
            </button>
          </div>
        </div>
      ) : null}
      <div className="muted small">
        Posted {created ? formatCentralDateTime(new Date(created)) : ''} · v{Number(challenge.version) || 0} · {id}
      </div>
    </article>
  );
}

export default function AdminChallenges() {
  const { challenges, error, loading, retry } = useAllChallenges();
  const nowMs = useNowMs();
  const [filter, setFilter] = useState('pending');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // { action, fields, challenge, preview }
  const [actionError, setActionError] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [notice, setNotice] = useState('');

  async function run(action, fields, done, after) {
    setBusy(true);
    setActionError('');
    setNotice('');
    try {
      await adminAction(action, fields);
      setNotice(done);
      if (after) after();
    } catch (err) {
      setActionError(err.message || 'Could not save that.');
    } finally {
      setBusy(false);
    }
  }

  async function preview(challenge, action, fields) {
    setBusy(true);
    setActionError('');
    setNotice('');
    try {
      const data = await adminAction(action, { challengeId: challenge.id, ...fields });
      setConfirmError('');
      setPending({ action, fields, challenge, preview: data });
    } catch (err) {
      setActionError(err.message || 'Could not prepare the preview.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setConfirmError('');
    try {
      const result = await adminAction(pending.action, { challengeId: pending.challenge.id, ...pending.fields, confirm: true });
      const s = result.settlement ?? {};
      const what = pending.action === 'challengeVoid' ? 'voided' : `settled, ${pending.preview.winnerLabel} won`;
      setNotice(`${pending.challenge.title}: ${what}. Settled ${s.settled ?? 0} bet${s.settled === 1 ? '' : 's'}; ${s.stillOpen ?? 0} still open.`);
      setPending(null);
    } catch (err) {
      setConfirmError(err.message || 'Could not apply that.');
    } finally {
      setBusy(false);
    }
  }

  const cancelPending = useCallback(() => setPending(null), []);

  if (loading) return <LoadingState label="Loading Challenges…" rows={2} />;
  if (error) return <ErrorState title="Couldn't load Challenges" message={error} onRetry={retry} />;

  const withState = challenges.map((c) => ({ c, state: stateOf(c, nowMs) }));
  const count = (f) => withState.filter((x) => inFilter(x.state, f)).length;
  const shown = withState.filter((x) => inFilter(x.state, filter)).map((x) => x.c);
  const totals = pending?.preview?.totals;
  const waiting = pending?.preview?.staysOpen?.length ?? 0;

  return (
    <div className="admin-battles admin-challenges">
      <div className="sub-tabs wrap" role="tablist" aria-label="Challenge filter">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'sub-tab active' : 'sub-tab'} onClick={() => setFilter(f.id)}>
            {f.label}
            {(f.id === 'pending' || f.id === 'closed') && count(f.id) ? <span className="nav-badge">{count(f.id)}</span> : null}
          </button>
        ))}
      </div>
      {notice ? <p className="success-text small">{notice}</p> : null}
      {actionError ? <p className="error-text small">{actionError}</p> : null}
      {shown.length === 0 ? (
        <EmptyState title={filter === 'pending' ? 'The queue is empty' : 'No Challenges here'}>Challenges players post wait here for your approval.</EmptyState>
      ) : null}
      {shown.map((c) => (
        <AdminChallengeCard key={c.id} challenge={c} nowMs={nowMs} busy={busy} onRun={run} onPreview={preview} />
      ))}
      {pending ? (
        <MoneyConfirmModal
          title={pending.action === 'challengeVoid' ? `Void: ${pending.preview.title}` : `Settle: ${pending.preview.title}`}
          walletChanges={pending.preview.walletChanges}
          confirmLabel={pending.action === 'challengeVoid' ? 'Void the Challenge' : `Settle: ${pending.preview.winnerLabel} won`}
          danger={pending.action === 'challengeVoid'}
          busy={busy}
          error={confirmError}
          onConfirm={confirm}
          onCancel={cancelPending}
        >
          <p className="small">
            {pending.action === 'challengeVoid' ? (
              'Every bet on it is void: singles get their stake back, parlays drop this leg.'
            ) : (
              <>
                Winner: <strong>{outcomeLabel(pending.challenge, pending.preview.winner)}</strong>.
              </>
            )}{' '}
            {totals ? `${totals.bets} bet${totals.bets === 1 ? '' : 's'} settle (${totals.won} won, ${totals.lost} lost, ${totals.push} push, ${totals.void} void), paying ${formatMoney(totals.payoutCents)}.` : ''}
            {waiting ? ` ${waiting} parlay${waiting === 1 ? '' : 's'} stay open, waiting on other legs.` : ''}
          </p>
        </MoneyConfirmModal>
      ) : null}
    </div>
  );
}
