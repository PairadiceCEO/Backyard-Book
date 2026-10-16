// Admin → Bets: every player's bets (newest first), filters, "Needs review", and regrades:
// force a whole bet to win / lose / void, or override one leg and recompute the bet with the normal rules.
// Each regrade previews the wallet change first and is applied only after you confirm.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { adminAction } from '../../lib/api.js';
import { formatAmerican, formatCentralDateTime, formatMoney } from '../../lib/format.js';
import MoneyConfirmModal from './MoneyConfirmModal.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/StatusViews.jsx';

const MAX_BETS = 500;
const PAGE = 50;
const REVIEW_AFTER_MS = 72 * 60 * 60 * 1000;
const STATUSES = ['open', 'won', 'lost', 'push', 'void'];
const STATUS_LABELS = { open: 'Open', won: 'Won', lost: 'Lost', push: 'Push', void: 'Void' };
const RESULT_LABELS = { win: 'Won', loss: 'Lost', push: 'Push', void: 'Void', pending: 'Pending' };
const FORCE_LABELS = { win: 'Force win', lose: 'Force lose', void: 'Void bet' };

function toMs(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function needsReview(bet, nowMs) {
  if (bet.status !== 'open') return false;
  if (bet.needsReview === true) return true;
  return bet.legs.some((leg) => {
    if (leg.result && leg.result !== 'pending') return false;
    const start = toMs(leg.startTime);
    return start !== null && nowMs - start >= REVIEW_AFTER_MS;
  });
}

// Live list of the newest bets from every player. Subscribes once (again on retry); removed on unmount.
function useAllBets() {
  const [state, setState] = useState({ bets: [], error: '', loaded: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!db) return undefined;
    const q = query(collection(db, 'bets'), orderBy('placedAt', 'desc'), limit(MAX_BETS));
    const unsubscribe = onSnapshot(
      q,
      (snap) => setState({ bets: snap.docs.map((d) => ({ id: d.id, ...d.data() })), error: '', loaded: true }),
      (err) => setState({ bets: [], error: err.message || 'Could not load bets.', loaded: true }),
    );
    return unsubscribe;
  }, [attempt]);
  const retry = useCallback(() => {
    setState({ bets: [], error: '', loaded: false });
    setAttempt((n) => n + 1);
  }, []);
  return { ...state, retry };
}

function useNowMs() {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  return nowMs;
}

