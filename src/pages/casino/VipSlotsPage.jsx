// The Pairadice VIP slot (0.28.0), /casino/vip. Locked on every visit: the page first asks for the password (sheet), sends it to
// /api/casino vipUnlock and keeps the VIP pass it gets back in React state only (never storage or cookies). Leaving the page,
// reloading, switching games or the pass expiring locks it again; a spin the server refuses with VIP_LOCKED does too.
//
// The machine: a 3 × 3 window, three paylines (top, middle, bottom rows) marked at both edges, winning lines lit with their amounts.
// The server decides every spin and the whole Golden Dice bonus before any animation (shared/casino/vipSlots.js); the phone lands
// the reels on the result, then plays the bonus spins one by one ("Free spin 4 / 10 · ×3", a running total, a big finish). The nav
// wallet is held at "balance − bet" until all of it has played. Bet chips, Max, Spin and Auto (10 / 25 / 50, the 7s Slots stop
// rules; Auto waits while a bonus plays and carries on after it, and stops if the pass is refused). At most one paid spin every 2 s
// (the server refuses faster ones), so a spin tapped sooner waits for the rest of the 2 s.
//
// 0.28.1: layout top to bottom is machine, win / bonus info, Spin (Stop / Skip to total), the bet spot, the chip rack with Max, then
// Auto. Any tap on Stop while a spin is busy is remembered (stopRequestedRef), so it also works during the 2 s wait and while the
// request is in flight: the reply lands at once, all three reels together. What the reels show is ONE value { stops, onBonus }: the
// stops and the strips they belong to change together, so the trigger spin stays exactly as it landed (its Golden Dice lit, a banner)
// until the first free spin brings the bonus strips along with its own stops.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import VipSymbol from '../../components/casino/VipSymbol.jsx';
import VipPaytableSheet from '../../components/casino/VipPaytableSheet.jsx';
import SoundToggle from '../../components/casino/SoundToggle.jsx';
import MaxBet from '../../components/casino/MaxBet.jsx';
import { BigWin, WinCount } from '../../components/casino/SlotWinFx.jsx';
import { ChipRack, ChipStack, chipsFor } from '../../components/casino/Chips.jsx';
import { friendlyError } from '../../components/StatusViews.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useWalletDisplay } from '../../context/WalletDisplayContext.jsx';
import { serverNow, spinVip, vipStatus, vipUnlock } from '../../lib/casino.js';
import { playSound, startLoop } from '../../lib/casinoSound.js';
import { prefersReducedMotion } from '../../lib/reducedMotion.js';
import { formatMoney } from '../../lib/format.js';
import { ensureFeltFont } from '../../lib/feltFont.js';
import { autoStopReason } from './SlotsPage.jsx';
import '../../styles/slots.css';
import '../../styles/vip.css';
import { BET_CEILING_CENTS, BET_CEILING_MESSAGE, BET_HELP_TEXT, CASINO_MIN_BET_DOLLARS } from '../../../shared/casino/constants.js';
import { VIP_BONUS_MULT, VIP_BONUS_REELS, VIP_LINES, VIP_PAYTABLE, VIP_REELS, goldenDiceCount, vipCents, vipWindow } from '../../../shared/casino/vipSlots.js';

const START_STOPS = [6, 14, 23];
const START_VIEW = { stops: START_STOPS, onBonus: false };
const MIN_SPIN_MS = 1000; // the reels spin at least this long
const REEL_GAP_MS = 320; // then stop one after another
const SPIN_GAP_MS = 2050; // the server allows one paid spin every 2 s
const BONUS_START_MS = 1300; // after the trigger lands, before the first free spin
const BONUS_SPIN_MS = 600; // a free spin's reels spin this long
const BONUS_SHOW_MS = 750; // then its result shows this long
const AUTO_GAP_MS = 900;
const AUTO_COUNTS = [10, 25, 50];
const AUTO_RULES = [
  { id: 'any', label: 'Any win' },
  { id: 'big', label: '10× bet' },
  { id: 'never', label: "Don't stop" },
];
const STOP_TEXT = {
  done: (run) => `Auto finished: ${run.done} spins.`,
  win: (run) => `Auto stopped on a win after ${run.done} spins.`,
  wallet: (run) => `Auto stopped after ${run.done} spins: not enough in your wallet for the next spin.`,
  failed: (run) => `Auto stopped after ${run.done} spins: a spin failed.`,
  stopped: (run) => `Auto stopped after ${run.done} spins.`,
  hidden: (run) => `Auto stopped after ${run.done} spins when you left the page.`,
  locked: (run) => `Auto stopped after ${run.done} spins: VIP locked again.`,
};
const LABELS = Object.fromEntries(VIP_PAYTABLE.map((l) => [l.id, l.label]));

