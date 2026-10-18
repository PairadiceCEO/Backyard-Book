// One Challenge on the Custom tab: the question, its status, who posted it, when betting closes, and an
// outcome button per outcome. While it's open (approved, before the close time) tapping an outcome adds it
// to the bet slip, like a game's price; picking another outcome of the same Challenge replaces it.

import { Link } from 'react-router-dom';
import { useBetSlip } from '../context/BetSlipContext.jsx';
import { formatAmerican, formatCentralDateTime } from '../lib/format.js';
import { closeMsOf, makeChallengePick, stateOf } from '../lib/challenges.js';
import { CHALLENGE_STATUS_LABELS, outcomeLabel } from '../../shared/challenges.js';

// One outcome: a slip button while betting is open, otherwise its price for display (the winner marked).
export function OutcomeButton({ challenge, outcome, open, winner = false }) {
  const slip = useBetSlip();
  const content = (
    <>
      <span className="outcome-label">{outcome.label}</span>
      <span className="odds-price">{formatAmerican(outcome.american)}</span>
    </>
  );
  if (!open) {
    return (
      <span className={winner ? 'outcome-cell winner' : 'outcome-cell'} aria-label={`${outcome.label} ${formatAmerican(outcome.american)}${winner ? ', won' : ''}`}>
        {content}
        {winner ? <span className="outcome-won">Won</span> : null}
      </span>
    );
  }
  const pick = makeChallengePick(challenge, outcome);
  const selected = slip.isSelected(pick.legId);
  return (
    <button
      type="button"
      className={selected ? 'outcome-cell odds-button selected' : 'outcome-cell odds-button'}
      aria-pressed={selected}
      aria-label={`${outcome.label} ${formatAmerican(outcome.american)}`}
      onClick={() => slip.toggle(pick)}
    >
      {content}
    </button>
  );
}

export function statusLine(challenge, state) {
  if (state === 'pending') return 'Pending approval: no betting until the admin approves it.';
  if (state === 'closed') return 'Betting closed · waiting for the admin to settle it.';
  if (state === 'settled') return `Settled · ${outcomeLabel(challenge, challenge.winner)} won.`;
  if (state === 'void') return 'Void: every bet on it was refunded.';
  if (state === 'rejected') return `Rejected${challenge.rejectNote ? `: ${challenge.rejectNote}` : ''}`;
  return '';
}

export default function ChallengeCard({ challenge, uid, nowMs }) {
  const state = stateOf(challenge, nowMs);
  const closeMs = closeMsOf(challenge);
  const mine = challenge.posterUid === uid;
  const bets = Number(challenge.betCount) || 0;
  const line = statusLine(challenge, state);
  const to = `/sportsbook/challenges/${encodeURIComponent(challenge.id)}`;
  return (
    <article className={`card challenge-card state-${state}`}>
      <div className="battle-card-head">
        <strong className="battle-title">{challenge.title}</strong>
        <span className={`battle-status status-${state}`}>{CHALLENGE_STATUS_LABELS[state] ?? state}</span>
      </div>
      <div className="muted small">
        By {mine ? 'you' : challenge.posterName} · {closeMs && closeMs > nowMs ? 'closes' : 'closed'} {closeMs ? formatCentralDateTime(new Date(closeMs)) : ''} · {bets} bet
        {bets === 1 ? '' : 's'}
      </div>
      <div className="outcome-grid">
        {(challenge.outcomes ?? []).map((o) => (
          <OutcomeButton key={o.id} challenge={challenge} outcome={o} open={state === 'open'} winner={state === 'settled' && challenge.winner === o.id} />
        ))}
      </div>
      {line ? <div className={state === 'rejected' ? 'error-text small' : 'muted small'}>{line}</div> : null}
      <Link to={to} className="challenge-more small" aria-label={`Details: ${challenge.title}`}>
        Details{(challenge.posterBets ?? []).length ? " · poster's bets" : ''} ›
      </Link>
    </article>
  );
}
