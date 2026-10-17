// One die drawn with CSS pips. `rolling` tumbles it (the real value is already decided on the server).

const PIPS = {
  1: [5],
  2: [1, 9],
  3: [1, 5, 9],
  4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9],
  6: [1, 3, 4, 6, 7, 9],
};

export default function Die({ value, rolling = false }) {
  const pips = rolling ? [] : PIPS[value] ?? [];
  return (
    <span className={rolling ? 'die rolling' : 'die'} role="img" aria-label={rolling ? 'Rolling' : `Die showing ${value}`}>
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className={pips.includes(i + 1) ? 'pip on' : 'pip'} />
      ))}
    </span>
  );
}
