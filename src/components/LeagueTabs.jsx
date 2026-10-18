import { LEAGUES } from '../../shared/constants.js';

// League tabs plus the Custom tab (custom games and Battles). badge: a count shown on Custom.
export const CUSTOM_TAB = { id: 'custom', label: 'Custom' };

export default function LeagueTabs({ value, onChange, customBadge = 0 }) {
  return (
    <div className="sub-tabs league-tabs" role="tablist" aria-label="Leagues">
      {[...LEAGUES, CUSTOM_TAB].map((league) => (
        <button
          key={league.id}
          type="button"
          role="tab"
          aria-selected={league.id === value}
          className={league.id === value ? 'sub-tab active' : 'sub-tab'}
          onClick={() => onChange(league.id)}
        >
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
