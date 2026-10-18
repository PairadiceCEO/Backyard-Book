// Fixture data for the phone harness: board, game detail, Firestore collections, admin answers.
const H = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const now = Date.now();

const q = (american, line = null, source = 'espn', ref = { provider: 'DraftKings' }) => ({
  american, decimal: american > 0 ? 1 + american / 100 : 1 + 100 / -american, line, source, ref,
});
const kq = (american, line, ticker, side) => q(american, line, 'kalshi', { provider: 'Kalshi', ticker, side, price: 0.5 });
const team = (abbr, name, shortName, score = null, logo = null) => ({ id: abbr, name, shortName, nickname: shortName, location: name.replace(` ${shortName}`, ''), abbr, logo, logoDark: null, score });
const markets = (o = {}) => ({ moneyline: { home: null, away: null }, spread: { home: null, away: null }, total: { over: null, under: null }, ...o });

export const nflGames = [
  {
    id: '401', league: 'nfl', source: 'espn', startTime: iso(now + 2 * H), state: 'pre', statusText: '', canceled: false, bettingClosed: false,
    home: team('HOU', 'Houston Texans', 'Texans', null, 'https://a.espncdn.com/i/teamlogos/nfl/500/hou.png'),
    away: team('JAX', 'Jacksonville Jaguars', 'Jaguars'),
    markets: markets({
      moneyline: { home: q(-135), away: q(114) },
      spread: { home: q(-110, -2.5), away: q(-110, 2.5) },
      total: { over: q(-110, 42.5), under: q(-110, 42.5) },
    }),
    oddsNote: null, kalshi: null,
  },
  {
    id: '402', league: 'nfl', source: 'espn', startTime: iso(now - H), state: 'in', statusText: '3rd Qtr 08:42', canceled: false, bettingClosed: true,
    home: team('CLE', 'Cleveland Browns', 'Browns', 17), away: team('BAL', 'Baltimore Ravens', 'Ravens', 24),
    markets: markets({
      moneyline: { home: kq(310, null, 'KXNFLGAME-X-CLE', 'yes'), away: kq(-420, null, 'KXNFLGAME-X-BAL', 'yes') },
      spread: { home: kq(-104, 6.5, 'KXNFLSPREAD-X-BAL7', 'no'), away: kq(-108, -6.5, 'KXNFLSPREAD-X-BAL7', 'yes') },
      total: { over: kq(-115, 47.5, 'KXNFLTOTAL-X-48', 'yes'), under: kq(-105, 47.5, 'KXNFLTOTAL-X-48', 'no') },
    }),
    oddsNote: null, kalshi: null,
  },
  {
    id: '403', league: 'nfl', source: 'espn', startTime: iso(now - 4 * H), state: 'post', statusText: 'Final/OT', canceled: false, bettingClosed: true,
    home: team('PHI', 'Philadelphia Eagles', 'Eagles', 30), away: team('CAR', 'Carolina Panthers', 'Panthers', 27),
    markets: markets(), oddsNote: null, kalshi: null,
  },
  {
    id: 'custom:abc', league: 'nfl', source: 'custom', startTime: iso(now + 26 * H), state: 'pre', statusText: '', canceled: false, bettingClosed: false,
    edits: [{ byName: 'Will', at: iso(now - 30 * H), what: 'Created' }, { byName: 'Will', at: iso(now - 5 * H), what: 'Edited: Home ML -140 → -150; Away ML +120 → +130' }],
    home: team('BB', 'Backyard Bears', 'Backyard Bears'), away: team('LL', 'Lawn Lions', 'Lawn Lions'),
    markets: markets({
      moneyline: { home: q(-150, null, 'custom', { provider: 'Custom' }), away: q(130, null, 'custom', { provider: 'Custom' }) },
      spread: { home: q(-110, -3.5, 'custom', { provider: 'Custom' }), away: q(-110, 3.5, 'custom', { provider: 'Custom' }) },
      total: { over: null, under: null },
    }),
    oddsNote: null, kalshi: null,
  },
  {
    id: '404', league: 'nfl', source: 'espn', startTime: iso(now + 27 * H), state: 'pre', statusText: '', canceled: false, bettingClosed: false,
    home: team('SF', 'San Francisco 49ers', '49ers'), away: team('LAR', 'Los Angeles Rams', 'Rams'),
    markets: markets(), oddsNote: 'Odds unavailable', kalshi: null,
  },
];

