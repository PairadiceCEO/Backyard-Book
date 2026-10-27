// Baccarat table. Everything on screen comes from one live doc, casinoTables/baccarat; every tap is a
// call to /api/casino. Top to bottom: status and countdown, the cards, the five seats, then (when
// seated) one panel per seat you hold, then the scoreboard (roads).
//
// A player may hold several seats; each has its own Player / Banker / Tie bets and limits, its own
// Confirm and its own Leave. Tabs switch between my seats; every action names its seat. Leaving the
// page gives up every seat (useLeaveOnExit).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChipRack } from '../../components/casino/Chips.jsx';
import BaccaratFelt, { PrintedSpot, SPOT_ORDER, watcherLabel } from '../../components/casino/BaccaratFelt.jsx';
import { Link } from 'react-router-dom';
import BaccaratScoreboard from '../../components/casino/BaccaratScoreboard.jsx';
import PlayingCard, { PeelCard } from '../../components/casino/PlayingCard.jsx';
import TableSeats from '../../components/casino/TableSeats.jsx';
import { ErrorState, LoadingState, friendlyError } from '../../components/StatusViews.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useWalletDisplay } from '../../context/WalletDisplayContext.jsx';
import {
  useCasinoTable,
  useCountdown,
  useDeadlineTick,
  useHeartbeat,
  useLeaveOnExit,
  usePendingTotal,
  useSeatFocus,
  useTableCall,
  useTimedReveal,
} from '../../hooks/useCasinoTable.js';
import { useChipBetting } from '../../hooks/useChipBetting.js';
import { newRequestId } from '../../lib/casino.js';
import { ensureFeltFont } from '../../lib/feltFont.js';
import { formatMoney } from '../../lib/format.js';
import { BET_HELP_TEXT, betCeilingProblem } from '../../../shared/casino/constants.js';
import { ChatButton, ChatDrawer } from '../../components/casino/CasinoChat.jsx';
import SoundToggle from '../../components/casino/SoundToggle.jsx';
import { useCasinoChat } from '../../hooks/useCasinoChat.js';
import {
  BACCARAT_ODDS,
  SPOT_LABELS,
  handTotal,
  coupRevealTimes,
  revealOrder,
  spotReturnCents,
  totalBetCents,
} from '../../../shared/casino/baccarat.js';

const GAME = 'baccarat';
const NO_SEATS = [null, null, null, null, null];
const NO_BETS = { player: 0, banker: 0, tie: 0 };
const WINNER_TEXT = { player: 'Player wins', banker: 'Banker wins', tie: 'Tie' };

function signedMoney(cents) {
  if (cents > 0) return `+${formatMoney(cents)}`;
  if (cents < 0) return `−${formatMoney(-cents)}`;
  return formatMoney(0);
}

// One printed card box. `peel` = { card, startAt, gapMs } while this hand's third card is face down and turning (the squeeze);
// `dealAtFor(name, i)` is the server time card i turns face up (it slides out of the shoe then).
function Hand({ label, cards, visibleCount, total, winner, freshFrom, peel, dealAtFor }) {
  const name = label.toLowerCase();
  return (
    <div className={winner ? `bact-box ${name} won` : `bact-box ${name}`}>
      <div className="bact-box-head">
        <span>{label}</span>
        <span className="bac-total" aria-live="polite">
          {visibleCount > 0 ? total : ''}
        </span>
      </div>
      <div className="bac-cards">
        {cards.slice(0, visibleCount).map((card, i) => (
          <PlayingCard key={card} card={card} fresh={i >= freshFrom} dealAt={dealAtFor ? dealAtFor(name, i) : null} />
        ))}
        {peel ? <PeelCard key={`peel-${peel.card}`} card={peel.card} startAt={peel.startAt} gapMs={peel.gapMs} /> : null}
        {visibleCount === 0 ? <span className="bac-cards-empty" aria-hidden="true" /> : null}
      </div>
    </div>
  );
}

