// Runs `task` now and then every `intervalMs`, pausing while the browser tab is hidden.
// Restarts only when intervalMs or resetKey change; the latest `task` is read from a ref,
// so passing a new function each render never restarts the timer or causes a loop.

import { useEffect, useRef } from 'react';

export function usePolling(task, intervalMs, resetKey) {
  const taskRef = useRef(task);

  // Keep the ref pointing at the newest task. No dependencies on purpose; it sets no state.
  useEffect(() => {
    taskRef.current = task;
  });

  useEffect(() => {
    let stopped = false;

    const run = () => {
      if (stopped) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      taskRef.current();
    };

    run();
    const timer = setInterval(run, intervalMs);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [intervalMs, resetKey]);
}
