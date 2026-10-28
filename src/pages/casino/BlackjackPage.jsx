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
//
// 0.24.0: 21+3, a side bet per seat: a small circle beside the seat's betting spot, on the same chips (validation, Undo,
// batching; it needs a main bet). The server settles it on the first two cards and the dealer's up card as soon as they're
// dealt; the panel and the felt show its result once those three cards are face up. Rebet repeats it; Max stays on the main
// bet and leaves 21+3 as it is.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChipRack, ChipStack } from '../../components/casino/Chips.jsx';
import { Link } from 'react-router-dom';
import PlayingCard from '../../components/casino/PlayingCard.jsx';
import BlackjackFelt from '../../components/casino/BlackjackFelt.jsx';
import MaxBet from '../../components/casino/MaxBet.jsx';
import RulesSheet, { RulesButton } from '../../components/casino/RulesSheet.jsx';
import { blackjackRuleSections } from '../../lib/casinoRules.js';
import { SIDE_BET_NEEDS_MAIN, TWENTY_ONE_3_NAME, twentyOne3Label } from '../../../shared/casino/sideBets.js';
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
import { cardRank } from '../../../shared/casino/cards.js';
import { ChatButton, ChatDrawer } from '../../components/casino/CasinoChat.jsx';
import SoundToggle from '../../components/casino/SoundToggle.jsx';
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

