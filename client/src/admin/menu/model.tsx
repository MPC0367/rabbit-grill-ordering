// Menu admin (C6): one shared copy of the admin catalog for every tab, plus
// the small helpers the tabs share (money text, search, error wording).
//
// The catalog refetches on `menu.` and `ordering.` live events and after every
// reconnect. A mutation's answer is kept as an override until a later fetch
// catches up with it, so a slow refetch never flashes the old state back.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AdminCatalogDTO, AdminItemDTO } from '../../../../shared/dto.ts';
import type { Permission } from '../../../../shared/permissions.ts';
import { ApiError } from '../../lib/api.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { useLive, useLiveEvent, useResource, type Resource } from '../../lib/live.tsx';
import { navigate } from '../../lib/router.ts';
import { normalizeSearch } from '../../ui/index.ts';
import { useStaff } from '../shell/session.tsx';

export type AdminCategory = AdminCatalogDTO['categories'][number];
export type AdminModifierGroup = AdminCatalogDTO['modifier_groups'][number];
export type GroupKey = 'food' | 'drinks';
export type MenuTab = 'availability' | 'catalog' | 'review' | 'import';

export const MENU_PATH = '/api/staff/menu';
const MENU_TOPICS = ['menu.', 'ordering.'];

export const TAB_HREF: Record<MenuTab, string> = {
  availability: '/admin/menu',
  catalog: '/admin/menu/catalog',
  review: '/admin/menu/review',
  import: '/admin/menu/import',
};
export const itemHref = (id: string) => `/admin/menu/items/${encodeURIComponent(id)}`;

interface Override { item: AdminItemDTO; at: number }

export interface MenuData {
  resource: Resource<AdminCatalogDTO>;
  catalog: AdminCatalogDTO | undefined;
  items: AdminItemDTO[];
  item: (id: string) => AdminItemDTO | undefined;
  category: (id: string) => AdminCategory | undefined;
  modifierGroup: (id: string) => AdminModifierGroup | undefined;
  /** Categories of one group in display order. */
  categoriesOf: (group: GroupKey) => AdminCategory[];
  /** Items of one category in display order. */
  itemsOf: (categoryId: string) => AdminItemDTO[];
  putItem: (item: AdminItemDTO) => void;
  putCatalog: (catalog: AdminCatalogDTO) => void;
}

const MenuDataContext = createContext<MenuData | null>(null);

/** The last catalog this tab saw: coming back to Menu shows it at once while a fresh copy loads. */
let cached: { data: AdminCatalogDTO; at: number } | null = null;

/**
 * The catalog, refetched on menu and ordering events. lib/live.tsx rebuilds its
 * subscribe function on every event, which makes useResource's own topic
 * subscription cancel the refetch that event scheduled; so this keeps its own
 * debounce timer (cleared only on unmount) and resync hook.
 */
function useCatalogResource(): Resource<AdminCatalogDTO> {
  const resource = useResource<AdminCatalogDTO>(MENU_PATH);
  const live = useLive();
  const refresh = useRef(resource.refresh);
  refresh.current = resource.refresh;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLiveEvent(MENU_TOPICS, () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void refresh.current(); }, 250);
  });
  useEffect(() => live.onResync(() => { void refresh.current(); }), [live.onResync]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return resource;
}

