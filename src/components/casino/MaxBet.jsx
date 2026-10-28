// Max bet (0.23.0, Blackjack and Baccarat): one button next to Rebet that puts everything the wallet has left onto one spot of
// one seat, after a confirm step so it can't be tapped by accident. It adds the chips through the page's normal chip path
// (useChipBetting.place): the same validation, one Undo entry, the same batching and 0.17.2 reply logic.
//   spotName        what the spot is called in the text ('your bet', 'Player', 'Banker', 'Tie')
//   currentCents    what the spot holds now on this screen (confirmed + not yet confirmed)
//   availableCents  the wallet left for this seat: the balance minus every chip not confirmed yet, on any seat
//   onPlace(cents)  adds that many cents to the spot through the chip path; returns false if it was refused (the reason shows)
//   onRefuse(text)  shows why Max can't put anything down
// One bet is never more than the casino's $1,000,000 ceiling: past it Max stops at $1,000,000 and says so with the usual
// message.

import { useEffect, useState } from 'react';
import { formatMoney } from '../../lib/format.js';
import { BET_CEILING_MESSAGE } from '../../../shared/casino/constants.js';
import { maxBetPlan } from '../../../shared/casino/maxBet.js';

export default function MaxBet({ spotName, currentCents, availableCents, onPlace, onRefuse, disabled = false }) {
  const [asking, setAsking] = useState(null); // the plan waiting for "Yes"
  // A new round, a confirmed seat or the betting closing: forget a question nobody answered.
  useEffect(() => {
    if (disabled) setAsking(null);
  }, [disabled]);

  const refuseText = (why) => (why === 'ceiling' ? BET_CEILING_MESSAGE : `Not enough in your wallet (${formatMoney(Math.max(0, availableCents))}).`);

  function ask() {
    const plan = maxBetPlan(currentCents, availableCents);
    if (plan.refuse) {
      onRefuse(refuseText(plan.refuse));
      return;
    }
    setAsking(plan);
  }

  function yes() {
    // Worked out again at the tap (chips may have gone down or come back since the question), never more than was asked.
    const plan = maxBetPlan(currentCents, availableCents);
    const asked = asking;
    setAsking(null);
    if (plan.refuse) onRefuse(refuseText(plan.refuse));
    else onPlace(Math.min(plan.addCents, asked.addCents));
  }

  if (asking) {
    const question = asking.capped
      ? `${BET_CEILING_MESSAGE} Bet the most one bet can be, ${formatMoney(asking.totalCents)} on ${spotName}?`
      : `Bet your whole wallet, ${formatMoney(asking.addCents)}${currentCents > 0 ? ` (${formatMoney(asking.totalCents)} on ${spotName} in all)` : ` on ${spotName}`}?`;
    return (
      <div className="max-confirm" role="group" aria-label="Confirm max bet">
        <p className="max-question">{question}</p>
        <div className="max-actions">
          <button type="button" className="btn btn-primary max-yes" onClick={yes} disabled={disabled}>
            Yes, bet {formatMoney(asking.capped ? asking.totalCents : asking.addCents)}
          </button>
          <button type="button" className="btn max-no" onClick={() => setAsking(null)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <button type="button" className="rebet-btn max-btn" onClick={ask} disabled={disabled} aria-label={`Max: bet your whole wallet on ${spotName}`}>
      Max
    </button>
  );
}
