// useResource() that refetches on live events reliably.
//
// lib/live.tsx rebuilds subscribe/onResync on every event, so useResource's
// subscription effect re-runs and its cleanup cancels the debounced refetch
// that the same event had just scheduled: with `topics`, it only refetches
// after a reconnect. This wrapper keeps its own timer (cleared only on
// unmount) and its own resync hook. Reported to the foundation owner.
import { useEffect, useRef } from 'react';
import { useLive, useLiveEvent, useResource, type Resource } from '../../lib/live.tsx';

export function useLiveResource<T>(
  path: string | null,
  opts: { topics: string[]; debounceMs?: number; intervalMs?: number },
): Resource<T> {
  const resource = useResource<T>(path, { intervalMs: opts.intervalMs });
  const live = useLive();
  const refresh = useRef(resource.refresh);
  refresh.current = resource.refresh;
  const active = useRef(path !== null);
  active.current = path !== null;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounce = opts.debounceMs ?? 150;

  useLiveEvent(opts.topics, () => {
    if (!active.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void refresh.current();
    }, debounce);
  });

  // Events may have been missed while disconnected: refetch after every (re)connect.
  useEffect(() => live.onResync(() => { if (active.current) void refresh.current(); }), [live.onResync]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return resource;
}
