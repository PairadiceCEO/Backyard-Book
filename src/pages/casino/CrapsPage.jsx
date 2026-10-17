// Craps and Crapless Craps (one page, the variant comes from the route). Everything on screen comes
// from one live doc, casinoTables/{game}; every tap is a call to /api/casino. Top to bottom: status,
// point and countdown, the dice, the seats, the last rolls, then (when seated) the felt and buttons.
//
// Pick a chip and tap a spot: the chip is on the felt at once, and taps close together go to the server
// as one request (Undo / Clear take back chips placed since the last roll). "Take down" + tap takes a
// whole bet back. Roll carries the table's rollSeq, so a double tap can only roll once; the shooter's
// dice start tumbling the moment Roll is tapped and land on the result from the reply.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChipRack, ChipStack } from '../../components/casino/Chips.jsx';
import { Link } from 'react-router-dom';
import Die from '../../components/casino/Die.jsx';
import TableSeats from '../../components/casino/TableSeats.jsx';
import { ErrorState, LoadingState, friendlyError } from '../../components/StatusViews.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useWalletDisplay } from '../../context/WalletDisplayContext.jsx';
import { useCasinoTable, useCountdown, useDeadlineTick, useHeartbeat, useRollAnimation, useTableCall } from '../../hooks/useCasinoTable.js';
import { useChipBetting } from '../../hooks/useChipBetting.js';
import { newRequestId, tableAction } from '../../lib/casino.js';
import { formatMoney } from '../../lib/format.js';
import { DICE_ANIMATION_MS } from '../../../shared/casino/constants.js';
import { DICE_VARIANTS } from '../../../shared/casino/diceVariants.js';
import { emptyDiceBets, placeBlocker, removeBlocker, spotAmount, spotLimitCents, totalOnFelt } from '../../../shared/casino/dice.js';

const NO_SEATS = [null, null, null, null, null];
const KIND_TEXT = { natural: 'Winner!', craps: 'Craps', point: 'Point set', pointMade: 'Point made!', sevenOut: 'Seven out', roll: '' };

function ratio([n, d]) {
  return `${n}:${d}`;
}

// The felt as chip spots: pass, dontPass, odds, field, place:6 …
function betsToSpots(bets) {
  const spots = { pass: bets.pass || 0, dontPass: bets.dontPass || 0, odds: bets.odds || 0, field: bets.field || 0 };
  for (const [n, cents] of Object.entries(bets.place ?? {})) spots[`place:${n}`] = cents || 0;
  return spots;
}

function spotsToBets(spots) {
  const bets = emptyDiceBets();
  for (const [key, cents] of Object.entries(spots)) {
    if (key.startsWith('place:')) {
      if (cents > 0) bets.place[Number(key.slice(6))] = cents;
    } else bets[key] = cents || 0;
  }
  return bets;
}

function spotKey(kind, number) {
  return kind === 'place' ? `place:${number}` : kind;
}

function signedMoney(cents) {
  if (cents > 0) return `+${formatMoney(cents)}`;
  if (cents < 0) return `−${formatMoney(-cents)}`;
  return formatMoney(0);
}

