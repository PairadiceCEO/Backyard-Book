// Challenges: player-posted public lines. A player posts one (pending: everyone sees it, nobody can bet);
// the admin approves it (optionally editing the wording and odds), rejects it with a note, edits its odds
// later, and finally settles it by picking the winning outcome, or voids it. Settling runs the normal
// settlement for its bets, which count toward win rate like any sportsbook bet.
//
// challenges/{id}: see PROGRESS.md (Phase C). Every admin change is appended to `edits` (who, what, when).
// Bets keep the odds they were placed at (stored on each leg); edits only affect new bets.

import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from './firebaseAdmin.js';
import { HttpError } from './http.js';
import { isValidRequestId } from '../shared/betRules.js';
import { centralWallTimeToDate } from '../shared/time.js';
import {
  CHALLENGE_LEAGUE,
  CHALLENGE_PREFIX,
  OUTCOME_IDS,
  REJECT_NOTE_MAX,
  challengeProblems,
  cleanAmerican,
  outcomeLabel,
} from '../shared/challenges.js';

const COLLECTION = 'challenges';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const MAX_EDITS = 100;

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

function idFrom(body) {
  const id = String(body.challengeId ?? '').replace(new RegExp(`^${CHALLENGE_PREFIX}`), '');
  if (!ID_PATTERN.test(id)) throw new HttpError(400, 'BAD_CHALLENGE', 'Missing Challenge id.');
  return id;
}

function americanText(n) {
  return n > 0 ? `+${n}` : String(n);
}

// { title, description, outcomes: [{ label, american }], closeDate, closeClock } → clean values or 400.
function parseChallenge(body, nowMs) {
  const close = centralWallTimeToDate(body.closeDate, body.closeClock);
  const input = {
    title: String(body.title ?? '').trim(),
    description: String(body.description ?? '').trim(),
    outcomes: Array.isArray(body.outcomes) ? body.outcomes : [],
    closeMs: close ? close.getTime() : NaN,
  };
  const problems = challengeProblems(input, nowMs);
  if (problems.length) throw new HttpError(400, 'BAD_CHALLENGE', problems[0], { problems });
  return {
    title: input.title,
    description: input.description,
    outcomes: input.outcomes.map((o, i) => ({ id: OUTCOME_IDS[i], label: String(o.label).trim(), american: cleanAmerican(o.american) })),
    closeTime: Timestamp.fromMillis(input.closeMs),
  };
}

// postChallenge { clientRequestId, title, description, outcomes, closeDate, closeClock }
export async function postChallenge(caller, body, { now = new Date() } = {}) {
  if (!isValidRequestId(body.clientRequestId)) throw new HttpError(400, 'BAD_REQUEST_ID', 'Missing or invalid clientRequestId.');
  const clean = parseChallenge(body, now.getTime());
  const db = adminDb();
  const id = `${caller.uid}_${body.clientRequestId}`;
  const ref = db.collection(COLLECTION).doc(id);
  const at = Timestamp.fromDate(now);
  const duplicate = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return true;
    tx.create(ref, {
      ...clean,
      posterUid: caller.uid,
      posterName: nameOf(caller.user, caller.uid),
      status: 'pending',
      winner: null,
      rejectNote: null,
      approvedAt: null,
      approvedBy: null,
      settledAt: null,
      settledBy: null,
      betCount: 0,
      posterBets: [],
      edits: [],
      createdAt: at,
      updatedAt: at,
      version: 0,
      requestId: body.clientRequestId,
    });
    return false;
  });
  return { ok: true, challengeId: id, duplicate };
}

// ---------- admin ----------

function edit(caller, what, at) {
  return { by: caller.uid, byName: nameOf(caller.user, caller.uid), at, what: String(what).slice(0, 400) };
}

// What changed between two versions, in words ("Yes +150 → +140; closes Oct 20 7:00 PM → Oct 20 9:00 PM").
function describeChanges(before, after) {
  const parts = [];
  if (after.title !== undefined && after.title !== before.title) parts.push(`title "${before.title}" → "${after.title}"`);
  if (after.description !== undefined && after.description !== before.description) parts.push('description edited');
  if (after.outcomes) {
    const was = new Map((before.outcomes ?? []).map((o) => [o.id, o]));
    for (const o of after.outcomes) {
      const old = was.get(o.id);
      if (!old) parts.push(`added "${o.label}" ${americanText(o.american)}`);
      else {
        if (old.label !== o.label) parts.push(`"${old.label}" renamed "${o.label}"`);
        if (old.american !== o.american) parts.push(`${o.label} ${americanText(old.american)} → ${americanText(o.american)}`);
      }
    }
    for (const old of before.outcomes ?? []) if (!after.outcomes.some((o) => o.id === old.id)) parts.push(`removed "${old.label}"`);
  }
  if (after.closeTime && toMs(after.closeTime) !== toMs(before.closeTime)) {
    const fmt = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    parts.push(`closes ${fmt(toMs(before.closeTime))} → ${fmt(toMs(after.closeTime))}`);
  }
  return parts.join('; ');
}

