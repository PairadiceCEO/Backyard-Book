import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import FullPageMessage from './FullPageMessage.jsx';
import { friendlyError } from './StatusViews.jsx';

export default function RequireAuth({ children }) {
  const { authReady, authUser, profileLoaded, profile, profileError, signOut } = useAuth();
  const location = useLocation();

  if (!authReady) {
    return <FullPageMessage>Loading…</FullPageMessage>;
  }

  if (!authUser) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (!profileLoaded) {
    return <FullPageMessage>Loading your account…</FullPageMessage>;
  }

  const signOutButton = (
    <button type="button" className="btn" onClick={() => signOut()}>
      Sign out
    </button>
  );

  if (profileError) {
    return (
      <FullPageMessage
        title="Couldn't load your account"
        actions={
          <>
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
              Try again
            </button>
            {signOutButton}
          </>
        }
      >
        {friendlyError(profileError)}
      </FullPageMessage>
    );
  }

  if (!profile) {
    return (
      <FullPageMessage title="No player profile" actions={signOutButton}>
        This login has no Pairadice Casino profile. Ask the admin to create your account.
      </FullPageMessage>
    );
  }

  if (profile.disabled) {
    return (
      <FullPageMessage title="Account disabled" actions={signOutButton}>
        This account has been disabled by the admin.
      </FullPageMessage>
    );
  }

  return children;
}
