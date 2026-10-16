import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { formatMoney } from '../lib/format.js';
import { APP_NAME } from '../../shared/constants.js';

const TABS = [
  { to: '/sportsbook', label: 'Sportsbook' },
  { to: '/my-bets', label: 'My Bets' },
  { to: '/leaderboard', label: 'Leaderboard' },
  { to: '/shop', label: 'Shop' },
];

function tabClass({ isActive }) {
  return isActive ? 'nav-tab active' : 'nav-tab';
}

export default function NavBar() {
  const { profile, isAdmin, signOut } = useAuth();

  return (
    <header className="navbar">
      <div className="navbar-top">
        <span className="brand">{APP_NAME}</span>
        <div className="navbar-account">
          <span className="wallet" title="Wallet balance">
            {formatMoney(profile?.balanceCents ?? 0)}
          </span>
          <span className="muted small">{profile?.displayName || profile?.username}</span>
          <button type="button" className="btn btn-ghost small" onClick={() => signOut()}>
            Sign out
          </button>
        </div>
      </div>
      <nav className="nav-tabs" aria-label="Main">
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} className={tabClass}>
            {tab.label}
          </NavLink>
        ))}
        {isAdmin ? (
          <NavLink to="/admin" className={tabClass}>
            Admin
          </NavLink>
        ) : null}
      </nav>
    </header>
  );
}
