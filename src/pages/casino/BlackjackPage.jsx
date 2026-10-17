// Blackjack table. Everything on screen comes from one live doc, casinoTables/blackjack; every tap is a
// call to /api/casino. Top to bottom: status and countdown, the dealer (and whoever is playing), the
// five seats, then (when seated) your hands and buttons, just above the tab bar.
//
// The dealer's face-down card is never in the doc: it shows as a card back until the server turns it
// over. Moves carry the hand's index and actionSeq, so a double tap can't play a hand twice.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChipRack, ChipStack } from '../../components/casino/Chips.jsx';
import { Link } from 'react-router-dom';
import PlayingCard from '../../components/casino/PlayingCard.jsx';
import TableSeats from '../../components/casino/TableSeats.jsx';
import { ErrorState, LoadingState, friendlyError } from '../../components/StatusViews.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useWalletDisplay } from '../../context/WalletDisplayContext.jsx';
import { useCasinoTable, useCountdown, useDeadlineTick, useHeartbeat, useTableCall, useTimedReveal } from '../../hooks/useCasinoTable.js';
import { useChipBetting } from '../../hooks/useChipBetting.js';
import { newRequestId, tableAction } from '../../lib/casino.js';
import { formatMoney } from '../../lib/format.js';
import { CASINO_MAX_BET_DOLLARS } from '../../../shared/casino/constants.js';
import { cardRank } from '../../../shared/casino/cards.js';
import {
  BLACKJACK_INITIAL_GAP_MS,
  canDouble,
  canSplit,
  handValue,
  isBlackjack,
  maxInsuranceCents,
} from '../../../shared/casino/blackjack.js';

const GAME = 'blackjack';
const NO_SPOTS = { bet: 0 };
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

