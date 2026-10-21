// Baccarat at the shared table.
//
//   Seats     a player may hold several; each seat has its own bets, confirm and result.
//   Betting   no timer until the first bet, then 15 s; closes early once every seat has confirmed.
//             `bet` sets a seat's three spots (each $0 or whole dollars ≥ $1, no maximum); a change charges or refunds the
//             difference. `confirm` locks the seat's bets.
//   Deal      when betting closes, in the same transaction: draw from the private shoe, play the coup,
//             pay every seat (one ledger entry per player), add the winner to the shoe's results.
//   Results   up until 5 s after the last card turns over on the phones; then the next round opens
//             and seats whose player left or went quiet are freed.
//
// Public doc (casinoTables/baccarat): phase, deadline, roundNo/roundId, seats, coup (face-up cards,
// totals, winner), shoeResults (every winner this shoe, e.g. "BPPTB", for the scoreboard), shoe counts. The shoe itself is only in private/shoe.

import { HttpError } from '../http.js';
import { requirePhase, requireSeat } from './tableRunner.js';
import { drawCard, reshuffleIfDue } from './shoe.js';
import { freeGoneSeats } from './seats.js';
import { formatDollars, requireBetAmount } from './money.js';
import { REQUEST_ID_PATTERN } from '../../shared/constants.js';
import {
  CASINO_SEATS,
  RESULTS_MS,
  TURN_SECONDS,
} from '../../shared/casino/constants.js';
import {
  BACCARAT_DECKS,
  BACCARAT_MAX_SHOE_RESULTS,
  BACCARAT_RESHUFFLE_AT,
  BACCARAT_SPOTS,
  SPOT_LABELS,
  emptyBets,
  playCoup,
  coupRevealMs,
  settleBaccaratBets,
  totalBetCents,
} from '../../shared/casino/baccarat.js';

const RECENT_REQUESTS = 8;
const WINNER_LETTER = { player: 'P', banker: 'B', tie: 'T' };

function roundIdFor(epoch, roundNo) {
  return `${epoch}-${roundNo}`;
}

