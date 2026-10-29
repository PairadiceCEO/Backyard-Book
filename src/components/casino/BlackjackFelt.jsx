// The Blackjack table (0.26.0): a real casino felt, edge to edge (560 px on a computer), with the dealer's chip tray at the top
// centre, the discard holder and the shoe in the corners, the dealer's cards and total pill under the tray, "BLACKJACK PAYS 3 TO 2"
// and "DEALER MUST HIT SOFT 17" printed in Cinzel, a curved insurance band ("INSURANCE PAYS 2 TO 1" along its curve) and five
// card-shaped betting spots on a curve (the centre one lowest, the outer ones higher and turned toward the centre), with the black
// rail along the players' edge. Mine glow gold; an empty one is dashed with "OPEN". Above each spot are that seat's cards (a split's
// hands side by side) under a total pill; the bet is a stack of chips in the spot; a small 21+3 circle sits at its lower right.
// Look only: every action still goes through the page's handlers.
//
// Props: seats; myUid; mySeats (my seat numbers); focus (the seat whose panel shows); onFocus(i); sitting/onSit(i);
// detail(seat, i) → { text, tone } for the line under a spot; betFor(seat, i) → cents to draw; dealer (the dealer's HandView);
// handsFor(seat, i) → [{ cards, dealAts, total, bust, active }] (the cards face up now, and when each turns, for the slide from
// the shoe); sideFor(seat, i) → { cents, tone ('win' | 'lose' | ''), text } or null (21+3); results (cards that decide it are
// face up); roundKey (changes each hand).
// 0.26.0 betting on the felt: slotRef(kind, i) gives a callback ref for an empty target inside seat i's spot ('bet') or its 21+3
// circle ('side'); the seat panel of my seat draws its real bet buttons into them (createPortal) while the table is taking
// bets, so the spot and the 21+3 circle on the felt are the buttons. portalSeats = the seats whose targets are in use (the felt
// then doesn't draw its own static chips there).

import { CASINO_SEATS } from '../../../shared/casino/constants.js';
import { DEALER_HITS_SOFT_17 } from '../../../shared/casino/blackjack.js';
import { cardName } from '../../../shared/casino/cards.js';
import FeltDecor from './FeltDecor.jsx';
import { FeltChip } from './FeltChip.jsx';
import { ChipStack } from './Chips.jsx';
import PlayingCard from './PlayingCard.jsx';
import ResultFx from './ResultFx.jsx';
import '../../styles/casinofelt.css';
import '../../styles/bjfelt.css';

// The felt is drawn in a 390 × 456 box (everything scales with its width). Where each spot's centre-x and top-y sit, and how far
// it is turned toward the centre (degrees).
export const FELT_W = 390;
export const FELT_H = 456;
export const SEAT_POS = [
  { x: 50, y: 280, rot: 13 },
  { x: 123, y: 322, rot: 7 },
  { x: 195, y: 338, rot: 0 },
  { x: 267, y: 322, rot: -7 },
  { x: 340, y: 280, rot: -13 },
];

// The insurance band: a smile from near the left edge to near the right edge (a quadratic curve, 28 thick).
const BAND = 'M 12 170 Q 195 238 378 170';

export const FELT_LINES = {
  pays: 'BLACKJACK PAYS 3 TO 2',
  soft17: DEALER_HITS_SOFT_17 ? 'DEALER MUST HIT SOFT 17' : 'DEALER STANDS ON SOFT 17',
  insurance: 'INSURANCE PAYS 2 TO 1',
};

