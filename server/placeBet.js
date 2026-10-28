// Places singles or a parlay: validate → re-price every leg at its source → one Firestore
// transaction that checks the balance, creates the bet(s), subtracts the stake and writes the ledger.
// Refusals, in this order: MARKET_CLOSED, LINE_CHANGED, then ODDS_CHANGED (a leg's fresh price is 50+ points from
// the quotedAmerican the player saw, shared/oddsMath.js needsOddsConfirm). Nothing is placed and no money moves.
// A smaller price change is accepted at the fresh price and listed in priceChanges.
// Challenge legs: the transaction re-checks the Challenge is still open, counts the bet on it, and when
// the bettor is the Challenge's poster, sets `posterBet: true` on the bet (decided here, never by the
// browser) and lists the bet in the Challenge's public `posterBets`.
//
// AI agents (0.21.0: the caller's profile has `agent`), house rules checked here and nowhere else:
//   AGENT_NO_CRYPTO (409) / AGENT_NOT_ALLOWED (403, Challenge legs)  before anything is fetched
//   AGENT_PREGAME_ONLY (409)  any leg whose game has started (after pricing, before LINE_CHANGED / ODDS_CHANGED)
//   AGENT_STAKE_CAP (409)     a bet slip's stake (a parlay counts once, each single is a slip) over 5% of the balance
//                             at the time of the bet, rounded down to the cent; read inside the transaction
//   AGENT_DAILY_LIMIT (409)   more than 10 slips in the Central calendar day: agentDaily/{uid}_{YYYY-MM-DD}, read and
//                             written (create or increment) inside the same transaction, so a retried clientRequestId
//                             (which stops at "already placed" before any write) never counts twice
// `why` (agents only) is cleaned like chat text, cut to 280 characters and stored on each bet as agentWhy.

import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from './firebaseAdmin.js';
import { HttpError } from './http.js';
import { getLeague } from './leagues.js';
import { createPricingContext, priceLeg } from './pricing.js';
import {
  PAYOUT_TOO_LARGE_MESSAGE,
  MAX_LEGS,
  combinedAmerican,
  combinedDecimal,
  isValidRequestId,
  isValidSelection,
  makeLegId,
  marketHasLine,
  payoutCents,
  payoutTooLarge,
  pickLabel,
  slipProblems,
  totalStakeCents,
} from '../shared/betRules.js';
import { needsOddsConfirm, roundDecimal } from '../shared/oddsMath.js';
import { CHALLENGE_LEAGUE, CHALLENGE_MARKET, challengeDocId, isChallengeLeg } from '../shared/challenges.js';
import { CRYPTO_LEAGUE, CRYPTO_MARKET, CRYPTO_PREFIX } from '../shared/crypto/coins.js';
import { PROP_MARKET } from '../shared/props.js';
import { AGENT_DAILY_LIMIT, AGENT_STAKE_PERCENT, agentDailyId, agentStakeCapCents, centralDay, cleanAgentWhy, isAgent } from '../shared/agents.js';

const KALSHI_TICKER_PATTERN = /^[A-Z0-9][A-Z0-9._-]{3,100}$/;

function bad(message, extra) {
  return new HttpError(400, 'BAD_SLIP', message, extra);
}

