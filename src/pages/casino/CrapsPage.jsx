// Craps and Crapless Craps (one page, the variant comes from the route). Everything on screen comes
// from one live doc, casinoTables/{game}; every tap is a call to /api/casino.
//
// Layout (0.15.0), built so betting, taking down and rolling never need a scroll:
//   1. one compact bar: the puck (ON 6 / OFF), the two dice and the last total, the countdown, and Roll when it's my
//      turn (or "Sit down" / "Table full" for a player who isn't seated);
//   2. the betting interface: the six chips, then "On the felt $X" + Take down + Undo / Clear, and every spot (Pass, Odds,
//      Don't Pass and its Odds, Come, Come bets on their numbers with their Odds, Place numbers, Field, Hard ways)
//      in dense grids; two columns on a computer;
//   3. below it: the seats, the last rolls, Leave seat, the help text and the rules.
// On a short screen (max-height 620px, e.g. 320×568) the chip rack, Take down and Roll move into a bar fixed above the
// bottom nav (DOCK_QUERY, via useMediaQuery: a media-query subscription that is removed on unmount); the spots scroll.
//
// Pick a chip and tap a spot: the chip is on the felt at once, and taps close together go to the server
// as one request (Undo / Clear take back chips placed since the last roll). "Take down" + tap takes a
// whole bet back. Roll carries the table's rollSeq, so a double tap can only roll once; the shooter's
// dice start tumbling the moment Roll is tapped and land on the result from the reply.
// No maximum bets (0.16.0): any whole-dollar amount the wallet covers; Odds stay at most 2× their line bet (a game rule).
// One seat per player here; leaving the page gives the seat up (useLeaveOnExit). No game rule lives in this file.

import { useCallback, useEffect, useRef, useState } from 'react';
import { CHIP_VALUES, ChipToken } from '../../components/casino/Chips.jsx';
import { Link } from 'react-router-dom';
import Die from '../../components/casino/Die.jsx';
import TableSeats from '../../components/casino/TableSeats.jsx';
import { ErrorState, LoadingState, friendlyError } from '../../components/StatusViews.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useWalletDisplay } from '../../context/WalletDisplayContext.jsx';
import { useCasinoTable, useCountdown, useDeadlineTick, useHeartbeat, useLeaveOnExit, useRollAnimation, useTableCall } from '../../hooks/useCasinoTable.js';
import { useChipBetting } from '../../hooks/useChipBetting.js';
import { useMediaQuery } from '../../hooks/useMediaQuery.js';
import { useCasinoChat } from '../../hooks/useCasinoChat.js';
import { ChatButton, ChatDrawer } from '../../components/casino/CasinoChat.jsx';
import { newRequestId } from '../../lib/casino.js';
import { formatMoney } from '../../lib/format.js';
import { DICE_ANIMATION_MS } from '../../../shared/casino/constants.js';
import { DICE_VARIANTS } from '../../../shared/casino/diceVariants.js';
import { BET_HELP_TEXT } from '../../../shared/casino/constants.js';
import { cloneBets, emptyDiceBets, limitProblem, placeBlocker, removeBlocker, spotAmount, spotLimitCents, totalOnFelt } from '../../../shared/casino/dice.js';

const NO_SEATS = [null, null, null, null, null];
const KIND_TEXT = { natural: 'Winner!', craps: 'Craps', point: 'Point set', pointMade: 'Point made!', sevenOut: 'Seven out', roll: '' };
// Short screens: chip rack, Take down and Roll go into a bar fixed at the bottom.
export const DOCK_QUERY = '(max-height: 620px)';

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

// A spot's amount as one short line: whole dollars without cents ("$15"; chips are whole dollars), or a placeholder.
function shortMoney(cents) {
  return cents % 100 === 0 ? `$${cents / 100}` : formatMoney(cents);
}

function amountText(cents, empty = '') {
  return cents ? shortMoney(cents) : empty;
}

// Chip rack for the craps table: the six chips in one row (Take down sits with Undo / Clear, or in the dock).
function CrapsRack({ chip, takeDown, onChip, disabled }) {
  return (
    <div className="craps-rack-chips" role="radiogroup" aria-label="Chip">
      {CHIP_VALUES.map((d) => (
        <button
          key={d}
          type="button"
          role="radio"
          aria-checked={!takeDown && chip === d}
          aria-label={`$${d} chip`}
          className={!takeDown && chip === d ? 'chip-pick active' : 'chip-pick'}
          onClick={() => onChip(d)}
          disabled={disabled}
        >
          <ChipToken dollars={d} />
        </button>
      ))}
    </div>
  );
}

