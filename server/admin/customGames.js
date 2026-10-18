// Admin custom ("house") games: create, edit, enter the final score, cancel, delete.
//
// customGames/{id}:
//   { league, home: { name, abbr, logoUrl }, away: { … }, startTime: Timestamp,
//     odds: { moneyline: { home, away }, spread: { homeLine, home, away }, total: { line, over, under } },
//     status: 'scheduled' | 'final' | 'canceled', finalScore: { home, away } | null,
//     betCount, createdAt, updatedAt, createdBy, edits: [{ by, byName, at, what }] }
// Every admin change is appended to `edits` (who, what, when) and shown on the game.
//
// Betting closes at startTime on the server clock (pricing reads the doc fresh at placement), so moving the
// start later reopens betting and moving it before now closes it at once. Bets keep the odds they were
// placed at; editing odds only affects new bets. Final score and cancel settle the game's bets right away,
// after a preview that shows every wallet change.

import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../firebaseAdmin.js';
import { HttpError } from '../http.js';
import { invalidateCache } from '../cache.js';
import { CUSTOM_BOARD_KEY } from '../board.js';
import { getLeague } from '../leagues.js';
import { normalizeCustomGame } from '../board.js';
import { resultFromCustomGame } from '../grading.js';
import { settleOpenBets } from '../settlement.js';
import { centralWallTimeToDate } from '../../shared/time.js';
import { parseAmerican } from '../../shared/oddsMath.js';

const NAME_MAX = 30;
const MAX_EDITS = 100;

function editEntry(caller, what) {
  return { by: caller?.uid ?? 'admin', byName: String(caller?.user?.displayName || caller?.user?.username || 'Admin').slice(0, 40), at: Timestamp.now(), what: String(what).slice(0, 400) };
}

const american = (n) => (n === null || n === undefined ? 'off' : n > 0 ? `+${n}` : String(n));
const lineText = (n) => (n === null || n === undefined ? 'off' : n > 0 ? `+${n}` : String(n));

// Every odds change in words: "Home ML -150 → -160; total 44.5 → 45.5".
export function describeOddsChange(before, after) {
  const b = before ?? {};
  const a = after ?? {};
  const parts = [];
  const cmp = (label, x, y, fmt = american) => {
    if ((x ?? null) !== (y ?? null)) parts.push(`${label} ${fmt(x)} → ${fmt(y)}`);
  };
  cmp('Home ML', b.moneyline?.home, a.moneyline?.home);
  cmp('Away ML', b.moneyline?.away, a.moneyline?.away);
  cmp('Spread (home line)', b.spread?.homeLine, a.spread?.homeLine, lineText);
  cmp('Home spread price', b.spread?.home, a.spread?.home);
  cmp('Away spread price', b.spread?.away, a.spread?.away);
  cmp('Total', b.total?.line, a.total?.line, (n) => (n === null || n === undefined ? 'off' : String(n)));
  cmp('Over price', b.total?.over, a.total?.over);
  cmp('Under price', b.total?.under, a.total?.under);
  return parts;
}
const ABBR_PATTERN = /^[A-Z0-9]{1,5}$/;
const MAX_SCORE = 999;

function bad(message) {
  return new HttpError(400, 'BAD_GAME', message);
}

function cleanTeam(raw, which) {
  const team = raw && typeof raw === 'object' ? raw : {};
  const name = String(team.name ?? '').trim();
  if (!name) throw bad(`Enter the ${which} team's name.`);
  if (name.length > NAME_MAX) throw bad(`The ${which} team's name must be ${NAME_MAX} characters or fewer.`);
  const abbr = String(team.abbr ?? '').trim().toUpperCase();
  if (!ABBR_PATTERN.test(abbr)) throw bad(`The ${which} team's abbreviation must be 1–5 letters or numbers.`);
  const logoUrl = String(team.logoUrl ?? '').trim();
  if (logoUrl) {
    let parsed = null;
    try {
      parsed = new URL(logoUrl);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== 'https:' || logoUrl.length > 500) throw bad(`The ${which} logo must be an https:// image link.`);
  }
  return { name, abbr, logoUrl: logoUrl || null };
}

// Blank → null. Otherwise a whole American price, +100 or more / −100 or less.
function price(value, label) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const text = String(value).trim();
  const parsed = /^[+-]?\d+$/.test(text) ? parseAmerican(text) : null;
  if (parsed === null || Math.abs(parsed) < 100) throw bad(`${label}: enter American odds like -110 or +150.`);
  return parsed;
}

