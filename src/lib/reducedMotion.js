// prefers-reduced-motion, read when an animation is about to start (not subscribed: an animation is short and a person
// changing the setting mid-hand just gets the new answer on the next card).
export function prefersReducedMotion() {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
