// Admin → Custom games: create, edit (incl. start time), final score, cancel and delete house games.
// Lists upcoming, closed (started, no final score) and finished games with their bet counts.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { adminAction } from '../../lib/api.js';
import { LEAGUES } from '../../../shared/constants.js';
import { centralWallParts } from '../../../shared/time.js';
import { formatAmerican, formatCentralDateTime, formatMoney, formatSpreadLine } from '../../lib/format.js';
import MoneyConfirmModal from './MoneyConfirmModal.jsx';
import { ErrorState, LoadingState } from '../../components/StatusViews.jsx';

const LEAGUE_LABELS = Object.fromEntries(LEAGUES.map((l) => [l.id, l.label]));
const RESULT_LABELS = { win: 'Won', loss: 'Lost', push: 'Push', void: 'Void', pending: 'Pending' };
const STATUS_LABELS = { open: 'Stays open', won: 'Won', lost: 'Lost', push: 'Push', void: 'Void' };

function toMs(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

const priceText = (v) => (v === null || v === undefined ? '' : v > 0 ? `+${v}` : String(v));
const lineText = (v) => (v === null || v === undefined ? '' : String(v));

// Live list of every custom game. Subscribes once (again on retry); removed on unmount.
function useCustomGames() {
  const [state, setState] = useState({ games: [], error: '', loaded: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!db) return undefined;
    const unsubscribe = onSnapshot(
      collection(db, 'customGames'),
      (snap) =>
        setState({
          games: snap.docs.map((d) => ({ id: d.id, ...d.data(), startMs: toMs(d.data().startTime) })),
          error: '',
          loaded: true,
        }),
      (err) => setState({ games: [], error: err.message || 'Could not load custom games.', loaded: true }),
    );
    return unsubscribe;
  }, [attempt]);
  const retry = useCallback(() => {
    setState({ games: [], error: '', loaded: false });
    setAttempt((n) => n + 1);
  }, []);
  return { ...state, retry };
}

// Current time, refreshed every 15 s so games move from Upcoming to Closed on their own.
function useNowMs() {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  return nowMs;
}

function emptyForm() {
  return {
    league: 'nfl',
    homeName: '',
    homeAbbr: '',
    homeLogo: '',
    awayName: '',
    awayAbbr: '',
    awayLogo: '',
    startDate: centralWallParts(new Date()).date,
    startClock: '19:00',
    mlHome: '',
    mlAway: '',
    spreadLine: '',
    spreadHome: '',
    spreadAway: '',
    totalLine: '',
    over: '',
    under: '',
  };
}

function formFromGame(game) {
  const start = centralWallParts(new Date(game.startMs));
  const o = game.odds ?? {};
  return {
    league: game.league,
    homeName: game.home?.name ?? '',
    homeAbbr: game.home?.abbr ?? '',
    homeLogo: game.home?.logoUrl ?? '',
    awayName: game.away?.name ?? '',
    awayAbbr: game.away?.abbr ?? '',
    awayLogo: game.away?.logoUrl ?? '',
    startDate: start.date,
    startClock: start.clock,
    mlHome: priceText(o.moneyline?.home),
    mlAway: priceText(o.moneyline?.away),
    spreadLine: lineText(o.spread?.homeLine),
    spreadHome: priceText(o.spread?.home),
    spreadAway: priceText(o.spread?.away),
    totalLine: lineText(o.total?.line),
    over: priceText(o.total?.over),
    under: priceText(o.total?.under),
  };
}

function payloadFrom(form) {
  return {
    league: form.league,
    home: { name: form.homeName, abbr: form.homeAbbr, logoUrl: form.homeLogo },
    away: { name: form.awayName, abbr: form.awayAbbr, logoUrl: form.awayLogo },
    startDate: form.startDate,
    startClock: form.startClock,
    odds: {
      moneyline: { home: form.mlHome, away: form.mlAway },
      spread: { homeLine: form.spreadLine, home: form.spreadHome, away: form.spreadAway },
      total: { line: form.totalLine, over: form.over, under: form.under },
    },
  };
}

