// Battles: players put in the same stake and the pot is paid out by finishing place.
// Pure rules shared by the server (authoritative) and the phone (previews). No Firestore, no clock.
//
// Formats
//   ffa    free-for-all: 2–8 players (the creator + 1–7 invited), places are per player
//   teams  2–4 teams of 2–4 players, 8 players at most; places are per team, a team's share is split
//          evenly among its members
// Payout structure: basis points by place (10000 = 100%), adding up to exactly 10000, with at most one
// paid place fewer than there are players (ffa) or teams (teams).
// Ties: the result gives each player (or team) a place number; equal numbers tie. Sorted by number, a tied
// group of k covers the next k positions and splits the shares of those positions evenly.
// Money: every share rounds down to the cent; the cents left over go to the highest-placed winner, so the
// whole pot is always paid out.

import { MAX_WALLET_CHANGE_CENTS } from './constants.js';
import { BET_CEILING_MESSAGE } from './casino/constants.js';

export const BATTLE_FORMATS = ['ffa', 'teams'];
export const FFA_MIN_PLAYERS = 2;
export const BATTLE_MAX_PLAYERS = 8;
export const TEAMS_MIN = 2;
export const TEAMS_MAX = 4;
export const TEAM_SIZE_MIN = 2;
export const TEAM_SIZE_MAX = 4;
// Stake: whole dollars, at least $1; no maximum (0.16.0) beyond the wallet and the $1,000,000 per-stake sanity ceiling.
export const BATTLE_STAKE_MIN_DOLLARS = 1;
export const BATTLE_STAKE_RULE = 'The stake is whole dollars, at least $1.';
export const BATTLE_TITLE_MAX = 80;
export const BATTLE_DESCRIPTION_MAX = 500;
export const TEAM_NAME_MAX = 24;
export const DISPUTE_NOTE_MAX = 300;
export const FULL_BPS = 10000;
export const BATTLE_EXPIRY_MS = 48 * 60 * 60 * 1000; // invites must all be accepted within 48 h
export const DISPUTE_WINDOW_MS = 48 * 60 * 60 * 1000; // disputes within 48 h of the result

export const BATTLE_STATUS_LABELS = {
  pending: 'Waiting for players',
  live: 'Live',
  settled: 'Paid out',
  cancelled: 'Cancelled',
  void: 'Void',
};

export const FORMAT_LABELS = { ffa: 'Free-for-all', teams: 'Teams' };

// "1st", "2nd", "3rd", "4th", "11th", "21st".
export function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