// League tabs list only games that haven't finished (the server drops final / canceled / postponed ones).
export function board(league) {
  if (league === 'live') return liveBoard();
  const games = league === 'nba' ? [] : nflGames.filter((g) => g.state !== 'post' && !g.canceled).map((g) => ({ ...g, league }));
  return { league, fetchedAt: new Date().toISOString(), stale: false, partial: false, kalshiStatus: 'ok', games };
}

// The Live tab: games in progress across leagues (each keeps its league), or none.
const liveMlb = {
  ...nflGames[1], id: '501', league: 'mlb', startTime: iso(now - 2 * H), statusText: 'Bot 7th',
  home: team('CLE', 'Cleveland Guardians', 'Guardians', 2), away: team('TB', 'Tampa Bay Rays', 'Rays', 6),
  markets: markets({ moneyline: { home: kq(900, null, 'KXMLBGAME-X-CLE', 'yes'), away: kq(-1900, null, 'KXMLBGAME-X-TB', 'yes') }, spread: { home: null, away: null }, total: { over: kq(-110, 9.5, 'KXMLBTOTAL-X-10', 'yes'), under: kq(-110, 9.5, 'KXMLBTOTAL-X-10', 'no') } }),
  partialNote: 'Some live prices unavailable',
};
const liveNhl = {
  ...nflGames[1], id: '601', league: 'nhl', startTime: iso(now - 0.5 * H), statusText: '2nd 11:20',
  home: team('PIT', 'Pittsburgh Penguins', 'Penguins', 1), away: team('VGK', 'Vegas Golden Knights', 'Golden Knights', 1),
  markets: markets(), oddsNote: 'Live prices unavailable',
};
export function liveBoard(empty = false) {
  const games = empty ? [] : [liveMlb, { ...nflGames[1], league: 'nfl' }, liveNhl];
  return { league: 'live', fetchedAt: new Date().toISOString(), stale: false, partial: false, kalshiStatus: 'ok', games };
}

export function gameDetail(id) {
  const game = nflGames.find((g) => g.id === id) ?? nflGames[0];
  const sp = (lines, side) => lines.map((l) => kq(l < 0 ? 100 + Math.round(-l * 40) : -100 - Math.round(l * 30), l, `KXNFLSPREAD-X-${side}${Math.abs(l)}`, l < 0 ? 'yes' : 'no'));
  return {
    league: 'nfl', fetchedAt: new Date().toISOString(), stale: false, kalshiStatus: 'ok', game,
    ladders: {
      spreads: { home: sp([-10.5, -6.5, -3.5, -2.5, -1.5, 1.5, 2.5, 3.5, 7.5], 'HOU'), away: sp([-7.5, -3.5, -2.5, -1.5, 1.5, 2.5, 3.5, 6.5, 10.5], 'JAC') },
      totals: [35.5, 38.5, 41.5, 42.5, 44.5, 47.5, 50.5].map((line, i) => ({ line, over: kq(-250 + i * 60, line, `KXNFLTOTAL-X-${line}`, 'yes'), under: kq(200 - i * 55, line, `KXNFLTOTAL-X-${line}`, 'no') })),
    },
  };
}

