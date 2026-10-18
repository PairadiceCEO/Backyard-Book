// Battles: player-created, private contests. Everyone puts in the same stake; the creator enters the
// result and the pot pays out at once; the admin can fix anything afterwards.
//
// Every action is one Firestore transaction that re-reads the Battle and the wallets it touches. Money
// entries use deterministic ledger ids written with create(), so a retry or double tap pays once:
//   bstake_{id}_{uid}_{seq}    battle_stake   −stake  (seq = that player's stake number: withdraw → accept again)
//   brefund_{id}_{uid}_{seq}   battle_refund  +stake  (decline, cancel, withdraw, 48 h expiry, void before payout)
//   bpay_{id}_{uid}            battle_payout  +share  (the result)
//   regrade_battle_{id}_v{n}_{uid}  admin_regrade ±difference (admin changes after the payout; may go below $0)
// `credited[uid]` on the Battle is what each player has been credited since it went live (payouts and
// admin changes), so an admin change moves only the difference.
//
// Statuses: pending (waiting for every invited player) → live (everyone accepted) → settled (paid out);
// or cancelled (declined, cancelled by the creator, or 48 h without everyone accepting) / void (admin).
// Battles never touch win rate and never appear in Shop purchases (ledger types battle_*).

import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from './firebaseAdmin.js';
import { HttpError } from './http.js';
import { isValidRequestId } from '../shared/betRules.js';
import {
  BATTLE_EXPIRY_MS,
  DISPUTE_NOTE_MAX,
  DISPUTE_WINDOW_MS,
  battleProblems,
  computeBattlePayouts,
  payoutProblems,
  placeUnits,
  resultProblems,
} from '../shared/battles.js';

const COLLECTION = 'battles';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const MAX_EDITS = 50;
const MAX_DISPUTES = 20;

