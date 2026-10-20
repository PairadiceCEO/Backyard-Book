// A horizontal "wheel" of lines (alternate spreads, totals, player-prop thresholds). One row of chips scrolls
// sideways with CSS scroll-snap; the centered chip is the selected line (highlighted, larger; chips fade toward the
// edges). Under it, exactly two bet buttons for the selected line. ‹ › buttons and the left/right arrow keys step one
// line. A chip whose line has a pick in the slip shows a dot; the pick's button stays highlighted.
//
// items: [{ key, value (number, for "nearest line"), chip (text), aria ("Total 44.5"),
//           sides: [{ id, text ("Over 44.5"), short ("Over"), quote, pick }] }] — already filtered to tradable lines.
// initialKey: the line to start on (the main line); if it isn't offered, the nearest one by value.
//
// Loop safety: the centered chip is found on a debounced scroll end (and the scrollend event where supported), never
// on every scroll frame; listeners and timers are removed on unmount. State is only set from taps, keys, scroll end,
// and once when the selected line disappears (the effect compares before setting). On a refresh the wheel keeps its
// line; if that line is gone it moves to the nearest remaining one and re-centers instantly (no jump).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import OddsButton from './OddsButton.jsx';
import { useBetSlip } from '../context/BetSlipContext.jsx';
import { formatAmerican } from '../lib/format.js';

const SCROLL_END_MS = 120;

function nearestItem(items, value) {
  if (!items.length) return null;
  if (!Number.isFinite(value)) return items[0];
  let best = items[0];
  for (const item of items) if (Math.abs(item.value - value) < Math.abs(best.value - value)) best = item;
  return best;
}

function sideAria(side) {
  return side.quote ? `${side.short} ${formatAmerican(side.quote.american)}` : `${side.short} unavailable`;
}

export default function LineWheel({ items, initialKey = null, initialValue = null, label = 'Lines' }) {
  const slip = useBetSlip();
  const scrollerRef = useRef(null);
  const chipRefs = useRef(new Map());
  const [selectedKey, setSelectedKey] = useState(() => {
    const exact = items.find((i) => i.key === initialKey);
    return (exact ?? nearestItem(items, initialValue))?.key ?? null;
  });
  const lastValueRef = useRef(null);
  const selectedKeyRef = useRef(selectedKey);
  const fromScrollRef = useRef(false);

  // The selected line, or (after a refresh removed it) the nearest remaining one.
  const active = useMemo(
    () => items.find((i) => i.key === selectedKey) ?? nearestItem(items, lastValueRef.current ?? initialValue) ?? null,
    [items, selectedKey, initialValue],
  );
  const activeKey = active?.key ?? null;
  const activeIndex = active ? items.indexOf(active) : -1;

  useEffect(() => {
    if (active) lastValueRef.current = active.value;
  }, [active]);
  useEffect(() => {
    selectedKeyRef.current = activeKey;
    if (activeKey !== null && activeKey !== selectedKey) {
      fromScrollRef.current = true; // re-centered instantly below; no smooth scroll for this one
      setSelectedKey(activeKey);
    }
  }, [activeKey, selectedKey]);

  const centerOn = useCallback((key, smooth) => {
    const scroller = scrollerRef.current;
    const chip = chipRefs.current.get(key);
    if (!scroller || !chip) return;
    const left = chip.offsetLeft - (scroller.clientWidth - chip.offsetWidth) / 2;
    if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
    else scroller.scrollLeft = left;
  }, []);

  // When the set of lines changes (and on mount), center the active chip instantly so nothing jumps.
  const keysSignature = items.map((i) => i.key).join('|');
  useLayoutEffect(() => {
    if (activeKey !== null) centerOn(activeKey, false);
    // keysSignature stands for `items` here on purpose: prices refreshing must not re-center the wheel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysSignature, centerOn]);

  // A tap, an arrow or a key changed the line: glide to it. (A scroll end already put it in the middle.)
  useEffect(() => {
    if (selectedKey === null) return;
    if (fromScrollRef.current) {
      fromScrollRef.current = false;
      return;
    }
    centerOn(selectedKey, true);
  }, [selectedKey, centerOn]);

  // Which chip is in the middle once scrolling stops.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;
    let timer = null;
    const settle = () => {
      clearTimeout(timer);
      timer = null;
      const middle = scroller.getBoundingClientRect().left + scroller.clientWidth / 2;
      let best = null;
      for (const chip of scroller.querySelectorAll('[data-key]')) {
        const r = chip.getBoundingClientRect();
        const d = Math.abs(r.left + r.width / 2 - middle);
        if (!best || d < best.d) best = { key: chip.dataset.key, d };
      }
      if (best && best.key !== selectedKeyRef.current) {
        fromScrollRef.current = true;
        setSelectedKey(best.key);
      }
    };
    const onScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(settle, SCROLL_END_MS);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    scroller.addEventListener('scrollend', settle);
    return () => {
      clearTimeout(timer);
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('scrollend', settle);
    };
  }, []);

  const step = useCallback(
    (delta) => {
      if (activeIndex < 0) return;
      const next = items[Math.min(items.length - 1, Math.max(0, activeIndex + delta))];
      if (next && next.key !== activeKey) setSelectedKey(next.key);
    },
    [items, activeIndex, activeKey],
  );

  const onKeyDown = useCallback(
    (e) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        step(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        step(1);
      }
    },
    [step],
  );

  if (!items.length || !active) return null;

  const fullAria = `${active.aria}, ${active.sides.map(sideAria).join(', ')}`;
  const setChipRef = (key) => (el) => {
    if (el) chipRefs.current.set(key, el);
    else chipRefs.current.delete(key);
  };

  return (
    <div className="line-wheel">
      <div className="wheel-row">
        <button type="button" className="wheel-arrow" aria-label={`Lower ${label}`} onClick={() => step(-1)} disabled={activeIndex <= 0}>
          ‹
        </button>
        <div ref={scrollerRef} className="wheel-track" role="group" aria-label={label} tabIndex={0} onKeyDown={onKeyDown}>
          {items.map((item) => {
            const selected = item.key === activeKey;
            const inSlip = item.sides.some((s) => s.pick && slip.isSelected(s.pick.legId));
            return (
              <button
                key={item.key}
                ref={setChipRef(item.key)}
                type="button"
                tabIndex={-1}
                data-key={item.key}
                className={`wheel-chip${selected ? ' selected' : ''}`}
                aria-pressed={selected}
                aria-label={selected ? fullAria : `${item.aria}${inSlip ? ', in your slip' : ''}`}
                onClick={() => setSelectedKey(item.key)}
              >
                {item.chip}
                {inSlip ? <span className="chip-dot" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
        <button type="button" className="wheel-arrow" aria-label={`Higher ${label}`} onClick={() => step(1)} disabled={activeIndex >= items.length - 1}>
          ›
        </button>
      </div>
      <span className="visually-hidden" aria-live="polite">
        {fullAria}
      </span>
      <div className="wheel-buttons">
        {active.sides.map((side) => (
          <OddsButton
            key={side.id}
            quote={side.quote}
            lineLabel={side.text}
            ariaLabel={side.quote ? `${side.text}, ${formatAmerican(side.quote.american)}` : side.text}
            selected={Boolean(side.pick && slip.isSelected(side.pick.legId))}
            onSelect={side.pick ? () => slip.toggle(side.pick) : null}
          />
        ))}
      </div>
    </div>
  );
}
