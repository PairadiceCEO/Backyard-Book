// Final scores and statuses for the games behind pending bet legs.
//
// ESPN games are found strictly by their ESPN event id, never by team names, so back-to-back games
// between the same teams can't be confused. For each game we read the scoreboard for its Central Time
// date; if the id isn't there (ESPN may date a late game differently) we read the day before and after;
// if it's still missing, the single-game summary endpoint is the last resort. Each scoreboard is fetched
// once per run and reused for every game on it. Custom games come from their customGames doc; Challenges
// from their challenges doc (settled = the admin's winning outcome, void = every leg void).

import { adminDb } from './firebaseAdmin.js';
import { getLeague } from './leagues.js';
import { normalizeCustomGame } from './board.js';
import { fetchEspnScoreboard, fetchEspnSummaryEvent, normalizeEspnEvent } from './sources/espn.js';
import { centralYmd } from '../shared/time.js';
import { resultFromCustomGame, resultFromEspnGame } from './grading.js';
import { resultFromChallenge } from './challenges.js';
import { CHALLENGE_PREFIX } from '../shared/challenges.js';

export function gameKey(leg) {
  return `${leg.league}|${leg.gameId}`;
}

function startMs(leg) {
  const value = leg.startTime?.toDate ? leg.startTime.toDate() : new Date(leg.startTime);
  const ms = value.getTime();
  return Number.isFinite(ms) ? ms : null;
}

// legs: every pending leg that needs a result. Returns Map(gameKey → result).
// overrides: optional Map(gameKey → result) used instead of looking those games up (admin previews).
export async function loadGameResults(legs, { now = new Date(), fetchImpl = fetch, db = adminDb(), overrides = null } = {}) {
  const games = new Map();
  const results = new Map();
  for (const leg of legs) {
    const key = gameKey(leg);
    if (overrides?.has(key)) {
      results.set(key, overrides.get(key));
      continue;
    }
    if (!games.has(key)) games.set(key, { league: leg.league, gameId: String(leg.gameId), start: startMs(leg) });
  }

  const scoreboards = new Map(); // `${league}|${yyyymmdd}` → Promise<Map(eventId → raw event) | null>

  const scoreboard = (league, ymd) => {
    const cacheKey = `${league.id}|${ymd}`;
    if (!scoreboards.has(cacheKey)) {
      scoreboards.set(
        cacheKey,
        fetchEspnScoreboard(league.espnPath, { ...league.espnParams, dates: ymd }, fetchImpl)
          .then((data) => new Map((data.events ?? []).map((e) => [String(e.id), e])))
          .catch((err) => {
            console.error(`settlement: ESPN ${league.id} dates=${ymd} failed:`, err.message);
            return null;
          }),
      );
    }
    return scoreboards.get(cacheKey);
  };

  const work = [];
  for (const [key, g] of games) {
    // Challenges: straight from Firestore.
    if (g.gameId.startsWith(CHALLENGE_PREFIX)) {
      const docId = g.gameId.slice(CHALLENGE_PREFIX.length);
      work.push(
        db
          .collection('challenges')
          .doc(docId)
          .get()
          .then((snap) => results.set(key, resultFromChallenge(snap.exists ? snap.data() : null)))
          .catch((err) => {
            results.set(key, resultFromChallenge(null));
            console.error(`settlement: Challenge ${g.gameId} failed:`, err.message);
          }),
      );
      continue;
    }
    // Custom games: straight from Firestore.
    if (g.gameId.startsWith('custom:')) {
      const docId = g.gameId.slice('custom:'.length);
      work.push(
        db
          .collection('customGames')
          .doc(docId)
          .get()
          .then((snap) => {
            const game = snap.exists ? normalizeCustomGame(docId, snap.data(), now) : null;
            results.set(key, resultFromCustomGame(game));
          })
          .catch((err) => {
            results.set(key, resultFromCustomGame(null));
            console.error(`settlement: custom game ${g.gameId} failed:`, err.message);
          }),
      );
      continue;
    }

    const league = getLeague(g.league);
    if (!league) {
      results.set(key, resultFromEspnGame(null));
      continue;
    }
    if (g.start !== null && g.start > now.getTime()) {
      results.set(key, { ...resultFromEspnGame(null), reason: 'Not started yet.' });
      continue;
    }

    work.push(
      (async () => {
        const base = new Date(g.start ?? now.getTime());
        const days = [centralYmd(0, base), centralYmd(-1, base), centralYmd(1, base)];
        let raw = null;
        let anyAnswered = false;
        for (const ymd of days) {
          const events = await scoreboard(league, ymd);
          if (events) anyAnswered = true;
          raw = events?.get(g.gameId) ?? null;
          if (raw) break;
        }
        if (!raw) {
          raw = await fetchEspnSummaryEvent(league.espnPath, g.gameId, fetchImpl).catch((err) => {
            console.error(`settlement: ESPN summary ${g.gameId} failed:`, err.message);
            return null;
          });
        }
        if (!raw) {
          results.set(key, {
            ...resultFromEspnGame(null),
            reason: anyAnswered ? 'Game id not found on ESPN for its date (±1 day).' : "ESPN didn't answer.",
          });
          return;
        }
        results.set(key, resultFromEspnGame(normalizeEspnEvent(raw, league.id)));
      })(),
    );
  }

  await Promise.all(work);
  return results;
}
