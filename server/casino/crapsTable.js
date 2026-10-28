// Craps and Crapless Craps at the shared table: one engine, built for each variant from
// shared/casino/diceVariants.js. The rules themselves are the pure functions in shared/casino/dice.js.
//
//   Bets       bets { changes: [{ kind, number?, cents }], requestId } puts chips down / takes them back
//              (bet { kind, number?, amount } = one chip). Kinds: pass, dontPass, odds, dontOdds, come,
//              comeOdds (number), place (number), hard (number), field. No maximum (0.16.0): the
//              wallet is the cap, Odds stay at most 2× their line bet (a game rule), and no spot may pass
//              the $1,000,000 sanity ceiling. removeBet { kind, number? } takes one down before the next roll (Pass / Don't Pass
//              only before a come-out; a Come bet that moved to its number can't come down) and
//              refunds it.
//   Roll       the shooter only, with a line bet, carrying rollSeq (rolls so far at the table). It's
//              refused (STALE) only if a roll already happened; other players' bets never block it.
//              Dice come from crypto.randomInt; every bet the roll decides is settled in the same
//              transaction, one payout entry per player per roll.
//   Timers     only with 2 or more players at the table (seated, not leaving), every clock is 30 s
//              (CRAPS_TURN_SECONDS). Come-out: the clock starts at the first bet after the last roll; with
//              a point on, it starts right after each roll (after the dice animation). At zero the server
//              rolls for the shooter. On a come-out with no line bet from the shooter, the dice pass to the
//              next seat and the clock restarts; after a full lap with no shooter willing, the table waits
//              (no clock) until someone bets a line, and that player gets the dice.
//              With 1 player there is no clock at all: no auto-roll, no passing; the dice roll only when the
//              shooter taps Roll. 2+ → 1 clears the clock; 1 → 2+ with a point on starts a 30 s clock then (on
//              a come-out it starts at the next bet). One exception keeps a clock: a shooter who left with
//              bets still in play can't tap Roll, so their dice still roll themselves.
//   Working    0.25.0: working { kind: 'place' | 'hard', number, on } or { all: true, on }, requestId: switches this seat's
//              Place bets / Hard ways ON (or back OFF) for come-out rolls. Only while no point is set; moves no money,
//              writes no ledger entry, never touches the clock. Every new come-out (a point made, a seven-out, a new
//              shooter) starts with them all OFF again (shared/casino/dice.js settleRoll + resetWorking here).
//   Seven-out  the dice go to the next occupied seat, clockwise.
//   Seats      one per player. After every roll, a seat whose player left or has been gone 60 s:
//              line bets, Come bets and every Odds keep working until they resolve; once none are left
//              the seat frees and its Place, Field and Hard-way bets are refunded.

import { HttpError } from '../http.js';
import { requireSeat } from './tableRunner.js';
import { seatIsStale } from './seats.js';
import { formatDollars, requireChip, requireUnderCeiling } from './money.js';
import { REQUEST_ID_PATTERN } from '../../shared/constants.js';
import { BET_CEILING_MESSAGE, CASINO_SEATS, CRAPS_TURN_SECONDS, DICE_ANIMATION_MS } from '../../shared/casino/constants.js';
import { DICE_VARIANTS } from '../../shared/casino/diceVariants.js';
import {
  BET_KINDS,
  BET_LABELS,
  NUMBERED_KINDS,
  cloneBets,
  emptyDiceBets,
  hasLineAction,
  limitProblem,
  placeBlocker,
  refundableCents,
  removeBlocker,
  rollKind,
  setWorking,
  settleRoll,
  spotAmount,
  totalOnFelt,
} from '../../shared/casino/dice.js';

export { DICE_ANIMATION_MS };
const TURN_MS = CRAPS_TURN_SECONDS * 1000;
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

// A new shooter's come-out: every seat's Place bets and Hard ways go back to OFF.
function resetWorking(state) {
  for (const seat of state.seats) if (seat?.bets?.working) seat.bets = cloneBets({ ...seat.bets, working: null });
}

// Players at the table: seated seats whose player is not leaving.
function seatedCount(state) {
  return state.seats.filter((s) => s && !s.leaving).length;
}

