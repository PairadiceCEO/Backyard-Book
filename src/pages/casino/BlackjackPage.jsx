// Blackjack table. Everything on screen comes from one live doc, casinoTables/blackjack; every tap is a
// call to /api/casino. Top to bottom: status and countdown, the dealer (and whoever is playing), the
// five seats, then (when seated) one panel per seat you hold, just above the tab bar.
//
// A player may hold several seats; each plays exactly like a separate player (own bet, hands, insurance,
// turn). Only one seat's panel shows at a time (tabs switch), and it jumps to the seat that needs a
// decision. Every action names its seat. Leaving the page gives up every seat (useLeaveOnExit).
//
// The dealer's face-down card is never in the doc: it shows as a card back until the server turns it
// over. Moves carry the hand's index and actionSeq, so a double tap can't play a hand twice.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChipRack, ChipStack } from '../../components/casino/Chips.jsx';
import { Link } from 'react-router-dom';
import PlayingCard from '../../components/casino/PlayingCard.jsx';
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
import { formatMoney } from '../../lib/format.js';
import { BET_HELP_TEXT, betCeilingProblem } from '../../../shared/casino/constants.js';
import { cardRank } from '../../../shared/casino/cards.js';
import { ChatButton, ChatDrawer } from '../../components/casino/CasinoChat.jsx';
import { useCasinoChat } from '../../hooks/useCasinoChat.js';
import {
  BLACKJACK_INITIAL_GAP_MS,
  canDouble,
  canSplit,
  handValue,
  isBlackjack,
  maxInsuranceCents,
} from '../../../shared/casino/blackjack.js';

const GAME = 'blackjack';
const NO_SEATS = [null, null, null, null, null];
const OUTCOME_TEXT = { win: 'Win', lose: 'Lose', push: 'Push', bust: 'Bust', blackjack: 'Blackjack' };

function signedMoney(cents) {
  if (cents > 0) return `+${formatMoney(cents)}`;
  if (cents < 0) return `−${formatMoney(-cents)}`;
  return formatMoney(0);
}

// What a finished hand won or lost on its own.
function handNet(hand) {
  switch (hand.outcome) {
    case 'win':
      return hand.betCents;
    case 'blackjack':
      return Math.round((hand.betCents * 3) / 2);
    case 'push':
      return 0;
    default:
      return -hand.betCents;
  }
}

function HandView({ label, cards, fromSplit, hiddenFrom, active, outcome, betCents, showOutcome, holeDown }) {
  const visible = cards.slice(0, hiddenFrom);
  const showBack = holeDown && hiddenFrom > cards.length; // the face-down card, until it's turned over
  const value = handValue(visible);
  let total = '';
  if (visible.length) {
    if (holeDown) total = `shows ${cardRank(visible[0]) === 'A' ? 'A' : value.total}`;
    else if (isBlackjack(visible, fromSplit)) total = 'BJ';
    else total = value.soft && value.total < 21 ? `soft ${value.total}` : String(value.total);
  }
  const bust = visible.length > 0 && value.total > 21;
  const finished = showOutcome && outcome;
  return (
    <div className={['bj-hand', active ? 'active' : '', finished ? `outcome-${outcome}` : ''].filter(Boolean).join(' ')}>
      <div className="bj-hand-head">
        <span className="bj-hand-label">{label}</span>
        <span className={bust ? 'bj-total bust' : 'bj-total'} aria-live="polite" aria-label={bust ? `bust ${value.total}` : undefined}>
          {total}
        </span>
      </div>
      <div className="bj-cards">
        {visible.map((card) => (
          <PlayingCard key={card} card={card} fresh />
        ))}
        {showBack ? <PlayingCard card={null} /> : null}
        {!visible.length && !showBack ? <span className="bj-cards-empty" aria-hidden="true" /> : null}
      </div>
      {finished ? (
        <div className={`bj-outcome ${outcome}`}>
          {OUTCOME_TEXT[outcome] ?? outcome}
          {betCents ? ` ${signedMoney(handNet({ outcome, betCents }))}` : ''}
        </div>
      ) : betCents ? (
        <div className="bj-hand-bet muted small">Bet {formatMoney(betCents)}</div>
      ) : null}
    </div>
  );
}