function dollarsLabel(dollars) {
  return `$${dollars.toLocaleString('en-US')}`;
}

// Dev only (stripped from the production build): after every render with all three reels stopped, the symbols actually drawn
// must equal the window of the result being shown (its stops on the strips the server used: base for a paid spin, bonus for a
// free spin). A mismatch logs an error and counts in window.__vipDrawMismatch (the phone harness asserts it stays 0).
const useDrawCheck = import.meta.env.DEV
  ? function useDrawCheck(expectedRef, view, stoppedReels) {
      useEffect(() => {
        const expected = expectedRef.current;
        if (!expected || stoppedReels !== 3) return;
        const want = vipWindow(expected.stops, expected.onBonus ? VIP_BONUS_REELS : VIP_REELS);
        const reels = document.querySelectorAll('.vip-reels .vip-reel');
        if (reels.length !== 3) return;
        const drawn = [...reels].map((el) => [...el.querySelectorAll('.vip-cell')].map((cell) => cell.getAttribute('data-sym')));
        const bad = drawn.some((column, reel) => column.length !== 3 || column.some((id, row) => id !== want[row][reel]));
        if (bad) {
          window.__vipDrawMismatch = (window.__vipDrawMismatch || 0) + 1;
          console.error('[vip-dev] what is drawn is not the result window', { drawn, want, expected, view });
        }
      }, [expectedRef, view, stoppedReels]);
    }
  : () => {};

