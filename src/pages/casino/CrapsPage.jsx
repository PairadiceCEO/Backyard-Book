// Craps and Crapless Craps (one page, the variant comes from the route). Everything on screen comes from one live doc,
// casinoTables/{game}; every tap is a call to /api/casino.
//
// Look (0.18.0): the table is drawn like a real one (src/components/casino/CrapsFelt.jsx) and the page takes the whole
// screen (it covers the app's top bar and bottom tabs; ‹ goes back). Two layouts from the same DOM, switched by CSS
// alone (src/styles/craps.css), so turning the phone never remounts anything and the seat, the chips not yet sent and
// the open drawers all stay:
//   Upright  (orientation: portrait): top bar + status row, the felt stacked, and a dock at the bottom (wallet, message,
//            eight chips, Undo / Clear / Take down and Roll).
//   Sideways (landscape; computers too, sized up): one-row top bar, the felt on the left, a rail on the right (wallet,
//            chips, Undo / Clear / Take down, message, Roll).
// Seats, last rolls, Leave seat, help and the rules live in the "Table" sheet (a top-bar button, the chat drawer's sheet
// styles); on tall upright screens they sit under the felt instead (the only thing JS decides: one media query, removed
// on unmount).
//
// Betting is unchanged since 0.15.0: pick a chip and tap an area; the chip is on the felt at once, taps close together
// go to the server as one request (Undo / Clear take back chips placed since the last roll), "Take down" + tap takes a
// whole bet back. Roll carries the table's rollSeq, so a double tap can only roll once; the shooter's dice start
// tumbling the moment Roll is tapped and land on the result from the reply.
// No maximum bets (0.16.0): any whole-dollar amount the wallet covers; Odds stay at most 2× their line bet (a game rule).
// One seat per player here; leaving the page gives the seat up (useLeaveOnExit). No game rule lives in this file.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import CrapsFelt from '../../components/casino/CrapsFelt.jsx';
import { CHIP_VALUES } from '../../components/casino/Chips.jsx';
import { FeltChip } from '../../components/casino/FeltChip.jsx';
import Die from '../../components/casino/Die.jsx';
import TableSeats from '../../components/casino/TableSeats.jsx';
import { ErrorState, LoadingState, friendlyError, useOnlineStatus } from '../../components/StatusViews.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useWalletDisplay } from '../../context/WalletDisplayContext.jsx';
import { useCasinoTable, useCountdown, useDeadlineTick, useHeartbeat, useLeaveOnExit, useRollAnimation, useTableCall } from '../../hooks/useCasinoTable.js';
import { useChipBetting } from '../../hooks/useChipBetting.js';
import { useMediaQuery } from '../../hooks/useMediaQuery.js';
import { useCasinoChat } from '../../hooks/useCasinoChat.js';
import { ChatButton, ChatDrawer } from '../../components/casino/CasinoChat.jsx';
import SoundToggle from '../../components/casino/SoundToggle.jsx';
import { playSound } from '../../lib/casinoSound.js';
import { newRequestId } from '../../lib/casino.js';
import { ensureFeltFont } from '../../lib/feltFont.js';
import { formatMoney } from '../../lib/format.js';
import { DICE_ANIMATION_MS } from '../../../shared/casino/constants.js';
import { DICE_VARIANTS } from '../../../shared/casino/diceVariants.js';
import { BET_HELP_TEXT, chipName } from '../../../shared/casino/constants.js';
import { cloneBets, emptyDiceBets, limitProblem, placeBlocker, removeBlocker, spotAmount, spotLimitCents, totalOnFelt } from '../../../shared/casino/dice.js';
import '../../styles/craps.css';

const NO_SEATS = [null, null, null, null, null];
const KIND_TEXT = { natural: 'Winner!', craps: 'Craps', point: 'Point set', pointMade: 'Point made!', sevenOut: 'Seven out', roll: '' };
const ROLLING_MESSAGE = 'The dice are on their way. Bet again as soon as they land.';
// Tall upright screens have room under the felt for the seats, last rolls, help and rules; everywhere else they are in
// the Table sheet. (Everything else about the two layouts is plain CSS.)
export const INLINE_INFO_QUERY = '(orientation: portrait) and (min-height: 780px)';

function ratio([n, d]) {
  return `${n}:${d}`;
}

const FLAT_KINDS = ['pass', 'dontPass', 'odds', 'dontOdds', 'come', 'field'];

