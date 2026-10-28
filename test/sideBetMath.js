// Test helper (not a test file): exact and simulated returns for the side bets in shared/casino/sideBets.js.
//   exactBaccaratSideEdges(decks)   every possible coup from a full shoe, by card value, through the real tableau
//   exactTwentyOne3Edge(decks)      every ordered three-card draw from a full shoe
//   simulateBaccaratSides(rounds, seed), simulateTwentyOne3(rounds, seed)   a shuffled shoe dealt round after round
// Each returns { edge: { [bet]: house edge in percent } } (and the simulations their standard errors in points).

import { bankerDraws, handTotal, playCoup, playerDraws } from '../shared/casino/baccarat.js';
import { buildShoe } from '../shared/casino/cards.js';
import { BACCARAT_SIDE_SPOTS, baccaratSideReturnCents, twentyOne3ReturnCents } from '../shared/casino/sideBets.js';

const VALUE_CARD = ['T', 'A', '2', '3', '4', '5', '6', '7', '8', '9']; // a card of each baccarat value
const fake = (v) => `${VALUE_CARD[v]}S0`;

// Deterministic PRNG (mulberry32) so a simulation gives the same numbers on every run.
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(cards, rnd) {
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

// ---------- Baccarat, exact ----------
export function exactBaccaratSideEdges(decks = 8) {
  const counts = [16 * decks, ...Array(9).fill(4 * decks)]; // value 0 = 10/J/Q/K
  let left = 52 * decks;
  const ev = Object.fromEntries(BACCARAT_SIDE_SPOTS.map((s) => [s, 0]));
  const main = { player: 0, banker: 0, tie: 0 };
  const take = (v) => {
    const p = counts[v] / left;
    counts[v] -= 1;
    left -= 1;
    return p;
  };
  const put = (v) => {
    counts[v] += 1;
    left += 1;
  };
  const finish = (pv, bv, prob) => {
    const player = pv.map(fake);
    const banker = bv.map(fake);
    const playerTotal = handTotal(player);
    const bankerTotal = handTotal(banker);
    const winner = playerTotal > bankerTotal ? 'player' : bankerTotal > playerTotal ? 'banker' : 'tie';
    const natural = handTotal(player.slice(0, 2)) >= 8 || handTotal(banker.slice(0, 2)) >= 8;
    const coup = { player, banker, playerTotal, bankerTotal, winner, natural };
    main[winner] += prob;
    for (const s of BACCARAT_SIDE_SPOTS) ev[s] += prob * (baccaratSideReturnCents(s, 100, coup) / 100 - 1);
  };
  for (let p1 = 0; p1 < 10; p1 += 1) {
    const a = take(p1);
    for (let b1 = 0; b1 < 10; b1 += 1) {
      const b = take(b1);
      for (let p2 = 0; p2 < 10; p2 += 1) {
        const c = take(p2);
        for (let b2 = 0; b2 < 10; b2 += 1) {
          const d = take(b2);
          const prob4 = a * b * c * d;
          if (prob4 > 0) {
            const pt = (p1 + p2) % 10;
            const bt = (b1 + b2) % 10;
            if (pt >= 8 || bt >= 8) finish([p1, p2], [b1, b2], prob4);
            else if (playerDraws(pt)) {
              for (let p3 = 0; p3 < 10; p3 += 1) {
                const e = take(p3);
                if (e > 0) {
                  if (bankerDraws(bt, p3)) {
                    for (let b3 = 0; b3 < 10; b3 += 1) {
                      const f = take(b3);
                      if (f > 0) finish([p1, p2, p3], [b1, b2, b3], prob4 * e * f);
                      put(b3);
                    }
                  } else finish([p1, p2, p3], [b1, b2], prob4 * e);
                }
                put(p3);
              }
            } else if (bankerDraws(bt, null)) {
              for (let b3 = 0; b3 < 10; b3 += 1) {
                const f = take(b3);
                if (f > 0) finish([p1, p2], [b1, b2, b3], prob4 * f);
                put(b3);
              }
            } else finish([p1, p2], [b1, b2], prob4);
          }
          put(b2);
        }
        put(p2);
      }
      put(b1);
    }
    put(p1);
  }
  return { edge: Object.fromEntries(Object.entries(ev).map(([s, v]) => [s, -100 * v])), main };
}

// ---------- 21+3, exact ----------
export function exactTwentyOne3Edge(decks = 6) {
  const types = buildShoe(1); // 52 distinct cards; each appears `decks` times
  const n = 52 * decks;
  let ev = 0;
  for (let i = 0; i < 52; i += 1) {
    for (let j = 0; j < 52; j += 1) {
      for (let k = 0; k < 52; k += 1) {
        const ways = decks * (decks - (j === i ? 1 : 0)) * (decks - (k === i ? 1 : 0) - (k === j ? 1 : 0));
        if (ways <= 0) continue;
        const prob = ways / (n * (n - 1) * (n - 2));
        ev += prob * (twentyOne3ReturnCents(100, [types[i], types[j], types[k]]) / 100 - 1);
      }
    }
  }
  return { edge: -100 * ev };
}

// ---------- simulations ----------
function stats(sum, sumSq, rounds) {
  const mean = sum / rounds;
  const sd = Math.sqrt(Math.max(0, sumSq / rounds - mean * mean));
  return { edge: -100 * mean, se: (100 * sd) / Math.sqrt(rounds) };
}

// Plays `rounds` coups from a shuffled 8-deck shoe through the real playCoup, reshuffling at the cut card (354 dealt).
export function simulateBaccaratSides(rounds = 1_000_000, seed = 2026, decks = 8) {
  const rnd = seededRandom(seed);
  let shoe = shuffle(buildShoe(decks), rnd);
  let pos = 0;
  const sum = Object.fromEntries(BACCARAT_SIDE_SPOTS.map((s) => [s, 0]));
  const sumSq = { ...sum };
  for (let r = 0; r < rounds; r += 1) {
    if (pos >= 354) {
      shoe = shuffle(shoe, rnd);
      pos = 0;
    }
    const coup = playCoup(() => shoe[pos++]);
    for (const s of BACCARAT_SIDE_SPOTS) {
      const net = baccaratSideReturnCents(s, 100, coup) / 100 - 1;
      sum[s] += net;
      sumSq[s] += net * net;
    }
  }
  return Object.fromEntries(BACCARAT_SIDE_SPOTS.map((s) => [s, stats(sum[s], sumSq[s], rounds)]));
}

// Deals the player's two cards and the dealer's up card from a shuffled 6-deck shoe, reshuffling at 75%.
export function simulateTwentyOne3(rounds = 1_000_000, seed = 2026, decks = 6) {
  const rnd = seededRandom(seed);
  let shoe = shuffle(buildShoe(decks), rnd);
  let pos = 0;
  let sum = 0;
  let sumSq = 0;
  const cut = Math.floor(52 * decks * 0.75);
  for (let r = 0; r < rounds; r += 1) {
    if (pos >= cut) {
      shoe = shuffle(shoe, rnd);
      pos = 0;
    }
    const net = twentyOne3ReturnCents(100, [shoe[pos], shoe[pos + 1], shoe[pos + 2]]) / 100 - 1;
    pos += 3;
    sum += net;
    sumSq += net * net;
  }
  return stats(sum, sumSq, rounds);
}
