// Top bar (brand, wallet, sign out) plus the main tabs: across the top on wide screens,
// as a thumb-friendly bottom tab bar with icons on phones (CSS decides which one shows).

import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useWalletDisplay } from '../context/WalletDisplayContext.jsx';
import { useBattles } from '../context/BattlesContext.jsx';
import { formatMoney } from '../lib/format.js';
import { APP_NAME } from '../../shared/constants.js';

const ICONS = {
  book: (
    <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 6v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-6V7Zm9-2v14" />
  ),
  casino: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <circle cx="9" cy="9" r="1.2" fill="currentColor" />
      <circle cx="15" cy="15" r="1.2" fill="currentColor" />
      <circle cx="15" cy="9" r="1.2" fill="currentColor" />
      <circle cx="9" cy="15" r="1.2" fill="currentColor" />
    </>
  ),
  bets: <path d="M7 3h10a1 1 0 0 1 1 1v17l-3-2-3 2-3-2-3 2V4a1 1 0 0 1 1-1Zm2 5h6M9 12h6M9 16h3" />,
  leaders: <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Zm0 2H4v2a3 3 0 0 0 3 3m10-5h3v2a3 3 0 0 1-3 3" />,
  shop: <path d="M12 7v10M7 12h10M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z" />,
  admin: (
    <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.5 7.5 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-4l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z" />
  ),
};

const TABS = [
  { to: '/sportsbook', label: 'Sportsbook', short: 'Book', icon: 'book' },
  { to: '/casino', label: 'Casino', short: 'Casino', icon: 'casino' },
  { to: '/my-bets', label: 'My Bets', short: 'My Bets', icon: 'bets' },
  { to: '/leaderboard', label: 'Leaderboard', short: 'Leaders', icon: 'leaders' },
  { to: '/shop', label: 'Shop', short: 'Shop', icon: 'shop' },
];
const ADMIN_TAB = { to: '/admin', label: 'Admin', short: 'Admin', icon: 'admin' };

function tabClass({ isActive }) {
  return isActive ? 'nav-tab active' : 'nav-tab';
}

function bottomClass({ isActive }) {
  return isActive ? 'bottom-tab active' : 'bottom-tab';
}

export default function NavBar() {
  const { profile, isAdmin, signOut } = useAuth();
  const { displayCents } = useWalletDisplay();
  const shownCents = displayCents(Number(profile?.balanceCents) || 0);
  const tabs = isAdmin ? [...TABS, ADMIN_TAB] : TABS;
  // Battle invites (and payout changes) waiting for me: a badge on the Sportsbook tab.
  const { needsMeCount } = useBattles();
  const badgeFor = (tab) =>
    tab.to === '/sportsbook' && needsMeCount > 0 ? (
      <span className="nav-badge" aria-label={`${needsMeCount} Battle${needsMeCount === 1 ? '' : 's'} waiting for you`}>
        {needsMeCount}
      </span>
    ) : null;

  return (
    <>
      <header className="navbar">
        <div className="navbar-top">
          <span className="brand">{APP_NAME}</span>
          <div className="navbar-account">
            <span className="wallet" title="Wallet balance">
              {formatMoney(shownCents)}
            </span>
            <span className="muted small account-name">{profile?.displayName || profile?.username}</span>
            <button type="button" className="btn btn-ghost small" onClick={() => signOut()}>
              Sign out
            </button>
          </div>
        </div>
        <nav className="nav-tabs" aria-label="Main">
          {tabs.map((tab) => (
            <NavLink key={tab.to} to={tab.to} className={tabClass}>
              {tab.label}
              {badgeFor(tab)}
            </NavLink>
          ))}
        </nav>
      </header>

      <nav className="bottom-nav" aria-label="Main">
        {tabs.map((tab) => (
          <NavLink key={tab.to} to={tab.to} className={bottomClass}>
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {ICONS[tab.icon]}
            </svg>
            <span>{tab.short}</span>
            {badgeFor(tab)}
          </NavLink>
        ))}
      </nav>
    </>
  );
}
