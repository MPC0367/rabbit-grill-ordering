// Toast system and live regions (DESIGN §10.24).
//  - One toast at a time, 4s, paused while hovered or focused, optional ghost
//    action ("เลิกทำ"). Shown above the dock; raised above open dialogs via
//    the popover top layer where supported. It moves to the top of the screen
//    rather than cover the control that has just taken focus (WCAG 2.4.11).
//  - Screen readers hear toasts through one polite and one assertive region
//    at the app root. Assertive is only for errors (failed submission,
//    connection loss).
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type HTMLAttributes, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';
import { Button } from './Button.tsx';

// ---------------------------------------------------------------- announcer
// While a modal <dialog> is open (showModal), everything outside it is inert
// and leaves the accessibility tree, so a region under <body> is silent. Each
// open modal therefore gets its own pair of regions (created when it opens,
// see Sheet.tsx), and the words go to the top-most modal's pair, chosen when
// they are written rather than when announce() was called: a dialog that
// closes inside the delay hands the message back to the page regions.
type Politeness = 'polite' | 'assertive';
type Regions = Record<Politeness, HTMLElement>;
let pageRegions: Regions | null = null;
const modalRegions = new WeakMap<Element, Regions>();
const timers: Partial<Record<Politeness, ReturnType<typeof setTimeout>>> = {};
const written: Partial<Record<Politeness, HTMLElement>> = {};

function makeRegions(host: HTMLElement): Regions {
  const make = (p: Politeness) => {
    const el = document.createElement('div');
    el.className = 'visually-hidden';
    el.setAttribute('aria-live', p);
    el.setAttribute('aria-atomic', 'true');
    el.setAttribute('role', p === 'assertive' ? 'alert' : 'status');
    el.dataset.rgAnnouncer = p;
    host.appendChild(el);
    return el;
  };
  return { polite: make('polite'), assertive: make('assertive') };
}

function ensureRegions(): Regions | null {
  if (typeof document === 'undefined' || !document.body) return null;
  if (pageRegions && pageRegions.polite.isConnected && pageRegions.assertive.isConnected) return pageRegions;
  pageRegions = makeRegions(document.body);
  return pageRegions;
}

function isModal(d: Element): boolean {
  try { return d.matches(':modal'); } catch { return (d as HTMLDialogElement).open && d.getAttribute('aria-modal') === 'true'; }
}

/** The modal dialog on top: the one holding focus, else the last one opened. */
function topModal(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const active = document.activeElement?.closest('dialog');
  if (active && isModal(active)) return active;
  const open = Array.from(document.querySelectorAll('dialog[open]')).filter(isModal);
  return (open.at(-1) as HTMLElement | undefined) ?? null;
}

/**
 * Give a modal dialog its own announcer regions. Call when it opens: a region
 * must already be in the accessibility tree when its text changes.
 */
export function ensureModalRegions(dialog: HTMLElement): Regions {
  const known = modalRegions.get(dialog);
  if (known && known.polite.parentNode === dialog && known.assertive.parentNode === dialog) return known;
  const made = makeRegions(dialog);
  modalRegions.set(dialog, made);
  return made;
}

function targetRegion(politeness: Politeness): { el: HTMLElement; fresh: boolean } | null {
  const modal = topModal();
  if (modal) {
    const fresh = !modalRegions.has(modal);
    return { el: ensureModalRegions(modal)[politeness], fresh };
  }
  const page = ensureRegions();
  return page ? { el: page[politeness], fresh: false } : null;
}

/** Speak a message once. Repeating the same words re-announces them. */
export function announce(message: string, politeness: Politeness = 'polite'): void {
  if (!message || !ensureRegions()) return;
  const first = targetRegion(politeness);
  if (!first) return;
  first.el.textContent = '';
  if (written[politeness] && written[politeness] !== first.el) written[politeness]!.textContent = '';
  if (timers[politeness]) clearTimeout(timers[politeness]);
  // A region created just now needs a moment in the tree before it speaks.
  timers[politeness] = setTimeout(() => {
    const at = targetRegion(politeness);
    if (!at) return;
    if (written[politeness] && written[politeness] !== at.el) written[politeness]!.textContent = '';
    at.el.textContent = message;
    written[politeness] = at.el;
  }, first.fresh ? 250 : 80);
}

/** `announce(text)` for polite updates; `announce(text, { assertive: true })` for errors only. */
export function useAnnounce(): (message: string, opts?: { assertive?: boolean }) => void {
  useEffect(() => { ensureRegions(); }, []);
  return useCallback((message: string, opts?: { assertive?: boolean }) => announce(message, opts?.assertive ? 'assertive' : 'polite'), []);
}

export interface LiveRegionProps extends HTMLAttributes<HTMLDivElement> {
  assertive?: boolean;
  /** Visible region (e.g. a result count); default visually hidden. */
  visible?: boolean;
}

