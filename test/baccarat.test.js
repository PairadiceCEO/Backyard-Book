// npm test: Baccarat's drawing rules and payouts.
// The odds test plays every possible deal from a full 8-deck shoe through the real playCoup and checks
// the published exact results, so any change to the tableau shows up immediately.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bankerDraws,
  playCoup,
  playerDraws,
  settleBaccaratBets,
  spotReturnCents,
} from '../shared/casino/baccarat.js';

test('Banker tableau matches the standard chart', () => {
  // Rows: Banker two-card total 0–7. Columns: Player third card value 0–9. D = draw, S = stand.
  const chart = {
    0: 'DDDDDDDDDD',
    1: 'DDDDDDDDDD',
    2: 'DDDDDDDDDD',
    3: 'DDDDDDDDSD',
    4: 'SSDDDDDDSS',
    5: 'SSSSDDDDSS',
    6: 'SSSSSSDDSS',
    7: 'SSSSSSSSSS',
  };
  for (let banker = 0; banker <= 7; banker += 1) {
    for (let third = 0; third <= 9; third += 1) {
      assert.equal(bankerDraws(banker, third), chart[banker][third] === 'D', `Banker ${banker}, Player third card ${third}`);
    }
    assert.equal(bankerDraws(banker, null), banker <= 5, `Banker ${banker} when the Player stood`);
  }
  for (let total = 0; total <= 7; total += 1) assert.equal(playerDraws(total), total <= 5);
});

test('8-deck exact odds: Banker 45.8597%, Player 44.6247%, Tie 9.5156%', () => {
  const rankFor = ['K', 'A', '2', '3', '4', '5', '6', '7', '8', '9'];
  const left = [128, 32, 32, 32, 32, 32, 32, 32, 32, 32]; // cards of each value in 8 decks
  const totals = { player: 0, banker: 0, tie: 0 };
  const needMore = Symbol('needMore');

  function explore(prefix, probability, cardsLeft) {
    let i = 0;
    let coup;
    try {
      coup = playCoup(() => {
        if (i >= prefix.length) throw needMore;
        return `${rankFor[prefix[i++]]}S0`;
      });
    } catch (signal) {
      if (signal !== needMore) throw signal;
      for (let value = 0; value < 10; value += 1) {
        if (!left[value]) continue;
        const p = left[value] / cardsLeft;
        left[value] -= 1;
        explore([...prefix, value], probability * p, cardsLeft - 1);
        left[value] += 1;
      }
      return;
    }
    totals[coup.winner] += probability;
  }

  explore([], 1, 416);
  assert.ok(Math.abs(totals.banker - 0.458597) < 5e-6, `Banker ${totals.banker}`);
  assert.ok(Math.abs(totals.player - 0.446247) < 5e-6, `Player ${totals.player}`);
  assert.ok(Math.abs(totals.tie - 0.095156) < 5e-6, `Tie ${totals.tie}`);
});

test('payouts: Player 1:1, Banker 0.95:1, Tie 8:1, Tie pushes Player and Banker', () => {
  assert.equal(spotReturnCents('player', 500, 'player'), 1000);
  assert.equal(spotReturnCents('banker', 300, 'banker'), 585);
  assert.equal(spotReturnCents('tie', 100, 'tie'), 900);
  assert.equal(spotReturnCents('player', 500, 'tie'), 500);
  assert.equal(spotReturnCents('banker', 500, 'tie'), 500);
  assert.equal(spotReturnCents('banker', 500, 'player'), 0);
  assert.deepEqual(settleBaccaratBets({ player: 0, banker: 300, tie: 100 }, 'banker'), { stakeCents: 400, returnCents: 585, netCents: 185 });
});