// One of my seats: its three spots, chips, Confirm and Leave. Kept mounted while another seat's tab is
// showing, so chips waiting to be sent keep going.
function SeatPanel({ index, seat, hidden, phase, winner, revealing, slot, call, roundId, balanceCents, chip, setChip, onPending, onLocalTotal, onError }) {
  const [busy, setBusy] = useState('');
  // Rebet (0.19.0): this seat's three bets the last time cards were dealt, kept in memory only (a reload forgets them).
  const [lastBets, setLastBets] = useState(NO_BETS);
  const serverBets = seat.bets ?? NO_BETS;
  const canBet = phase === 'betting' && !seat.ready && !seat.leaving;
  const validate = useCallback(
    (spot, cents, after) => {
      const tooBig = betCeilingProblem(cents); // only the $1,000,000 sanity ceiling: no maximum bet
      if (tooBig) return tooBig;
      const extra = totalBetCents(after) - totalBetCents(serverBets);
      if (extra > balanceCents) return `Not enough in your wallet (${formatMoney(balanceCents)}).`;
      return '';
    },
    [serverBets, balanceCents],
  );
  // Sends the seat's three totals; resolves with that seat's bets as the server now holds them (from the reply's table),
  // so the next batch builds on them.
  const sendChips = useCallback(
    async (_changes, totals) => {
      const reply = await call('bet', {
        seat: index,
        player: (totals.player ?? 0) / 100,
        banker: (totals.banker ?? 0) / 100,
        tie: (totals.tie ?? 0) / 100,
        requestId: newRequestId(),
      });
      const held = reply?.table?.seats?.[index]?.bets;
      return held && typeof held === 'object' ? { player: held.player ?? 0, banker: held.banker ?? 0, tie: held.tie ?? 0 } : null;
    },
    [call, index],
  );
  const chips = useChipBetting({ spots: serverBets, roundKey: roundId, validate, send: sendChips, onPending, enabled: canBet });
  const myBets = { ...NO_BETS, ...chips.spots };
  const myTotal = totalBetCents(myBets);

  const dealtKey = `${serverBets.player || 0},${serverBets.banker || 0},${serverBets.tie || 0}`;
  useEffect(() => {
    if (phase === 'betting') return;
    const [player, banker, tie] = dealtKey.split(',').map(Number);
    if (player + banker + tie > 0) setLastBets({ player, banker, tie });
  }, [phase, dealtKey]);
  const lastTotal = totalBetCents(lastBets);
  const showRebet = canBet && lastTotal > 0 && myTotal === 0;
  const rebetBusy = useRef(false);
  useEffect(() => {
    rebetBusy.current = false;
  }, [myTotal, roundId]);
  // Rebet / Rebet x2: every spot that had a bet, through chips.place (one batch: the taps all land in the same 300 ms).
  // A wallet that can't cover the whole thing places nothing.
  function rebet(times) {
    if (rebetBusy.current || myTotal > 0) return;
    if (lastTotal * times > balanceCents) {
      chips.setError(`Not enough in your wallet (${formatMoney(balanceCents)}).`);
      return;
    }
    rebetBusy.current = true;
    let placed = 0;
    for (const spot of SPOT_ORDER) {
      if (!lastBets[spot]) continue;
      if (chips.place(spot, lastBets[spot] * times)) placed += 1;
      else {
        if (placed) chips.clear(); // a spot was refused (the $1,000,000 ceiling): all or nothing
        rebetBusy.current = false;
        return;
      }
    }
  }

  // The seat tile shows chips the moment they go down, before the server answers.
  useEffect(() => {
    onLocalTotal(myTotal);
  }, [myTotal, onLocalTotal]);

  async function run(kind, action, fields = {}) {
    setBusy(kind);
    onError('');
    try {
      await call(action, { seat: index, ...fields });
    } catch (err) {
      onError(friendlyError(err.message));
    } finally {
      setBusy('');
    }
  }

  async function confirmBets() {
    setBusy('confirm');
    await chips.flushNow(); // every chip confirmed first
    setBusy('');
    run('confirm', 'confirm');
  }

  const result = phase === 'results' && !revealing ? seat.result : null;

  return (
    <div className="card bac-controls seat-panel" hidden={hidden} role="tabpanel" id={`seat-panel-${index}`} aria-label={`Seat ${index + 1}`}>
      <div className="seat-panel-head">
        <strong>
          {seat.name} · Seat {index + 1}
        </strong>
        {result ? <span className={result.netCents > 0 ? 'bj-net win' : result.netCents < 0 ? 'bj-net lose' : 'bj-net'}>{result.netCents === 0 ? 'push' : signedMoney(result.netCents)}</span> : null}
      </div>
      {!hidden && slot
        ? createPortal(
            SPOT_ORDER.map((spot) => {
              const stake = myBets[spot];
              const resultKnown = phase === 'results' && !revealing && winner && seat.result && stake > 0;
              return (
                <PrintedSpot
                  key={spot}
                  spot={spot}
                  cents={stake}
                  won={winner === spot}
                  disabled={!canBet}
                  onClick={() => chips.place(spot, chip * 100)}
                  label={`Seat ${index + 1}: ${SPOT_LABELS[spot]}, pays ${BACCARAT_ODDS[spot].label}, your bet ${formatMoney(stake)}. Tap to add a $${chip} chip.`}
                  fx={resultKnown ? { show: true, netCents: spotReturnCents(spot, stake, winner) - stake, stakeCents: stake, roundKey: `${roundId}-${index}-${spot}` } : null}
                />
              );
            }),
            slot,
          )
        : null}

      <ChipRack
        chip={chip}
        onChip={setChip}
        onUndo={chips.undo}
        onClear={chips.clear}
        canUndo={chips.canUndo}
        disabled={!canBet}
        rebet={
          showRebet ? (
            <div className="rebet-row">
              <button type="button" className="rebet-btn" onClick={() => rebet(1)}>
                Rebet {formatMoney(lastTotal)}
              </button>
              <button type="button" className="rebet-btn" onClick={() => rebet(2)}>
                Rebet ×2 {formatMoney(lastTotal * 2)}
              </button>
            </div>
          ) : null
        }
        extra={
          <button type="button" className="btn btn-primary" onClick={confirmBets} disabled={!canBet || myTotal === 0 || busy === 'confirm'}>
            {seat.ready ? 'Confirmed ✓' : busy === 'confirm' ? 'Confirming…' : `Confirm ${myTotal ? formatMoney(myTotal) : ''}`.trim()}
          </button>
        }
      />

      <p className="muted small bac-help" aria-live="polite">
        {chips.error ? (
          <span className="error-text">{chips.error}</span>
        ) : seat.leaving ? (
          "Leaving: this seat's bets play out, then the seat frees."
        ) : seat.ready && phase === 'betting' ? (
          'Confirmed. The cards come out when every seat confirms or the clock runs out.'
        ) : phase === 'betting' ? (
          `Pick a chip and tap Player, Banker or Tie on the table; each tap adds a chip. ${BET_HELP_TEXT}`
        ) : (
          'Bet again when the next hand opens.'
        )}
      </p>

      <button type="button" className="btn btn-ghost small leave-btn" onClick={() => run('leave', 'leave')} disabled={busy === 'leave' || seat.leaving}>
        {seat.leaving ? 'Leaving after this hand' : `Leave seat ${index + 1}`}
      </button>
    </div>
  );
}

