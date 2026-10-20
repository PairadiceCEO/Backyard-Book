// New Battle: title, description, free-for-all or teams, the players (and their teams), the stake, and
// how the pot pays out by place. The rules come from shared/battles.js, so what this page accepts is
// exactly what the server accepts; the server still checks everything again.

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useWalletDisplay } from '../../context/WalletDisplayContext.jsx';
import { friendlyError } from '../../components/StatusViews.jsx';
import { battleAction } from '../../lib/battles.js';
import { makeRequestId } from '../../lib/api.js';
import { formatMoney } from '../../lib/format.js';
import { BET_HELP_TEXT } from '../../../shared/casino/constants.js';
import {
  BATTLE_DESCRIPTION_MAX,
  BATTLE_MAX_PLAYERS,
  BATTLE_TITLE_MAX,
  TEAMS_MAX,
  TEAMS_MIN,
  TEAM_NAME_MAX,
  battleProblems,
  ordinal,
  percentToBps,
  placeAmounts,
} from '../../../shared/battles.js';

const TEAM_IDS = ['t1', 't2', 't3', 't4'];
const DEFAULT_TEAM_NAMES = ['Team 1', 'Team 2', 'Team 3', 'Team 4'];

function presetsFor(units) {
  const list = [{ label: 'Winner takes all', pcts: ['100'] }];
  if (units >= 3) list.push({ label: '70 / 30', pcts: ['70', '30'] });
  if (units >= 4) list.push({ label: '50 / 30 / 20', pcts: ['50', '30', '20'] });
  return list;
}

