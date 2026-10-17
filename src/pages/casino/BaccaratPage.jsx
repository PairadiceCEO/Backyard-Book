// Baccarat table. Everything on screen comes from one live doc, casinoTables/baccarat; every tap is a
// call to /api/casino. Top to bottom: status and countdown, the cards, the five seats, the history
// strip, then (when seated) your bets and buttons, just above the tab bar.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import PlayingCard from '../../components/casino/PlayingCard.jsx';
import TableSeats from '../../components/casino/TableSeats.jsx';
import { ErrorState, LoadingState, friendlyError } from '../../components/StatusViews.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useWalletDisplay } from '../../context/WalletDisplayContext.jsx';
import { useCardReveal, useCasinoTable, useCountdown, useDeadlineTick, useHeartbeat } from '../../hooks/useCasinoTable.js';
import { newRequestId, tableAction } from '../../lib/casino.js';
import { formatMoney } from '../../lib/format.js';
import { CASINO_MAX_BET_DOLLARS } from '../../../shared/casino/constants.js';
import {
  BACCARAT_CARD_REVEAL_MS,
  BACCARAT_ODDS,
  SPOT_LABELS,
  handTotal,
  revealOrder,
  totalBetCents,
} from '../../../shared/casino/baccarat.js';

const GAME = 'baccarat';
const CHIPS = [1, 2, 5, 10];
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

