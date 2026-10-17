// The five seats in one row, the same on every phone. An empty seat is a "Sit" button for a player
// who isn't seated yet; the caller's own seat is outlined and the detail line comes from the game.

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
          <li key={i} className={classes}>
            <span className="seat-num">{i + 1}</span>
            <span className="seat-name">{seat.uid === myUid ? 'You' : seat.name}</span>
            <span className="seat-detail">{seat.leaving ? 'leaving' : info?.text ?? ''}</span>
          </li>
        );
      })}
    </ol>
  );
}
