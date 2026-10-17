// Seats, watching, heartbeats and deadlines: the part every table game shares.
//
//   sit        take an empty seat (or a seat whose player has been gone 60 s with nothing in play).
//              Blackjack and Baccarat: as many seats as you like (each plays like its own player);
//              Craps: one seat per player.
//   leave      { seat } frees that seat now, or marks it "leaving" if its bets are still in play;
//              without a seat, every seat the caller holds
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
  const mine = ctx.mySeats;
  const wanted = body.seat === undefined || body.seat === null ? null : body.seat;
  if (wanted !== null && (!Number.isInteger(wanted) || wanted < 0 || wanted >= CASINO_SEATS)) {
    throw new HttpError(400, 'BAD_SEAT', `Seats are numbered 1–${CASINO_SEATS}.`);
  }
  if (wanted !== null && mine.includes(wanted)) return { seat: wanted, already: true };
  if (mine.length && !engine.multiSeat) {
    if (wanted === null) return { seat: mine[0], already: true };
    const name = casinoGame(ctx.game)?.name ?? 'This table';
    throw new HttpError(409, 'ONE_SEAT', `${name} is one seat per player. You're in seat ${mine[0] + 1}; leave it first to move.`);
  }
  if (mine.length && wanted === null) return { seat: mine[0], already: true };

  const seats = ctx.state.seats;
  if (seats.every(Boolean) || (wanted !== null && seats[wanted])) await ctx.prefetchPresence(seats.filter(Boolean).map((s) => s.uid));
  const canTake = async (i) => {
    const seat = seats[i];
    if (!seat) return true;
    if (seat.uid === ctx.caller.uid) return false;
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
  return { seat: index, mySeats: ctx.mySeats };
}

// leave { seat } gives up one seat; leave {} gives up every seat the caller holds (leaving the page).
// A seat with bets in play is marked "leaving": its bets play out and it frees when the round ends.
async function leave(ctx, body, engine) {
  const mine = ctx.mySeats;
  if (!mine.length) return { left: true, leaving: false, freedSeats: [], leavingSeats: [] };
  const list = body.seat === undefined || body.seat === null ? mine : [requireSeat(ctx, body)];
  const freedSeats = [];
  const leavingSeats = [];
  for (const index of list) {
    if (engine.seatInPlay(ctx.state, index)) {
      if (!ctx.state.seats[index].leaving) {
        ctx.state.seats[index].leaving = true;
        ctx.changed = true;
      }
      leavingSeats.push(index);
      continue;
    }
    await engine.beforeFree?.(ctx, index);
    ctx.state.seats[index] = null;
    ctx.changed = true;
    freedSeats.push(index);
  }
  if (ctx.changed) await engine.afterSeatsChanged?.(ctx);
  return { left: leavingSeats.length === 0, leaving: leavingSeats.length > 0, freedSeats, leavingSeats };
}

// One heartbeat covers every seat the caller holds (presence is per player).
async function heartbeat(ctx, _body, engine) {
  if (!ctx.mySeats.length) return { seated: false };
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
    if (handler !== sit && handler !== tick && handler !== heartbeat && handler !== leave && !ctx.mySeats.length) {
      throw new HttpError(403, 'NOT_SEATED', 'Take a seat to play. You can watch without one.');
    }
    return handler(ctx, body, engine);
  });
}
