// Tiny History-API router. Deep links and browser back work everywhere.
//
//   const { path, query } = useRoute();
//   const params = matchPath('/q/:token', path);    // { token } | null
//   navigate('/menu/cart');                          // push
//   navigate('/menu', { replace: true });
//   <a href="/menu/orders" onClick={linkHandler}>…</a>   or  <Link to="/menu/orders">
import { createElement, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

type Listener = () => void;
const listeners = new Set<Listener>();
let snapshot = read();

function read() {
  return { path: window.location.pathname, search: window.location.search, hash: window.location.hash, state: window.history.state as unknown };
}

function notify() {
  snapshot = read();
  for (const l of listeners) l();
}

window.addEventListener('popstate', notify);

function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export interface RouteState {
  path: string;
  query: URLSearchParams;
  hash: string;
  state: unknown;
}

let cachedKey = '';
let cachedRoute: RouteState | null = null;

export function useRoute(): RouteState {
  const snap = useSyncExternalStore(subscribe, () => snapshot);
  const key = `${snap.path}${snap.search}${snap.hash}`;
  if (!cachedRoute || key !== cachedKey || cachedRoute.state !== snap.state) {
    cachedKey = key;
    cachedRoute = { path: snap.path, query: new URLSearchParams(snap.search), hash: snap.hash, state: snap.state };
  }
  return cachedRoute;
}

export function currentPath(): string {
  return window.location.pathname;
}

export function navigate(to: string, opts: { replace?: boolean; state?: unknown; keepScroll?: boolean } = {}): void {
  const url = new URL(to, window.location.origin);
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current && opts.state === undefined) return;
  if (opts.replace) window.history.replaceState(opts.state ?? null, '', next);
  else window.history.pushState(opts.state ?? null, '', next);
  notify();
  if (!opts.keepScroll && !url.hash) window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
}

export function back(fallback = '/menu'): void {
  if (window.history.length > 1) window.history.back();
  else navigate(fallback, { replace: true });
}

/** '/admin/tables/:id' against '/admin/tables/tbl_1' → { id: 'tbl_1' } */
export function matchPath(pattern: string, path: string, opts: { prefix?: boolean } = {}): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (opts.prefix ? s.length < p.length : s.length !== p.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

export function setQuery(patch: Record<string, string | null | undefined>, opts: { replace?: boolean } = { replace: true }): void {
  const q = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '') q.delete(k);
    else q.set(k, v);
  }
  const qs = q.toString();
  navigate(`${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`, { replace: opts.replace, keepScroll: true });
}

export function linkHandler(e: MouseEvent<HTMLAnchorElement>): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.currentTarget;
  if (a.target && a.target !== '_self') return;
  const url = new URL(a.href);
  if (url.origin !== window.location.origin) return;
  e.preventDefault();
  navigate(`${url.pathname}${url.search}${url.hash}`);
}

export function Link({ to, replace, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; replace?: boolean }) {
  return createElement('a', {
    ...rest,
    href: to,
    onClick: (e: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e);
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(to, { replace });
    },
  });
}