// Every player in the game, read once when the page opens (the list doesn't need to be live).
function usePlayers() {
  const [state, setState] = useState({ players: [], loading: true, error: '' });
  useEffect(() => {
    let cancelled = false;
    if (!db) {
      setState({ players: [], loading: false, error: 'Firebase is not configured.' });
      return undefined;
    }
    getDocs(collection(db, 'users'))
      .then((snap) => {
        if (cancelled) return;
        const players = snap.docs
          .map((d) => ({ uid: d.id, name: d.data().displayName || d.data().username || d.id, disabled: d.data().disabled === true }))
          .filter((p) => !p.disabled)
          .sort((a, b) => a.name.localeCompare(b.name));
        setState({ players, loading: false, error: '' });
      })
      .catch((err) => {
        if (!cancelled) setState({ players: [], loading: false, error: err.message || 'Could not load the players.' });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

export default function NewBattlePage() {
  const navigate = useNavigate();
  const { authUser, profile } = useAuth();
  const myUid = authUser?.uid ?? null;
  const myName = profile?.displayName || profile?.username || 'You';
  const balanceCents = Number(profile?.balanceCents) || 0;
  const { reportBalance } = useWalletDisplay();
  const { players: everyone, loading: playersLoading, error: playersError } = usePlayers();

  const [requestId] = useState(makeRequestId);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [format, setFormat] = useState('ffa');
  const [stakeText, setStakeText] = useState('5');
  const [invited, setInvited] = useState([]); // uids, in the order picked
  const [teamCount, setTeamCount] = useState(2);
  const [teamNames, setTeamNames] = useState(DEFAULT_TEAM_NAMES);
  const [teamOf, setTeamOf] = useState({}); // uid → team id (the creator included)
  const [payoutPcts, setPayoutPcts] = useState(['100']);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const others = everyone.filter((p) => p.uid !== myUid);
  const nameOf = (uid) => (uid === myUid ? `${myName} (you)` : everyone.find((p) => p.uid === uid)?.name ?? uid);
  const teams = TEAM_IDS.slice(0, teamCount).map((id, i) => ({ id, name: teamNames[i].trim() }));
  const playerUids = myUid ? [myUid, ...invited] : invited;
  const units = format === 'teams' ? teamCount : playerUids.length;
  const stakeDollars = /^\d+$/.test(stakeText.trim()) ? Number(stakeText.trim()) : NaN;
  const payoutBps = payoutPcts.map(percentToBps);

  // Rebuilt every render (it's small); battleProblems is the same check the server runs.
  const input = {
    title,
    description,
    format,
    stakeDollars,
    payoutBps: payoutBps.map((b) => (b === null ? 0 : b)),
    teams: format === 'teams' ? teams : [],
    players: playerUids.map((uid) => ({ uid, team: format === 'teams' ? teamOf[uid] ?? null : null })),
  };
  const problems = myUid ? battleProblems(input, myUid) : ['Sign in first.'];
  const potCents = Number.isFinite(stakeDollars) ? stakeDollars * 100 * playerUids.length : 0;
  const amounts = placeAmounts(potCents, payoutBps.map((b) => b ?? 0));
  const maxInvites = BATTLE_MAX_PLAYERS - 1;

  function toggle(uid) {
    setInvited((list) => (list.includes(uid) ? list.filter((u) => u !== uid) : list.length >= maxInvites ? list : [...list, uid]));
  }

  function setPct(i, value) {
    setPayoutPcts((list) => list.map((v, j) => (j === i ? value : v)));
  }

  async function create() {
    setBusy(true);
    setError('');
    try {
      const reply = await battleAction('create', { clientRequestId: requestId, ...input });
      if (Number.isFinite(reply?.balanceCents)) reportBalance(reply.balanceCents);
      navigate(`/sportsbook/battles/${encodeURIComponent(reply.battleId)}`, { replace: true });
    } catch (err) {
      setError(friendlyError(err.message));
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <section className="page battle-page">
      <div className="slots-top">
        <Link to="/sportsbook" className="btn btn-ghost small">
          ‹ Sportsbook
        </Link>
        <h2 className="section-title">New Battle</h2>
      </div>

      <div className="card form-card">
        <label className="field">
          <span>Title</span>
          <input value={title} maxLength={BATTLE_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} placeholder="Saturday golf, 9 holes" />
        </label>
        <label className="field">
          <span>Description (optional)</span>
          <textarea value={description} maxLength={BATTLE_DESCRIPTION_MAX} rows={3} onChange={(e) => setDescription(e.target.value)} placeholder="Rules, where, when…" />
        </label>

        <fieldset className="field">
          <legend>Format</legend>
          <div className="segmented" role="radiogroup" aria-label="Format">
            {[
              ['ffa', 'Free-for-all'],
              ['teams', 'Teams'],
            ].map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={format === id} className={format === id ? 'seg active' : 'seg'} onClick={() => setFormat(id)}>
                {label}
              </button>
            ))}
          </div>
          <span className="muted small">{format === 'ffa' ? 'You plus 1–7 players; places are per player.' : '2–4 teams of 2–4 players (8 at most); a team’s share is split evenly.'}</span>
        </fieldset>

        <label className="field">
          <span>Stake per player ($)</span>
          {/* 10 digits: enough to type past the $1,000,000 sanity ceiling and see why it's refused (was 5, a hidden $99,999 cap). */}
          <input inputMode="numeric" value={stakeText} onChange={(e) => setStakeText(e.target.value.replace(/[^\d]/g, '').slice(0, 10))} />
          <span className="muted small">
            {BET_HELP_TEXT} Yours is taken when you create it; each player's when they accept. Your wallet:{' '}
            {formatMoney(balanceCents)}.
          </span>
        </label>
      </div>

      <div className="card form-card">
        <h3 className="small-heading">
          Players ({playerUids.length} of {BATTLE_MAX_PLAYERS})
        </h3>
        {playersLoading ? <p className="muted small">Loading players…</p> : null}
        {playersError ? <p className="error-text small">{playersError}</p> : null}
        <ul className="pick-list">
          {others.map((p) => {
            const on = invited.includes(p.uid);
            return (
              <li key={p.uid}>
                <button type="button" className={on ? 'pick-row on' : 'pick-row'} aria-pressed={on} onClick={() => toggle(p.uid)} disabled={!on && invited.length >= maxInvites}>
                  <span className="pick-check" aria-hidden="true">
                    {on ? '✓' : ''}
                  </span>
                  <span>{p.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {format === 'teams' ? (
        <div className="card form-card">
          <h3 className="small-heading">Teams</h3>
          <div className="segmented" role="radiogroup" aria-label="Number of teams">
            {Array.from({ length: TEAMS_MAX - TEAMS_MIN + 1 }, (_, i) => TEAMS_MIN + i).map((n) => (
              <button key={n} type="button" role="radio" aria-checked={teamCount === n} className={teamCount === n ? 'seg active' : 'seg'} onClick={() => setTeamCount(n)}>
                {n} teams
              </button>
            ))}
          </div>
          {teams.map((t, i) => (
            <label key={t.id} className="field">
              <span>Team {i + 1} name</span>
              <input value={teamNames[i]} maxLength={TEAM_NAME_MAX} onChange={(e) => setTeamNames((list) => list.map((v, j) => (j === i ? e.target.value : v)))} />
            </label>
          ))}
          <ul className="team-assign">
            {playerUids.map((uid) => (
              <li key={uid}>
                <span>{nameOf(uid)}</span>
                <select value={teamOf[uid] ?? ''} onChange={(e) => setTeamOf((m) => ({ ...m, [uid]: e.target.value || null }))} aria-label={`Team for ${nameOf(uid)}`}>
                  <option value="">Pick a team</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name || t.id}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="card form-card">
        <h3 className="small-heading">Payout · pot {formatMoney(potCents)}</h3>
        <div className="button-row">
          {presetsFor(units).map((p) => (
            <button key={p.label} type="button" className="btn small-btn" onClick={() => setPayoutPcts(p.pcts)}>
              {p.label}
            </button>
          ))}
        </div>
        <ul className="payout-rows">
          {payoutPcts.map((pct, i) => (
            <li key={i} className="payout-row">
              <span className="payout-place">{ordinal(i + 1)}</span>
              <span className="pct-input">
                <input inputMode="decimal" value={pct} aria-label={`${ordinal(i + 1)} place percent`} onChange={(e) => setPct(i, e.target.value.replace(/[^\d.]/g, '').slice(0, 6))} />%
              </span>
              <span className="muted small payout-amount">{payoutBps[i] ? formatMoney(amounts[i]) : '—'}</span>
              {payoutPcts.length > 1 ? (
                <button type="button" className="btn btn-ghost small" onClick={() => setPayoutPcts((list) => list.filter((_, j) => j !== i))} aria-label={`Remove ${ordinal(i + 1)} place`}>
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {payoutPcts.length < Math.max(1, units - 1) ? (
          <button type="button" className="btn btn-ghost small" onClick={() => setPayoutPcts((list) => [...list, ''])}>
            Add {ordinal(payoutPcts.length + 1)} place
          </button>
        ) : null}
        <p className="muted small">
          {format === 'teams' ? 'By team place. ' : ''}Shares must add up to 100%. Ties split the places they cover; amounts round down to the cent and
          any leftover cents go to the top winner.
        </p>
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

      {confirming ? (
        <div className="card confirm-card" role="dialog" aria-label="Confirm the Battle">
          <p>
            Create <strong>{title.trim()}</strong> and put in your <strong>{formatMoney(stakeDollars * 100)}</strong> stake now? The others are
            invited; it goes live when all {playerUids.length} have accepted (within 48 hours, or everyone is refunded).
          </p>
          <div className="button-row">
            <button type="button" className="btn btn-primary" onClick={create} disabled={busy}>
              {busy ? 'Creating…' : `Create and pay ${formatMoney(stakeDollars * 100)}`}
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn-primary btn-block" disabled={problems.length > 0 || stakeDollars * 100 > balanceCents} onClick={() => setConfirming(true)}>
          {stakeDollars * 100 > balanceCents ? 'Not enough in your wallet' : 'Review and create'}
        </button>
      )}
    </section>
  );
}