// The felt as chip spots: pass, dontPass, odds, dontOdds, come, field, place:6, hard:8, comeOdds:5 …
// (A Come bet that moved to its number isn't a spot: chips can't go on or come off it; its Odds can.)
function betsToSpots(bets) {
  const b = cloneBets(bets);
  const spots = {};
  for (const kind of FLAT_KINDS) spots[kind] = b[kind] || 0;
  for (const [n, cents] of Object.entries(b.place)) spots[`place:${n}`] = cents || 0;
  for (const [n, cents] of Object.entries(b.hard)) spots[`hard:${n}`] = cents || 0;
  for (const [n, c] of Object.entries(b.comeOn)) spots[`comeOdds:${n}`] = c.odds || 0;
  return spots;
}

// Spots back to bets, with the Come bets on numbers taken from the server's copy (`base`).
function spotsToBets(spots, base) {
  const bets = emptyDiceBets();
  const from = cloneBets(base);
  for (const [n, c] of Object.entries(from.comeOn)) bets.comeOn[n] = { bet: c.bet, odds: 0 };
  for (const [key, cents] of Object.entries(spots)) {
    const [kind, num] = key.split(':');
    if (num === undefined) bets[kind] = cents || 0;
    else if (kind === 'comeOdds') {
      if (bets.comeOn[num]) bets.comeOn[num].odds = cents || 0;
    } else if (cents > 0) bets[kind][Number(num)] = cents;
  }
  return bets;
}

function spotKey(kind, number) {
  return number === undefined ? kind : `${kind}:${number}`;
}

function signedMoney(cents) {
  if (cents > 0) return `+${formatMoney(cents)}`;
  if (cents < 0) return `−${formatMoney(-cents)}`;
  return formatMoney(0);
}

