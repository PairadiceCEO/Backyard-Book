// One slot spin = one transaction: check the wallet, debit the bet, pick three reel stops with
// crypto.randomInt, credit any win. The bet's ledger entry keeps the stops, so a retried request
// (same requestId) replays the original result instead of spinning or charging again.

import { adminDb } from '../firebaseAdmin.js';
import { HttpError } from '../http.js';
import { randomInt as defaultRandomInt } from './rng.js';
import { applyCasinoEntries } from './money.js';
import { REQUEST_ID_PATTERN } from '../../shared/constants.js';
import { isValidCasinoBet } from '../../shared/casino/constants.js';
import { STOPS_PER_REEL, lineSymbols, lineWin } from '../../shared/casino/slotMachine.js';

function parseSpin(body) {
  const amount = body.amount;
  if (!isValidCasinoBet(amount)) throw new HttpError(400, 'BAD_BET', 'Bets are whole dollars from $1 to $10.');
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

export async function spinSlots(caller, body, { now = new Date(), randomInt = defaultRandomInt } = {}) {
  const { betCents, requestId } = parseSpin(body);
  const db = adminDb();
  const userRef = db.collection('users').doc(caller.uid);
  const betRef = db.collection('ledger').doc(`cbet_${caller.uid}_${requestId}`);

  return db.runTransaction(async (tx) => {
    const [userSnap, betSnap] = await Promise.all([tx.get(userRef), tx.get(betRef)]);
    if (!userSnap.exists) throw new HttpError(403, 'NO_PROFILE', 'No player profile exists for this login.');
    const balanceCents = Number(userSnap.data().balanceCents) || 0;

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
    return resultFrom(spin, after, false);
  });
}
