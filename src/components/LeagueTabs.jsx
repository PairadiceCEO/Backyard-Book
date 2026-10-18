import { LEAGUES } from '../../shared/constants.js';

// The Live tab (every game in progress), the league tabs, the Crypto tab (Kalshi crypto markets), then the Custom
// tab (custom games, Battles and Challenges). customBadge: a count shown on Custom.
export const LIVE_TAB = { id: 'live', label: 'Live' };
export const CRYPTO_TAB = { id: 'crypto', label: 'Crypto' };
export const CUSTOM_TAB = { id: 'custom', label: 'Custom' };
export const BOARD_TABS = [LIVE_TAB, ...LEAGUES, CRYPTO_TAB, CUSTOM_TAB];

export default function LeagueTabs({ value, onChange, customBadge = 0 }) {
  return (
    <div className="sub-tabs league-tabs" role="tablist" aria-label="Leagues">
      {BOARD_TABS.map((league) => (
        <button
          key={league.id}
          type="button"
          role="tab"
          aria-selected={league.id === value}
          className={league.id === value ? 'sub-tab active' : 'sub-tab'}
          onClick={() => onChange(league.id)}
        >
          {league.id === LIVE_TAB.id ? <span className="live-dot" aria-hidden="true" /> : null}
          {league.label}
          {league.id === CUSTOM_TAB.id && customBadge > 0 ? (
            <span className="nav-badge" aria-label={`${customBadge} waiting for you`}>
              {customBadge}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
