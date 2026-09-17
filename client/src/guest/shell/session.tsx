// Guest session (docs/CLIENT.md, brief 07 and 30).
//
//   mode 'loading'  first GET /api/guest/session has not answered yet
//        'public'   no table access (401 visit_access_required): browse only
//        'joined'   this browser belongs to an open or billing visit
//        'ended'    the visit closed (410 visit_closed) or this browser's
//                   access was revoked (401 visit_access_revoked)
//
// Poll-free: the session is fetched on mount, when the window regains focus
// or becomes visible, and when the live stream reports visit/ordering/table
// changes (GuestLiveBridge calls refresh()). Once ended, the mode stays ended
// until a new join (setSession) or a later fetch proves access again: a
// cleared cookie must never flip a finished visit back to "public".
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GuestSessionDTO } from '../../../../shared/dto.ts';
import { api, ApiError } from '../../lib/api.ts';

export type GuestMode = 'loading' | 'public' | 'joined' | 'ended';

export interface GuestSessionApi {
  mode: GuestMode;
  session: GuestSessionDTO | null;
  /** 'visit_closed' | 'visit_access_revoked' while ended (null until known). */
  endedReason: string | null;
  refresh: () => Promise<void>;
  setSession: (s: GuestSessionDTO) => void;
  markEnded: (reason?: string) => void;
  /** Last fetch failed for a reason other than access (network, server). */
  error: ApiError | null;
}

const noop = async () => {};

const SessionContext = createContext<GuestSessionApi>({
  mode: 'loading',
  session: null,
  endedReason: null,
  refresh: noop,
  setSession: () => {},
  markEnded: () => {},
  error: null,
});

const ENDED_CODES = new Set(['visit_closed', 'visit_access_revoked']);

// This tab's finished visit, so a reload still says "ended" (the server then
// only answers visit_access_required). Per tab, for a few hours.
const ENDED_KEY = 'rg.guest.ended';
const ENDED_TTL_MS = 6 * 60 * 60 * 1000;
interface EndedMark { reason: string | null; session: GuestSessionDTO | null; at: number }

function readEnded(): EndedMark | null {
  try {
    const raw = window.sessionStorage.getItem(ENDED_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as EndedMark;
    if (typeof v?.at !== 'number' || Date.now() - v.at > ENDED_TTL_MS) return null;
    return v;
  } catch {
    return null;
  }
}

function writeEnded(mark: EndedMark | null): void {
  try {
    if (mark) window.sessionStorage.setItem(ENDED_KEY, JSON.stringify(mark));
    else window.sessionStorage.removeItem(ENDED_KEY);
  } catch { /* private mode */ }
}

const FOCUS_THROTTLE_MS = 4_000;
const RETRY_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

interface State {
  mode: GuestMode;
  session: GuestSessionDTO | null;
  endedReason: string | null;
  error: ApiError | null;
}

export function GuestSessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ mode: 'loading', session: null, endedReason: null, error: null });
  const stateRef = useRef(state);
  stateRef.current = state;
  const seq = useRef(0);
  const lastFetch = useRef(0);
  const retry = useRef<{ timer: ReturnType<typeof setTimeout> | null; n: number }>({ timer: null, n: 0 });
  const mounted = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    const my = ++seq.current;
    lastFetch.current = Date.now();
    if (retry.current.timer) { clearTimeout(retry.current.timer); retry.current.timer = null; }
    try {
      const s = await api.get<GuestSessionDTO>('/api/guest/session');
      if (my !== seq.current || !mounted.current) return;
      retry.current.n = 0;
      setState({ mode: 'joined', session: s, endedReason: null, error: null });
    } catch (err) {
      if (my !== seq.current || !mounted.current) return;
      const e = err instanceof ApiError ? err : new ApiError('internal', 0, String(err));
      if (ENDED_CODES.has(e.code)) {
        retry.current.n = 0;
        setState((prev) => ({
          mode: 'ended',
          // Keep the last known visit (the ended page's table label, and the
          // visit its feedback belongs to). After a reload this tab has none of
          // its own: the mark from before the reload still has it.
          session: prev.session ?? readEnded()?.session ?? null,
          endedReason: e.code,
          error: null,
        }));
        return;
      }
      if (e.code === 'visit_access_required') {
        retry.current.n = 0;
        setState((prev) => {
          // The cookie is gone after a close: stay ended, keep the known reason.
          if (prev.mode === 'ended') return { ...prev, endedReason: prev.endedReason ?? 'visit_closed', error: null };
          const mark = prev.mode === 'loading' ? readEnded() : null;
          if (mark) return { mode: 'ended', session: mark.session, endedReason: mark.reason ?? 'visit_closed', error: null };
          return { mode: 'public', session: null, endedReason: null, error: null };
        });
        return;
      }
      // Network or server trouble: keep what we know and try again later.
      setState((prev) => ({ ...prev, error: e }));
      const n = retry.current.n++;
      const wait = RETRY_MS[Math.min(n, RETRY_MS.length - 1)];
      retry.current.timer = setTimeout(() => { void refresh(); }, wait);
    }
  }, []);

  const setSession = useCallback((s: GuestSessionDTO) => {
    seq.current++; // any fetch in flight is older than this join
    retry.current.n = 0;
    setState({ mode: 'joined', session: s, endedReason: null, error: null });
  }, []);

  const markEnded = useCallback((reason?: string) => {
    setState((prev) => ({
      mode: 'ended',
      session: prev.session,
      endedReason: reason ?? prev.endedReason ?? null,
      error: null,
    }));
    // Learn the precise reason (closed or revoked) when none was given.
    if (!reason) void refresh();
  }, [refresh]);

  // Remember an ended visit for this tab; a new join forgets it.
  useEffect(() => {
    if (state.mode === 'joined') writeEnded(null);
    // Never replace a remembered visit with "nothing": the reason may arrive
    // (410 from a fresh load) before this tab has learned which visit it was.
    else if (state.mode === 'ended') writeEnded({ reason: state.endedReason, session: state.session ?? readEnded()?.session ?? null, at: Date.now() });
  }, [state.mode, state.endedReason, state.session]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      if (retry.current.timer) clearTimeout(retry.current.timer);
    };
  }, [refresh]);

  // Focus / visibility / back online: re-check access (throttled).
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastFetch.current < FOCUS_THROTTLE_MS) return;
      void refresh();
    };
    const online = () => { lastFetch.current = 0; check(); };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('online', online);
    };
  }, [refresh]);

  const value = useMemo<GuestSessionApi>(() => ({
    mode: state.mode,
    session: state.session,
    endedReason: state.mode === 'ended' ? state.endedReason : null,
    error: state.error,
    refresh,
    setSession,
    markEnded,
  }), [state, refresh, setSession, markEnded]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useGuestSession(): GuestSessionApi {
  return useContext(SessionContext);
}
