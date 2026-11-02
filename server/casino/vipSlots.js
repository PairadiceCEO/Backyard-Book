// The Pairadice VIP slot (0.28.0): one paid spin = one transaction. In order: the VIP pass (signature, uid, expiry, current password
// version; otherwise 403 VIP_LOCKED), the profile (missing or disabled → refused), the same request again (replays the spin that
// already happened, never charges twice), at most one paid spin every 2 s per player, the wallet. Then the debit, the reel stops
// from crypto.randomInt, the whole Golden Dice bonus if it triggers (every bonus spin's stops from crypto.randomInt too) and the
// credits, all in the same transaction. Ledger ids are deterministic:
//   cbet_vip_{uid}_{requestId}          the bet (−B), with the full spin record (stops, lines, bonus spins) for replays
//   cpay_vip_{uid}_{requestId}_base     the paid spin's line wins (if any)
//   cpay_vip_{uid}_{requestId}_bonus    the bonus total (if any), capped so line wins + bonus ≤ 10,000 × B
// The phone animates the result it gets back; it decides nothing.

import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../firebaseAdmin.js';
import { HttpError } from '../http.js';
import { checkProfile } from '../auth.js';
import { randomInt as defaultRandomInt } from './rng.js';
import { applyCasinoEntries, requireBetAmount } from './money.js';
import { REQUEST_ID_PATTERN } from '../../shared/constants.js';
import { playVipSpin, vipCapBonus } from '../../shared/casino/vipSlots.js';
import { VIP_SPIN_GAP_MS, verifyVipPass, vipMetaRef, vipRateRef } from '../vipLock.js';

export const VIP_TOO_FAST_MESSAGE = 'Let the reels stop first.';

function parseSpin(body) {
  requireBetAmount(body.amount); // whole dollars ≥ $1 under the casino's $1,000,000 ceiling; the wallet is checked below
  if (typeof body.requestId !== 'string' || !REQUEST_ID_PATTERN.test(body.requestId)) {
    throw new HttpError(400, 'BAD_REQUEST_ID', 'Missing or invalid requestId.');
  }
  return { betCents: body.amount * 100, requestId: body.requestId };
}

// What is stored (and returned): lines as { line, row, id, tenths } (the phone reads the labels from the paytable).
function slimLines(lines) {
  return lines.map((l) => ({ line: l.line, row: l.row, id: l.id, tenths: l.tenths }));
}

function recordOf(play, betCents) {
  // The cap again, here: line wins + bonus never more than 10,000 × B, whatever the machine returned.
  const bonusCents = play.bonus ? vipCapBonus(betCents, play.baseCents, play.bonus.cents) : 0;
  const capped = Boolean(play.bonus) && (play.bonus.capped || bonusCents < play.bonus.cents);
  return {
    stops: play.stops,
    lines: slimLines(play.lines),
    dice: play.dice,
    betCents,
    baseCents: play.baseCents,
    bonus: play.bonus
      ? {
          spins: play.bonus.spins.map((s) => ({ stops: s.stops, lines: slimLines(s.lines), dice: s.dice, cents: s.cents, added: s.added })),
          awarded: play.bonus.awarded,
          cents: bonusCents,
          capped,
        }
      : null,
    winCents: play.baseCents + bonusCents,
  };
}

function resultFrom(spin, balanceCents, duplicate) {
  return { ok: true, duplicate, spin, betCents: spin.betCents, winCents: spin.winCents, balanceCents };
}

const noTiming = { time: (_n, fn) => fn(), add() {}, attempt() {} };

export async function spinVip(caller, body, { now = new Date(), randomInt = defaultRandomInt, timing = noTiming } = {}) {
  const db = adminDb();
  const metaRef = vipMetaRef(db);
  const userRef = db.collection('users').doc(caller.uid);
  const rateRef = vipRateRef(db, caller.uid);
  const nowMs = now.getTime();
  const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
  const betRef = db.collection('ledger').doc(`cbet_vip_${caller.uid}_${REQUEST_ID_PATTERN.test(requestId) ? requestId : 'invalid'}`);

  let fnDoneAt = 0;
  const result = await db.runTransaction(async (tx) => {
    timing.attempt();
    const [metaSnap, userSnap, betSnap, rateSnap] = await timing.time('read', () => tx.getAll(metaRef, userRef, betRef, rateRef), '4 docs');
    // The pass first: nothing else happens without it.
    verifyVipPass(body?.pass, metaSnap.exists ? metaSnap.data() : null, caller.uid, nowMs);
    const balanceCents = Number(checkProfile(userSnap).balanceCents) || 0;
    const { betCents } = parseSpin(body);

    // Same request again (double tap, retry): the spin that already happened.
    if (betSnap.exists) {
      const previous = betSnap.data();
      if (previous.uid !== caller.uid || !previous.spin) throw new HttpError(409, 'DUPLICATE_REQUEST', 'That request id was already used.');
      return resultFrom(previous.spin, balanceCents, true);
    }

    const rate = rateSnap.exists ? rateSnap.data() : {};
    if (Number.isFinite(rate.lastSpinAt) && nowMs - rate.lastSpinAt < VIP_SPIN_GAP_MS && nowMs >= rate.lastSpinAt) {
      throw new HttpError(429, 'VIP_TOO_FAST', VIP_TOO_FAST_MESSAGE);
    }
    if (balanceCents < betCents) {
      throw new HttpError(409, 'INSUFFICIENT_BALANCE', `Your wallet has $${(balanceCents / 100).toFixed(2)}; this spin needs $${betCents / 100}.`);
    }

    const play = playVipSpin(randomInt, betCents);
    const spin = recordOf(play, betCents);
    if (!Number.isSafeInteger(spin.winCents)) throw new HttpError(400, 'BET_TOO_LARGE', 'That bet is larger than the table allows.');

    const entries = [
      {
        id: betRef.id,
        type: 'casino_bet',
        amountCents: -betCents,
        game: 'vip',
        note: `VIP slot spin $${betCents / 100}`,
        extra: { requestId, spin },
      },
    ];
    if (spin.baseCents > 0) {
      entries.push({
        id: `cpay_vip_${caller.uid}_${requestId}_base`,
        type: 'casino_payout',
        amountCents: spin.baseCents,
        game: 'vip',
        note: `VIP slot: ${spin.lines.length} winning line${spin.lines.length === 1 ? '' : 's'}`,
        extra: { requestId },
      });
    }
    if (spin.bonus && spin.bonus.cents > 0) {
      entries.push({
        id: `cpay_vip_${caller.uid}_${requestId}_bonus`,
        type: 'casino_payout',
        amountCents: spin.bonus.cents,
        game: 'vip',
        note: `VIP slot: Golden Dice bonus, ${spin.bonus.spins.length} free spins${spin.bonus.capped ? ' (capped at 10,000×)' : ''}`,
        extra: { requestId },
      });
    }

    const after = applyCasinoEntries(tx, db, { uid: caller.uid, balanceCents, entries, now });
    tx.set(rateRef, { ...rate, lastSpinAt: nowMs, updatedAt: Timestamp.fromDate(now) });
    fnDoneAt = performance.now();
    return resultFrom(spin, after, false);
  });
  if (fnDoneAt) timing.add('commit', performance.now() - fnDoneAt);
  return result;
}