const leg = (o) => ({
  legId: `${o.gameId}:${o.marketType}:${o.selection}:${o.line ?? ''}`, league: 'nfl', gameLabel: 'Jaguars @ Texans', startTime: iso(now + 2 * H),
  line: null, americanOdds: -110, decimalOdds: 1.9091, source: 'espn', result: 'pending', ...o,
});
export const bets = [
  { id: 'b1', uid: 'u1', username: 'mike', type: 'single', status: 'open', stakeCents: 2500, potentialPayoutCents: 4772, payoutCents: 0, combinedAmerican: -110, placedAt: iso(now - 30 * 60000), version: 0,
    legs: [leg({ gameId: '401', marketType: 'spread', selection: 'away', line: 2.5, label: 'Jaguars +2.5' })] },
  { id: 'b2', uid: 'u1', username: 'mike', type: 'parlay', status: 'open', stakeCents: 1000, potentialPayoutCents: 12345, payoutCents: 0, combinedAmerican: 1134, placedAt: iso(now - 50 * 60000), version: 0,
    legs: [
      leg({ gameId: '401', marketType: 'moneyline', selection: 'home', label: 'Texans ML', americanOdds: -135 }),
      leg({ gameId: '402', marketType: 'total', selection: 'over', line: 47.5, label: 'Over 47.5', gameLabel: 'Ravens @ Browns', source: 'kalshi' }),
      leg({ gameId: 'custom:abc', marketType: 'spread', selection: 'home', line: -3.5, label: 'Backyard Bears -3.5', gameLabel: 'Lawn Lions @ Backyard Bears', source: 'custom' }),
      leg({ gameId: '404', marketType: 'moneyline', selection: 'away', label: 'Rams ML', gameLabel: 'Rams @ 49ers', americanOdds: 145 }),
    ] },
  { id: 'b3', uid: 'u1', username: 'mike', type: 'single', status: 'won', stakeCents: 1000, potentialPayoutCents: 1909, payoutCents: 1909, combinedAmerican: -110, placedAt: iso(now - 6 * H), settledAt: iso(now - 2 * H), version: 1,
    legs: [leg({ gameId: '403', marketType: 'spread', selection: 'home', line: -2.5, label: 'Eagles -2.5', gameLabel: 'Panthers @ Eagles', result: 'win', scoreText: 'Panthers 27 @ Eagles 30 · Final/OT' })] },
  { id: 'b4', uid: 'u1', username: 'mike', type: 'parlay', status: 'lost', stakeCents: 500, potentialPayoutCents: 1745, payoutCents: 0, combinedAmerican: 249, placedAt: iso(now - 7 * H), settledAt: iso(now - 2 * H), version: 1,
    legs: [
      leg({ gameId: '403', marketType: 'moneyline', selection: 'away', label: 'Panthers ML', gameLabel: 'Panthers @ Eagles', americanOdds: 120, result: 'loss', scoreText: 'Panthers 27 @ Eagles 30 · Final/OT' }),
      leg({ gameId: '401', marketType: 'total', selection: 'under', line: 42.5, label: 'Under 42.5' }),
    ] },
  { id: 'b7', uid: 'u1', username: 'mike', type: 'parlay', status: 'cashed_out', stakeCents: 1000, potentialPayoutCents: 6084, payoutCents: 2210, cashoutCents: 2210, combinedAmerican: 508, placedAt: iso(now - 5 * H), settledAt: iso(now - 3 * H), cashedOutAt: iso(now - 3 * H), settledBy: 'cashout', version: 1,
    legs: [
      leg({ gameId: '403', marketType: 'moneyline', selection: 'home', label: 'Eagles ML', gameLabel: 'Panthers @ Eagles', americanOdds: -150 }),
      leg({ gameId: '402', marketType: 'spread', selection: 'away', line: 6.5, label: 'Ravens +6.5', gameLabel: 'Ravens @ Browns', americanOdds: 150 }),
    ] },
  { id: 'b8', uid: 'u1', username: 'mike', type: 'single', status: 'open', stakeCents: 1800, potentialPayoutCents: 2800, payoutCents: 0, combinedAmerican: -180, placedAt: iso(now - 3 * H), version: 0, posterBet: true,
    legs: [leg({ league: 'challenge', gameId: 'challenge:c-open', marketType: 'challenge', selection: 'o2', label: 'No', gameLabel: 'Will Mike run a 5K under 25 minutes?', americanOdds: -180, decimalOdds: 1.5556, source: 'challenge', startTime: iso(now + 5 * H) })] },
  { id: 'b5', uid: 'u2', username: 'dan', type: 'single', status: 'push', stakeCents: 2000, potentialPayoutCents: 3818, payoutCents: 2000, combinedAmerican: -110, placedAt: iso(now - 8 * H), settledAt: iso(now - 2 * H), version: 1,
    legs: [leg({ gameId: '403', marketType: 'spread', selection: 'home', line: -3, label: 'Eagles -3', gameLabel: 'Panthers @ Eagles', result: 'push', scoreText: 'Panthers 27 @ Eagles 30 · Final/OT' })] },
  { id: 'b6', uid: 'u2', username: 'dan', type: 'single', status: 'open', stakeCents: 500, potentialPayoutCents: 954, payoutCents: 0, combinedAmerican: -110, placedAt: iso(now - 90 * H), version: 0,
    needsReview: true, reviewReason: 'Pending over 72 h — Ravens @ Browns: Not final yet (ESPN: Suspended)',
    legs: [leg({ gameId: '402', marketType: 'moneyline', selection: 'away', label: 'Ravens ML', gameLabel: 'Ravens @ Browns', startTime: iso(now - 80 * H) })] },
];

