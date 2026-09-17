// Inside <LiveProvider>: turns live events into refetches of the providers
// that sit outside it (session, catalog, public config). Events only say
// "something changed"; the refetch is the truth (DECISIONS D-03).
//
// LiveProvider's context value (and so `subscribe`) changes with every event,
// which re-runs the subscription effect. The debounce timers therefore live in
// a ref and are only cleared on unmount, or a pending refetch would be lost.
import { useEffect, useRef } from 'react';
import { useConfig } from '../../lib/config.tsx';
import { useLive } from '../../lib/live.tsx';
import { useCatalog } from './catalog.tsx';
import { useGuestSession } from './session.tsx';

const DEBOUNCE_MS = 200;
/** A resync right after a fetch (the first "hello") needs no second fetch. */
const FRESH_MS = 3_000;

type Key = 'catalog' | 'session' | 'config';

export function GuestLiveBridge() {
  const live = useLive();
  const session = useGuestSession();
  const catalog = useCatalog();
  const config = useConfig();
  const refs = useRef({ session, catalog, config });
  refs.current = { session, catalog, config };
  const timers = useRef(new Map<Key, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  useEffect(() => {
    const later = (key: Key) => {
      const map = timers.current;
      const old = map.get(key);
      if (old) clearTimeout(old);
      map.set(key, setTimeout(() => {
        map.delete(key);
        const r = refs.current;
        if (key === 'catalog') void r.catalog.refresh();
        else if (key === 'session') void r.session.refresh();
        else void r.config.refresh();
      }, DEBOUNCE_MS));
    };
    const offMenu = live.subscribe(['menu.'], () => later('catalog'));
    const offVisit = live.subscribe(['visit.', 'table.', 'ordering.', 'bill.'], () => later('session'));
    const offConfig = live.subscribe(['ordering.', 'settings.'], () => later('config'));
    const offResync = live.onResync(() => {
      const at = refs.current.catalog.fetchedAt;
      if (!at || Date.now() - at > FRESH_MS) later('catalog');
      later('session');
      later('config');
    });
    return () => { offMenu(); offVisit(); offConfig(); offResync(); };
  }, [live.subscribe, live.onResync]);

  return null;
}
