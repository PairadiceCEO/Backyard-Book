// One-time page that creates the admin account. Refuses once setup is complete.

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { adminAction } from '../lib/api.js';
import {
  DISPLAY_NAME_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_RULES,
  isValidUsername,
  normalizeUsername,
} from '../../shared/constants.js';

export default function SetupPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();

  const [status, setStatus] = useState('checking'); // checking | open | done | error
  const [statusError, setStatusError] = useState('');

  const [setupSecret, setSetupSecret] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Ask the server once whether setup has already happened.
  useEffect(() => {
    let cancelled = false;
    adminAction('setupStatus', {}, { requireAuth: false })
      .then((result) => {
        if (!cancelled) setStatus(result?.done ? 'done' : 'open');
      })
      .catch((err) => {
        if (!cancelled) {
          setStatusError(err.message);
          setStatus('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    const cleanUsername = normalizeUsername(username);

    if (!setupSecret) return setError('Enter the setup secret you saved in Vercel.');
    if (!isValidUsername(cleanUsername)) return setError(`Username must be ${USERNAME_RULES}`);
    if (password.length < PASSWORD_MIN_LENGTH) {
      return setError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
    }
    if (password !== confirmPassword) return setError('The two passwords do not match.');

    setSubmitting(true);
    setError('');
    try {
      await adminAction(
        'bootstrap',
        {
          setupSecret,
          username: cleanUsername,
          displayName: displayName.trim(),
          password,
        },
        { requireAuth: false },
      );
      await signIn(cleanUsername, password);
      navigate('/sportsbook', { replace: true });
    } catch (err) {
      if (err.code === 'ALREADY_SET_UP') setStatus('done');
      setError(err.message || 'Setup failed.');
      setSubmitting(false);
    }
  }

  if (status === 'checking') {
    return (
      <div className="center-page">
        <div className="card narrow muted">Checking setup status…</div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="center-page">
        <div className="card narrow">
          <h1 className="card-title">Setup check failed</h1>
          <p className="error-text">{statusError}</p>
          <p className="muted small">
            Usually this means a Firebase variable is missing in Vercel or you haven't redeployed since adding them.
          </p>
        </div>
      </div>
    );
  }

  if (status === 'done') {
    return (
      <div className="center-page">
        <div className="card narrow">
          <h1 className="card-title">Setup is complete</h1>
          <p className="muted">The admin account already exists, so this page is locked.</p>
          {error ? <p className="error-text">{error}</p> : null}
          <Link to="/login" className="btn btn-primary full">
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="center-page">
      <form className="card narrow" onSubmit={handleSubmit} noValidate>
        <h1 className="card-title">Create the admin account</h1>
        <p className="muted small">This works once. After it succeeds, this page locks itself.</p>

        <label className="field">
          <span>Setup secret</span>
          <input
            type="password"
            autoComplete="off"
            value={setupSecret}
            onChange={(e) => setSetupSecret(e.target.value)}
            disabled={submitting}
          />
          <small className="muted">The SETUP_SECRET value you entered in Vercel.</small>
        </label>

        <label className="field">
          <span>Username</span>
          <input
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck="false"
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
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
          />
          <small className="muted">At least {PASSWORD_MIN_LENGTH} characters.</small>
        </label>

        <label className="field">
          <span>Confirm password</span>
          <input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={submitting}
          />
        </label>

        {error ? <p className="error-text" role="alert">{error}</p> : null}

        <button type="submit" className="btn btn-primary full" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create admin account'}
        </button>
      </form>
    </div>
  );
}