function createTable(now) {
  const epoch = now.toString(36);
  return {
    game: 'baccarat',
    epoch,
    roundNo: 1,
    roundId: roundIdFor(epoch, 1),
    phase: 'betting',
    deadline: null,
    seats: Array.from({ length: CASINO_SEATS }, () => null),
    coup: null,
    shoeResults: '',
    shoe: { remaining: BACCARAT_DECKS * 52, total: BACCARAT_DECKS * 52, shuffles: 0 },
    version: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function newSeat({ uid, name, sitAt }) {
  return { uid, name, sitAt, leaving: false, ready: false, bets: emptyBets(), result: null, reqs: [] };
}

// Bets are "in play" from the moment they're charged until the coup settles them.
function seatInPlay(state, index) {
  const seat = state.seats[index];
  return Boolean(seat) && state.phase === 'betting' && totalBetCents(seat.bets) > 0;
}

function anyBets(state) {
  return state.seats.some((seat) => seat && totalBetCents(seat.bets) > 0);
}

function isIdle(state) {
  return state.phase === 'betting' && !anyBets(state);
}

// Everyone still at the table has confirmed (a seat that left keeps its bets and counts as done).
function everyoneReady(state) {
  const seated = state.seats.filter(Boolean);
  return seated.length > 0 && anyBets(state) && seated.every((seat) => seat.ready || seat.leaving);
}

function describeBets(bets) {
  const parts = BACCARAT_SPOTS.filter((spot) => bets[spot] > 0).map((spot) => `${SPOT_LABELS[spot]} ${formatDollars(bets[spot])}`);
  return parts.length ? parts.join(' · ') : 'no bets';
}

function parseBets(body) {
  const bets = {};
  for (const spot of BACCARAT_SPOTS) {
    const dollars = body[spot] ?? 0;
    // $0 clears the spot; otherwise whole dollars ≥ $1 under the sanity ceiling (no maximum; the wallet is the cap).
    if (dollars !== 0) requireBetAmount(dollars);
    bets[spot] = dollars * 100;
  }
  if (typeof body.requestId !== 'string' || !REQUEST_ID_PATTERN.test(body.requestId)) {
    throw new HttpError(400, 'BAD_REQUEST_ID', 'Missing or invalid requestId.');
  }
  return { bets, requestId: body.requestId };
}

// ---------- actions ----------

async function bet(ctx, body) {
  const index = requireSeat(ctx, body);
  const { bets, requestId } = parseBets(body);
  const seat = ctx.state.seats[index];
  if (seat.reqs?.includes(requestId)) return { duplicate: true };
  requirePhase(ctx, 'betting', 'Betting is closed for this hand. Bet again when the next one opens.');
  if (seat.leaving) throw new HttpError(409, 'LEAVING', "You're leaving this table.");
  if (seat.ready) throw new HttpError(409, 'CONFIRMED', 'Your bets are confirmed for this hand.');

  const uid = ctx.caller.uid;
  const roundNo = ctx.state.roundNo;
  const diff = totalBetCents(bets) - totalBetCents(seat.bets);

  if (diff > 0) {
    const id = `cbet_${uid}_${requestId}`;
    if (await ctx.ledgerExists(id)) return { duplicate: true };
    const balance = await ctx.balance(uid);
    if (balance < diff) {
      throw new HttpError(409, 'INSUFFICIENT_BALANCE', `Your wallet has ${formatDollars(balance)}; that needs ${formatDollars(diff)} more.`);
    }
    ctx.addMoney(uid, {
      id,
      type: 'casino_bet',
      amountCents: -diff,
      roundId: ctx.state.roundId,
      note: `Baccarat hand ${roundNo}: ${describeBets(bets)}`,
      extra: { requestId },
    });
  } else if (diff < 0) {
    ctx.addMoney(uid, {
      id: `cref_baccarat_${ctx.state.roundId}_${uid}_s${index}_${requestId}`,
      type: 'casino_refund',
      amountCents: -diff,
      roundId: ctx.state.roundId,
      note: `Baccarat hand ${roundNo}: bets lowered to ${describeBets(bets)}`,
      extra: { requestId },
    });
  }

  seat.bets = bets;
  seat.reqs = [...(seat.reqs ?? []), requestId].slice(-RECENT_REQUESTS);
  if (anyBets(ctx.state) && !ctx.state.deadline) ctx.state.deadline = ctx.now + TURN_SECONDS * 1000;
  ctx.changed = true;
  return { betCents: totalBetCents(bets) };
}

async function confirm(ctx, body) {
  const index = requireSeat(ctx, body);
  const seat = ctx.state.seats[index];
  requirePhase(ctx, 'betting', 'Betting is closed for this hand.');
  if (seat.ready) return { ready: true };
  if (totalBetCents(seat.bets) === 0) throw new HttpError(409, 'NO_BET', 'Place a bet before you confirm.');
  seat.ready = true;
  ctx.changed = true;
  if (everyoneReady(ctx.state)) await closeBetting(ctx);
  return { ready: true, dealt: ctx.state.phase === 'results' };
}

// ---------- phase changes ----------

async function closeBetting(ctx) {
  const { state } = ctx;
  if (!anyBets(state)) {
    // Every bet was taken back: wait for the next first bet.
    state.deadline = null;
    for (const seat of state.seats) if (seat) seat.ready = false;
    ctx.changed = true;
    return;
  }

  const uids = state.seats.filter(Boolean).map((seat) => seat.uid);
  await ctx.prefetch({ wallets: uids, presence: uids }); // payouts + the next round's seat check
  const shoe = await ctx.shoe();
  const reshuffled = reshuffleIfDue(shoe, { decks: BACCARAT_DECKS, reshuffleAt: BACCARAT_RESHUFFLE_AT, minCards: 6 });
  const coup = playCoup(() => drawCard(shoe, ctx.randomInt));
  const headline = coup.winner === 'tie' ? 'Tie' : `${SPOT_LABELS[coup.winner]} wins`;
  const result = `${headline} ${coup.playerTotal}–${coup.bankerTotal}`;

  for (const seat of state.seats) {
    if (!seat) continue;
    const stake = totalBetCents(seat.bets);
    if (stake === 0) {
      seat.result = null;
      continue;
    }
    const settled = settleBaccaratBets(seat.bets, coup.winner);
    seat.result = settled;
    if (settled.returnCents > 0) {
      ctx.addMoney(seat.uid, {
        id: `cpay_baccarat_${state.roundId}_${seat.uid}_s${state.seats.indexOf(seat)}_end`,
        type: 'casino_payout',
        amountCents: settled.returnCents,
        roundId: state.roundId,
        note: `Baccarat hand ${state.roundNo}, seat ${state.seats.indexOf(seat) + 1}: ${result} (${describeBets(seat.bets)})`,
      });
    }
  }

  state.coup = { ...coup, dealtAt: ctx.now, reshuffled };
  // The scoreboard: every winner since the last shuffle. A new shoe starts it over.
  const previous = !reshuffled && typeof state.shoeResults === 'string' ? state.shoeResults : '';
  state.shoeResults = `${previous}${WINNER_LETTER[coup.winner]}`.slice(-BACCARAT_MAX_SHOE_RESULTS);
  delete state.history; // the old 20-hand strip (tables created before the scoreboard)
  state.phase = 'results';
  state.deadline = ctx.now + coupRevealMs(coup.player, coup.banker) + RESULTS_MS;
  ctx.changed = true;
}

async function openNextRound(ctx) {
  const { state } = ctx;
  state.phase = 'betting'; // set first, so nothing counts as "in play" while seats are freed
  state.deadline = null;
  state.coup = null;
  for (const seat of state.seats) {
    if (!seat) continue;
    seat.bets = emptyBets();
    seat.ready = false;
    seat.result = null;
  }
  await freeGoneSeats(ctx, baccaratEngine);
  state.roundNo = (Number(state.roundNo) || 0) + 1;
  state.roundId = roundIdFor(state.epoch, state.roundNo);
  ctx.changed = true;
}

async function onDeadline(ctx) {
  if (ctx.state.phase === 'betting') await closeBetting(ctx);
  else await openNextRound(ctx);
}

// A seat leaving (or being freed) can make "everyone has confirmed" true.
async function afterSeatsChanged(ctx) {
  if (ctx.state.phase === 'betting' && everyoneReady(ctx.state)) await closeBetting(ctx);
}

export const baccaratEngine = {
  id: 'baccarat',
  multiSeat: true, // a player may hold several seats; each has its own bets and limits
  // Actions that can close betting and deal (the shoe is read with the table, in one round trip).
  preloadShoe: (action) => action === 'confirm' || action === 'leave',
  decks: BACCARAT_DECKS,
  createTable,
  newSeat,
  seatInPlay,
  isIdle,
  onDeadline,
  afterSeatsChanged,
  actions: { bet, confirm },
};