function SpotAmount({ cents }) {
  return (
    <span className="spot-bet spot-chips">
      {cents ? <ChipStack cents={cents} max={5} /> : null}
      {cents ? formatMoney(cents) : '—'}
    </span>
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
  useDeadlineTick(game, deadline, Boolean(table));
  useHeartbeat(game, Boolean(mySeat));
  const tumbling = useRollAnimation(lastRoll?.at ?? null, DICE_ANIMATION_MS);
  const [rollTapped, setRollTapped] = useState(false); // the shooter's dice tumble from the tap
  const rolling = tumbling || rollTapped;

  const [chip, setChip] = useState(1);
  const [takeDown, setTakeDown] = useState(false);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    tableAction(game, 'tick').catch(() => {});
  }, [game]);

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
      const afterBets = spotsToBets(after);
      const before = { ...afterBets, place: { ...afterBets.place } };
      const blocked = placeBlocker(variant, tablePoint, before, kind, number);
      if (blocked) return blocked;
      const limit = spotLimitCents(variant, afterBets, kind);
      if (cents > limit) return kind === 'odds' ? `Odds can be up to ${formatMoney(limit)} (${variant.oddsMultiple}× your Pass).` : `That spot holds up to ${formatMoney(limit)}.`;
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
  const myBets = spotsToBets(chips.spots);
  const hasLine = myBets.pass > 0 || myBets.dontPass > 0;
  const placeNumbers = variant.points;
  const oddsMax = spotLimitCents(variant, myBets, 'odds');

  function tapSpot(kind, number) {
    if (!mySeat || rolling) return;
    if (takeDown) {
      if (!spotAmount(serverBets, kind, number)) return;
      const blocked = removeBlocker(tablePoint, kind);
      if (blocked) {
        setActionError(blocked);
        return;
      }
      run(`down-${kind}${number ?? ''}`, 'removeBet', number === undefined ? { kind } : { kind, number });
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
  if (!table || !seats.some(Boolean)) status = 'Waiting for players. Take a seat to start.';
  else if (rolling) status = `${lastRoll && seats[lastRoll.shooter] ? `${seats[lastRoll.shooter].uid === myUid ? 'You' : seats[lastRoll.shooter].name}` : 'Shooter'} rolling…`;
  else if (table.waiting) status = 'Nobody has the dice. Bet a line to shoot.';
  else status = point ? `Point is ${point}` : 'Come-out roll';

  const shooterName = shooter ? (shooter.uid === myUid ? 'You' : shooter.name) : 'nobody';
  const lastKind = lastRoll && !rolling ? KIND_TEXT[lastRoll.kind] : '';
  const oddsRatio = point ? variant.odds[point] : null;

  const spotClass = (kind, number, extra = '') => {
    const mine = spotAmount(myBets, kind, number);
    const blocked = takeDown ? !mine || removeBlocker(table?.point ?? null, kind) : placeBlocker(variant, table?.point ?? null, myBets, kind, number);
    return ['craps-spot', extra, mine ? 'has-bet' : '', blocked ? 'blocked' : ''].filter(Boolean).join(' ');
  };

  return (
    <section className="page table-page">
      <div className="slots-top">
        <Link to="/casino" className="btn btn-ghost small">
          ‹ Casino
        </Link>
        <h2 className="section-title">{variant.name}</h2>
      </div>

      <div className="card table-status craps-status" role="status">
        <span className={point ? 'puck on' : 'puck'} aria-label={point ? `Puck on ${point}` : 'Puck off'}>
          {point ? `ON ${point}` : 'OFF'}
        </span>
        <span className="craps-status-text">
          <span className="table-status-text">{status}</span>
          <span className="muted small">Shooter: {shooterName}</span>
        </span>
        {deadline && !rolling ? (
          <span className={seconds !== null && seconds <= 5 ? 'countdown urgent' : 'countdown'} aria-hidden="true">
            {seconds ?? 0}
          </span>
        ) : null}
      </div>

      <div className="card craps-dice-card">
        <div className="craps-dice">
          <Die value={lastRoll?.dice?.[0] ?? 1} rolling={rolling} />
          <Die value={lastRoll?.dice?.[1] ?? 1} rolling={rolling} />
        </div>
        <div className="craps-roll-text" aria-live="polite">
          {lastRoll ? (rolling ? 'Rolling…' : `${lastRoll.total}${lastKind ? ` · ${lastKind}` : ''}`) : 'No rolls yet'}
        </div>
        {iShoot ? (
          <button
            type="button"
            className="btn btn-primary craps-roll-btn"
            disabled={!hasLine || rolling}
            onClick={rollDice}
          >
            {rolling ? 'Rolling…' : hasLine ? 'Roll the dice' : `Bet Pass${variant.dontPass ? " or Don't Pass" : ''} to roll`}
          </button>
        ) : null}
      </div>

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
        <div className={rolling ? 'card craps-felt dim' : 'card craps-felt'}>
          <ChipRack
            chip={takeDown ? null : chip}
            onChip={(d) => {
              setChip(d);
              setTakeDown(false);
            }}
            onUndo={chips.undo}
            onClear={chips.clear}
            canUndo={chips.canUndo}
            disabled={!canChip}
            extra={
              <button type="button" aria-pressed={takeDown} className={takeDown ? 'btn take-down active' : 'btn take-down'} onClick={() => setTakeDown((v) => !v)}>
                Take down
              </button>
            }
          />

          <div className={`craps-place n${placeNumbers.length}`}>
            {placeNumbers.map((n) => (
              <button key={n} type="button" className={spotClass('place', n, point === n ? 'is-point' : '')} onClick={() => tapSpot('place', n)}>
                <span className="spot-name">{n}</span>
                <span className="spot-odds">{ratio(variant.place[n])}</span>
                <span className="spot-bet">
                  {spotAmount(myBets, 'place', n) ? <ChipStack cents={spotAmount(myBets, 'place', n)} max={4} /> : point ? '' : 'off'}
                </span>
              </button>
            ))}
          </div>

          <button type="button" className={spotClass('field', undefined, 'band field')} onClick={() => tapSpot('field')}>
            <span className="spot-name">Field</span>
            <span className="spot-odds">3 4 9 10 11 pay 1:1 · 2 and 12 pay 2:1</span>
            <SpotAmount cents={myBets.field} />
          </button>

          {variant.dontPass ? (
            <button type="button" className={spotClass('dontPass', undefined, 'band dont')} onClick={() => tapSpot('dontPass')}>
              <span className="spot-name">Don't Pass</span>
              <span className="spot-odds">1:1 · 12 is a push</span>
              <SpotAmount cents={myBets.dontPass} />
            </button>
          ) : null}

          <button type="button" className={spotClass('pass', undefined, 'band pass')} onClick={() => tapSpot('pass')}>
            <span className="spot-name">Pass Line</span>
            <span className="spot-odds">1:1</span>
            <SpotAmount cents={myBets.pass} />
          </button>

          {point ? (
            <button type="button" className={spotClass('odds', undefined, 'band odds')} onClick={() => tapSpot('odds')}>
              <span className="spot-name">Odds on {point}</span>
              <span className="spot-odds">
                {oddsRatio ? ratio(oddsRatio) : ''} · {myBets.pass ? `max ${formatMoney(oddsMax)} (${variant.oddsMultiple}× Pass)` : 'needs a Pass bet'}
              </span>
              <SpotAmount cents={myBets.odds} />
            </button>
          ) : null}

          <p className="muted small bac-help" aria-live="polite">
            {chips.error ? (
              <span className="error-text">{chips.error}</span>
            ) : mySeat.leaving ? (
              'You are leaving: Pass and Odds play out, then the seat frees and Place/Field come back.'
            ) : takeDown ? (
              'Tap one of your bets to take all of it down (Pass stays up once a Point is set).'
            ) : (
              `Pick a chip and tap a spot; each tap adds a chip. Up to $10 a spot; Odds up to ${variant.oddsMultiple}× your Pass.`
            )}
          </p>
          <button type="button" className="btn btn-ghost small leave-btn" onClick={() => run('leave', 'leave')} disabled={busy === 'leave' || mySeat.leaving}>
            {mySeat.leaving ? 'Leaving' : 'Leave seat'}
          </button>
        </div>
      ) : (
        <div className="card watch-note">
          <strong>You're watching.</strong>
          <span className="muted small">{seats.every(Boolean) ? 'All 5 seats are taken. You can keep watching.' : 'Tap an empty seat above to sit down and play.'}</span>
        </div>
      )}

      {actionError ? (
        <p className="error-text small" role="alert">
          {actionError}
        </p>
      ) : null}

      <p className="muted small table-rules">
        {game === 'crapless'
          ? 'Come-out: 7 wins; every other number becomes the Point (no craps, no Don’t Pass). '
          : 'Come-out: 7 or 11 wins, 2, 3 or 12 loses; Don’t Pass wins on 2 or 3 and pushes on 12. '}
        Odds pay true odds{game === 'crapless' ? ' (2 and 12 at 5:1)' : ''}, up to {variant.oddsMultiple}× your Pass bet. Place bets work only while a
        Point is on and stay up after a win. The shooter has 15 s to roll, then the dice roll themselves. Chips $1–$10, up to $10 a spot.
      </p>
    </section>
  );
}
