// The Baccarat table (0.19.0): the same green felt and wood rail as Blackjack, with PLAYER and BANKER card boxes printed at
// the top (the hand totals in pills beside the names), the shoe at the corner and three printed bet areas under them:
// PLAYER (blue print, pays 1 to 1), BANKER (red print, pays 0.95 to 1, 5% commission) and TIE (green with white print,
// pays 8 to 1). Look only: the spots are buttons that call the same chip handlers as before.
//
// BaccaratFelt draws the table and leaves `spotsRef` (a callback ref) on the empty box the bet areas go into; the seat panel
// whose tab is showing puts its three PrintedSpot buttons there (createPortal), so each spot keeps its seat-specific label.
// Someone who is only watching gets PrintedSpot rendered disabled.

import '../../styles/tablefelt.css';
import { BACCARAT_ODDS, SPOT_LABELS } from '../../../shared/casino/baccarat.js';
import { ChipStack } from './Chips.jsx';
import ResultFx from './ResultFx.jsx';
import Shoe from './Shoe.jsx';

export const PRINT_ODDS = { player: 'pays 1 to 1', banker: 'pays 0.95 to 1', tie: 'pays 8 to 1' };
export const SPOT_ORDER = ['player', 'banker', 'tie'];

// One printed bet area. `fx` = { show, netCents, stakeCents, roundKey } for my result effect on this spot.
export function PrintedSpot({ spot, cents = 0, won = false, disabled, onClick, label, fx = null }) {
  return (
    <button type="button" className={['bac-spot', spot, won ? 'won' : '', cents ? 'has-bet' : ''].filter(Boolean).join(' ')} onClick={onClick} disabled={disabled} aria-label={label}>
      <span className="bac-spot-name">{SPOT_LABELS[spot]}</span>
      <span className="bac-spot-odds">{PRINT_ODDS[spot]}</span>
      {spot === 'banker' ? <span className="bac-spot-note">5% commission</span> : null}
      <span className="bac-spot-chipwrap">
        {cents ? <ChipStack cents={cents} /> : <span className="bac-spot-empty" aria-hidden="true" />}
      </span>
      {fx ? <ResultFx show={fx.show} netCents={fx.netCents} stakeCents={fx.stakeCents} roundKey={fx.roundKey} /> : null}
    </button>
  );
}

export function watcherLabel(spot) {
  return `${SPOT_LABELS[spot]}, pays ${BACCARAT_ODDS[spot].label}. Sit down to bet.`;
}

export default function BaccaratFelt({ player, banker, banner, hint, spotsRef, watcherSpots }) {
  return (
    <div className="tfelt-rail bact-rail">
      <div className="tfelt bact-felt" data-felt="baccarat">
        <div className="bact-head" data-dealer-spot="">
          <span className="bact-title">Baccarat</span>
          <Shoe />
        </div>
        <div className="bact-boxes">
          {player}
          {banker}
        </div>
        {banner}
        {hint}
        <div className="bact-spots" ref={spotsRef}>
          {watcherSpots}
        </div>
      </div>
    </div>
  );
}