function toMs(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function nameOf(user, uid) {
  return String(user?.displayName || user?.username || uid).slice(0, 40);
}

function battleIdFrom(body) {
  const id = typeof body.battleId === 'string' ? body.battleId : '';
  if (!ID_PATTERN.test(id)) throw new HttpError(400, 'BAD_BATTLE', 'Missing Battle id.');
  return id;
}

function fmt(cents) {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? '−' : ''}$${(abs / 100).toFixed(2)}`;
}

export function battleLedgerIds(battleId) {
  return {
    stake: (uid, seq) => `bstake_${battleId}_${uid}_${seq}`,
    refund: (uid, seq) => `brefund_${battleId}_${uid}_${seq}`,
    payout: (uid) => `bpay_${battleId}_${uid}`,
    regrade: (uid, version) => `regrade_battle_${battleId}_v${version}_${uid}`,
  };
}

// ---------- transaction helpers ----------

// Reads the Battle and the wallets of every participant (plus `extraUids`) in one round trip.
async function readBattle(tx, db, battleId, extraUids = []) {
  const ref = db.collection(COLLECTION).doc(battleId);
  const snap = await tx.get(ref);
  if (!snap.exists) throw new HttpError(404, 'BATTLE_NOT_FOUND', 'That Battle does not exist.');
  const battle = snap.data();
  const uids = [...new Set([...(battle.participantUids ?? []), ...extraUids])];
  const userSnaps = uids.length ? await tx.getAll(...uids.map((uid) => db.collection('users').doc(uid))) : [];
  const wallets = new Map();
  uids.forEach((uid, i) => {
    const s = userSnaps[i];
    wallets.set(uid, { exists: s.exists, balanceCents: s.exists ? Number(s.data().balanceCents) || 0 : 0, user: s.exists ? s.data() : null });
  });
  return { ref, battle, wallets };
}

// Collects money moves, then writes wallets and ledger entries in one go (after every read).
function moneyBook(tx, db, wallets, battleId, at) {
  const entries = [];
  return {
    add(uid, { id, type, amountCents, note, by }) {
      if (!amountCents) return;
      entries.push({ uid, id, type, amountCents, note, by });
    },
    balanceAfter(uid) {
      const w = wallets.get(uid);
      return (w?.balanceCents ?? 0) + entries.filter((e) => e.uid === uid).reduce((s, e) => s + e.amountCents, 0);
    },
    commit() {
      const running = new Map();
      for (const e of entries) {
        const w = wallets.get(e.uid);
        if (!w?.exists) {
          console.error(`battle ${battleId}: no users/${e.uid}; skipped ${e.type} ${e.amountCents}`);
          continue;
        }
        const before = running.has(e.uid) ? running.get(e.uid) : w.balanceCents;
        const after = before + e.amountCents;
        running.set(e.uid, after);
        tx.create(db.collection('ledger').doc(e.id), {
          uid: e.uid,
          type: e.type,
          amountCents: e.amountCents,
          balanceAfterCents: after,
          betId: null,
          battleId,
          note: String(e.note).slice(0, 200),
          by: e.by,
          createdAt: at,
        });
      }
      for (const [uid, balance] of running) tx.update(db.collection('users').doc(uid), { balanceCents: balance });
      return running;
    },
  };
}

function participant(battle, uid) {
  return (battle.participants ?? []).find((p) => p.uid === uid) ?? null;
}

function requireParticipant(battle, uid) {
  const p = participant(battle, uid);
  if (!p) throw new HttpError(403, 'NOT_IN_BATTLE', "You're not in this Battle.");
  return p;
}

// Refunds every player currently holding a stake (pending Battles).
function refundStakes(book, battle, ids, note, by) {
  for (const p of battle.participants) {
    if (p.status !== 'accepted') continue;
    book.add(p.uid, { id: ids.refund(p.uid, p.stakeSeq), type: 'battle_refund', amountCents: battle.stakeCents, note, by });
  }
}

function isExpired(battle, nowMs) {
  return battle.status === 'pending' && toMs(battle.expiresAt) !== null && nowMs >= toMs(battle.expiresAt);
}

// A pending Battle past its 48 h: cancelled and every stake refunded. Returns the update to write.
function expireUpdate(book, battle, ids, at) {
  refundStakes(book, battle, ids, `Battle "${battle.title}" expired (not everyone accepted in 48 h): stake back`, 'battles');
  return {
    status: 'cancelled',
    cancelReason: 'Not everyone accepted within 48 hours.',
    cancelledAt: at,
    participants: battle.participants.map((p) => (p.status === 'accepted' ? { ...p, status: 'refunded' } : p)),
    version: (Number(battle.version) || 0) + 1,
  };
}

// Runs fn(battle, wallets, book) in a transaction; a pending Battle that has expired is closed first
// (and the action refused), so nobody can join or act on it.
async function runBattle(battleId, { now, extraUids = [], allowExpired = false }, fn) {
  const db = adminDb();
  const at = Timestamp.fromDate(now);
  const ids = battleLedgerIds(battleId);
  const result = await db.runTransaction(async (tx) => {
    const { ref, battle, wallets } = await readBattle(tx, db, battleId, extraUids);
    const book = moneyBook(tx, db, wallets, battleId, at);
    if (!allowExpired && isExpired(battle, now.getTime())) {
      tx.update(ref, expireUpdate(book, battle, ids, at));
      book.commit();
      return { expired: true };
    }
    const out = await fn({ battle, wallets, book, ids, at, ref });
    if (out?.update) tx.update(ref, { ...out.update, version: (Number(battle.version) || 0) + 1, updatedAt: at });
    const balances = book.commit();
    return { ...(out?.reply ?? { ok: true }), balances };
  });
  if (result.expired) throw new HttpError(409, 'BATTLE_EXPIRED', 'This Battle expired: not everyone accepted within 48 hours. Every stake was refunded.');
  return result;
}

function myBalance(result, uid) {
  return result.balances?.has(uid) ? result.balances.get(uid) : undefined;
}

// ---------- player actions ----------

// create { clientRequestId, title, description, format, stakeDollars, payoutBps, teams?, players: [{ uid, team }] }
export async function createBattle(caller, body, { now = new Date() } = {}) {
  if (!isValidRequestId(body.clientRequestId)) throw new HttpError(400, 'BAD_REQUEST_ID', 'Missing or invalid clientRequestId.');
  const input = {
    title: String(body.title ?? '').trim(),
    description: String(body.description ?? '').trim(),
    format: body.format,
    stakeDollars: body.stakeDollars,
    payoutBps: body.payoutBps,
    teams: body.format === 'teams' && Array.isArray(body.teams) ? body.teams.map((t) => ({ id: t?.id, name: String(t?.name ?? '').trim() })) : [],
    players: Array.isArray(body.players) ? body.players.map((p) => ({ uid: p?.uid, team: body.format === 'teams' ? p?.team ?? null : null })) : [],
  };
  const problems = battleProblems(input, caller.uid);
  if (problems.length) throw new HttpError(400, 'BAD_BATTLE', problems[0], { problems });

  const db = adminDb();
  const battleId = `${caller.uid}_${body.clientRequestId}`;
  const ref = db.collection(COLLECTION).doc(battleId);
  const stakeCents = input.stakeDollars * 100;
  const at = Timestamp.fromDate(now);
  const ids = battleLedgerIds(battleId);

  const result = await db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists) return { duplicate: true, battle: existing.data() };
    const uids = input.players.map((p) => p.uid);
    const snaps = await tx.getAll(...uids.map((uid) => db.collection('users').doc(uid)));
    const users = new Map();
    snaps.forEach((s, i) => {
      if (!s.exists || s.data().disabled === true) throw new HttpError(409, 'BAD_PLAYER', 'One of the invited players no longer exists or is disabled.');
      users.set(uids[i], s.data());
    });
    const creatorBalance = Number(users.get(caller.uid).balanceCents) || 0;
    if (creatorBalance < stakeCents) {
      throw new HttpError(409, 'INSUFFICIENT_BALANCE', `Your wallet has ${fmt(creatorBalance)}; the stake is ${fmt(stakeCents)}.`);
    }
    const participants = input.players.map((p) => ({
      uid: p.uid,
      name: nameOf(users.get(p.uid), p.uid),
      team: p.team,
      status: p.uid === caller.uid ? 'accepted' : 'invited',
      stakeSeq: p.uid === caller.uid ? 1 : 0,
      notice: null,
      acceptedAt: p.uid === caller.uid ? at : null,
    }));
    const battle = {
      title: input.title,
      description: input.description,
      creatorUid: caller.uid,
      creatorName: nameOf(users.get(caller.uid), caller.uid),
      format: input.format,
      teams: input.teams,
      stakeCents,
      potCents: stakeCents * participants.length,
      payoutBps: input.payoutBps,
      participants,
      participantUids: uids,
      status: 'pending',
      createdAt: at,
      updatedAt: at,
      expiresAt: Timestamp.fromMillis(now.getTime() + BATTLE_EXPIRY_MS),
      liveAt: null,
      result: null,
      resultAt: null,
      credited: {},
      disputes: [],
      disputed: false,
      edits: [],
      cancelReason: null,
      version: 0,
      requestId: body.clientRequestId,
    };
    tx.create(ref, battle);
    tx.create(db.collection('ledger').doc(ids.stake(caller.uid, 1)), {
      uid: caller.uid,
      type: 'battle_stake',
      amountCents: -stakeCents,
      balanceAfterCents: creatorBalance - stakeCents,
      betId: null,
      battleId,
      note: `Battle "${input.title}": stake`,
      by: caller.uid,
      createdAt: at,
    });
    tx.update(db.collection('users').doc(caller.uid), { balanceCents: creatorBalance - stakeCents });
    return { duplicate: false, battle, balanceCents: creatorBalance - stakeCents };
  });
  return { ok: true, battleId, duplicate: result.duplicate, balanceCents: result.balanceCents };
}

export async function acceptBattle(caller, body, { now = new Date() } = {}) {
  const battleId = battleIdFrom(body);
  const result = await runBattle(battleId, { now }, ({ battle, wallets, book, ids, at }) => {
    const me = requireParticipant(battle, caller.uid);
    if (battle.status !== 'pending') throw new HttpError(409, 'BATTLE_CLOSED', battle.status === 'live' ? 'This Battle is already live.' : 'This Battle is closed.');
    if (me.status === 'accepted') return { reply: { ok: true, duplicate: true } };
    if (me.status !== 'invited') throw new HttpError(409, 'BATTLE_CLOSED', 'You already declined this Battle.');
    const balance = wallets.get(caller.uid).balanceCents;
    if (balance < battle.stakeCents) {
      throw new HttpError(409, 'INSUFFICIENT_BALANCE', `Your wallet has ${fmt(balance)}; the stake is ${fmt(battle.stakeCents)}.`);
    }
    const seq = (Number(me.stakeSeq) || 0) + 1;
    book.add(caller.uid, { id: ids.stake(caller.uid, seq), type: 'battle_stake', amountCents: -battle.stakeCents, note: `Battle "${battle.title}": stake`, by: caller.uid });
    const participants = battle.participants.map((p) => (p.uid === caller.uid ? { ...p, status: 'accepted', stakeSeq: seq, notice: null, acceptedAt: at } : p));
    const allIn = participants.every((p) => p.status === 'accepted');
    const update = { participants };
    if (allIn) {
      update.status = 'live';
      update.liveAt = at;
    }
    return { update, reply: { ok: true, live: allIn } };
  });
  return { ...stripBalances(result), balanceCents: myBalance(result, caller.uid) };
}

export async function declineBattle(caller, body, { now = new Date() } = {}) {
  const battleId = battleIdFrom(body);
  const result = await runBattle(battleId, { now }, ({ battle, book, ids, at }) => {
    const me = requireParticipant(battle, caller.uid);
    if (battle.status === 'cancelled' && me.status === 'declined') return { reply: { ok: true, duplicate: true } };
    if (battle.status !== 'pending') throw new HttpError(409, 'BATTLE_CLOSED', 'This Battle is no longer waiting for players.');
    if (me.status !== 'invited') throw new HttpError(409, 'ALREADY_IN', "You've already accepted. You can withdraw only if the admin changes the payout before it goes live.");
    refundStakes(book, battle, ids, `Battle "${battle.title}" cancelled (${me.name} declined): stake back`, caller.uid);
    return {
      update: {
        status: 'cancelled',
        cancelReason: `${me.name} declined.`,
        cancelledAt: at,
        participants: battle.participants.map((p) => (p.uid === caller.uid ? { ...p, status: 'declined' } : p.status === 'accepted' ? { ...p, status: 'refunded' } : p)),
      },
      reply: { ok: true, cancelled: true },
    };
  });
  return stripBalances(result);
}

// After an admin payout change (before live): take the stake back and go back to "invited".
export async function withdrawBattle(caller, body, { now = new Date() } = {}) {
  const battleId = battleIdFrom(body);
  const result = await runBattle(battleId, { now }, ({ battle, book, ids }) => {
    const me = requireParticipant(battle, caller.uid);
    if (battle.status !== 'pending') throw new HttpError(409, 'BATTLE_CLOSED', 'This Battle is no longer waiting for players.');
    if (me.status !== 'accepted' || me.notice !== 'payoutChanged') {
      if (me.status === 'invited') return { reply: { ok: true, duplicate: true } };
      throw new HttpError(409, 'CANT_WITHDRAW', 'You can withdraw only after the admin changes the payout.');
    }
    book.add(caller.uid, { id: ids.refund(caller.uid, me.stakeSeq), type: 'battle_refund', amountCents: battle.stakeCents, note: `Battle "${battle.title}": withdrew after the payout changed`, by: caller.uid });
    return {
      update: { participants: battle.participants.map((p) => (p.uid === caller.uid ? { ...p, status: 'invited', notice: null, acceptedAt: null } : p)) },
      reply: { ok: true },
    };
  });
  return { ...stripBalances(result), balanceCents: myBalance(result, caller.uid) };
}

// After an admin payout change: "keep my spot" (clears the notice).
export async function keepBattle(caller, body, { now = new Date() } = {}) {
  const battleId = battleIdFrom(body);
  const result = await runBattle(battleId, { now }, ({ battle }) => {
    const me = requireParticipant(battle, caller.uid);
    if (!me.notice) return { reply: { ok: true, duplicate: true } };
    return { update: { participants: battle.participants.map((p) => (p.uid === caller.uid ? { ...p, notice: null } : p)) }, reply: { ok: true } };
  });
  return stripBalances(result);
}

export async function cancelBattle(caller, body, { now = new Date() } = {}) {
  const battleId = battleIdFrom(body);
  const result = await runBattle(battleId, { now }, ({ battle, book, ids, at }) => {
    if (battle.creatorUid !== caller.uid) throw new HttpError(403, 'NOT_CREATOR', 'Only the creator can cancel a Battle.');
    if (battle.status === 'cancelled') return { reply: { ok: true, duplicate: true } };
    if (battle.status !== 'pending') throw new HttpError(409, 'BATTLE_LIVE', 'A Battle can be cancelled only before it goes live. Ask the admin to void it.');
    refundStakes(book, battle, ids, `Battle "${battle.title}" cancelled by its creator: stake back`, caller.uid);
    return {
      update: {
        status: 'cancelled',
        cancelReason: 'Cancelled by the creator.',
        cancelledAt: at,
        participants: battle.participants.map((p) => (p.status === 'accepted' ? { ...p, status: 'refunded' } : p)),
      },
      reply: { ok: true },
    };
  });
  return { ...stripBalances(result), balanceCents: myBalance(result, caller.uid) };
}

// The creator's result: { places: { [uid | teamId]: n } }. Pays out at once.
export async function setBattleResult(caller, body, { now = new Date() } = {}) {
  const battleId = battleIdFrom(body);
  const result = await runBattle(battleId, { now }, ({ battle, book, ids, at }) => {
    if (battle.creatorUid !== caller.uid) throw new HttpError(403, 'NOT_CREATOR', 'Only the creator enters the result.');
    if (battle.status === 'settled') throw new HttpError(409, 'ALREADY_SETTLED', 'The result is already in. If it’s wrong, anyone in the Battle can dispute it for the admin.');
    if (battle.status !== 'live') throw new HttpError(409, 'NOT_LIVE', 'The result can be entered once everyone has accepted.');
    const places = cleanPlaces(body.places);
    const problems = resultProblems(battle, places);
    if (problems.length) throw new HttpError(400, 'BAD_RESULT', problems[0], { problems });
    const { byUid } = computeBattlePayouts(battle, battle.potCents, places);
    const credited = {};
    for (const p of battle.participants) {
      const cents = byUid[p.uid] ?? 0;
      credited[p.uid] = cents;
      book.add(p.uid, { id: ids.payout(p.uid), type: 'battle_payout', amountCents: cents, note: `Battle "${battle.title}": ${cents ? 'winnings' : 'result'}`, by: caller.uid });
    }
    return {
      update: { status: 'settled', result: { places, enteredBy: caller.uid, enteredAt: at, by: 'creator' }, resultAt: at, credited },
      reply: { ok: true, payouts: byUid },
    };
  });
  return { ...stripBalances(result), balanceCents: myBalance(result, caller.uid) };
}

export async function disputeBattle(caller, body, { now = new Date() } = {}) {
  const battleId = battleIdFrom(body);
  const note = String(body.note ?? '').trim();
  if (!note || note.length > DISPUTE_NOTE_MAX) throw new HttpError(400, 'BAD_NOTE', `Say what's wrong (1–${DISPUTE_NOTE_MAX} characters).`);
  const result = await runBattle(battleId, { now }, ({ battle, at }) => {
    const me = requireParticipant(battle, caller.uid);
    if (battle.status !== 'settled') throw new HttpError(409, 'NO_RESULT', 'You can dispute a Battle once its result is in.');
    const resultMs = toMs(battle.resultAt);
    if (resultMs === null || now.getTime() - resultMs > DISPUTE_WINDOW_MS) throw new HttpError(409, 'DISPUTE_CLOSED', 'Disputes close 48 hours after the result.');
    const disputes = battle.disputes ?? [];
    if (disputes.some((d) => d.uid === caller.uid && !d.resolved)) return { reply: { ok: true, duplicate: true } };
    if (disputes.length >= MAX_DISPUTES) throw new HttpError(409, 'TOO_MANY', 'This Battle already has the maximum number of disputes.');
    return { update: { disputes: [...disputes, { uid: caller.uid, name: me.name, note, at, resolved: false }], disputed: true }, reply: { ok: true } };
  });
  return stripBalances(result);
}

