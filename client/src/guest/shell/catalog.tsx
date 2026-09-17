// The published guest catalog (GET /api/public/menu), shared by the menu,
// the item sheet, the cart and tracking. Refreshed on 'menu.' live events
// (GuestLiveBridge), after a reconnect, when the guest joins or leaves a
// table, and when the page becomes visible again. Older data stays on screen
// when a refresh fails (`stale`).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { CatalogDTO, MenuCategoryDTO, MenuItemDTO } from '../../../../shared/dto.ts';
import type { ApiError } from '../../lib/api.ts';
import { useResource } from '../../lib/live.tsx';
import { useGuestSession } from './session.tsx';

export interface CatalogApi {
  catalog?: CatalogDTO;
  item: (id: string) => MenuItemDTO | undefined;
  category: (id: string) => MenuCategoryDTO | undefined;
  refresh: () => Promise<void>;
  error: ApiError | null;
  loading: boolean;
  /** A refresh failed while an older catalog is still shown. */
  stale: boolean;
  fetchedAt: number | null;
}

const CatalogContext = createContext<CatalogApi>({
  catalog: undefined,
  item: () => undefined,
  category: () => undefined,
  refresh: async () => {},
  error: null,
  loading: true,
  stale: false,
  fetchedAt: null,
});

const VISIBLE_THROTTLE_MS = 30_000;

export function CatalogProvider({ children }: { children: ReactNode }) {
  const r = useResource<CatalogDTO>('/api/public/menu');
  const { mode } = useGuestSession();
  const refreshRef = useRef(r.refresh);
  refreshRef.current = r.refresh;
  const fetchedAt = useRef(r.fetchedAt);
  fetchedAt.current = r.fetchedAt;

  // Joining or leaving can change what the guest may order: refetch (not on the first answer).
  const lastMode = useRef(mode);
  useEffect(() => {
    const prev = lastMode.current;
    lastMode.current = mode;
    if (prev === mode || prev === 'loading') return;
    void refreshRef.current();
  }, [mode]);

  // Public browsers have no live stream: refetch when the page comes back into view.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (fetchedAt.current && Date.now() - fetchedAt.current < VISIBLE_THROTTLE_MS) return;
      void refreshRef.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, []);

  const data = r.data;
  const maps = useMemo(() => ({
    items: new Map((data?.items ?? []).map((i) => [i.id, i] as const)),
    categories: new Map((data?.categories ?? []).map((c) => [c.id, c] as const)),
  }), [data]);

  const item = useCallback((id: string) => maps.items.get(id), [maps]);
  const category = useCallback((id: string) => maps.categories.get(id), [maps]);
  const refresh = useCallback(() => refreshRef.current(), []);

  const value = useMemo<CatalogApi>(() => ({
    catalog: data,
    item,
    category,
    refresh,
    error: r.error,
    loading: r.loading,
    stale: r.stale,
    fetchedAt: r.fetchedAt,
  }), [data, item, category, refresh, r.error, r.loading, r.stale, r.fetchedAt]);

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): CatalogApi {
  return useContext(CatalogContext);
}
