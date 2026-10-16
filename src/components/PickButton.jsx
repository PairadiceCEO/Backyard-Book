// One selectable price, wired to the bet slip. A missing quote renders "—" and can't be picked.

import OddsButton from './OddsButton.jsx';
import { useBetSlip } from '../context/BetSlipContext.jsx';
import { makePick } from '../lib/betSlipReducer.js';

export default function PickButton({ game, marketType, selection, quote, lineLabel = '', ariaLabel = '' }) {
  const slip = useBetSlip();
  if (!quote) return <OddsButton quote={null} ariaLabel={ariaLabel} />;
  const pick = makePick(game, marketType, selection, quote);
  return (
    <OddsButton
      quote={quote}
      lineLabel={lineLabel}
      ariaLabel={ariaLabel}
      selected={slip.isSelected(pick.legId)}
      onSelect={() => slip.toggle(pick)}
    />
  );
}