function stripBalances(result) {
  const { balances: _b, ...rest } = result;
  return rest;
}

function cleanPlaces(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || k.length > 128) continue;
    out[k] = Number.isInteger(v) ? v : Number(v);
  }
  return out;
}

// ---------- the 48 h expiry, run with settlement ----------

// Cancels every pending Battle past its 48 h and refunds the stakes. Returns how many it closed.
export async function sweepExpiredBattles({ now = new Date(), db = adminDb() } = {}) {
  const snap = await db.collection(COLLECTION).where('status', '==', 'pending').get();
  const due = [];
  snap.forEach((doc) => {
    if (isExpired(doc.data(), now.getTime())) due.push(doc.id);
  });
  let closed = 0;
  for (const id of due) {
    try {
      const at = Timestamp.fromDate(now);
      await db.runTransaction(async (tx) => {
        const { ref, battle, wallets } = await readBattle(tx, db, id);
        if (!isExpired(battle, now.getTime())) return;
        const book = moneyBook(tx, db, wallets, id, at);
        tx.update(ref, { ...expireUpdate(book, battle, battleLedgerIds(id), at), updatedAt: at });
        book.commit();
        closed += 1;
      });
    } catch (err) {
      console.error(`battle ${id} expiry failed:`, err.message);
    }
  }
  return closed;
}

