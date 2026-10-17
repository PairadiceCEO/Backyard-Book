// Seats, watching, heartbeats and deadlines: the part every table game shares.
//
//   sit        take an empty seat (or a seat whose player has been gone 60 s with nothing in play)
//   leave      free the seat now, or mark it "leaving" if its bets are still in play
//   heartbeat  "still here": presence is written at most every 30 s; on an idle table it also frees
//              seats whose player has been gone 60 s
//   tick       anyone at the table may send it; applies the phase's default only if the server's clock
//              has passed the deadline, so five phones ticking at once apply it exactly once
//
// Game-specific actions (bet, confirm, …) come from the game's engine.

import { HttpError } from '../http.js';
import { randomInt as defaultRandomInt } from './rng.js';
import { requireSeat, runTableAction } from './tableRunner.js';
import { baccaratEngine } from './baccaratTable.js';
import { blackjackEngine } from './blackjackTable.js';
import { craplessEngine, crapsEngine } from './crapsTable.js';
import { freeGoneSeats, seatIsStale } from './seats.js';
import { CASINO_SEATS, casinoGame } from '../../shared/casino/constants.js';
import { REQUEST_ID_PATTERN } from '../../shared/constants.js';

const ENGINES = {
  baccarat: baccaratEngine,
  blackjack: blackjackEngine,
  craps: crapsEngine,
  crapless: craplessEngine,
};

export function tableEngine(gameId) {
  if (Object.prototype.hasOwnProperty.call(ENGINES, gameId)) return ENGINES[gameId];
  const game = casinoGame(gameId);
  if (game?.kind === 'table') {
    throw new HttpError(400, 'TABLE_NOT_OPEN', `${game.name} isn't open yet.${game.opensIn ? ` It opens in casino phase ${game.opensIn}.` : ''}`);
  }
  throw new HttpError(400, 'BAD_GAME', 'Pick a table: "blackjack", "baccarat", "craps" or "crapless".');
}

function displayName(caller) {
  const user = caller.user ?? {};
  return String(user.displayName || user.username || 'Player').slice(0, 24);
}

async function sit(ctx, body, engine) {
  const current = ctx.seatIndex;
  const wanted = body.seat === undefined || body.seat === null ? null : body.seat;
  if (wanted !== null && (!Number.isInteger(wanted) || wanted < 0 || wanted >= CASINO_SEATS)) {
    throw new HttpError(400, 'BAD_SEAT', `Seats are numbered 1–${CASINO_SEATS}.`);
  }
  if (current !== -1) {
    if (wanted === null || wanted === current) return { seat: current, already: true };
    throw new HttpError(409, 'ALREADY_SEATED', `You're already in seat ${current + 1}. Leave it first.`);
  }

  const seats = ctx.state.seats;
  if (seats.every(Boolean) || (wanted !== null && seats[wanted])) await ctx.prefetchPresence(seats.filter(Boolean).map((s) => s.uid));
  const canTake = async (i) => {
    const seat = seats[i];
    if (!seat) return true;
    // A seat whose player left long ago, with nothing riding, can be taken over.
    return !engine.seatInPlay(ctx.state, i) && (seat.leaving || (await seatIsStale(ctx, seat)));
  };

  let index = -1;
  if (wanted !== null) {
    if (!(await canTake(wanted))) throw new HttpError(409, 'SEAT_TAKEN', `Seat ${wanted + 1} is taken. Pick an empty one.`);
    index = wanted;
  } else {
    index = seats.findIndex((s) => !s);
    for (let i = 0; index === -1 && i < CASINO_SEATS; i += 1) if (await canTake(i)) index = i;
    if (index === -1) throw new HttpError(409, 'TABLE_FULL', 'All 5 seats are taken. You can still watch.');
  }

  if (seats[index]) await engine.beforeFree?.(ctx, index); // taking over a gone player's seat
  seats[index] = engine.newSeat({ uid: ctx.caller.uid, name: displayName(ctx.caller), sitAt: ctx.now }, ctx.state);
  ctx.changed = true;
  await ctx.markPresent(ctx.caller.uid, { force: true });
  await engine.afterSeatsChanged?.(ctx);
  return { seat: index };
}

async function leave(ctx, _body, engine) {
  const index = ctx.seatIndex;
  if (index === -1) return { left: true };
  if (engine.seatInPlay(ctx.state, index)) {
    // Its bets play out; the seat frees when the round ends.
    if (!ctx.state.seats[index].leaving) {
      ctx.state.seats[index].leaving = true;
      ctx.changed = true;
      await engine.afterSeatsChanged?.(ctx);
    }
    return { left: false, leaving: true };
  }
  await engine.beforeFree?.(ctx, index);
  ctx.state.seats[index] = null;
  ctx.changed = true;
  await engine.afterSeatsChanged?.(ctx);
  return { left: true };
}

async function heartbeat(ctx, _body, engine) {
  const index = ctx.seatIndex;
  if (index === -1) return { seated: false };
  const wrote = await ctx.markPresent(ctx.caller.uid);
  // An idle table has no round ending to free a seat, so a heartbeat that writes does it instead.
  if (wrote && engine.isIdle(ctx.state)) {
    const freed = await freeGoneSeats(ctx, engine);
    if (freed.length) await engine.afterSeatsChanged?.(ctx);
  }
  return { seated: true, wrote };
}

async function tick(ctx, _body, engine) {
  const deadline = Number(ctx.state.deadline) || 0;
  if (!ctx.exists || !deadline || ctx.now < deadline) return { applied: false, deadline: deadline || null };
  await engine.onDeadline(ctx);
  ctx.changed = true;
  return { applied: true };
}

const SHARED_ACTIONS = { sit, leave, heartbeat, tick };

export async function handleTableAction(caller, body, { now = Date.now(), randomInt = defaultRandomInt, timing } = {}) {
  const gameId = String(body.game ?? '');
  const engine = tableEngine(gameId);
  const action = String(body.action ?? '');

  let handler = null;
  if (Object.prototype.hasOwnProperty.call(SHARED_ACTIONS, action)) handler = SHARED_ACTIONS[action];
  else if (Object.prototype.hasOwnProperty.call(engine.actions, action)) handler = engine.actions[action];
  if (!handler) throw new HttpError(400, 'UNKNOWN_ACTION', `${casinoGame(gameId)?.name ?? gameId} has no "${action}".`);

  // Read up front what this action will need: the shoe when it may deal, the bet's ledger entry
  // when it carries a request id (the retry check).
  const preload = {
    shoe: Boolean(engine.preloadShoe?.(action)),
    ledgerIds: typeof body.requestId === 'string' && REQUEST_ID_PATTERN.test(body.requestId) ? [`cbet_${caller.uid}_${body.requestId}`] : [],
  };

  return runTableAction({ game: gameId, engine, caller, now, randomInt, timing, preload }, async (ctx) => {
    if (handler !== sit && handler !== tick && handler !== heartbeat && handler !== leave) requireSeat(ctx);
    return handler(ctx, body, engine);
  });
}
