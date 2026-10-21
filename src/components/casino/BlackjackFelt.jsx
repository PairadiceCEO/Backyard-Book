// The Blackjack table (0.19.0): green felt in a wood rail, a half-moon with the dealer and the shoe at the top, the table's
// rules printed in an arc across the middle (Oswald, uppercase) and the five seats as betting circles around the curve:
// mine outlined in gold, other players' in white, an empty one dashed with "Sit". Each circle holds the seat's chips; the
// player's name and a short status sit under it. Look only: every action still goes through the page's handlers.
//
// Props: seats; myUid; mySeats (my seat numbers); focus (the seat whose panel shows); onFocus(i); sitting/onSit(i);
// detail(seat, i) → { text, tone } for the line under a circle; betFor(seat, i) → cents to draw; dealer (the dealer's
// HandView); results (cards that decide it are face up); roundKey (changes each hand).

import '../../styles/tablefelt.css';
import { CASINO_SEATS } from '../../../shared/casino/constants.js';
import { FeltChip } from './FeltChip.jsx';
import ResultFx from './ResultFx.jsx';
import Shoe from './Shoe.jsx';

// Where each circle's centre sits, in the 300 × 310 drawing the arcs use (x, y).
export const FELT_W = 300;
export const FELT_H = 310;
export const SEAT_XY = [
  [42, 190],
  [96, 226],
  [150, 242],
  [204, 226],
  [258, 190],
];
const CIRCLE_R = 25.5;
const SLOT_W = 18; // percent of the felt width each seat's column takes

// The printed lines, top to bottom: [text, y of the arc's ends, class].
export const FELT_LINES = [
  ['BLACKJACK PAYS 3 TO 2', 96, 'gold'],
  ['DEALER MUST HIT SOFT 17', 122, ''],
  ['INSURANCE PAYS 2 TO 1', 146, ''],
];

export default function BlackjackFelt({ seats, myUid, mySeats, focus, onFocus, sitting, onSit, detail, betFor, dealer, results, roundKey }) {
  const multi = mySeats.length > 1;
  return (
    <div className="tfelt-rail bjt-rail">
      <div className="tfelt bjt-felt" data-felt="blackjack">
        <svg className="bjt-arcs" viewBox={`0 0 ${FELT_W} ${FELT_H}`} aria-hidden="true" focusable="false">
          <defs>
            {FELT_LINES.map(([, y], k) => (
              <path key={k} id={`bjt-arc-${k}`} d={`M 26 ${y} Q 150 ${y + 48} 274 ${y}`} fill="none" />
            ))}
          </defs>
          {FELT_LINES.map(([text, , tone], k) => (
            <text key={text} className={tone ? `bjt-arc-text ${tone}` : 'bjt-arc-text'}>
              <textPath href={`#bjt-arc-${k}`} startOffset="50%" textAnchor="middle">
                {text}
              </textPath>
            </text>
          ))}
        </svg>

        <div className="bjt-dealer" data-dealer-spot="">
          {dealer}
        </div>
        <Shoe className="bjt-shoe" />

        <ol className="bjt-seats" aria-label="Seats">
          {Array.from({ length: CASINO_SEATS }, (_, i) => {
            const seat = seats?.[i] ?? null;
            const [x, y] = SEAT_XY[i];
            const style = { left: `${(x / FELT_W) * 100}%`, top: `${((y - CIRCLE_R) / FELT_H) * 100}%`, width: `${SLOT_W}%`, marginLeft: `${-SLOT_W / 2}%` };
            if (!seat) {
              return (
                <li key={i} className="bjt-seat empty" style={style}>
                  <button type="button" className="bjt-circle" onClick={() => onSit(i)} disabled={sitting} aria-label={`Sit in seat ${i + 1}`}>
                    <span className="bjt-sit">Sit</span>
                  </button>
                </li>
              );
            }
            const mine = seat.uid === myUid;
            const info = detail(seat, i);
            const cents = betFor(seat, i);
            const label = `Seat ${i + 1}: ${seat.name}${mine ? ' (you)' : ''}`;
            const classes = ['bjt-seat', mine ? 'mine' : 'other', seat.leaving ? 'leaving' : '', focus === i && multi ? 'focused' : '', info?.tone ?? ''].filter(Boolean).join(' ');
            const inner = cents > 0 ? <FeltChip cents={cents} className="spot-chip" /> : <span className="bjt-num">{i + 1}</span>;
            return (
              <li key={i} className={classes} style={style} aria-label={label}>
                <div className="bjt-circle-wrap">
                  {mine && multi ? (
                    <button type="button" className="bjt-circle" onClick={() => onFocus(i)} aria-label={`${label}. Show this seat's controls.`}>
                      {inner}
                    </button>
                  ) : (
                    <span className="bjt-circle" aria-hidden="true">
                      {inner}
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
