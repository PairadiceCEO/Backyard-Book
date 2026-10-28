// Blackjack at the shared table.
//
//   Betting    no timer until the first bet, then 15 s; chips build each seat's bet (whole dollars ≥ $1, no maximum) and
//              Confirm locks it; deals at once when every seated player has confirmed.
//   Deal       two cards each, seat 1 → 5, the dealer's second card face down. The hole card goes to
//              private/shoe.holeCard; the public doc only says holeDown: true.
//   Insurance  only when the dealer shows an Ace: 15 s; each seat with a bet insures 0 to half its bet
//              (pays 2:1). Undecided at 0 = declined.
//   Peek       dealer shows an Ace or a 10: blackjack → hole card turned over, every hand settled at once
//              (naturals push). Otherwise naturals are paid 3:2 now and play goes on.
//   Turns      one hand at a time, 15 s per hand (timeout = stand). Hit / Stand / Double / Split carry
//              the hand's index and its actionSeq; a tap for a hand that has already moved on is refused
//              (STALE) and changes nothing. One split per seat; split Aces get one card each; double
//              after split is allowed. A bust is collected at once.
//   Dealer     turns the hole card over; draws only if a live hand remains; hits soft 17.
//   Results    5 s after the last card turns over on the phones, then the next hand opens.
//
// 21+3 (0.24.0): an optional side bet per seat (seat.sideCents), set by the same `bet` action (`side`, whole dollars; it
//              needs a main bet), charged with it, and settled as soon as the opening cards are out (the seat's first two cards +
//              the dealer's up card, before insurance or play): seat.side = { cards, hand, stakeCents, returnCents }, paid as
//              cpay_blackjack_{round}_{uid}_s{n}_213 (shared/casino/sideBets.js has the paytable and its source).
//
// Shoe: 6 decks, reshuffled before a hand once 281 cards are dealt. If it runs dry mid-hand, a fresh
// shoe is built from every card not on the table.

import { HttpError } from '../http.js';
import { requirePhase, requireSeat } from './tableRunner.js';
import { drawCard, reshuffleIfDue } from './shoe.js';
import { freeGoneSeats } from './seats.js';
import { formatDollars, requireBetAmount } from './money.js';
import { REQUEST_ID_PATTERN } from '../../shared/constants.js';
import { buildShoe, cardRank } from '../../shared/casino/cards.js';
import { CASINO_SEATS, RESULTS_MS, TURN_SECONDS } from '../../shared/casino/constants.js';
import { SIDE_BET_KEEPS_MAIN, SIDE_BET_NEEDS_MAIN, twentyOne3Hand, twentyOne3Label, twentyOne3ReturnCents } from '../../shared/casino/sideBets.js';
import {
  BLACKJACK_INITIAL_GAP_MS,
  BLACKJACK_LATER_GAP_MS,
  CARD_SETTLE_MS,
  BLACKJACK_DECKS,
  BLACKJACK_RESHUFFLE_AT,
  canDouble,
  canSplit,
  dealerHits,
  dealerPeeks,
  handValue,
  insuranceReturnCents,
  isBlackjack,
  isBust,
  maxInsuranceCents,
  naturalReturnCents,
  offersInsurance,
  settlePlayedHand,
} from '../../shared/casino/blackjack.js';

const RECENT_REQUESTS = 8;
const TURN_MS = TURN_SECONDS * 1000;

function roundIdFor(epoch, roundNo) {
  return `${epoch}-${roundNo}`;
}

function emptyDealer() {
  return { cards: [], holeDown: false };
}