// A seat's hands as real cards (34 × 48 at 390), each hand under its total pill.
function SeatHands({ hands }) {
  const shown = hands.filter((h) => h.cards.length);
  if (!shown.length) return null;
  const label = shown.map((h, j) => `${shown.length > 1 ? `Hand ${j + 1}: ` : ''}${h.cards.map(cardName).join(', ')}, ${h.total}`).join('; ');
  return (
    <div className={shown.length > 1 ? 'bjt-hands split' : 'bjt-hands'} role="img" aria-label={label}>
      {shown.map((h, j) => (
        <div key={j} className={['bjt-mini-hand', h.active ? 'active' : '', h.bust ? 'bust' : ''].filter(Boolean).join(' ')} style={{ '--n': h.cards.length }}>
          <span className={h.bust ? 'bjt-mini-total bust' : 'bjt-mini-total'} aria-hidden="true">
            {h.total}
          </span>
          <span className="bjt-mini-cards" aria-hidden="true">
            {h.cards.map((card, k) => (
              <PlayingCard key={card} card={card} seat fresh dealAt={h.dealAts ? h.dealAts[k] ?? null : null} />
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function BlackjackFelt({
  seats,
  myUid,
  mySeats,
  focus,
  onFocus,
  sitting,
  onSit,
  detail,
  betFor,
  handsFor = null,
  sideFor = null,
  dealer,
  results,
  roundKey,
  slotRef = null,
  portalSeats = [],
}) {
  const multi = mySeats.length > 1;
  return (
    <div className="cfelt-box">
      <div className="cfelt bjt-felt" data-felt="blackjack">
        <FeltDecor />

        <svg className="bjt-print" viewBox={`0 0 ${FELT_W} ${FELT_H}`} aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="bjt-gold" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#a97b2c" />
              <stop offset="50%" stopColor="#e2bd62" />
              <stop offset="100%" stopColor="#a97b2c" />
            </linearGradient>
            <path id="bjt-band-path" d={BAND} fill="none" />
            <mask id="bjt-band-mask" maskUnits="userSpaceOnUse" x="0" y="0" width={FELT_W} height={FELT_H}>
              <rect width={FELT_W} height={FELT_H} fill="#fff" />
              <path d={BAND} fill="none" stroke="#000" strokeWidth="26.6" strokeLinecap="round" />
            </mask>
          </defs>
          <text x="195" y="150" textAnchor="middle" className="bjt-pays">
            {FELT_LINES.pays}
          </text>
          <text x="195" y="165" textAnchor="middle" className="bjt-soft">
            {FELT_LINES.soft17}
          </text>
          <path d={BAND} fill="none" stroke="rgba(0,0,0,0.12)" strokeWidth="26.6" strokeLinecap="round" />
          <path d={BAND} fill="none" stroke="url(#bjt-gold)" strokeWidth="28" strokeLinecap="round" mask="url(#bjt-band-mask)" />
          <text className="bjt-band-text" dy="3.4">
            <textPath href="#bjt-band-path" startOffset="50%" textAnchor="middle">
              {FELT_LINES.insurance}
            </textPath>
          </text>
        </svg>

        <div className="bjt-dealer">{dealer}</div>

        <ol className="bjt-seats" aria-label="Seats">
          {Array.from({ length: CASINO_SEATS }, (_, i) => {
            const seat = seats?.[i] ?? null;
            const pos = SEAT_POS[i];
            const style = { left: `${(pos.x / FELT_W) * 100}%`, top: `${(pos.y / FELT_H) * 100}%`, '--rot': `${pos.rot}deg` };
            if (!seat) {
              return (
                <li key={i} className="bjt-seat empty" style={style}>
                  <div className="bjt-circle-wrap">
                    <button type="button" className="bjt-circle bjt-spot" onClick={() => onSit(i)} disabled={sitting} aria-label={`Sit in seat ${i + 1}`}>
                      <span className="bjt-open">OPEN</span>
                    </button>
                  </div>
                </li>
              );
            }
            const mine = seat.uid === myUid;
            const info = detail(seat, i);
            const cents = betFor(seat, i);
            const side = sideFor ? sideFor(seat, i) : null;
            const portal = mine && portalSeats.includes(i);
            const label = `Seat ${i + 1}: ${seat.name}${mine ? ' (you)' : ''}${side ? `, 21+3 ${(side.cents / 100).toFixed(0)} dollars${side.tone ? (side.tone === 'win' ? ', won' : ', lost') : ''}` : ''}`;
            const classes = ['bjt-seat', mine ? 'mine' : 'other', seat.leaving ? 'leaving' : '', focus === i && multi ? 'focused' : '', info?.tone ?? ''].filter(Boolean).join(' ');
            const stack = cents > 0 ? <ChipStack cents={cents} /> : <span className="bjt-num">{i + 1}</span>;
            return (
              <li key={i} className={classes} style={style} aria-label={label}>
                <div className="bjt-circle-wrap">
                  {handsFor ? <SeatHands hands={handsFor(seat, i)} /> : null}
                  <div className="bjt-spot">
                    {mine && slotRef ? <span className="bjt-slot bjt-bet-slot" ref={slotRef('bet', i)} /> : null}
                    {portal ? null : mine && multi ? (
                      <button type="button" className="bjt-circle" onClick={() => onFocus(i)} aria-label={`${label}. Show this seat's controls.`}>
                        {stack}
                      </button>
                    ) : (
                      <span className="bjt-circle" aria-hidden="true">
                        {stack}
                      </span>
                    )}
                  </div>
                  {mine && slotRef ? <span className="bjt-slot bjt-side-slot" ref={slotRef('side', i)} /> : null}
                  {portal ? null : side ? (
                    <span className={['bjt-side', side.tone].filter(Boolean).join(' ')} data-side-marker="" aria-hidden="true">
                      <FeltChip cents={side.cents} className="bjt-side-chip" />
                    </span>
                  ) : (
                    <span className="bjt-side idle" aria-hidden="true">
                      <span className="bjt-side-label">21+3</span>
                    </span>
                  )}
                  {mine && seat.hands?.length && seat.result ? (
                    <ResultFx show={results} netCents={seat.result.netCents} stakeCents={cents} roundKey={`${roundKey}-${i}`} />
                  ) : null}
                </div>
                <span className="bjt-name">{seat.name}</span>
                <span className="bjt-detail" aria-hidden="true">
                  {seat.leaving ? 'leaving' : info?.text ?? ''}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
