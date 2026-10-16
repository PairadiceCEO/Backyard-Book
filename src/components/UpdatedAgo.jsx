// "Updated 12s ago". Re-renders only itself once per second, not the whole board.

import { useEffect, useState } from 'react';

function describe(seconds) {
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ago`;
}

export default function UpdatedAgo({ timestamp }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const time = timestamp ? new Date(timestamp).getTime() : NaN;
  if (!Number.isFinite(time)) return null;
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  return <span className="muted small">Updated {describe(seconds)}</span>;
}