// ---------- admin (preview with confirm: false, apply with confirm: true + expectedVersion) ----------

function adminEdit(caller, what, at) {
  return { by: caller.uid, byName: nameOf(caller.user, caller.uid), at, what: String(what).slice(0, 300) };
}

// Each player's change if every accepted player ends up credited `target[uid]` (since going live).
function moneyPlan(battle, wallets, target) {
  return battle.participants
    .filter((p) => p.status === 'accepted')
    .map((p) => {
      const from = Number(battle.credited?.[p.uid]) || 0;
      const to = target[p.uid] ?? 0;
      const before = wallets.get(p.uid)?.balanceCents ?? 0;
      return { uid: p.uid, name: p.name, fromCents: from, toCents: to, deltaCents: to - from, balanceBeforeCents: before, balanceAfterCents: before + (to - from) };
    });
}

async function adminBattle(caller, body, now, plan) {
  const battleId = battleIdFrom(body);
  const confirm = body.confirm === true;
  if (confirm && !Number.isInteger(body.expectedVersion)) throw new HttpError(400, 'MISSING_FIELD', 'Missing "expectedVersion" from the preview.');
  const db = adminDb();
  const at = Timestamp.fromDate(now);
  const ids = battleLedgerIds(battleId);
  return db.runTransaction(async (tx) => {
    const { ref, battle, wallets } = await readBattle(tx, db, battleId);
    const version = Number(battle.version) || 0;
    if (confirm && version !== body.expectedVersion) throw new HttpError(409, 'BATTLE_CHANGED', 'This Battle changed since you previewed it. Review it again.');
    const book = moneyBook(tx, db, wallets, battleId, at);
    const out = plan({ battle, wallets, book, ids, at, version });
    const summary = { battleId, version, title: battle.title, status: battle.status, describe: out.describe, toStatus: out.update.status ?? battle.status, players: out.players ?? [] };
    if (!confirm) return { preview: true, ...summary };
    const edits = [...(battle.edits ?? []), adminEdit(caller, out.describe, at)].slice(-MAX_EDITS);
    tx.update(ref, { ...out.update, edits, version: version + 1, updatedAt: at });
    book.commit();
    return { ok: true, ...summary, version: version + 1 };
  });
}