// Blank → null. Otherwise a whole or half number.
function lineValue(value, label, { positive = false } = {}) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(String(value).trim());
  if (!Number.isFinite(n) || Math.round(n * 2) !== n * 2) throw bad(`${label}: use a whole or half number like -3.5 or 7.`);
  if (positive && n <= 0) throw bad(`${label} must be above 0.`);
  if (Math.abs(n) > 500) throw bad(`${label} is too large.`);
  return n;
}

// Any market left blank is not offered ("—" on the board).
export function cleanOdds(raw) {
  const odds = raw && typeof raw === 'object' ? raw : {};
  const ml = odds.moneyline ?? {};
  const sp = odds.spread ?? {};
  const tot = odds.total ?? {};

  const moneyline = { home: price(ml.home, 'Home moneyline'), away: price(ml.away, 'Away moneyline') };

  const homeLine = lineValue(sp.homeLine, 'Spread line');
  const spread = { homeLine, home: price(sp.home, 'Home spread price'), away: price(sp.away, 'Away spread price') };
  if (homeLine === null && (spread.home !== null || spread.away !== null)) throw bad('Spread: enter the home line too, or clear the spread prices.');
  if (homeLine !== null && spread.home === null && spread.away === null) throw bad('Spread: enter at least one price, or clear the line.');

  const line = lineValue(tot.line, 'Total line', { positive: true });
  const total = { line, over: price(tot.over, 'Over price'), under: price(tot.under, 'Under price') };
  if (line === null && (total.over !== null || total.under !== null)) throw bad('Total: enter the line too, or clear the over/under prices.');
  if (line !== null && total.over === null && total.under === null) throw bad('Total: enter at least one price, or clear the line.');

  return { moneyline, spread, total };
}

function cleanStart(body) {
  const start = centralWallTimeToDate(body.startDate, body.startClock);
  if (!start) throw bad('Enter a valid start date and time (Central Time).');
  return start;
}

function cleanLeague(value) {
  const league = String(value ?? '').toLowerCase();
  if (!getLeague(league)) throw bad('Pick a league.');
  return league;
}

function gameIdFrom(body) {
  const raw = String(body.gameId ?? '').trim().replace(/^custom:/, '');
  if (!raw || raw.length > 100 || raw.includes('/')) throw new HttpError(400, 'MISSING_FIELD', 'Missing "gameId".');
  return raw;
}

async function loadGame(db, docId) {
  const snap = await db.collection('customGames').doc(docId).get();
  if (!snap.exists) throw new HttpError(404, 'GAME_NOT_FOUND', 'That custom game does not exist.');
  return snap.data();
}

function requireScheduled(game) {
  if (game.status === 'final') throw new HttpError(409, 'GAME_FINISHED', 'This game already has a final score.');
  if (game.status === 'canceled') throw new HttpError(409, 'GAME_FINISHED', 'This game was canceled.');
}

export async function createCustomGame(body, caller) {
  const league = cleanLeague(body.league);
  const home = cleanTeam(body.home, 'home');
  const away = cleanTeam(body.away, 'away');
  const startTime = cleanStart(body);
  const odds = cleanOdds(body.odds);
  const now = Timestamp.now();

  const ref = adminDb().collection('customGames').doc();
  await ref.set({
    league,
    home,
    away,
    startTime: Timestamp.fromDate(startTime),
    odds,
    status: 'scheduled',
    finalScore: null,
    betCount: 0,
    createdAt: now,
    updatedAt: now,
    createdBy: caller.uid,
    edits: [editEntry(caller, 'Created')],
  });
  await invalidateCache(CUSTOM_BOARD_KEY);
  return { ok: true, gameId: `custom:${ref.id}` };
}

// Edits anything on a game that hasn't finished. League can only change while it has no bets.
// Bets already placed keep their odds; the change is logged on the game.
export async function updateCustomGame(body, caller) {
  const docId = gameIdFrom(body);
  const db = adminDb();
  const ref = db.collection('customGames').doc(docId);
  const fields = {
    home: cleanTeam(body.home, 'home'),
    away: cleanTeam(body.away, 'away'),
    startTime: Timestamp.fromDate(cleanStart(body)),
    odds: cleanOdds(body.odds),
  };
  const league = cleanLeague(body.league);

  const before = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError(404, 'GAME_NOT_FOUND', 'That custom game does not exist.');
    const game = snap.data();
    requireScheduled(game);
    if (league !== game.league && (Number(game.betCount) || 0) > 0) {
      throw new HttpError(409, 'HAS_BETS', "Bets were placed on this game, so its league can't change.");
    }
    const changes = describeOddsChange(game.odds, fields.odds);
    const startBefore = game.startTime?.toMillis ? game.startTime.toMillis() : new Date(game.startTime).getTime();
    if (startBefore !== fields.startTime.toMillis()) {
      const fmt = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      changes.push(`start ${fmt(startBefore)} → ${fmt(fields.startTime.toMillis())}`);
    }
    if (game.home?.name !== fields.home.name || game.away?.name !== fields.away.name) changes.push(`teams ${game.away?.name} @ ${game.home?.name} → ${fields.away.name} @ ${fields.home.name}`);
    if (league !== game.league) changes.push(`league ${game.league} → ${league}`);
    const edits = changes.length ? [...(game.edits ?? []), editEntry(caller, `Edited: ${changes.join('; ')}`)].slice(-MAX_EDITS) : game.edits ?? [];
    tx.update(ref, { ...fields, league, edits, updatedAt: Timestamp.now() });
    return game;
  });

  await invalidateCache(CUSTOM_BOARD_KEY);
  const nowMs = Date.now();
  return { ok: true, gameId: `custom:${docId}`, bettingOpen: fields.startTime.toMillis() > nowMs };
}

