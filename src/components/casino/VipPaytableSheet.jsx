// The VIP slot's paytable sheet (0.28.0): every line pay read from shared/casino/vipSlots.js (never retyped), what each pays for
// the current bet on one line, the bonus rules and the proven numbers. The chat drawer's sheet styles; Escape or the backdrop
// closes it; the page behind doesn't scroll while it is open.
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import VipSymbol from './VipSymbol.jsx';
import {
  VIP_BONUS_MAX_SPINS,
  VIP_BONUS_MULT,
  VIP_BONUS_SPINS,
  VIP_MAX_WIN_TIMES,
  VIP_PAYTABLE,
  VIP_STATS,
  VIP_TRIGGER_DICE,
  vipCents,
  vipPaysText,
} from '../../../shared/casino/vipSlots.js';
import { formatMoney } from '../../lib/format.js';

const pct = (x) => `${(x * 100).toFixed(1)}%`;

export default function VipPaytableSheet({ open, onClose, betDollars, hitIds = [] }) {
  const closeRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  }, [open, onClose]);

  if (!open) return null;
  const betCents = Math.max(0, betDollars) * 100;
  return createPortal(
    <>
      <div className="chat-backdrop" role="presentation" onClick={onClose} />
      <section className="chat-drawer paytable-sheet vip-paytable" role="dialog" aria-modal="true" aria-label="VIP paytable">
        <header className="chat-head">
          <h3>VIP paytable</h3>
          <button type="button" className="icon-button" aria-label="Close paytable" onClick={onClose} ref={closeRef}>
            ×
          </button>
        </header>
        <p className="muted small paytable-note">
          Three paylines: the top, middle and bottom rows. Your bet covers all three; each winning line pays its multiple of the bet and
          wins on different lines add up. Amounts are for one line at your {formatMoney(betCents)} bet.
        </p>
        <ul className="paytable-list">
          {VIP_PAYTABLE.map((line) => (
            <li key={line.id} className={hitIds.includes(line.id) ? 'paytable-row hit' : 'paytable-row'} data-line={line.id}>
              <span className="paytable-symbols" aria-hidden="true">
                {line.show.map((id, i) => (
                  <VipSymbol key={i} id={id} small />
                ))}
              </span>
              <span className="paytable-label">{line.label}</span>
              <span className="paytable-pays">
                <span className="paytable-times">{vipPaysText(line.tenths)}</span>
                <strong className="paytable-amount">{formatMoney(vipCents(betCents, line.tenths))}</strong>
              </span>
            </li>
          ))}
        </ul>
        <div className="vip-bonus-rules">
          <h4 className="small-heading">
            <span className="paytable-symbols" aria-hidden="true">
              <VipSymbol id="GD" small />
              <VipSymbol id="GD" small />
              <VipSymbol id="GD" small />
            </span>{' '}
            Golden Dice bonus
          </h4>
          <p className="small">
            {VIP_TRIGGER_DICE} or more Golden Dice anywhere in the window win {VIP_BONUS_SPINS} free spins on the bonus reels (more
            premiums, fewer blanks), and every win in them pays ×{VIP_BONUS_MULT}. {VIP_TRIGGER_DICE} Golden Dice during the bonus add{' '}
            {VIP_BONUS_SPINS} more spins, up to {VIP_BONUS_MAX_SPINS} in all. Golden Dice don't pay on a line. The whole bonus is decided
            with the spin that wins it; a spin never pays more than {VIP_MAX_WIN_TIMES.toLocaleString('en-US')}× the bet.
          </p>
          <p className="muted small">
            Returns {pct(VIP_STATS.totalRtp)} of what is bet over time ({pct(VIP_STATS.baseRtp)} from the lines,{' '}
            {pct(VIP_STATS.bonusRtp)} from the bonus). Something comes back on {pct(VIP_STATS.hitRate)} of spins, 5× the bet or more on{' '}
            {pct(VIP_STATS.bigRate)}; the bonus comes about once every {Math.round(VIP_STATS.triggerEvery)} spins and is worth{' '}
            {Math.round(VIP_STATS.bonusValueTimes)}× the bet on average.
          </p>
        </div>
      </section>
    </>,
    document.body,
  );
}
