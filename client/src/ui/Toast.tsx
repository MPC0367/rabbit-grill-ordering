// Toast system and live regions (DESIGN §10.24).
//  - One toast at a time, 4s, paused while hovered or focused, optional ghost
//    action ("เลิกทำ"). Shown above the dock; raised above open dialogs via
//    the popover top layer where supported.
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
type Politeness = 'polite' | 'assertive';
let regions: Record<Politeness, HTMLElement> | null = null;
const timers: Partial<Record<Politeness, ReturnType<typeof setTimeout>>> = {};

function ensureRegions(): Record<Politeness, HTMLElement> | null {
  if (typeof document === 'undefined' || !document.body) return null;
  if (regions && regions.polite.isConnected && regions.assertive.isConnected) return regions;
  const make = (p: Politeness) => {
    const el = document.createElement('div');
    el.className = 'visually-hidden';
    el.setAttribute('aria-live', p);
    el.setAttribute('aria-atomic', 'true');
    el.setAttribute('role', p === 'assertive' ? 'alert' : 'status');
    el.dataset.rgAnnouncer = p;
    document.body.appendChild(el);
    return el;
  };
  regions = { polite: make('polite'), assertive: make('assertive') };
  return regions;
}

/** Speak a message once. Repeating the same words re-announces them. */
export function announce(message: string, politeness: Politeness = 'polite'): void {
  const r = ensureRegions();
  if (!r || !message) return;
  const el = r[politeness];
  el.textContent = '';
  if (timers[politeness]) clearTimeout(timers[politeness]);
  timers[politeness] = setTimeout(() => { el.textContent = message; }, 80);
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

function ToastViewport({ toast, onDone }: { toast: ToastItem | null; onDone: (id?: string) => void }) {
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = region.current as (HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void }) | null;
    if (!el || typeof el.showPopover !== 'function') return;
    try {
      if (el.matches(':popover-open')) el.hidePopover?.();
      if (toast) el.showPopover();
    } catch { /* unsupported: the region is a plain fixed element */ }
  }, [toast]);
  return (
    <div ref={region} className="toast-region" popover="manual" data-empty={toast ? undefined : ''}>
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
