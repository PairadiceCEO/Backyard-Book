// 7s Slots. The server decides every spin (debit, crypto.randomInt reel stops, credit) before any
// animation; the reels then stop one by one on the result. While they spin, the nav wallet is held at
// "balance − bet" so the live balance can't give the result away early.
//
// The bet is built from chips ($1, $2, $5, $10, $25, $100; Undo, Clear). Minimum $1, no maximum: the wallet is the only
// cap (and the server's $1,000,000 sanity ceiling). Tap Spin again while the
// reels spin to stop them at once on the result (as soon as it has arrived) — that tap never starts or
// charges another spin.

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
import { ChipRack, ChipStack, chipsFor } from '../../components/casino/Chips.jsx';
import { BET_CEILING_CENTS, BET_CEILING_MESSAGE, BET_HELP_TEXT, CASINO_MIN_BET_DOLLARS, isValidBetAmount } from '../../../shared/casino/constants.js';

const BET_STORAGE_KEY = 'backyardbook.slotBet';
const MIN_SPIN_MS = 900; // reels spin at least this long, even if the server answers sooner
const REEL_GAP_MS = 350; // then stop one after another
const START_STOPS = [5, 13, 22];

// "$1,250": whole dollars with thousands separators.
function dollarsLabel(dollars) {
  return `$${dollars.toLocaleString('en-US')}`;
}

function readSavedBet() {
  try {
    const saved = Number(window.sessionStorage.getItem(BET_STORAGE_KEY));
    if (isValidBetAmount(saved) && saved * 100 <= BET_CEILING_CENTS) return saved;
  } catch {
    // Storage can be blocked; fall back to $1.
  }
  return CASINO_MIN_BET_DOLLARS;
}

export default function SlotsPage() {
  const { profile } = useAuth();
  const { setHeldCents } = useWalletDisplay();
  const balanceCents = Number(profile?.balanceCents) || 0;

  const [chipList, setChipList] = useState(() => chipsFor(readSavedBet() * 100)); // chips on the bet, in order
  const [chip, setChip] = useState(1);
  const [stops, setStops] = useState(START_STOPS);
  const [stoppedReels, setStoppedReels] = useState(3); // reels 0..stoppedReels-1 are still; the rest spin
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState([]);

  const timersRef = useRef([]);
  const mountedRef = useRef(true);
  const quickStopRef = useRef(false); // Spin tapped again while spinning
  const outcomeRef = useRef(null); // this spin's result, once the server has answered
  const bet = chipList.reduce((sum, d) => sum + d, 0);

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

  // Remember the bet for this browser session.
  useEffect(() => {
    try {
      if (bet >= CASINO_MIN_BET_DOLLARS) window.sessionStorage.setItem(BET_STORAGE_KEY, String(bet));
    } catch {
      // Not remembered; that's fine.
    }
  }, [bet]);

  const addChip = useCallback(
    (dollars) => {
      setError('');
      if ((bet + dollars) * 100 > BET_CEILING_CENTS) {
        setError(BET_CEILING_MESSAGE);
        return;
      }
      if ((bet + dollars) * 100 > balanceCents) {
        setError(`Not enough in your wallet (${formatMoney(balanceCents)}).`);
        return;
      }
      setChipList((list) => [...list, dollars]);
    },
    [bet, balanceCents],
  );

  // All reels stop on the result, the win shows, the wallet is released.
  const land = useCallback(
    (outcome) => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      setStops(outcome.stops);
      setStoppedReels(3);
      setResult(outcome);
      setHistory((prev) => [outcome, ...prev].slice(0, 10));
      setHeldCents(null);
      setBusy(false);
      quickStopRef.current = false;
      outcomeRef.current = null;
    },
    [setHeldCents],
  );

  async function spin() {
    if (busy) {
      // A second tap while spinning: stop now (or the moment the result arrives). Never a new spin.
      quickStopRef.current = true;
      if (outcomeRef.current) land(outcomeRef.current);
      return;
    }
    if (bet < CASINO_MIN_BET_DOLLARS) {
      setError('Put a chip on the bet first.');
      return;
    }
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
    quickStopRef.current = false;
    outcomeRef.current = null;
    const startedAt = Date.now();

    let outcome;
    try {
      outcome = await spinSlots(bet);
    } catch (err) {
      if (!mountedRef.current) return;
      setHeldCents(null);
      setStoppedReels(3);
      setBusy(false);
      quickStopRef.current = false;
      setError(friendlyError(err.message || 'The spin failed. Nothing was charged.'));
      return;
    }
    if (!mountedRef.current) return;
    outcomeRef.current = outcome;
    if (quickStopRef.current) {
      land(outcome);
      return;
    }

    // The result is final; now let the reels land on it one at a time.
    const wait = Math.max(0, MIN_SPIN_MS - (Date.now() - startedAt));
    const at = (ms, fn) => timersRef.current.push(setTimeout(fn, ms));
    at(wait, () => {
      setStops(outcome.stops);
      setStoppedReels(1);
    });
    at(wait + REEL_GAP_MS, () => setStoppedReels(2));
    at(wait + 2 * REEL_GAP_MS, () => land(outcome));
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

        <button type="button" className={bet ? 'slot-bet has-bet' : 'slot-bet'} onClick={() => addChip(chip)} disabled={busy} aria-label={`Bet ${dollarsLabel(bet)}. Tap to add a $${chip} chip.`}>
          <span className="slot-bet-label">Bet · tap to add ${chip}</span>
          <span className="spot-chips">
            <ChipStack cents={bet * 100} />
            <span className="bet-amount">{dollarsLabel(bet)}</span>
          </span>
        </button>
        <ChipRack
          chip={chip}
          onChip={setChip}
          onUndo={() => {
            setError('');
            setChipList((list) => list.slice(0, -1));
          }}
          onClear={() => {
            setError('');
            setChipList([]);
          }}
          canUndo={chipList.length > 0}
          disabled={busy}
        />

        <button type="button" className={busy ? 'btn btn-primary spin-btn spinning' : 'btn btn-primary spin-btn'} onClick={spin} disabled={!busy && bet < CASINO_MIN_BET_DOLLARS}>
          {busy ? 'Stop' : bet ? `Spin · ${dollarsLabel(bet)}` : 'Add a chip to spin'}
        </button>
        <p className="muted small slot-help">{BET_HELP_TEXT}</p>
        {error ? (
          <p className="error-text small" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="card paytable">
        <h3 className="small-heading">Paytable · one payline · pays shown for your {dollarsLabel(bet)} bet</h3>
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