export const users = [
  { id: 'u0', username: 'will', displayName: 'Will', role: 'admin', balanceCents: 18250, stats: { won: 12, lost: 9 }, disabled: false },
  { id: 'u1', username: 'mike', displayName: 'Mike the Bookie Slayer', role: 'player', balanceCents: 9640, stats: { won: 5, lost: 7 }, disabled: false },
  { id: 'u2', username: 'dan', displayName: 'Dan', role: 'player', balanceCents: 123456789, stats: { won: 0, lost: 0 }, disabled: false },
  { id: 'u3', username: 'sam', displayName: 'Sam', role: 'player', balanceCents: 0, stats: { won: 1, lost: 0 }, disabled: true },
  { id: 'u4', username: 'ann', displayName: 'Ann', role: 'player', balanceCents: 5000, stats: { won: 2, lost: 2 }, disabled: false },
  { id: 'u5', username: 'bo', displayName: 'Bo', role: 'player', balanceCents: 7000, stats: { won: 1, lost: 3 }, disabled: false },
];

export const ledger = [
  { id: 'shop_u1_a', uid: 'u1', type: 'shop', amountCents: 2500, createdAt: iso(now - 3 * H), note: 'Shop +$25' },
  { id: 'shop_u1_b', uid: 'u1', type: 'shop', amountCents: 10000, createdAt: iso(now - 30 * H), note: 'Shop +$100' },
  { id: 'shop_u2_a', uid: 'u2', type: 'shop', amountCents: 500, createdAt: iso(now - 5 * H), note: 'Shop +$5' },
];

export const customGames = [
  { id: 'abc', league: 'nfl', status: 'scheduled', startTime: iso(now + 26 * H), betCount: 3, edits: [{ by: 'u0', byName: 'Will', at: iso(now - 30 * H), what: 'Created' }, { by: 'u0', byName: 'Will', at: iso(now - 5 * H), what: 'Edited: Home ML -140 → -150; Away ML +120 → +130' }], home: { name: 'Backyard Bears', abbr: 'BB', logoUrl: null }, away: { name: 'Lawn Lions', abbr: 'LL', logoUrl: null },
    odds: { moneyline: { home: -150, away: 130 }, spread: { homeLine: -3.5, home: -110, away: -110 }, total: { line: null, over: null, under: null } } },
  { id: 'def', league: 'mlb', status: 'scheduled', startTime: iso(now - H), betCount: 0, home: { name: 'Patio Pumas', abbr: 'PP', logoUrl: null }, away: { name: 'Deck Ducks', abbr: 'DD', logoUrl: null },
    odds: { moneyline: { home: -120, away: 100 }, spread: { homeLine: null, home: null, away: null }, total: { line: 8.5, over: -110, under: -110 } } },
  { id: 'ghi', league: 'nba', status: 'final', startTime: iso(now - 30 * H), betCount: 2, finalScore: { home: 101, away: 99 }, home: { name: 'Garage Gators', abbr: 'GG', logoUrl: null }, away: { name: 'Shed Sharks', abbr: 'SS', logoUrl: null },
    odds: { moneyline: { home: -110, away: -110 }, spread: { homeLine: null, home: null, away: null }, total: { line: null, over: null, under: null } } },
];

