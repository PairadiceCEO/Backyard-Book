import { LEAGUES } from '../../shared/constants.js';

export default function LeagueTabs({ value, onChange }) {
  return (
    <div className="sub-tabs" role="tablist" aria-label="Leagues">
      {LEAGUES.map((league) => (
        <button
          key={league.id}
          type="button"
          role="tab"
          aria-selected={league.id === value}
          className={league.id === value ? 'sub-tab active' : 'sub-tab'}
          onClick={() => onChange(league.id)}
        >
          {league.label}
        </button>
      ))}
    </div>
  );
}
