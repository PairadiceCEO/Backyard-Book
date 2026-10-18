// My Bets → Finished: a sort menu, a collapsible Filters panel (count badge, Clear all), a summary line for what is
// showing, and the list (50 at a time). Sort and filters are remembered for the session (sessionStorage).
// The bets come in already merged (every finished bet, see useBetHistory); everything here is computed in memory.
//
// Loop safety: the view is read once from storage (lazy useState) and written back in an effect that sets no state;
// the filtered list is a useMemo of (bets, view); the shown count is reset in the change handlers, never in render.

import { useCallback, useEffect, useMemo, useState } from 'react';
import BetCard from './BetCard.jsx';
import { EmptyState } from './StatusViews.jsx';
import { formatMoney } from '../lib/format.js';
import {
  CATEGORY_OPTIONS,
  DATE_OPTIONS,
  DEFAULT_FILTERS,
  MARKET_OPTIONS,
  RESULT_OPTIONS,
  SORT_OPTIONS,
  TIMING_OPTIONS,
  TYPE_OPTIONS,
  activeFilterCount,
  filterBets,
  readSavedView,
  saveView,
  sortBets,
  summarize,
} from '../lib/betFilters.js';

const PAGE = 50;

function Chips({ legend, options, value, onToggle }) {
  return (
    <fieldset className="filter-group">
      <legend>{legend}</legend>
      <div className="chip-row">
        {options.map((o) => (
          <button key={o.id} type="button" className={value.includes(o.id) ? 'chip active' : 'chip'} aria-pressed={value.includes(o.id)} onClick={() => onToggle(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function OneOf({ legend, options, value, onPick }) {
  return (
    <fieldset className="filter-group">
      <legend>{legend}</legend>
      <div className="chip-row">
        {options.map((o) => (
          <button key={o.id} type="button" className={value === o.id ? 'chip active' : 'chip'} aria-pressed={value === o.id} onClick={() => onPick(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function signedMoney(cents) {
  if (cents > 0) return `+${formatMoney(cents)}`;
  if (cents < 0) return `−${formatMoney(-cents)}`;
  return formatMoney(0);
}

export default function FinishedBets({ bets, history }) {
  const [view, setView] = useState(readSavedView);
  const [panelOpen, setPanelOpen] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [nowMs] = useState(() => Date.now()); // "today" / "last 7 days" are measured from when the page opened

  useEffect(() => {
    saveView(view);
  }, [view]);

  const { sort, filters } = view;
  const setFilter = useCallback((name, value) => {
    setView((v) => ({ ...v, filters: { ...v.filters, [name]: value } }));
    setShown(PAGE);
  }, []);
  const toggleIn = useCallback((name, id) => {
    setView((v) => {
      const list = v.filters[name];
      return { ...v, filters: { ...v.filters, [name]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] } };
    });
    setShown(PAGE);
  }, []);
  const setSort = useCallback((value) => {
    setView((v) => ({ ...v, sort: value }));
    setShown(PAGE);
  }, []);
  const clearAll = useCallback(() => {
    setView((v) => ({ ...v, filters: { ...DEFAULT_FILTERS } }));
    setShown(PAGE);
  }, []);

  const visible = useMemo(() => sortBets(filterBets(bets, filters, nowMs), sort), [bets, filters, sort, nowMs]);
  const summary = useMemo(() => summarize(visible), [visible]);
  const active = activeFilterCount(filters);
  const hasPosterBets = useMemo(() => bets.some((b) => b.posterBet === true), [bets]);

  return (
    <div className="finished-bets">
      <div className="finished-toolbar">
        <label className="sort-field">
          <span className="muted small">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort finished bets">
            {SORT_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={active ? 'btn filters-toggle active' : 'btn filters-toggle'} aria-expanded={panelOpen} aria-controls="finished-filters" onClick={() => setPanelOpen((o) => !o)}>
          Filters
          {active ? (
            <span className="nav-badge filter-badge" aria-label={`${active} active`}>
              {active}
            </span>
          ) : null}
          <span aria-hidden="true">{panelOpen ? ' ▴' : ' ▾'}</span>
        </button>
      </div>

      {panelOpen ? (
        <div id="finished-filters" className="card filters-panel">
          <Chips legend="Result" options={RESULT_OPTIONS} value={filters.results} onToggle={(id) => toggleIn('results', id)} />
          <fieldset className="filter-group">
            <legend>Date placed</legend>
            <select value={filters.date} onChange={(e) => setFilter('date', e.target.value)} aria-label="Date placed">
              {DATE_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            {filters.date === 'custom' ? (
              <div className="date-range">
                <label>
                  <span className="muted small">From</span>
                  <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilter('from', e.target.value)} />
                </label>
                <label>
                  <span className="muted small">To</span>
                  <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter('to', e.target.value)} />
                </label>
                <span className="muted small">Central Time, both days included</span>
              </div>
            ) : null}
          </fieldset>
          <Chips legend="Category" options={CATEGORY_OPTIONS} value={filters.categories} onToggle={(id) => toggleIn('categories', id)} />
          <OneOf legend="Bet type" options={TYPE_OPTIONS} value={filters.type} onPick={(id) => setFilter('type', id)} />
          <Chips legend="Market" options={MARKET_OPTIONS} value={filters.markets} onToggle={(id) => toggleIn('markets', id)} />
          <OneOf legend="Placed" options={TIMING_OPTIONS} value={filters.timing} onPick={(id) => setFilter('timing', id)} />
          <fieldset className="filter-group">
            <legend>Stake ($)</legend>
            <div className="stake-range">
              <input type="text" inputMode="decimal" placeholder="Min" aria-label="Minimum stake in dollars" value={filters.stakeMin} onChange={(e) => setFilter('stakeMin', e.target.value)} />
              <span className="muted">to</span>
              <input type="text" inputMode="decimal" placeholder="Max" aria-label="Maximum stake in dollars" value={filters.stakeMax} onChange={(e) => setFilter('stakeMax', e.target.value)} />
            </div>
          </fieldset>
          <fieldset className="filter-group">
            <legend>Search</legend>
            <input type="search" placeholder="Team, game, Challenge or coin" aria-label="Search your bets" value={filters.text} onChange={(e) => setFilter('text', e.target.value)} />
          </fieldset>
          {hasPosterBets ? (
            <label className="filter-check">
              <input type="checkbox" checked={filters.posterOnly} onChange={(e) => setFilter('posterOnly', e.target.checked)} />
              Poster&apos;s bets only
            </label>
          ) : null}
          <div className="filters-actions">
            <button type="button" className="btn" onClick={clearAll} disabled={!active}>
              Clear all
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setPanelOpen(false)}>
              Done
            </button>
          </div>
        </div>
      ) : null}

      <p className="finished-summary small" aria-live="polite">
        <span>
          {summary.count} bet{summary.count === 1 ? '' : 's'}
        </span>
        <span>Staked {formatMoney(summary.stakedCents)}</span>
        <span>Returned {formatMoney(summary.returnedCents)}</span>
        <span className={summary.netCents > 0 ? 'net-up' : summary.netCents < 0 ? 'net-down' : ''}>Net {signedMoney(summary.netCents)}</span>
        <span>Win rate {summary.winRate === null ? '—' : `${Math.round(summary.winRate * 100)}%`}</span>
      </p>
      {history.loading ? <p className="muted small">Loading your older bets… totals update as they arrive.</p> : null}
      {history.error ? (
        <p className="warning-text small">
          Couldn&apos;t load your older bets, so this list may be missing some.{' '}
          <button type="button" className="btn btn-ghost small" onClick={history.retry}>
            Try again
          </button>
        </p>
      ) : null}

      {visible.length === 0 && bets.length > 0 ? (
        <EmptyState title="No bets match these filters">
          <button type="button" className="btn btn-ghost" onClick={clearAll}>
            Clear all filters
          </button>
        </EmptyState>
      ) : null}
      {visible.slice(0, shown).map((bet) => (
        <BetCard key={bet.id} bet={bet} />
      ))}
      {visible.length > shown ? (
        <button type="button" className="btn show-more" onClick={() => setShown((n) => n + PAGE)}>
          Show {Math.min(PAGE, visible.length - shown)} more ({visible.length - shown} left)
        </button>
      ) : null}
    </div>
  );
}
