import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import FullPageMessage from '../components/FullPageMessage.jsx';
import { APP_NAME, normalizeUsername } from '../../shared/constants.js';

function friendlyAuthError(err) {
  switch (err?.code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-email':
      return 'Wrong username or password.';
    case 'auth/user-disabled':
      return 'This account has been disabled by the admin.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes and try again.';
    case 'auth/network-request-failed':
      return 'Could not reach the server. Check your connection.';
    default:
      return err?.message || 'Sign-in failed. Try again.';
  }
}

export default function LoginPage() {
  const { authReady, authUser, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const returnTo = typeof location.state?.from === 'string' ? location.state.from : '/sportsbook';

  if (!authReady) {
    return <FullPageMessage>Loading…</FullPageMessage>;
  }

  if (authUser) {
    return <Navigate to={returnTo} replace />;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const cleanUsername = normalizeUsername(username);
    if (!cleanUsername || !password) {
      setError('Enter your username and password.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await signIn(cleanUsername, password);
      navigate(returnTo, { replace: true });
    } catch (err) {
      setError(friendlyAuthError(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="center-page">
      <form className="card narrow" onSubmit={handleSubmit} noValidate>
        <h1 className="card-title">{APP_NAME}</h1>
        <p className="muted">Sign in to place your bets.</p>

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
        </label>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
          />
        </label>

        {error ? <p className="error-text" role="alert">{error}</p> : null}

        <button type="submit" className="btn btn-primary full" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="muted small center">
          First time setting up the site? <Link to="/setup">Go to setup</Link>
        </p>
      </form>
    </div>
  );
}