function cleanPlayerName(value) {
  if (typeof value !== 'string') return '';
  const text = [...value].filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127 && ch !== '<' && ch !== '>').join('').trim();
  return text.length <= 60 ? text : '';
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
    const gameId = String(leg.gameId ?? '');
    if (!gameId || gameId.length > 200) throw bad(`Pick ${i + 1}: missing game.`);
    const challenge = league === CHALLENGE_LEAGUE || leg.marketType === CHALLENGE_MARKET || isChallengeLeg({ gameId });
    const crypto = league === CRYPTO_LEAGUE || leg.marketType === CRYPTO_MARKET || gameId.startsWith(CRYPTO_PREFIX);
    if (challenge) {
      if (league !== CHALLENGE_LEAGUE || leg.marketType !== CHALLENGE_MARKET || !isChallengeLeg({ gameId })) throw bad(`Pick ${i + 1}: invalid Challenge pick.`);
    } else if (crypto) {
      if (league !== CRYPTO_LEAGUE || leg.marketType !== CRYPTO_MARKET || !gameId.startsWith(CRYPTO_PREFIX)) throw bad(`Pick ${i + 1}: invalid crypto pick.`);
      if (!leg.kalshiTicker) throw bad(`Pick ${i + 1}: a crypto pick needs its Kalshi market.`);
    } else if (!getLeague(league)) throw bad(`Pick ${i + 1}: unknown league.`);
    if (leg.marketType === PROP_MARKET && (gameId.includes(':') || !leg.kalshiTicker)) throw bad(`Pick ${i + 1}: a prop needs its game and Kalshi market.`);
    if (!isValidSelection(leg.marketType, leg.selection)) throw bad(`Pick ${i + 1}: invalid market.`);
    const line = leg.line === null || leg.line === undefined ? null : Number(leg.line);
    if (line !== null && !Number.isFinite(line)) throw bad(`Pick ${i + 1}: invalid line.`);
    if (marketHasLine(leg.marketType) && line === null) throw bad(`Pick ${i + 1}: missing line.`);
    const quotedAmerican = Number(leg.quotedAmerican);
    if (!Number.isInteger(quotedAmerican)) throw bad(`Pick ${i + 1}: missing price.`);
    const stakeCents = leg.stakeCents === undefined ? undefined : Number(leg.stakeCents);

    // Exact Kalshi market (main or alternate line), validated against the game at pricing time.
    let kalshiTicker = null;
    let kalshiSide = null;
    if (leg.kalshiTicker !== undefined && leg.kalshiTicker !== null && leg.kalshiTicker !== '') {
      if (typeof leg.kalshiTicker !== 'string' || !KALSHI_TICKER_PATTERN.test(leg.kalshiTicker)) {
        throw bad(`Pick ${i + 1}: invalid Kalshi market.`);
      }
      if (leg.kalshiSide !== 'yes' && leg.kalshiSide !== 'no') throw bad(`Pick ${i + 1}: invalid Kalshi side.`);
      kalshiTicker = leg.kalshiTicker;
      kalshiSide = leg.kalshiSide;
    }

    // The slip's own id for this pick is echoed back in LINE_CHANGED / MARKET_CLOSED answers.
    const clientLegId = typeof leg.legId === 'string' && leg.legId.length <= 200 ? leg.legId : null;
    // A prop's player name, used only as text in the "one leg per player per stat" refusal (the rule itself is decided
    // on the Kalshi ticker, never on this name); nothing else reads it and it is never stored.
    const playerName = leg.marketType === PROP_MARKET ? cleanPlayerName(leg.playerName) : '';

    return {
      league,
      gameId,
      marketType: leg.marketType,
      selection: leg.selection,
      line: marketHasLine(leg.marketType) ? line : null,
      quotedAmerican,
      stakeCents,
      kalshiTicker,
      kalshiSide,
      playerName,
      legId: clientLegId ?? makeLegId({ league, gameId, marketType: leg.marketType, selection: leg.selection, line, ticker: kalshiTicker ?? '' }),
    };
  });

  const stakeCents = mode === 'parlay' ? Number(body.stakeCents) : undefined;
  const problems = slipProblems({ mode, legs, stakeCents });
  if (problems.length > 0) throw bad(problems[0], { problems });

  return { mode, legs, stakeCents, requestId: body.clientRequestId };
}