export const regradePreview = {
  preview: true, betId: 'b4', version: 1, uid: 'u1', username: 'mike', type: 'parlay', stakeCents: 500, describe: 'Forced win (full odds)',
  from: { status: 'lost', payoutCents: 0 }, to: { status: 'won', payoutCents: 1745 }, deltaCents: 1745,
  balanceBeforeCents: 9640, balanceAfterCents: 11385, statsBefore: { won: 5, lost: 7 }, statsAfter: { won: 6, lost: 6 },
  legs: [{ label: 'Panthers ML', gameLabel: 'Panthers @ Eagles', result: 'loss' }, { label: 'Under 42.5', gameLabel: 'Jaguars @ Texans', result: 'win' }], noChange: false,
};

export const settlePreview = {
  preview: true, generatedAt: new Date().toISOString(), checked: 3,
  totals: { bets: 1, payoutCents: 1909, won: 1, lost: 0, push: 0, void: 0, needsReview: 1 },
  walletChanges: [{ uid: 'u1', username: 'mike', deltaCents: 1909, bets: 1, balanceBeforeCents: 9640, balanceAfterCents: 11549 }],
  wouldSettle: [{ id: 'b3', uid: 'u1', username: 'mike', type: 'single', stakeCents: 1000, status: 'won', payoutCents: 1909, deltaCents: 1909, droppedLegs: 0, review: null,
    legs: [{ label: 'Eagles -2.5', gameLabel: 'Panthers @ Eagles', league: 'nfl', gameId: '403', americanOdds: -110, result: 'win', scoreText: 'Panthers 27 @ Eagles 30 · Final/OT', reason: '' }] }],
  staysOpen: [{ id: 'b6', uid: 'u2', username: 'dan', type: 'single', stakeCents: 500, status: 'open', payoutCents: 0, deltaCents: 0, droppedLegs: 0, review: 'Pending over 72 h — Ravens @ Browns: Not final yet (ESPN: Suspended)',
    legs: [{ label: 'Ravens ML', gameLabel: 'Ravens @ Browns', league: 'nfl', gameId: '402', americanOdds: -420, result: 'pending', scoreText: null, reason: 'Not final yet (ESPN: Suspended).' }] }],
};

// ---------- Custom board and Battles ----------
export function customBoard() {
  const games = nflGames.slice(0, 2).map((g, i) => ({ ...g, id: `custom:${['abc', 'def'][i]}`, source: 'custom', league: i ? 'mlb' : 'nfl', oddsProvider: 'Custom' }));
  return { league: 'custom', fetchedAt: new Date().toISOString(), stale: false, partial: false, kalshiStatus: 'ok', games };
}

