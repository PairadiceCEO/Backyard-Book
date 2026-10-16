// Places singles or a parlay: validate → re-price every leg at its source → one Firestore
// transaction that checks the balance, creates the bet(s), subtracts the stake and writes the ledger.

import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from './firebaseAdmin.js';
import { HttpError } from './http.js';
import { getLeague } from './leagues.js';
import { createPricingContext, priceLeg } from './pricing.js';
import {
  MAX_LEGS,
  combinedAmerican,
  combinedDecimal,
  isValidRequestId,
  isValidSelection,
  makeLegId,
  payoutCents,
  pickLabel,
  slipProblems,
  totalStakeCents,
} from '../shared/betRules.js';
import { roundDecimal } from '../shared/oddsMath.js';

function bad(message, extra) {
  return new HttpError(400, 'BAD_SLIP', message, extra);
}

function parseRequest(body) {
  const mode = body.mode;
  if (mode !== 'singles' && mode !== 'parlay') throw bad('mode must be "singles" or "parlay".');
  if (!isValidRequestId(body.clientRequestId)) throw bad('Missing or invalid clientRequestId.');
  if (!Array.isArray(body.legs) || body.legs.length === 0) throw bad('Add at least one pick.');
  if (body.legs.length > MAX_LEGS) throw bad(`A slip can hold at most ${MAX_LEGS} picks.`);

  const legs = body.legs.map((raw, i) => {
    const leg = raw && typeof raw === 'object' ? raw : {};
    const league = String(leg.league ?? '').toLowerCase();
    if (!getLeague(league)) throw bad(`Pick ${i + 1}: unknown league.`);
    const gameId = String(leg.gameId ?? '');
    if (!gameId || gameId.length > 120) throw bad(`Pick ${i + 1}: missing game.`);
    if (!isValidSelection(leg.marketType, leg.selection)) throw bad(`Pick ${i + 1}: invalid market.`);
    const line = leg.line === null || leg.line === undefined ? null : Number(leg.line);
    if (line !== null && !Number.isFinite(line)) throw bad(`Pick ${i + 1}: invalid line.`);
    if (leg.marketType !== 'moneyline' && line === null) throw bad(`Pick ${i + 1}: missing line.`);
    const quotedAmerican = Number(leg.quotedAmerican);
    if (!Number.isInteger(quotedAmerican)) throw bad(`Pick ${i + 1}: missing price.`);
    const stakeCents = leg.stakeCents === undefined ? undefined : Number(leg.stakeCents);
    return {
      league,
      gameId,
      marketType: leg.marketType,
      selection: leg.selection,
      line: leg.marketType === 'moneyline' ? null : line,
      quotedAmerican,
      stakeCents,
      legId: makeLegId({ league, gameId, marketType: leg.marketType, selection: leg.selection }),
    };
  });

  const stakeCents = mode === 'parlay' ? Number(body.stakeCents) : undefined;
  const problems = slipProblems({ mode, legs, stakeCents });
  if (problems.length > 0) throw bad(problems[0], { problems });

  return { mode, legs, stakeCents, requestId: body.clientRequestId };
}

function betIds(uid, requestId, mode, legCount) {
  if (mode === 'parlay') return [`${uid}_${requestId}`];
  return Array.from({ length: legCount }, (_, i) => `${uid}_${requestId}_${i + 1}`);
}

function serializeBet(id, data) {
  const placedAt = data.placedAt?.toDate ? data.placedAt.toDate().toISOString() : data.placedAt ?? null;
  return { id, ...data, placedAt };
}

async function loadExisting(db, ids, uid) {
  const snaps = await Promise.all(ids.map((id) => db.collection('bets').doc(id).get()));
  if (!snaps[0].exists) return null;
  return snaps.filter((s) => s.exists && s.data().uid === uid).map((s) => serializeBet(s.id, s.data()));
}

function storedLeg(request, priced) {
  const { quote, game } = priced;
  return {
    legId: request.legId,
    league: request.league,
    gameId: request.gameId,
    gameLabel: `${game.away.shortName} @ ${game.home.shortName}`,
    startTime: game.startTime,
    marketType: request.marketType,
    selection: request.selection,
    label: pickLabel({
      marketType: request.marketType,
      selection: request.selection,
      line: quote.line,
      homeName: game.home.shortName,
      awayName: game.away.shortName,
    }),
    line: request.marketType === 'moneyline' ? null : quote.line,
    americanOdds: quote.american,
    decimalOdds: quote.decimal,
    source: quote.source,
    sourceRef: quote.ref ?? null,
    result: 'pending',
  };
}

