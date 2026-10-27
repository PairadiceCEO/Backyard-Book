// Admin player management: live list, create form, and one inline editor at a time.

import { useCallback, useEffect, useState } from 'react';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { db } from '../../firebase.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { adminAction } from '../../lib/api.js';
import { formatMoney, formatWinRate, parseDollarsToCents } from '../../lib/format.js';
import MoneyConfirmModal from './MoneyConfirmModal.jsx';
import { ErrorState, LoadingState } from '../../components/StatusViews.jsx';
import { AgentBadge, AgentLabel } from '../../components/AgentBadge.jsx';
import { AGENT_LABEL_MAX, AGENT_PROVIDERS, AGENT_PROVIDER_NAMES } from '../../../shared/agents.js';
import {
  DISPLAY_NAME_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_RULES,
  isValidUsername,
  normalizeUsername,
} from '../../../shared/constants.js';

function CreatePlayerForm({ onDone }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [startingBalance, setStartingBalance] = useState('100');
  const [isAgent, setIsAgent] = useState(false);
  const [provider, setProvider] = useState(AGENT_PROVIDERS[0]);
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event) {
    event.preventDefault();
    const cleanUsername = normalizeUsername(username);
    if (!isValidUsername(cleanUsername)) return setError(`Username must be ${USERNAME_RULES}`);
    if (password.length < PASSWORD_MIN_LENGTH) {
      return setError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
    }
    const startingBalanceCents = startingBalance.trim() === '' ? 0 : parseDollarsToCents(startingBalance);
    if (startingBalanceCents === null) return setError('Starting balance must be a dollar amount like 100 or 25.50.');
    if (isAgent && !label.trim()) return setError('Give the AI agent a model label, e.g. "Claude Sonnet".');

    setSubmitting(true);
    setError('');
    try {
      await adminAction('createUser', {
        username: cleanUsername,
        displayName: displayName.trim(),
        password,
        startingBalanceCents,
        ...(isAgent ? { agent: { provider, label: label.trim() } } : {}),
      });
      setUsername('');
      setDisplayName('');
      setPassword('');
      setStartingBalance('100');
      setIsAgent(false);
      setLabel('');
      onDone(isAgent ? `Created the AI agent "${cleanUsername}". Put its username and password in the GitHub secrets.` : `Created "${cleanUsername}". Share the username and password with them.`);
    } catch (err) {
      setError(err.message || 'Could not create the player.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form-grid" onSubmit={handleSubmit} noValidate>
      <h3>Add a player</h3>
      <label className="field">
        <span>Username</span>
        <input
          type="text"
          autoCapitalize="none"
          spellCheck="false"
          autoComplete="off"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={submitting}
        />
        <small className="muted">{USERNAME_RULES}</small>
      </label>
      <label className="field">
        <span>Display name (optional)</span>
        <input
          type="text"
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          disabled={submitting}
        />
      </label>
      <label className="field">
        <span>Password</span>
        <input
          type="text"
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={submitting}
        />
        <small className="muted">At least {PASSWORD_MIN_LENGTH} characters. Shown so you can copy it to them.</small>
      </label>
      <label className="field">
        <span>Starting balance ($)</span>
        <input
          type="text"
          inputMode="decimal"
          value={startingBalance}
          onChange={(e) => setStartingBalance(e.target.value)}
          disabled={submitting}
        />
      </label>
      <label className="field checkbox-field">
        <input type="checkbox" checked={isAgent} onChange={(e) => setIsAgent(e.target.checked)} disabled={submitting} />
        <span>AI agent (bets on its own from GitHub Actions, house rules apply)</span>
      </label>
      {isAgent ? (
        <>
          <label className="field">
            <span>Provider</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={submitting}>
              {AGENT_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {AGENT_PROVIDER_NAMES[p]} ({p})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Model label</span>
            <input type="text" maxLength={AGENT_LABEL_MAX} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Claude Sonnet" disabled={submitting} />
            <small className="muted">Shown under its name on the leaderboard.</small>
          </label>
        </>
      ) : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      <button type="submit" className="btn btn-primary" disabled={submitting}>
        {submitting ? 'Creating…' : isAgent ? 'Create AI agent' : 'Create player'}
      </button>
    </form>
  );
}

// Each editor is mounted with a key per player + kind, so its local state starts fresh
// without any effect copying props into state.
function EditNameForm({ player, onDone, onCancel }) {
  const [displayName, setDisplayName] = useState(player.displayName || '');
  const [isAgent, setIsAgent] = useState(Boolean(player.agent?.provider));
  const [provider, setProvider] = useState(player.agent?.provider ?? AGENT_PROVIDERS[0]);
  const [label, setLabel] = useState(player.agent?.label ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const canBeAgent = player.role !== 'admin';

  async function handleSubmit(event) {
    event.preventDefault();
    if (isAgent && !label.trim()) return setError('Give the AI agent a model label.');
    setSaving(true);
    setError('');
    try {
      await adminAction('updateUser', { uid: player.id, displayName: displayName.trim(), ...(canBeAgent ? { agent: isAgent ? { provider, label: label.trim() } : null } : {}) });
      onDone(`Updated ${player.username}.`);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <form className="editor" onSubmit={handleSubmit} noValidate>
      <label className="field">
        <span>Display name</span>
        <input
          type="text"
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          disabled={saving}
        />
      </label>
      {canBeAgent ? (
        <label className="field checkbox-field">
          <input type="checkbox" checked={isAgent} onChange={(e) => setIsAgent(e.target.checked)} disabled={saving} />
          <span>AI agent</span>
        </label>
      ) : null}
      {canBeAgent && isAgent ? (
        <>
          <label className="field">
            <span>Provider</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={saving}>
              {AGENT_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {AGENT_PROVIDER_NAMES[p]} ({p})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Model label</span>
            <input type="text" maxLength={AGENT_LABEL_MAX} value={label} onChange={(e) => setLabel(e.target.value)} disabled={saving} />
          </label>
        </>
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}
      <div className="row-actions">
        <button type="submit" className="btn btn-primary small" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn small" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ResetPasswordForm({ player, onDone, onCancel }) {
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event) {
    event.preventDefault();
    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      setError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await adminAction('resetPassword', { uid: player.id, newPassword });
      onDone(`Reset ${player.username}'s password. They've been signed out everywhere.`);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <form className="editor" onSubmit={handleSubmit} noValidate>
      <label className="field">
        <span>New password</span>
        <input
          type="text"
          autoComplete="off"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          disabled={saving}
        />
        <small className="muted">At least {PASSWORD_MIN_LENGTH} characters.</small>
      </label>
      {error ? <p className="error-text">{error}</p> : null}
      <div className="row-actions">
        <button type="submit" className="btn btn-primary small" disabled={saving}>
          {saving ? 'Saving…' : 'Set password'}
        </button>
        <button type="button" className="btn small" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function AdjustWalletForm({ player, onDone, onCancel }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [pendingCents, setPendingCents] = useState(null); // amount waiting for confirmation

  // Step 1: check the amount and show the wallet change for confirmation.
  function handleSubmit(event) {
    event.preventDefault();
    const deltaCents = parseDollarsToCents(amount, { allowNegative: true });
    if (deltaCents === null || deltaCents === 0) {
      setError('Enter an amount like 50 to add or -20 to remove.');
      return;
    }
    setError('');
    setPendingCents(deltaCents);
  }

  // Step 2: apply it.
  async function apply() {
    setSaving(true);
    setError('');
    try {
      const result = await adminAction('adjustWallet', { uid: player.id, deltaCents: pendingCents, note: note.trim() });
      setPendingCents(null);
      onDone(`${player.username}'s wallet is now ${formatMoney(result.balanceCents)}.`);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  const closeConfirm = useCallback(() => setPendingCents(null), []);
  const before = Number(player.balanceCents) || 0;

  return (
    <form className="editor" onSubmit={handleSubmit} noValidate>
      <p className="muted small">Current balance: {formatMoney(player.balanceCents)}</p>
      <label className="field">
        <span>Amount ($, use a minus sign to remove)</span>
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={saving}
        />
      </label>
      <label className="field">
        <span>Note (optional)</span>
        <input type="text" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} disabled={saving} />
      </label>
      {error && pendingCents === null ? <p className="error-text">{error}</p> : null}
      <div className="row-actions">
        <button type="submit" className="btn btn-primary small" disabled={saving}>
          Review
        </button>
        <button type="button" className="btn small" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
      {pendingCents !== null ? (
        <MoneyConfirmModal
          title="Adjust wallet?"
          walletChanges={[{ uid: player.id, username: player.username, deltaCents: pendingCents, balanceBeforeCents: before, balanceAfterCents: before + pendingCents }]}
          confirmLabel="Apply"
          danger={pendingCents < 0}
          busy={saving}
          error={error}
          onConfirm={apply}
          onCancel={closeConfirm}
        >
          <p>{note.trim() ? `Note: ${note.trim()}` : 'No note.'}</p>
        </MoneyConfirmModal>
      ) : null}
    </form>
  );
}

function PlayerRow({ player, isSelf, editingKind, onEdit, onDone, onCancel, onToggleDisabled, toggling }) {
  return (
    <li className={player.disabled ? 'player-row disabled' : 'player-row'}>
      <div className="player-summary">
        <div>
          <strong>{player.displayName || player.username}</strong>{' '}
          <span className="muted small">@{player.username}</span>
          {player.agent ? (
            <>
              {' '}
              <AgentLabel agent={player.agent} />
            </>
          ) : null}
          {player.role === 'admin' ? <span className="badge">admin</span> : null}
          <AgentBadge agent={player.agent} />
          {player.disabled ? <span className="badge badge-danger">disabled</span> : null}
        </div>
        <div className="player-stats">
          <span className="wallet-amount">{formatMoney(player.balanceCents)}</span>
          <span className="muted small">Win rate {formatWinRate(player.stats)}</span>
        </div>
      </div>
      <div className="row-actions">
        <button type="button" className="btn small" onClick={() => onEdit(player.id, 'name')}>
          Edit
        </button>
        <button type="button" className="btn small" onClick={() => onEdit(player.id, 'wallet')}>
          Adjust wallet
        </button>
        <button type="button" className="btn small" onClick={() => onEdit(player.id, 'password')}>
          Reset password
        </button>
        {!isSelf ? (
          <button
            type="button"
            className={player.disabled ? 'btn small' : 'btn small btn-danger'}
            onClick={() => onToggleDisabled(player)}
            disabled={toggling}
          >
            {toggling ? 'Saving…' : player.disabled ? 'Enable' : 'Disable'}
          </button>
        ) : null}
      </div>
      {editingKind === 'name' ? (
        <EditNameForm key={`${player.id}-name`} player={player} onDone={onDone} onCancel={onCancel} />
      ) : null}
      {editingKind === 'wallet' ? (
        <AdjustWalletForm key={`${player.id}-wallet`} player={player} onDone={onDone} onCancel={onCancel} />
      ) : null}
      {editingKind === 'password' ? (
        <ResetPasswordForm key={`${player.id}-password`} player={player} onDone={onDone} onCancel={onCancel} />
      ) : null}
    </li>
  );
}

export default function AdminUsers() {
  const { authUser } = useAuth();
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [editing, setEditing] = useState(null); // { uid, kind } | null
  const [togglingUid, setTogglingUid] = useState(null);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [attempt, setAttempt] = useState(0); // bumped by Try again to re-subscribe after an error

  // Live player list; subscribes once (and again on retry) and unsubscribes on unmount.
  useEffect(() => {
    if (!db) return undefined;
    const q = query(collection(db, 'users'), orderBy('username'));
    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        setPlayers(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setListError('');
        setLoading(false);
      },
      (err) => {
        setListError(err.message || 'Could not load players.');
        setLoading(false);
      },
    );
    return unsubscribe;
  }, [attempt]);

  function retryList() {
    setListError('');
    setLoading(true);
    setAttempt((n) => n + 1);
  }

  function handleDone(text) {
    setEditing(null);
    setActionError('');
    setNotice(text);
  }

  function handleEdit(uid, kind) {
    setNotice('');
    setActionError('');
    setEditing((current) => (current && current.uid === uid && current.kind === kind ? null : { uid, kind }));
  }

  async function handleToggleDisabled(player) {
    const disabling = !player.disabled;
    if (disabling && !window.confirm(`Disable ${player.username}? They'll be signed out and can't log in.`)) return;
    setTogglingUid(player.id);
    setNotice('');
    setActionError('');
    try {
      await adminAction('setDisabled', { uid: player.id, disabled: disabling });
      setNotice(`${player.username} is now ${disabling ? 'disabled' : 'enabled'}.`);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setTogglingUid(null);
    }
  }

  const myUid = authUser ? authUser.uid : null;

  return (
    <div className="page">
      <CreatePlayerForm onDone={handleDone} />

      {notice ? <p className="success-text" role="status">{notice}</p> : null}
      {actionError ? <p className="error-text" role="alert">{actionError}</p> : null}

      <div className="card">
        <h3>Players</h3>
        {loading ? <LoadingState label="Loading players…" rows={2} /> : null}
        {!loading && listError ? <ErrorState title="Couldn't load players" message={listError} onRetry={retryList} /> : null}
        {!loading && !listError ? (
          <ul className="player-list">
            {players.map((player) => (
              <PlayerRow
                key={player.id}
                player={player}
                isSelf={player.id === myUid}
                editingKind={editing && editing.uid === player.id ? editing.kind : null}
                onEdit={handleEdit}
                onDone={handleDone}
                onCancel={() => setEditing(null)}
                onToggleDisabled={handleToggleDisabled}
                toggling={togglingUid === player.id}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
