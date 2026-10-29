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
import OddsChangedModal from './OddsChangedModal.jsx';
import { ODDS_CONFIRM_POINTS, oddsScale } from '../../shared/oddsMath.js';

function stakeCents(input) {
  if (String(input ?? '').trim() === '') return null;
  return parseDollarsToCents(input);
}

function lineText(marketType, line, leg) {
  if (marketType === 'total') return String(line);
  if (marketType === 'crypto') return formatStrike(leg?.crypto?.kind, line);
  if (marketType === 'prop') return Number.isFinite(line) ? `${Math.round(line + 0.5)}+` : '';
  return formatSignedLine(line);
}

// Admin test switches: shift lines by half a point and prices by 5 so the server's real
// LINE_CHANGED / price-change handling can be exercised on demand; or send odds 60 points off (on the scale where
// −100 and +100 are the same point) to see ODDS_CHANGED.
function shiftedOdds(american, points) {
  const x = oddsScale(american) + points;
  return x >= 0 ? x + 100 : x - 100;
}

function staleCopy(leg) {
  if (!marketHasLine(leg.marketType)) {
    return { line: null, quotedAmerican: leg.american > 0 ? leg.american + 5 : leg.american - 5 };
  }
  return { line: leg.line + 0.5, quotedAmerican: leg.american };
}

