// True while a CSS media query matches. Subscribes to the query's own change event (no resize listener), and the
// subscription is removed on unmount or when the query changes. useSyncExternalStore reads the current value during
// render without setting state, so it can never cause a re-render loop.

import { useCallback, useSyncExternalStore } from 'react';

function mediaList(query) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(query);
}

export function useMediaQuery(query) {
  const subscribe = useCallback(
    (onChange) => {
      const list = mediaList(query);
      if (!list) return () => {};
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  const getSnapshot = () => Boolean(mediaList(query)?.matches);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