function createTable(now) {
  const epoch = now.toString(36);
  return {
    game: 'blackjack',
    epoch,
    roundNo: 1,
    roundId: roundIdFor(epoch, 1),
    phase: 'betting',
    deadline: null,
    seats: Array.from({ length: CASINO_SEATS }, () => null),
    dealer: emptyDealer(),
    turn: null,
    lastDeal: null,
    shoe: { remaining: BLACKJACK_DECKS * 52, total: BLACKJACK_DECKS * 52, shuffles: 0 },
    version: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function freshSeatRound(seat) {
  seat.ready = false;
  seat.betCents = 0;
  seat.sideCents = 0; // 21+3 (0.24.0)
  seat.side = null; // its result once the opening cards are out
  seat.stakeCents = 0;
  seat.returnCents = 0;
  seat.insurance = null;
  seat.hands = [];
  seat.result = null;
}

function newSeat({ uid, name, sitAt }) {
  const seat = { uid, name, sitAt, leaving: false, reqs: [] };
  freshSeatRound(seat);
  return seat;
}

function seatInPlay(state, index) {
  const seat = state.seats[index];
  return Boolean(seat) && seat.betCents > 0 && state.phase !== 'results';
}

function anyBets(state) {
  return state.seats.some((seat) => seat && seat.betCents > 0);
}

function isIdle(state) {
  return state.phase === 'betting' && !anyBets(state);
}

// Every seated player has locked in a bet (a seat that's leaving counts as done).
function everyoneReady(state) {
  const seated = state.seats.filter(Boolean);
  return seated.length > 0 && anyBets(state) && seated.every((seat) => (seat.betCents > 0 && seat.ready) || seat.leaving);
}

function playerSeats(state) {
  return state.seats.map((seat, i) => (seat && seat.betCents > 0 ? i : -1)).filter((i) => i >= 0);
}

// ---------- cards ----------

// Every card a player can see, plus the face-down hole card: what a mid-hand refill must leave out.
function cardsOnTable(state, shoe) {
  const cards = [...(state.dealer?.cards ?? [])];
  if (shoe.holeCard) cards.push(shoe.holeCard);
  for (const seat of state.seats) for (const hand of seat?.hands ?? []) cards.push(...hand.cards);
  return cards;
}

async function draw(ctx) {
  const shoe = await ctx.shoe();
  if (shoe.cards.length === 0) {
    // Ran dry mid-hand: a fresh shoe from every card not on the table.
    const onTable = new Set(cardsOnTable(ctx.state, shoe));
    shoe.cards = buildShoe(BLACKJACK_DECKS).filter((card) => !onTable.has(card));
    shoe.dealt = onTable.size;
    shoe.shuffles = (shoe.shuffles ?? 0) + 1;
    ctx.state.refilledMidHand = ctx.state.roundId;
  }
  return drawCard(shoe, ctx.randomInt);
}

// Cards dealt in one write turn over one by one on the phones: each card carries t, its offset in ms
// from lastDeal.at (the server's time of the write). Opening cards are BLACKJACK_INITIAL_GAP_MS apart,
// every later card BLACKJACK_LATER_GAP_MS (shared/casino/timing.js).
function logDeal(ctx, to, index) {
  if (!ctx.dealLog) {
    ctx.dealLog = { at: ctx.now, cards: [] };
    ctx.state.lastDeal = ctx.dealLog;
  }
  const list = ctx.dealLog.cards;
  const initial = Boolean(ctx.openingDeal);
  let t = 0;
  if (list.length) {
    const prev = list[list.length - 1];
    t = prev.t + (initial && prev.opening ? BLACKJACK_INITIAL_GAP_MS : BLACKJACK_LATER_GAP_MS);
  }
  list.push(initial ? { to, i: index, t, opening: true } : { to, i: index, t });
}

// How long this write's cards take to show: decision clocks start after it, so nobody loses time.
function revealPadMs(ctx) {
  const list = ctx.dealLog?.cards ?? [];
  return list.length ? list[list.length - 1].t + CARD_SETTLE_MS : 0;
}

async function dealToHand(ctx, seatIndex, handIndex) {
  const hand = ctx.state.seats[seatIndex].hands[handIndex];
  hand.cards.push(await draw(ctx));
  logDeal(ctx, `${seatIndex}-${handIndex}`, hand.cards.length - 1);
}

async function revealHole(ctx) {
  const { dealer } = ctx.state;
  if (!dealer.holeDown) return;
  const shoe = await ctx.shoe();
  dealer.cards.push(shoe.holeCard);
  dealer.holeDown = false;
  shoe.holeCard = null;
  logDeal(ctx, 'd', dealer.cards.length - 1);
}

// ---------- money ----------
// Ledger ids name the seat (s0–s4) as well as the player: one player may hold several seats.

function seatNo(ctx, seat) {
  return ctx.state.seats.indexOf(seat);
}

function charge(ctx, seat, id, cents, note) {
  ctx.addMoney(seat.uid, { id, type: 'casino_bet', amountCents: -cents, roundId: ctx.state.roundId, note: `Blackjack hand ${ctx.state.roundNo}, seat ${seatNo(ctx, seat) + 1}: ${note}` });
  seat.stakeCents += cents;
}

function pay(ctx, seat, step, cents, note) {
  if (cents <= 0) return;
  ctx.addMoney(seat.uid, {
    id: `cpay_blackjack_${ctx.state.roundId}_${seat.uid}_s${seatNo(ctx, seat)}_${step}`,
    type: 'casino_payout',
    amountCents: cents,
    roundId: ctx.state.roundId,
    note: `Blackjack hand ${ctx.state.roundNo}, seat ${seatNo(ctx, seat) + 1}: ${note}`,
  });
  seat.returnCents += cents;
}

async function requireFunds(ctx, seat, cents, what) {
  const balance = await ctx.balance(seat.uid);
  if (balance < cents) {
    throw new HttpError(409, 'INSUFFICIENT_BALANCE', `Your wallet has ${formatDollars(balance)}; ${what} needs ${formatDollars(cents)}.`);
  }
}

// ---------- the round ----------

async function deal(ctx) {
  const { state } = ctx;
  const shoe = await ctx.shoe();
  const reshuffled = reshuffleIfDue(shoe, { decks: BLACKJACK_DECKS, reshuffleAt: BLACKJACK_RESHUFFLE_AT, minCards: 0 });
  shoe.holeCard = null;
  const players = playerSeats(state);
  for (const i of players) {
    const seat = state.seats[i];
    seat.hands = [{ cards: [], betCents: seat.betCents, status: 'playing', seq: 0, fromSplit: false, splitAces: false, doubled: false, outcome: null }];
  }
  state.dealer = emptyDealer();
  state.reshuffled = reshuffled;
  state.turn = null;

  // Seat 1 → 5, dealer; then the second card in the same order (the dealer's face down).
  ctx.openingDeal = true;
  for (const i of players) await dealToHand(ctx, i, 0);
  state.dealer.cards.push(await draw(ctx));
  logDeal(ctx, 'd', 0);
  for (const i of players) await dealToHand(ctx, i, 0);
  shoe.holeCard = await draw(ctx); // face down: never in the public doc until it's turned over
  state.dealer.holeDown = true;
  logDeal(ctx, 'd', 1);
  ctx.openingDeal = false;

  for (const i of players) {
    const hand = state.seats[i].hands[0];
    if (isBlackjack(hand.cards)) hand.status = 'blackjack';
  }

  // 21+3: settled now, on the seat's first two cards and the dealer's up card.
  for (const i of players) {
    const seat = state.seats[i];
    if (!(seat.sideCents > 0)) continue;
    const cards = [seat.hands[0].cards[0], seat.hands[0].cards[1], state.dealer.cards[0]];
    const hand = twentyOne3Hand(cards);
    const returnCents = twentyOne3ReturnCents(seat.sideCents, cards);
    seat.side = { cards, hand, stakeCents: seat.sideCents, returnCents };
    pay(ctx, seat, '213', returnCents, `21+3 ${twentyOne3Label(hand)}`);
  }

  if (offersInsurance(state.dealer.cards[0])) {
    state.phase = 'insurance';
    for (const i of players) state.seats[i].insurance = null;
    state.deadline = ctx.now + revealPadMs(ctx) + TURN_MS;
    return;
  }
  await afterInsurance(ctx);
}

async function afterInsurance(ctx) {
  const { state } = ctx;
  const shoe = await ctx.shoe();
  const up = state.dealer.cards[0];
  const players = playerSeats(state);
  for (const i of players) if (state.seats[i].insurance === null) state.seats[i].insurance = 0;

  if (dealerPeeks(up) && isBlackjack([up, shoe.holeCard])) {
    await revealHole(ctx);
    for (const i of players) {
      const seat = state.seats[i];
      if (seat.insurance > 0) pay(ctx, seat, 'ins', insuranceReturnCents(seat.insurance), 'insurance pays 2:1');
      let back = 0;
      for (const hand of seat.hands) {
        if (hand.status === 'blackjack') {
          hand.outcome = 'push';
          back += hand.betCents;
        } else {
          hand.outcome = 'lose';
        }
        hand.status = 'done';
      }
      pay(ctx, seat, 'end', back, 'dealer blackjack, your blackjack pushes');
    }
    finishRound(ctx, 'dealerBlackjack');
    return;
  }

  // No dealer blackjack: insurance is lost; naturals are paid 3:2 right now.
  for (const i of players) {
    const seat = state.seats[i];
    const hand = seat.hands[0];
    if (hand.status === 'blackjack') {
      hand.outcome = 'blackjack';
      pay(ctx, seat, 'natural', naturalReturnCents(hand.betCents), 'blackjack pays 3:2');
    }
  }
  state.phase = 'playing';
  state.turn = null;
  await advance(ctx);
}

function nextPlayableHand(state, from) {
  for (let s = from ? from.seat : 0; s < CASINO_SEATS; s += 1) {
    const seat = state.seats[s];
    if (!seat) continue;
    const startHand = from && s === from.seat ? from.hand + 1 : 0;
    for (let h = startHand; h < seat.hands.length; h += 1) {
      if (seat.hands[h].status === 'playing') return { seat: s, hand: h };
    }
  }
  return null;
}

// Moves the turn to the next hand that still has a decision to make, or plays the dealer.
async function advance(ctx) {
  const { state } = ctx;
  let next = nextPlayableHand(state, state.turn);
  while (next) {
    const hand = state.seats[next.seat].hands[next.hand];
    if (handValue(hand.cards).total === 21) {
      hand.status = 'stood'; // 21 stands by itself
      next = nextPlayableHand(state, next);
      continue;
    }
    state.turn = { seat: next.seat, hand: next.hand };
    state.deadline = ctx.now + revealPadMs(ctx) + TURN_MS;
    return;
  }
  state.turn = null;
  await dealerTurn(ctx);
}

async function dealerTurn(ctx) {
  const { state } = ctx;
  const uids = state.seats.filter(Boolean).map((seat) => seat.uid);
  await ctx.prefetch({ wallets: uids, presence: uids }); // payouts in one round trip
  await revealHole(ctx);
  const live = [];
  for (const i of playerSeats(state)) {
    for (const hand of state.seats[i].hands) if (hand.status === 'stood') live.push([i, hand]);
  }
  if (live.length) {
    while (dealerHits(state.dealer.cards)) {
      state.dealer.cards.push(await draw(ctx));
      logDeal(ctx, 'd', state.dealer.cards.length - 1);
    }
  }
  const dealerTotal = handValue(state.dealer.cards).total;
  const backBySeat = new Map();
  for (const [i, hand] of live) {
    const { outcome, returnCents } = settlePlayedHand(hand, state.dealer.cards);
    hand.outcome = outcome;
    hand.status = 'done';
    backBySeat.set(i, (backBySeat.get(i) ?? 0) + returnCents);
  }
  for (const [i, cents] of backBySeat) {
    pay(ctx, state.seats[i], 'end', cents, dealerTotal > 21 ? `dealer busts with ${dealerTotal}` : `dealer has ${dealerTotal}`);
  }
  finishRound(ctx, 'played');
}

function finishRound(ctx, how) {
  const { state } = ctx;
  for (const i of playerSeats(state)) {
    const seat = state.seats[i];
    for (const hand of seat.hands) if (hand.status !== 'done') hand.status = 'done';
    seat.result = { stakeCents: seat.stakeCents, returnCents: seat.returnCents, netCents: seat.returnCents - seat.stakeCents };
  }
  state.phase = 'results';
  state.turn = null;
  state.finish = how;
  state.deadline = ctx.now + revealPadMs(ctx) + RESULTS_MS;
}

async function openNextRound(ctx) {
  const { state } = ctx;
  state.phase = 'betting';
  state.deadline = null;
  state.dealer = emptyDealer();
  state.turn = null;
  state.lastDeal = null;
  state.finish = null;
  state.reshuffled = false;
  for (const seat of state.seats) if (seat) freshSeatRound(seat);
  await freeGoneSeats(ctx, blackjackEngine);
  state.roundNo = (Number(state.roundNo) || 0) + 1;
  state.roundId = roundIdFor(state.epoch, state.roundNo);
  ctx.changed = true;
}

// ---------- actions ----------

// Chips build the bet: `bet` sets this hand's total ($0 clears it; no maximum, the wallet must cover it); a change charges or
// refunds the difference. `confirm` locks it in. The cards come out when every seated player has
// confirmed, or 15 s after the first bet for whoever has a bet down.
async function bet(ctx, body) {
  const index = requireSeat(ctx, body);
  const seat = ctx.state.seats[index];
  const amount = body.amount;
  if (amount !== 0) requireBetAmount(amount);
  // 21+3 (0.24.0): `side` sets it ($0 clears it); left out, it stays as it is.
  const side = body.side === undefined || body.side === null ? (seat.sideCents || 0) / 100 : body.side;
  if (side !== 0) requireBetAmount(side);
  if (typeof body.requestId !== 'string' || !REQUEST_ID_PATTERN.test(body.requestId)) {
    throw new HttpError(400, 'BAD_REQUEST_ID', 'Missing or invalid requestId.');
  }
  if (seat.reqs?.includes(body.requestId)) return { duplicate: true };
  requirePhase(ctx, 'betting', 'Betting is closed for this hand. Bet again when the next one opens.');
  if (seat.leaving) throw new HttpError(409, 'LEAVING', "You're leaving this table.");
  if (seat.ready) throw new HttpError(409, 'CONFIRMED', 'Your bet is locked in for this hand.');
  const cents = amount * 100;
  const sideCents = side * 100;
  if (sideCents > 0 && cents === 0) throw new HttpError(409, 'SIDE_NEEDS_MAIN', seat.betCents > 0 ? SIDE_BET_KEEPS_MAIN : SIDE_BET_NEEDS_MAIN);
  const diff = cents + sideCents - seat.betCents - (seat.sideCents || 0);
  const what = sideCents ? `bet now ${formatDollars(cents)} + 21+3 ${formatDollars(sideCents)}` : `bet now ${formatDollars(cents)}`;
  const id = `cbet_${ctx.caller.uid}_${body.requestId}`;
  if (diff > 0) {
    if (await ctx.ledgerExists(id)) return { duplicate: true };
    await requireFunds(ctx, seat, diff, 'that bet');
    charge(ctx, seat, id, diff, what);
  } else if (diff < 0) {
    ctx.addMoney(seat.uid, {
      id: `cref_blackjack_${ctx.state.roundId}_${seat.uid}_${body.requestId}`,
      type: 'casino_refund',
      amountCents: -diff,
      roundId: ctx.state.roundId,
      note: `Blackjack hand ${ctx.state.roundNo}, seat ${index + 1}: lowered to ${what.replace('bet now ', '')}`,
    });
    seat.stakeCents += diff;
  }
  seat.betCents = cents;
  seat.sideCents = sideCents;
  seat.reqs = [...(seat.reqs ?? []), body.requestId].slice(-RECENT_REQUESTS);
  if (anyBets(ctx.state) && !ctx.state.deadline) ctx.state.deadline = ctx.now + TURN_MS;
  ctx.changed = true;
  return { betCents: cents, sideCents };
}

async function confirm(ctx, body) {
  const index = requireSeat(ctx, body);
  const seat = ctx.state.seats[index];
  requirePhase(ctx, 'betting', 'Betting is closed for this hand.');
  if (seat.ready) return { ready: true };
  if (!(seat.betCents > 0)) throw new HttpError(409, 'NO_BET', 'Put a chip down before you confirm.');
  seat.ready = true;
  ctx.changed = true;
  if (everyoneReady(ctx.state)) await deal(ctx);
  return { ready: true, dealt: ctx.state.phase !== 'betting' };
}

async function insurance(ctx, body) {
  const index = requireSeat(ctx, body);
  const seat = ctx.state.seats[index];
  requirePhase(ctx, 'insurance', 'Insurance is only offered while the dealer shows an Ace.');
  if (!(seat.betCents > 0)) throw new HttpError(403, 'NO_HAND', "You don't have a hand this round.");
  const max = maxInsuranceCents(seat.betCents);
  const cents = body.amountCents;
  if (!Number.isInteger(cents) || cents < 0 || cents > max) {
    throw new HttpError(400, 'BAD_INSURANCE', `Insurance is $0 to ${formatDollars(max)} (half your bet).`);
  }
  if (seat.insurance !== null) return { insurance: seat.insurance, duplicate: true };
  if (cents > 0) {
    await requireFunds(ctx, seat, cents, 'insurance');
    charge(ctx, seat, `cbet_${seat.uid}_s${index}_ins_${ctx.state.roundId}`, cents, `insurance ${formatDollars(cents)}`);
  }
  seat.insurance = cents;
  ctx.changed = true;
  const undecided = playerSeats(ctx.state).some((i) => ctx.state.seats[i].insurance === null);
  if (!undecided) await afterInsurance(ctx);
  return { insurance: cents };
}

// Finds the caller's hand for a move and applies the double-tap guard: refused only if that hand has
// already moved on (its actionSeq changed or it's finished). Other players' actions never matter.
// The seat is body.seat, or (when not given) the seat whose turn it is if it's the caller's.
function handForMove(ctx, body) {
  requirePhase(ctx, 'playing', 'No hands are being played right now.');
  const turnSeat = ctx.state.turn?.seat;
  const index =
    (body.seat === undefined || body.seat === null) && Number.isInteger(turnSeat) && ctx.mySeats.includes(turnSeat)
      ? turnSeat
      : requireSeat(ctx, body);
  const handIndex = body.hand;
  const actionSeq = body.actionSeq;
  if (!Number.isInteger(handIndex) || !Number.isInteger(actionSeq)) {
    throw new HttpError(400, 'BAD_MOVE', 'A move needs the hand number and its actionSeq.');
  }
  const seat = ctx.state.seats[index];
  const hand = seat.hands[handIndex];
  if (!hand) throw new HttpError(400, 'BAD_HAND', "You don't have that hand.");
  if (hand.status !== 'playing' || hand.seq !== actionSeq) {
    throw new HttpError(409, 'STALE', 'That hand already moved on.');
  }
  const turn = ctx.state.turn;
  if (!turn || turn.seat !== index || turn.hand !== handIndex) throw new HttpError(403, 'NOT_YOUR_TURN', `It isn't seat ${index + 1}'s turn.`);
  return { seat, hand, index, handIndex };
}

async function hit(ctx, body) {
  const { hand, index, handIndex } = handForMove(ctx, body);
  await dealToHand(ctx, index, handIndex);
  hand.seq += 1;
  ctx.changed = true;
  if (isBust(hand.cards)) {
    hand.status = 'bust'; // collected at once: the bet was already taken
    hand.outcome = 'bust';
    await advance(ctx);
  } else if (handValue(hand.cards).total === 21) {
    hand.status = 'stood';
    await advance(ctx);
  }
  return { total: handValue(hand.cards).total };
}

async function stand(ctx, body) {
  const { hand } = handForMove(ctx, body);
  hand.status = 'stood';
  hand.seq += 1;
  ctx.changed = true;
  await advance(ctx);
  return { stood: true };
}

async function double(ctx, body) {
  const { seat, hand, index, handIndex } = handForMove(ctx, body);
  if (!canDouble(hand)) throw new HttpError(409, 'CANT_DOUBLE', 'Double on your first two cards only.');
  await requireFunds(ctx, seat, hand.betCents, 'doubling');
  charge(ctx, seat, `cbet_${seat.uid}_s${index}_dbl${handIndex}_${ctx.state.roundId}`, hand.betCents, `double ${formatDollars(hand.betCents)}`);
  hand.betCents *= 2;
  hand.doubled = true;
  await dealToHand(ctx, index, handIndex);
  hand.seq += 1;
  if (isBust(hand.cards)) {
    hand.status = 'bust';
    hand.outcome = 'bust';
  } else {
    hand.status = 'stood';
  }
  ctx.changed = true;
  await advance(ctx);
  return { total: handValue(hand.cards).total };
}

async function split(ctx, body) {
  const { seat, hand, index } = handForMove(ctx, body);
  if (!canSplit(hand, seat.hands.length)) throw new HttpError(409, 'CANT_SPLIT', 'Split two cards of the same value, once per hand.');
  await requireFunds(ctx, seat, hand.betCents, 'splitting');
  charge(ctx, seat, `cbet_${seat.uid}_s${index}_split_${ctx.state.roundId}`, hand.betCents, `split ${formatDollars(hand.betCents)}`);
  const aces = cardRank(hand.cards[0]) === 'A' && cardRank(hand.cards[1]) === 'A';
  const make = (card, seq) => ({ cards: [card], betCents: hand.betCents, status: 'playing', seq, fromSplit: true, splitAces: aces, doubled: false, outcome: null });
  seat.hands = [make(hand.cards[0], hand.seq + 1), make(hand.cards[1], 0)];
  await dealToHand(ctx, index, 0);
  await dealToHand(ctx, index, 1);
  ctx.changed = true;
  if (aces) {
    // Split Aces: one card each, then they stand.
    for (const h of seat.hands) h.status = 'stood';
    await advance(ctx);
  } else if (handValue(seat.hands[0].cards).total === 21) {
    seat.hands[0].status = 'stood';
    await advance(ctx);
  } else {
    ctx.state.turn = { seat: index, hand: 0 };
    ctx.state.deadline = ctx.now + revealPadMs(ctx) + TURN_MS;
  }
  return { split: true };
}

// ---------- deadlines and seats ----------

async function onDeadline(ctx) {
  const { state } = ctx;
  if (state.phase === 'betting') {
    if (anyBets(state)) await deal(ctx);
    else state.deadline = null;
  } else if (state.phase === 'insurance') {
    await afterInsurance(ctx); // undecided = no insurance
  } else if (state.phase === 'playing') {
    const turn = state.turn;
    const hand = turn ? state.seats[turn.seat]?.hands[turn.hand] : null;
    if (hand && hand.status === 'playing') {
      hand.status = 'stood'; // time's up: stand
      hand.seq += 1;
    }
    await advance(ctx);
  } else {
    await openNextRound(ctx);
  }
}

async function afterSeatsChanged(ctx) {
  if (ctx.state.phase === 'betting' && everyoneReady(ctx.state)) await deal(ctx);
}

export const blackjackEngine = {
  id: 'blackjack',
  multiSeat: true, // a player may hold several seats; each plays like its own player
  // Actions that can deal, draw or turn the hole card (the shoe is read with the table).
  preloadShoe: (action) => ['confirm', 'insurance', 'hit', 'stand', 'double', 'split', 'leave'].includes(action),
  decks: BLACKJACK_DECKS,
  createTable,
  newSeat,
  seatInPlay,
  isIdle,
  onDeadline,
  afterSeatsChanged,
  actions: { bet, confirm, insurance, hit, stand, double, split },
};