// `handKey` ('d' for the dealer, 'seat-hand' for a player) and `dealAtFor(handKey, cardIndex)` tell each card when the
// server turns it face up, so it can slide out of the shoe at that moment (PlayingCard `dealAt`). The total pill sits beside
// the cards and follows the cards that are face up.
function HandView({ label, cards, fromSplit, hiddenFrom, active, outcome, betCents, showOutcome, holeDown, handKey, dealAtFor }) {
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
      </div>
      <div className="bj-cards-row">
        <div className="bj-cards">
          {visible.map((card, k) => (
            <PlayingCard key={card} card={card} fresh dealAt={dealAtFor ? dealAtFor(handKey, k) : null} />
          ))}
          {showBack ? <PlayingCard card={null} /> : null}
          {!visible.length && !showBack ? <span className="bj-cards-empty" aria-hidden="true" /> : null}
        </div>
        <span className={bust ? 'bj-total bust' : 'bj-total'} aria-live="polite" aria-label={bust ? `bust ${value.total}` : undefined}>
          {total}
        </span>
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
  dealAtFor,
  call,
  roundId,
  balanceCents,
  chip,
  setChip,
  onPending,
  onLocalBet,
  onLocalSide,
  sideShown,
  onError,
}) {
  const [busy, setBusy] = useState('');
  // Rebet (0.19.0): the bet this seat had the last time cards were dealt to it, kept in memory only (a reload forgets it).
  const [lastBet, setLastBet] = useState(0);
  const [lastSide, setLastSide] = useState(0); // 0.24.0: and its 21+3
  const rebetBusy = useRef(false);
  const hands = seat.hands ?? [];
  const myTurn = phase === 'playing' && turn?.seat === index;
  const activeHand = myTurn ? hands[turn.hand] : null;
  const canMove = myTurn && activeHand?.status === 'playing' && !revealing && !busy;

  const canBet = phase === 'betting' && !seat.ready && !seat.leaving;
  // Two spots: the bet and 21+3 ('side').
  const serverSpots = useMemo(() => ({ bet: seat.betCents || 0, side: seat.sideCents || 0 }), [seat.betCents, seat.sideCents]);
  const validate = useCallback(
    (spot, cents, after) => {
      const tooBig = betCeilingProblem(cents); // only the $1,000,000 sanity ceiling: no maximum bet
      if (tooBig) return tooBig;
      if (spot === 'side' && !((after.bet ?? 0) > 0)) return SIDE_BET_NEEDS_MAIN;
      const extra = (after.bet ?? 0) + (after.side ?? 0) - (seat.betCents || 0) - (seat.sideCents || 0);
      if (extra > balanceCents) return `Not enough in your wallet (${formatMoney(balanceCents)}).`;
      return '';
    },
    [seat.betCents, seat.sideCents, balanceCents],
  );
  // Sends the seat's new total; resolves with what the server holds now, so the next batch builds on it.
  const sendChips = useCallback(
    async (_changes, totals) => {
      const reply = await call('bet', { seat: index, amount: (totals.bet ?? 0) / 100, side: (totals.side ?? 0) / 100, requestId: newRequestId() });
      const held = reply?.table?.seats?.[index]?.betCents ?? reply?.betCents;
      const heldSide = reply?.table?.seats?.[index]?.sideCents ?? reply?.sideCents ?? 0;
      return Number.isInteger(held) ? { bet: held, side: Number.isInteger(heldSide) ? heldSide : 0 } : null;
    },
    [call, index],
  );
  const chips = useChipBetting({ spots: serverSpots, roundKey: roundId, validate, send: sendChips, onPending, enabled: canBet });
  const myBetCents = chips.spots.bet ?? 0;
  const mySideCents = chips.spots.side ?? 0;
  // Max (0.23.0): the wallet left for this seat = the balance minus every chip not confirmed yet, on any of my seats.
  const { displayCents, heldCents, pendingCents } = useWalletDisplay();
  const walletLeft = heldCents === null ? displayCents(balanceCents) : balanceCents - pendingCents;

  // Cards are dealt to this seat: remember its bet (the server's seat bet, not a doubled or split hand's).
  const dealtBet = hands.length ? seat.betCents || 0 : 0;
  const dealtSide = hands.length ? seat.sideCents || 0 : 0;
  useEffect(() => {
    if (phase !== 'betting' && dealtBet > 0) {
      setLastBet(dealtBet);
      setLastSide(dealtSide);
    }
  }, [phase, dealtBet, dealtSide]);

  // Rebet / Rebet x2: the same chips as tapping them: one chips.place, so batching, validation (wallet) and Undo all apply.
  // The ref stops a double tap from placing twice before the chips show.
  const showRebet = canBet && lastBet > 0 && myBetCents === 0 && mySideCents === 0;
  const lastTotal = lastBet + lastSide;
  useEffect(() => {
    rebetBusy.current = false;
  }, [myBetCents, roundId]);
  // The bet first, then its 21+3 (which needs the bet). The whole thing or nothing.
  function rebet(times) {
    if (rebetBusy.current || myBetCents > 0) return;
    if (lastTotal * times > balanceCents) {
      chips.setError(`Not enough in your wallet (${formatMoney(balanceCents)}).`);
      return;
    }
    rebetBusy.current = true;
    if (!chips.place('bet', lastBet * times)) {
      rebetBusy.current = false; // refused: nothing placed, the message shows
      return;
    }
    if (lastSide && !chips.place('side', lastSide * times)) chips.clear();
  }

  // The seat tile shows chips the moment they go down, before the server answers.
  useEffect(() => {
    onLocalBet(myBetCents);
  }, [myBetCents, onLocalBet]);
  useEffect(() => {
    onLocalSide(mySideCents);
  }, [mySideCents, onLocalSide]);
  const side = seat.side && sideShown ? seat.side : null; // 21+3's result, once its three cards are face up

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
              handKey={`${index}-${j}`}
              dealAtFor={dealAtFor}
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
          <div className="bj-bet-row">
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
            <button
              type="button"
              className={mySideCents ? 'bj-side-spot has-bet' : 'bj-side-spot'}
              onClick={() => chips.place('side', chip * 100)}
              disabled={!canBet}
              aria-label={`Seat ${index + 1} 21+3 side bet ${formatMoney(mySideCents)}. Tap to add a $${chip} chip.`}
            >
              <span className="bj-side-name">{TWENTY_ONE_3_NAME}</span>
              {mySideCents ? <ChipStack cents={mySideCents} /> : <span className="bj-side-empty">side bet</span>}
            </button>
          </div>
          <ChipRack
            chip={chip}
            onChip={setChip}
            onUndo={chips.undo}
            onClear={chips.clear}
            canUndo={chips.canUndo}
            disabled={!canBet}
            rebet={
              canBet ? (
                <div className="rebet-row">
                  {showRebet ? (
                    <>
                      <button type="button" className="rebet-btn" onClick={() => rebet(1)}>
                        Rebet {formatMoney(lastTotal)}
                      </button>
                      <button type="button" className="rebet-btn" onClick={() => rebet(2)}>
                        Rebet ×2 {formatMoney(lastTotal * 2)}
                      </button>
                    </>
                  ) : null}
                  <MaxBet
                    spotName={`seat ${index + 1}`}
                    currentCents={myBetCents}
                    availableCents={walletLeft}
                    onPlace={(cents) => chips.place('bet', cents)}
                    onRefuse={chips.setError}
                    disabled={!canBet}
                  />
                </div>
              ) : null
            }
            extra={
              <button type="button" className="btn btn-primary" onClick={confirmBet} disabled={!canBet || !myBetCents || busy === 'confirm'}>
                {seat.ready ? 'Confirmed ✓' : busy === 'confirm' ? 'Confirming…' : `Deal me in ${myBetCents ? formatMoney(myBetCents + mySideCents) : ''}`.trim()}
              </button>
            }
          />
          <p className="bj-note muted small" aria-live="polite">
            {chips.error ? (
              <span className="error-text">{chips.error}</span>
            ) : seat.ready ? (
              'Locked in. Cards come out when every seat confirms or the clock runs out.'
            ) : (
              `Pick a chip and tap the spot; each tap adds a chip. 21+3 (beside it) needs a bet. ${BET_HELP_TEXT}`
            )}
          </p>
        </>
      ) : null}

      {side ? (
        <p className={`bj-note bj-side-result ${side.returnCents > 0 ? 'win' : 'lose'}`} data-side-result="">
          21+3: {side.hand ? twentyOne3Label(side.hand) : 'no hand'} {side.returnCents > 0 ? signedMoney(side.returnCents - side.stakeCents) : `−${formatMoney(side.stakeCents)}`}
        </p>
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
    ensureFeltFont(); // the felt and the chips are lettered in Oswald
  }, []);

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

  // When the server turns a given card face up (server ms), so it can slide out of the shoe then; null for cards that aren't
  // part of the latest deal.
  const dealAtFor = useCallback(
    (to, cardIndex) => {
      if (!lastDeal?.at) return null;
      const pos = dealList.findIndex((d) => d.to === to && d.i === cardIndex);
      if (pos === -1) return null;
      const t = dealList[pos].t;
      return lastDeal.at + (Number.isFinite(t) ? t : pos * BLACKJACK_INITIAL_GAP_MS);
    },
    [dealList, lastDeal],
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
  const [localSides, setLocalSides] = useState({}); // 0.24.0: my 21+3 chips, the same way
  const localSideCallbacks = useRef(new Map());
  const localSideFor = useCallback((i) => {
    if (!localSideCallbacks.current.has(i)) {
      localSideCallbacks.current.set(i, (cents) => setLocalSides((prev) => (prev[i] === cents ? prev : { ...prev, [i]: cents })));
    }
    return localSideCallbacks.current.get(i);
  }, []);
  const [rulesOpen, setRulesOpen] = useState(false);
  const closeRules = useCallback(() => setRulesOpen(false), []);
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
    // 0.23.0: the cards and their totals sit on the circle (handsFor); the line under it shows what the seat has bet.
    const bet = seat.hands.reduce((sum, h) => sum + (h.betCents || 0), 0);
    return { text: bet ? formatMoney(bet) : '', tone: turn?.seat === i && phase === 'playing' ? 'active' : '' };
  }

  // Every seat's hands for its circle (mine and everyone else's): only the cards face up right now, each with its total.
  function handsFor(seat, i) {
    return (seat.hands ?? []).map((h, j) => {
      const visible = h.cards.slice(0, hiddenFrom(`${i}-${j}`, h.cards.length));
      const value = handValue(visible);
      let total = '';
      if (visible.length) {
        if (isBlackjack(visible, h.fromSplit)) total = 'BJ';
        else if (value.total > 21) total = `bust ${value.total}`;
        else total = value.soft && value.total < 21 ? `soft ${value.total}` : String(value.total);
      }
      return { cards: visible, total, bust: value.total > 21, active: phase === 'playing' && turn?.seat === i && turn.hand === j && !revealing };
    });
  }

  // The chips drawn in a seat's circle: the bet (mine: the chips as I put them down, before the server answers), or the
  // hands' bets once cards are out (a double or split is more than the first bet).
  function circleBet(seat, i) {
    if (seat.hands?.length) return seat.hands.reduce((sum, h) => sum + (h.betCents || 0), 0);
    return seat.uid === myUid ? localBets[i] ?? seat.betCents ?? 0 : seat.betCents ?? 0;
  }

  // 21+3's three cards (the seat's first two, the dealer's up card) are face up: its result can show.
  function sideShownFor(i) {
    return hiddenFrom(`${i}-0`, 2) >= 2 && hiddenFrom('d', 1) >= 1;
  }

  // The small 21+3 circle beside each seat's circle on the felt: its chips, and once settled and face up, won or lost.
  function sideFor(seat, i) {
    if (seat.side) {
      const known = sideShownFor(i);
      return { cents: seat.side.stakeCents, tone: known ? (seat.side.returnCents > 0 ? 'win' : 'lose') : '', text: known ? (seat.side.returnCents > 0 ? 'WIN' : ' ') : '' };
    }
    const cents = seat.hands?.length ? seat.sideCents ?? 0 : seat.uid === myUid ? localSides[i] ?? seat.sideCents ?? 0 : seat.sideCents ?? 0;
    return cents > 0 ? { cents, tone: '', text: '' } : null;
  }

  // Someone else's turn: show their hand below the felt so everyone can follow.
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
        <SoundToggle />
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

      <BlackjackFelt
        seats={seats}
        myUid={myUid}
        mySeats={mySeats}
        focus={focus}
        onFocus={setFocus}
        sitting={busy === 'sit'}
        onSit={sit}
        detail={seatDetail}
        betFor={circleBet}
        handsFor={handsFor}
        sideFor={sideFor}
        results={results}
        roundKey={table?.roundId ?? 'r'}
        dealer={<HandView label="Dealer" cards={dealer.cards} hiddenFrom={dealerHidden} holeDown={dealer.holeDown} fromSplit={false} handKey="d" dealAtFor={dealAtFor} />}
      />
      {!dealerShown.length && phase === 'betting' ? <p className="muted small bac-felt-hint bjt-hint">Cards are dealt when betting closes. Dealer hits soft 17.</p> : null}
      {spotlight ? (
        <div className="card bj-felt bj-spotlight-card">
          <div className="bj-spotlight">
            {spotlight.seat.hands.map((h, j) => (
              <HandView
                key={j}
                label={`${spotlight.seat.name}${spotlight.seat.hands.length > 1 ? ` · ${j + 1}` : ''}`}
                cards={h.cards}
                fromSplit={h.fromSplit}
                hiddenFrom={hiddenFrom(`${spotlight.index}-${j}`, h.cards.length)}
                handKey={`${spotlight.index}-${j}`}
                dealAtFor={dealAtFor}
                active={turn.hand === j}
                betCents={h.betCents}
              />
            ))}
          </div>
        </div>
      ) : null}

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
              dealAtFor={dealAtFor}
              call={call}
              roundId={table?.roundId ?? null}
              balanceCents={balanceCents}
              chip={chip}
              setChip={setChip}
              onPending={pendingFor(i)}
              onLocalBet={localBetFor(i)}
              onLocalSide={localSideFor(i)}
              sideShown={sideShownFor(i)}
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
        {BET_HELP_TEXT} Each seat bets on its own; sit in as many seats as you like. 21+3 side bet: three-card poker on your
        first two cards and the dealer's up card. <RulesButton onClick={() => setRulesOpen(true)} />
      </p>
      <RulesSheet open={rulesOpen} onClose={closeRules} title="Blackjack rules" sections={blackjackRuleSections()} />
      <ChatDrawer chat={chat} />
    </section>
  );
}
