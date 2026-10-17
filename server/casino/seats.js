// Seat helpers shared by the table actions and the game engines.

import { CASINO_SEATS, SEAT_TIMEOUT_SECONDS } from '../../shared/casino/constants.js';

// Gone = no presence for 60 s (or, if presence was never written, sat down over 60 s ago).
export async function seatIsStale(ctx, seat) {
  const presenceAt = await ctx.presenceAt(seat.uid);
  const at = presenceAt ?? (Number(seat.sitAt) || 0);
  return ctx.now - at > SEAT_TIMEOUT_SECONDS * 1000;
}

// Frees seats marked "leaving" and seats whose player has gone quiet (calling the game's beforeFree
// hook first). Only called when nothing is in play for them (the start of a round, or an idle table), so no bet is ever stranded.
export async function freeGoneSeats(ctx, engine) {
  const freed = [];
  for (let i = 0; i < CASINO_SEATS; i += 1) {
    const seat = ctx.state.seats[i];
    if (!seat || engine.seatInPlay(ctx.state, i)) continue;
    if (seat.leaving || (await seatIsStale(ctx, seat))) {
      await engine.beforeFree?.(ctx, i); // e.g. Craps refunds Place and Field bets
      ctx.state.seats[i] = null;
      freed.push(i);
    }
  }
  if (freed.length) ctx.changed = true;
  return freed;
}