export default function BaccaratPage() {
  const { authUser, profile } = useAuth();
  const chat = useCasinoChat(GAME); // this game's chat room (0.17.0)
  const myUid = authUser?.uid ?? null;
  const balanceCents = Number(profile?.balanceCents) || 0;
  const { setHeldCents, setPendingCents, reportBalance } = useWalletDisplay();
  const { table, loading, error, accept } = useCasinoTable(GAME);
  const call = useTableCall(GAME, accept, reportBalance);

  const seats = table?.seats ?? NO_SEATS;
  const mySeatsKey = seats.map((seat, i) => (seat && seat.uid === myUid ? i : '')).join(',');
  const mySeats = useMemo(() => mySeatsKey.split(',').filter((v) => v !== '').map(Number), [mySeatsKey]);
  const seated = mySeats.length > 0;
  const phase = table?.phase ?? 'betting';
  const deadline = table?.deadline ?? null;
  const roundId = table?.roundId ?? null;

  const seconds = useCountdown(deadline);
  useDeadlineTick(GAME, deadline, { enabled: Boolean(table), call, phase: table?.phase ?? null });
  useHeartbeat(GAME, seated);
  useLeaveOnExit(GAME, seated);

  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(''); // 'sit' | 'leaveAll' while that call is in flight
  const [chip, setChip] = useState(1);
  const [focus, setFocus] = useSeatFocus(mySeats, null);
  const [spotsSlot, setSpotsSlot] = useState(null); // the printed bet areas' box on the felt: my seat panel draws its spots there

  useEffect(() => {
    ensureFeltFont(); // the felt and the chips are lettered in Oswald
  }, []);

  // Arriving at the table: one tick applies anything overdue (an abandoned table waits for the first
  // visitor) and gives this phone the server's clock. Runs once per visit.
  useEffect(() => {
    call('tick').catch(() => {}); // through call: the reply's table shows at once
  }, [call]); // call is stable per game, so this still runs once per visit

  // ---- the deal: cards turn over at the server's times (gaps from shared/casino/timing.js) ----
  const coup = phase === 'results' ? table?.coup ?? null : null;
  const order = coup ? revealOrder(coup.player, coup.banker) : [];
  const revealTimes = coup ? coupRevealTimes(coup.player, coup.banker) : [];
  const shown = useTimedReveal(coup?.dealtAt ?? null, revealTimes);
  const revealing = Boolean(coup) && shown < order.length;
  const visible = { player: 0, banker: 0 };
  order.slice(0, shown).forEach((o) => {
    visible[o.hand] += 1;
  });
  const playerCards = coup?.player ?? [];
  const bankerCards = coup?.banker ?? [];
  const winner = coup && !revealing ? coup.winner : null;

  // When the server turns each card face up (server ms), so it slides out of the shoe then.
  const dealAtFor = (name, i) => {
    const k = order.findIndex((o) => o.hand === name && o.index === i);
    return k === -1 || !coup?.dealtAt ? null : coup.dealtAt + revealTimes[k];
  };
  // The squeeze: the next card is a third card, so it shows face down from the moment the previous card turned (its 1.5 s
  // gap starts) and peels open to finish on its own reveal time.
  const nextCard = revealing && shown > 0 ? order[shown] : null;
  const peelFor = (name) =>
    nextCard && nextCard.index === 2 && nextCard.hand === name
      ? { card: coup[name][2], startAt: coup.dealtAt + revealTimes[shown - 1], gapMs: revealTimes[shown] - revealTimes[shown - 1] }
      : null;

  // ---- while the cards turn, the nav wallet shows the pre-deal balance (no spoilers) ----
  const preDealRef = useRef(null);
  useEffect(() => {
    if (phase === 'betting') preDealRef.current = balanceCents;
  }, [phase, balanceCents]);
  const holdWallet = revealing && mySeats.some((i) => seats[i]?.result);
  useEffect(() => {
    if (!holdWallet || preDealRef.current === null) return undefined;
    setHeldCents(preDealRef.current);
    return () => setHeldCents(null);
  }, [holdWallet, setHeldCents]);

  // ---- every seat's chips count toward the nav wallet; tiles show each seat's chips at once ----
  const pendingFor = usePendingTotal(setPendingCents);
  const [localTotals, setLocalTotals] = useState({});
  const localCallbacks = useRef(new Map());
  const localTotalFor = useCallback((i) => {
    if (!localCallbacks.current.has(i)) {
      localCallbacks.current.set(i, (cents) => setLocalTotals((prev) => (prev[i] === cents ? prev : { ...prev, [i]: cents })));
    }
    return localCallbacks.current.get(i);
  }, []);

  async function sit(seat) {
    setBusy('sit');
    setActionError('');
    try {
      const reply = await call('sit', { seat });
      if (Number.isInteger(reply?.seat)) setFocus(reply.seat);
    } catch (err) {
      setActionError(friendlyError(err.message));
    } finally {
      setBusy('');
    }
  }

  async function leaveAll() {
    setBusy('leaveAll');
    setActionError('');
    try {
      await call('leave', { all: true });
    } catch (err) {
      setActionError(friendlyError(err.message));
    } finally {
      setBusy('');
    }
  }

  // ---- what each seat tile says ----
  function seatDetail(seat, i) {
    if (phase === 'results' && seat.result && !revealing) {
      const net = seat.result.netCents;
      return { text: net === 0 ? 'push' : signedMoney(net), tone: net > 0 ? 'win' : net < 0 ? 'lose' : '' };
    }
    const total = seat.uid === myUid && localTotals[i] !== undefined ? localTotals[i] : totalBetCents(seat.bets);
    if (!total) return { text: '—' };
    return { text: `${formatMoney(total)}${seat.ready ? ' ✓' : ''}`, tone: seat.ready ? 'ready' : '' };
  }

  // ---- status line ----
  let status;
  if (!table || !seats.some(Boolean)) status = 'Waiting for players. Take a seat to start.';
  else if (phase === 'betting') status = deadline ? `Betting closes in ${seconds ?? 0}s` : seated ? 'Place your bets' : 'Waiting for the first bet';
  else if (revealing) status = 'Dealing…';
  else status = `${WINNER_TEXT[coup?.winner] ?? 'Hand over'} ${coup ? `${coup.playerTotal}–${coup.bankerTotal}` : ''}`.trim();

  if (loading) return <LoadingState label="Opening the Baccarat table…" />;
  if (error) return <ErrorState title="Couldn't open the table" message={error} />;

  // My net over every seat I played this hand.
  const myResults = phase === 'results' && !revealing ? mySeats.map((i) => seats[i]?.result).filter(Boolean) : [];
  const myResult = myResults.length ? { netCents: myResults.reduce((sum, r) => sum + r.netCents, 0) } : null;
  // The newest hand joins the roads once its last card is face up.
  const shoeResults = typeof table?.shoeResults === 'string' ? table.shoeResults : '';
  const scoreboardResults = revealing ? shoeResults.slice(0, -1) : shoeResults;
  const tableFull = seats.every(Boolean);

  return (
    <section className="page table-page">
      <div className="slots-top">
        <Link to="/casino" className="btn btn-ghost small">
          ‹ Casino
        </Link>
        <h2 className="section-title">Baccarat</h2>
        {table?.shoe ? (
          <span className="muted small shoe-count">
            Shoe {table.shoe.remaining}/{table.shoe.total}
          </span>
        ) : null}
        <SoundToggle />
        <ChatButton chat={chat} />
      </div>

      <div className={`card table-status phase-${phase}`} role="status">
        <span className="table-status-text">{status}</span>
        {phase === 'results' && !revealing && deadline ? <span className="muted small">Next hand in {seconds ?? 0}s</span> : null}
        {phase === 'betting' && deadline ? (
          <span className={seconds !== null && seconds <= 5 ? 'countdown urgent' : 'countdown'} aria-hidden="true">
            {seconds ?? 0}
          </span>
        ) : null}
      </div>

      <BaccaratFelt
        spotsRef={setSpotsSlot}
        player={<Hand label="Player" cards={playerCards} visibleCount={visible.player} total={handTotal(playerCards.slice(0, visible.player))} winner={winner === 'player'} freshFrom={0} peel={peelFor('player')} dealAtFor={dealAtFor} />}
        banker={<Hand label="Banker" cards={bankerCards} visibleCount={visible.banker} total={handTotal(bankerCards.slice(0, visible.banker))} winner={winner === 'banker'} freshFrom={0} peel={peelFor('banker')} dealAtFor={dealAtFor} />}
        banner={
          winner ? (
            <div className={`bac-banner banner-${winner}`}>
              {WINNER_TEXT[winner]}
              {coup.natural ? ' · natural' : ''}
              {myResult ? <span className="bac-banner-me">You {myResult.netCents === 0 ? 'push' : signedMoney(myResult.netCents)}</span> : null}
            </div>
          ) : null
        }
        hint={!coup && phase === 'betting' ? <p className="bact-hint">Cards are dealt when betting closes.</p> : null}
        watcherSpots={
          seated
            ? null
            : SPOT_ORDER.map((spot) => (
                <PrintedSpot key={spot} spot={spot} won={winner === spot} disabled label={watcherLabel(spot)} />
              ))
        }
      />

      <TableSeats seats={seats} myUid={myUid} canSit sitting={busy === 'sit'} onSit={sit} detail={seatDetail} />

      {seated ? (
        <>
          {mySeats.length > 1 ? (
            <div className="seat-tabs" role="tablist" aria-label="Your seats">
              {mySeats.map((i) => {
                const seat = seats[i];
                const result = phase === 'results' && !revealing ? seat.result : null;
                const pending = localTotals[i] ?? totalBetCents(seat.bets);
                const note = result ? (result.netCents === 0 ? 'push' : signedMoney(result.netCents)) : seat.ready ? '✓' : pending ? formatMoney(pending) : '';
                return (
                  <button
                    key={i}
                    type="button"
                    role="tab"
                    aria-selected={focus === i}
                    aria-controls={`seat-panel-${i}`}
                    className={focus === i ? 'seat-tab active' : 'seat-tab'}
                    onClick={() => setFocus(i)}
                  >
                    <span>Seat {i + 1}</span>
                    {note ? <span className="seat-tab-note">{note}</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          {mySeats.map((i) => (
            <SeatPanel
              key={i}
              index={i}
              seat={seats[i]}
              hidden={i !== focus}
              phase={phase}
              winner={winner}
              revealing={revealing}
              slot={spotsSlot}
              call={call}
              roundId={roundId}
              balanceCents={balanceCents}
              chip={chip}
              setChip={setChip}
              onPending={pendingFor(i)}
              onLocalTotal={localTotalFor(i)}
              onError={setActionError}
            />
          ))}
          <p className="muted small seat-more">
            {!tableFull ? 'Tap an empty seat to play another; each seat bets on its own.' : ''}
            {mySeats.length > 1 ? (
              <button type="button" className="btn btn-ghost small leave-all-btn" onClick={leaveAll} disabled={busy === 'leaveAll'}>
                Leave all seats
              </button>
            ) : null}
          </p>
        </>
      ) : (
        <div className="card watch-note">
          <strong>You're watching.</strong>
          <span className="muted small">{tableFull ? 'All 5 seats are taken. You can keep watching.' : 'Tap an empty seat above to sit down and play. You can take more than one.'}</span>
        </div>
      )}

      {actionError ? (
        <p className="error-text small" role="alert">
          {actionError}
        </p>
      ) : null}

      <BaccaratScoreboard results={scoreboardResults} />

      <p className="muted small table-rules">
        Player pays 1:1, Banker 0.95:1 (5% commission), Tie 8:1; a Tie pushes Player and Banker bets. 8 decks, standard
        drawing rules, every card dealt on the server.
      </p>
      <ChatDrawer chat={chat} />
    </section>
  );
}
