// Staff session (brief 18). The server enforces every permission; the client
// uses the same list only to hide what a role cannot use.
//
//   <StaffSessionProvider> ... </StaffSessionProvider>
//   const { me, can, logout, refresh } = useStaff();     // inside the signed-in tree
//   const session = useSessionState();                   // status, sign-in plumbing (shell only)
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { StaffMeDTO } from '../../../../shared/dto.ts';
import type { Permission } from '../../../../shared/permissions.ts';
import { api, ApiError } from '../../lib/api.ts';

export type SessionStatus = 'loading' | 'signed-out' | 'signed-in' | 'unreachable';
/** Why the sign-in page is showing: a fresh visit, a manual sign-out, a lock, or a session the server ended. */
export type SignedOutReason = 'none' | 'signed-out' | 'locked' | 'expired';

export interface SessionState {
  status: SessionStatus;
  me: StaffMeDTO | null;
  reason: SignedOutReason;
  /** The last /me failure while no session was known (network down at start). */
  error: ApiError | null;
  /** The sign-in form succeeded. */
  signIn(me: StaffMeDTO): void;
  /** Re-read /me. A 401 signs the device out (reason "expired" if it was signed in). */
  check(): Promise<void>;
  /** Sign out on the server, then show the sign-in page. */
  signOut(reason?: Exclude<SignedOutReason, 'none' | 'expired'>): Promise<void>;
}

export interface StaffApi {
  me: StaffMeDTO;
  can(p: Permission): boolean;
  /** Any of the given permissions. */
  canAny(ps: readonly Permission[]): boolean;
  logout(): Promise<void>;
  refresh(): Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);
const StaffContext = createContext<StaffApi | null>(null);

export function StaffSessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [me, setMe] = useState<StaffMeDTO | null>(null);
  const [reason, setReason] = useState<SignedOutReason>('none');
  const [error, setError] = useState<ApiError | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const seq = useRef(0);

  const check = useCallback(async () => {
    const my = ++seq.current;
    try {
      const next = await api.get<StaffMeDTO>('/api/staff/auth/me');
      if (my !== seq.current) return;
      setMe(next);
      setError(null);
      setStatus('signed-in');
    } catch (err) {
      if (my !== seq.current) return;
      const e = err instanceof ApiError ? err : new ApiError('internal', 0, String(err));
      if (e.status === 401 || e.code === 'auth_required') {
        if (statusRef.current === 'signed-in') setReason('expired');
        setMe(null);
        setStatus('signed-out');
        return;
      }
      // A network blip must not throw a signed-in person out of service.
      if (statusRef.current === 'signed-in') return;
      setError(e);
      setStatus('unreachable');
    }
  }, []);

  useEffect(() => { void check(); }, [check]);

  const signIn = useCallback((next: StaffMeDTO) => {
    seq.current++;
    setMe(next);
    setError(null);
    setReason('none');
    setStatus('signed-in');
  }, []);

  const signOut = useCallback(async (why: Exclude<SignedOutReason, 'none' | 'expired'> = 'signed-out') => {
    seq.current++;
    try {
      await api.post('/api/staff/auth/logout');
    } catch {
      /* the cookie may already be gone; the device still leaves the session */
    }
    setMe(null);
    setReason(why);
    setStatus('signed-out');
  }, []);

  const session = useMemo<SessionState>(
    () => ({ status, me, reason, error, signIn, check, signOut }),
    [status, me, reason, error, signIn, check, signOut],
  );

  const staff = useMemo<StaffApi | null>(() => {
    if (!me) return null;
    const perms = new Set(me.permissions);
    return {
      me,
      can: (p) => perms.has(p),
      canAny: (ps) => ps.some((p) => perms.has(p)),
      logout: () => signOut('signed-out'),
      refresh: check,
    };
  }, [me, signOut, check]);

  return (
    <SessionContext.Provider value={session}>
      <StaffContext.Provider value={staff}>{children}</StaffContext.Provider>
    </SessionContext.Provider>
  );
}

export function useSessionState(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSessionState outside StaffSessionProvider');
  return ctx;
}

/** The signed-in staff member. Only valid inside the signed-in tree. */
export function useStaff(): StaffApi {
  const ctx = useContext(StaffContext);
  if (!ctx) throw new Error('useStaff outside a signed-in StaffSessionProvider');
  return ctx;
}

/** Same as useStaff(), or null while signed out (for components that render in both trees). */
export function useOptionalStaff(): StaffApi | null {
  return useContext(StaffContext);
}