// "70%" or "33.33%".
export function bpsText(bps) {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0$/, '')}%`;
}

// Percent text from the form ("70", "33.33") → basis points, or null if it isn't 0.01–100 with ≤ 2 decimals.
export function percentToBps(text) {
  const s = String(text ?? '').trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  const bps = Math.round(Number(s) * 100);
  return bps > 0 && bps <= FULL_BPS ? bps : null;
}

// The units that get places: players (ffa) or teams (teams).
export function placeUnits(battle) {
  if (battle.format === 'teams') return (battle.teams ?? []).map((t) => t.id);
  return (battle.participants ?? []).map((p) => p.uid);
}

export function teamMembers(battle, teamId) {
  return (battle.participants ?? []).filter((p) => p.team === teamId);
}

// Checks a new Battle. input: { title, description, format, stakeDollars, payoutBps: [..], teams: [{ id,
// name }], players: [{ uid, team }] } — players includes the creator. Returns a list of problems ([] = ok).
export function battleProblems(input, creatorUid) {
  const problems = [];
  const title = String(input?.title ?? '').trim();
  const description = String(input?.description ?? '').trim();
  if (!title) problems.push('Give the Battle a title.');
  if (title.length > BATTLE_TITLE_MAX) problems.push(`The title can be up to ${BATTLE_TITLE_MAX} characters.`);
  if (description.length > BATTLE_DESCRIPTION_MAX) problems.push(`The description can be up to ${BATTLE_DESCRIPTION_MAX} characters.`);

  const format = input?.format;
  if (!BATTLE_FORMATS.includes(format)) {
    problems.push('Pick free-for-all or teams.');
    return problems;
  }

  const stake = input?.stakeDollars;
  if (typeof stake !== 'number' || !Number.isInteger(stake) || stake < BATTLE_STAKE_MIN_DOLLARS) {
    problems.push(BATTLE_STAKE_RULE);
  } else if (!Number.isSafeInteger(stake) || stake * 100 > MAX_WALLET_CHANGE_CENTS) {
    problems.push(BET_CEILING_MESSAGE);
  }

  const players = Array.isArray(input?.players) ? input.players : [];
  const uids = players.map((p) => p?.uid);
  if (uids.some((u) => typeof u !== 'string' || !u || u.length > 128)) problems.push('A player is missing.');
  if (new Set(uids).size !== uids.length) problems.push('Each player can only be in a Battle once.');
  if (!uids.includes(creatorUid)) problems.push('You have to be in your own Battle.');

  let units = 0;
  if (format === 'ffa') {
    if (players.length < FFA_MIN_PLAYERS || players.length > BATTLE_MAX_PLAYERS) {
      problems.push(`Free-for-all is you plus 1–${BATTLE_MAX_PLAYERS - 1} invited players.`);
    }
    units = players.length;
  } else {
    const teams = Array.isArray(input?.teams) ? input.teams : [];
    if (teams.length < TEAMS_MIN || teams.length > TEAMS_MAX) problems.push(`Teams Battles have ${TEAMS_MIN}–${TEAMS_MAX} teams.`);
    const ids = teams.map((t) => t?.id);
    if (ids.some((id) => typeof id !== 'string' || !/^t[1-4]$/.test(id)) || new Set(ids).size !== ids.length) problems.push('Teams are badly formed.');
    for (const t of teams) {
      const name = String(t?.name ?? '').trim();
      if (!name || name.length > TEAM_NAME_MAX) problems.push(`Team names are 1–${TEAM_NAME_MAX} characters.`);
    }
    if (players.length > BATTLE_MAX_PLAYERS) problems.push(`Teams Battles have at most ${BATTLE_MAX_PLAYERS} players.`);
    if (players.some((p) => !ids.includes(p?.team))) problems.push('Put every player, you included, on a team.');
    for (const t of teams) {
      const size = players.filter((p) => p?.team === t?.id).length;
      if (size < TEAM_SIZE_MIN || size > TEAM_SIZE_MAX) {
        problems.push(`${String(t?.name ?? 'A team').trim() || 'A team'} needs ${TEAM_SIZE_MIN}–${TEAM_SIZE_MAX} players.`);
      }
    }
    units = teams.length;
  }

  problems.push(...payoutProblems(input?.payoutBps, units, format));
  return [...new Set(problems)];
}

// Checks a payout structure for a Battle with `units` players (ffa) or teams.
export function payoutProblems(payoutBps, units, format = 'ffa') {
  const problems = [];
  const list = Array.isArray(payoutBps) ? payoutBps : [];
  const maxPlaces = Math.max(1, units - 1);
  const who = format === 'teams' ? 'teams' : 'players';
  if (list.length < 1) problems.push('Add at least one paid place.');
  if (list.length > maxPlaces) problems.push(`With ${units} ${who}, pay at most ${maxPlaces} place${maxPlaces === 1 ? '' : 's'}.`);
  if (list.some((b) => !Number.isInteger(b) || b <= 0 || b > FULL_BPS)) problems.push('Each paid place needs a share between 0.01% and 100%.');
  const total = list.reduce((s, b) => s + (Number.isInteger(b) ? b : 0), 0);
  if (list.length && total !== FULL_BPS) problems.push(`The shares add up to ${bpsText(total)}; they must add up to exactly 100%.`);
  return problems;
}

// Checks a result: { places: { [uid or teamId]: placeNumber } } for every unit, numbers 1..units.
export function resultProblems(battle, places) {
  const units = placeUnits(battle);
  const problems = [];
  if (!places || typeof places !== 'object') return ['Give every player a place.'];
  for (const unit of units) {
    const p = places[unit];
    if (!Number.isInteger(p) || p < 1 || p > units.length) {
      problems.push(battle.format === 'teams' ? 'Give every team a place.' : 'Give every player a place.');
      break;
    }
  }
  if (Object.keys(places).some((k) => !units.includes(k))) problems.push('The result names someone who isn’t in this Battle.');
  return problems;
}

// Groups units by place: [{ place, units: [...], start (0-based position), positions: k }], best first.
export function placeGroups(units, places) {
  const order = units.map((u, i) => ({ u, i, p: places[u] })).sort((a, b) => a.p - b.p || a.i - b.i);
  const groups = [];
  let position = 0;
  for (const entry of order) {
    const last = groups[groups.length - 1];
    if (last && last.place === entry.p) last.units.push(entry.u);
    else groups.push({ place: entry.p, units: [entry.u], start: position });
    position += 1;
  }
  for (const g of groups) g.positions = g.units.length;
  return groups;
}

// What each player gets. battle: { format, payoutBps, teams, participants (accepted players) }, potCents,
// places: { [uid | teamId]: n }. Returns { byUid: { uid: cents }, groups: [{ place, finish (1-based
// position), units, bps, perMemberCents }], leftoverTo, leftoverCents }. The amounts add up to potCents.
export function computeBattlePayouts(battle, potCents, places) {
  const bps = battle.payoutBps ?? [];
  const units = placeUnits(battle);
  const groups = placeGroups(units, places);
  const byUid = {};
  for (const p of battle.participants ?? []) byUid[p.uid] = 0;

  const membersOf = (unit) => (battle.format === 'teams' ? teamMembers(battle, unit).map((p) => p.uid) : [unit]);
  let paid = 0;
  let leftoverTo = null;
  const out = [];
  for (const g of groups) {
    let groupBps = 0;
    for (let pos = g.start; pos < g.start + g.positions; pos += 1) groupBps += bps[pos] ?? 0;
    let perMemberCents = 0;
    for (const unit of g.units) {
      const members = membersOf(unit);
      if (!members.length) continue;
      // unit share = pot × groupBps / (10000 × k); member = unit share / team size; rounded down.
      perMemberCents = Math.floor((potCents * groupBps) / (FULL_BPS * g.positions * members.length));
      for (const uid of members) {
        byUid[uid] = (byUid[uid] ?? 0) + perMemberCents;
        paid += perMemberCents;
        if (leftoverTo === null && groupBps > 0) leftoverTo = uid;
      }
    }
    out.push({ place: g.place, finish: g.start + 1, units: g.units, bps: groupBps, perMemberCents });
  }
  const leftoverCents = potCents - paid;
  if (leftoverTo !== null && leftoverCents > 0) byUid[leftoverTo] += leftoverCents;
  return { byUid, groups: out, leftoverTo, leftoverCents: leftoverTo !== null ? leftoverCents : 0 };
}

// Preview of what each place pays with no ties (for the create form and the detail page).
export function placeAmounts(potCents, payoutBps) {
  return (payoutBps ?? []).map((b) => Math.floor((potCents * b) / FULL_BPS));
}
