// Overlay plumbing for Sheet / Dialog / Drawer (DESIGN §10.7):
//  - browser Back closes the open overlay (one history entry per open overlay,
//    same URL, marked in history.state)
//  - page scroll lock while any modal is open
//  - focus returns to the element that opened it
import { useEffect, useRef } from 'react';
import { useLatest } from './cx.ts';

const MARK = '__rgOverlay';

let pendingBacks = 0;
const settledWaiters: Array<() => void> = [];

function onBackSettled() {
  pendingBacks = Math.max(0, pendingBacks - 1);
  if (pendingBacks === 0) {
    const waiting = settledWaiters.splice(0);
    for (const fn of waiting) fn();
  }
}

function whenHistorySettled(fn: () => void) {
  if (pendingBacks === 0) fn();
  else settledWaiters.push(fn);
}

function currentMark(): string | null {
  const s = window.history.state as Record<string, unknown> | null;
  return s && typeof s === 'object' && typeof s[MARK] === 'string' ? (s[MARK] as string) : null;
}

let seq = 0;

/**
 * While `open`, keep one history entry for this overlay. Back (or any
 * navigation that leaves the entry) calls `onClose`. Closing from the UI
 * pops the entry again so Back is not "used up".
 */
export function useHistoryDismiss(open: boolean, onClose: () => void, enabled = true): void {
  const close = useLatest(onClose);
  useEffect(() => {
    if (!open || !enabled || typeof window === 'undefined') return;
    const token = `o${++seq}`;
    let pushed = false;
    let disposed = false;
    // Deferred: React StrictMode mounts effects twice; the first run is cleaned up before this fires.
    const timer = setTimeout(() => {
      whenHistorySettled(() => {
        if (disposed) return;
        const prev = (window.history.state ?? {}) as Record<string, unknown>;
        window.history.pushState({ ...prev, [MARK]: token }, '');
        pushed = true;
      });
    }, 0);
    const onPop = () => {
      if (!pushed || pendingBacks > 0) return;
      if (currentMark() !== token) {
        pushed = false;
        close.current();
      }
    };
    window.addEventListener('popstate', onPop);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener('popstate', onPop);
      if (pushed && currentMark() === token) {
        pendingBacks++;
        window.addEventListener('popstate', onBackSettled, { once: true });
        window.history.back();
      }
    };
  }, [open, enabled, close]);
}

let locks = 0;
/** Lock page scroll while `active` (reference counted). */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    if (locks++ === 0) {
      const gap = window.innerWidth - root.clientWidth;
      if (gap > 0) root.style.setProperty('padding-right', `${gap}px`);
      root.classList.add('is-locked');
    }
    return () => {
      if (--locks === 0) {
        root.classList.remove('is-locked');
        root.style.removeProperty('padding-right');
      }
    };
  }, [active]);
}

/** Remember the focused element when `active` turns on; restore it when it turns off or unmounts. */
export function useFocusReturn(active: boolean): void {
  const origin = useRef<HTMLElement | null>(null);
  const wasActive = useRef(false);
  // Capture during render: layout effects (showModal, panel focus) move focus before effects run.
  if (active && !wasActive.current && typeof document !== 'undefined') {
    origin.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  }
  wasActive.current = active;
  useEffect(() => {
    if (!active) return;
    return () => {
      const el = origin.current;
      if (!el) return;
      // After the overlay is gone. Only when focus was lost with it (a closed
      // native dialog already restores focus itself).
      requestAnimationFrame(() => {
        const now = document.activeElement;
        const lost = !now || now === document.body || !now.isConnected;
        if (lost && el.isConnected) el.focus({ preventScroll: true });
      });
    };
  }, [active]);
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), summary';

/** First focusable element inside `root`, preferring [autofocus] / [data-autofocus]. */
export function firstFocusable(root: HTMLElement | null, skipClose = false): HTMLElement | null {
  if (!root) return null;
  const preferred = root.querySelector<HTMLElement>('[autofocus], [data-autofocus]');
  if (preferred) return preferred;
  const all = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest('[hidden]'));
  if (skipClose) {
    const body = all.find((el) => !el.hasAttribute('data-overlay-close'));
    if (body) return body;
  }
  return all[0] ?? null;
}