function cleanScores(body) {
  const home = Number(body.homeScore);
  const away = Number(body.awayScore);
  for (const [n, which] of [[home, 'home'], [away, 'away']]) {
    if (!Number.isInteger(n) || n < 0 || n > MAX_SCORE) throw bad(`Enter the ${which} score as a whole number from 0 to ${MAX_SCORE}.`);
  }
  return { home, away };
}

// Shared by final score and cancel: preview (confirm false) or save + settle (confirm true).
async function closeOut(body, caller, kind) {
  const docId = gameIdFrom(body);
  const gameId = `custom:${docId}`;
  const db = adminDb();
  const game = await loadGame(db, docId);
  requireScheduled(game);
  const scores = kind === 'final' ? cleanScores(body) : null;
  const onThisGame = (bet) => bet.legs.some((leg) => String(leg.gameId) === gameId);

  if (body.confirm !== true) {
    const doc = kind === 'final' ? { ...game, status: 'final', finalScore: scores } : { ...game, status: 'canceled' };
    const result = resultFromCustomGame(normalizeCustomGame(docId, doc, new Date()));
    const preview = await settleOpenBets({
      trigger: 'admin',
      dryRun: true,
      betFilter: onThisGame,
      resultOverrides: new Map([[`${game.league}|${gameId}`, result]]),
    });
    return {
      preview: true,
      gameId,
      kind,
      scores,
      label: `${game.away.name} @ ${game.home.name}`,
      wouldSettle: preview.wouldSettle,
      staysOpen: preview.staysOpen,
      totals: preview.totals,
      walletChanges: preview.walletChanges,
    };
  }

  const ref = db.collection('customGames').doc(docId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError(404, 'GAME_NOT_FOUND', 'That custom game does not exist.');
    requireScheduled(snap.data());
    const now = Timestamp.now();
    const what = kind === 'final' ? `Final score: ${game.away.name} ${scores.away} @ ${game.home.name} ${scores.home}` : 'Canceled (every bet on it is void)';
    const edits = [...(snap.data().edits ?? []), editEntry(caller, what)].slice(-MAX_EDITS);
    tx.update(
      ref,
      kind === 'final'
        ? { status: 'final', finalScore: scores, finishedAt: now, finishedBy: caller.uid, updatedAt: now, edits }
        : { status: 'canceled', finalScore: null, finishedAt: now, finishedBy: caller.uid, updatedAt: now, edits },
    );
  });
  await invalidateCache(CUSTOM_BOARD_KEY);

  const settlement = await settleOpenBets({ trigger: 'admin', force: true, betFilter: onThisGame });
  return { ok: true, gameId, kind, scores, settlement };
}

// { gameId, homeScore, awayScore, confirm? }
export function finalizeCustomGame(body, caller) {
  return closeOut(body, caller, 'final');
}

// { gameId, confirm? } — voids every leg on the game, like a postponed real game.
export function cancelCustomGame(body, caller) {
  return closeOut(body, caller, 'cancel');
}

// Only a game nobody ever bet on can be deleted.
export async function deleteCustomGame(body) {
  const docId = gameIdFrom(body);
  const db = adminDb();
  const ref = db.collection('customGames').doc(docId);
  const league = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError(404, 'GAME_NOT_FOUND', 'That custom game does not exist.');
    const game = snap.data();
    if ((Number(game.betCount) || 0) > 0) {
      throw new HttpError(409, 'HAS_BETS', `${game.betCount} bet${game.betCount === 1 ? ' was' : 's were'} placed on this game, so it can't be deleted. Cancel it instead.`);
    }
    tx.delete(ref);
    return game.league;
  });
  await invalidateCache(CUSTOM_BOARD_KEY);
  return { ok: true, gameId: `custom:${docId}` };
}
