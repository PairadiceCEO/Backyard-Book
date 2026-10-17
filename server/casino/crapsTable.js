// Craps and Crapless Craps at the shared table: one engine, built for each variant from
// shared/casino/diceVariants.js. The rules themselves are the pure functions in shared/casino/dice.js.
//
//   Bets       bet { kind, number?, amount, requestId } adds to a spot ($1–$10 a time, $10 a spot);
//              removeBet { kind, number? } takes one down before the next roll (Pass / Don't Pass
//              only before a come-out) and refunds it.
//   Roll       the shooter only, with a line bet, carrying rollSeq (rolls so far at the table). It's
//              refused (STALE) only if a roll already happened; other players' bets never block it.
//              Dice come from crypto.randomInt; every bet the roll decides is settled in the same
//              transaction, one payout entry per player per roll.
//   Timers     come-out: the 15 s clock starts at the first bet after the last roll; with a point on, it
//              starts right after each roll. At zero the server rolls for the shooter. On a come-out
//              with no line bet from the shooter, the dice pass to the next seat and the clock restarts;
//              after a full lap with no shooter willing, the table waits (no clock) until someone bets
//              a line, and that player gets the dice.
//   Seven-out  the dice go to the next occupied seat, clockwise.
//   Seats      after every roll, a seat whose player left or has been gone 60 s: Pass / Don't Pass /
//              Odds keep working until they resolve; once none are left the seat frees and its Place
//              and Field bets are refunded.

import { HttpError } from '../http.js';
import { requireSeat } from './tableRunner.js';
import { seatIsStale } from './seats.js';
import { formatDollars } from './money.js';
import { REQUEST_ID_PATTERN } from '../../shared/constants.js';
import { CASINO_SEATS, DICE_ANIMATION_MS, TURN_SECONDS, isValidCasinoBet } from '../../shared/casino/constants.js';
import { DICE_VARIANTS } from '../../shared/casino/diceVariants.js';
import {
  BET_KINDS,
  BET_LABELS,
  SPOT_MAX_CENTS,
  cloneBets,
  emptyDiceBets,
  hasLineAction,
  placeBlocker,
  removeBlocker,
  rollKind,
  settleRoll,
  spotAmount,
  totalOnFelt,
} from '../../shared/casino/dice.js';

export { DICE_ANIMATION_MS };
const TURN_MS = TURN_SECONDS * 1000;
const ROLL_HISTORY = 20;
const RECENT_REQUESTS = 8;
const KIND_TEXT = { natural: 'winner', craps: 'craps', point: 'point set', pointMade: 'point made', sevenOut: 'seven out', roll: '' };

function hasLine(seat) {
  return Boolean(seat) && (seat.bets.pass > 0 || seat.bets.dontPass > 0);
}

// Next occupied seat clockwise after `from` (wrapping, `from` itself last). Seats that are leaving
// don't take the dice.
function nextShooter(state, from) {
  const start = Number.isInteger(from) ? from : -1;
  for (let step = 1; step <= CASINO_SEATS; step += 1) {
    const i = (((start + step) % CASINO_SEATS) + CASINO_SEATS) % CASINO_SEATS;
    const seat = state.seats[i];
    if (seat && !seat.leaving) return i;
  }
  return null;
}

function seatedCount(state) {
  return state.seats.filter((s) => s && !s.leaving).length;
}

