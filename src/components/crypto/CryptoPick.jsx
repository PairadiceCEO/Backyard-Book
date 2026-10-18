// One side of a crypto market (Up / Down, Above / Below), wired to the bet slip. When betting on the market is
// closed (its last 60 s, or no price) it shows "Closed" and can't be picked.

import OddsButton from '../OddsButton.jsx';
import { useBetSlip } from '../../context/BetSlipContext.jsx';
import { makeCryptoPick } from '../../lib/crypto.js';

export default function CryptoPick({ coin, section, row, side, label, open }) {
  const slip = useBetSlip();
  const pick = open ? makeCryptoPick(coin, section, row, side) : null;
  if (!pick) {
    return (
      <span className="odds-cell unavailable crypto-closed" aria-label={`${label}: closed`}>
        <span className="odds-line">{label}</span>
        <span>Closed</span>
      </span>
    );
  }
  return (
    <OddsButton
      quote={row[side]}
      lineLabel={label}
      ariaLabel={pick.label}
      selected={slip.isSelected(pick.legId)}
      onSelect={() => slip.toggle(pick)}
    />
  );
}