// One seat's controls: its hands, its chips and Confirm, insurance, moves, result and Leave. Kept mounted
// while hidden (another seat's tab is showing) so its chips and Undo history survive a tab switch.
function SeatPanel({
  index,
  seat,
  hidden,
  phase,
  turn,
  revealing,
  results,
  hiddenFrom,
  call,
  roundId,
  balanceCents,
  chip,
  setChip,
  onPending,
  onLocalBet,
  onError,
}) {
  const [busy, setBusy] = useState('');
  const hands = seat.hands ?? [];
  const myTurn = phase === 'playing' && turn?.seat === index;
  const activeHand = myTurn ? hands[turn.hand] : null;
  const canMove = myTurn && activeHand?.status === 'playing' && !revealing && !busy;

  const canBet = phase === 'betting' && !seat.ready && !seat.leaving;
  const serverSpots = useMemo(() => ({ bet: seat.betCents || 0 }), [seat.betCents]);
  const validate = useCallback(
    (_spot, cents) => {
      const tooBig = betCeilingProblem(cents); // only the $1,000,000 sanity ceiling: no maximum bet
      if (tooBig) return tooBig;
      if (cents - (seat.betCents || 0) > balanceCents) return `Not enough in your wallet (${formatMoney(balanceCents)}).`;
      return '';
    },
    [seat.betCents, balanceCents],
  );
  // Sends the seat's new total; resolves with what the server holds now, so the next batch builds on it.
  const sendChips = useCallback(
    async (_changes, totals) => {
      const reply = await call('bet', { seat: index, amount: (totals.bet ?? 0) / 100, requestId: newRequestId() });
      const held = reply?.table?.seats?.[index]?.betCents ?? reply?.betCents;
      return Number.isInteger(held) ? { bet: held } : null;
    },
    [call, index],
  );
  const chips = useChipBetting({ spots: serverSpots, roundKey: roundId, validate, send: sendChips, onPending, enabled: canBet });
  const myBetCents = chips.spots.bet ?? 0;

  // The seat tile shows chips the moment they go down, before the server answers.
  useEffect(() => {
    onLocalBet(myBetCents);
  }, [myBetCents, onLocalBet]);

  async function run(kind, action, fields = {}) {
    setBusy(kind);
    onError('');
    try {
      await call(action, { seat: index, ...fields });
    } catch (err) {
      // A STALE refusal means the move already happened (double tap) or the timer stood the hand.
      if (err.code !== 'STALE') onError(friendlyError(err.message));
    } finally {
      setBusy('');
    }
  }

  async function confirmBet() {
    setBusy('confirm');
    await chips.flushNow();
    setBusy('');
    run('confirm', 'confirm');
  }

  return (
    <div className="card bj-controls seat-panel" hidden={hidden} role="tabpanel" id={`seat-panel-${index}`} aria-label={`Seat ${index + 1}`}>
      <div className="seat-panel-head">
        <strong>
          {seat.name} · Seat {index + 1}
        </strong>
        {myTurn && !revealing ? <span className="seat-panel-flag">Your turn</span> : null}
      </div>
      {hands.length ? (
        <div className={hands.length > 1 ? 'bj-my-hands split' : 'bj-my-hands'}>
          {hands.map((h, j) => (
            <HandView
              key={j}
              label={hands.length > 1 ? `Hand ${j + 1}` : 'Your hand'}
              cards={h.cards}
              fromSplit={h.fromSplit}
              hiddenFrom={hiddenFrom(`${index}-${j}`, h.cards.length)}
              active={myTurn && turn.hand === j}
              outcome={h.outcome}
              showOutcome={!revealing && (results || h.outcome === 'bust' || h.outcome === 'blackjack')}
              betCents={h.betCents}
            />
          ))}
        </div>
      ) : null}

      {phase === 'betting' && !seat.leaving ? (
        <>
          <button
            type="button"
            className={myBetCents ? 'bj-bet-spot has-bet' : 'bj-bet-spot'}
            onClick={() => chips.place('bet', chip * 100)}
            disabled={!canBet}
            aria-label={`Seat ${index + 1} bet ${formatMoney(myBetCents)}. Tap to add a $${chip} chip.`}
          >
            <span className="bj-bet-label">{seat.ready ? 'Bet locked in' : 'Tap to bet'}</span>
            <span className="spot-chips">
              <ChipStack cents={myBetCents} />
              <strong>{myBetCents ? formatMoney(myBetCents) : '—'}</strong>
            </span>
          </button>
          <ChipRack
            chip={chip}
            onChip={setChip}
            onUndo={chips.undo}
            onClear={chips.clear}
            canUndo={chips.canUndo}
            disabled={!canBet}
            extra={
              <button type="button" className="btn btn-primary" onClick={confirmBet} disabled={!canBet || !myBetCents || busy === 'confirm'}>
                {seat.ready ? 'Confirmed ✓' : busy === 'confirm' ? 'Confirming…' : `Deal me in ${myBetCents ? formatMoney(myBetCents) : ''}`.trim()}
              </button>
            }
          />
          <p className="bj-note muted small" aria-live="polite">
            {chips.error ? (
              <span className="error-text">{chips.error}</span>
            ) : seat.ready ? (
              'Locked in. Cards come out when every seat confirms or the clock runs out.'
            ) : (
              `Pick a chip and tap the spot; each tap adds a chip. ${BET_HELP_TEXT}`
            )}
          </p>
        </>
      ) : null}

      {phase === 'insurance' && !revealing && seat.betCents > 0 ? (
        seat.insurance === null ? (
          <div className="bac-actions bj-insurance">
            <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => run('ins', 'insurance', { amountCents: 0 })}>
              No insurance
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={Boolean(busy) || maxInsuranceCents(seat.betCents) > balanceCents}
              onClick={() => run('ins', 'insurance', { amountCents: maxInsuranceCents(seat.betCents) })}
            >
              Insure {formatMoney(maxInsuranceCents(seat.betCents))}
            </button>
          </div>
        ) : (
          <p className="bj-note">{seat.insurance > 0 ? `Insured for ${formatMoney(seat.insurance)} (pays 2:1).` : 'No insurance.'} Waiting for the others.</p>
        )
      ) : null}

      {phase === 'playing' && hands.length ? (
        <div className="bj-moves">
          {['hit', 'stand', 'double', 'split'].map((move) => {
            const legal =
              canMove && (move === 'hit' || move === 'stand' || (move === 'double' && canDouble(activeHand)) || (move === 'split' && canSplit(activeHand, hands.length)));
            const extra = move === 'double' || move === 'split' ? activeHand?.betCents ?? 0 : 0;
            return (
              <button
                key={move}
                type="button"
                className={move === 'hit' || move === 'stand' ? 'btn btn-primary' : 'btn'}
                disabled={!legal || extra > balanceCents}
                onClick={() => run(move, move, { hand: turn.hand, actionSeq: activeHand.seq })}
              >
                {busy === move ? '…' : move[0].toUpperCase() + move.slice(1)}
              </button>
            );
          })}
        </div>
      ) : null}

      {phase === 'playing' && hands.length && !myTurn ? <p className="bj-note muted small">Waiting for seat {index + 1}'s turn.</p> : null}
      {results && seat.result ? (
        <p className={`bj-note bj-net ${seat.result.netCents > 0 ? 'win' : seat.result.netCents < 0 ? 'lose' : ''}`}>
          Seat {index + 1} this hand: {seat.result.netCents === 0 ? 'even' : signedMoney(seat.result.netCents)}
        </p>
      ) : null}
      {seat.leaving ? <p className="bj-note muted small">Leaving: this seat's hand plays out (it stands on its timer), then the seat frees.</p> : null}

      <button type="button" className="btn btn-ghost small leave-btn" onClick={() => run('leave', 'leave')} disabled={busy === 'leave' || seat.leaving}>
        {seat.leaving ? 'Leaving after this hand' : `Leave seat ${index + 1}`}
      </button>
    </div>
  );
}

export default function BlackjackPage() {
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
  const turn = table?.turn ?? null;
  const dealer = table?.dealer ?? { cards: [], holeDown: false };

  const seconds = useCountdown(deadline);
  useDeadlineTick(GAME, deadline, { enabled: Boolean(table), call, phase: table?.phase ?? null });
  useHeartbeat(GAME, seated);
  useLeaveOnExit(GAME, seated);

  const [chip, setChip] = useState(5);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    call('tick').catch(() => {}); // through call: the reply's table shows at once
  }, [call]); // call is stable per game, so this still runs once per visit

  // ---- cards dealt in the latest write turn over at the server's times ----
  // (gaps from shared/casino/timing.js; t is each card's offset from lastDeal.at)
  const lastDeal = table?.lastDeal ?? null;
  const dealList = useMemo(() => lastDeal?.cards ?? [], [lastDeal]);
  const shown = useTimedReveal(lastDeal?.at ?? null, dealList.map((c, k) => (Number.isFinite(c.t) ? c.t : k * BLACKJACK_INITIAL_GAP_MS)));
  const revealing = dealList.length > 0 && shown < dealList.length;
  // For each hand, how many of its cards are face up right now.
  const hiddenFrom = useCallback(
    (to, cardCount) => {
      let first = cardCount + 1; // +1: "nothing hidden", also lets the face-down hole card show its back
      dealList.forEach((d, pos) => {
        if (d.to === to && pos >= shown) first = Math.min(first, d.i);
      });
      return first;
    },
    [dealList, shown],
  );

  // ---- the nav wallet stays put until the cards that decide it are face up ----
  const preRevealRef = useRef(null);
  useEffect(() => {
    if (!revealing) preRevealRef.current = balanceCents;
  }, [revealing, balanceCents]);
  const holdWallet = revealing && mySeats.some((i) => seats[i]?.hands?.length);
  useEffect(() => {
    if (!holdWallet || preRevealRef.current === null) return undefined;
    setHeldCents(preRevealRef.current);
    return () => setHeldCents(null);
  }, [holdWallet, setHeldCents]);

  // ---- every seat's chips count toward the nav wallet; tiles show each seat's chips at once ----
  const pendingFor = usePendingTotal(setPendingCents);
  const [localBets, setLocalBets] = useState({});
  const localBetCallbacks = useRef(new Map());
  const localBetFor = useCallback((i) => {
    if (!localBetCallbacks.current.has(i)) {
      localBetCallbacks.current.set(i, (cents) => setLocalBets((prev) => (prev[i] === cents ? prev : { ...prev, [i]: cents })));
    }
    return localBetCallbacks.current.get(i);
  }, []);

  // ---- which seat's panel shows: the one that needs a decision, else the last one tapped ----
  const myTurn = phase === 'playing' && Boolean(turn) && mySeats.includes(turn.seat);
  const insuranceSeat = phase === 'insurance' && !revealing ? mySeats.find((i) => seats[i].betCents > 0 && seats[i].insurance === null) : undefined;
  const [focus, setFocus] = useSeatFocus(mySeats, myTurn && !revealing ? turn.seat : insuranceSeat ?? null);

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
      await call('leave', {});
    } catch (err) {
      setActionError(friendlyError(err.message));
    } finally {
      setBusy('');
    }
  }

  if (loading) return <LoadingState label="Opening the Blackjack table…" />;
  if (error) return <ErrorState title="Couldn't open the table" message={error} />;

  const dealerHidden = hiddenFrom('d', dealer.cards.length);
  const dealerShown = dealer.cards.slice(0, dealerHidden);
  const results = phase === 'results' && !revealing;
  const activeSeat = turn ? seats[turn.seat] : null;

  // ---- status line ----
  let status;
  if (!table || !seats.some(Boolean)) status = 'Waiting for players. Take a seat to start.';
  else if (phase === 'betting') status = deadline ? `Betting closes in ${seconds ?? 0}s` : seated ? 'Place your bet' : 'Waiting for the first bet';
  else if (revealing) status = 'Dealing…';
  else if (phase === 'insurance') status = 'Dealer shows an Ace. Insurance?';
  else if (phase === 'playing') {
    const handNote = activeSeat?.hands?.length > 1 ? `, hand ${turn.hand + 1}` : '';
    status = myTurn ? `Your turn: seat ${turn.seat + 1}${handNote}` : `${activeSeat?.name ?? 'Next seat'}'s turn (seat ${(turn?.seat ?? 0) + 1})`;
  } else {
    const total = handValue(dealer.cards).total;
    status = table.finish === 'dealerBlackjack' ? 'Dealer blackjack' : total > 21 ? `Dealer busts with ${total}` : `Dealer has ${total}`;
  }
  const showCountdown = deadline && !revealing && phase !== 'results';

  function seatDetail(seat, i) {
    if (results && seat.result) {
      const net = seat.result.netCents;
      return { text: net === 0 ? 'push' : signedMoney(net), tone: net > 0 ? 'win' : net < 0 ? 'lose' : '' };
    }
    if (!seat.hands?.length) {
      const cents = seat.uid === myUid ? localBets[i] ?? seat.betCents : seat.betCents;
      return { text: cents ? `${formatMoney(cents)}${seat.ready ? ' ✓' : ''}` : '—', tone: seat.ready ? 'ready' : '' };
    }
    const labels = seat.hands.map((h, j) => {
      const visible = h.cards.slice(0, hiddenFrom(`${i}-${j}`, h.cards.length));
      if (isBlackjack(visible, h.fromSplit)) return 'BJ';
      const t = handValue(visible).total;
      return t > 21 ? 'bust' : String(t);
    });
    return { text: labels.join(' · '), tone: turn?.seat === i && phase === 'playing' ? 'active' : '' };
  }

  // Someone else's turn: show their hand on the felt so everyone can follow.
  const spotlight = phase === 'playing' && activeSeat && !mySeats.includes(turn.seat) ? { seat: activeSeat, index: turn.seat } : null;

  // What each of my seat tabs flags.
  function tabNote(i) {
    const seat = seats[i];
    if (phase === 'playing' && turn?.seat === i && !revealing) return 'turn';
    if (phase === 'insurance' && seat.betCents > 0 && seat.insurance === null && !revealing) return 'insurance?';
    if (results && seat.result) return seat.result.netCents === 0 ? 'push' : signedMoney(seat.result.netCents);
    if (phase === 'betting') return seat.ready ? '✓' : (localBets[i] ?? seat.betCents) ? formatMoney(localBets[i] ?? seat.betCents) : '';
    return '';
  }

  return (
    <section className="page table-page">
      <div className="slots-top">
        <Link to="/casino" className="btn btn-ghost small">
          ‹ Casino
        </Link>
        <h2 className="section-title">Blackjack</h2>
        {table?.shoe ? (
          <span className="muted small shoe-count">
            Shoe {table.shoe.remaining}/{table.shoe.total}
          </span>
        ) : null}
        <ChatButton chat={chat} />
      </div>

      <div className={`card table-status phase-${phase}`} role="status">
        <span className="table-status-text">{status}</span>
        {results && deadline ? <span className="muted small">Next hand in {seconds ?? 0}s</span> : null}
        {showCountdown ? (
          <span className={seconds !== null && seconds <= 5 ? 'countdown urgent' : 'countdown'} aria-hidden="true">
            {seconds ?? 0}
          </span>
        ) : null}
      </div>

      <div className="card bj-felt">
        <HandView label="Dealer" cards={dealer.cards} hiddenFrom={dealerHidden} holeDown={dealer.holeDown} fromSplit={false} />
        {!dealerShown.length && phase === 'betting' ? <p className="muted small bac-felt-hint">Cards are dealt when betting closes. Dealer hits soft 17.</p> : null}
        {spotlight ? (
          <div className="bj-spotlight">
            {spotlight.seat.hands.map((h, j) => (
              <HandView
                key={j}
                label={`${spotlight.seat.name}${spotlight.seat.hands.length > 1 ? ` · ${j + 1}` : ''}`}
                cards={h.cards}
                fromSplit={h.fromSplit}
                hiddenFrom={hiddenFrom(`${spotlight.index}-${j}`, h.cards.length)}
                active={turn.hand === j}
                betCents={h.betCents}
              />
            ))}
          </div>
        ) : null}
      </div>

      <TableSeats seats={seats} myUid={myUid} canSit sitting={busy === 'sit'} onSit={sit} detail={seatDetail} />

      {seated ? (
        <>
          {mySeats.length > 1 ? (
            <div className="seat-tabs" role="tablist" aria-label="Your seats">
              {mySeats.map((i) => {
                const note = tabNote(i);
                return (
                  <button
                    key={i}
                    type="button"
                    role="tab"
                    aria-selected={focus === i}
                    aria-controls={`seat-panel-${i}`}
                    className={['seat-tab', focus === i ? 'active' : '', note === 'turn' || note === 'insurance?' ? 'needs' : ''].filter(Boolean).join(' ')}
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
              turn={turn}
              revealing={revealing}
              results={results}
              hiddenFrom={hiddenFrom}
              call={call}
              roundId={table?.roundId ?? null}
              balanceCents={balanceCents}
              chip={chip}
              setChip={setChip}
              onPending={pendingFor(i)}
              onLocalBet={localBetFor(i)}
              onError={setActionError}
            />
          ))}
          <p className="muted small seat-more">
            {mySeats.length < seats.length && seats.some((s) => !s) ? 'Tap an empty seat to play another hand; each seat plays on its own.' : ''}
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
          <span className="muted small">{seats.every(Boolean) ? 'All 5 seats are taken. You can keep watching.' : 'Tap an empty seat above to sit down and play. You can take more than one.'}</span>
        </div>
      )}

      {actionError ? (
        <p className="error-text small" role="alert">
          {actionError}
        </p>
      ) : null}

      <p className="muted small table-rules">
        6 decks. Blackjack pays 3:2; insurance up to half your bet pays 2:1. Dealer hits soft 17 and peeks with an Ace or 10. One
        split per hand (split Aces get one card), double on any first two cards, also after a split. 15 s per hand; time out = stand.
        {BET_HELP_TEXT} Each seat bets on its own; sit in as many seats as you like.
      </p>
      <ChatDrawer chat={chat} />
    </section>
  );
}
