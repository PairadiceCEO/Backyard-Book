// Groups shop ledger entries by player for the admin Shop purchases tab.

function toMillis(createdAt) {
  if (!createdAt) return 0;
  if (typeof createdAt.toMillis === 'function') return createdAt.toMillis();
  if (typeof createdAt.toDate === 'function') return createdAt.toDate().getTime();
  const ms = new Date(createdAt).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

// entries: ledger docs ({ id, uid, type, amountCents, createdAt }); users: users docs ({ id, username, displayName, disabled }).
// Only type "shop" counts. Players are sorted by total purchased (highest first); purchases newest first.
export function groupShopPurchases(entries, users) {
  const userById = new Map(users.map((u) => [u.id, u]));
  const byUid = new Map();
  let totalCount = 0;
  let totalCents = 0;

  for (const entry of entries) {
    if (entry.type !== 'shop') continue;
    const amount = Number(entry.amountCents) || 0;
    let group = byUid.get(entry.uid);
    if (!group) {
      const user = userById.get(entry.uid);
      group = {
        uid: entry.uid,
        displayName: user?.displayName || user?.username || 'Unknown player',
        username: user?.username || entry.uid,
        disabled: user?.disabled === true,
        count: 0,
        totalCents: 0,
        purchases: [],
      };
      byUid.set(entry.uid, group);
    }
    group.count += 1;
    group.totalCents += amount;
    group.purchases.push({ id: entry.id, amountCents: amount, atMs: toMillis(entry.createdAt) });
    totalCount += 1;
    totalCents += amount;
  }

  const players = [...byUid.values()];
  for (const p of players) p.purchases.sort((a, b) => b.atMs - a.atMs);
  players.sort((a, b) => b.totalCents - a.totalCents || a.username.localeCompare(b.username));

  return { players, totalCount, totalCents };
}
