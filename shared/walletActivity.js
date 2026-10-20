// Admin → Wallet activity (0.17.0): how ledger entries are grouped, labelled and checked. Read-only: the ledger
// itself is never changed. Shared by /api/admin walletActivity (summary) and the admin screen (rows, filters, checks).

export const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ACTIVITY_PAGE = 50;

// Every ledger type the server writes, by what it is. Debits are wagers or stakes; credits are wins, returns,
// refunds or purchases; admin entries can go either way (shown as net).
export const SPORTSBOOK_TYPES = ['stake', 'payout', 'cashout'];
export const CASINO_TYPES = ['casino_bet', 'casino_payout', 'casino_refund'];
export const BATTLE_TYPES = ['battle_stake', 'battle_payout', 'battle_refund'];
export const SHOP_TYPES = ['shop'];
export const ADMIN_TYPES = ['admin_adjust', 'admin_regrade'];
export const DEBIT_TYPES = ['stake', 'casino_bet', 'battle_stake'];
export const CREDIT_TYPES = ['payout', 'cashout', 'casino_payout', 'casino_refund', 'battle_payout', 'battle_refund', 'shop'];
export const NON_CASINO_TYPES = [...SPORTSBOOK_TYPES, ...BATTLE_TYPES, ...SHOP_TYPES, ...ADMIN_TYPES];
export const CASINO_GAME_IDS = ['slots', 'blackjack', 'baccarat', 'craps', 'crapless'];
export const CASINO_GAME_NAMES = { slots: 'Slots', blackjack: 'Blackjack', baccarat: 'Baccarat', craps: 'Craps', crapless: 'Crapless' };

export const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'sportsbook', label: 'Sportsbook' },
  { id: 'casino', label: 'Casino' },
  { id: 'battles', label: 'Battles' },
  { id: 'shop', label: 'Shop' },
  { id: 'admin', label: 'Admin' },
];

export function categoryOf(type) {
  if (SPORTSBOOK_TYPES.includes(type)) return 'sportsbook';
  if (CASINO_TYPES.includes(type)) return 'casino';
  if (BATTLE_TYPES.includes(type)) return 'battles';
  if (SHOP_TYPES.includes(type)) return 'shop';
  if (ADMIN_TYPES.includes(type)) return 'admin';
  return 'other';
}

export function matchesFilter(entry, filter, game = 'all') {
  if (filter === 'all') return true;
  if (categoryOf(entry.type) !== filter) return false;
  if (filter === 'casino' && game !== 'all') return entry.game === game;
  return true;
}

// "Sportsbook", "Slots", "Blackjack seat 3", "Craps", "Battle", "Shop", "Admin".
export function whereOf(entry) {
  const cat = categoryOf(entry.type);
  if (cat === 'sportsbook') return 'Sportsbook';
  if (cat === 'casino') {
    const name = CASINO_GAME_NAMES[entry.game] ?? 'Casino';
    const seat = /\bseat (\d)\b/.exec(String(entry.note ?? ''));
    return (entry.game === 'blackjack' || entry.game === 'baccarat') && seat ? `${name} seat ${seat[1]}` : name;
  }
  if (cat === 'battles') return 'Battle';
  if (cat === 'shop') return 'Shop';
  if (cat === 'admin') return 'Admin';
  return entry.type || 'Other';
}

// A bucket of the summary: entries, wagered (debits, positive cents), won/returned (credits), adjusted (admin net), net.
export function emptyBucket() {
  return { count: 0, wageredCents: 0, wonCents: 0, adjustedCents: 0, netCents: 0 };
}

// Adds one type's aggregate ({ count, sumCents }) to a bucket.
export function addAggregate(bucket, type, { count, sumCents }) {
  bucket.count += count;
  bucket.netCents += sumCents;
  if (DEBIT_TYPES.includes(type)) bucket.wageredCents += -sumCents;
  else if (CREDIT_TYPES.includes(type)) bucket.wonCents += sumCents;
  else bucket.adjustedCents += sumCents;
  return bucket;
}