// Whether the table runs shooter clocks: 2 or more players, or a shooter who left with bets in play (nobody
// will tap Roll for them, so their dice keep rolling themselves).
export function clocksOn(state) {
  if (seatedCount(state) >= 2) return true;
  const shooter = state.shooter === null || state.shooter === undefined ? null : state.seats[state.shooter];
  return Boolean(shooter?.leaving);
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

  // Line bets, Come bets and every Odds have to play out; Place, Field and Hard ways can be refunded.
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

  // A seat is about to be freed: its Place, Field and Hard-way bets come back to the wallet.
  async function beforeFree(ctx, index) {
    const seat = ctx.state.seats[index];
    if (!seat) return;
    const bets = cloneBets(seat.bets);
    refund(ctx, seat, refundableCents(bets), 'Place, Field and Hard-way bets (seat freed)');
    seat.bets = { ...bets, place: {}, field: 0, hard: {} };
  }

  // Keep the dice with a seated player; with nobody seated the table stops its clock.
  // Then the clock follows the player count: 2+ → 1 clears it; 1 → 2+ with a point on starts 30 s from now
  // (on a come-out it starts at the next bet, as usual).
  async function afterSeatsChanged(ctx) {
    const { state } = ctx;
    const wasOn = typeof state.clocksOn === 'boolean' ? state.clocksOn : Boolean(state.deadline);
    if (seatedCount(state) === 0 && !state.seats.some((s) => s && hasLineAction(s.bets))) {
      state.shooter = null;
      state.deadline = null;
      state.waiting = false;
      state.lap = 0;
      state.clocksOn = false;
      return;
    }
    const current = state.shooter === null ? null : state.seats[state.shooter];
    if (!current || (current.leaving && !hasLineAction(current.bets))) {
      const before = state.shooter;
      state.shooter = nextShooter(state, state.shooter ?? -1);
      state.lap = 0;
      if (state.shooter !== before && state.point === null) resetWorking(state); // a new shooter's come-out
    }
    const on = clocksOn(state);
    if (!on) {
      state.deadline = null;
      state.waiting = false; // nobody to pass the dice to
    } else if (!wasOn && state.point !== null && state.shooter !== null) {
      state.deadline = ctx.now + TURN_MS;
    }
    state.clocksOn = on;
  }

  // ---------- actions ----------

  const CHANGE_LIMIT = 20;

  function parseKind(change) {
    const kind = change?.kind;
    if (!BET_KINDS.includes(kind)) throw new HttpError(400, 'BAD_BET', `Pick a bet: ${BET_KINDS.join(', ')}.`);
    const numbered = NUMBERED_KINDS.includes(kind);
    const number = numbered ? change.number : undefined;
    if (numbered && !(Number.isInteger(number) && number >= 2 && number <= 12)) {
      throw new HttpError(400, 'BAD_BET', `${BET_LABELS[kind]} needs its number.`);
    }
    return { kind, number };
  }

  function labelOf(kind, number) {
    if (kind === 'place') return `Place ${number}`;
    if (kind === 'hard') return `Hard ${number}`;
    if (kind === 'comeOdds') return `Odds on Come ${number}`;
    return BET_LABELS[kind];
  }

  // Writes `amount` into a copy of the bets at one spot.
  function setSpot(bets, kind, number, amount) {
    if (kind === 'place' || kind === 'hard') {
      if (amount > 0) bets[kind][number] = amount;
      else delete bets[kind][number];
    } else if (kind === 'comeOdds') {
      bets.comeOn[number] = { ...bets.comeOn[number], odds: amount };
    } else {
      bets[kind] = amount;
    }
  }

  // Applies chip changes to a copy of the seat's bets: + puts chips down, − takes them back.
  // Returns { bets, addCents, backCents } or throws with the reason (and nothing changes).
  function applyChanges(state, seatBets, changes) {
    const bets = cloneBets(seatBets);
    let addCents = 0;
    let backCents = 0;
    let lastAdded = null;
    for (const change of changes) {
      const { kind, number } = parseKind(change);
      const cents = change.cents;
      if (!Number.isInteger(cents) || cents === 0 || cents % 100 !== 0) throw new HttpError(400, 'BAD_BET', 'Chips are whole dollars.');
      requireUnderCeiling(Math.abs(cents)); // a change is several chips on one spot: an amount, not a chip
      const label = labelOf(kind, number);
      const have = spotAmount(bets, kind, number);
      if (cents > 0) {
        const blocked = placeBlocker(variant, state.point, bets, kind, number);
        if (blocked) throw new HttpError(409, 'BET_NOT_ALLOWED', blocked);
        addCents += cents;
        lastAdded = { kind, number };
      } else {
        const blocked = removeBlocker(state.point, kind);
        if (blocked) throw new HttpError(409, 'BET_LOCKED', blocked);
        if (have + cents < 0) throw new HttpError(409, 'NO_BET', `You have only ${formatDollars(have)} on ${label}.`);
        backCents += -cents;
      }
      setSpot(bets, kind, number, have + cents);
    }
    // The rules are checked on the bets as they would be: each Odds at most 2× its line bet, and no spot past the
    // sanity ceiling. There is no table total and no per-spot maximum.
    const problem = limitProblem(variant, bets, lastAdded ?? {});
    if (problem && addCents > 0) throw new HttpError(problem === BET_CEILING_MESSAGE ? 400 : 409, problem === BET_CEILING_MESSAGE ? 'BET_TOO_LARGE' : 'SPOT_LIMIT', problem);
    requireUnderCeiling(addCents);
    return { bets: cloneBets(bets), addCents, backCents };
  }

  // A chip went down: start the come-out clock, or hand the dice to whoever bets a line while waiting.
  // With 1 player there is no clock: the shooter rolls when they tap Roll.
  function afterChipDown(ctx, index, kinds) {
    const { state } = ctx;
    if (state.shooter === null) state.shooter = nextShooter(state, -1);
    const on = clocksOn(state);
    state.clocksOn = on;
    if (state.point !== null) return;
    if (state.waiting) {
      if (kinds.some((k) => k === 'pass' || k === 'dontPass')) {
        // Nobody wanted the dice; the first player to bet a line gets them.
        state.shooter = index;
        state.waiting = false;
        state.lap = 0;
        state.deadline = on ? ctx.now + TURN_MS : null;
      }
    } else if (!state.deadline && on) {
      state.deadline = ctx.now + TURN_MS; // the first bet after the last roll starts the clock
    }
  }

  // bets { changes: [{ kind, number?, cents }], requestId }: chips tapped within a moment arrive
  // together and are applied all-or-nothing, with one charge and/or one refund.
  async function placeChips(ctx, index, changes, requestId) {
    const { state } = ctx;
    const seat = state.seats[index];
    if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) throw new HttpError(400, 'BAD_REQUEST_ID', 'Missing or invalid requestId.');
    if (seat.reqs?.includes(requestId)) return { duplicate: true };
    const { bets: next, addCents, backCents } = applyChanges(state, seat.bets, changes);
    if (addCents > 0 && seat.leaving) throw new HttpError(409, 'LEAVING', "You're leaving this table.");
    const id = `cbet_${ctx.caller.uid}_${requestId}`;
    if (addCents > 0) {
      if (await ctx.ledgerExists(id)) return { duplicate: true };
      const balance = (await ctx.balance(seat.uid)) + backCents;
      if (balance < addCents) throw new HttpError(409, 'INSUFFICIENT_BALANCE', `Your wallet has ${formatDollars(balance)}; that needs ${formatDollars(addCents)}.`);
    }
    if (backCents > 0) refund(ctx, seat, backCents, 'chips taken back');
    if (addCents > 0) {
      ctx.addMoney(seat.uid, { id, type: 'casino_bet', amountCents: -addCents, roundId: rollId(state), note: `${variant.name}: chips ${formatDollars(addCents)}`, extra: { requestId } });
    }
    seat.bets = next;
    seat.reqs = [...(seat.reqs ?? []), requestId].slice(-RECENT_REQUESTS);
    const added = changes.filter((c) => c.cents > 0).map((c) => c.kind);
    if (added.length) afterChipDown(ctx, index, added);
    ctx.changed = true;
    return { bets: next };
  }

  async function bets(ctx, body) {
    const index = requireSeat(ctx, body);
    const changes = body.changes;
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > CHANGE_LIMIT) {
      throw new HttpError(400, 'BAD_BET', `Send 1–${CHANGE_LIMIT} chip changes.`);
    }
    return placeChips(ctx, index, changes, body.requestId);
  }

  // One bet { kind, number?, amount (dollars), requestId }: the same as a single chip.
  async function bet(ctx, body) {
    const index = requireSeat(ctx, body);
    const { kind, number } = parseKind(body);
    requireChip(body.amount); // one chip: $1, $2, $5, $10, $25, $100, $1,000 or $10,000
    const result = await placeChips(ctx, index, [{ kind, number, cents: body.amount * 100 }], body.requestId);
    return result.duplicate ? result : { spotCents: spotAmount(result.bets, kind, number) };
  }

  async function removeBet(ctx, body) {
    const index = requireSeat(ctx, body);
    const { state } = ctx;
    const seat = state.seats[index];
    const { kind, number } = parseKind(body);
    const blocked = removeBlocker(state.point, kind);
    if (blocked) throw new HttpError(409, 'BET_LOCKED', blocked);
    const amount = spotAmount(seat.bets, kind, number);
    if (!amount && kind === 'come' && Object.keys(cloneBets(seat.bets).comeOn).length) {
      throw new HttpError(409, 'BET_LOCKED', 'A Come bet stays on its number until it wins or loses. Its Odds can come down.');
    }
    if (!amount) throw new HttpError(409, 'NO_BET', 'You have nothing on that spot.');
    const bets = cloneBets(seat.bets);
    setSpot(bets, kind, number, 0);
    let back = amount;
    // Odds can't stay without their line bet (Pass / Don't Pass come down only before a come-out,
    // when there are no Odds; kept for safety).
    if (kind === 'pass' && bets.odds) {
      back += bets.odds;
      bets.odds = 0;
    }
    if (kind === 'dontPass' && bets.dontOdds) {
      back += bets.dontOdds;
      bets.dontOdds = 0;
    }
    seat.bets = cloneBets(bets);
    refund(ctx, seat, back, `${labelOf(kind, number)} taken down`);
    ctx.changed = true;
    return { refundedCents: back };
  }

  // 0.25.0: switch come-out working flags. No money, no ledger, no clock change.
  async function working(ctx, body) {
    const index = requireSeat(ctx, body);
    const { state } = ctx;
    const seat = state.seats[index];
    if (typeof body.requestId !== 'string' || !REQUEST_ID_PATTERN.test(body.requestId)) throw new HttpError(400, 'BAD_REQUEST_ID', 'Missing or invalid requestId.');
    if (seat.reqs?.includes(body.requestId)) return { duplicate: true, bets: cloneBets(seat.bets) };
    if (typeof body.on !== 'boolean') throw new HttpError(400, 'BAD_WORKING', 'Say on: true or on: false.');
    const change = body.all === true ? { all: true, on: body.on } : { kind: body.kind, number: body.number, on: body.on };
    const result = setWorking(variant, state.point, seat.bets, change);
    if (result.problem) throw new HttpError(409, 'WORKING_NOT_ALLOWED', result.problem);
    seat.bets = result.bets;
    seat.reqs = [...(seat.reqs ?? []), body.requestId].slice(-RECENT_REQUESTS);
    ctx.changed = true;
    return { bets: result.bets };
  }

  async function roll(ctx, body) {
    const index = requireSeat(ctx, body);
    const { state } = ctx;
    if (!Number.isInteger(body.rollSeq)) throw new HttpError(400, 'BAD_ROLL', 'A roll needs the table’s rollSeq.');
    // The double-tap guard: only "a roll already happened" refuses it. Bets by other seats don't.
    if (body.rollSeq !== state.rollSeq) throw new HttpError(409, 'STALE', 'That roll already happened.');
    if (state.shooter !== index) throw new HttpError(403, 'NOT_SHOOTER', "You don't have the dice.");
    if (!hasLine(state.seats[index])) throw new HttpError(409, 'NEED_LINE_BET', `Bet Pass${variant.dontPass ? " or Don't Pass" : ''} to roll.`);
    await doRoll(ctx);
    return { rollSeq: state.rollSeq, total: state.lastRoll.total, dice: state.lastRoll.dice, kind: state.lastRoll.kind };
  }

  // ---------- the roll ----------

  async function doRoll(ctx) {
    const { state } = ctx;
    // Everyone the roll may pay, and everyone the sweep checks afterwards: one round trip.
    const uids = state.seats.filter(Boolean).map((seat) => seat.uid);
    await ctx.prefetch({ wallets: uids, presence: uids });
    const dice = [ctx.randomInt(6) + 1, ctx.randomInt(6) + 1];
    const total = dice[0] + dice[1];
    const pointBefore = state.point;
    const kind = rollKind(variant, pointBefore, total);
    state.rollSeq = (Number(state.rollSeq) || 0) + 1;
    const id = rollId(state);
    const headline = `${total} (${dice[0]}+${dice[1]})${KIND_TEXT[kind] ? `, ${KIND_TEXT[kind]}` : ''}`;

    for (const seat of state.seats) {
      if (!seat) continue;
      const result = settleRoll(variant, pointBefore, seat.bets, total, dice);
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
    const on = clocksOn(state);
    state.clocksOn = on;
    if (on && state.point !== null && state.shooter !== null) state.deadline = ctx.now + DICE_ANIMATION_MS + TURN_MS;
    else state.deadline = null; // a come-out (the clock waits for the first bet), or a player alone (no clock)
    ctx.changed = true;
  }

  // After each roll: free seats that left or went quiet once nothing they have must play out.
  async function sweepSeats(ctx) {
    const { state } = ctx;
    await ctx.prefetchPresence(state.seats.filter(Boolean).map((seat) => seat.uid)); // one round trip
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
    // The player count may have dropped since the clock started: a player alone gets no auto-roll and no pass.
    if (!clocksOn(state)) {
      state.deadline = null;
      state.clocksOn = false;
      return;
    }
    if (state.point !== null || hasLine(state.seats[state.shooter])) {
      await doRoll(ctx); // time's up: the server rolls for the shooter
      return;
    }
    // Come-out, and the shooter has no line bet: the dice move on (a new shooter: every bet OFF again).
    state.shooter = nextShooter(state, state.shooter);
    resetWorking(state);
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
    actions: { bet, bets, removeBet, roll, working },
  };
}

export const crapsEngine = makeDiceEngine('craps');
export const craplessEngine = makeDiceEngine('crapless');