const part = (uid, name, status = 'accepted', extra = {}) => ({ uid, name, team: null, status, stakeSeq: status === 'accepted' ? 1 : 0, notice: null, acceptedAt: status === 'accepted' ? iso(now - 3 * H) : null, ...extra });
const battleBase = (extra) => ({
  title: 'Saturday golf, 9 holes', description: 'Lowest score wins. Winner buys the first round.', creatorUid: 'u0', creatorName: 'Will', format: 'ffa', teams: [],
  stakeCents: 2000, potCents: 6000, payoutBps: [7000, 3000], status: 'pending', createdAt: iso(now - 5 * H), updatedAt: iso(now - H), expiresAt: iso(now + 43 * H),
  liveAt: null, result: null, resultAt: null, credited: {}, disputes: [], disputed: false, edits: [], cancelReason: null, version: 2, ...extra,
});
export const battles = [
  { id: 'b-inv', ...battleBase({ participants: [part('u0', 'Will'), part('u1', 'Mike the Bookie Slayer', 'invited'), part('u2', 'Dan')], participantUids: ['u0', 'u1', 'u2'] }) },
  { id: 'b-pc', ...battleBase({ title: 'Darts to 501', createdAt: iso(now - 6 * H), stakeCents: 500, potCents: 1500, payoutBps: [10000], participants: [part('u2', 'Dan'), part('u1', 'Mike the Bookie Slayer', 'accepted', { notice: 'payoutChanged' }), part('u4', 'Ann', 'invited')], participantUids: ['u2', 'u1', 'u4'], creatorUid: 'u2', creatorName: 'Dan',
    edits: [{ by: 'u0', byName: 'Will', at: iso(now - 2 * H), what: 'Payout changed: 70/30% → 100%' }] }) },
  { id: 'b-live', ...battleBase({ title: 'Cornhole tournament', createdAt: iso(now - 20 * H), status: 'live', liveAt: iso(now - 18 * H), format: 'teams', creatorUid: 'u1', creatorName: 'Mike the Bookie Slayer', stakeCents: 1000, potCents: 4000, payoutBps: [10000],
    teams: [{ id: 't1', name: 'Bag Tossers' }, { id: 't2', name: 'Hole Hunters' }],
    participants: [part('u1', 'Mike the Bookie Slayer', 'accepted', { team: 't1' }), part('u4', 'Ann', 'accepted', { team: 't1' }), part('u2', 'Dan', 'accepted', { team: 't2' }), part('u5', 'Bo', 'accepted', { team: 't2' })], participantUids: ['u1', 'u4', 'u2', 'u5'] }) },
  { id: 'b-done', ...battleBase({ title: 'Mario Kart 150cc', createdAt: iso(now - 30 * H), status: 'settled', liveAt: iso(now - 28 * H), resultAt: iso(now - 4 * H), stakeCents: 1000, potCents: 4000, payoutBps: [7000, 3000],
    participants: [part('u0', 'Will'), part('u1', 'Mike the Bookie Slayer'), part('u2', 'Dan'), part('u4', 'Ann')], participantUids: ['u0', 'u1', 'u2', 'u4'],
    result: { places: { u0: 2, u1: 1, u2: 3, u4: 4 }, enteredBy: 'u0', enteredAt: iso(now - 4 * H), by: 'creator' }, credited: { u0: 1200, u1: 2800, u2: 0, u4: 0 },
    disputes: [{ uid: 'u2', name: 'Dan', note: 'Ann used a blue shell on the last lap after time was called.', at: iso(now - 3 * H), resolved: false }], disputed: true }) },
  { id: 'b-cx', ...battleBase({ title: 'Ping pong', createdAt: iso(now - 50 * H), status: 'cancelled', cancelReason: 'Dan declined.', participants: [part('u1', 'Mike the Bookie Slayer', 'refunded'), part('u2', 'Dan', 'declined')], participantUids: ['u1', 'u2'], creatorUid: 'u1', creatorName: 'Mike the Bookie Slayer' }) },
];
export const battlePreview = {
  preview: true, battleId: 'b-done', version: 2, title: 'Mario Kart 150cc', status: 'settled', toStatus: 'settled', describe: 'Result changed by the admin',
  players: [
    { uid: 'u0', name: 'Will', fromCents: 1200, toCents: 0, deltaCents: -1200, balanceBeforeCents: 500, balanceAfterCents: -700 },
    { uid: 'u1', name: 'Mike the Bookie Slayer', fromCents: 2800, toCents: 2800, deltaCents: 0, balanceBeforeCents: 9640, balanceAfterCents: 9640 },
    { uid: 'u2', name: 'Dan', fromCents: 0, toCents: 1200, deltaCents: 1200, balanceBeforeCents: 2000, balanceAfterCents: 3200 },
  ],
};