// The 24 h summary from per-type aggregates.
//   byType: { [type]: { count, sumCents } } for the non-casino types
//   byGame: { [game]: { [casinoType]: { count, sumCents } } }
//   total:  { count, sumCents } over every entry in the window (catches types this file doesn't know)
export function buildSummary({ byType = {}, byGame = {}, total = null }) {
  const sportsbook = emptyBucket();
  const casino = { ...emptyBucket(), games: {} };
  const other = { ...emptyBucket(), parts: { battles: emptyBucket(), shop: emptyBucket(), admin: emptyBucket() } };
  for (const [type, agg] of Object.entries(byType)) {
    const cat = categoryOf(type);
    if (cat === 'sportsbook') addAggregate(sportsbook, type, agg);
    else if (cat === 'battles' || cat === 'shop' || cat === 'admin') {
      addAggregate(other, type, agg);
      addAggregate(other.parts[cat], type, agg);
    }
  }
  for (const game of CASINO_GAME_IDS) {
    const bucket = emptyBucket();
    for (const [type, agg] of Object.entries(byGame[game] ?? {})) addAggregate(bucket, type, agg);
    casino.games[game] = bucket;
    for (const k of ['count', 'wageredCents', 'wonCents', 'adjustedCents', 'netCents']) casino[k] += bucket[k];
  }
  const all = emptyBucket();
  for (const b of [sportsbook, casino, other]) for (const k of ['count', 'wageredCents', 'wonCents', 'adjustedCents', 'netCents']) all[k] += b[k];
  const unclassified = total
    ? { count: total.count - all.count, netCents: total.sumCents - all.netCents }
    : { count: 0, netCents: 0 };
  return { all, sportsbook, casino, other, unclassified };
}

// ---------- the balance check ----------
// entries: newest first, as the server returns them: { id, amountCents, balanceAfterCents, createdKey }.
// createdKey is the exact server timestamp; entries written in one transaction share it and are checked as a group.
// complete: true when the oldest entry is the first of the 24 h window (no more pages).
// currentBalanceCents: the player's wallet now.
// Returns { rows: Map(id → { status: 'ok' | 'jump' | 'first' | 'unchecked', expectedCents?, ledgerCents? }),
//           jumps, walletMismatch: null | { expectedCents (newest balance after), walletCents } }.
export function checkBalances(entries, { complete = false, currentBalanceCents = null } = {}) {
  const rows = new Map();
  const oldestFirst = [...entries].reverse();
  const groups = [];
  for (const e of oldestFirst) {
    const last = groups[groups.length - 1];
    if (last && last.key === e.createdKey) last.items.push(e);
    else groups.push({ key: e.createdKey, items: [e] });
  }
  let jumps = 0;
  let prev = null;
  groups.forEach((group, gi) => {
    if (gi === 0) {
      // Nothing older to compare with: the start of the window (or of what is loaded so far). Inside the group the
      // entries must still chain with each other, starting from the balance before the first one.
      const status = complete ? 'first' : 'unchecked';
      const start = chainStart(group.items);
      if (start === null) {
        for (const e of group.items) rows.set(e.id, { status });
        prev = Math.max(...group.items.map((e) => e.balanceAfterCents));
        return;
      }
      prev = start;
    }
    const result = chainGroup(prev, group.items);
    for (const e of group.items) rows.set(e.id, gi === 0 ? { status: complete ? 'first' : 'unchecked' } : { status: 'ok' });
    if (result.ok) {
      prev = result.endCents;
      return;
    }
    jumps += 1;
    rows.set(result.bad.id, { status: 'jump', expectedCents: result.expectedCents, ledgerCents: result.bad.balanceAfterCents });
    prev = result.endCents; // continue from what the ledger says
  });
  const newest = entries[0];
  const walletMismatch =
    newest && Number.isInteger(currentBalanceCents) && newest.balanceAfterCents !== currentBalanceCents
      ? { expectedCents: newest.balanceAfterCents, walletCents: currentBalanceCents }
      : null;
  return { rows, jumps, walletMismatch };
}

// Chains a same-transaction group from `start`: each step takes any unused entry whose balance after equals the
// running balance + its amount. ok when every entry chains. Otherwise the first entry (in ledger order) that can't is
// the jump; the walk then trusts what the ledger says for it and goes on, so endCents is where the group ends.
function chainGroup(start, items) {
  const left = [...items];
  let cur = start;
  let bad = null;
  let expectedCents = null;
  while (left.length) {
    let i = left.findIndex((e) => e.balanceAfterCents === cur + e.amountCents);
    if (i < 0) {
      i = 0;
      if (!bad) {
        bad = left[0];
        expectedCents = cur + bad.amountCents;
      }
    }
    cur = left[i].balanceAfterCents;
    left.splice(i, 1);
  }
  return bad ? { ok: false, bad, expectedCents, endCents: cur } : { ok: true, endCents: cur };
}

// The balance before the window's first group, found from the group itself: the one start value from which every
// entry of the group chains. null if there is none (then the group isn't checked against itself).
function chainStart(items) {
  for (const e of items) {
    const start = e.balanceAfterCents - e.amountCents;
    if (chainGroup(start, items).ok) return start;
  }
  return null;
}
