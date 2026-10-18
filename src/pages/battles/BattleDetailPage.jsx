// One Battle, live from its Firestore doc (readable by its players and the admin). What I can do here
// depends on where it stands: accept / decline an invite, keep my spot or withdraw after a payout change,
// cancel it (creator, before it's live), enter the result (creator, once live: pays out at once), or
// dispute the result (any player, within 48 h). Every action is a call to /api/battles.

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useWalletDisplay } from '../../context/WalletDisplayContext.jsx';
import { ErrorState, LoadingState, friendlyError } from '../../components/StatusViews.jsx';
import { PARTICIPANT_STATUS, battleAction, isExpired, myPart, timeLeft, toMs } from '../../lib/battles.js';
import { formatCentralDateTime, formatMoney } from '../../lib/format.js';
import {
  BATTLE_STATUS_LABELS,
  DISPUTE_NOTE_MAX,
  DISPUTE_WINDOW_MS,
  FORMAT_LABELS,
  bpsText,
  computeBattlePayouts,
  ordinal,
  placeAmounts,
  placeUnits,
  resultProblems,
} from '../../../shared/battles.js';

function signedMoney(cents) {
  if (cents > 0) return `+${formatMoney(cents)}`;
  if (cents < 0) return `−${formatMoney(-cents)}`;
  return formatMoney(0);
}

function useBattleDoc(battleId) {
  const [state, setState] = useState({ id: null, battle: null, error: '', loaded: false });
  useEffect(() => {
    if (!db || !battleId) return undefined;
    const unsubscribe = onSnapshot(
      doc(db, 'battles', battleId),
      (snap) => setState({ id: battleId, battle: snap.exists() ? { id: snap.id, ...snap.data() } : null, error: '', loaded: true }),
      (err) =>
        setState({
          id: battleId,
          battle: null,
          error: err.code === 'permission-denied' ? "This Battle doesn't exist or you're not in it." : err.message || 'Could not load the Battle.',
          loaded: true,
        }),
    );
    return unsubscribe;
  }, [battleId]);
  const current = state.id === battleId;
  return { battle: current ? state.battle : null, error: current ? state.error : '', loading: !current || !state.loaded };
}

