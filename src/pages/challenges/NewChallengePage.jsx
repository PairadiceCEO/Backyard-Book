// Post a Challenge: the question, an optional description, 2–6 outcomes each with proposed American odds,
// and when betting closes (Central Time). It's visible to everyone at once as "Pending approval"; betting
// opens when the admin approves it (they may adjust the wording and odds first). The checks come from
// shared/challenges.js, the same ones the server runs again.

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { friendlyError } from '../../components/StatusViews.jsx';
import { battleAction } from '../../lib/battles.js';
import { makeRequestId } from '../../lib/api.js';
import { formatMoney } from '../../lib/format.js';
import { useNowMs } from '../../lib/challenges.js';
import { payoutCents } from '../../../shared/betRules.js';
import { americanToDecimal } from '../../../shared/oddsMath.js';
import { centralWallParts, centralWallTimeToDate } from '../../../shared/time.js';
import {
  CHALLENGE_DESCRIPTION_MAX,
  CHALLENGE_TITLE_MAX,
  OUTCOMES_MAX,
  OUTCOMES_MIN,
  OUTCOME_LABEL_MAX,
  challengeProblems,
  cleanAmerican,
} from '../../../shared/challenges.js';

const SAMPLE_STAKE_CENTS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// "+150" → "a $10 bet pays $25.00"; nothing for an incomplete price.
function payoutHint(text) {
  const american = cleanAmerican(text);
  if (american === null) return '';
  return `$10 pays ${formatMoney(payoutCents(SAMPLE_STAKE_CENTS, americanToDecimal(american)))}`;
}

function cleanOddsInput(value) {
  const v = value.replace(/[^\d+-]/g, '');
  const sign = /^[+-]/.test(v) ? v[0] : '';
  return (sign + v.replace(/[+-]/g, '')).slice(0, 7);
}

export default function NewChallengePage() {
  const navigate = useNavigate();
  const nowMs = useNowMs();
  const [requestId] = useState(makeRequestId);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [outcomes, setOutcomes] = useState([
    { label: 'Yes', american: '' },
    { label: 'No', american: '' },
  ]);
  const [closeDate, setCloseDate] = useState(() => centralWallParts(new Date(Date.now() + DAY_MS)).date);
  const [closeClock, setCloseClock] = useState('19:00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const close = centralWallTimeToDate(closeDate, closeClock);
  const problems = challengeProblems({ title, description, outcomes, closeMs: close ? close.getTime() : NaN }, nowMs);

  function setOutcome(i, field, value) {
    setOutcomes((list) => list.map((o, j) => (j === i ? { ...o, [field]: value } : o)));
  }

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const reply = await battleAction('postChallenge', {
        clientRequestId: requestId,
        title: title.trim(),
        description: description.trim(),
        outcomes: outcomes.map((o) => ({ label: o.label.trim(), american: o.american.trim() })),
        closeDate,
        closeClock,
      });
      navigate(`/sportsbook/challenges/${encodeURIComponent(reply.challengeId)}`, { replace: true });
    } catch (err) {
      setError(friendlyError(err.message));
      setBusy(false);
    }
  }

  return (
    <section className="page battle-page">
      <div className="slots-top">
        <Link to="/sportsbook" className="btn btn-ghost small">
          ‹ Sportsbook
        </Link>
        <h2 className="section-title">Post a Challenge</h2>
      </div>

      <div className="card form-card">
        <label className="field">
          <span>Question</span>
          <input value={title} maxLength={CHALLENGE_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} placeholder="Will Mike run a 5K under 25 minutes?" />
        </label>
        <label className="field">
          <span>Description (optional)</span>
          <textarea
            value={description}
            maxLength={CHALLENGE_DESCRIPTION_MAX}
            rows={3}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="How it's decided: where, when, what counts…"
          />
        </label>
      </div>

      <div className="card form-card">
        <h3 className="small-heading">
          Outcomes ({outcomes.length} of {OUTCOMES_MAX})
        </h3>
        <p className="muted small">Name each outcome and propose its American odds: +150 pays $25 on a $10 bet, -180 pays $15.55. The admin may adjust them.</p>
        <ul className="payout-rows">
          {outcomes.map((o, i) => (
            <li key={i} className="outcome-row">
              <input
                className="outcome-name"
                value={o.label}
                maxLength={OUTCOME_LABEL_MAX}
                aria-label={`Outcome ${i + 1} name`}
                placeholder={`Outcome ${i + 1}`}
                onChange={(e) => setOutcome(i, 'label', e.target.value)}
              />
              <input
                className="outcome-odds"
                inputMode="text"
                value={o.american}
                aria-label={`Outcome ${i + 1} odds`}
                placeholder="+150"
                onChange={(e) => setOutcome(i, 'american', cleanOddsInput(e.target.value))}
              />
              {outcomes.length > OUTCOMES_MIN ? (
                <button type="button" className="btn btn-ghost small" aria-label={`Remove outcome ${i + 1}`} onClick={() => setOutcomes((list) => list.filter((_, j) => j !== i))}>
                  Remove
                </button>
              ) : null}
              <span className="muted small outcome-hint">{payoutHint(o.american)}</span>
            </li>
          ))}
        </ul>
        {outcomes.length < OUTCOMES_MAX ? (
          <button type="button" className="btn btn-ghost small" onClick={() => setOutcomes((list) => [...list, { label: '', american: '' }])}>
            Add an outcome
          </button>
        ) : null}
      </div>

      <div className="card form-card">
        <h3 className="small-heading">Betting closes (Central Time)</h3>
        <div className="close-time-row">
          <label className="field">
            <span>Date</span>
            <input type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} />
          </label>
          <label className="field">
            <span>Time</span>
            <input type="time" value={closeClock} onChange={(e) => setCloseClock(e.target.value)} />
          </label>
        </div>
        <p className="muted small">At least 10 minutes and at most 60 days from now. Set it before the result can be known.</p>
      </div>

      {problems.length ? (
        <ul className="problem-list" aria-live="polite">
          {problems.map((p) => (
            <li key={p} className="warning-text small">
              {p}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}

      <button type="button" className="btn btn-primary btn-block" disabled={problems.length > 0 || busy} onClick={submit}>
        {busy ? 'Posting…' : 'Post for approval'}
      </button>
      <p className="muted small">Everyone sees it right away as “Pending approval”. Betting opens, for you too, once the admin approves it.</p>
    </section>
  );
}
