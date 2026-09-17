// Refetch on live events with a debounce that survives re-subscription.
//
// History: lib/live.tsx used to re-create `subscribe` on every event, which
// cancelled useResource's pending refetch. The foundation is fixed
// (subscribe/onResync are stable), so the Orders screens now rely on
// useResource({ topics }) directly. Kept for refetching things that are not a
// useResource (none at the moment).
import { useEffect, useRef } from 'react';
import { useLiveEvent } from '../../lib/live.tsx';

export function useLiveRefresh(prefixes: string[], refresh: () => unknown, enabled = true, ms = 200): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fn = useRef(refresh);
  fn.current = refresh;
  const on = useRef(enabled);
  on.current = enabled;
  useLiveEvent(prefixes, () => {
    if (!on.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void fn.current();
    }, ms);
  });
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
}
