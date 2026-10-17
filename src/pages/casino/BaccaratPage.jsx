// Baccarat table. Everything on screen comes from one live doc, casinoTables/baccarat; every tap is a
// call to /api/casino. Top to bottom: status and countdown, the cards, the five seats, the scoreboard
// (roads), then (when seated) your bets and buttons, just above the tab bar.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChipRack, ChipStack } from '../../components/casino/Chips.jsx';
import { Link } from 'react-router-dom';
import BaccaratScoreboard from '../../components/casino/BaccaratScoreboard.jsx';
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
import {
  BACCARAT_ODDS,
  SPOT_LABELS,
  handTotal,
  coupRevealTimes,
  revealOrder,
  totalBetCents,
} from '../../../shared/casino/baccarat.js';

const GAME = 'baccarat';
const SPOT_ORDER = ['player', 'tie', 'banker'];
const NO_SEATS = [null, null, null, null, null];
const NO_BETS = { player: 0, banker: 0, tie: 0 };
const MAX_SPOT_CENTS = CASINO_MAX_BET_DOLLARS * 100;
const WINNER_TEXT = { player: 'Player wins', banker: 'Banker wins', tie: 'Tie' };

function signedMoney(cents) {
  if (cents > 0) return `+${formatMoney(cents)}`;
  if (cents < 0) return `−${formatMoney(-cents)}`;
  return formatMoney(0);
}

function Hand({ label, cards, visibleCount, total, winner, freshFrom }) {
  return (
    <div className={winner ? `bac-hand ${label.toLowerCase()} won` : `bac-hand ${label.toLowerCase()}`}>
      <div className="bac-hand-head">
        <span>{label}</span>
        <span className="bac-total" aria-live="polite">
          {visibleCount > 0 ? total : ''}
        </span>
      </div>
      <div className="bac-cards">
        {cards.slice(0, visibleCount).map((card, i) => (
          <PlayingCard key={card} card={card} fresh={i >= freshFrom} />
        ))}
        {visibleCount === 0 ? <span className="bac-cards-empty" aria-hidden="true" /> : null}
      </div>
    </div>
  );
}

