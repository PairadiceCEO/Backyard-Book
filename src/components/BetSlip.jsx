// Bet slip: a bar with the pick count slides up from the bottom of the Sportsbook when picks are added;
// tapping it opens a drawer (backdrop, page scroll locked, Place button pinned to the bottom).
// Singles (each pick has its own stake) or a parlay (one stake). Server answers decide the final price.

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { useBetSlip } from '../context/BetSlipContext.jsx';
import { apiRequest, makeRequestId } from '../lib/api.js';
import { formatAmerican, formatMoney, parseDollarsToCents } from '../lib/format.js';
import { formatStrike } from '../../shared/crypto/coins.js';
import {
  CRYPTO_PARLAY_MESSAGE,
  MIN_PARLAY_LEGS,
  combinedAmerican,
  combinedDecimal,
  formatSignedLine,
  marketHasLine,
  payoutCents,
  slipProblems,
  totalStakeCents,
} from '../../shared/betRules.js';
import BetConfirmModal from './BetConfirmModal.jsx';

function stakeCents(input) {
  if (String(input ?? '').trim() === '') return null;
  return parseDollarsToCents(input);
}

function lineText(marketType, line, leg) {
  if (marketType === 'total') return String(line);
  if (marketType === 'crypto') return formatStrike(leg?.crypto?.kind, line);
  return formatSignedLine(line);
}

// Admin test switch: shift lines by half a point and prices by 5 so the server's real
// LINE_CHANGED / price-change handling can be exercised on demand.
function staleCopy(leg) {
  if (!marketHasLine(leg.marketType)) {
    return { line: null, quotedAmerican: leg.american > 0 ? leg.american + 5 : leg.american - 5 };
  }
  return { line: leg.line + 0.5, quotedAmerican: leg.american };
}

