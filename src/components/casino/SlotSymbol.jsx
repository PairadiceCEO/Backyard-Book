// One slot symbol drawn with plain HTML/CSS (no images): Red 7, Blue 7, BARs, Cherry or Blank.

const BAR_COUNT = { BAR3: 3, BAR2: 2, BAR1: 1 };
const NAMES = { R7: 'Red 7', B7: 'Blue 7', BAR3: 'Triple BAR', BAR2: 'Double BAR', BAR1: 'Single BAR', CH: 'Cherry', BL: 'Blank' };

export default function SlotSymbol({ id, small = false }) {
  const size = small ? ' small' : '';
  if (id === 'R7' || id === 'B7') {
    return (
      <span className={`sym sym-seven ${id === 'R7' ? 'red' : 'blue'}${size}`} role="img" aria-label={NAMES[id]}>
        7
      </span>
    );
  }
  if (BAR_COUNT[id]) {
    return (
      <span className={`sym sym-bars${size}`} role="img" aria-label={NAMES[id]}>
        {Array.from({ length: BAR_COUNT[id] }, (_, i) => (
          <span key={i} className="bar">
            BAR
          </span>
        ))}
      </span>
    );
  }
  if (id === 'CH') {
    return (
      <span className={`sym sym-cherry${size}`} role="img" aria-label="Cherry">
        🍒
      </span>
    );
  }
  if (id === null || id === undefined) {
    return <span className={`sym sym-any${size}`} aria-label="Any symbol">any</span>;
  }
  return <span className={`sym sym-blank${size}`} aria-label="Blank" />;
}