export async function placeBets(caller, body, { now = new Date(), fetchImpl = fetch, ctx = null } = {}) {
  const request = parseRequest(body);
  const db = adminDb();
  const ids = betIds(caller.uid, request.requestId, request.mode, request.legs.length);

  // Double-click / retry: the same request id returns the bets it already placed.
  const existing = await loadExisting(db, ids, caller.uid);
  if (existing) {
    const userSnap = await db.collection('users').doc(caller.uid).get();
    return { ok: true, duplicate: true, bets: existing, priceChanges: [], balanceCents: userSnap.data()?.balanceCents ?? 0 };
  }

  // Re-price every leg at its source.
  const pricing = ctx ?? createPricingContext({ now, fetchImpl });
  const results = await Promise.all(
    request.legs.map((leg) =>
      priceLeg(leg, pricing).catch((err) => {
        console.error(`pricing ${leg.legId} failed:`, err.message);
        return { status: 'closed', reason: 'Could not reach the odds source. Try again.' };
      }),
    ),
  );

  const closedLegs = [];
  const lineChanges = [];
  results.forEach((r, i) => {
    const leg = request.legs[i];
    if (r.status === 'closed') closedLegs.push({ legId: leg.legId, reason: r.reason });
    if (r.status === 'lineChanged') {
      lineChanges.push({ legId: leg.legId, oldLine: leg.line, newLine: r.quote.line, newAmerican: r.quote.american, quote: r.quote });
    }
  });
  if (closedLegs.length > 0) {
    throw new HttpError(409, 'MARKET_CLOSED', closedLegs.length === 1 ? closedLegs[0].reason : 'Some picks are no longer available.', {
      closedLegs,
      lineChanges,
    });
  }
  if (lineChanges.length > 0) {
    throw new HttpError(409, 'LINE_CHANGED', 'A line moved. Accept the new line or remove the pick, then submit again.', {
      lineChanges,
      closedLegs: [],
    });
  }

  // Build the bet documents at the fresh prices.
  const legsOut = results.map((r, i) => storedLeg(request.legs[i], r));
  const priceChanges = legsOut
    .map((leg, i) => ({ legId: leg.legId, from: request.legs[i].quotedAmerican, to: leg.americanOdds }))
    .filter((c) => c.from !== c.to);

  const placedAt = Timestamp.fromDate(now);
  const base = {
    uid: caller.uid,
    username: caller.user.username,
    status: 'open',
    payoutCents: 0,
    settledBy: null,
    settledAt: null,
    version: 0,
    placedAt,
    requestId: request.requestId,
  };

  const bets =
    request.mode === 'parlay'
      ? [(() => {
          const decimal = roundDecimal(combinedDecimal(legsOut.map((l) => l.decimalOdds)));
          return {
            ...base,
            type: 'parlay',
            stakeCents: request.stakeCents,
            legs: legsOut,
            combinedDecimal: decimal,
            combinedAmerican: combinedAmerican(legsOut.map((l) => l.decimalOdds)),
            potentialPayoutCents: payoutCents(request.stakeCents, combinedDecimal(legsOut.map((l) => l.decimalOdds))),
          };
        })()]
      : legsOut.map((leg, i) => ({
          ...base,
          type: 'single',
          stakeCents: request.legs[i].stakeCents,
          legs: [leg],
          combinedDecimal: leg.decimalOdds,
          combinedAmerican: leg.americanOdds,
          potentialPayoutCents: payoutCents(request.legs[i].stakeCents, leg.decimalOdds),
        }));

  const total = totalStakeCents({ mode: request.mode, legs: request.legs, stakeCents: request.stakeCents });
  const userRef = db.collection('users').doc(caller.uid);
  const betRefs = ids.map((id) => db.collection('bets').doc(id));

  const outcome = await db.runTransaction(async (tx) => {
    const [userSnap, firstBetSnap] = await Promise.all([tx.get(userRef), tx.get(betRefs[0])]);
    if (firstBetSnap.exists) return { duplicate: true };
    if (!userSnap.exists) throw new HttpError(403, 'NO_PROFILE', 'No player profile exists for this login.');

    const balance = Number(userSnap.data().balanceCents) || 0;
    if (total > balance) {
      throw new HttpError(409, 'INSUFFICIENT_BALANCE', `Your wallet has $${(balance / 100).toFixed(2)}; this slip needs $${(total / 100).toFixed(2)}.`);
    }

    let running = balance;
    bets.forEach((bet, i) => {
      running -= bet.stakeCents;
      tx.create(betRefs[i], bet);
      tx.create(db.collection('ledger').doc(`stake_${ids[i]}`), {
        uid: caller.uid,
        type: 'stake',
        amountCents: -bet.stakeCents,
        balanceAfterCents: running,
        betId: ids[i],
        note: bet.type === 'parlay' ? `Parlay (${bet.legs.length} legs)` : bet.legs[0].label,
        by: caller.uid,
        createdAt: placedAt,
      });
    });
    tx.update(userRef, { balanceCents: running });
    return { duplicate: false, balanceCents: running };
  });

  if (outcome.duplicate) {
    const again = await loadExisting(db, ids, caller.uid);
    const userSnap = await userRef.get();
    return { ok: true, duplicate: true, bets: again ?? [], priceChanges: [], balanceCents: userSnap.data()?.balanceCents ?? 0 };
  }

  return {
    ok: true,
    duplicate: false,
    bets: bets.map((bet, i) => serializeBet(ids[i], bet)),
    priceChanges,
    balanceCents: outcome.balanceCents,
  };
}
