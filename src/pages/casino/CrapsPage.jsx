// Craps and Crapless Craps (one page, the variant comes from the route). Everything on screen comes
// from one live doc, casinoTables/{game}; every tap is a call to /api/casino. Top to bottom: status,
// point and countdown, the dice, the seats, the last rolls, then (when seated) the felt and buttons.
//
// Pick a chip and tap a spot to bet; switch on "Take down" and tap a spot to take your bet back.
// Roll carries the table's rollSeq, so a double tap can only roll once.

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Die from '../../components/casino/Die.jsx';
import TableSeats from '../../components/casino/TableSeats.jsx';
import { ErrorState, LoadingState, friendlyError } from '../../components/StatusViews.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useWalletDisplay } from '../../context/WalletDisplayContext.jsx';
import { useCasinoTable, useCountdown, useDeadlineTick, useHeartbeat, useRollAnimation } from '../../hooks/useCasinoTable.js';
import { newRequestId, tableAction } from '../../lib/casino.js';
import { formatMoney } from '../../lib/format.js';
import { DICE_ANIMATION_MS } from '../../../shared/casino/constants.js';
import { DICE_VARIANTS } from '../../../shared/casino/diceVariants.js';
import { SPOT_MAX_CENTS, emptyDiceBets, placeBlocker, removeBlocker, spotAmount, totalOnFelt } from '../../../shared/casino/dice.js';

const CHIPS = [1, 2, 5, 10];
const NO_SEATS = [null, null, null, null, null];
const KIND_TEXT = { natural: 'Winner!', craps: 'Craps', point: 'Point set', pointMade: 'Point made!', sevenOut: 'Seven out', roll: '' };

function ratio([n, d]) {
  return `${n}:${d}`;
}

function signedMoney(cents) {
  if (cents > 0) return `+${formatMoney(cents)}`;
  if (cents < 0) return `−${formatMoney(-cents)}`;
  return formatMoney(0);
}