export function MenuDataProvider({ children }: { children: ReactNode }) {
  const resource = useCatalogResource();
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const { mutate } = resource;

  const putItem = useCallback((item: AdminItemDTO) => {
    setOverrides((o) => ({ ...o, [item.id]: { item, at: Date.now() } }));
  }, []);
  const putCatalog = useCallback((catalog: AdminCatalogDTO) => {
    setOverrides({});
    mutate(catalog);
  }, [mutate]);

  if (resource.data && resource.fetchedAt && (!cached || cached.data !== resource.data)) cached = { data: resource.data, at: resource.fetchedAt };

  const value = useMemo<MenuData>(() => {
    const fromCache = !resource.data && cached !== null;
    const data = resource.data ?? cached?.data;
    const fetchedAt = resource.fetchedAt ?? cached?.at ?? 0;
    // A failed refresh over cached data is stale data, not a blank page.
    const shown: Resource<AdminCatalogDTO> = fromCache
      ? { ...resource, data, fetchedAt, stale: Boolean(resource.error) }
      : resource;
    const items: AdminItemDTO[] = [];
    const seen = new Set<string>();
    for (const fetched of data?.items ?? []) {
      seen.add(fetched.id);
      const o = overrides[fetched.id];
      const useOverride = o && (o.item.version > fetched.version || (o.item.version === fetched.version && o.at > fetchedAt));
      items.push(useOverride ? o.item : fetched);
    }
    // Items created in this tab that the next fetch has not delivered yet.
    if (data) for (const o of Object.values(overrides)) if (!seen.has(o.item.id)) items.push(o.item);

    const byId = new Map(items.map((i) => [i.id, i]));
    const cats = new Map((data?.categories ?? []).map((c) => [c.id, c]));
    const groups = new Map((data?.modifier_groups ?? []).map((g) => [g.id, g]));
    const byCategory = new Map<string, AdminItemDTO[]>();
    for (const it of items) {
      const list = byCategory.get(it.category_id);
      if (list) list.push(it); else byCategory.set(it.category_id, [it]);
    }
    for (const list of byCategory.values()) list.sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key));

    return {
      resource: shown,
      catalog: data,
      items,
      item: (id) => byId.get(id),
      category: (id) => cats.get(id),
      modifierGroup: (id) => groups.get(id),
      categoriesOf: (group) => {
        const ids = data?.groups.find((g) => g.key === group)?.category_ids ?? [];
        return ids.map((id) => cats.get(id)).filter((c): c is AdminCategory => Boolean(c)).sort((a, b) => a.sort - b.sort);
      },
      itemsOf: (categoryId) => byCategory.get(categoryId) ?? [],
      putItem,
      putCatalog,
    };
  }, [resource, overrides, putItem, putCatalog]);

  return <MenuDataContext.Provider value={value}>{children}</MenuDataContext.Provider>;
}

export function useMenuData(): MenuData {
  const ctx = useContext(MenuDataContext);
  if (!ctx) throw new Error('useMenuData outside MenuDataProvider');
  return ctx;
}

/** Permission check from the signed-in staff session. */
export function useCan(): (p: Permission) => boolean {
  return useStaff().can;
}

/**
 * Leave an open overlay for another page. The overlay owns one history entry
 * (ui/overlay.ts); replacing that entry keeps Back working and stops the
 * overlay's cleanup from stepping back over the new page.
 */
export function navigateFromOverlay(to: string): void {
  const state = window.history.state as Record<string, unknown> | null;
  const inOverlayEntry = Boolean(state && typeof state === 'object' && '__rgOverlay' in state);
  navigate(to, { replace: inOverlayEntry });
}

// ------------------------------------------------------------------ money text
/** Satang to the baht text used in inputs ("590", "1590.50"). */
export function minorToBahtText(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return '';
  const whole = Math.floor(minor / 100);
  const satang = minor % 100;
  return satang ? `${whole}.${String(satang).padStart(2, '0')}` : String(whole);
}

/** "590", "1,590", "590.5" to satang, exactly. undefined = not a price, null = blank. */
export function bahtTextToMinor(text: string): number | null | undefined {
  const s = text.trim();
  if (!s) return null;
  const m = /^(\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return undefined;
  return Number(m[1].replace(/,/g, '')) * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0);
}

/** Whole number text to a number. undefined = invalid, null = blank. */
export function intText(text: string, min: number, max: number): number | null | undefined {
  const s = text.trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  return n >= min && n <= max ? n : undefined;
}

// ------------------------------------------------------------------ search
export function matchesItem(item: AdminItemDTO, query: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  const hay = normalizeSearch([item.name.th, item.name.en, item.key].filter(Boolean).join(' '));
  return q.split(' ').every((part) => hay.includes(part));
}

// ------------------------------------------------------------------ errors
export interface FieldIssue { path: string; message: string }

/** Field-level issues from a validation_failed answer. */
export function validationIssues(err: unknown): FieldIssue[] {
  if (!(err instanceof ApiError) || err.code !== 'validation_failed') return [];
  const d = err.details as { issues?: Array<{ path?: unknown; message?: unknown }> } | null | undefined;
  return (d?.issues ?? []).map((i) => ({
    path: Array.isArray(i.path) ? i.path.join('.') : String(i.path ?? ''),
    message: String(i.message ?? ''),
  }));
}

/** Translated sentence for any failure (error.<code>), never a raw server string. */
export function useErrorText(): (err: unknown) => string {
  const { t, has } = useI18n();
  return useCallback((err: unknown) => {
    if (err instanceof ApiError) {
      if (err.code === 'forbidden') return t('catalog.err.forbidden');
      if (err.code === 'payload_too_large') return t('catalog.err.tooLarge');
      const key = `error.${err.code}`;
      return has(key) ? t(key) : t('error.internal');
    }
    return t('error.internal');
  }, [t, has]);
}