export default function BaccaratPage() {
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
  const roundId = table?.roundId ?? null;

  const seconds = useCountdown(deadline);
  useDeadlineTick(GAME, deadline, Boolean(table));
  useHeartbeat(GAME, Boolean(mySeat));

  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(''); // 'sit' | 'leave' | 'confirm' while that call is in flight
  const [chip, setChip] = useState(1);

  // Arriving at the table: one tick applies anything overdue (an abandoned table waits for the first
  // visitor) and gives this phone the server's clock. Runs once per visit.
  useEffect(() => {
    tableAction(GAME, 'tick').catch(() => {});
  }, []);

  // ---- the deal: cards turn over at the server's times (0.5 s apart, 1 s before a third card) ----
  const coup = phase === 'results' ? table?.coup ?? null : null;
  const order = coup ? revealOrder(coup.player, coup.banker) : [];
  const shown = useTimedReveal(coup?.dealtAt ?? null, coup ? coupRevealTimes(coup.player, coup.banker) : []);
  const revealing = Boolean(coup) && shown < order.length;
  const visible = { player: 0, banker: 0 };
  order.slice(0, shown).forEach((o) => {
    visible[o.hand] += 1;
  });
  const playerCards = coup?.player ?? [];
  const bankerCards = coup?.banker ?? [];
  const winner = coup && !revealing ? coup.winner : null;

  // ---- while the cards turn, the nav wallet shows the pre-deal balance (no spoilers) ----
  const preDealRef = useRef(null);
  useEffect(() => {
    if (phase === 'betting') preDealRef.current = balanceCents;
  }, [phase, balanceCents]);
  const holdWallet = revealing && Boolean(mySeat?.result);
  useEffect(() => {
    if (!holdWallet || preDealRef.current === null) return undefined;
    setHeldCents(preDealRef.current);
    return () => setHeldCents(null);
  }, [holdWallet, setHeldCents]);

  // ---- my chips: on the felt the moment I tap; taps close together go as one request ----
  const serverBets = mySeat?.bets ?? NO_BETS;
  const canBet = Boolean(mySeat) && phase === 'betting' && !mySeat.ready && !mySeat.leaving;
  const validate = useCallback(
    (spot, cents, after) => {
      if (cents > MAX_SPOT_CENTS) return `${SPOT_LABELS[spot]} holds up to $${CASINO_MAX_BET_DOLLARS}.`;
      const extra = totalBetCents(after) - totalBetCents(serverBets);
      if (extra > balanceCents) return `Not enough in your wallet (${formatMoney(balanceCents)}).`;
      return '';
    },
    [serverBets, balanceCents],
  );
  const sendChips = useCallback(
    (_changes, totals) =>
      call('bet', {
        player: (totals.player ?? 0) / 100,
        banker: (totals.banker ?? 0) / 100,
        tie: (totals.tie ?? 0) / 100,
        requestId: newRequestId(),
      }),
    [call],
  );
  const chips = useChipBetting({ spots: serverBets, roundKey: roundId, validate, send: sendChips, onPending: setPendingCents, enabled: canBet });
  const myBets = { ...NO_BETS, ...chips.spots };
  const myTotal = totalBetCents(myBets);

  async function run(kind, action, fields) {
    setBusy(kind);
    setActionError('');
    try {
      await call(action, fields);
    } catch (err) {
      setActionError(friendlyError(err.message));
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

  // ---- what each seat tile says ----
  function seatDetail(seat) {
    if (phase === 'results' && seat.result && !revealing) {
      const net = seat.result.netCents;
      return { text: net === 0 ? 'push' : signedMoney(net), tone: net > 0 ? 'win' : net < 0 ? 'lose' : '' };
    }
    const total = totalBetCents(seat.uid === myUid ? myBets : seat.bets);
    if (!total) return { text: '—' };
    return { text: `${formatMoney(total)}${seat.ready ? ' ✓' : ''}`, tone: seat.ready ? 'ready' : '' };
  }

  // ---- status line ----
  let status;
  if (!table || !seats.some(Boolean)) status = 'Waiting for players. Take a seat to start.';
  else if (phase === 'betting') status = deadline ? `Betting closes in ${seconds ?? 0}s` : mySeat ? 'Place your bets' : 'Waiting for the first bet';
  else if (revealing) status = 'Dealing…';
  else status = `${WINNER_TEXT[coup?.winner] ?? 'Hand over'} ${coup ? `${coup.playerTotal}–${coup.bankerTotal}` : ''}`.trim();

  if (loading) return <LoadingState label="Opening the Baccarat table…" />;
  if (error) return <ErrorState title="Couldn't open the table" message={error} />;

  const myResult = mySeat?.result && phase === 'results' && !revealing ? mySeat.result : null;
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

      <div className="card bac-felt">
        <Hand label="Player" cards={playerCards} visibleCount={visible.player} total={handTotal(playerCards.slice(0, visible.player))} winner={winner === 'player'} freshFrom={0} />
        <Hand label="Banker" cards={bankerCards} visibleCount={visible.banker} total={handTotal(bankerCards.slice(0, visible.banker))} winner={winner === 'banker'} freshFrom={0} />
        {winner ? (
          <div className={`bac-banner banner-${winner}`}>
            {WINNER_TEXT[winner]}
            {coup.natural ? ' · natural' : ''}
            {myResult ? <span className="bac-banner-me">You {myResult.netCents === 0 ? 'push' : signedMoney(myResult.netCents)}</span> : null}
          </div>
        ) : null}
        {!coup ? <p className="muted small bac-felt-hint">{phase === 'betting' ? 'Cards are dealt when betting closes.' : ''}</p> : null}
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
        <div className="card bac-controls">
          <div className="bac-spots">
            {SPOT_ORDER.map((spot) => (
              <button
                key={spot}
                type="button"
                className={['bac-spot', spot, winner === spot ? 'won' : '', myBets[spot] ? 'has-bet' : ''].filter(Boolean).join(' ')}
                onClick={() => chips.place(spot, chip * 100)}
                disabled={!canBet}
                aria-label={`${SPOT_LABELS[spot]}, pays ${BACCARAT_ODDS[spot].label}, your bet ${formatMoney(myBets[spot])}. Tap to add a $${chip} chip.`}
              >
                <span className="bac-spot-name">{SPOT_LABELS[spot]}</span>
                <span className="bac-spot-odds">{BACCARAT_ODDS[spot].label}</span>
                <span className="spot-chips">
                  <ChipStack cents={myBets[spot]} />
                  <span className="bac-spot-bet">{myBets[spot] ? formatMoney(myBets[spot]) : '—'}</span>
                </span>
              </button>
            ))}
          </div>

          <ChipRack
            chip={chip}
            onChip={setChip}
            onUndo={chips.undo}
            onClear={chips.clear}
            canUndo={chips.canUndo}
            disabled={!canBet}
            extra={
              <button
                type="button"
                className="btn btn-primary"
                onClick={confirmBets}
                disabled={!canBet || myTotal === 0 || busy === 'confirm'}
              >
                {mySeat.ready ? 'Confirmed ✓' : busy === 'confirm' ? 'Confirming…' : `Confirm ${myTotal ? formatMoney(myTotal) : ''}`.trim()}
              </button>
            }
          />

          <p className="muted small bac-help" aria-live="polite">
            {chips.error ? (
              <span className="error-text">{chips.error}</span>
            ) : mySeat.leaving ? (
              'You are leaving: your bets play out, then the seat frees.'
            ) : mySeat.ready && phase === 'betting' ? (
              'Confirmed. The cards come out when everyone confirms or the clock runs out.'
            ) : phase === 'betting' ? (
              `Pick a chip and tap Player, Banker or Tie; each tap adds a chip. Up to $${CASINO_MAX_BET_DOLLARS} a spot.`
            ) : (
              'Bet again when the next hand opens.'
            )}
          </p>

          <button type="button" className="btn btn-ghost small leave-btn" onClick={() => run('leave', 'leave')} disabled={busy === 'leave' || mySeat.leaving}>
            {mySeat.leaving ? 'Leaving after this hand' : 'Leave seat'}
          </button>
        </div>
      ) : (
        <div className="card watch-note">
          <strong>You're watching.</strong>
          <span className="muted small">{tableFull ? 'All 5 seats are taken. You can keep watching.' : 'Tap an empty seat above to sit down and play.'}</span>
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
    </section>
  );
}