function slipSummary({ legs, mode, total, potential }) {
  let title;
  if (mode === 'parlay' && legs.length >= MIN_PARLAY_LEGS) {
    title = `${legs.length}-leg parlay ${formatAmerican(combinedAmerican(legs.map((l) => l.decimal)))}`;
  } else if (legs.length === 1) {
    title = `${legs[0].label} ${formatAmerican(legs[0].american)}`;
  } else {
    title = `${legs.length} single bets`;
  }
  const sub = total > 0 ? `${formatMoney(total)} to win ${formatMoney(Math.max(0, potential - total))}` : 'Add a stake';
  return { title, sub };
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
  const [simulateOdds, setSimulateOdds] = useState(false);
  const [oddsChanges, setOddsChanges] = useState(null); // ODDS_CHANGED answer waiting for the player

  const balanceCents = profile?.balanceCents ?? 0;
  const flagged = legs.filter((l) => l.flag);
  const hasCrypto = legs.some((l) => l.marketType === 'crypto');
  const lineFlags = legs.filter((l) => l.flag?.type === 'lineChanged');

  const parsedLegs = legs.map((l) => ({ ...l, stakeCents: stakeCents(l.stake) }));
  const parlayStakeCents = stakeCents(parlayStake);
  const draft = {
    mode,
    legs: parsedLegs.map((l) => ({ gameId: l.gameId, marketType: l.marketType, selection: l.selection, kalshi: l.kalshi, prop: l.prop, stakeCents: l.stakeCents ?? undefined })),
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

  // The closed bar's text, from the same numbers the drawer shows: "2-leg parlay +264" and "$10 to win $26.40" (the win is the
  // payout minus the stake).
  const summary = slipSummary({ legs, mode, total, potential });

  const canSubmit = legs.length > 0 && problems.length === 0 && flagged.length === 0 && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    const useStale = isAdmin && simulateStale;
    const useOdds = isAdmin && simulateOdds && !useStale;
    try {
      const body = {
        mode,
        clientRequestId: makeRequestId(),
        stakeCents: mode === 'parlay' ? parlayStakeCents : undefined,
        legs: parsedLegs.map((l) => ({
          legId: l.legId,
          kalshiTicker: l.kalshi?.ticker,
          kalshiSide: l.kalshi?.side,
          ...(l.marketType === 'prop' && l.prop?.player ? { playerName: l.prop.player } : {}),
          league: l.league,
          gameId: l.gameId,
          marketType: l.marketType,
          selection: l.selection,
          line: l.line,
          quotedAmerican: l.american,
          stakeCents: mode === 'singles' ? l.stakeCents : undefined,
          ...(useStale ? staleCopy(l) : {}),
          ...(useOdds ? { quotedAmerican: shiftedOdds(l.american, ODDS_CONFIRM_POINTS + 10) } : {}),
        })),
      };
      const result = await apiRequest('/api/bets', { method: 'POST', body });
      if (useStale) setSimulateStale(false);
      if (useOdds) setSimulateOdds(false);
      setConfirmation(result);
      slip.clear();
      setOpen(false);
    } catch (err) {
      if (useStale) setSimulateStale(false);
      if (useOdds) setSimulateOdds(false);
      if (err.status === 409 && (err.code === 'LINE_CHANGED' || err.code === 'MARKET_CLOSED')) {
        slip.serverRejected({ lineChanges: err.details?.lineChanges ?? [], closedLegs: err.details?.closedLegs ?? [] });
      }
      if (err.status === 409 && err.code === 'ODDS_CHANGED' && Array.isArray(err.details?.oddsChanges)) {
        // The popup lists each moved pick with its label; nothing was placed.
        const byId = new Map(legs.map((l) => [l.legId, l]));
        setOddsChanges(
          err.details.oddsChanges
            .filter((c) => byId.has(c.legId))
            .map((c) => ({ ...c, label: byId.get(c.legId).label, gameLabel: byId.get(c.legId).gameLabel })),
        );
        setError('');
        return;
      }
      setError(err.message || 'Could not place the bet.');
    } finally {
      setSubmitting(false);
    }
  }

  const closeConfirmation = useCallback(() => setConfirmation(null), []);
  const closeOddsChanges = useCallback(() => setOddsChanges(null), []);
  const acceptOddsChanges = useCallback(() => {
    if (oddsChanges) slip.acceptOdds(oddsChanges);
    setOddsChanges(null);
  }, [oddsChanges, slip]);
  const removeOddsChanged = useCallback(() => {
    if (oddsChanges) slip.removeMany(oddsChanges.map((c) => c.legId));
    setOddsChanges(null);
  }, [oddsChanges, slip]);
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
          {notice && !isOpen ? (
            // A refused pick (e.g. a second leg on the same player and stat in a parlay) explains itself even with the
            // drawer closed; the next pick or the × clears it.
            <div className="slip-notice" role="status">
              <span className="warning-text small">{notice}</span>
              <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => slip.dismissNotice()}>
                ×
              </button>
            </div>
          ) : null}
          <button type="button" className="slip-bar" onClick={() => setOpen((v) => !v)} aria-expanded={isOpen}>
            {isOpen ? (
              <>
                <span className="slip-bar-title">
                  <span className="slip-count" key={legs.length} aria-label={`${legs.length} pick${legs.length === 1 ? '' : 's'}`}>
                    {legs.length}
                  </span>
                  Bet slip
                  {flagged.length > 0 ? <span className="badge badge-danger">needs review</span> : null}
                </span>
                <span className="slip-bar-right">
                  {total > 0 ? formatMoney(total) : ''}
                  <span className="slip-chevron" aria-hidden="true">
                    ▾
                  </span>
                </span>
              </>
            ) : (
              <>
                <span className="slip-count" key={legs.length} aria-label={`${legs.length} pick${legs.length === 1 ? '' : 's'}`}>
                  {legs.length}
                </span>
                <span className="slip-summary">
                  <span className="slip-summary-title">{summary.title}</span>
                  <span className="slip-summary-sub">
                    {flagged.length > 0 ? 'Needs review' : summary.sub}
                  </span>
                </span>
                <span className="slip-open-cta">Bet slip</span>
              </>
            )}
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
                <>
                  <label className="test-switch small">
                    <input type="checkbox" checked={simulateStale} onChange={(e) => setSimulateStale(e.target.checked)} />
                    Admin test: submit with an outdated line / price (next submit only)
                  </label>
                  <label className="test-switch small">
                    <input type="checkbox" checked={simulateOdds} onChange={(e) => setSimulateOdds(e.target.checked)} />
                    Admin test: submit with odds 60 points off, to see the odds-changed popup (next submit only)
                  </label>
                </>
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
      {oddsChanges && oddsChanges.length ? (
        <OddsChangedModal changes={oddsChanges} onAccept={acceptOddsChanges} onRemove={removeOddsChanged} onClose={closeOddsChanges} />
      ) : null}
    </>
  );
}
