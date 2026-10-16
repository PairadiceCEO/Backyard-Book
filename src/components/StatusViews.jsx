// Shared loading, error and empty states so every page looks and behaves the same.

import { Component, useEffect, useState } from 'react';

export function LoadingState({ label = 'Loading…', rows = 2 }) {
  return (
    <div className="card loading-state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className="muted">{label}</span>
      <div className="skeleton-rows" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <span key={i} className="skeleton-row" />
        ))}
      </div>
    </div>
  );
}

// Friendly wording for errors that are common on phones.
export function friendlyError(message) {
  const text = String(message || '');
  if (/network|failed to fetch|reach the server|offline/i.test(text)) return "Couldn't reach Backyard Book. Check your connection.";
  if (/index/i.test(text)) return 'This list needs a database index that is still being built. Try again in a minute.';
  if (/permission|insufficient/i.test(text)) return "You don't have access to this. Try signing out and back in.";
  return text || 'Something went wrong.';
}

export function ErrorState({ title = "Couldn't load this", message, onRetry = null, retrying = false, children = null }) {
  return (
    <div className="card error-state" role="alert">
      <strong>{title}</strong>
      <p className="muted">{friendlyError(message)}</p>
      {children}
      {onRetry ? (
        <button type="button" className="btn btn-primary" onClick={onRetry} disabled={retrying}>
          {retrying ? 'Trying again…' : 'Try again'}
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ icon = null, title, children = null, action = null }) {
  return (
    <div className="card empty-state">
      {icon ? (
        <div className="empty-icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <strong>{title}</strong>
      {children ? <p className="muted">{children}</p> : null}
      {action}
    </div>
  );
}

// True while the browser reports a connection. Listens to online/offline events; sets state only on change.
export function useOnlineStatus() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

export function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <div className="offline-banner" role="status">
      You're offline. Prices and bets will update when you're back online.
    </div>
  );
}

// Catches a crash while drawing a page and shows a way out instead of a blank screen.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Page crashed:', error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    // Navigating to another page clears the error.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card error-state" role="alert">
        <strong>Something went wrong on this page.</strong>
        <p className="muted">Reloading usually fixes it. Your bets and wallet are safe on the server.</p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