export function makeDiceEngine(variantId) {
  const variant = DICE_VARIANTS[variantId];
  if (!variant) throw new Error(`no dice variant ${variantId}`);
  const game = variant.id;

  const rollId = (state) => `${state.epoch}-${state.rollSeq}`;

  function createTable(now) {
    return {
      game,
      epoch: now.toString(36),
      rollSeq: 0,
      point: null,
      shooter: null,
      deadline: null,
      waiting: false,
      lap: 0,
      lastRoll: null,
      rolls: [],
      moneySeq: 0,
      seats: Array.from({ length: CASINO_SEATS }, () => null),
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  function newSeat({ uid, name, sitAt }) {
    return { uid, name, sitAt, leaving: false, reqs: [], bets: emptyDiceBets(), lastRoll: null };
  }

  // Pass, Don't Pass and Odds have to play out; Place and Field can be refunded.
  function seatInPlay(state, index) {
    const seat = state.seats[index];
    return Boolean(seat) && hasLineAction(seat.bets);
  }

  function isIdle(state) {
    return state.seats.every((seat) => !seat || totalOnFelt(seat.bets) === 0);
  }

  function refund(ctx, seat, cents, what) {
    if (cents <= 0) return;
    ctx.state.moneySeq = (Number(ctx.state.moneySeq) || 0) + 1;
    ctx.addMoney(seat.uid, {
      id: `cref_${game}_${ctx.state.epoch}_${seat.uid}_${ctx.state.moneySeq}`,
      type: 'casino_refund',
      amountCents: cents,
      roundId: rollId(ctx.state),
      note: `${variant.name}: ${what} refunded`,
    });
  }

  // A seat is about to be freed: its Place and Field bets come back to the wallet.
  async function beforeFree(ctx, index) {
    const seat = ctx.state.seats[index];
    if (!seat) return;
    const bets = cloneBets(seat.bets);
    const placeTotal = Object.values(bets.place).reduce((s, v) => s + (v || 0), 0);
    refund(ctx, seat, placeTotal + bets.field, 'Place and Field bets (seat freed)');
    seat.bets = { ...bets, place: {}, field: 0 };
  }

  // Keep the dice with a seated player; with nobody seated the table stops its clock.
  async function afterSeatsChanged(ctx) {
    const { state } = ctx;
    if (seatedCount(state) === 0 && !state.seats.some((s) => s && hasLineAction(s.bets))) {
      state.shooter = null;
      state.deadline = null;
      state.waiting = false;
      state.lap = 0;
      return;
    }
    const current = state.shooter === null ? null : state.seats[state.shooter];
    if (!current || (current.leaving && !hasLineAction(current.bets))) {
      state.shooter = nextShooter(state, state.shooter ?? -1);
      state.lap = 0;
    }
  }

  // ---------- actions ----------

  async function bet(ctx, body) {
    const index = requireSeat(ctx);
    const { state } = ctx;
    const seat = state.seats[index];
    const kind = body.kind;
    if (!BET_KINDS.includes(kind)) throw new HttpError(400, 'BAD_BET', 'Pick a bet: pass, dontPass, odds, place or field.');
    const number = kind === 'place' ? body.number : undefined;
    if (kind === 'place' && !Number.isInteger(number)) throw new HttpError(400, 'BAD_BET', 'A Place bet needs its number.');
    if (!isValidCasinoBet(body.amount)) throw new HttpError(400, 'BAD_BET', 'Bets are whole dollars from $1 to $10.');
    if (typeof body.requestId !== 'string' || !REQUEST_ID_PATTERN.test(body.requestId)) {
      throw new HttpError(400, 'BAD_REQUEST_ID', 'Missing or invalid requestId.');
    }
    if (seat.reqs?.includes(body.requestId)) return { duplicate: true };
    if (seat.leaving) throw new HttpError(409, 'LEAVING', "You're leaving this table.");
    const blocked = placeBlocker(variant, state.point, seat.bets, kind, number);
    if (blocked) throw new HttpError(409, 'BET_NOT_ALLOWED', blocked);
    const cents = body.amount * 100;
    const already = spotAmount(seat.bets, kind, number);
    if (already + cents > SPOT_MAX_CENTS) {
      throw new HttpError(409, 'SPOT_LIMIT', `That spot holds up to ${formatDollars(SPOT_MAX_CENTS)}; you have ${formatDollars(already)} there.`);
    }
    const id = `cbet_${ctx.caller.uid}_${body.requestId}`;
    if (await ctx.ledgerExists(id)) return { duplicate: true };
    const balance = await ctx.balance(seat.uid);
    if (balance < cents) throw new HttpError(409, 'INSUFFICIENT_BALANCE', `Your wallet has ${formatDollars(balance)}; that needs ${formatDollars(cents)}.`);

    const label = kind === 'place' ? `Place ${number}` : BET_LABELS[kind];
    ctx.addMoney(seat.uid, { id, type: 'casino_bet', amountCents: -cents, roundId: rollId(state), note: `${variant.name}: ${label} ${formatDollars(cents)}`, extra: { requestId: body.requestId } });
    const bets = cloneBets(seat.bets);
    if (kind === 'place') bets.place[number] = already + cents;
    else bets[kind] = already + cents;
    seat.bets = bets;
    seat.reqs = [...(seat.reqs ?? []), body.requestId].slice(-RECENT_REQUESTS);

    if (state.shooter === null) state.shooter = nextShooter(state, -1);
    if (state.point === null) {
      const isLine = kind === 'pass' || kind === 'dontPass';
      if (state.waiting) {
        if (isLine) {
          // Nobody wanted the dice; the first player to bet a line gets them.
          state.shooter = index;
          state.waiting = false;
          state.lap = 0;
          state.deadline = ctx.now + TURN_MS;
        }
      } else if (!state.deadline) {
        state.deadline = ctx.now + TURN_MS; // the first bet after the last roll starts the clock
      }
    }
    ctx.changed = true;
    return { spotCents: already + cents };
  }

  async function removeBet(ctx, body) {
    const index = requireSeat(ctx);
    const { state } = ctx;
    const seat = state.seats[index];
    const kind = body.kind;
    const number = kind === 'place' ? body.number : undefined;
    if (!BET_KINDS.includes(kind)) throw new HttpError(400, 'BAD_BET', 'Pick a bet to take down.');
    const blocked = removeBlocker(state.point, kind);
    if (blocked) throw new HttpError(409, 'BET_LOCKED', blocked);
    const amount = spotAmount(seat.bets, kind, number);
    if (!amount) throw new HttpError(409, 'NO_BET', 'You have nothing on that spot.');
    const bets = cloneBets(seat.bets);
    if (kind === 'place') delete bets.place[number];
    else bets[kind] = 0;
    if (kind === 'pass') bets.odds = 0; // (Odds can't exist without a point; kept for safety)
    seat.bets = bets;
    refund(ctx, seat, amount, `${kind === 'place' ? `Place ${number}` : BET_LABELS[kind]} taken down`);
    ctx.changed = true;
    return { refundedCents: amount };
  }

  async function roll(ctx, body) {
    const index = requireSeat(ctx);
    const { state } = ctx;
    if (!Number.isInteger(body.rollSeq)) throw new HttpError(400, 'BAD_ROLL', 'A roll needs the table’s rollSeq.');
    // The double-tap guard: only "a roll already happened" refuses it. Bets by other seats don't.
    if (body.rollSeq !== state.rollSeq) throw new HttpError(409, 'STALE', 'That roll already happened.');
    if (state.shooter !== index) throw new HttpError(403, 'NOT_SHOOTER', "You don't have the dice.");
    if (!hasLine(state.seats[index])) throw new HttpError(409, 'NEED_LINE_BET', `Bet Pass${variant.dontPass ? " or Don't Pass" : ''} to roll.`);
    await doRoll(ctx);
    return { rollSeq: state.rollSeq, total: state.lastRoll.total };
  }

  // ---------- the roll ----------

  async function doRoll(ctx) {
    const { state } = ctx;
    const dice = [ctx.randomInt(6) + 1, ctx.randomInt(6) + 1];
    const total = dice[0] + dice[1];
    const pointBefore = state.point;
    const kind = rollKind(variant, pointBefore, total);
    state.rollSeq = (Number(state.rollSeq) || 0) + 1;
    const id = rollId(state);
    const headline = `${total} (${dice[0]}+${dice[1]})${KIND_TEXT[kind] ? `, ${KIND_TEXT[kind]}` : ''}`;

    for (const seat of state.seats) {
      if (!seat) continue;
      const result = settleRoll(variant, pointBefore, seat.bets, total);
      seat.bets = result.bets;
      seat.lastRoll = result.lines.length
        ? { seq: state.rollSeq, netCents: result.netCents, profitCents: result.profitCents, lostCents: result.lostCents, returnCents: result.returnCents }
        : null;
      if (result.returnCents > 0) {
        ctx.addMoney(seat.uid, {
          id: `cpay_${game}_${id}_${seat.uid}`,
          type: 'casino_payout',
          amountCents: result.returnCents,
          roundId: id,
          note: `${variant.name} roll ${state.rollSeq}: ${headline}`,
        });
      }
    }
    state.point = kind === 'point' ? total : kind === 'pointMade' || kind === 'sevenOut' ? null : pointBefore;
    state.lastRoll = { dice, total, at: ctx.now, kind, pointBefore, seq: state.rollSeq, shooter: state.shooter };
    state.rolls = [...(state.rolls ?? []), { d: dice, t: total, k: kind }].slice(-ROLL_HISTORY);

    if (kind === 'sevenOut') {
      state.shooter = nextShooter(state, state.shooter);
      state.lap = 0;
    }

    await sweepSeats(ctx);

    state.waiting = false;
    state.lap = kind === 'sevenOut' ? 0 : state.lap;
    if (state.point !== null && state.shooter !== null) state.deadline = ctx.now + DICE_ANIMATION_MS + TURN_MS;
    else state.deadline = null; // a come-out: the clock waits for the first bet
    ctx.changed = true;
  }

  // After each roll: free seats that left or went quiet once nothing they have must play out.
  async function sweepSeats(ctx) {
    const { state } = ctx;
    for (let i = 0; i < CASINO_SEATS; i += 1) {
      const seat = state.seats[i];
      if (!seat) continue;
      const gone = seat.leaving || (await seatIsStale(ctx, seat));
      if (!gone) continue;
      if (hasLineAction(seat.bets)) {
        seat.leaving = true; // Pass / Don't Pass / Odds keep working
        continue;
      }
      await beforeFree(ctx, i);
      state.seats[i] = null;
    }
    await afterSeatsChanged(ctx);
  }

  async function onDeadline(ctx) {
    const { state } = ctx;
    if (state.shooter === null || !state.seats[state.shooter]) await afterSeatsChanged(ctx);
    if (state.shooter === null) {
      state.deadline = null;
      return;
    }
    if (state.point !== null || hasLine(state.seats[state.shooter])) {
      await doRoll(ctx); // time's up: the server rolls for the shooter
      return;
    }
    // Come-out, and the shooter has no line bet: the dice move on.
    state.shooter = nextShooter(state, state.shooter);
    state.lap = (Number(state.lap) || 0) + 1;
    if (state.shooter === null || state.lap >= seatedCount(state)) {
      state.waiting = true; // a full lap with nobody willing: wait for a line bet, no clock
      state.deadline = null;
    } else {
      state.deadline = ctx.now + TURN_MS;
    }
  }

  return {
    id: game,
    decks: 0,
    variant,
    createTable,
    newSeat,
    seatInPlay,
    isIdle,
    onDeadline,
    afterSeatsChanged,
    beforeFree,
    actions: { bet, removeBet, roll },
  };
}

export const crapsEngine = makeDiceEngine('craps');
export const craplessEngine = makeDiceEngine('crapless');