// { battleId, places, confirm?, expectedVersion? }: set or change the result (live or settled).
export async function adminSetBattleResult(body, caller, { now = new Date() } = {}) {
  return adminBattle(caller, body, now, ({ battle, wallets, book, ids, at, version }) => {
    if (battle.status !== 'live' && battle.status !== 'settled') throw new HttpError(409, 'NOT_LIVE', 'A result can be set once the Battle is live.');
    const places = cleanPlaces(body.places);
    const problems = resultProblems(battle, places);
    if (problems.length) throw new HttpError(400, 'BAD_RESULT', problems[0], { problems });
    const { byUid } = computeBattlePayouts(battle, battle.potCents, places);
    const players = moneyPlan(battle, wallets, byUid);
    const first = battle.status === 'live';
    for (const p of players) {
      if (!p.deltaCents) continue;
      book.add(p.uid, first
        ? { id: ids.payout(p.uid), type: 'battle_payout', amountCents: p.deltaCents, note: `Battle "${battle.title}": winnings (result by the admin)`, by: caller.uid }
        : { id: ids.regrade(p.uid, version + 1), type: 'admin_regrade', amountCents: p.deltaCents, note: `Battle "${battle.title}": result changed by the admin`, by: caller.uid });
    }
    const credited = Object.fromEntries(players.map((p) => [p.uid, p.toCents]));
    const resolvedDisputes = (battle.disputes ?? []).map((d) => ({ ...d, resolved: true }));
    return {
      describe: first ? 'Result entered by the admin' : 'Result changed by the admin',
      players,
      update: { status: 'settled', result: { places, enteredBy: caller.uid, enteredAt: at, by: 'admin' }, resultAt: battle.resultAt ?? at, credited, disputes: resolvedDisputes, disputed: false },
    };
  });
}