// ---------- Challenges (Phase C) ----------
const outcome = (id, label, american) => ({ id, label, american });
const challengeBase = (extra) => ({
  title: 'Will Mike run a 5K under 25 minutes?', description: 'Saturday park run, chip time. Mike says he’s been training.', posterUid: 'u1', posterName: 'Mike the Bookie Slayer',
  status: 'open', winner: null, rejectNote: null, closeTime: iso(now + 5 * H), createdAt: iso(now - 6 * H), updatedAt: iso(now - 2 * H), approvedAt: iso(now - 4 * H), approvedBy: 'u0',
  settledAt: null, settledBy: null, betCount: 4, posterBets: [], edits: [], version: 1,
  outcomes: [outcome('o1', 'Yes', 150), outcome('o2', 'No', -180)], ...extra,
});
export const challenges = [
  { id: 'c-open', ...challengeBase({
    posterBets: [{ betId: 'b8', outcomeId: 'o2', label: 'No', americanOdds: -180, stakeCents: 1800, parlay: false, at: iso(now - 3 * H) }],
    edits: [{ by: 'u0', byName: 'Will', at: iso(now - 4 * H), what: 'Approved with edits: Yes +170 → +150; No -200 → -180' }, { by: 'u0', byName: 'Will', at: iso(now - 2 * H), what: 'Edited: closes Oct 18, 9:00 AM → Oct 18, 7:00 PM' }] }) },
  { id: 'c-pend', ...challengeBase({ title: 'How many wings can Dan eat in 10 minutes?', description: 'Medium sauce. Bones counted at the end.', posterUid: 'u2', posterName: 'Dan', status: 'pending', approvedAt: null, approvedBy: null, betCount: 0, createdAt: iso(now - H), version: 0,
    outcomes: [outcome('o1', 'Under 30', -120), outcome('o2', '30 to 44', 200), outcome('o3', '45 or more (a new backyard record)', 450)] }) },
  { id: 'c-closed', ...challengeBase({ title: 'Who wins the bake-off?', description: '', posterUid: 'u4', posterName: 'Ann', closeTime: iso(now - H), createdAt: iso(now - 30 * H), betCount: 7,
    outcomes: [outcome('o1', 'Ann’s lemon tart', 120), outcome('o2', 'Bo’s brownies', 250), outcome('o3', 'Dan’s mystery pie', 600), outcome('o4', 'Nobody shows up', 2000)] }) },
  { id: 'c-settled', ...challengeBase({ title: 'Will it rain on the cookout?', description: '', posterUid: 'u5', posterName: 'Bo', status: 'settled', winner: 'o1', closeTime: iso(now - 20 * H), settledAt: iso(now - 2 * H), createdAt: iso(now - 40 * H), betCount: 3,
    edits: [{ by: 'u0', byName: 'Will', at: iso(now - 38 * H), what: 'Approved' }, { by: 'u0', byName: 'Will', at: iso(now - 2 * H), what: 'Settled: "Yes" won' }] }) },
  { id: 'c-rej', ...challengeBase({ title: 'Will Sam quit his job on Monday?', description: '', status: 'rejected', rejectNote: 'Not about someone who isn’t in on it.', approvedAt: null, approvedBy: null, betCount: 0, createdAt: iso(now - 3 * H), updatedAt: iso(now - 2 * H),
    edits: [{ by: 'u0', byName: 'Will', at: iso(now - 2 * H), what: 'Rejected: Not about someone who isn’t in on it.' }] }) },
];
export const challengeSettlePreview = {
  preview: true, challengeId: 'c-closed', kind: 'settle', winner: 'o2', winnerLabel: 'Bo’s brownies', title: 'Who wins the bake-off?',
  totals: { bets: 6, payoutCents: 8750, won: 2, lost: 4, push: 0, void: 0, needsReview: 0 },
  walletChanges: [
    { uid: 'u5', username: 'bo', deltaCents: 7000, bets: 1, balanceBeforeCents: 7000, balanceAfterCents: 14000 },
    { uid: 'u1', username: 'mike', deltaCents: 1750, bets: 2, balanceBeforeCents: 9640, balanceAfterCents: 11390 },
    { uid: 'u4', username: 'ann', deltaCents: 0, bets: 3, balanceBeforeCents: 5000, balanceAfterCents: 5000 },
  ],
  wouldSettle: [], staysOpen: [{ id: 'bx' }],
};
