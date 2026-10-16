// Admin settlement: preview what settlement would do (changes nothing) and settle now.
// The "Needs review" list lives on the Bets tab, where those bets can be regraded.

import { useCallback, useState } from 'react';
import { previewSettlement, settleNow } from '../../lib/settle.js';
import { formatAmerican, formatCentralDateTime, formatMoney } from '../../lib/format.js';
import MoneyConfirmModal from './MoneyConfirmModal.jsx';

const STATUS_LABELS = { open: 'Stays open', won: 'Won', lost: 'Lost', push: 'Push', void: 'Void' };
const RESULT_LABELS = { win: 'Won', loss: 'Lost', push: 'Push', void: 'Void', pending: 'Pending' };
const RESULT_CLASS = { win: 'result-win', loss: 'result-loss', push: 'result-push', void: 'result-void', pending: 'result-pending' };

function PreviewLegs({ legs }) {
  return (
    <ul className="bet-legs">
      {legs.map((leg, i) => (
        <li key={`${leg.gameId}-${i}`} className="bet-leg">
          <div>
            <div>
              {leg.label} <span className="muted small">{formatAmerican(leg.americanOdds)}</span>
            </div>
            <div className="muted small">
              {leg.gameLabel} · {String(leg.league || '').toUpperCase()} · ESPN id {leg.gameId}
            </div>
            {leg.scoreText ? <div className="small leg-score">{leg.scoreText}</div> : null}
            {leg.result === 'pending' && leg.reason ? <div className="muted small">{leg.reason}</div> : null}
          </div>
          <span className={`leg-result ${RESULT_CLASS[leg.result] ?? ''}`}>{RESULT_LABELS[leg.result] ?? leg.result}</span>
        </li>
      ))}
    </ul>
  );
}

function PreviewBet({ bet }) {
  const statusClass = bet.status === 'open' ? 'status-open' : `status-${bet.status}`;
  return (
    <article className="bet-card">
      <header className="bet-card-head">
        <strong>
          {bet.username} · {bet.type === 'parlay' ? `Parlay · ${bet.legs.length} legs` : 'Single'}
        </strong>
        <span className={`bet-status ${statusClass}`}>{STATUS_LABELS[bet.status] ?? bet.status}</span>
      </header>
      <PreviewLegs legs={bet.legs} />
      <footer className="bet-card-foot">
        <span>
          Stake <strong>{formatMoney(bet.stakeCents)}</strong>
          {bet.type === 'parlay' && Number.isFinite(bet.combinedAmerican) ? <span className="muted"> at {formatAmerican(bet.combinedAmerican)}</span> : null}
        </span>
        {bet.status === 'open' ? null : (
          <span>
            Would pay <strong>{formatMoney(bet.payoutCents)}</strong>
          </span>
        )}
      </footer>
      {bet.status === 'won' && bet.droppedLegs > 0 && Number.isFinite(bet.settledAmerican) ? (
        <div className="muted small">
          {bet.droppedLegs} leg{bet.droppedLegs === 1 ? '' : 's'} pushed/voided · pays at {formatAmerican(bet.settledAmerican)}
        </div>
      ) : null}
      {bet.review ? <div className="warning-text small">{bet.review}</div> : null}
      <div className="muted small">Bet {bet.id}</div>
    </article>
  );
}

function PreviewResult({ preview }) {
  const t = preview.totals;
  return (
    <div className="settle-preview">
      <div className="card">
        <p>
          <strong>Preview at {formatCentralDateTime(new Date(preview.generatedAt))}</strong> — nothing has changed.
        </p>
        <p className="muted small">
          {preview.checked} open bet{preview.checked === 1 ? '' : 's'} checked · {t.bets} would settle ({t.won} won, {t.lost} lost, {t.push} push, {t.void} void) ·
          total paid out {formatMoney(t.payoutCents)} · {t.needsReview} need review
        </p>
      </div>

      <h3 className="section-title">Would settle now</h3>
      {preview.wouldSettle.length === 0 ? <div className="card muted">No open bet has all the results it needs yet.</div> : null}
      {preview.wouldSettle.map((bet) => (
        <PreviewBet key={bet.id} bet={bet} />
      ))}

      <details className="card">
        <summary>
          Stays open ({preview.staysOpen.length}) — why each is still waiting
        </summary>
        <div className="settle-open-list">
          {preview.staysOpen.length === 0 ? <p className="muted small">None.</p> : null}
          {preview.staysOpen.map((bet) => (
            <PreviewBet key={bet.id} bet={bet} />
          ))}
        </div>
      </details>
    </div>
  );
}