// The fields an admin edit may change. Pending: wording, odds and close time. Open: odds and close time only
// (the wording is what people bet on, so it's fixed once betting has opened).
function parseEdit(body, challenge, nowMs) {
  const pending = challenge.status === 'pending';
  const out = {};
  if (body.outcomes !== undefined) {
    if (!Array.isArray(body.outcomes) || body.outcomes.length !== challenge.outcomes.length) {
      if (!pending) throw new HttpError(400, 'BAD_CHALLENGE', "Outcomes can't be added or removed once betting has opened.");
    }
  }
  if (pending) {
    const merged = {
      title: body.title !== undefined ? body.title : challenge.title,
      description: body.description !== undefined ? body.description : challenge.description,
      outcomes: body.outcomes !== undefined ? body.outcomes : challenge.outcomes,
      closeDate: body.closeDate,
      closeClock: body.closeClock,
    };
    if (body.closeDate === undefined && body.closeClock === undefined) {
      // Keep the close time: validate it as it stands.
      const ms = toMs(challenge.closeTime);
      const d = new Date(ms);
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((p) => [p.type, p.value]));
      merged.closeDate = `${parts.year}-${parts.month}-${parts.day}`;
      merged.closeClock = `${parts.hour}:${parts.minute}`;
    }
    return parseChallenge(merged, nowMs);
  }
  if (body.title !== undefined && String(body.title).trim() !== challenge.title) throw new HttpError(409, 'WORDING_FIXED', "The wording can't change once betting has opened. Edit the odds or close time, or void it.");
  if (body.description !== undefined && String(body.description).trim() !== challenge.description) throw new HttpError(409, 'WORDING_FIXED', "The wording can't change once betting has opened.");
  if (body.outcomes !== undefined) {
    out.outcomes = challenge.outcomes.map((o, i) => {
      const raw = body.outcomes[i] ?? {};
      if (raw.label !== undefined && String(raw.label).trim() !== o.label) throw new HttpError(409, 'WORDING_FIXED', "Outcome names can't change once betting has opened.");
      const american = cleanAmerican(raw.american ?? o.american);
      if (american === null) throw new HttpError(400, 'BAD_CHALLENGE', `${o.label}: enter American odds like +150 or -180.`);
      return { ...o, american };
    });
  }
  if (body.closeDate !== undefined || body.closeClock !== undefined) {
    const close = centralWallTimeToDate(body.closeDate, body.closeClock);
    if (!close) throw new HttpError(400, 'BAD_CHALLENGE', 'Enter a valid close date and time (Central Time).');
    out.closeTime = Timestamp.fromDate(close);
  }
  return out;
}

async function adminTx(body, caller, now, fn) {
  const id = idFrom(body);
  const db = adminDb();
  const ref = db.collection(COLLECTION).doc(id);
  const at = Timestamp.fromDate(now);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError(404, 'CHALLENGE_NOT_FOUND', 'That Challenge does not exist.');
    const challenge = snap.data();
    const { update, what, reply } = fn(challenge, at);
    const edits = [...(challenge.edits ?? []), edit(caller, what, at)].slice(-MAX_EDITS);
    tx.update(ref, { ...update, edits, updatedAt: at, version: (Number(challenge.version) || 0) + 1 });
    return { ok: true, challengeId: id, ...(reply ?? {}) };
  });
}

// { challengeId, title?, description?, outcomes?, closeDate?, closeClock? }: approve (with any edits).
export async function approveChallenge(body, caller, { now = new Date() } = {}) {
  return adminTx(body, caller, now, (challenge, at) => {
    if (challenge.status !== 'pending') throw new HttpError(409, 'NOT_PENDING', 'Only a pending Challenge can be approved.');
    const changes = parseEdit(body, challenge, now.getTime());
    const changed = describeChanges(challenge, changes);
    return { update: { ...changes, status: 'open', approvedAt: at, approvedBy: caller.uid }, what: `Approved${changed ? ` with edits: ${changed}` : ''}` };
  });
}

// { challengeId, note }
export async function rejectChallenge(body, caller, { now = new Date() } = {}) {
  const note = String(body.note ?? '').trim();
  if (!note || note.length > REJECT_NOTE_MAX) throw new HttpError(400, 'BAD_NOTE', `Say why it's rejected (1–${REJECT_NOTE_MAX} characters).`);
  return adminTx(body, caller, now, (challenge) => {
    if (challenge.status !== 'pending') throw new HttpError(409, 'NOT_PENDING', 'Only a pending Challenge can be rejected.');
    return { update: { status: 'rejected', rejectNote: note }, what: `Rejected: ${note}` };
  });
}

