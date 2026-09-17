// Behaviour hooks shared by the kit: the gliding ember mark (DESIGN §9) and
// roving-tabindex keyboard handling (tabs, segmented controls).
import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import { useIsoLayoutEffect } from './cx.ts';

export interface GlideOptions {
  /** Horizontal inset from the item edges (category tabs use 12). */
  inset?: number;
  /** Fixed mark width, centred on the item (bottom nav uses 32). */
  width?: number;
}

/**
 * Places one `.mark` element under the item that matches `selector` inside
 * `container`. The mark glides (transform + width, 200ms) and snaps on first
 * placement; reduced motion collapses the transition via tokens.
 * `key` should change whenever the current item changes.
 */
export function useGlideMark(
  container: RefObject<HTMLElement | null>,
  mark: RefObject<HTMLElement | null>,
  selector: string,
  key: unknown,
  opts: GlideOptions = {},
): void {
  const placed = useRef(false);
  const { inset = 0, width } = opts;

  useIsoLayoutEffect(() => {
    const box = container.current;
    const m = mark.current;
    if (!box || !m) return;
    const place = () => {
      const el = box.querySelector<HTMLElement>(selector);
      if (!el) { m.style.width = '0px'; return; }
      const w = width ?? Math.max(0, el.offsetWidth - inset * 2);
      const x = el.offsetLeft + (width !== undefined ? (el.offsetWidth - width) / 2 : inset);
      if (!placed.current) m.classList.add('is-snap');
      m.style.width = `${w}px`;
      m.style.transform = `translateX(${x}px)`;
      if (!placed.current) {
        placed.current = true;
        void m.offsetWidth; // commit the snapped position before re-enabling the glide
        requestAnimationFrame(() => m.classList.remove('is-snap'));
      }
    };
    place();
    let cancelled = false;
    document.fonts?.ready.then(() => { if (!cancelled) place(); }).catch(() => {});
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => place()) : null;
    ro?.observe(box);
    const el = box.querySelector<HTMLElement>(selector);
    if (el) ro?.observe(el);
    return () => { cancelled = true; ro?.disconnect(); };
  }, [container, mark, selector, key, inset, width]);
}

/** Scroll `el` into view inside its horizontal scroller without moving the page. */
export function scrollIntoViewInline(scroller: HTMLElement | null, el: HTMLElement | null, pad = 24): void {
  if (!scroller || !el) return;
  const left = el.offsetLeft;
  const right = left + el.offsetWidth;
  const viewL = scroller.scrollLeft;
  const viewR = viewL + scroller.clientWidth;
  let target: number | null = null;
  if (left - pad < viewL) target = Math.max(0, left - pad);
  else if (right + pad + 36 > viewR) target = right + pad + 36 - scroller.clientWidth;
  if (target === null) return;
  const reduce = document.documentElement.dataset.motion === 'reduce' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  scroller.scrollTo({ left: target, behavior: reduce ? 'auto' : 'smooth' });
}

/**
 * Arrow/Home/End handling for a roving-tabindex group. Returns the index to
 * move to (already focused), or null when the key is not handled.
 */
export function rovingKeyDown(
  e: KeyboardEvent<HTMLElement>,
  items: Array<HTMLElement | null>,
  current: number,
  orientation: 'horizontal' | 'vertical' | 'both' = 'horizontal',
): number | null {
  const prevKeys = orientation === 'vertical' ? ['ArrowUp'] : orientation === 'both' ? ['ArrowLeft', 'ArrowUp'] : ['ArrowLeft'];
  const nextKeys = orientation === 'vertical' ? ['ArrowDown'] : orientation === 'both' ? ['ArrowRight', 'ArrowDown'] : ['ArrowRight'];
  const rtl = orientation !== 'vertical' && getComputedStyle(e.currentTarget).direction === 'rtl';
  let step = 0;
  if (prevKeys.includes(e.key)) step = rtl ? 1 : -1;
  else if (nextKeys.includes(e.key)) step = rtl ? -1 : 1;
  const enabled = (i: number) => {
    const el = items[i];
    return Boolean(el) && !(el as HTMLButtonElement).disabled && el!.getAttribute('aria-disabled') !== 'true';
  };
  const n = items.length;
  if (!n) return null;
  let next: number | null = null;
  if (e.key === 'Home' || e.key === 'End') {
    const order = e.key === 'Home' ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
    next = order.find(enabled) ?? null;
  } else if (step) {
    for (let k = 1; k <= n; k++) {
      const i = (current + step * k + n * k) % n;
      if (enabled(i)) { next = i; break; }
    }
  }
  if (next === null) return null;
  e.preventDefault();
  items[next]?.focus();
  return next;
}

// ---------------------------------------------------------------- pinned edges
// Bars pinned to the viewport (the guest dock, the staff phone bar, sticky
// mastheads) cover whatever the browser scrolls a focused control to. Each
// one reports the band it covers; <html> carries the largest band per edge
// as --pinned-top / --pinned-bottom (px), which base.css turns into
// scroll-padding (bottom) and a focus scroll-margin (top). WCAG 2.4.11.
type Edge = 'top' | 'bottom';
const pinned: Record<Edge, Map<Element, number>> = { top: new Map(), bottom: new Map() };

function publishEdge(edge: Edge): void {
  const root = document.documentElement;
  const band = Math.max(0, ...pinned[edge].values());
  if (band > 0) {
    root.style.setProperty(`--pinned-${edge}`, `${Math.round(band)}px`);
    root.dataset[edge === 'top' ? 'pinnedTop' : 'pinnedBottom'] = '';
  } else {
    root.style.removeProperty(`--pinned-${edge}`);
    delete root.dataset[edge === 'top' ? 'pinnedTop' : 'pinnedBottom'];
  }
}

function measureEdge(el: HTMLElement, edge: Edge): number {
  const cs = getComputedStyle(el);
  if (cs.display === 'none') return 0;
  const r = el.getBoundingClientRect();
  if (edge === 'bottom') return cs.position === 'fixed' ? Math.max(0, window.innerHeight - r.top) : 0;
  if (cs.position !== 'sticky' && cs.position !== 'fixed') return 0;
  const top = Number.parseFloat(cs.top);
  return (Number.isFinite(top) ? top : 0) + r.height;
}

/**
 * While mounted, report the band `ref` covers at the top (sticky/fixed) or
 * bottom (fixed) of the viewport so keyboard focus is scrolled clear of it.
 */
export function usePinnedEdge(ref: RefObject<HTMLElement | null>, edge: Edge, enabled = true): void {
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled || typeof window === 'undefined') return;
    const update = () => {
      pinned[edge].set(el, measureEdge(el, edge));
      publishEdge(edge);
    };
    update();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', update);
      pinned[edge].delete(el);
      publishEdge(edge);
    };
  }, [ref, edge, enabled]);
}

/** Run `fn` on Escape while `active` (non-modal panels). */
export function useEscape(active: boolean, fn: () => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) ref.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active]);
}