export default function CrapsPage({ game }) {
  const variant = DICE_VARIANTS[game];
  const { authUser, profile } = useAuth();
  const myUid = authUser?.uid ?? null;
  const balanceCents = Number(profile?.balanceCents) || 0;
  const { setHeldCents } = useWalletDisplay();
  const { table, loading, error } = useCasinoTable(game);

  const seats = table?.seats ?? NO_SEATS;
  const mySeatIndex = seats.findIndex((seat) => seat && seat.uid === myUid);
  const mySeat = mySeatIndex >= 0 ? seats[mySeatIndex] : null;
  const deadline = table?.deadline ?? null;
  const lastRoll = table?.lastRoll ?? null;

  const seconds = useCountdown(deadline);
  useDeadlineTick(game, deadline, Boolean(table));
  useHeartbeat(game, Boolean(mySeat));
  const rolling = useRollAnimation(lastRoll?.at ?? null, DICE_ANIMATION_MS);

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

  async function run(kind, action, fields = {}) {
    setBusy(kind);
    setActionError('');
    try {
      await tableAction(game, action, fields);
    } catch (err) {
      if (err.code !== 'STALE') setActionError(friendlyError(err.message));
    } finally {
      setBusy('');
    }
  }

  if (!variant) return null;
  if (loading) return <LoadingState label={`Opening the ${variant.name} table…`} />;
  if (error) return <ErrorState title="Couldn't open the table" message={error} />;

  // While tumbling, show the table as it was before this roll.
  const point = rolling ? lastRoll?.pointBefore ?? null : table?.point ?? null;
  const shooterIndex = table?.shooter ?? null;
  const shooter = shooterIndex === null ? null : seats[shooterIndex];
  const iShoot = Boolean(mySeat) && shooterIndex === mySeatIndex;
  const myBets = mySeat?.bets ?? emptyDiceBets();
  const hasLine = myBets.pass > 0 || myBets.dontPass > 0;
  const placeNumbers = variant.points;

  function tapSpot(kind, number) {
    if (!mySeat || busy || rolling) return;
    if (takeDown) {
      if (!spotAmount(myBets, kind, number)) return;
      const blocked = removeBlocker(table?.point ?? null, kind);
      if (blocked) {
        setActionError(blocked);
        return;
      }
      run(`down-${kind}${number ?? ''}`, 'removeBet', number === undefined ? { kind } : { kind, number });
      return;
    }
    const blocked = placeBlocker(variant, table?.point ?? null, myBets, kind, number);
    if (blocked) {
      setActionError(blocked);
      return;
    }
    if (chip * 100 > balanceCents) {
      setActionError(`Your wallet has ${formatMoney(balanceCents)}. Add money in the Shop.`);
      return;
    }
    if (spotAmount(myBets, kind, number) + chip * 100 > SPOT_MAX_CENTS) {
      setActionError('Each spot holds up to $10.');
      return;
    }
    run(`bet-${kind}${number ?? ''}`, 'bet', { kind, amount: chip, requestId: newRequestId(), ...(number === undefined ? {} : { number }) });
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
            disabled={!hasLine || rolling || busy === 'roll'}
            onClick={() => run('roll', 'roll', { rollSeq: table.rollSeq })}
          >
            {busy === 'roll' ? 'Rolling…' : hasLine ? 'Roll the dice' : `Bet Pass${variant.dontPass ? " or Don't Pass" : ''} to roll`}
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
          <div className="craps-chips" role="radiogroup" aria-label="Chip">
            {CHIPS.map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={!takeDown && chip === d}
                className={!takeDown && chip === d ? 'btn chip active' : 'btn chip'}
                onClick={() => {
                  setChip(d);
                  setTakeDown(false);
                }}
              >
                ${d}
              </button>
            ))}
            <button type="button" role="radio" aria-checked={takeDown} className={takeDown ? 'btn chip take-down active' : 'btn chip take-down'} onClick={() => setTakeDown(true)}>
              Take down
            </button>
          </div>

          <div className={`craps-place n${placeNumbers.length}`}>
            {placeNumbers.map((n) => (
              <button key={n} type="button" className={spotClass('place', n, point === n ? 'is-point' : '')} onClick={() => tapSpot('place', n)}>
                <span className="spot-name">{n}</span>
                <span className="spot-odds">{ratio(variant.place[n])}</span>
                <span className="spot-bet">{spotAmount(myBets, 'place', n) ? formatMoney(spotAmount(myBets, 'place', n)) : point ? '' : 'off'}</span>
              </button>
            ))}
          </div>

          <button type="button" className={spotClass('field', undefined, 'band field')} onClick={() => tapSpot('field')}>
            <span className="spot-name">Field</span>
            <span className="spot-odds">3 4 9 10 11 pay 1:1 · 2 and 12 pay 2:1</span>
            <span className="spot-bet">{myBets.field ? formatMoney(myBets.field) : '—'}</span>
          </button>

          {variant.dontPass ? (
            <button type="button" className={spotClass('dontPass', undefined, 'band dont')} onClick={() => tapSpot('dontPass')}>
              <span className="spot-name">Don't Pass</span>
              <span className="spot-odds">1:1 · 12 is a push</span>
              <span className="spot-bet">{myBets.dontPass ? formatMoney(myBets.dontPass) : '—'}</span>
            </button>
          ) : null}

          <button type="button" className={spotClass('pass', undefined, 'band pass')} onClick={() => tapSpot('pass')}>
            <span className="spot-name">Pass Line</span>
            <span className="spot-odds">1:1</span>
            <span className="spot-bet">{myBets.pass ? formatMoney(myBets.pass) : '—'}</span>
          </button>

          {point ? (
            <button type="button" className={spotClass('odds', undefined, 'band odds')} onClick={() => tapSpot('odds')}>
              <span className="spot-name">Odds on {point}</span>
              <span className="spot-odds">{oddsRatio ? `${ratio(oddsRatio)} · behind Pass, up to $10` : ''}</span>
              <span className="spot-bet">{myBets.odds ? formatMoney(myBets.odds) : '—'}</span>
            </button>
          ) : null}

          <p className="muted small bac-help" aria-live="polite">
            {mySeat.leaving
              ? 'You are leaving: Pass and Odds play out, then the seat frees and Place/Field come back.'
              : takeDown
                ? 'Tap one of your bets to take it down (Pass stays up once a Point is set).'
                : `Tap a spot to add $${chip}. Up to $10 a spot.`}
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
        Odds pay true odds{game === 'crapless' ? ' (2 and 12 at 5:1)' : ''}. Place bets work only while a Point is on and stay up after a win. The
        shooter has 15 s to roll, then the dice roll themselves. Bets $1–$10, up to $10 a spot.
      </p>
    </section>
  );
}
