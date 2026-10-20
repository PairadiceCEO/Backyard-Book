// One slot spin = one transaction: check the wallet, debit the bet, pick three reel stops with
// crypto.randomInt, credit any win. The bet's ledger entry keeps the stops, so a retried request
// (same requestId) replays the original result instead of spinning or charging again.

import { adminDb } from '../firebaseAdmin.js';
import { HttpError } from '../http.js';
import { randomInt as defaultRandomInt } from './rng.js';
import { applyCasinoEntries, requireBetAmount } from './money.js';
import { checkProfile } from '../auth.js';
import { REQUEST_ID_PATTERN } from '../../shared/constants.js';
import { STOPS_PER_REEL, lineSymbols, lineWin } from '../../shared/casino/slotMachine.js';

function parseSpin(body) {
  const amount = body.amount;
  requireBetAmount(amount); // no maximum: whole dollars ≥ $1 under the sanity ceiling; the wallet is checked below
  if (typeof body.requestId !== 'string' || !REQUEST_ID_PATTERN.test(body.requestId)) {
    throw new HttpError(400, 'BAD_REQUEST_ID', 'Missing or invalid requestId.');
  }
  return { betCents: amount * 100, requestId: body.requestId };
}

function resultFrom(spin, balanceCents, duplicate) {
  return {
    ok: true,
    duplicate,
    stops: spin.stops,
    symbols: spin.symbols,
    line: spin.line,
    betCents: spin.betCents,
    winCents: spin.winCents,
    balanceCents,
  };
}

const noTiming = { time: (_n, fn) => fn(), add() {}, attempt() {} };

export async function spinSlots(caller, body, { now = new Date(), randomInt = defaultRandomInt, timing = noTiming } = {}) {
  const { betCents, requestId } = parseSpin(body);
  const db = adminDb();
  const userRef = db.collection('users').doc(caller.uid);
  const betRef = db.collection('ledger').doc(`cbet_${caller.uid}_${requestId}`);

  let fnDoneAt = 0;
  const result = await db.runTransaction(async (tx) => {
    timing.attempt();
    // The profile (wallet, disabled) and the retry check in one round trip.
    const [userSnap, betSnap] = await timing.time('read', () => tx.getAll(userRef, betRef), '2 docs');
    const balanceCents = Number(checkProfile(userSnap).balanceCents) || 0;

    // Same request again (double tap, retry): show the spin that already happened.
    if (betSnap.exists) {
      const previous = betSnap.data();
      if (previous.uid !== caller.uid || !previous.spin) throw new HttpError(409, 'DUPLICATE_REQUEST', 'That request id was already used.');
      return resultFrom(previous.spin, balanceCents, true);
    }

    if (balanceCents < betCents) {
      throw new HttpError(409, 'INSUFFICIENT_BALANCE', `Your wallet has $${(balanceCents / 100).toFixed(2)}; this spin needs $${betCents / 100}.`);
    }

    const stops = [randomInt(STOPS_PER_REEL), randomInt(STOPS_PER_REEL), randomInt(STOPS_PER_REEL)];
    const symbols = lineSymbols(stops);
    const win = lineWin(symbols);
    const winCents = win ? betCents * win.pays : 0;
    const spin = { stops, symbols, line: win ? { id: win.id, label: win.label, pays: win.pays } : null, betCents, winCents };

    const entries = [
      {
        id: betRef.id ?? `cbet_${caller.uid}_${requestId}`,
        type: 'casino_bet',
        amountCents: -betCents,
        game: 'slots',
        note: `7s Slots spin $${betCents / 100}`,
        extra: { requestId, spin },
      },
    ];
    if (winCents > 0) {
      entries.push({
        id: `cpay_slots_${caller.uid}_${requestId}`,
        type: 'casino_payout',
        amountCents: winCents,
        game: 'slots',
        note: `7s Slots: ${win.label} pays ${win.pays}×`,
        extra: { requestId },
      });
    }

    const after = applyCasinoEntries(tx, db, { uid: caller.uid, balanceCents, entries, now });
    fnDoneAt = performance.now();
    return resultFrom(spin, after, false);
  });
  if (fnDoneAt) timing.add('commit', performance.now() - fnDoneAt);
  return result;
}