function HistoryStrip({ history }) {
  if (!history?.length) return <p className="muted small history-empty">No hands yet this shoe.</p>;
  return (
    <ol className="bac-history" aria-label="Last hands, oldest first">
      {history.map((h, i) => (
        <li key={i} className={`bead bead-${h.w}`} title={`${h.w === 'T' ? 'Tie' : h.w === 'P' ? 'Player' : 'Banker'} ${h.p}–${h.b}`}>
          {h.w}
        </li>
      ))}
    </ol>
  );
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
  const { setHeldCents } = useWalletDisplay();
  const { table, loading, error } = useCasinoTable(GAME);

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
  const [note, setNote] = useState('');

  // Arriving at the table: one tick applies anything overdue (an abandoned table waits for the first
  // visitor) and gives this phone the server's clock. Runs once per visit.
  useEffect(() => {
    tableAction(GAME, 'tick').catch(() => {});
  }, []);

  // ---- the deal, turned over one card at a time ----
  const coup = phase === 'results' ? table?.coup ?? null : null;
  const order = coup ? revealOrder(coup.player, coup.banker) : [];
  const shown = useCardReveal(coup?.dealtAt ?? null, order.length, BACCARAT_CARD_REVEAL_MS);
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

  // ---- my bets: shown locally at once, sent one request at a time (the latest total wins) ----
  const serverBets = mySeat?.bets ?? NO_BETS;
  const sp = serverBets.player;
  const sb = serverBets.banker;
  const st = serverBets.tie;
  const [desired, setDesired] = useState(null);
  const [sending, setSending] = useState(false);
  const queuedRef = useRef(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    setDesired(null);
    queuedRef.current = null;
    setNote('');
  }, [roundId]);

  const sendBets = useCallback(async function send() {
    if (inFlightRef.current || !queuedRef.current) return;
    const target = queuedRef.current;
    queuedRef.current = null;
    inFlightRef.current = true;
    setSending(true);
    try {
      await tableAction(GAME, 'bet', {
        player: target.player / 100,
        banker: target.banker / 100,
        tie: target.tie / 100,
        requestId: newRequestId(),
      });
    } catch (err) {
      queuedRef.current = null;
      setDesired(null);
      setActionError(friendlyError(err.message));
    } finally {
      inFlightRef.current = false;
      setSending(false);
    }
    if (queuedRef.current) send();
  }, []);

  // Once the table shows what was sent, drop the local copy.
  useEffect(() => {
    if (!desired || sending || queuedRef.current) return;
    if (desired.player === sp && desired.banker === sb && desired.tie === st) setDesired(null);
  }, [desired, sending, sp, sb, st]);

  const myBets = desired ?? serverBets;
  const myTotal = totalBetCents(myBets);
  const canBet = Boolean(mySeat) && phase === 'betting' && !mySeat.ready && !mySeat.leaving;
  const pending = sending || desired !== null;

  function changeBets(next) {
    const extra = totalBetCents(next) - totalBetCents(serverBets);
    if (extra > balanceCents) {
      setActionError(`Your wallet has ${formatMoney(balanceCents)}. Add money in the Shop.`);
      return;
    }
    setActionError('');
    setDesired(next);
    queuedRef.current = next;
    sendBets();
  }

  function placeChip(spot) {
    if (!canBet) return;
    const nextAmount = Math.min(MAX_SPOT_CENTS, myBets[spot] + chip * 100);
    if (nextAmount === myBets[spot]) {
      setNote(`${SPOT_LABELS[spot]} is at the $${CASINO_MAX_BET_DOLLARS} limit.`);
      return;
    }
    setNote(nextAmount < myBets[spot] + chip * 100 ? `${SPOT_LABELS[spot]} capped at $${CASINO_MAX_BET_DOLLARS}.` : '');
    changeBets({ ...myBets, [spot]: nextAmount });
  }

  function clearBets() {
    if (!canBet || myTotal === 0) return;
    setNote('');
    changeBets({ ...NO_BETS });
  }

  async function run(kind, action, fields) {
    setBusy(kind);
    setActionError('');
    try {
      await tableAction(GAME, action, fields);
    } catch (err) {
      setActionError(friendlyError(err.message));
    } finally {
      setBusy('');
    }
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

      <div className="card">
        <h3 className="small-heading">Last {table?.history?.length || 0} hands</h3>
        <HistoryStrip history={table?.history} />
      </div>

      {mySeat ? (
        <div className="card bac-controls">
          <div className="bac-spots">
            {SPOT_ORDER.map((spot) => (
              <button
                key={spot}
                type="button"
                className={['bac-spot', spot, winner === spot ? 'won' : '', myBets[spot] ? 'has-bet' : ''].filter(Boolean).join(' ')}
                onClick={() => placeChip(spot)}
                disabled={!canBet}
                aria-label={`${SPOT_LABELS[spot]}, pays ${BACCARAT_ODDS[spot].label}, your bet ${formatMoney(myBets[spot])}. Tap to add $${chip}.`}
              >
                <span className="bac-spot-name">{SPOT_LABELS[spot]}</span>
                <span className="bac-spot-odds">{BACCARAT_ODDS[spot].label}</span>
                <span className="bac-spot-bet">{myBets[spot] ? formatMoney(myBets[spot]) : '—'}</span>
              </button>
            ))}
          </div>

          <div className="quick-bets" role="radiogroup" aria-label="Chip">
            {CHIPS.map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={chip === d}
                className={chip === d ? 'btn chip active' : 'btn chip'}
                onClick={() => setChip(d)}
                disabled={!canBet}
              >
                ${d}
              </button>
            ))}
          </div>

          <div className="bac-actions">
            <button type="button" className="btn" onClick={clearBets} disabled={!canBet || myTotal === 0}>
              Clear
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => run('confirm', 'confirm')}
              disabled={!canBet || myTotal === 0 || pending || busy === 'confirm'}
            >
              {mySeat.ready ? 'Confirmed ✓' : busy === 'confirm' ? 'Confirming…' : `Confirm ${myTotal ? formatMoney(myTotal) : ''}`.trim()}
            </button>
          </div>

          <p className="muted small bac-help" aria-live="polite">
            {note ||
              (mySeat.leaving
                ? 'You are leaving: your bets play out, then the seat frees.'
                : mySeat.ready && phase === 'betting'
                  ? 'Confirmed. The cards come out when everyone confirms or the clock runs out.'
                  : phase === 'betting'
                    ? `Pick a chip, tap Player, Banker or Tie. $1–$${CASINO_MAX_BET_DOLLARS} per spot.`
                    : 'Bet again when the next hand opens.')}
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

      <p className="muted small table-rules">
        Player pays 1:1, Banker 0.95:1 (5% commission), Tie 8:1; a Tie pushes Player and Banker bets. 8 decks, standard
        drawing rules, every card dealt on the server.
      </p>
    </section>
  );
}