export default function BetSlip() {
  const { profile, isAdmin } = useAuth();
  const slip = useBetSlip();
  const { legs, mode, parlayStake, notice } = slip.state;

  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState(null);
  const [simulateStale, setSimulateStale] = useState(false);

  const balanceCents = profile?.balanceCents ?? 0;
  const flagged = legs.filter((l) => l.flag);
  const hasCrypto = legs.some((l) => l.marketType === 'crypto');
  const lineFlags = legs.filter((l) => l.flag?.type === 'lineChanged');

  const parsedLegs = legs.map((l) => ({ ...l, stakeCents: stakeCents(l.stake) }));
  const parlayStakeCents = stakeCents(parlayStake);
  const draft = {
    mode,
    legs: parsedLegs.map((l) => ({ gameId: l.gameId, marketType: l.marketType, selection: l.selection, stakeCents: l.stakeCents ?? undefined })),
    stakeCents: parlayStakeCents ?? undefined,
  };
  const problems = slipProblems(draft, { balanceCents });
  const total = totalStakeCents(draft);
  const parlayDecimal = combinedDecimal(legs.map((l) => l.decimal));
  const potential =
    mode === 'parlay'
      ? parlayStakeCents
        ? payoutCents(parlayStakeCents, parlayDecimal)
        : 0
      : parsedLegs.reduce((sum, l) => sum + (l.stakeCents ? payoutCents(l.stakeCents, l.decimal) : 0), 0);

  const canSubmit = legs.length > 0 && problems.length === 0 && flagged.length === 0 && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    const useStale = isAdmin && simulateStale;
    try {
      const body = {
        mode,
        clientRequestId: makeRequestId(),
        stakeCents: mode === 'parlay' ? parlayStakeCents : undefined,
        legs: parsedLegs.map((l) => ({
          legId: l.legId,
          kalshiTicker: l.kalshi?.ticker,
          kalshiSide: l.kalshi?.side,
          league: l.league,
          gameId: l.gameId,
          marketType: l.marketType,
          selection: l.selection,
          line: l.line,
          quotedAmerican: l.american,
          stakeCents: mode === 'singles' ? l.stakeCents : undefined,
          ...(useStale ? staleCopy(l) : {}),
        })),
      };
      const result = await apiRequest('/api/bets', { method: 'POST', body });
      if (useStale) setSimulateStale(false);
      setConfirmation(result);
      slip.clear();
      setOpen(false);
    } catch (err) {
      if (useStale) setSimulateStale(false);
      if (err.status === 409 && (err.code === 'LINE_CHANGED' || err.code === 'MARKET_CLOSED')) {
        slip.serverRejected({ lineChanges: err.details?.lineChanges ?? [], closedLegs: err.details?.closedLegs ?? [] });
      }
      setError(err.message || 'Could not place the bet.');
    } finally {
      setSubmitting(false);
    }
  }

  const closeConfirmation = useCallback(() => setConfirmation(null), []);
  const isOpen = open && legs.length > 0;

  // While the drawer is open: Escape closes it and the page behind it doesn't scroll.
  // Depends only on isOpen; the cleanup always undoes the lock.
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  }, [isOpen]);

  if (legs.length === 0 && !confirmation) return null;

  return (
    <>
      {isOpen ? <div className="slip-backdrop" role="presentation" onClick={() => setOpen(false)} /> : null}
      {legs.length > 0 ? (
        <aside className={isOpen ? 'bet-slip open' : 'bet-slip'} aria-label="Bet slip">
          <button type="button" className="slip-bar" onClick={() => setOpen((v) => !v)} aria-expanded={isOpen}>
            <span className="slip-bar-title">
              <span className="slip-count" key={legs.length} aria-label={`${legs.length} pick${legs.length === 1 ? '' : 's'}`}>
                {legs.length}
              </span>
              Bet slip
              {flagged.length > 0 ? <span className="badge badge-danger">needs review</span> : null}
            </span>
            <span className="slip-bar-right">
              {total > 0 ? formatMoney(total) : isOpen ? '' : 'Tap to review'}
              <span className="slip-chevron" aria-hidden="true">
                {isOpen ? '▾' : '▴'}
              </span>
            </span>
          </button>

          {isOpen ? (
            <div className="slip-body">
              <div className="slip-modes" role="tablist" aria-label="Bet type">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'singles'}
                  className={mode === 'singles' ? 'sub-tab active' : 'sub-tab'}
                  onClick={() => slip.setMode('singles')}
                >
                  Singles
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'parlay'}
                  className={mode === 'parlay' ? 'sub-tab active' : 'sub-tab'}
                  onClick={() => slip.setMode('parlay')}
                  disabled={legs.length < MIN_PARLAY_LEGS || hasCrypto}
                  title={hasCrypto ? CRYPTO_PARLAY_MESSAGE : legs.length < MIN_PARLAY_LEGS ? 'Add at least 2 picks for a parlay' : undefined}
                >
                  Parlay
                </button>
              </div>

              {hasCrypto ? <p className="muted small">{CRYPTO_PARLAY_MESSAGE}</p> : null}

              <ul className="slip-legs">
                {legs.map((leg) => (
                  <li key={leg.legId} className={leg.flag ? 'slip-leg flagged' : 'slip-leg'}>
                    <div className="slip-leg-top">
                      <div>
                        <div className="slip-leg-label">{leg.label}</div>
                        <div className="muted small">{leg.gameLabel}</div>
                      </div>
                      <div className="slip-leg-odds">{formatAmerican(leg.american)}</div>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove ${leg.label}`}
                        onClick={() => {
                          if (legs.length === 1) setOpen(false); // last pick: the drawer goes away with it
                          slip.remove(leg.legId);
                        }}
                      >
                        ×
                      </button>
                    </div>

                    {leg.flag?.type === 'lineChanged' ? (
                      <div className="slip-flag">
                        <span>
                          Line moved: {lineText(leg.marketType, leg.flag.oldLine, leg)} → {lineText(leg.marketType, leg.flag.newLine, leg)} (
                          {formatAmerican(leg.flag.newAmerican)})
                        </span>
                        <span className="row-actions">
                          <button type="button" className="btn btn-primary small" onClick={() => slip.accept(leg.legId)}>
                            Accept
                          </button>
                          <button type="button" className="btn small" onClick={() => slip.remove(leg.legId)}>
                            Remove
                          </button>
                        </span>
                      </div>
                    ) : null}
                    {leg.flag?.type === 'closed' ? (
                      <div className="slip-flag">
                        <span>{leg.flag.reason}</span>
                        <button type="button" className="btn small" onClick={() => slip.remove(leg.legId)}>
                          Remove
                        </button>
                      </div>
                    ) : null}

                    {mode === 'singles' ? (
                      <label className="stake-field">
                        <span className="muted small">Stake $</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="0.00"
                          value={leg.stake}
                          onChange={(e) => slip.setStake(leg.legId, e.target.value)}
                        />
                        <span className="muted small">
                          {stakeCents(leg.stake) ? `to win ${formatMoney(payoutCents(stakeCents(leg.stake), leg.decimal))}` : ''}
                        </span>
                      </label>
                    ) : null}
                  </li>
                ))}
              </ul>

              {mode === 'parlay' ? (
                <div className="parlay-box">
                  <div className="slip-row">
                    <span>Parlay odds ({legs.length} legs)</span>
                    <strong>{formatAmerican(combinedAmerican(legs.map((l) => l.decimal)))}</strong>
                  </div>
                  <label className="stake-field">
                    <span className="muted small">Stake $</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={parlayStake}
                      onChange={(e) => slip.setParlayStake(e.target.value)}
                    />
                  </label>
                </div>
              ) : null}

              <div className="slip-row">
                <span className="muted">Total stake</span>
                <span>{formatMoney(total)}</span>
              </div>
              <div className="slip-row">
                <span className="muted">Potential payout</span>
                <strong>{formatMoney(potential)}</strong>
              </div>
              <div className="slip-row">
                <span className="muted small">Wallet</span>
                <span className="muted small">{formatMoney(balanceCents)}</span>
              </div>

              {lineFlags.length > 1 ? (
                <button type="button" className="btn small" onClick={() => slip.acceptAll()}>
                  Accept all new lines
                </button>
              ) : null}

              {notice ? <p className="warning-text small">{notice}</p> : null}
              {legs.length > 0 && problems.length > 0 && flagged.length === 0 ? (
                <p className="muted small">{problems[0]}</p>
              ) : null}
              {flagged.length > 0 ? <p className="warning-text small">Review the flagged picks before placing.</p> : null}
              {error ? <p className="error-text small" role="alert">{error}</p> : null}

              {isAdmin ? (
                <label className="test-switch small">
                  <input type="checkbox" checked={simulateStale} onChange={(e) => setSimulateStale(e.target.checked)} />
                  Admin test: submit with an outdated line / price (next submit only)
                </label>
              ) : null}

              <div className="slip-actions">
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    slip.clear();
                    setOpen(false);
                  }}
                  disabled={submitting}
                >
                  Clear
                </button>
                <button type="button" className="btn btn-primary" onClick={submit} disabled={!canSubmit}>
                  {submitting ? 'Placing…' : `Place ${mode === 'parlay' ? 'parlay' : legs.length === 1 ? 'bet' : 'bets'}${total > 0 ? ` · ${formatMoney(total)}` : ''}`}
                </button>
              </div>
            </div>
          ) : null}
        </aside>
      ) : null}

      {confirmation ? <BetConfirmModal result={confirmation} onClose={closeConfirmation} /> : null}
    </>
  );
}