function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small className="muted">{hint}</small> : null}
    </label>
  );
}

// Create or edit form. `initial` seeds the form once; the parent remounts it (key) for a different game.
function CustomGameForm({ initial, gameId, betCount, onSaved, onCancel }) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (key) => (event) => {
    const value = key.endsWith('Abbr') ? event.target.value.toUpperCase() : event.target.value;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  async function handleSubmit(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const result = await adminAction(gameId ? 'updateCustomGame' : 'createCustomGame', { gameId, ...payloadFrom(form) });
      onSaved(
        gameId
          ? `Saved. Betting is ${result.bettingOpen ? 'open until the start time' : 'closed (start time has passed)'}.`
          : 'Game created. It appears on the board within 30 seconds.',
      );
    } catch (err) {
      setError(err.message || 'Could not save the game.');
      setSaving(false);
    }
  }

  const input = (key, props = {}) => <input type="text" value={form[key]} onChange={set(key)} disabled={saving} {...props} />;

  return (
    <form className="card form-grid" onSubmit={handleSubmit} noValidate>
      <h3>{gameId ? 'Edit custom game' : 'New custom game'}</h3>

      <Field label="League (the board tab it appears on)" hint={gameId && betCount > 0 ? "Bets exist, so the league can't change." : null}>
        <select value={form.league} onChange={set('league')} disabled={saving || (Boolean(gameId) && betCount > 0)}>
          {LEAGUES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </Field>

      <div className="two-col">
        <fieldset className="form-grid fieldset">
          <legend>Away team</legend>
          <Field label="Name">{input('awayName', { maxLength: 30 })}</Field>
          <Field label="Abbreviation">{input('awayAbbr', { maxLength: 5, autoCapitalize: 'characters' })}</Field>
          <Field label="Logo URL (optional)" hint="https:// image link; initials are shown without one">
            {input('awayLogo', { inputMode: 'url', autoCapitalize: 'none', spellCheck: false })}
          </Field>
        </fieldset>
        <fieldset className="form-grid fieldset">
          <legend>Home team</legend>
          <Field label="Name">{input('homeName', { maxLength: 30 })}</Field>
          <Field label="Abbreviation">{input('homeAbbr', { maxLength: 5, autoCapitalize: 'characters' })}</Field>
          <Field label="Logo URL (optional)" hint="https:// image link; initials are shown without one">
            {input('homeLogo', { inputMode: 'url', autoCapitalize: 'none', spellCheck: false })}
          </Field>
        </fieldset>
      </div>

      <div className="two-col">
        <Field label="Start date (Central Time)">
          <input type="date" value={form.startDate} onChange={set('startDate')} disabled={saving} />
        </Field>
        <Field label="Start time (Central Time)" hint="Betting closes at this time.">
          <input type="time" value={form.startClock} onChange={set('startClock')} disabled={saving} />
        </Field>
      </div>

      <fieldset className="form-grid fieldset">
        <legend>Odds — leave a market blank to not offer it</legend>
        <p className="muted small">American odds like -110 or +150. {gameId ? 'New odds only apply to new bets; placed bets keep their odds.' : ''}</p>
        <div className="odds-group">
          <span className="odds-group-title">Moneyline</span>
          <div className="odds-row two">
            <Field label="Away">{input('mlAway', { inputMode: 'numeric' })}</Field>
            <Field label="Home">{input('mlHome', { inputMode: 'numeric' })}</Field>
          </div>
        </div>
        <div className="odds-group">
          <span className="odds-group-title">Spread — home line, e.g. -3.5 (away gets +3.5)</span>
          <div className="odds-row">
            <Field label="Home line">{input('spreadLine', { inputMode: 'decimal' })}</Field>
            <Field label="Away price">{input('spreadAway', { inputMode: 'numeric' })}</Field>
            <Field label="Home price">{input('spreadHome', { inputMode: 'numeric' })}</Field>
          </div>
        </div>
        <div className="odds-group">
          <span className="odds-group-title">Total — e.g. 44.5</span>
          <div className="odds-row">
            <Field label="Line">{input('totalLine', { inputMode: 'decimal' })}</Field>
            <Field label="Over">{input('over', { inputMode: 'numeric' })}</Field>
            <Field label="Under">{input('under', { inputMode: 'numeric' })}</Field>
          </div>
        </div>
      </fieldset>

      {error ? <p className="error-text">{error}</p> : null}
      <div className="button-row">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : gameId ? 'Save changes' : 'Create game'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function oddsSummary(game) {
  const o = game.odds ?? {};
  const parts = [];
  const ml = o.moneyline ?? {};
  if (ml.home !== null && ml.home !== undefined) parts.push(`${game.home.abbr} ${formatAmerican(ml.home)}`);
  if (ml.away !== null && ml.away !== undefined) parts.push(`${game.away.abbr} ${formatAmerican(ml.away)}`);
  const ms = parts.length ? `ML ${parts.join(' / ')}` : 'ML —';
  const sp = o.spread ?? {};
  const spread =
    sp.homeLine !== null && sp.homeLine !== undefined
      ? `Spread ${game.home.abbr} ${formatSpreadLine(sp.homeLine)} (${sp.home !== null ? formatAmerican(sp.home) : '—'} / ${sp.away !== null ? formatAmerican(sp.away) : '—'})`
      : 'Spread —';
  const t = o.total ?? {};
  const total =
    t.line !== null && t.line !== undefined
      ? `Total ${t.line} (O ${t.over !== null ? formatAmerican(t.over) : '—'} / U ${t.under !== null ? formatAmerican(t.under) : '—'})`
      : 'Total —';
  return `${ms} · ${spread} · ${total}`;
}

function PreviewBets({ rows }) {
  if (rows.length === 0) return <p className="muted small">No bets settle.</p>;
  return (
    <ul className="confirm-list">
      {rows.map((bet) => (
        <li key={bet.id} className="confirm-bet">
          <div className="confirm-bet-head">
            <strong>
              {bet.username} · {bet.type === 'parlay' ? `Parlay · ${bet.legs.length} legs` : 'Single'} · {formatMoney(bet.stakeCents)}
            </strong>
            <span>
              {STATUS_LABELS[bet.status]} · pays {formatMoney(bet.payoutCents)}
            </span>
          </div>
          {bet.legs.map((leg, i) => (
            <div key={`${bet.id}-${i}`} className="confirm-leg">
              <div>
                <div>{leg.label}</div>
                <div className="muted small">{leg.scoreText || leg.gameLabel}</div>
              </div>
              <span className={`leg-result result-${leg.result}`}>{RESULT_LABELS[leg.result] ?? leg.result}</span>
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}

// One game with its actions. Final score and cancel preview first, then confirm in the money modal.
function GameRow({ game, group, onEdit, onNotice }) {
  const [scoring, setScoring] = useState(false);
  const [scores, setScores] = useState({ away: '', home: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(null); // { kind: 'final' | 'cancel', preview, params }
  const [confirmError, setConfirmError] = useState('');

  const gameId = `custom:${game.id}`;
  const label = `${game.away.name} @ ${game.home.name}`;
  const betCount = Number(game.betCount) || 0;

  async function review(kind) {
    setBusy(true);
    setError('');
    const params = kind === 'final' ? { gameId, homeScore: Number(scores.home), awayScore: Number(scores.away) } : { gameId };
    try {
      const preview = await adminAction(kind === 'final' ? 'finalizeCustomGame' : 'cancelCustomGame', params);
      setConfirmError('');
      setPending({ kind, preview, params });
    } catch (err) {
      setError(err.message || 'Could not prepare the preview.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setConfirmError('');
    try {
      const result = await adminAction(pending.kind === 'final' ? 'finalizeCustomGame' : 'cancelCustomGame', { ...pending.params, confirm: true });
      const s = result.settlement ?? {};
      onNotice(`${label}: ${pending.kind === 'final' ? 'final score saved' : 'canceled'}. Settled ${s.settled ?? 0} bet${s.settled === 1 ? '' : 's'}; ${s.stillOpen ?? 0} still open.`);
      setPending(null);
      setScoring(false);
    } catch (err) {
      setConfirmError(err.message || 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete ${label}? This can't be undone.`)) return;
    setBusy(true);
    setError('');
    try {
      await adminAction('deleteCustomGame', { gameId });
      onNotice(`${label} deleted.`);
    } catch (err) {
      setError(err.message || 'Could not delete.');
      setBusy(false);
    }
  }

  const cancelPending = useCallback(() => setPending(null), []);
  const scheduled = game.status === 'scheduled' || !game.status;

  return (
    <li className="card custom-game">
      <div className="custom-game-head">
        <div>
          <strong>{label}</strong> <span className="badge">{LEAGUE_LABELS[game.league] ?? game.league}</span>
          {group === 'closed' ? <span className="badge">betting closed</span> : null}
          <div className="muted small">
            {game.startMs ? formatCentralDateTime(new Date(game.startMs)) : 'No start time'} · {betCount} bet{betCount === 1 ? '' : 's'}
          </div>
        </div>
        <div className="custom-game-status">
          {game.status === 'final' ? (
            <strong>
              Final: {game.away.abbr} {game.finalScore?.away} – {game.home.abbr} {game.finalScore?.home}
            </strong>
          ) : null}
          {game.status === 'canceled' ? <strong className="muted">Canceled</strong> : null}
        </div>
      </div>
      <div className="muted small">{oddsSummary(game)}</div>

      {scheduled && scoring ? (
        <div className="score-entry">
          <label className="field">
            <span>{game.away.name} (away)</span>
            <input type="number" min="0" inputMode="numeric" value={scores.away} onChange={(e) => setScores((s) => ({ ...s, away: e.target.value }))} disabled={busy} />
          </label>
          <label className="field">
            <span>{game.home.name} (home)</span>
            <input type="number" min="0" inputMode="numeric" value={scores.home} onChange={(e) => setScores((s) => ({ ...s, home: e.target.value }))} disabled={busy} />
          </label>
          <div className="button-row">
            <button type="button" className="btn btn-primary" onClick={() => review('final')} disabled={busy || scores.home === '' || scores.away === ''}>
              {busy ? 'Checking…' : 'Review payouts'}
            </button>
            <button type="button" className="btn" onClick={() => setScoring(false)} disabled={busy}>
              Back
            </button>
          </div>
        </div>
      ) : null}

      {!scoring ? (
        <div className="button-row">
          {scheduled ? (
            <>
              <button type="button" className="btn" onClick={() => onEdit(game)} disabled={busy}>
                Edit
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setScoring(true)} disabled={busy}>
                Final score
              </button>
              <button type="button" className="btn btn-danger" onClick={() => review('cancel')} disabled={busy}>
                Cancel game
              </button>
            </>
          ) : null}
          {betCount === 0 ? (
            <button type="button" className="btn btn-danger" onClick={remove} disabled={busy}>
              Delete
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="error-text small">{error}</p> : null}

      {pending ? (
        <MoneyConfirmModal
          title={pending.kind === 'final' ? 'Save final score and settle?' : 'Cancel game and void its legs?'}
          walletChanges={pending.preview.walletChanges}
          confirmLabel={pending.kind === 'final' ? 'Save final & settle' : 'Cancel game & settle'}
          danger={pending.kind === 'cancel'}
          busy={busy}
          error={confirmError}
          onConfirm={confirm}
          onCancel={cancelPending}
        >
          <p>
            {pending.kind === 'final' ? (
              <strong>
                Final: {game.away.name} {pending.preview.scores.away} @ {game.home.name} {pending.preview.scores.home}
              </strong>
            ) : (
              <strong>Every leg on {label} becomes void, like a postponed game. Singles get their stake back; parlays drop the leg.</strong>
            )}
          </p>
          <p className="muted small">
            {pending.preview.wouldSettle.length} bet{pending.preview.wouldSettle.length === 1 ? '' : 's'} settle now, paying{' '}
            {formatMoney(pending.preview.totals.payoutCents)} in total. {pending.preview.staysOpen.length} stay open (parlays waiting on other games).
          </p>
          <PreviewBets rows={pending.preview.wouldSettle} />
        </MoneyConfirmModal>
      ) : null}
    </li>
  );
}

export default function AdminCustomGames() {
  const { games, error, loaded, retry } = useCustomGames();
  const nowMs = useNowMs();
  const [editor, setEditor] = useState(null); // null | { key, game | null }
  const [notice, setNotice] = useState('');

  const groups = useMemo(() => {
    const upcoming = [];
    const closed = [];
    const finished = [];
    for (const g of games) {
      if (g.status === 'final' || g.status === 'canceled') finished.push(g);
      else if (g.startMs !== null && g.startMs <= nowMs) closed.push(g);
      else upcoming.push(g);
    }
    upcoming.sort((a, b) => a.startMs - b.startMs);
    closed.sort((a, b) => a.startMs - b.startMs);
    finished.sort((a, b) => b.startMs - a.startMs);
    return { upcoming, closed, finished };
  }, [games, nowMs]);

  const editingGame = editor?.game ?? null;
  const editingLive = editingGame ? games.find((g) => g.id === editingGame.id) ?? editingGame : null;

  function startNew() {
    setNotice('');
    setEditor({ key: `new-${Date.now()}`, game: null });
  }

  function startEdit(game) {
    setNotice('');
    setEditor({ key: `edit-${game.id}-${Date.now()}`, game });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function saved(message) {
    setEditor(null);
    setNotice(message);
  }

  const section = (title, list, group, empty) => (
    <>
      <h3 className="section-title">
        {title} ({list.length})
      </h3>
      {list.length === 0 ? <div className="card muted small">{empty}</div> : null}
      <ul className="custom-game-list">
        {list.map((g) => (
          <GameRow key={g.id} game={g} group={group} onEdit={startEdit} onNotice={setNotice} />
        ))}
      </ul>
    </>
  );

  return (
    <div className="admin-custom-games">
      <div className="card">
        <p className="muted small">
          House games appear on their league's board tab. Betting closes at the start time; move the start later to reopen it. Enter the
          final score (or cancel) to settle every bet on the game.
        </p>
        {!editor ? (
          <button type="button" className="btn btn-primary" onClick={startNew}>
            New custom game
          </button>
        ) : null}
        {notice ? <p className="success-text small">{notice}</p> : null}
      </div>

      {editor ? (
        <CustomGameForm
          key={editor.key}
          initial={editor.game ? formFromGame(editor.game) : emptyForm()}
          gameId={editor.game ? `custom:${editor.game.id}` : null}
          betCount={Number(editingLive?.betCount) || 0}
          onSaved={saved}
          onCancel={() => setEditor(null)}
        />
      ) : null}

      {error ? <ErrorState title="Couldn't load custom games" message={error} onRetry={retry} /> : null}
      {!loaded ? <LoadingState label="Loading custom games…" rows={2} /> : null}
      {loaded && !error ? (
        <>
          {section('Upcoming', groups.upcoming, 'upcoming', 'No upcoming custom games.')}
          {section('Closed — started, no final score', groups.closed, 'closed', 'None waiting for a score.')}
          {section('Finished', groups.finished, 'finished', 'No finished custom games yet.')}
        </>
      ) : null}
    </div>
  );
}
