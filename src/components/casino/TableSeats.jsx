// The five seats in one row, the same on every phone. An empty seat is a "Sit" button while the player
// may take another seat (any time at Blackjack and Baccarat, only before sitting at Craps); the player's
// own seats are outlined and labelled with their name and "you", and the detail line comes from the game.

import { CASINO_SEATS } from '../../../shared/casino/constants.js';

export default function TableSeats({ seats, myUid, canSit, sitting, onSit, detail }) {
  const list = Array.from({ length: CASINO_SEATS }, (_, i) => seats?.[i] ?? null);
  return (
    <ol className="seat-row" aria-label="Seats">
      {list.map((seat, i) => {
        if (!seat) {
          return (
            <li key={i} className="seat-tile empty">
              {canSit ? (
                <button type="button" className="seat-sit" onClick={() => onSit(i)} disabled={sitting} aria-label={`Sit in seat ${i + 1}`}>
                  <span className="seat-num">{i + 1}</span>
                  <span>Sit</span>
                </button>
              ) : (
                <span className="seat-open">
                  <span className="seat-num">{i + 1}</span>
                  <span className="muted">Empty</span>
                </span>
              )}
            </li>
          );
        }
        const info = detail ? detail(seat, i) : null;
        const classes = ['seat-tile', seat.uid === myUid ? 'mine' : '', seat.leaving ? 'leaving' : '', info?.tone ?? ''].filter(Boolean).join(' ');
        return (
          <li key={i} className={classes} aria-label={`Seat ${i + 1}: ${seat.name}${seat.uid === myUid ? ' (you)' : ''}`}>
            <span className="seat-num">{i + 1}</span>
            <span className="seat-name">{seat.name}</span>
            {seat.uid === myUid ? <span className="seat-you">you</span> : null}
            <span className="seat-detail">{seat.leaving ? 'leaving' : info?.text ?? ''}</span>
          </li>
        );
      })}
    </ol>
  );
}