// One reel: three cells (top, middle, bottom row), or a blurred column scrolling past while it spins. The blur uses the strip of the
// spin it belongs to (spinStrips); the stopped window uses the strips the stops were drawn on (windowStrips).
function VipReel({ reel, stop, spinning, spinStrips, windowStrips, litRows, diceGlow }) {
  if (spinning) {
    const strip = spinStrips[reel];
    return (
      <div className="reel vip-reel spinning" aria-label={`Reel ${reel + 1} spinning`}>
        <div className={`reel-track reel-speed-${reel}`}>
          {[...strip.slice(0, 10), ...strip.slice(0, 10)].map((id, i) => (
            <div key={i} className="reel-cell" data-sym={id}>
              <VipSymbol id={id} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  const window = vipWindow([stop, stop, stop], windowStrips).map((row) => row[reel]);
  return (
    <div className="reel vip-reel" aria-label={`Reel ${reel + 1}: ${window.join(', ')}`}>
      {window.map((id, row) => {
        const classes = ['reel-cell', 'vip-cell'];
        if (litRows.includes(row)) classes.push('lit');
        if (diceGlow && id === 'GD') classes.push('dice');
        return (
          <div key={row} className={classes.join(' ')} data-row={row} data-sym={id}>
            <VipSymbol id={id} />
          </div>
        );
      })}
    </div>
  );
}

// The password sheet: shown on every visit until the server says yes.
function UnlockSheet({ setUp, statusError, onUnlocked, note }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (setUp) inputRef.current?.focus({ preventScroll: true });
  }, [setUp]);

  async function submit(event) {
    event.preventDefault();
    if (!password || busy) return;
    const tried = password;
    setPassword(''); // never kept after a try
    setBusy(true);
    setError('');
    try {
      const data = await vipUnlock(tried);
      onUnlocked({ pass: data.pass, expiresAt: data.expiresAt });
    } catch (err) {
      setError(friendlyError(err.message || 'Could not unlock VIP.'));
      setBusy(false);
      inputRef.current?.focus({ preventScroll: true });
    }
  }

  return (
    <div className="vip-lock card" role="dialog" aria-modal="false" aria-labelledby="vip-lock-title">
      <div className="vip-lock-icon" aria-hidden="true">
        <LockIcon />
      </div>
      <h3 id="vip-lock-title" className="vip-lock-title">
        VIP
      </h3>
      {setUp === null ? <p className="muted small">Checking…</p> : null}
      {statusError ? (
        <p className="error-text small" role="alert">
          {statusError}
        </p>
      ) : null}
      {setUp === false ? <p className="vip-lock-text">VIP isn't set up yet</p> : null}
      {setUp ? (
        <form className="vip-lock-form" onSubmit={submit}>
          <p className="muted small vip-lock-text">{note || 'Members only. Enter the VIP password to play.'}</p>
          <label className="field">
            <span>Password</span>
            <input
              ref={inputRef}
              type="password"
              name="vip-password"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck="false"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </label>
          <button type="submit" className="btn btn-primary full" disabled={busy || !password}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
          {error ? (
            <p className="error-text small" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}

export function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="10" rx="2.5" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      <circle cx="12" cy="16" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default function VipSlotsPage() {
  const { profile } = useAuth();
  const { setHeldCents } = useWalletDisplay();
  const balanceCents = Number(profile?.balanceCents) || 0;

  const [setUp, setSetUp] = useState(null);
  const [statusError, setStatusError] = useState('');
  const [pass, setPass] = useState(null); // { pass, expiresAt }: memory only
  const [lockNote, setLockNote] = useState('');

  const [chipList, setChipList] = useState(() => chipsFor(CASINO_MIN_BET_DOLLARS * 100));
  const [chip, setChip] = useState(1);
  // The stops on screen and the strips they were drawn on, ONE value: they always change together, so a window can never be
  // drawn with another spin's strips (the bonus strips arrive with the first free spin's stops, the base strips with the next
  // paid spin's result).
  const [view, setView] = useState(START_VIEW);
  const [trigger, setTrigger] = useState(null); // { key } while the trigger spin stays on screen with its Golden Dice lit
  const [stoppedReels, setStoppedReels] = useState(3);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(null); // { key, lines, mult, cents, betCents } on screen now
  const [bonus, setBonus] = useState(null); // { index, played, awarded, total, mult, finished } while a bonus plays
  const [bigWin, setBigWin] = useState(null);
  const [error, setError] = useState('');
  const [paytableOpen, setPaytableOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const [autoCount, setAutoCount] = useState(AUTO_COUNTS[0]);
  const [autoRule, setAutoRule] = useState('any');
  const [auto, setAuto] = useState(null);
  const [autoNote, setAutoNote] = useState('');
  const [session, setSession] = useState({ spins: 0, bet: 0, won: 0 });

  const timersRef = useRef([]);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const autoRef = useRef(null);
  const passRef = useRef(null);
  const balanceRef = useRef(balanceCents);
  const lastSentRef = useRef(0);
  const spinSoundRef = useRef(() => {});
  const finishRef = useRef(null); // ends the current spin (and bonus) at once: Skip / quick stop
  const stopRequestedRef = useRef(false); // a tap on Stop while the reply isn't here yet: land the moment it arrives
  const expectedRef = useRef(null); // dev check: the result window being shown ({ stops, onBonus }), from the server's reply
  const keyRef = useRef(0);
  const bet = chipList.reduce((sum, d) => sum + d, 0);

  useDrawCheck(expectedRef, view, stoppedReels);

  useEffect(() => {
    balanceRef.current = balanceCents;
  }, [balanceCents]);

  useEffect(() => {
    passRef.current = pass;
  }, [pass]);

  useEffect(() => {
    ensureFeltFont();
    let cancelled = false;
    vipStatus()
      .then((r) => {
        if (!cancelled) setSetUp(Boolean(r.setUp));
      })
      .catch((err) => {
        if (!cancelled) {
          setStatusError(friendlyError(err.message || 'Could not reach VIP.'));
          setSetUp(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const relock = useCallback(
    (note) => {
      stopAuto('locked');
      setPass(null);
      setLockNote(note);
      setPaytableOpen(false);
      setAutoOpen(false);
    },
    [stopAuto],
  );

  // The pass runs out after 2 hours: lock again (a spin on screen still finishes).
  useEffect(() => {
    if (!pass) return undefined;
    const ms = Math.max(0, pass.expiresAt - serverNow());
    const timer = setTimeout(() => relock('Your VIP time ran out. Enter the password again.'), Math.min(ms, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [pass, relock]);

  const at = useCallback((ms, fn) => {
    timersRef.current.push(setTimeout(fn, ms));
  }, []);
  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  // Everything about this spin is on screen: give the wallet back, check Auto.
  const finish = useCallback(
    (outcome) => {
      clearTimers();
      finishRef.current = null;
      stopRequestedRef.current = false;
      spinSoundRef.current();
      spinSoundRef.current = () => {};
      setHeldCents(null);
      busyRef.current = false;
      setBusy(false);
      setSession((s) => ({ spins: s.spins + 1, bet: s.bet + outcome.betCents, won: s.won + outcome.winCents }));
      const run = autoRef.current;
      if (run) {
        const reason = autoStopReason(run, { winCents: outcome.winCents, betCents: outcome.betCents, balanceCents: outcome.balanceCents });
        if (reason) stopAuto(reason);
      }
    },
    [clearTimers, setHeldCents, stopAuto],
  );

  const showLines = useCallback((lines, mult, betCents, silent = false) => {
    keyRef.current += 1;
    const cents = lines.reduce((s, l) => s + vipCents(betCents, l.tenths, mult), 0);
    setShown({ key: keyRef.current, lines, mult, cents, betCents });
    if (cents > 0 && !silent) playSound(cents >= 10 * betCents ? 'bigWin' : 'win');
  }, []);

  // The bonus, one free spin at a time, then the big finish.
  const playBonus = useCallback(
    (outcome) => {
      const { spin, betCents } = outcome;
      const spins = spin.bonus.spins;
      const reduced = prefersReducedMotion();
      const spinMs = reduced ? 0 : BONUS_SPIN_MS;
      const showMs = reduced ? 500 : BONUS_SHOW_MS;
      let awarded = 10;
      let total = 0;
      const last = spins[spins.length - 1];
      const end = () => {
        finishRef.current = null; // once
        clearTimers();
        setTrigger(null);
        setBonus({ index: spins.length - 1, played: spins.length, awarded: spin.bonus.awarded, total: spin.bonus.cents, mult: VIP_BONUS_MULT, finished: true });
        // the last free spin as the server drew it, its winning lines lit with it (never the lines of an earlier spin)
        expectedRef.current = { stops: last.stops, onBonus: true };
        setView({ stops: last.stops, onBonus: true });
        setStoppedReels(3);
        showLines(last.lines, VIP_BONUS_MULT, betCents, true);
        playSound('bigWin');
        keyRef.current += 1;
        setBigWin({ key: keyRef.current, cents: spin.bonus.cents, title: 'Bonus win!', after: () => finish(outcome) });
      };
      finishRef.current = end;
      // The trigger spin stays exactly as it landed (its stops on the base strips, its Golden Dice lit, its line wins) for
      // BONUS_START_MS: nothing here touches `view`. The bonus strips come only with the first free spin's stops below.
      setBonus({ index: -1, played: 0, awarded, total: 0, mult: VIP_BONUS_MULT, finished: false, dice: outcome.dice });
      let t = BONUS_START_MS;
      spins.forEach((s, i) => {
        at(t, () => {
          if (reduced) return; // no spinning: the result below replaces the window in one step
          setShown(null);
          setTrigger(null);
          setStoppedReels(0);
          spinSoundRef.current();
          spinSoundRef.current = startLoop('reelSpin');
        });
        t += spinMs;
        at(t, () => {
          spinSoundRef.current();
          spinSoundRef.current = () => {};
          setTrigger(null);
          expectedRef.current = { stops: s.stops, onBonus: true };
          setView({ stops: s.stops, onBonus: true });
          setStoppedReels(3);
          playSound('reelStop');
          awarded += s.added;
          total += s.cents;
          setBonus({ index: i, played: i + 1, awarded, total, mult: VIP_BONUS_MULT, finished: false, added: s.added });
          showLines(s.lines, VIP_BONUS_MULT, betCents);
        });
        t += showMs;
      });
      at(t, end);
    },
    [at, clearTimers, finish, showLines],
  );

  // The paid spin lands; then its bonus (if any) plays, or it's done.
  const land = useCallback(
    (outcome) => {
      clearTimers();
      stopRequestedRef.current = false; // landing is what a Stop tap asks for: it is answered
      spinSoundRef.current();
      spinSoundRef.current = () => {};
      // the paid spin as the server drew it: its stops on the base strips, in one step
      expectedRef.current = { stops: outcome.spin.stops, onBonus: false };
      setView({ stops: outcome.spin.stops, onBonus: false });
      setStoppedReels(3);
      showLines(outcome.spin.lines, 1, outcome.betCents);
      if (outcome.spin.bonus) {
        playSound('bigWin');
        keyRef.current += 1;
        setTrigger({ key: keyRef.current }); // light the Golden Dice until the first free spin starts
        playBonus({ ...outcome, dice: goldenDiceCount(vipWindow(outcome.spin.stops, VIP_REELS)) }); // Auto waits while it plays and carries on after it
        return;
      }
      if (outcome.spin.baseCents >= 10 * outcome.betCents) {
        keyRef.current += 1;
        setBigWin({ key: keyRef.current, cents: outcome.spin.baseCents, title: 'Big win!', after: () => finish(outcome) });
        finishRef.current = null;
        return;
      }
      finish(outcome);
    },
    [clearTimers, finish, playBonus, showLines],
  );

  const startSpin = useCallback(
    async (betDollars) => {
      if (busyRef.current || !passRef.current) return false;
      const betCents = betDollars * 100;
      busyRef.current = true;
      stopRequestedRef.current = false;
      setBusy(true);
      setError('');
      setShown(null);
      setBonus(null);
      setBigWin(null);
      setTrigger(null);
      setHeldCents(balanceRef.current - betCents);
      // the server allows one paid spin every 2 s: wait out the rest
      const wait = lastSentRef.current + SPIN_GAP_MS - Date.now();
      setStoppedReels(0);
      spinSoundRef.current();
      spinSoundRef.current = startLoop('reelSpin');
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (!mountedRef.current) return false;
      const startedAt = Date.now();
      lastSentRef.current = startedAt;
      let outcome;
      try {
        const data = await spinVip(betDollars, passRef.current?.pass);
        outcome = { spin: data.spin, betCents: data.betCents, winCents: data.winCents, balanceCents: data.balanceCents };
      } catch (err) {
        if (!mountedRef.current) return false;
        spinSoundRef.current();
        spinSoundRef.current = () => {};
        stopRequestedRef.current = false;
        setHeldCents(null);
        setStoppedReels(3);
        busyRef.current = false;
        setBusy(false);
        if (err.code === 'VIP_LOCKED') {
          relock('VIP locked again. Enter the password to keep playing.');
          return false;
        }
        setError(friendlyError(err.message || 'The spin failed. Nothing was charged.'));
        stopAuto('failed');
        return false;
      }
      if (!mountedRef.current) return false;
      // A Stop tap came in while the request or the 2 s wait was still going (finishRef didn't exist yet): land at once, all three
      // reels together, with none of the minimum spin time or the gaps between reels. land() answers the tap.
      if (stopRequestedRef.current) {
        land(outcome);
        return true;
      }
      const reduced = prefersReducedMotion();
      const delay = reduced ? 0 : Math.max(0, MIN_SPIN_MS - (Date.now() - startedAt));
      finishRef.current = () => {
        finishRef.current = null;
        land(outcome);
      };
      at(delay, () => {
        expectedRef.current = { stops: outcome.spin.stops, onBonus: false };
        setView({ stops: outcome.spin.stops, onBonus: false });
        setStoppedReels(1);
        playSound('reelStop');
      });
      at(delay + (reduced ? 0 : REEL_GAP_MS), () => {
        setStoppedReels(2);
        playSound('reelStop');
      });
      at(delay + (reduced ? 0 : 2 * REEL_GAP_MS), () => {
        playSound('reelStop');
        finishRef.current = null;
        land(outcome);
      });
      return true;
    },
    [at, land, relock, setHeldCents, stopAuto],
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

  function canAfford() {
    if (bet < CASINO_MIN_BET_DOLLARS) {
      setError('Put a chip on the bet first.');
      return false;
    }
    if (bet * 100 > balanceCents) {
      setError(`Your wallet has ${formatMoney(balanceCents)}. Lower the bet or add money in the Shop.`);
      return false;
    }
    return true;
  }

  function spin() {
    if (busyRef.current) {
      // A second tap, never a new spin. Remember it first: during the 2 s wait or while the request is in flight there is nothing to
      // finish yet (finishRef is set only once the reply is here), so the reply lands at once when it arrives. When there is
      // something to finish, do it now: land the reels, or skip a bonus to its total.
      stopRequestedRef.current = true;
      finishRef.current?.();
      return;
    }
    if (!canAfford()) return;
    setAutoNote('');
    startSpin(bet);
  }

  function startAuto() {
    setAutoOpen(false);
    setAutoNote('');
    if (!canAfford()) return;
    setRun({ total: autoCount, done: 1, rule: autoRule, bet });
    startSpin(bet);
  }

  // Auto: the next spin once the last one (and its bonus and big win) is over.
  useEffect(() => {
    if (!auto || busy || bigWin || !pass) return undefined;
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
  }, [auto, busy, bigWin, pass, startSpin, setRun, stopAuto]);

  useEffect(() => {
    if (!auto) return undefined;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stopAuto('hidden');
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [auto, stopAuto]);

  const closePaytable = useCallback(() => setPaytableOpen(false), []);
  const endBigWin = useCallback(() => {
    setBigWin((b) => {
      if (b?.after) setTimeout(b.after, 0);
      return null;
    });
  }, []);

  const inBonus = Boolean(bonus);
  // A stopped window is drawn on the strips its stops belong to (view.onBonus); a spinning blur on the strips of the spin that is
  // running: the bonus strips while a bonus plays, the base strips for a paid spin.
  const windowStrips = view.onBonus ? VIP_BONUS_REELS : VIP_REELS;
  const spinStrips = inBonus ? VIP_BONUS_REELS : VIP_REELS;
  const litRows = stoppedReels === 3 && shown ? shown.lines.map((l) => l.row) : [];
  const locked = busy || Boolean(auto);
  const triggerShown = Boolean(trigger) && stoppedReels === 3;

  return (
    <section className="page slots-page vip-page">
      <div className="slots-top">
        <Link to="/casino" className="btn btn-ghost small">
          ‹ Casino
        </Link>
        <h2 className="section-title">VIP</h2>
        {pass ? (
          <button type="button" className="btn btn-ghost small paytable-btn" onClick={() => setPaytableOpen(true)}>
            Paytable
          </button>
        ) : null}
        <SoundToggle />
      </div>

      {!pass ? (
        <UnlockSheet setUp={setUp} statusError={statusError} note={lockNote} onUnlocked={(p) => {
          setLockNote('');
          setPass(p);
        }} />
      ) : (
        <div className={inBonus ? 'card slot-machine vip-machine in-bonus' : 'card slot-machine vip-machine'}>
          {inBonus ? (
            <div className={triggerShown && bonus.played === 0 ? 'vip-bonus-bar trigger' : 'vip-bonus-bar'} role="status" aria-live="polite">
              <span className="vip-bonus-count">
                {bonus.played > 0
                  ? `Free spin ${bonus.played} / ${bonus.awarded}`
                  : bonus.dice
                    ? `${bonus.dice} Golden Dice! ${bonus.awarded} free spins`
                    : `${bonus.awarded} free spins`}{' '}
                · ×{bonus.mult}
              </span>
              <span className="vip-bonus-total">{formatMoney(bonus.total)}</span>
              {bonus.added ? <span className="vip-bonus-added">+{bonus.added} spins!</span> : null}
            </div>
          ) : null}
          <div className="vip-frame">
            <div className="vip-marks left" aria-hidden="true">
              {VIP_LINES.map((l) => (
                <span key={l.id} className={litRows.includes(l.row) ? 'vip-mark lit' : 'vip-mark'}>
                  {l.row + 1}
                </span>
              ))}
            </div>
            <div className={shown && shown.cents > 0 ? 'reels vip-reels has-win' : 'reels vip-reels'} aria-live="polite">
              {[0, 1, 2].map((reel) => (
                <VipReel
                  key={reel}
                  reel={reel}
                  stop={view.stops[reel]}
                  spinning={reel >= stoppedReels}
                  spinStrips={spinStrips}
                  windowStrips={windowStrips}
                  litRows={litRows}
                  diceGlow={triggerShown}
                />
              ))}
              {litRows.map((row) => (
                <div key={`${shown.key}-${row}`} className={`vip-win-line row-${row}`} aria-hidden="true" />
              ))}
              {bigWin ? <BigWin key={`big-${bigWin.key}`} cents={bigWin.cents} title={bigWin.title} onDone={endBigWin} /> : null}
            </div>
            <div className="vip-marks right" aria-hidden="true">
              {VIP_LINES.map((l) => (
                <span key={l.id} className={litRows.includes(l.row) ? 'vip-mark lit' : 'vip-mark'}>
                  {l.row + 1}
                </span>
              ))}
            </div>
          </div>

          {litRows.length > 0 ? (
            <ul className="vip-line-wins" aria-label="Winning lines">
              {shown.lines.map((l) => (
                <li key={l.line} className="vip-line-win">
                  <span className="vip-line-num">{l.row + 1}</span>
                  <span className="vip-line-name">{LABELS[l.id]}</span>
                  <strong className="vip-line-amount">+{formatMoney(vipCents(shown.betCents, l.tenths, shown.mult))}</strong>
                </li>
              ))}
            </ul>
          ) : null}

          <div className={shown && shown.cents > 0 ? 'slot-result win' : 'slot-result'} role="status">
            {shown && stoppedReels === 3 ? (
              shown.cents > 0 ? (
                <>
                  <span className="sr-only">
                    {shown.lines.map((l) => LABELS[l.id]).join(', ')}: you win {formatMoney(shown.cents)}
                  </span>
                  <span aria-hidden="true">
                    <strong>{shown.lines.length === 1 ? LABELS[shown.lines[0].id] : `${shown.lines.length} lines`}</strong>
                    {shown.mult > 1 ? ` ×${shown.mult}` : ''} · you win <WinCount key={shown.key} cents={shown.cents} />
                  </span>
                </>
              ) : inBonus ? (
                'No win this spin'
              ) : (
                'No win this time'
              )
            ) : busy ? (
              inBonus ? 'Free spin…' : 'Spinning…'
            ) : (
              'Pick a bet and spin'
            )}
          </div>

          {auto ? (
            <div className="auto-bar">
              <span className="auto-count" aria-live="polite">
                Auto {auto.done}/{auto.total}
                {inBonus ? ' · bonus playing' : ''}
              </span>
              <button type="button" className="btn btn-danger auto-stop" onClick={() => stopAuto('stopped')}>
                Stop
              </button>
            </div>
          ) : (
            <div className="spin-row">
              <button type="button" className={busy ? 'btn btn-primary spin-btn spinning' : 'btn btn-primary spin-btn'} onClick={spin} disabled={!busy && bet < CASINO_MIN_BET_DOLLARS}>
                {busy ? (inBonus ? 'Skip to total' : 'Stop') : bet ? `Spin · ${dollarsLabel(bet)}` : 'Add a chip to spin'}
              </button>
            </div>
          )}

          <button type="button" className={bet ? 'slot-bet has-bet' : 'slot-bet'} onClick={() => addChip(chip)} disabled={locked} aria-label={`Bet ${dollarsLabel(bet)} on all three lines. Tap to add a $${chip} chip.`}>
            <span className="slot-bet-label">{auto ? 'Bet locked while Auto runs' : `Bet · 3 lines · tap to add $${chip}`}</span>
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
            extra={
              <MaxBet
                spotName="your bet"
                currentCents={bet * 100}
                availableCents={balanceCents}
                disabled={locked}
                onPlace={(cents) => {
                  setError('');
                  setChipList((list) => [...list, ...chipsFor(cents)]);
                  return true;
                }}
                onRefuse={setError}
              />
            }
          />

          {!auto ? (
            <div className="vip-auto-row">
              <button type="button" className="btn auto-btn" onClick={() => setAutoOpen((v) => !v)} disabled={busy || bet < CASINO_MIN_BET_DOLLARS} aria-expanded={autoOpen}>
                Auto
              </button>
            </div>
          ) : null}

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

          <p className="muted small slot-help">One bet covers all three lines. {BET_HELP_TEXT}</p>
          {session.spins > 0 ? (
            <p className="muted small vip-session">
              This visit: {session.spins} spin{session.spins === 1 ? '' : 's'} · bet {formatMoney(session.bet)} · won {formatMoney(session.won)}
            </p>
          ) : null}
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
      )}

      <VipPaytableSheet open={paytableOpen && Boolean(pass)} onClose={closePaytable} betDollars={bet} hitIds={shown ? shown.lines.map((l) => l.id) : []} />
    </section>
  );
}