export default function BlackjackPage() {
  const { authUser, profile } = useAuth();
  const myUid = authUser?.uid ?? null;
  const balanceCents = Number(profile?.balanceCents) || 0;
  const { setHeldCents, setPendingCents, reportBalance } = useWalletDisplay();
  const { table, loading, error, accept } = useCasinoTable(GAME);
  const call = useTableCall(GAME, accept, reportBalance);

  const seats = table?.seats ?? NO_SEATS;
  const mySeatIndex = seats.findIndex((seat) => seat && seat.uid === myUid);
  const mySeat = mySeatIndex >= 0 ? seats[mySeatIndex] : null;
  const phase = table?.phase ?? 'betting';
  const deadline = table?.deadline ?? null;
  const turn = table?.turn ?? null;
  const dealer = table?.dealer ?? { cards: [], holeDown: false };

  const seconds = useCountdown(deadline);
  useDeadlineTick(GAME, deadline, Boolean(table));
  useHeartbeat(GAME, Boolean(mySeat));

  const [chip, setChip] = useState(5);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    tableAction(GAME, 'tick').catch(() => {});
  }, []);

  // ---- cards dealt in the latest write turn over at the server's times ----
  // (opening cards 0.5 s apart, later cards 1 s apart; t is each card's offset from lastDeal.at)
  const lastDeal = table?.lastDeal ?? null;
  const dealList = lastDeal?.cards ?? [];
  const shown = useTimedReveal(lastDeal?.at ?? null, dealList.map((c, k) => (Number.isFinite(c.t) ? c.t : k * BLACKJACK_INITIAL_GAP_MS)));
  const revealing = dealList.length > 0 && shown < dealList.length;
  // For each hand, how many of its cards are face up right now.
  const hiddenFrom = (to, cardCount) => {
    let first = cardCount + 1; // +1: "nothing hidden", also lets the face-down hole card show its back
    dealList.forEach((d, pos) => {
      if (d.to === to && pos >= shown) first = Math.min(first, d.i);
    });
    return first;
  };

  // ---- the nav wallet stays put until the cards that decide it are face up ----
  const preRevealRef = useRef(null);
  useEffect(() => {
    if (!revealing) preRevealRef.current = balanceCents;
  }, [revealing, balanceCents]);
  const holdWallet = revealing && Boolean(mySeat?.hands?.length);
  useEffect(() => {
    if (!holdWallet || preRevealRef.current === null) return undefined;
    setHeldCents(preRevealRef.current);
    return () => setHeldCents(null);
  }, [holdWallet, setHeldCents]);

  // ---- my bet: chips stack on the spot at once; taps close together go as one request ----
  const canBet = Boolean(mySeat) && phase === 'betting' && !mySeat.ready && !mySeat.leaving;
  const serverSpots = mySeat ? { bet: mySeat.betCents || 0 } : NO_SPOTS;
  const validate = useCallback(
    (_spot, cents) => {
      if (cents > CASINO_MAX_BET_DOLLARS * 100) return `The bet is up to $${CASINO_MAX_BET_DOLLARS}.`;
      if (cents - (mySeat?.betCents || 0) > balanceCents) return `Not enough in your wallet (${formatMoney(balanceCents)}).`;
      return '';
    },
    [mySeat?.betCents, balanceCents],
  );
  const sendChips = useCallback((_changes, totals) => call('bet', { amount: (totals.bet ?? 0) / 100, requestId: newRequestId() }), [call]);
  const chips = useChipBetting({ spots: serverSpots, roundKey: table?.roundId ?? null, validate, send: sendChips, onPending: setPendingCents, enabled: canBet });
  const myBetCents = chips.spots.bet ?? 0;

  async function run(kind, action, fields = {}) {
    setBusy(kind);
    setActionError('');
    try {
      await call(action, fields);
    } catch (err) {
      // A STALE refusal means the move already happened (double tap) or the timer stood the hand.
      if (err.code !== 'STALE') setActionError(friendlyError(err.message));
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

  if (loading) return <LoadingState label="Opening the Blackjack table…" />;
  if (error) return <ErrorState title="Couldn't open the table" message={error} />;

  const dealerHidden = hiddenFrom('d', dealer.cards.length);
  const dealerShown = dealer.cards.slice(0, dealerHidden);
  const results = phase === 'results' && !revealing;
  const activeSeat = turn ? seats[turn.seat] : null;
  const myTurn = Boolean(mySeat) && turn?.seat === mySeatIndex && phase === 'playing';
  const myHands = mySeat?.hands ?? [];
  const activeHand = myTurn ? myHands[turn.hand] : null;
  const canMove = myTurn && activeHand?.status === 'playing' && !revealing && !busy;

  // ---- status line ----
  let status;
  if (!table || !seats.some(Boolean)) status = 'Waiting for players. Take a seat to start.';
  else if (phase === 'betting') status = deadline ? `Betting closes in ${seconds ?? 0}s` : mySeat ? 'Place your bet' : 'Waiting for the first bet';
  else if (revealing) status = 'Dealing…';
  else if (phase === 'insurance') status = 'Dealer shows an Ace. Insurance?';
  else if (phase === 'playing') status = myTurn ? `Your turn${myHands.length > 1 ? `, hand ${turn.hand + 1}` : ''}` : `${activeSeat?.name ?? 'Next seat'}'s turn`;
  else {
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
      const cents = seat.uid === myUid ? myBetCents : seat.betCents;
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
  const spotlight = phase === 'playing' && activeSeat && turn.seat !== mySeatIndex ? { seat: activeSeat, index: turn.seat } : null;

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

      <TableSeats
        seats={seats}
        myUid={myUid}
        canSit={!mySeat}
        sitting={busy === 'sit'}
        onSit={(seat) => run('sit', 'sit', { seat })}
        detail={seatDetail}
      />

      {mySeat ? (
        <div className="card bj-controls">
          {myHands.length ? (
            <div className={myHands.length > 1 ? 'bj-my-hands split' : 'bj-my-hands'}>
              {myHands.map((h, j) => (
                <HandView
                  key={j}
                  label={myHands.length > 1 ? `Hand ${j + 1}` : 'Your hand'}
                  cards={h.cards}
                  fromSplit={h.fromSplit}
                  hiddenFrom={hiddenFrom(`${mySeatIndex}-${j}`, h.cards.length)}
                  active={myTurn && turn.hand === j}
                  outcome={h.outcome}
                  showOutcome={!revealing && (results || h.outcome === 'bust' || h.outcome === 'blackjack')}
                  betCents={h.betCents}
                />
              ))}
            </div>
          ) : null}

          {phase === 'betting' && !mySeat.leaving ? (
            <>
              <button
                type="button"
                className={myBetCents ? 'bj-bet-spot has-bet' : 'bj-bet-spot'}
                onClick={() => chips.place('bet', chip * 100)}
                disabled={!canBet}
                aria-label={`Your bet ${formatMoney(myBetCents)}. Tap to add a $${chip} chip.`}
              >
                <span className="bj-bet-label">{mySeat.ready ? 'Bet locked in' : 'Tap to bet'}</span>
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
                    {mySeat.ready ? 'Confirmed ✓' : busy === 'confirm' ? 'Confirming…' : `Deal me in ${myBetCents ? formatMoney(myBetCents) : ''}`.trim()}
                  </button>
                }
              />
              <p className="bj-note muted small" aria-live="polite">
                {chips.error ? (
                  <span className="error-text">{chips.error}</span>
                ) : mySeat.ready ? (
                  'Locked in. Cards come out when everyone confirms or the clock runs out.'
                ) : (
                  `Pick a chip and tap the spot; each tap adds a chip. Up to $${CASINO_MAX_BET_DOLLARS}.`
                )}
              </p>
            </>
          ) : null}

          {phase === 'insurance' && !revealing && mySeat.betCents > 0 ? (
            mySeat.insurance === null ? (
              <div className="bac-actions bj-insurance">
                <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => run('ins', 'insurance', { amountCents: 0 })}>
                  No insurance
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={Boolean(busy) || maxInsuranceCents(mySeat.betCents) > balanceCents}
                  onClick={() => run('ins', 'insurance', { amountCents: maxInsuranceCents(mySeat.betCents) })}
                >
                  Insure {formatMoney(maxInsuranceCents(mySeat.betCents))}
                </button>
              </div>
            ) : (
              <p className="bj-note">{mySeat.insurance > 0 ? `Insured for ${formatMoney(mySeat.insurance)} (pays 2:1).` : 'No insurance.'} Waiting for the others.</p>
            )
          ) : null}

          {phase === 'playing' && myHands.length ? (
            <div className="bj-moves">
              {['hit', 'stand', 'double', 'split'].map((move) => {
                const legal =
                  canMove &&
                  (move === 'hit' || move === 'stand' || (move === 'double' && canDouble(activeHand)) || (move === 'split' && canSplit(activeHand, myHands.length)));
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

          {phase === 'playing' && myHands.length && !myTurn ? <p className="bj-note muted small">Waiting for your turn.</p> : null}
          {results && mySeat.result ? (
            <p className={`bj-note bj-net ${mySeat.result.netCents > 0 ? 'win' : mySeat.result.netCents < 0 ? 'lose' : ''}`}>
              This hand: {mySeat.result.netCents === 0 ? 'even' : signedMoney(mySeat.result.netCents)}
            </p>
          ) : null}
          {mySeat.leaving ? <p className="bj-note muted small">You are leaving: your hand plays out (it stands on its timer), then the seat frees.</p> : null}

          <button type="button" className="btn btn-ghost small leave-btn" onClick={() => run('leave', 'leave')} disabled={busy === 'leave' || mySeat.leaving}>
            {mySeat.leaving ? 'Leaving after this hand' : 'Leave seat'}
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
        6 decks. Blackjack pays 3:2; insurance up to half your bet pays 2:1. Dealer hits soft 17 and peeks with an Ace or 10. One
        split per hand (split Aces get one card), double on any first two cards, also after a split. 15 s per hand; time out = stand.
        Bets $1–${CASINO_MAX_BET_DOLLARS}.
      </p>
    </section>
  );
}