// { battleId, payoutBps, confirm?, expectedVersion? }: change the payout structure.
//   pending: players who already accepted get a notice and may withdraw for a full refund
//   live:    just changes it
//   settled: recomputes everyone's payout from the same places; only the differences move
export async function adminSetBattlePayout(body, caller, { now = new Date() } = {}) {
  return adminBattle(caller, body, now, ({ battle, wallets, book, ids, version }) => {
    if (!['pending', 'live', 'settled'].includes(battle.status)) throw new HttpError(409, 'BATTLE_CLOSED', 'This Battle is closed.');
    const payoutBps = body.payoutBps;
    const problems = payoutProblems(payoutBps, placeUnits(battle).length, battle.format);
    if (problems.length) throw new HttpError(400, 'BAD_PAYOUT', problems[0], { problems });
    const describe = `Payout changed: ${(battle.payoutBps ?? []).map((b) => b / 100).join('/')}% → ${payoutBps.map((b) => b / 100).join('/')}%`;
    if (battle.status === 'pending') {
      const participants = battle.participants.map((p) => (p.status === 'accepted' ? { ...p, notice: 'payoutChanged' } : p));
      return { describe, players: [], update: { payoutBps, participants } };
    }
    if (battle.status === 'live') return { describe, players: [], update: { payoutBps } };
    const { byUid } = computeBattlePayouts({ ...battle, payoutBps }, battle.potCents, battle.result.places);
    const players = moneyPlan(battle, wallets, byUid);
    for (const p of players) {
      if (p.deltaCents) book.add(p.uid, { id: ids.regrade(p.uid, version + 1), type: 'admin_regrade', amountCents: p.deltaCents, note: `Battle "${battle.title}": payout changed by the admin`, by: caller.uid });
    }
    return { describe, players, update: { payoutBps, credited: Object.fromEntries(players.map((p) => [p.uid, p.toCents])) } };
  });
}

