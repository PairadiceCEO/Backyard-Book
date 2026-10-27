// 7s Slots. The server decides every spin (debit, crypto.randomInt reel stops, credit) before any
// animation; the reels then stop one by one on the result. While they spin, the nav wallet is held at
// "balance − bet" so the live balance can't give the result away early.
//
// The bet is built from chips ($1, $2, $5, $10, $25, $100; Undo, Clear). Minimum $1, no maximum: the wallet is the only
// cap (and the server's $1,000,000 sanity ceiling). Tap Spin again while the
// reels spin to stop them at once on the result (as soon as it has arrived) — that tap never starts or
// charges another spin.
//
// 0.20.0: the Paytable sheet; on a win the winning symbols glow, a line is drawn through them and the win counts up; a win
// of 10× the bet or more is a Big win (banner + coin shower, at most 2.5 s, tap to skip). Autospin: 10 / 25 / 50 spins,
// each one the normal spin call, sent only after the last spin's reels have stopped and its result is on screen (and the
// Big win, if any, is over), so it is never faster than tapping. It stops on the count, its stop rule, a wallet that can't
// cover the next bet, a failed spin, Stop, leaving the page or the tab being hidden. The bet is locked while it runs.
// Sounds: src/lib/casinoSound.js.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Reel from '../../components/casino/Reel.jsx';
import SlotSymbol from '../../components/casino/SlotSymbol.jsx';
import PaytableSheet from '../../components/casino/PaytableSheet.jsx';
import SoundToggle from '../../components/casino/SoundToggle.jsx';
import { BIG_WIN_TIMES, BigWin, WinCount } from '../../components/casino/SlotWinFx.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useWalletDisplay } from '../../context/WalletDisplayContext.jsx';
import { spinSlots } from '../../lib/casino.js';
import { playSound, startLoop } from '../../lib/casinoSound.js';
import { formatMoney } from '../../lib/format.js';
import { friendlyError } from '../../components/StatusViews.jsx';
import { ChipRack, ChipStack, chipsFor } from '../../components/casino/Chips.jsx';
import { ensureFeltFont } from '../../lib/feltFont.js';
import '../../styles/slots.css';
import { BET_CEILING_CENTS, BET_CEILING_MESSAGE, BET_HELP_TEXT, CASINO_MIN_BET_DOLLARS, isValidBetAmount } from '../../../shared/casino/constants.js';

const BET_STORAGE_KEY = 'backyardbook.slotBet';
const MIN_SPIN_MS = 900; // reels spin at least this long, even if the server answers sooner
const REEL_GAP_MS = 350; // then stop one after another
const START_STOPS = [5, 13, 22];
export const AUTO_GAP_MS = 900; // autospin: the pause after a result is on screen before the next spin is sent
const AUTO_COUNTS = [10, 25, 50];
const AUTO_RULES = [
  { id: 'any', label: 'Any win' },
  { id: 'big', label: `${BIG_WIN_TIMES}× bet` },
  { id: 'never', label: "Don't stop" },
];

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

// Which reels' symbols made the win: the Cherries for a Cherry line, otherwise all three.
export function winningReels(symbols, lineId) {
  if (lineId === 'cherry1' || lineId === 'cherry2') return symbols.map((s, i) => (s === 'CH' ? i : -1)).filter((i) => i >= 0);
  return [0, 1, 2];
}

export function isBigWin(outcome, betCents = outcome?.betCents) {
  return Boolean(outcome) && Number.isFinite(betCents) && betCents > 0 && outcome.winCents > 0 && outcome.winCents >= BIG_WIN_TIMES * betCents;
}

// Why an autospin run stops after this spin's result, or '' to keep going.
export function autoStopReason(run, outcome) {
  if (run.done >= run.total) return 'done';
  if (run.rule === 'any' && outcome.winCents > 0) return 'win';
  if (run.rule === 'big' && isBigWin(outcome, Number.isFinite(outcome.betCents) ? outcome.betCents : run.bet * 100)) return 'win';
  if (Number.isFinite(outcome.balanceCents) && outcome.balanceCents < run.bet * 100) return 'wallet';
  return '';
}