function AdminBetCard({ bet, flagged, busy, onAction }) {
  const placed = toMs(bet.placedAt);
  return (
    <article className={`bet-card status-${bet.status}`}>
      <header className="bet-card-head">
        <strong>
          {bet.username} · {bet.type === 'parlay' ? `Parlay · ${bet.legs.length} legs` : 'Single'}
        </strong>
        <span className={`bet-status status-${bet.status}`}>{STATUS_LABELS[bet.status] ?? bet.status}</span>
      </header>

      <ul className="bet-legs">
        {bet.legs.map((leg, i) => (
          <li key={leg.legId ?? i} className="bet-leg admin-leg">
            <div>
              <div>
                {leg.label} <span className="muted small">{formatAmerican(leg.americanOdds)}</span>
              </div>
              <div className="muted small">
                {leg.gameLabel} · {String(leg.league || '').toUpperCase()} · {formatCentralDateTime(new Date(toMs(leg.startTime) ?? 0))}
              </div>
              {leg.scoreText ? <div className="small leg-score">{leg.scoreText}</div> : null}
            </div>
            <div className="admin-leg-right">
              <span className={`leg-result result-${leg.result || 'pending'}`}>
                {RESULT_LABELS[leg.result || 'pending']}
                {leg.overriddenBy ? ' (admin)' : ''}
              </span>
              <select
                className="leg-override"
                value=""
                disabled={busy}
                aria-label={`Set result for ${leg.label}`}
                onChange={(e) => {
                  if (e.target.value) onAction('setLegResult', { betId: bet.id, legIndex: i, result: e.target.value });
                }}
              >
                <option value="">Set leg…</option>
                <option value="win">Won</option>
                <option value="loss">Lost</option>
                <option value="push">Push</option>
                <option value="void">Void</option>
              </select>
            </div>
          </li>
        ))}
      </ul>

      <footer className="bet-card-foot">
        <span>
          Stake <strong>{formatMoney(bet.stakeCents)}</strong>
          {bet.type === 'parlay' ? <span className="muted"> at {formatAmerican(bet.combinedAmerican)}</span> : null}
        </span>
        {bet.status === 'open' ? (
          <span>
            To win <strong>{formatMoney(bet.potentialPayoutCents)}</strong>
          </span>
        ) : (
          <span>
            Paid <strong>{formatMoney(bet.payoutCents)}</strong>
          </span>
        )}
      </footer>
      {flagged ? <div className="warning-text small">{bet.reviewReason || 'A leg is still pending 72+ hours after its game started.'}</div> : null}
      {bet.adminNote ? <div className="muted small">Admin: {bet.adminNote}</div> : null}
      <div className="button-row">
        {['win', 'lose', 'void'].map((outcome) => (
          <button
            key={outcome}
            type="button"
            className={outcome === 'lose' ? 'btn btn-danger small-btn' : 'btn small-btn'}
            disabled={busy}
            onClick={() => onAction('gradeBet', { betId: bet.id, outcome })}
          >
            {FORCE_LABELS[outcome]}
          </button>
        ))}
      </div>
      <div className="muted small">
        Placed {placed ? formatCentralDateTime(new Date(placed)) : ''} · v{Number(bet.version) || 0} · {bet.id}
      </div>
    </article>
  );
}