// { battleId, confirm?, expectedVersion? }: void the Battle; everyone ends up with exactly their stake back.
export async function adminVoidBattle(body, caller, { now = new Date() } = {}) {
  return adminBattle(caller, body, now, ({ battle, wallets, book, ids, at, version }) => {
    if (battle.status === 'void') throw new HttpError(409, 'ALREADY_VOID', 'This Battle is already void.');
    if (battle.status === 'cancelled') throw new HttpError(409, 'BATTLE_CLOSED', 'This Battle was cancelled and every stake was refunded.');
    const target = Object.fromEntries(battle.participants.filter((p) => p.status === 'accepted').map((p) => [p.uid, battle.stakeCents]));
    let players;
    if (battle.status === 'settled') {
      players = moneyPlan(battle, wallets, target);
      for (const p of players) {
        if (p.deltaCents) book.add(p.uid, { id: ids.regrade(p.uid, version + 1), type: 'admin_regrade', amountCents: p.deltaCents, note: `Battle "${battle.title}" voided by the admin: stake back`, by: caller.uid });
      }
    } else {
      // Nothing paid out yet: a plain refund of each stake held.
      players = moneyPlan({ ...battle, credited: {} }, wallets, target);
      for (const p of battle.participants) {
        if (p.status === 'accepted') book.add(p.uid, { id: ids.refund(p.uid, p.stakeSeq), type: 'battle_refund', amountCents: battle.stakeCents, note: `Battle "${battle.title}" voided by the admin: stake back`, by: caller.uid });
      }
    }
    const participants = battle.status === 'pending' ? battle.participants.map((p) => (p.status === 'accepted' ? { ...p, status: 'refunded', notice: null } : p)) : battle.participants;
    return {
      describe: 'Voided by the admin (every stake back)',
      players,
      update: { status: 'void', voidedAt: at, credited: target, participants, disputes: (battle.disputes ?? []).map((d) => ({ ...d, resolved: true })), disputed: false },
    };
  });
}
