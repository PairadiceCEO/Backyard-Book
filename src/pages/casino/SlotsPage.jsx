// 7s Slots. The server decides every spin (debit, crypto.randomInt reel stops, credit) before any
// animation; the reels then stop one by one on the result. While they spin, the nav wallet is held at
// "balance − bet" so the live balance can't give the result away early.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Reel from '../../components/casino/Reel.jsx';
import SlotSymbol from '../../components/casino/SlotSymbol.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useWalletDisplay } from '../../context/WalletDisplayContext.jsx';
import { spinSlots } from '../../lib/casino.js';
import { formatMoney } from '../../lib/format.js';
import { friendlyError } from '../../components/StatusViews.jsx';
import { PAYTABLE } from '../../../shared/casino/slotMachine.js';
import { CASINO_MAX_BET_DOLLARS, CASINO_MIN_BET_DOLLARS } from '../../../shared/casino/constants.js';

const BET_STORAGE_KEY = 'backyardbook.slotBet';
const QUICK_BETS = [1, 2, 5, 10];
const MIN_SPIN_MS = 900; // reels spin at least this long, even if the server answers sooner
const REEL_GAP_MS = 350; // then stop one after another
const START_STOPS = [5, 13, 22];

function readSavedBet() {
  try {
    const saved = Number(window.sessionStorage.getItem(BET_STORAGE_KEY));
    if (Number.isInteger(saved) && saved >= CASINO_MIN_BET_DOLLARS && saved <= CASINO_MAX_BET_DOLLARS) return saved;
  } catch {
    // Storage can be blocked; fall back to $1.
  }
  return CASINO_MIN_BET_DOLLARS;
}

export default function SlotsPage() {
  const { profile } = useAuth();
  const { setHeldCents } = useWalletDisplay();
  const balanceCents = Number(profile?.balanceCents) || 0;

  const [bet, setBet] = useState(readSavedBet);
  const [stops, setStops] = useState(START_STOPS);
  const [stoppedReels, setStoppedReels] = useState(3); // reels 0..stoppedReels-1 are still; the rest spin
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState([]);

  const timersRef = useRef([]);
  const mountedRef = useRef(true);

  // On leaving the page: stop pending reel timers and give the nav its real balance back.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      setHeldCents(null);
    };
  }, [setHeldCents]);

  const chooseBet = useCallback((dollars) => {
    const next = Math.min(CASINO_MAX_BET_DOLLARS, Math.max(CASINO_MIN_BET_DOLLARS, dollars));
    setBet(next);
    try {
      window.sessionStorage.setItem(BET_STORAGE_KEY, String(next));
    } catch {
      // Not remembered; that's fine.
    }
  }, []);

  async function spin() {
    if (busy) return;
    const betCents = bet * 100;
    if (betCents > balanceCents) {
      setError(`Your wallet has ${formatMoney(balanceCents)}. Lower the bet or add money in the Shop.`);
      return;
    }
    setBusy(true);
    setError('');
    setResult(null);
    setStoppedReels(0);
    setHeldCents(balanceCents - betCents);
    const startedAt = Date.now();

    let outcome;
    try {
      outcome = await spinSlots(bet);
    } catch (err) {
      if (!mountedRef.current) return;
      setHeldCents(null);
      setStoppedReels(3);
      setBusy(false);
      setError(friendlyError(err.message || 'The spin failed. Nothing was charged.'));
      return;
    }
    if (!mountedRef.current) return;

    // The result is final; now let the reels land on it one at a time.
    const wait = Math.max(0, MIN_SPIN_MS - (Date.now() - startedAt));
    const at = (ms, fn) => timersRef.current.push(setTimeout(fn, ms));
    at(wait, () => {
      setStops(outcome.stops);
      setStoppedReels(1);
    });
    at(wait + REEL_GAP_MS, () => setStoppedReels(2));
    at(wait + 2 * REEL_GAP_MS, () => {
      setStoppedReels(3);
      setResult(outcome);
      setHistory((prev) => [outcome, ...prev].slice(0, 10));
      setHeldCents(null);
      setBusy(false);
      timersRef.current = [];
    });
  }

  const won = result && result.winCents > 0;

  return (
    <section className="page slots-page">
      <div className="slots-top">
        <Link to="/casino" className="btn btn-ghost small">
          ‹ Casino
        </Link>
        <h2 className="section-title">7s Slots</h2>
      </div>

      <div className="card slot-machine">
        <div className="reels" aria-live="polite">
          {[0, 1, 2].map((reel) => (
            <Reel key={reel} reel={reel} stop={stops[reel]} spinning={reel >= stoppedReels} />
          ))}
          <div className="payline-mark" aria-hidden="true" />
        </div>

        <div className={won ? 'slot-result win' : 'slot-result'} role="status">
          {result ? (
            won ? (
              <>
                <strong>{result.line.label}</strong> · you win <strong>{formatMoney(result.winCents)}</strong>
              </>
            ) : (
              'No win this time'
            )
          ) : busy ? (
            'Spinning…'
          ) : (
            'Pick a bet and spin'
          )}
        </div>

        <div className="bet-stepper" role="group" aria-label="Bet per spin">
          <button type="button" className="btn stepper-btn" onClick={() => chooseBet(bet - 1)} disabled={busy || bet <= CASINO_MIN_BET_DOLLARS} aria-label="Lower bet">
            −
          </button>
          <span className="bet-amount">${bet}</span>
          <button type="button" className="btn stepper-btn" onClick={() => chooseBet(bet + 1)} disabled={busy || bet >= CASINO_MAX_BET_DOLLARS} aria-label="Raise bet">
            +
          </button>
        </div>
        <div className="quick-bets">
          {QUICK_BETS.map((d) => (
            <button key={d} type="button" className={d === bet ? 'btn chip active' : 'btn chip'} onClick={() => chooseBet(d)} disabled={busy}>
              ${d}
            </button>
          ))}
        </div>

        <button type="button" className="btn btn-primary spin-btn" onClick={spin} disabled={busy}>
          {busy ? 'Spinning…' : `Spin · $${bet}`}
        </button>
        {error ? (
          <p className="error-text small" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="card paytable">
        <h3 className="small-heading">Paytable · one payline · pays shown for your ${bet} bet</h3>
        <ul className="paytable-list">
          {PAYTABLE.map((line) => (
            <li key={line.id} className={result?.line?.id === line.id ? 'paytable-row hit' : 'paytable-row'}>
              <span className="paytable-symbols">
                {line.show.map((id, i) => (
                  <SlotSymbol key={i} id={id} small />
                ))}
              </span>
              <span className="paytable-label">{line.label}</span>
              <span className="paytable-pays">
                {line.pays}× <span className="muted small">{formatMoney(line.pays * bet * 100)}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="muted small">Return to player 90.0%. Every spin is decided on the server before the reels move.</p>
      </div>

      {history.length > 0 ? (
        <div className="card">
          <h3 className="small-heading">This session</h3>
          <ul className="spin-history">
            {history.map((h, i) => (
              <li key={`${h.stops.join('-')}-${i}`} className={h.winCents > 0 ? 'win' : ''}>
                <span className="paytable-symbols">
                  {h.symbols.map((id, j) => (
                    <SlotSymbol key={j} id={id} small />
                  ))}
                </span>
                <span>{h.winCents > 0 ? `+${formatMoney(h.winCents)}` : `−${formatMoney(h.betCents)}`}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