function runSummary(result) {
  if (!result) return '';
  if (result.ran === false) return result.reason || 'Skipped.';
  const parts = [
    `${result.checked} open bet${result.checked === 1 ? '' : 's'} checked`,
    `${result.settled} settled`,
    `${result.alreadySettled} already settled by another run`,
    `${result.stillOpen} still open`,
    `${result.needsReview} need review`,
  ];
  if (result.errors) parts.push(`${result.errors} failed (see Vercel logs)`);
  return parts.join(' · ');
}

export default function AdminSettlement() {
  const [busy, setBusy] = useState(null); // 'preview' | 'settle' | null
  const [preview, setPreview] = useState(null);
  const [lastRun, setLastRun] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [confirmError, setConfirmError] = useState('');
  const [error, setError] = useState('');

  async function runPreview() {
    setBusy('preview');
    setError('');
    try {
      setPreview(await previewSettlement());
    } catch (err) {
      setError(`${err.message} (${err.code})`);
    } finally {
      setBusy(null);
    }
  }

  // Settle now moves money, so it first shows the preview's wallet changes and waits for Confirm.
  async function askSettle() {
    setBusy('settle-preview');
    setError('');
    try {
      const fresh = await previewSettlement();
      setPreview(fresh);
      setConfirmError('');
      setConfirming(fresh);
    } catch (err) {
      setError(`${err.message} (${err.code})`);
    } finally {
      setBusy(null);
    }
  }

  async function runSettle() {
    setBusy('settle');
    setConfirmError('');
    try {
      const result = await settleNow();
      setLastRun({ at: new Date(), result });
      setPreview(null); // the old preview no longer matches
      setConfirming(null);
    } catch (err) {
      setConfirmError(`${err.message} (${err.code})`);
    } finally {
      setBusy(null);
    }
  }

  const closeConfirm = useCallback(() => setConfirming(null), []);

  return (
    <div className="admin-settlement">
      <div className="card">
        <p className="muted small">
          Bets settle by ESPN game id once ESPN marks the game final (custom games once you enter the final score). It runs when
          players open the app or My Bets (at most once a minute), once a day at 6 AM CT, and from the button below.
        </p>
        <div className="button-row">
          <button type="button" className="btn" onClick={runPreview} disabled={busy !== null}>
            {busy === 'preview' ? 'Checking ESPN…' : 'Preview settlement'}
          </button>
          <button type="button" className="btn btn-primary" onClick={askSettle} disabled={busy !== null}>
            {busy === 'settle-preview' ? 'Checking ESPN…' : 'Settle now'}
          </button>
        </div>
        {error ? <p className="error-text">{error}</p> : null}
        {lastRun ? (
          <p className="success-text small">
            Settled at {formatCentralDateTime(lastRun.at)}: {runSummary(lastRun.result)}
          </p>
        ) : null}
      </div>

      {preview ? <PreviewResult preview={preview} /> : null}

      {confirming ? (
        <MoneyConfirmModal
          title="Settle now?"
          walletChanges={confirming.walletChanges}
          confirmLabel={`Settle ${confirming.totals.bets} bet${confirming.totals.bets === 1 ? '' : 's'}`}
          busy={busy === 'settle'}
          error={confirmError}
          onConfirm={runSettle}
          onCancel={closeConfirm}
        >
          <p>
            {confirming.totals.bets} bet{confirming.totals.bets === 1 ? '' : 's'} would settle ({confirming.totals.won} won, {confirming.totals.lost} lost,{' '}
            {confirming.totals.push} push, {confirming.totals.void} void), paying {formatMoney(confirming.totals.payoutCents)} in total. The full list is in
            the preview below.
          </p>
          <p className="muted small">If another game finishes in the next few seconds, its bets settle too.</p>
        </MoneyConfirmModal>
      ) : null}

      <p className="muted small">Bets with a leg still pending 72 hours after its game started are listed under Admin → Bets → Needs review.</p>
    </div>
  );
}