function TakeDownButton({ takeDown, onToggle, disabled }) {
  return (
    <button type="button" aria-pressed={takeDown} className={takeDown ? 'btn take-down active' : 'btn take-down'} onClick={onToggle} disabled={disabled}>
      Take down
    </button>
  );
}

export default function CrapsPage({ game }) {
  const variant = DICE_VARIANTS[game];
  const { authUser, profile } = useAuth();
  const myUid = authUser?.uid ?? null;
  const balanceCents = Number(profile?.balanceCents) || 0;
  const { setHeldCents, setPendingCents, reportBalance } = useWalletDisplay();
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
  const docked = useMediaQuery(DOCK_QUERY);
  const chat = useCasinoChat(game); // Craps and Crapless each have their own room (0.17.0)

  useEffect(() => {
    call('tick').catch(() => {}); // through call: the reply's table shows at once
  }, [call]); // call is stable per game, so this still runs once per visit

  // While the dice tumble, the nav wallet stays where it was before the roll.
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
  const canChip = Boolean(mySeat) && !mySeat.leaving && !rolling;
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
  const placeNumbers = variant.points;
  const oddsMax = spotLimitCents(variant, myBets, 'odds');
  const dontOddsMax = spotLimitCents(variant, myBets, 'dontOdds');
  const onFelt = totalOnFelt(myBets);
  const comeNumbers = placeNumbers.filter((n) => myBets.comeOn[n]);

  function tapSpot(kind, number) {
    if (!mySeat || rolling) return;
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
  const oddsRatio = point ? variant.odds[point] : null;
  const firstOpen = seats.findIndex((s) => !s);
  const message = chips.error || actionError;

  const spotClass = (kind, number, extra = '') => {
    const mine = spotAmount(myBets, kind, number);
    const blocked = takeDown ? !mine || removeBlocker(table?.point ?? null, kind) : placeBlocker(variant, table?.point ?? null, myBets, kind, number);
    return ['craps-spot', extra, mine ? 'has-bet' : '', blocked ? 'blocked' : ''].filter(Boolean).join(' ');
  };

  // One spot button: a name, an optional short sub-line (payout or limit) and the amount on it.
  const spot = ({ kind, number, name, sub = '', extra = '', aria, cents }) => (
    <button
      key={spotKey(kind, number)}
      type="button"
      className={spotClass(kind, number, extra)}
      onClick={() => tapSpot(kind, number)}
      aria-label={`${aria ?? name}${cents ? `, ${formatMoney(cents)} on it` : ''}`}
    >
      <span className="spot-name">{name}</span>
      {sub ? <span className="spot-odds">{sub}</span> : null}
      <span className="spot-bet">{amountText(cents)}</span>
    </button>
  );

  const rollButton = iShoot ? (
    <button type="button" className="btn btn-primary craps-roll-btn" disabled={!hasLine || rolling} onClick={rollDice} title={hasLine ? undefined : status}>
      {rolling ? 'Rolling…' : 'Roll'}
    </button>
  ) : null;

  const rack = mySeat ? (
    <CrapsRack
      chip={chip}
      takeDown={takeDown}
      disabled={!canChip}
      onChip={(d) => {
        setChip(d);
        setTakeDown(false);
      }}
    />
  ) : null;
  const takeDownButton = mySeat ? <TakeDownButton takeDown={takeDown} onToggle={() => setTakeDown((v) => !v)} disabled={!canChip} /> : null;

  const lineSpots = [
    spot({ kind: 'pass', name: 'Pass', extra: 'line pass', aria: 'Pass Line, pays 1:1', cents: myBets.pass }),
    spot({
      kind: 'odds',
      name: point ? `Odds ${point}` : 'Odds',
      sub: oddsRatio ? ratio(oddsRatio) : 'after point',
      extra: 'line odds',
      aria: point ? `Odds on ${point}, pays ${oddsRatio ? ratio(oddsRatio) : ''}, at most ${formatMoney(oddsMax)} (2× Pass)` : 'Odds behind Pass, once a Point is set',
      cents: myBets.odds,
    }),
  ];
  if (variant.dontPass) {
    lineSpots.push(
      spot({ kind: 'dontPass', name: "Don't", sub: 'Pass', extra: 'line dont', aria: "Don't Pass, pays 1:1, 12 pushes", cents: myBets.dontPass }),
      spot({
        kind: 'dontOdds',
        name: "Don't Odds",
        sub: oddsRatio ? ratio([oddsRatio[1], oddsRatio[0]]) : 'after point',
        extra: 'line odds dont',
        aria: point ? `Don't Pass Odds on ${point}, at most ${formatMoney(dontOddsMax)} (2× Don't Pass)` : "Don't Pass Odds, once a Point is set",
        cents: myBets.dontOdds,
      }),
    );
  }
  const comeSpot = spot({ kind: 'come', name: 'Come', sub: point ? '' : 'after point', extra: 'line come', aria: 'Come, pays 1:1', cents: myBets.come });
  const fieldSpot = spot({ kind: 'field', name: 'Field', sub: '2·12 ×2', extra: 'field', aria: 'Field: 3, 4, 9, 10, 11 pay 1:1; 2 and 12 pay 2:1', cents: myBets.field });

  return (
    <section className={docked && mySeat ? 'page table-page craps-page docked' : 'page table-page craps-page'}>
      <h2 className="visually-hidden">{variant.name}</h2>

      <div className="card craps-bar">
        <span className={point ? 'puck on' : 'puck'} aria-label={point ? `Puck on ${point}` : 'Puck off'}>
          {point ? `ON ${point}` : 'OFF'}
        </span>
        <span className="craps-dice">
          <Die value={lastRoll?.dice?.[0] ?? 1} rolling={rolling} />
          <Die value={lastRoll?.dice?.[1] ?? 1} rolling={rolling} />
        </span>
        <span className="craps-bar-text">
          <span className="craps-roll-text" aria-live="polite">
            {lastRoll ? (rolling ? 'Rolling…' : `${lastRoll.total}${lastKind ? ` · ${lastKind}` : ''}`) : 'No rolls yet'}
          </span>
          <span className="craps-bar-status" role="status" title={status}>
            {status}
          </span>
        </span>
        {deadline && !rolling ? (
          <span className={seconds !== null && seconds <= 5 ? 'countdown urgent' : 'countdown'} aria-label={`${seconds ?? 0} seconds to roll`}>
            {seconds ?? 0}
          </span>
        ) : null}
        {docked ? null : rollButton}
        {!mySeat ? (
          firstOpen >= 0 ? (
            <button type="button" className="btn btn-primary craps-sit-btn" onClick={() => run('sit', 'sit', { seat: firstOpen })} disabled={busy === 'sit'}>
              {busy === 'sit' ? 'Sitting…' : 'Sit down'}
            </button>
          ) : (
            <span className="craps-full">Table full</span>
          )
        ) : null}
        <ChatButton chat={chat} compact />
      </div>

      {mySeat ? (
        <div className={rolling ? 'card craps-felt dim' : 'card craps-felt'}>
          {message ? (
            <p className="craps-toast" role="alert">
              {message}
            </p>
          ) : null}
          <div className="craps-col">
            {docked ? null : rack}
            <div className={docked ? 'craps-tools no-take-down' : 'craps-tools'}>
              <div className="craps-meter" aria-live="polite">
                On the felt <strong>{formatMoney(onFelt)}</strong>
              </div>
              {docked ? null : takeDownButton}
              <button type="button" className="btn" onClick={chips.undo} disabled={!canChip || !chips.canUndo}>
                Undo
              </button>
              <button type="button" className="btn" onClick={chips.clear} disabled={!canChip || !chips.canUndo}>
                Clear
              </button>
            </div>
            {variant.dontPass ? (
              <>
                <div className="craps-grid cols-4 craps-lines">{lineSpots}</div>
                <div className="craps-grid cols-2">
                  {comeSpot}
                  {fieldSpot}
                </div>
              </>
            ) : (
              <div className="craps-grid cols-4 craps-lines">
                {lineSpots}
                {comeSpot}
                {fieldSpot}
              </div>
            )}
          </div>

          <div className="craps-col">
            <div className={`craps-grid craps-place n${placeNumbers.length}`} aria-label="Place numbers">
              {placeNumbers.map((n) =>
                spot({
                  kind: 'place',
                  number: n,
                  name: String(n),
                  sub: ratio(variant.place[n]),
                  extra: point === n ? 'is-point' : '',
                  aria: `Place ${n}, pays ${ratio(variant.place[n])}${point ? '' : ', off on the come-out'}`,
                  cents: spotAmount(myBets, 'place', n),
                }),
              )}
            </div>

            {comeNumbers.length ? (
              <div className={`craps-grid craps-come-row n${placeNumbers.length}`} aria-label="Your Come bets">
                {comeNumbers.map((n) =>
                  spot({
                    kind: 'comeOdds',
                    number: n,
                    name: String(n),
                    sub: `Come ${shortMoney(myBets.comeOn[n].bet)}${point ? '' : ' off'}`,
                    extra: 'come-on',
                    aria: `Come bet ${formatMoney(myBets.comeOn[n].bet)} on ${n}; tap for Odds (${ratio(variant.odds[n])}, at most ${formatMoney(spotLimitCents(variant, myBets, 'comeOdds', n))})`,
                    cents: myBets.comeOn[n].odds,
                  }),
                )}
              </div>
            ) : null}

            <div className="craps-grid cols-4 craps-hard" aria-label="Hard ways">
              {Object.keys(variant.hardWays).map((key) => {
                const n = Number(key);
                return spot({
                  kind: 'hard',
                  number: n,
                  name: `Hard ${n}`,
                  sub: ratio(variant.hardWays[n]),
                  aria: `Hard ${n} (${n / 2} and ${n / 2}), pays ${ratio(variant.hardWays[n])}`,
                  cents: spotAmount(myBets, 'hard', n),
                });
              })}
            </div>
          </div>
        </div>
      ) : null}

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
          <span className="muted small">{firstOpen >= 0 ? 'Tap Sit down above, or an empty seat, to play.' : 'All 5 seats are taken. You can keep watching.'}</span>
        </div>
      )}

      <p className="muted small bac-help">
        {mySeat?.leaving
          ? 'You are leaving: line, Come and Odds bets play out, then the seat frees and Place, Field and Hard ways come back.'
          : takeDown
            ? 'Take down: tap one of your bets to take all of it down (Pass and Don’t Pass stay up once a Point is set; a Come bet on its number stays, its Odds can come down).'
            : `Pick a chip and tap a spot; each tap adds a chip. ${BET_HELP_TEXT} Odds up to ${variant.oddsMultiple}× their line bet.`}
      </p>

      <p className="muted small table-rules">
        {game === 'crapless'
          ? 'Come-out: 7 wins; every other number becomes the Point (no craps, no Don’t Pass). '
          : 'Come-out: 7 or 11 wins, 2, 3 or 12 loses; Don’t Pass wins on 2 or 3 and pushes on 12. '}
        Pass, Don’t Pass and Come pay 1:1. Odds pay true odds ({placeNumbers.map((n) => `${n} ${ratio(variant.odds[n])}`).join(', ')}), up to{' '}
        {variant.oddsMultiple}× their line bet{variant.dontPass ? '; Don’t Pass Odds pay the inverse' : ''}. Come bets work like a new Pass bet on the
        next roll ({variant.comeOutPassWins.join(' or ')} wins{variant.comeOutPassLoses.length ? `, ${variant.comeOutPassLoses.join(', ')} loses` : ''}), then
        move to their number; Come Odds are off on the come-out. Place bets pay {placeNumbers.map((n) => `${n} ${ratio(variant.place[n])}`).join(', ')} and,
        like Hard ways, are off on the come-out. Field: 3, 4, 9, 10, 11 pay 1:1; 2 and 12 pay 2:1. Hard 4 and 10 pay {ratio(variant.hardWays[4])}, Hard 6
        and 8 pay {ratio(variant.hardWays[6])} and stay up after a win. With 2 or more players the shooter has 30 s to roll, then the dice roll themselves;
        a player alone rolls when they tap Roll. One seat per player.
      </p>

      <Link to="/casino" className="btn btn-ghost small craps-back">
        ‹ Casino
      </Link>

      {docked && mySeat ? (
        <div className="craps-dock">
          {rack}
          <div className={rollButton ? 'craps-dock-row' : 'craps-dock-row solo'}>
            {takeDownButton}
            {rollButton}
          </div>
        </div>
      ) : null}

      <ChatDrawer chat={chat} />
    </section>
  );
}