/** A local live region whose text changes are announced. */
export function LiveRegion({ assertive, visible, className, children, ...rest }: LiveRegionProps) {
  return (
    <div
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={cx(!visible && 'visually-hidden', className)}
      {...rest}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- toasts
export type ToastTone = 'ok' | 'info' | 'error';

export interface ToastOptions {
  message: ReactNode;
  tone?: ToastTone;
  /** Ghost action, e.g. undo. The toast closes after it runs. */
  action?: { label: string; onClick: () => void };
  /** ms, default 4000 */
  duration?: number;
  /** Words for screen readers when `message` is not plain text. */
  spoken?: string;
}

type ToastItem = ToastOptions & { tone: ToastTone; duration: number; id: string };

export interface ToastApi {
  show: (opts: ToastOptions | string) => string;
  dismiss: (id?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let toastSeq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<ToastItem[]>([]);
  useEffect(() => { ensureRegions(); }, []);

  const dismiss = useCallback((id?: string) => {
    setQueue((q) => (id ? q.filter((x) => x.id !== id) : q.slice(1)));
  }, []);

  const show = useCallback((input: ToastOptions | string) => {
    const opts: ToastOptions = typeof input === 'string' ? { message: input } : input;
    const item: ToastItem = { tone: 'ok', duration: 4000, ...opts, id: `t${++toastSeq}` };
    const words = item.spoken ?? (typeof item.message === 'string' ? item.message : '');
    if (words) announce(words, item.tone === 'error' ? 'assertive' : 'polite');
    // One at a time: a new toast replaces the one showing.
    setQueue([item]);
    return item.id;
  }, []);

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);
  const current = queue[0] ?? null;

  return (
    <ToastContext.Provider value={api}>
      {children}
      {typeof document !== 'undefined'
        ? createPortal(<ToastViewport toast={current} onDone={dismiss} />, document.body)
        : null}
    </ToastContext.Provider>
  );
}

const fallbackApi: ToastApi = {
  show: (input) => {
    const opts = typeof input === 'string' ? { message: input } : input;
    const words = opts.spoken ?? (typeof opts.message === 'string' ? opts.message : '');
    if (words) announce(words, opts.tone === 'error' ? 'assertive' : 'polite');
    return '';
  },
  dismiss: () => {},
};

/** Toast API. Outside a ToastProvider it only announces. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? fallbackApi;
}

/** Do these two boxes overlap on screen? */
function overlaps(a: DOMRect, b: DOMRect): boolean {
  if (b.width === 0 && b.height === 0) return false;
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function ToastViewport({ toast, onDone }: { toast: ToastItem | null; onDone: (id?: string) => void }) {
  const region = useRef<HTMLDivElement>(null);
  // Which edge the toast sits on. It starts at the bottom and moves to the top
  // if it would cover the control that has just taken focus (WCAG 2.4.11).
  const [edge, setEdge] = useState<'bottom' | 'top'>('bottom');
  const edgeRef = useRef<'bottom' | 'top'>('bottom');
  useEffect(() => {
    const el = region.current as (HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void }) | null;
    edgeRef.current = 'bottom';
    setEdge('bottom');
    if (!el || typeof el.showPopover !== 'function') return;
    try {
      if (el.matches(':popover-open')) el.hidePopover?.();
      if (toast) el.showPopover();
    } catch { /* unsupported: the region is a plain fixed element */ }
  }, [toast]);

  const id = toast?.id;
  useEffect(() => {
    if (!id) return;
    let frame = 0;
    const check = () => {
      const card = region.current?.querySelector('.toast') as HTMLElement | null;
      const focused = document.activeElement as HTMLElement | null;
      if (!card || !focused || focused === document.body || card.contains(focused)) return;
      if (!overlaps(card.getBoundingClientRect(), focused.getBoundingClientRect())) return;
      if (edgeRef.current === 'bottom') {
        edgeRef.current = 'top';
        setEdge('top');
        // Measure again once the move has been painted.
        frame = requestAnimationFrame(() => { frame = requestAnimationFrame(check); });
        return;
      }
      // Covered at both edges (a very short screen): the words have already
      // been announced and the toast is transient, so let it go.
      onDone(id);
    };
    const onFocus = () => {
      cancelAnimationFrame(frame);
      // Focus scrolls the page first (scroll-padding); measure after that.
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(check); });
    };
    document.addEventListener('focusin', onFocus);
    onFocus(); // the toast may appear over what is already focused
    return () => { document.removeEventListener('focusin', onFocus); cancelAnimationFrame(frame); };
  }, [id, onDone]);

  return (
    <div ref={region} className="toast-region" popover="manual" data-edge={edge} data-empty={toast ? undefined : ''}>
      {toast ? <ToastCard key={toast.id} toast={toast} onDone={onDone} /> : null}
    </div>
  );
}

function ToastCard({ toast, onDone }: { toast: ToastItem; onDone: (id?: string) => void }) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const remaining = useRef(toast.duration);
  const paused = hover || focus;

  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const timer = setTimeout(() => onDone(toast.id), Math.max(0, remaining.current));
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [paused, onDone, toast.id]);

  const icon = toast.tone === 'error' ? 'alert' : toast.tone === 'info' ? 'info' : 'check-c';
  return (
    <div
      className={cx('toast', toast.tone === 'error' && 'toast--error')}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false); }}
    >
      <Icon name={icon} />
      <span className="toast__msg">{toast.message}</span>
      {toast.action ? (
        <Button variant="ghost" onClick={() => { toast.action!.onClick(); onDone(toast.id); }}>
          {toast.action.label}
        </Button>
      ) : (
        <span className="toast__pad" aria-hidden="true" />
      )}
    </div>
  );
}

export interface ToastProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  message: ReactNode;
  tone?: ToastTone;
  action?: { label: string; onClick: () => void };
}

/** Presentational toast in the page flow (documentation, previews). Use useToast() in screens. */
export function Toast({ message, tone = 'ok', action, className, ...rest }: ToastProps) {
  const icon = tone === 'error' ? 'alert' : tone === 'info' ? 'info' : 'check-c';
  return (
    <div className={cx('toast', 'toast--inline', tone === 'error' && 'toast--error', className)} {...rest}>
      <Icon name={icon} />
      <span className="toast__msg">{message}</span>
      {action ? <Button variant="ghost" onClick={action.onClick}>{action.label}</Button> : <span className="toast__pad" aria-hidden="true" />}
    </div>
  );
}