// The creator's result form: a place for every player (free-for-all) or team; equal places tie.
function ResultForm({ battle, onSubmit, busy }) {
  const units = placeUnits(battle);
  const [places, setPlaces] = useState({});
  const labelOf = (unit) => (battle.format === 'teams' ? battle.teams.find((t) => t.id === unit)?.name ?? unit : battle.participants.find((p) => p.uid === unit)?.name ?? unit);
  const complete = resultProblems(battle, places).length === 0;
  const preview = complete ? computeBattlePayouts(battle, battle.potCents, places) : null;
  return (
    <div className="card form-card">
      <h3 className="small-heading">Enter the result</h3>
      <p className="muted small">Give each {battle.format === 'teams' ? 'team' : 'player'} their finishing place. Same place = a tie (they split the places they cover).</p>
      <ul className="team-assign">
        {units.map((unit) => (
          <li key={unit}>
            <span>{labelOf(unit)}</span>
            <select value={places[unit] ?? ''} aria-label={`Place for ${labelOf(unit)}`} onChange={(e) => setPlaces((m) => ({ ...m, [unit]: e.target.value ? Number(e.target.value) : undefined }))}>
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
      {preview ? (
        <ul className="payout-preview">
          {battle.participants.map((p) => (
            <li key={p.uid}>
              <span>{p.name}</span>
              <strong>{formatMoney(preview.byUid[p.uid] ?? 0)}</strong>
            </li>
          ))}
        </ul>
      ) : null}
      <button type="button" className="btn btn-primary" disabled={!complete || busy} onClick={() => onSubmit(Object.fromEntries(units.map((u) => [u, places[u]])))}>
        {busy ? 'Paying out…' : 'Confirm result and pay out'}
      </button>
      <p className="muted small">Pays out at once. Anyone in the Battle can dispute it within 48 hours; the admin can fix it.</p>
    </div>
  );
}

export default function BattleDetailPage() {
  const { battleId } = useParams();
  const { authUser, profile } = useAuth();
  const myUid = authUser?.uid ?? null;
  const balanceCents = Number(profile?.balanceCents) || 0;
  const { reportBalance } = useWalletDisplay();
  const { battle, error, loading } = useBattleDoc(battleId);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDecline, setConfirmDecline] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [disputing, setDisputing] = useState(false);
  const [note, setNote] = useState('');

  async function run(kind, action, fields = {}, done = '') {
    setBusy(kind);
    setActionError('');
    setNotice('');
    try {
      const reply = await battleAction(action, { battleId, ...fields });
      if (Number.isFinite(reply?.balanceCents)) reportBalance(reply.balanceCents);
      if (done) setNotice(done);
      return reply;
    } catch (err) {
      setActionError(friendlyError(err.message));
      return null;
    } finally {
      setBusy('');
    }
  }

  if (loading) return <LoadingState label="Loading the Battle…" />;
  if (error || !battle) {
    return (
      <section className="page">
        <ErrorState title="Battle not found" message={error || "This Battle doesn't exist or you're not in it."}>
          <Link to="/sportsbook" className="btn">
            Back to the Sportsbook
          </Link>
        </ErrorState>
      </section>
    );
  }

  const me = myPart(battle, myUid);
  const creator = battle.creatorUid === myUid;
  const expired = isExpired(battle);
  const pending = battle.status === 'pending' && !expired;
  const amounts = placeAmounts(battle.potCents, battle.payoutBps);
  const resultMs = toMs(battle.resultAt);
  const canDispute =
    Boolean(me) && battle.status === 'settled' && resultMs !== null && Date.now() - resultMs <= DISPUTE_WINDOW_MS && !(battle.disputes ?? []).some((d) => d.uid === myUid && !d.resolved);
  const credited = battle.credited ?? {};
  const placeOf = (unit) => battle.result?.places?.[unit];
  const stakeHeld = (p) => p.status === 'accepted';

  // Players in display order: by team (teams), then by finishing place once there's a result.
  const rows = [...battle.participants].sort((a, b) => {
    const pa = placeOf(battle.format === 'teams' ? a.team : a.uid) ?? 99;
    const pb = placeOf(battle.format === 'teams' ? b.team : b.uid) ?? 99;
    if (battle.format === 'teams' && a.team !== b.team && pa === pb) return String(a.team).localeCompare(String(b.team));
    return pa - pb;
  });

  return (
    <section className="page battle-page">
      <div className="slots-top">
        <Link to="/sportsbook" className="btn btn-ghost small">
          ‹ Sportsbook
        </Link>
        <span className={`battle-status status-${expired ? 'cancelled' : battle.status}`}>{expired ? 'Expired' : BATTLE_STATUS_LABELS[battle.status]}</span>
      </div>

      <div className="card">
        <h2 className="battle-detail-title">{battle.title}</h2>
        {battle.description ? <p className="battle-description">{battle.description}</p> : null}
        <dl className="battle-facts">
          <div>
            <dt>Format</dt>
            <dd>{FORMAT_LABELS[battle.format]}</dd>
          </div>
          <div>
            <dt>Stake</dt>
            <dd>{formatMoney(battle.stakeCents)} each</dd>
          </div>
          <div>
            <dt>Pot</dt>
            <dd>{formatMoney(battle.potCents)}</dd>
          </div>
          <div>
            <dt>Created by</dt>
            <dd>{battle.creatorName}</dd>
          </div>
        </dl>
        {pending ? <p className="muted small">Goes live when everyone accepts · {timeLeft(toMs(battle.expiresAt))} left, then everyone is refunded.</p> : null}
        {expired ? <p className="warning-text small">Not everyone accepted within 48 hours. Every stake is refunded at the next check.</p> : null}
        {battle.status === 'cancelled' || battle.status === 'void' ? <p className="muted small">{battle.status === 'void' ? 'Voided by the admin: every stake back.' : battle.cancelReason || 'Cancelled: every stake refunded.'}</p> : null}
      </div>

      {notice ? (
        <p className="success-text small" role="status">
          {notice}
        </p>
      ) : null}
      {actionError ? (
        <p className="error-text small" role="alert">
          {actionError}
        </p>
      ) : null}

      {pending && me?.notice === 'payoutChanged' ? (
        <div className="card notice-card">
          <strong>The admin changed the payout.</strong>
          <p className="small">It's now {battle.payoutBps.map((b, i) => `${ordinal(i + 1)} ${bpsText(b)}`).join(' · ')}. Keep your spot, or withdraw for a full refund.</p>
          <div className="button-row">
            <button type="button" className="btn btn-primary" disabled={Boolean(busy)} onClick={() => run('keep', 'keep', {}, 'You kept your spot.')}>
              Keep my spot
            </button>
            <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => run('withdraw', 'withdraw', {}, `Withdrawn: ${formatMoney(battle.stakeCents)} refunded.`)}>
              {busy === 'withdraw' ? 'Withdrawing…' : `Withdraw (refund ${formatMoney(battle.stakeCents)})`}
            </button>
          </div>
        </div>
      ) : null}

      {pending && me?.status === 'invited' ? (
        <div className="card notice-card">
          <strong>{creator ? 'You re-joined.' : `${battle.creatorName} invited you.`}</strong>
          <p className="small">Accepting puts {formatMoney(battle.stakeCents)} into the pot now. Declining cancels the Battle for everyone.</p>
          {confirmDecline ? (
            <div className="button-row">
              <button type="button" className="btn btn-danger" disabled={Boolean(busy)} onClick={() => run('decline', 'decline', {}, 'Declined. The Battle is cancelled and everyone refunded.')}>
                {busy === 'decline' ? 'Declining…' : 'Yes, decline and cancel it'}
              </button>
              <button type="button" className="btn" onClick={() => setConfirmDecline(false)}>
                Back
              </button>
            </div>
          ) : (
            <div className="button-row">
              <button type="button" className="btn btn-primary" disabled={Boolean(busy) || balanceCents < battle.stakeCents} onClick={() => run('accept', 'accept', {}, "You're in!")}>
                {busy === 'accept' ? 'Joining…' : balanceCents < battle.stakeCents ? `Need ${formatMoney(battle.stakeCents)} to join` : `Accept · pay ${formatMoney(battle.stakeCents)}`}
              </button>
              <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => setConfirmDecline(true)}>
                Decline
              </button>
            </div>
          )}
        </div>
      ) : null}

      {battle.status === 'live' && creator ? <ResultForm battle={battle} busy={busy === 'result'} onSubmit={(places) => run('result', 'result', { places }, 'Result in: paid out.')} /> : null}
      {battle.status === 'live' && !creator ? <p className="muted small">Everyone's in. {battle.creatorName} enters the result when it's over.</p> : null}

      <div className="card">
        <h3 className="small-heading">{battle.format === 'teams' ? 'Teams and players' : 'Players'}</h3>
        <ul className="battle-players">
          {rows.map((p) => {
            const unit = battle.format === 'teams' ? p.team : p.uid;
            const place = placeOf(unit);
            const paid = Number(credited[p.uid]) || 0;
            const settled = battle.status === 'settled';
            return (
              <li key={p.uid} className={p.uid === myUid ? 'mine' : ''}>
                <span className="battle-player-name">
                  {place ? <span className="battle-place">{ordinal(place)}</span> : null}
                  {p.name}
                  {p.uid === battle.creatorUid ? <span className="muted small"> · creator</span> : null}
                  {battle.format === 'teams' ? <span className="muted small"> · {battle.teams.find((t) => t.id === p.team)?.name}</span> : null}
                </span>
                <span className={`battle-player-status ${p.status}`}>
                  {settled ? `${formatMoney(paid)} (${signedMoney(paid - (stakeHeld(p) ? battle.stakeCents : 0))})` : PARTICIPANT_STATUS[p.status] ?? p.status}
                  {p.notice === 'payoutChanged' && pending ? ' · deciding' : ''}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="card">
        <h3 className="small-heading">Payout{battle.format === 'teams' ? ' (by team place, split evenly within the team)' : ''}</h3>
        <ul className="payout-preview">
          {battle.payoutBps.map((b, i) => (
            <li key={i}>
              <span>
                {ordinal(i + 1)} · {bpsText(b)}
              </span>
              <strong>{formatMoney(amounts[i])}</strong>
            </li>
          ))}
        </ul>
        <p className="muted small">Ties split the places they cover. Amounts round down to the cent; leftover cents go to the top winner.</p>
      </div>

      {canDispute ? (
        disputing ? (
          <div className="card form-card">
            <label className="field">
              <span>What's wrong with the result?</span>
              <textarea value={note} maxLength={DISPUTE_NOTE_MAX} rows={3} onChange={(e) => setNote(e.target.value)} />
            </label>
            <div className="button-row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!note.trim() || Boolean(busy)}
                onClick={async () => {
                  const ok = await run('dispute', 'dispute', { note: note.trim() }, 'Sent to the admin.');
                  if (ok) setDisputing(false);
                }}
              >
                {busy === 'dispute' ? 'Sending…' : 'Send dispute to the admin'}
              </button>
              <button type="button" className="btn" onClick={() => setDisputing(false)}>
                Back
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-ghost" onClick={() => setDisputing(true)}>
            Dispute this result
          </button>
        )
      ) : null}

      {pending && creator ? (
        confirmCancel ? (
          <div className="button-row">
            <button type="button" className="btn btn-danger" disabled={Boolean(busy)} onClick={() => run('cancel', 'cancel', {}, 'Cancelled. Every stake refunded.')}>
              {busy === 'cancel' ? 'Cancelling…' : 'Yes, cancel and refund everyone'}
            </button>
            <button type="button" className="btn" onClick={() => setConfirmCancel(false)}>
              Back
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-ghost" onClick={() => setConfirmCancel(true)}>
            Cancel this Battle
          </button>
        )
      ) : null}

      {(battle.disputes ?? []).length ? (
        <div className="card">
          <h3 className="small-heading">Disputes</h3>
          <ul className="battle-log">
            {battle.disputes.map((d, i) => (
              <li key={i}>
                <strong>{d.name}</strong>: {d.note}
                <span className="muted small">
                  {' '}
                  · {formatCentralDateTime(new Date(toMs(d.at) ?? 0))}
                  {d.resolved ? ' · resolved by the admin' : ' · with the admin'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {(battle.edits ?? []).length ? (
        <div className="card">
          <h3 className="small-heading">Admin changes</h3>
          <ul className="battle-log">
            {battle.edits.map((e, i) => (
              <li key={i}>
                {e.what}
                <span className="muted small">
                  {' '}
                  · {e.byName} · {formatCentralDateTime(new Date(toMs(e.at) ?? 0))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