const STOP_TEXT = {
  done: (run) => `Auto finished: ${run.done} spins.`,
  win: (run) => `Auto stopped on a win after ${run.done} spins.`,
  wallet: (run) => `Auto stopped after ${run.done} spins: not enough in your wallet for the next spin.`,
  failed: (run) => `Auto stopped after ${run.done} spins: a spin failed.`,
  stopped: (run) => `Auto stopped after ${run.done} spins.`,
  hidden: (run) => `Auto stopped after ${run.done} spins when you left the page.`,
};

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
  const [paytableOpen, setPaytableOpen] = useState(false);
  const [bigWin, setBigWin] = useState(null); // { key, cents } while the Big win shows
  const [autoOpen, setAutoOpen] = useState(false);
  const [autoCount, setAutoCount] = useState(AUTO_COUNTS[0]);
  const [autoRule, setAutoRule] = useState('any');
  const [auto, setAuto] = useState(null); // { total, done, rule, bet } while an autospin run is going
  const [autoNote, setAutoNote] = useState('');

  const timersRef = useRef([]);
  const mountedRef = useRef(true);
  const quickStopRef = useRef(false); // Spin tapped again while spinning
  const outcomeRef = useRef(null); // this spin's result, once the server has answered
  const busyRef = useRef(false);
  const autoRef = useRef(null);
  const balanceRef = useRef(balanceCents);
  const spinSoundRef = useRef(() => {});
  const spinCount = useRef(0);
  const bet = chipList.reduce((sum, d) => sum + d, 0);

  useEffect(() => {
    balanceRef.current = balanceCents;
  }, [balanceCents]);

  useEffect(() => {
    ensureFeltFont(); // the chips are lettered in Oswald
  }, []);

  // On leaving the page: stop pending reel timers, the spin sound and autospin, and give the nav its real balance back.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      spinSoundRef.current();
      autoRef.current = null;
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

  const setRun = useCallback((run) => {
    autoRef.current = run;
    setAuto(run);
  }, []);

  const stopAuto = useCallback(
    (reason) => {
      const run = autoRef.current;
      if (!run) return;
      setRun(null);
      setAutoNote(STOP_TEXT[reason]?.(run) ?? 'Auto stopped.');
    },
    [setRun],
  );

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
      playSound('chip');
      setChipList((list) => [...list, dollars]);
    },
    [bet, balanceCents],
  );

  // All reels stop on the result, the win shows, the wallet is released.
  const land = useCallback(
    (outcome) => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      spinSoundRef.current();
      spinSoundRef.current = () => {};
      setStops(outcome.stops);
      setStoppedReels(3);
      setResult({ ...outcome, key: (spinCount.current += 1) });
      setHistory((prev) => [outcome, ...prev].slice(0, 10));
      setHeldCents(null);
      busyRef.current = false;
      setBusy(false);
      quickStopRef.current = false;
      outcomeRef.current = null;
      if (outcome.winCents > 0) {
        const big = isBigWin(outcome);
        playSound(big ? 'bigWin' : 'win');
        if (big) setBigWin({ key: spinCount.current, cents: outcome.winCents });
      }
      const run = autoRef.current;
      if (run) {
        const reason = autoStopReason(run, outcome);
        if (reason) stopAuto(reason);
      }
    },
    [setHeldCents, stopAuto],
  );

  // One spin of `betDollars`. Refuses (returns false) while another spin is still on screen.
  const startSpin = useCallback(
    async (betDollars) => {
      if (busyRef.current) return false;
      const betCents = betDollars * 100;
      busyRef.current = true;
      setBusy(true);
      setError('');
      setResult(null);
      setBigWin(null);
      setStoppedReels(0);
      setHeldCents(balanceRef.current - betCents);
      quickStopRef.current = false;
      outcomeRef.current = null;
      spinSoundRef.current();
      spinSoundRef.current = startLoop('reelSpin');
      const startedAt = Date.now();

      let outcome;
      try {
        outcome = await spinSlots(betDollars);
      } catch (err) {
        if (!mountedRef.current) return false;
        spinSoundRef.current();
        spinSoundRef.current = () => {};
        setHeldCents(null);
        setStoppedReels(3);
        busyRef.current = false;
        setBusy(false);
        quickStopRef.current = false;
        setError(friendlyError(err.message || 'The spin failed. Nothing was charged.'));
        stopAuto('failed');
        return false;
      }
      if (!mountedRef.current) return false;
      outcomeRef.current = outcome;
      if (quickStopRef.current) {
        land(outcome);
        return true;
      }

      // The result is final; now let the reels land on it one at a time.
      const wait = Math.max(0, MIN_SPIN_MS - (Date.now() - startedAt));
      const at = (ms, fn) => timersRef.current.push(setTimeout(fn, ms));
      at(wait, () => {
        setStops(outcome.stops);
        setStoppedReels(1);
        playSound('reelStop');
      });
      at(wait + REEL_GAP_MS, () => {
        setStoppedReels(2);
        playSound('reelStop');
      });
      at(wait + 2 * REEL_GAP_MS, () => {
        playSound('reelStop');
        land(outcome);
      });
      return true;
    },
    [land, setHeldCents, stopAuto],
  );

  function spin() {
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
    if (bet * 100 > balanceCents) {
      setError(`Your wallet has ${formatMoney(balanceCents)}. Lower the bet or add money in the Shop.`);
      return;
    }
    setAutoNote('');
    startSpin(bet);
  }

  function startAuto() {
    setAutoOpen(false);
    setAutoNote('');
    if (bet < CASINO_MIN_BET_DOLLARS) {
      setError('Put a chip on the bet first.');
      return;
    }
    if (bet * 100 > balanceCents) {
      setError(`Your wallet has ${formatMoney(balanceCents)}. Lower the bet or add money in the Shop.`);
      return;
    }
    setRun({ total: autoCount, done: 1, rule: autoRule, bet });
    startSpin(bet);
  }

  // Autospin: the next spin goes once the last one has landed (and its Big win, if any, is over), after a short pause.
  useEffect(() => {
    if (!auto || busy || bigWin) return undefined;
    const timer = setTimeout(() => {
      const run = autoRef.current;
      if (!run || busyRef.current || !mountedRef.current) return;
      if (run.bet * 100 > balanceRef.current) {
        stopAuto('wallet');
        return;
      }
      setRun({ ...run, done: run.done + 1 });
      startSpin(run.bet);
    }, AUTO_GAP_MS);
    return () => clearTimeout(timer);
  }, [auto, busy, bigWin, startSpin, setRun, stopAuto]);

  // Hiding the tab (or switching apps) stops autospin; the spin already on its way still lands.
  useEffect(() => {
    if (!auto) return undefined;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stopAuto('hidden');
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [auto, stopAuto]);

  const closePaytable = useCallback(() => setPaytableOpen(false), []);
  const endBigWin = useCallback(() => setBigWin(null), []);

  const won = result && result.winCents > 0;
  const glow = won ? winningReels(result.symbols ?? [], result.line?.id) : [];
  const locked = busy || Boolean(auto);

  return (
    <section className="page slots-page">
      <div className="slots-top">
        <Link to="/casino" className="btn btn-ghost small">
          ‹ Casino
        </Link>
        <h2 className="section-title">7s Slots</h2>
        <button type="button" className="btn btn-ghost small paytable-btn" onClick={() => setPaytableOpen(true)}>
          Paytable
        </button>
        <SoundToggle />
      </div>

      <div className="card slot-machine">
        <div className={won ? 'reels has-win' : 'reels'} aria-live="polite">
          {[0, 1, 2].map((reel) => (
            <Reel key={reel} reel={reel} stop={stops[reel]} spinning={reel >= stoppedReels} glow={glow.includes(reel)} />
          ))}
          <div className="payline-mark" aria-hidden="true" />
          {won ? <div key={`line-${result.key}`} className="win-line" aria-hidden="true" /> : null}
          {bigWin ? <BigWin key={`big-${bigWin.key}`} cents={bigWin.cents} onDone={endBigWin} /> : null}
        </div>

        <div className={won ? 'slot-result win' : 'slot-result'} role="status">
          {result ? (
            won ? (
              <>
                <span className="sr-only">
                  {result.line.label}: you win {formatMoney(result.winCents)}
                </span>
                <span aria-hidden="true">
                  <strong>{result.line.label}</strong> · you win <WinCount key={result.key} cents={result.winCents} />
                </span>
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

        <button type="button" className={bet ? 'slot-bet has-bet' : 'slot-bet'} onClick={() => addChip(chip)} disabled={locked} aria-label={`Bet ${dollarsLabel(bet)}. Tap to add a $${chip} chip.`}>
          <span className="slot-bet-label">{auto ? 'Bet locked while Auto runs' : `Bet · tap to add $${chip}`}</span>
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
          canUndo={chipList.length > 0 && !auto}
          disabled={locked}
        />

        {auto ? (
          <div className="auto-bar">
            <span className="auto-count" aria-live="polite">
              Auto {auto.done}/{auto.total}
            </span>
            <button type="button" className="btn btn-danger auto-stop" onClick={() => stopAuto('stopped')}>
              Stop
            </button>
          </div>
        ) : (
          <div className="spin-row">
            <button type="button" className={busy ? 'btn btn-primary spin-btn spinning' : 'btn btn-primary spin-btn'} onClick={spin} disabled={!busy && bet < CASINO_MIN_BET_DOLLARS}>
              {busy ? 'Stop' : bet ? `Spin · ${dollarsLabel(bet)}` : 'Add a chip to spin'}
            </button>
            <button type="button" className="btn auto-btn" onClick={() => setAutoOpen((v) => !v)} disabled={busy || bet < CASINO_MIN_BET_DOLLARS} aria-expanded={autoOpen}>
              Auto
            </button>
          </div>
        )}

        {autoOpen && !auto ? (
          <div className="auto-panel" role="group" aria-label="Autospin">
            <div className="auto-choice" role="radiogroup" aria-label="Spins">
              <span className="auto-choice-label">Spins</span>
              {AUTO_COUNTS.map((n) => (
                <button key={n} type="button" role="radio" aria-checked={autoCount === n} className={autoCount === n ? 'btn auto-opt active' : 'btn auto-opt'} onClick={() => setAutoCount(n)}>
                  {n}
                </button>
              ))}
            </div>
            <div className="auto-choice" role="radiogroup" aria-label="Stop on a win of at least">
              <span className="auto-choice-label">Stop on a win of at least</span>
              {AUTO_RULES.map((r) => (
                <button key={r.id} type="button" role="radio" aria-checked={autoRule === r.id} className={autoRule === r.id ? 'btn auto-opt active' : 'btn auto-opt'} onClick={() => setAutoRule(r.id)}>
                  {r.label}
                </button>
              ))}
            </div>
            <button type="button" className="btn btn-primary auto-start" onClick={startAuto}>
              Start Auto · {autoCount} × {dollarsLabel(bet)}
            </button>
          </div>
        ) : null}

        <p className="muted small slot-help">{BET_HELP_TEXT}</p>
        {autoNote ? (
          <p className="small auto-note" role="status">
            {autoNote}
          </p>
        ) : null}
        {error ? (
          <p className="error-text small" role="alert">
            {error}
          </p>
        ) : null}
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

      <PaytableSheet open={paytableOpen} onClose={closePaytable} betDollars={bet} hitId={result?.line?.id ?? null} />
    </section>
  );
}