export default function AdminBets() {
  const { bets, error, loaded, retry } = useAllBets();
  const nowMs = useNowMs();
  const [player, setPlayer] = useState('all');
  const [status, setStatus] = useState('all');
  const [shown, setShown] = useState(PAGE);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(null); // { action, params, preview }
  const [confirmError, setConfirmError] = useState('');

  const players = useMemo(() => [...new Set(bets.map((b) => b.username || b.uid))].sort(), [bets]);
  const review = useMemo(() => bets.filter((b) => needsReview(b, nowMs)), [bets, nowMs]);
  const filtered = useMemo(
    () => bets.filter((b) => (player === 'all' || (b.username || b.uid) === player) && (status === 'all' || b.status === status)),
    [bets, player, status],
  );

  async function onAction(action, params) {
    setBusy(true);
    setActionError('');
    setNotice('');
    try {
      const preview = await adminAction(action, params);
      setConfirmError('');
      setPending({ action, params, preview });
    } catch (err) {
      setActionError(err.message || 'Could not prepare the regrade.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setConfirmError('');
    try {
      const result = await adminAction(pending.action, { ...pending.params, confirm: true, expectedVersion: pending.preview.version });
      setNotice(
        `${result.username}: ${result.describe}. ${STATUS_LABELS[result.from.status]} → ${STATUS_LABELS[result.to.status]}, wallet ${
          result.deltaCents === 0 ? 'unchanged' : `${result.deltaCents > 0 ? '+' : '−'}${formatMoney(Math.abs(result.deltaCents))}`
        }.`,
      );
      setPending(null);
    } catch (err) {
      setConfirmError(err.message || 'Could not apply the regrade.');
    } finally {
      setBusy(false);
    }
  }

  const cancelPending = useCallback(() => setPending(null), []);
  const p = pending?.preview;

  return (
    <div className="admin-bets">
      {actionError ? <div className="card error-text">{actionError}</div> : null}
      {notice ? <div className="card success-text small">{notice}</div> : null}
      {error ? <ErrorState title="Couldn't load bets" message={error} onRetry={retry} /> : null}
      {!loaded ? <LoadingState label="Loading bets…" rows={3} /> : null}

      <h3 className="section-title">Needs review ({review.length})</h3>
      {loaded && review.length === 0 ? <div className="card muted small">Nothing to review. Open bets land here when a leg is still pending 72 hours after its game started.</div> : null}
      {review.map((bet) => (
        <AdminBetCard key={`review-${bet.id}`} bet={bet} flagged busy={busy} onAction={onAction} />
      ))}

      <h3 className="section-title">All bets</h3>
      <div className="card filter-row">
        <label className="field">
          <span>Player</span>
          <select
            value={player}
            onChange={(e) => {
              setPlayer(e.target.value);
              setShown(PAGE);
            }}
          >
            <option value="all">All players</option>
            {players.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Status</span>
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setShown(PAGE);
            }}
          >
            <option value="all">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <span className="muted small">
          {filtered.length} bet{filtered.length === 1 ? '' : 's'}
          {bets.length >= MAX_BETS ? ` (newest ${MAX_BETS} loaded)` : ''}
        </span>
      </div>

      {loaded && !error && filtered.length === 0 ? (
        <EmptyState title={bets.length === 0 ? 'No bets yet' : 'No bets match these filters'}>
          {bets.length === 0 ? 'Bets appear here as soon as anyone places one.' : 'Try another player or status.'}
        </EmptyState>
      ) : null}
      {filtered.slice(0, shown).map((bet) => (
        <AdminBetCard key={bet.id} bet={bet} flagged={needsReview(bet, nowMs)} busy={busy} onAction={onAction} />
      ))}
      {filtered.length > shown ? (
        <button type="button" className="btn" onClick={() => setShown((n) => n + PAGE)}>
          Show more
        </button>
      ) : null}

      {pending ? (
        <MoneyConfirmModal
          title="Confirm regrade"
          walletChanges={[{ uid: p.uid, username: p.username, deltaCents: p.deltaCents, balanceBeforeCents: p.balanceBeforeCents, balanceAfterCents: p.balanceAfterCents }]}
          confirmLabel={p.noChange ? 'Nothing to change' : 'Apply regrade'}
          canConfirm={!p.noChange}
          busy={busy}
          error={confirmError}
          onConfirm={confirm}
          onCancel={cancelPending}
        >
          <p>
            <strong>
              {p.username} · {p.type === 'parlay' ? `Parlay · ${p.legs.length} legs` : 'Single'} · stake {formatMoney(p.stakeCents)}
            </strong>
          </p>
          <p>{p.describe}</p>
          <div className="regrade-table">
            <span className="muted">Status</span>
            <span>
              {STATUS_LABELS[p.from.status]} → <strong>{STATUS_LABELS[p.to.status]}</strong>
            </span>
            <span className="muted">Payout</span>
            <span>
              {formatMoney(p.from.payoutCents)} → <strong>{formatMoney(p.to.payoutCents)}</strong>
            </span>
            <span className="muted">Record (W–L)</span>
            <span>
              {p.statsBefore.won}–{p.statsBefore.lost} → <strong>{p.statsAfter.won}–{p.statsAfter.lost}</strong>
            </span>
          </div>
          {p.to.status === 'open' ? <p className="muted small">The bet reopens and settles normally once its other legs finish.</p> : null}
          <ul className="confirm-list">
            {p.legs.map((leg, i) => (
              <li key={i} className="confirm-leg">
                <div>
                  <div>{leg.label}</div>
                  <div className="muted small">{leg.gameLabel}</div>
                </div>
                <span className={`leg-result result-${leg.result}`}>{RESULT_LABELS[leg.result] ?? leg.result}</span>
              </li>
            ))}
          </ul>
          {p.noChange ? <p className="warning-text small">This leaves the bet exactly as it is.</p> : null}
        </MoneyConfirmModal>
      ) : null}
    </div>
  );
}