function startMs(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// A priced leg's game has started (or isn't a pre-game market any more).
export function legHasStarted(game, now) {
  if (!game) return true;
  if (game.state && game.state !== 'pre') return true;
  if (game.bettingClosed === true) return true;
  const ms = startMs(game.startTime);
  return ms !== null && ms <= now.getTime();
}

function agentRefusal(status, code, message) {
  return new HttpError(status, code, message);
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
  if (request.marketType === PROP_MARKET) {
    const prop = game.prop;
    return {
      legId: makeLegId({ league: request.league, gameId: request.gameId, marketType: PROP_MARKET, selection: request.selection, line: quote.line, source: quote.source, ticker: quote.ref?.ticker ?? '' }),
      league: request.league,
      gameId: request.gameId,
      gameLabel: `${game.away.shortName} @ ${game.home.shortName}`,
      startTime: game.startTime,
      marketType: PROP_MARKET,
      selection: request.selection,
      label: pickLabel({ marketType: PROP_MARKET, selection: request.selection, prop }),
      line: quote.line,
      americanOdds: quote.american,
      decimalOdds: quote.decimal,
      source: quote.source,
      sourceRef: quote.ref ?? null,
      prop: { series: prop.series, stat: prop.stat, player: prop.player, team: prop.team ?? null, threshold: prop.threshold, anytime: prop.anytime },
      result: 'pending',
    };
  }
  if (game.kind === 'crypto') {
    return {
      legId: makeLegId({ league: request.league, gameId: request.gameId, marketType: request.marketType, selection: request.selection, line: quote.line, source: quote.source }),
      league: request.league,
      gameId: request.gameId,
      gameLabel: game.gameLabel,
      startTime: game.startTime, // the market's close time
      marketType: request.marketType,
      selection: request.selection,
      label: pickLabel({ marketType: request.marketType, selection: request.selection, line: quote.line, crypto: game.crypto }),
      line: quote.line,
      americanOdds: quote.american,
      decimalOdds: quote.decimal,
      source: quote.source,
      sourceRef: quote.ref ?? null,
      crypto: { symbol: game.crypto.symbol, coin: game.crypto.coin, kind: game.crypto.kind, closeTime: game.crypto.closeTime },
      result: 'pending',
    };
  }
  if (game.kind === 'challenge') {
    return {
      legId: makeLegId({ league: request.league, gameId: request.gameId, marketType: request.marketType, selection: request.selection, source: quote.source }),
      league: request.league,
      gameId: request.gameId,
      gameLabel: game.title,
      startTime: game.startTime,
      marketType: request.marketType,
      selection: request.selection,
      label: pickLabel({ marketType: request.marketType, selection: request.selection, outcomeLabel: game.outcomeLabel }),
      line: null,
      americanOdds: quote.american,
      decimalOdds: quote.decimal,
      source: quote.source,
      sourceRef: quote.ref ?? null,
      result: 'pending',
    };
  }
  return {
    legId: makeLegId({
      league: request.league,
      gameId: request.gameId,
      marketType: request.marketType,
      selection: request.selection,
      line: marketHasLine(request.marketType) ? quote.line : null,
      source: quote.source,
    }),
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
    line: marketHasLine(request.marketType) ? quote.line : null,
    americanOdds: quote.american,
    decimalOdds: quote.decimal,
    source: quote.source,
    sourceRef: quote.ref ?? null,
    result: 'pending',
  };
}

export async function placeBets(caller, body, { now = new Date(), fetchImpl = fetch, ctx = null } = {}) {
  const request = parseRequest(body);
  const agent = isAgent(caller.user);
  if (agent) {
    if (request.legs.some((l) => l.league === CRYPTO_LEAGUE || l.marketType === CRYPTO_MARKET)) {
      throw agentRefusal(409, 'AGENT_NO_CRYPTO', 'AI agents bet pre-game only, so crypto markets are not allowed.');
    }
    if (request.legs.some((l) => isChallengeLeg(l))) {
      throw agentRefusal(403, 'AGENT_NOT_ALLOWED', 'AI agents can\'t bet on Challenges.');
    }
  }
  const agentWhy = agent ? cleanAgentWhy(body.why) : '';
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
  // Agents: pre-game only. Checked before a line or price change, so an agent is never asked to re-submit a started game.
  if (agent) {
    const started = results.map((r, i) => (legHasStarted(r.game, now) ? request.legs[i].legId : null)).filter(Boolean);
    if (started.length > 0) {
      throw new HttpError(409, 'AGENT_PREGAME_ONLY', 'AI agents bet pre-game only, and a game on this slip has started.', { startedLegs: started });
    }
  }
  if (lineChanges.length > 0) {
    throw new HttpError(409, 'LINE_CHANGED', 'A line moved. Accept the new line or remove the pick, then submit again.', {
      lineChanges,
      closedLegs: [],
    });
  }

  // A big price move on any leg (either direction, any market, each parlay leg): the player confirms first.
  const oddsChanges = [];
  results.forEach((r, i) => {
    const leg = request.legs[i];
    if (needsOddsConfirm(leg.quotedAmerican, r.quote.american)) {
      oddsChanges.push({ legId: leg.legId, oldAmerican: leg.quotedAmerican, newAmerican: r.quote.american, quote: r.quote });
    }
  });
  if (oddsChanges.length > 0) {
    throw new HttpError(409, 'ODDS_CHANGED', oddsChanges.length === 1 ? 'The odds moved. Accept the new odds or remove the pick.' : 'Some odds moved. Accept the new odds or remove the picks.', {
      oddsChanges,
      lineChanges: [],
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
    ...(agentWhy ? { agentWhy } : {}),
  };

  // Challenges this player posted: their bets on them are flagged by the server.
  const postedByMe = new Set(results.filter((r) => r.game?.kind === 'challenge' && r.game.posterUid === caller.uid).map((r) => r.game.id));
  const isPosterLeg = (leg) => isChallengeLeg(leg) && postedByMe.has(String(leg.gameId));

  const bets = (
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
        }))
  ).map((bet) => (bet.legs.some(isPosterLeg) ? { ...bet, posterBet: true } : bet));

  // Technical guard (0.16.0, no maximum stakes): a payout must be an exact integer number of cents, so a huge stake on
  // a long-odds parlay is refused rather than stored rounded. Nothing has been read or written yet.
  if (bets.some((bet) => payoutTooLarge(bet.potentialPayoutCents))) throw bad(PAYOUT_TOO_LARGE_MESSAGE);

  const total = totalStakeCents({ mode: request.mode, legs: request.legs, stakeCents: request.stakeCents });
  const userRef = db.collection('users').doc(caller.uid);
  const betRefs = ids.map((id) => db.collection('bets').doc(id));

  // Custom games count the bets placed on them (Delete is only allowed at 0).
  const customBetCounts = new Map(); // customGames doc id → number of new bets on it
  for (const bet of bets) {
    const docIds = new Set(bet.legs.filter((l) => String(l.gameId).startsWith('custom:')).map((l) => String(l.gameId).slice(7)));
    for (const docId of docIds) customBetCounts.set(docId, (customBetCounts.get(docId) ?? 0) + 1);
  }
  const customRefs = [...customBetCounts.keys()].map((docId) => db.collection('customGames').doc(docId));

  // Challenges count their bets too, and list the poster's own bets publicly.
  const challengeBets = new Map(); // challenges doc id → [{ bet, index }]
  bets.forEach((bet, i) => {
    const docIds = new Set(bet.legs.filter(isChallengeLeg).map((l) => challengeDocId(l.gameId)));
    for (const docId of docIds) challengeBets.set(docId, [...(challengeBets.get(docId) ?? []), { bet, index: i }]);
  });
  const challengeIds = [...challengeBets.keys()];
  const challengeRefs = challengeIds.map((docId) => db.collection('challenges').doc(docId));
  const day = centralDay(now);
  const dailyRef = agent ? db.collection('agentDaily').doc(agentDailyId(caller.uid, day)) : null;

  const outcome = await db.runTransaction(async (tx) => {
    const [userSnap, firstBetSnap, dailySnap, ...docSnaps] = await Promise.all([
      tx.get(userRef),
      tx.get(betRefs[0]),
      dailyRef ? tx.get(dailyRef) : Promise.resolve(null),
      ...customRefs.map((r) => tx.get(r)),
      ...challengeRefs.map((r) => tx.get(r)),
    ]);
    const customSnaps = docSnaps.slice(0, customRefs.length);
    const challengeSnaps = docSnaps.slice(customRefs.length);
    if (firstBetSnap.exists) return { duplicate: true }; // a retry: nothing below runs, so nothing counts twice
    if (!userSnap.exists) throw new HttpError(403, 'NO_PROFILE', 'No player profile exists for this login.');
    if (customSnaps.some((s) => !s.exists)) {
      throw new HttpError(409, 'MARKET_CLOSED', 'A custom game on this slip was just removed.', { closedLegs: [], lineChanges: [] });
    }
    // Re-checked inside the transaction: settled, voided or closed since it was priced → refused.
    for (const snap of challengeSnaps) {
      const c = snap.exists ? snap.data() : null;
      const closeMs = c?.closeTime?.toMillis ? c.closeTime.toMillis() : new Date(c?.closeTime ?? 0).getTime();
      if (!c || c.status !== 'open' || now.getTime() >= closeMs) {
        throw new HttpError(409, 'MARKET_CLOSED', 'A Challenge on this slip just closed.', { closedLegs: [], lineChanges: [] });
      }
    }

    const balance = Number(userSnap.data().balanceCents) || 0;
    if (total > balance) {
      throw new HttpError(409, 'INSUFFICIENT_BALANCE', `Your wallet has $${(balance / 100).toFixed(2)}; this slip needs $${(total / 100).toFixed(2)}.`);
    }
    let dailyCount = 0;
    if (agent) {
      const cap = agentStakeCapCents(balance);
      const over = bets.find((bet) => bet.stakeCents > cap);
      if (over) {
        throw new HttpError(409, 'AGENT_STAKE_CAP', `AI agents can stake at most ${AGENT_STAKE_PERCENT}% of the balance per slip: $${(cap / 100).toFixed(2)} now.`, { capCents: cap, balanceCents: balance });
      }
      dailyCount = dailySnap?.exists ? Number(dailySnap.data().count) || 0 : 0;
      if (dailyCount + bets.length > AGENT_DAILY_LIMIT) {
        throw new HttpError(409, 'AGENT_DAILY_LIMIT', `AI agents can place at most ${AGENT_DAILY_LIMIT} bet slips a day (Central time); ${dailyCount} placed today.`, { slips: dailyCount, limit: AGENT_DAILY_LIMIT });
      }
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
    if (agent) {
      const counter = { uid: caller.uid, day, count: dailyCount + bets.length, updatedAt: placedAt };
      if (dailySnap?.exists) tx.update(dailyRef, counter);
      else tx.create(dailyRef, counter);
    }
    customRefs.forEach((ref, i) => {
      const count = Number(customSnaps[i].data().betCount) || 0;
      tx.update(ref, { betCount: count + customBetCounts.get(ref.id ?? ref.path.split('/').pop()) });
    });
    challengeRefs.forEach((ref, i) => {
      const c = challengeSnaps[i].data();
      const placed = challengeBets.get(challengeIds[i]);
      const update = { betCount: (Number(c.betCount) || 0) + placed.length };
      if (c.posterUid === caller.uid) {
        const mine = placed.map(({ bet, index }) => {
          const leg = bet.legs.find((l) => isChallengeLeg(l) && challengeDocId(l.gameId) === challengeIds[i]);
          return { betId: ids[index], outcomeId: leg.selection, label: leg.label, americanOdds: leg.americanOdds, stakeCents: bet.stakeCents, parlay: bet.type === 'parlay', at: placedAt };
        });
        update.posterBets = [...(c.posterBets ?? []), ...mine].slice(-100);
      }
      tx.update(ref, update);
    });
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