// Chip rack for the craps table: the eight chips in one row upright (two rows of four on the narrowest phones), 4 × 2 sideways
// (CSS decides).
function CrapsRack({ chip, takeDown, onChip, disabled }) {
  return (
    <div className="cs-rack" role="radiogroup" aria-label="Chip">
      {CHIP_VALUES.map((d) => {
        const active = !takeDown && chip === d;
        return (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${chipName(d)} chip`}
            className={active ? 'rack-chip active' : 'rack-chip'}
            onClick={() => onChip(d)}
            disabled={disabled}
          >
            <FeltChip dollars={d} />
          </button>
        );
      })}
    </div>
  );
}

// While the craps page is on screen the app's top bar and bottom tabs step aside (CSS on body); put back on exit.
function HideAppChrome() {
  useLayoutEffect(() => {
    document.body.classList.add('craps-stage-on');
    return () => document.body.classList.remove('craps-stage-on');
  }, []);
  return null;
}

// The "Table" sheet: the chat drawer's sheet over the page (it never moves the felt). Escape, the × and the backdrop close it.
function TableSheet({ title, onClose, children }) {
  const closeRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus({ preventScroll: true });
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <>
      <div className="chat-backdrop" role="presentation" onClick={onClose} />
      <section className="chat-drawer table-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <header className="chat-head">
          <h3>{title}</h3>
          <button ref={closeRef} type="button" className="icon-button" aria-label="Close table" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="table-sheet-body">{children}</div>
      </section>
    </>,
    document.body,
  );
}

export default function CrapsPage({ game }) {
  const variant = DICE_VARIANTS[game];
  const { authUser, profile } = useAuth();
  const myUid = authUser?.uid ?? null;
  const balanceCents = Number(profile?.balanceCents) || 0;
  const { setHeldCents, setPendingCents, reportBalance, displayCents } = useWalletDisplay();
  const { table, loading, error, accept } = useCasinoTable(game);
  const call = useTableCall(game, accept, reportBalance);

  const seats = table?.seats ?? NO_SEATS;
  const mySeatIndex = seats.findIndex((seat) => seat && seat.uid === myUid);
  const mySeat = mySeatIndex >= 0 ? seats[mySeatIndex] : null;
  const deadline = table?.deadline ?? null;
  const lastRoll = table?.lastRoll ?? null;

  const seconds = useCountdown(deadline);
  useDeadlineTick(game, deadline, { enabled: Boolean(table), call, phase: table?.phase ?? null });
  useHeartbeat(game, Boolean(mySeat));
  useLeaveOnExit(game, Boolean(mySeat));
  const tumbling = useRollAnimation(lastRoll?.at ?? null, DICE_ANIMATION_MS);
  const [rollTapped, setRollTapped] = useState(false); // the shooter's dice tumble from the tap
  const rolling = tumbling || rollTapped;

  const [chip, setChip] = useState(1);
  const [takeDown, setTakeDown] = useState(false);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const inlineInfo = useMediaQuery(INLINE_INFO_QUERY);
  const online = useOnlineStatus(); // the app's bars step aside on this page, so the offline banner is drawn here
  const chat = useCasinoChat(game); // Craps and Crapless each have their own room (0.17.0)
  const closeSheet = useCallback(() => setSheetOpen(false), []);

  useEffect(() => {
    ensureFeltFont();
  }, []);

  // 0.20.0 sounds: the dice rattle as they start to tumble and knock when they land; my win this roll chimes once they show.
  const wasRolling = useRef(rolling);
  const myRollNet = mySeat?.lastRoll && mySeat.lastRoll.seq === table?.rollSeq ? mySeat.lastRoll.netCents : 0;
  useEffect(() => {
    if (rolling === wasRolling.current) return;
    wasRolling.current = rolling;
    if (rolling) playSound('diceRattle');
    else {
      playSound('diceLand');
      if (myRollNet > 0) playSound('win');
    }
  }, [rolling, myRollNet]);

  useEffect(() => {
    call('tick').catch(() => {}); // through call: the reply's table shows at once
  }, [call]); // call is stable per game, so this still runs once per visit

  // While the dice tumble, the wallet stays where it was before the roll.
  const preRollRef = useRef(null);
  useEffect(() => {
    if (!rolling) preRollRef.current = balanceCents;
  }, [rolling, balanceCents]);
  const holdWallet = rolling && Boolean(mySeat);
  useEffect(() => {
    if (!holdWallet || preRollRef.current === null) return undefined;
    setHeldCents(preRollRef.current);
    return () => setHeldCents(null);
  }, [holdWallet, setHeldCents]);

  // ---- my chips: on the felt the moment I tap; taps close together go as one request ----
  const serverBets = mySeat?.bets ?? emptyDiceBets();
  const serverSpots = betsToSpots(serverBets);
  const tablePoint = table?.point ?? null;
  const validate = useCallback(
    (key, cents, after) => {
      if (!variant) return 'Unknown table.';
      const [kind, num] = key.split(':');
      const number = num === undefined ? undefined : Number(num);
      const afterBets = spotsToBets(after, serverBets);
      const beforeSpots = { ...after, [key]: (after[key] ?? 0) - cents };
      const blocked = placeBlocker(variant, tablePoint, spotsToBets(beforeSpots, serverBets), kind, number);
      if (blocked) return blocked;
      const problem = limitProblem(variant, afterBets, { kind, number });
      if (problem) return problem;
      const extra = totalOnFelt(afterBets) - totalOnFelt(serverBets);
      if (extra > balanceCents) return `Not enough in your wallet (${formatMoney(balanceCents)}).`;
      return '';
    },
    [variant, tablePoint, serverBets, balanceCents],
  );
  const sendChips = useCallback(
    (changes) =>
      call('bets', {
        changes: changes.map(({ spot, cents }) => {
          const [kind, num] = spot.split(':');
          return num === undefined ? { kind, cents } : { kind, number: Number(num), cents };
        }),
        requestId: newRequestId(),
      }),
    [call],
  );
  // 0.23.0: chips go down while the dice tumble too (the roll is already in the table: they are bets on the next roll). Only
  // between the shooter's Roll tap and the reply are they held back, with a message, since that roll isn't known yet.
  const canChip = Boolean(mySeat) && !mySeat.leaving && !rollTapped;
  const chips = useChipBetting({ spots: serverSpots, roundKey: table?.rollSeq ?? null, validate, send: sendChips, onPending: setPendingCents, enabled: canChip });

  async function run(kind, action, fields = {}) {
    setBusy(kind);
    setActionError('');
    try {
      return await call(action, fields);
    } catch (err) {
      if (err.code !== 'STALE') setActionError(friendlyError(err.message));
      return null;
    } finally {
      setBusy('');
    }
  }

  async function rollDice() {
    if (rollTapped || !table) return;
    const seq = table.rollSeq;
    setRollTapped(true); // tumble now; the reply (with the dice) usually lands well inside the animation
    await chips.flushNow();
    await run('roll', 'roll', { rollSeq: seq });
    setRollTapped(false);
  }

  if (!variant) return null;
  if (loading) return <LoadingState label={`Opening the ${variant.name} table…`} />;
  if (error) return <ErrorState title="Couldn't open the table" message={error} />;

  // While tumbling, show the table as it was before this roll.
  const point = tumbling ? lastRoll?.pointBefore ?? null : rollTapped ? tablePoint : table?.point ?? null;
  const shooterIndex = table?.shooter ?? null;
  const shooter = shooterIndex === null ? null : seats[shooterIndex];
  const iShoot = Boolean(mySeat) && shooterIndex === mySeatIndex;
  const myBets = spotsToBets(chips.spots, serverBets);
  const hasLine = myBets.pass > 0 || myBets.dontPass > 0;
  const oddsMax = spotLimitCents(variant, myBets, 'odds');
  const dontOddsMax = spotLimitCents(variant, myBets, 'dontOdds');
  const onFelt = totalOnFelt(myBets);
  const walletCents = displayCents(balanceCents);

  function tapSpot(kind, number) {
    if (!mySeat) return;
    if (rollTapped) {
      setActionError(ROLLING_MESSAGE);
      return;
    }
    if (takeDown) {
      if (!spotAmount(serverBets, kind, number)) return;
      const blocked = removeBlocker(tablePoint, kind);
      if (blocked) {
        setActionError(blocked);
        return;
      }
      run(`down-${spotKey(kind, number)}`, 'removeBet', number === undefined ? { kind } : { kind, number });
      return;
    }
    setActionError('');
    chips.place(spotKey(kind, number), chip * 100);
  }

  // An area that can't take a bet right now keeps the old "blocked" look; tapping it says why (the reason comes from chips.place).
  const blockedOf = (kind, number) =>
    takeDown ? !spotAmount(myBets, kind, number) || Boolean(removeBlocker(table?.point ?? null, kind)) : Boolean(placeBlocker(variant, table?.point ?? null, myBets, kind, number));

  function seatDetail(seat, i) {
    const showResult = !rolling && seat.lastRoll && seat.lastRoll.seq === table?.rollSeq;
    const prefix = i === shooterIndex ? '🎲 ' : '';
    if (showResult) {
      const net = seat.lastRoll.netCents;
      return { text: `${prefix}${net === 0 ? 'even' : signedMoney(net)}`, tone: net > 0 ? 'win' : net < 0 ? 'lose' : i === shooterIndex ? 'active' : '' };
    }
    const felt = totalOnFelt(seat.bets);
    return { text: `${prefix}${felt ? formatMoney(felt) : '—'}`, tone: i === shooterIndex ? 'active' : '' };
  }

  let status;
  if (!table || !seats.some(Boolean)) status = 'Waiting for players';
  else if (rolling) status = `${lastRoll && seats[lastRoll.shooter] ? `${seats[lastRoll.shooter].uid === myUid ? 'You' : seats[lastRoll.shooter].name}` : 'Shooter'} rolling…`;
  else if (table.waiting) status = 'Nobody has the dice: bet a line to shoot';
  else if (iShoot && !hasLine) status = `Your dice: bet Pass${variant.dontPass ? " or Don't Pass" : ''} to roll`;
  else status = `${point ? '' : 'Come-out · '}Shooter: ${shooter ? (shooter.uid === myUid ? 'you' : shooter.name) : 'nobody'}`; // the puck shows the point

  const lastKind = lastRoll && !rolling ? KIND_TEXT[lastRoll.kind] : '';
  const firstOpen = seats.findIndex((s) => !s);
  const message = chips.error || actionError;
  const hint = rolling ? '' : takeDown ? 'Tap a bet to take it down.' : iShoot && !hasLine ? `Bet Pass${variant.dontPass ? " or Don't Pass" : ''} to roll.` : '';
  const players = seats.filter(Boolean).length;

  const rollButton = iShoot ? (
    <button type="button" className="btn btn-primary craps-roll-btn" disabled={!hasLine || rolling} onClick={rollDice} title={hasLine ? undefined : status}>
      {rolling ? 'Rolling…' : 'Roll'}
    </button>
  ) : null;

  const rollArea = mySeat ? (
    rollButton ?? (
      <p className="cs-wait" role="status">
        {status}
      </p>
    )
  ) : firstOpen >= 0 ? (
    <button type="button" className="btn btn-primary craps-sit-btn" onClick={() => run('sit', 'sit', { seat: firstOpen })} disabled={busy === 'sit'}>
      {busy === 'sit' ? 'Sitting…' : 'Sit down'}
    </button>
  ) : (
    <span className="craps-full">Table full</span>
  );

  // Seats, last rolls, Leave seat, help and rules: in the Table sheet, or under the felt on tall upright screens.
  const tableInfo = (
    <>
      <p className="cs-info-status">{status}</p>
      <TableSeats seats={seats} myUid={myUid} canSit={!mySeat} sitting={busy === 'sit'} onSit={(seat) => run('sit', 'sit', { seat })} detail={seatDetail} />

      <div className="card">
        <h3 className="small-heading">Last rolls</h3>
        {table?.rolls?.length ? (
          <ol className="craps-rolls" aria-label="Last rolls, oldest first">
            {(rolling ? table.rolls.slice(0, -1) : table.rolls).map((r, i) => (
              <li key={i} className={r.t === 7 ? 'roll-chip seven' : r.k === 'pointMade' ? 'roll-chip made' : 'roll-chip'}>
                {r.t}
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted small history-empty">No rolls yet.</p>
        )}
      </div>

      {mySeat ? (
        <button type="button" className="btn btn-ghost small leave-btn" onClick={() => run('leave', 'leave')} disabled={busy === 'leave' || mySeat.leaving}>
          {mySeat.leaving ? 'Leaving' : 'Leave seat'}
        </button>
      ) : (
        <div className="card watch-note">
          <strong>You're watching.</strong>
          <span className="muted small">{firstOpen >= 0 ? 'Tap Sit down, or an empty seat, to play.' : 'All 5 seats are taken. You can keep watching.'}</span>
        </div>
      )}

      <p className="muted small bac-help">
        {mySeat?.leaving
          ? 'You are leaving: line, Come and Odds bets play out, then the seat frees and Place, Field and Hard ways come back.'
          : takeDown
            ? 'Take down: tap one of your bets to take all of it down (Pass and Don’t Pass stay up once a Point is set; a Come bet on its number stays, its Odds can come down).'
            : `Pick a chip and tap a bet on the table; each tap adds a chip. ${BET_HELP_TEXT} Odds up to ${variant.oddsMultiple}× their line bet. A Come bet on its number shows as a chip marked C; tap it to add Odds.`}
      </p>

      <p className="muted small table-rules">
        {game === 'crapless'
          ? 'Come-out: 7 wins; every other number becomes the Point (no craps, no Don’t Pass). '
          : 'Come-out: 7 or 11 wins, 2, 3 or 12 loses; Don’t Pass wins on 2 or 3 and pushes on 12. '}
        Pass, Don’t Pass and Come pay 1:1. Odds pay true odds ({variant.points.map((n) => `${n} ${ratio(variant.odds[n])}`).join(', ')}), up to{' '}
        {variant.oddsMultiple}× their line bet{variant.dontPass ? '; Don’t Pass Odds pay the inverse' : ''}. Come bets work like a new Pass bet on the
        next roll ({variant.comeOutPassWins.join(' or ')} wins{variant.comeOutPassLoses.length ? `, ${variant.comeOutPassLoses.join(', ')} loses` : ''}), then
        move to their number; Come Odds are off on the come-out. Place bets pay {variant.points.map((n) => `${n} ${ratio(variant.place[n])}`).join(', ')} and,
        go up any time; like Hard ways, they are OFF on the come-out (a come-out roll never wins or loses them) and work once a Point is set. Field: 3, 4, 9, 10, 11 pay 1:1; 2 and 12 pay 2:1. Hard 4 and 10 pay {ratio(variant.hardWays[4])}, Hard 6
        and 8 pay {ratio(variant.hardWays[6])} and stay up after a win. With 2 or more players the shooter has 30 s to roll, then the dice roll themselves;
        a player alone rolls when they tap Roll. One seat per player.
      </p>
    </>
  );

  return (
    <section className={['craps-stage', mySeat ? 'seated' : 'watching', rolling ? 'is-rolling' : '', online ? '' : 'is-offline'].filter(Boolean).join(' ')} data-game={game}>
      <HideAppChrome />
      {online ? null : (
        <div className="offline-banner cs-offline" role="status">
          You're offline. Bets and rolls will update when you're back online.
        </div>
      )}

      <header className="craps-bar cs-top">
        <Link to="/casino" className="cs-back" aria-label="Back to the casino">
          ‹
        </Link>
        <h2 className="cs-name">{variant.name}</h2>

        <div className="cs-status">
          <span className={point ? 'cs-point on' : 'cs-point'} aria-label={point ? `Puck on ${point}` : 'Puck off'}>
            <span className="cs-puck">{point ? 'ON' : 'OFF'}</span>
            <span className="cs-point-text">{point ? `Point ${point}` : 'Come-out'}</span>
          </span>
          <span className="craps-dice">
            <Die value={lastRoll?.dice?.[0] ?? 1} rolling={rolling} />
            <Die value={lastRoll?.dice?.[1] ?? 1} rolling={rolling} />
          </span>
          <span className="cs-rolled" aria-live="polite">
            {lastRoll ? (
              rolling ? (
                <span className="craps-roll-text">Rolling…</span>
              ) : (
                <>
                  <span className="craps-roll-text">
                    <span className="roll-total">{lastRoll.total}</span>
                    <span className="roll-word">Rolled</span>
                  </span>
                  {lastKind ? <span className="cs-kind">{lastKind}</span> : null}
                </>
              )
            ) : (
              <span className="craps-roll-text">No rolls yet</span>
            )}
          </span>
          <span className="cs-shooter" role="status" title={status}>
            {status}
          </span>
        </div>

        <div className="cs-meta">
          <span className="cs-players" aria-label={`${players} ${players === 1 ? 'player' : 'players'} at the table`}>
            <span aria-hidden="true">👥</span> {players}
          </span>
          {deadline && !rolling ? (
            <span className={seconds !== null && seconds <= 5 ? 'cs-count urgent' : 'cs-count'} aria-label={`${seconds ?? 0} seconds to roll`}>
              {seconds ?? 0}
            </span>
          ) : null}
          {inlineInfo ? null : (
            <button type="button" className="btn cs-table-btn" aria-haspopup="dialog" aria-expanded={sheetOpen} onClick={() => setSheetOpen(true)}>
              Table
            </button>
          )}
          <SoundToggle className="cs-sound" />
          <ChatButton chat={chat} compact />
        </div>
      </header>

      <div className={rolling ? 'cs-felt-wrap dim' : 'cs-felt-wrap'}>
        <CrapsFelt
          variant={variant}
          point={point}
          bets={myBets}
          takeDown={takeDown}
          oddsMax={oddsMax}
          dontOddsMax={dontOddsMax}
          blockedOf={blockedOf}
          onTap={tapSpot}
          disabled={!mySeat}
        />
      </div>

      <aside className="cs-rail" aria-label="Chips and rolling">
        <div className="cs-money" aria-live="polite">
          <span className="cs-bal">
            Wallet <strong>{formatMoney(walletCents)}</strong>
          </span>
          <span className="craps-meter">
            On the felt <strong>{formatMoney(onFelt)}</strong>
          </span>
        </div>
        {mySeat ? (
          <>
            <CrapsRack
              chip={chip}
              takeDown={takeDown}
              disabled={!canChip}
              onChip={(d) => {
                setChip(d);
                setTakeDown(false);
              }}
            />
            <div className="cs-tools">
              <button type="button" className="btn" onClick={chips.undo} disabled={!canChip || !chips.canUndo}>
                Undo
              </button>
              <button type="button" className="btn" onClick={chips.clear} disabled={!canChip || !chips.canUndo}>
                Clear
              </button>
              <button type="button" aria-pressed={takeDown} className={takeDown ? 'btn take-down active' : 'btn take-down'} onClick={() => setTakeDown((v) => !v)} disabled={!canChip}>
                Take down
              </button>
            </div>
          </>
        ) : null}
        <p className={message ? 'cs-msg error' : 'cs-msg'} role={message ? 'alert' : undefined}>
          {message || hint || (mySeat ? '' : 'You are watching.')}
        </p>
        <div className="cs-roll">{rollArea}</div>
      </aside>

      {inlineInfo ? <div className="cs-info">{tableInfo}</div> : null}
      {!inlineInfo && sheetOpen ? (
        <TableSheet title={`${variant.name} table`} onClose={closeSheet}>
          {tableInfo}
        </TableSheet>
      ) : null}

      <ChatDrawer chat={chat} />
    </section>
  );
}