// { challengeId, …fields }: edit a pending Challenge (anything) or an open one (odds, close time).
export async function editChallenge(body, caller, { now = new Date() } = {}) {
  return adminTx(body, caller, now, (challenge) => {
    if (challenge.status !== 'pending' && challenge.status !== 'open') throw new HttpError(409, 'CHALLENGE_CLOSED', 'This Challenge is finished.');
    const changes = parseEdit(body, challenge, now.getTime());
    const changed = describeChanges(challenge, changes);
    if (!changed) throw new HttpError(400, 'NO_CHANGE', 'Nothing changed.');
    return { update: changes, what: `Edited: ${changed}` };
  });
}

// The settlement result for a Challenge doc (see gameResults / grading).
export function resultFromChallenge(challenge) {
  if (!challenge) return { status: 'pending', homeScore: null, awayScore: null, homeName: null, awayName: null, statusText: '', reason: 'Challenge not found.' };
  const base = { homeScore: null, awayScore: null, homeName: null, awayName: null };
  if (challenge.status === 'void') return { ...base, status: 'void', statusText: 'Void', reason: 'Challenge voided by the admin' };
  if (challenge.status === 'settled' && challenge.winner) {
    return { ...base, status: 'final', winner: challenge.winner, winnerLabel: outcomeLabel(challenge, challenge.winner), statusText: 'Settled', reason: '' };
  }
  return { ...base, status: 'pending', statusText: '', reason: 'Waiting for the admin to settle this Challenge.' };
}

// Settle or void: preview (confirm false: every bet and wallet change, nothing written) or apply.
async function closeOut(body, caller, kind, now) {
  const { settleOpenBets } = await import('./settlement.js');
  const id = idFrom(body);
  const gameId = `${CHALLENGE_PREFIX}${id}`;
  const db = adminDb();
  const snap = await db.collection(COLLECTION).doc(id).get();
  if (!snap.exists) throw new HttpError(404, 'CHALLENGE_NOT_FOUND', 'That Challenge does not exist.');
  const challenge = snap.data();
  if (challenge.status !== 'open' && !(kind === 'void' && challenge.status === 'pending')) {
    throw new HttpError(409, 'CHALLENGE_CLOSED', challenge.status === 'pending' ? 'Approve it before settling it.' : 'This Challenge is already finished.');
  }
  let winner = null;
  if (kind === 'settle') {
    winner = String(body.winner ?? '');
    if (!challenge.outcomes.some((o) => o.id === winner)) throw new HttpError(400, 'BAD_WINNER', 'Pick the winning outcome.');
  }
  const onThis = (bet) => bet.legs.some((leg) => String(leg.gameId) === gameId);
  const after = kind === 'settle' ? { ...challenge, status: 'settled', winner } : { ...challenge, status: 'void' };

  if (body.confirm !== true) {
    const preview = await settleOpenBets({
      trigger: 'admin',
      dryRun: true,
      now,
      betFilter: onThis,
      resultOverrides: new Map([[`${CHALLENGE_LEAGUE}|${gameId}`, resultFromChallenge(after)]]),
    });
    return {
      preview: true,
      challengeId: id,
      kind,
      winner,
      winnerLabel: winner ? outcomeLabel(challenge, winner) : null,
      title: challenge.title,
      wouldSettle: preview.wouldSettle,
      staysOpen: preview.staysOpen,
      totals: preview.totals,
      walletChanges: preview.walletChanges,
    };
  }

  await adminTx(body, caller, now, (current, at) => {
    if (current.status !== challenge.status) throw new HttpError(409, 'CHALLENGE_CHANGED', 'This Challenge changed since you previewed it. Review it again.');
    return kind === 'settle'
      ? { update: { status: 'settled', winner, settledAt: at, settledBy: caller.uid }, what: `Settled: "${outcomeLabel(challenge, winner)}" won` }
      : { update: { status: 'void', settledAt: at, settledBy: caller.uid }, what: 'Voided (every bet on it is void: stakes back)' };
  });
  const settlement = await settleOpenBets({ trigger: 'admin', force: true, now, betFilter: onThis });
  return { ok: true, challengeId: id, kind, winner, settlement };
}

// { challengeId, winner, confirm? }
export function settleChallenge(body, caller, { now = new Date() } = {}) {
  return closeOut(body, caller, 'settle', now);
}

// { challengeId, confirm? }
export function voidChallenge(body, caller, { now = new Date() } = {}) {
  return closeOut(body, caller, 'void', now);
}
