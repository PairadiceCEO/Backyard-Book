// One Challenge, live from its Firestore doc: the question and description, who posted it, when betting
// closes, its outcomes (tap one to add it to the bet slip while it's open), the poster's own bets on it
// (each tagged "Poster's bet", listed for everyone), and the admin's change log.

import { Link, useParams } from 'react-router-dom';
import { EmptyState, ErrorState, LoadingState } from '../../components/StatusViews.jsx';
import EditLog from '../../components/EditLog.jsx';
import { OutcomeButton, statusLine } from '../../components/ChallengeCard.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { closeMsOf, stateOf, useChallenge, useNowMs } from '../../lib/challenges.js';
import { toMs, timeLeft } from '../../lib/battles.js';
import { formatAmerican, formatCentralDateTime, formatMoney } from '../../lib/format.js';
import { CHALLENGE_STATUS_LABELS } from '../../../shared/challenges.js';

function PosterBets({ challenge }) {
  const list = challenge.posterBets ?? [];
  if (list.length === 0) return null;
  return (
    <div className="card">
      <h3 className="small-heading">{challenge.posterName}'s bets on this</h3>
      <ul className="battle-log poster-bets">
        {list.map((b) => (
          <li key={b.betId} className="poster-bet">
            <span className="tag tag-poster">Poster's bet</span>
            <span>
              <strong>{b.label}</strong> {formatAmerican(b.americanOdds)}
              {b.parlay ? ' (in a parlay)' : ''} · {formatMoney(b.stakeCents)}
              {b.parlay ? ' parlay stake' : ''}
            </span>
            <span className="muted small">{formatCentralDateTime(new Date(toMs(b.at) ?? 0))}</span>
          </li>
        ))}
      </ul>
      <p className="muted small">The poster may bet on their own Challenge like anyone else; those bets are always shown here.</p>
    </div>
  );
}

export default function ChallengeDetailPage() {
  const { challengeId } = useParams();
  const { authUser } = useAuth();
  const uid = authUser?.uid ?? null;
  const { challenge, error, loading } = useChallenge(challengeId);
  const nowMs = useNowMs();

  const top = (
    <div className="slots-top">
      <Link to="/sportsbook" className="btn btn-ghost small">
        ‹ Sportsbook
      </Link>
      {challenge ? <span className={`battle-status status-${stateOf(challenge, nowMs)}`}>{CHALLENGE_STATUS_LABELS[stateOf(challenge, nowMs)]}</span> : null}
    </div>
  );

  if (loading) {
    return (
      <section className="page battle-page">
        {top}
        <LoadingState label="Loading the Challenge…" rows={3} />
      </section>
    );
  }
  if (error) {
    return (
      <section className="page battle-page">
        {top}
        <ErrorState title="Couldn't load this Challenge" message={error} />
      </section>
    );
  }
  if (!challenge) {
    return (
      <section className="page battle-page">
        {top}
        <EmptyState icon="🎯" title="This Challenge doesn't exist">
          It may have been removed. Your bets are always in My Bets.
        </EmptyState>
      </section>
    );
  }

  const state = stateOf(challenge, nowMs);
  const closeMs = closeMsOf(challenge);
  const mine = challenge.posterUid === uid;
  const bets = Number(challenge.betCount) || 0;
  const line = statusLine(challenge, state);

  return (
    <section className="page battle-page">
      {top}
      <div className="card">
        <h2 className="battle-detail-title">{challenge.title}</h2>
        {challenge.description ? <p className="battle-description">{challenge.description}</p> : null}
        <dl className="battle-facts">
          <div>
            <dt>Posted by</dt>
            <dd>{mine ? `${challenge.posterName} (you)` : challenge.posterName}</dd>
          </div>
          <div>
            <dt>{state === 'open' || state === 'pending' ? 'Betting closes' : 'Betting closed'}</dt>
            <dd>{closeMs ? formatCentralDateTime(new Date(closeMs)) : '—'}</dd>
          </div>
          <div>
            <dt>Bets</dt>
            <dd>{bets}</dd>
          </div>
          {state === 'open' && closeMs ? (
            <div>
              <dt>Time left</dt>
              <dd>{timeLeft(closeMs, nowMs)}</dd>
            </div>
          ) : null}
        </dl>
        <div className="outcome-grid">
          {(challenge.outcomes ?? []).map((o) => (
            <OutcomeButton key={o.id} challenge={challenge} outcome={o} open={state === 'open'} winner={state === 'settled' && challenge.winner === o.id} />
          ))}
        </div>
        {state === 'open' ? (
          <p className="muted small">Tap an outcome to add it to your slip. Singles or parlays; one outcome per Challenge in a parlay. Your odds are locked when you bet.</p>
        ) : null}
        {line ? <p className={state === 'rejected' ? 'error-text small' : 'muted small'}>{line}</p> : null}
        {state === 'pending' && mine ? <p className="muted small">The admin may adjust the wording or odds before approving it. You can bet on it too once it's open.</p> : null}
      </div>

      <PosterBets challenge={challenge} />
      <EditLog edits={challenge.edits} />
      <p className="muted small">Your bets on this Challenge are in My Bets.</p>
    </section>
  );
}
