// Menu scroll behaviour (brief 09, 33, 42):
//  - the current category follows the MEASURED scroll position (a rAF-throttled
//    scroll listener reading section positions); nothing is ever revealed or
//    hidden by an IntersectionObserver
//  - a tapped category stays current while the page scrolls to it, until the
//    guest scrolls by hand
//  - each group (Food, Drinks) keeps its own scroll position, also across
//    route changes within this tab
import { useCallback, useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../../ui/index.ts';
import type { GroupKey } from './model.ts';

// ---------------------------------------------------------------- memory
interface MenuMemory {
  group: GroupKey | null;
  y: Record<GroupKey, number | null>;
  query: string;
}

const SESSION_KEY = 'rg.menu.view';

function load(): MenuMemory {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<MenuMemory>;
      const y = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);
      return {
        group: v.group === 'food' || v.group === 'drinks' ? v.group : null,
        y: { food: y(v.y?.food), drinks: y(v.y?.drinks) },
        query: typeof v.query === 'string' ? v.query.slice(0, 80) : '',
      };
    }
  } catch { /* private mode */ }
  return { group: null, y: { food: null, drinks: null }, query: '' };
}

export const menuMemory: MenuMemory = typeof window === 'undefined'
  ? { group: null, y: { food: null, drinks: null }, query: '' }
  : load();

let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function saveMenuMemory(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(menuMemory)); } catch { /* ignore */ }
  }, 250);
}

/** Record the menu's scroll position for `group` while the menu is the page on screen. */
export function useRememberScroll(group: GroupKey, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const record = () => {
      raf = 0;
      // A route change has already moved the URL (and scrolled to the top): ignore.
      if (window.location.pathname.replace(/\/+$/, '') !== '/menu') return;
      // A modal sheet locks the page; its position is unchanged.
      if (document.documentElement.classList.contains('is-locked')) return;
      menuMemory.y[group] = Math.max(0, Math.round(window.scrollY));
      saveMenuMemory();
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(record); };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [group, active]);
}

// ---------------------------------------------------------------- geometry
/**
 * Height of the sticky chrome: masthead + its double rule (when it is pinned;
 * short viewports let it scroll away), plus the category row when shown.
 */
export function stickyOffset(): number {
  const mast = document.querySelector<HTMLElement>('.mast');
  const row = document.querySelector<HTMLElement>('.catrow');
  const pinned = mast ? getComputedStyle(mast).position === 'sticky' || getComputedStyle(mast).position === 'fixed' : false;
  const mastBottom = mast && pinned ? Math.max(0, mast.getBoundingClientRect().bottom) + 5 : 0;
  const rowH = row && row.offsetParent !== null ? row.offsetHeight : 0;
  return Math.round(mastBottom + rowH);
}

/** Page offset that puts a section's kicker just under the sticky chrome. */
export function sectionTarget(anchor: string): number | null {
  const el = document.getElementById(anchor);
  if (!el) return null;
  const pad = parseFloat(getComputedStyle(el).paddingTop) || 0;
  const top = el.getBoundingClientRect().top + window.scrollY + pad - stickyOffset() - 16;
  return Math.max(0, Math.round(top));
}

export function scrollToY(y: number, smooth: boolean): void {
  window.scrollTo({ top: y, behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'instant' as ScrollBehavior });
}

// ---------------------------------------------------------------- current section
interface Lock { anchor: string }

/**
 * The current category among `anchors` (DOM ids of the sections, in order).
 * `select(anchor)` marks a tapped category as current and holds it while the
 * page scrolls there, until the guest scrolls, taps or types.
 */
export function useCurrentSection(anchors: ReadonlyArray<string>, enabled: boolean): {
  current: string | null;
  select: (anchor: string) => void;
  measure: () => void;
} {
  const key = anchors.join('|');
  const [current, setCurrent] = useState<string | null>(anchors[0] ?? null);
  const lock = useRef<Lock | null>(null);
  const measureRef = useRef<() => void>(() => {});

  useEffect(() => {
    const list = key ? key.split('|') : [];
    if (!enabled || !list.length) {
      setCurrent(list[0] ?? null);
      measureRef.current = () => {};
      return;
    }
    let raf = 0;
    const measure = () => {
      raf = 0;
      if (lock.current) {
        const target = sectionTarget(lock.current.anchor);
        // Arrived (or as close as the page allows): let measuring take over again.
        const maxY = document.documentElement.scrollHeight - window.innerHeight;
        if (target === null || Math.abs(window.scrollY - Math.min(target, maxY)) > 2) return;
        lock.current = null;
        // Arrived: the tapped section stays current (a short last section may sit below the line).
        return;
      }
      const line = stickyOffset() + 24;
      let best = list[0];
      for (const id of list) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= line) best = id;
        else break;
      }
      // At the very bottom, a short last section can never reach the line: the
      // last section whose heading is in the upper part of the screen wins.
      const doc = document.documentElement;
      if (window.scrollY > 0 && window.innerHeight + window.scrollY >= doc.scrollHeight - 2) {
        for (const id of list) {
          const el = document.getElementById(id);
          if (el && el.getBoundingClientRect().top < window.innerHeight * 0.55) best = id;
        }
      }
      setCurrent((prev) => (prev === best ? prev : best));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    const release = () => { if (lock.current) { lock.current = null; schedule(); } };
    measureRef.current = schedule;
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('wheel', release, { passive: true });
    window.addEventListener('touchstart', release, { passive: true });
    window.addEventListener('keydown', release);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    ro?.observe(document.body);
    measure();
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('wheel', release);
      window.removeEventListener('touchstart', release);
      window.removeEventListener('keydown', release);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      measureRef.current = () => {};
    };
  }, [key, enabled]);

  const select = useCallback((anchor: string) => {
    lock.current = { anchor };
    setCurrent(anchor);
  }, []);

  const measure = useCallback(() => measureRef.current(), []);

  return { current, select, measure };
}
