// Staff and guest authentication.
//
// Staff: username + password (scrypt), opaque session cookie `rg_staff`
//        (HttpOnly, SameSite=Strict). Sessions live in the DB by token hash.
// Guest: joining a visit issues an opaque cookie `rg_guest` (HttpOnly,
//        SameSite=Lax so a QR scan navigation carries it). It is valid only
//        while its visit is open/billing and the membership is not revoked.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { config } from '../config.ts';
import { insert, one, run, tx } from '../db/index.ts';
import { newSecret } from '../../shared/ids.ts';
import { can, permissionsFor, type Permission, type Role } from '../../shared/permissions.ts';
import type { VisitStatus } from '../../shared/status.ts';
import { nowIso } from '../../shared/time.ts';
import { AppError } from './errors.ts';
import { sha256 } from './http.ts';
import { getSettings } from './settings.ts';
import { pokeStreams } from './events.ts';
import type { Actor } from './audit.ts';

export const STAFF_COOKIE = 'rg_staff';
export const GUEST_COOKIE = 'rg_guest';

// ------------------------------------------------------------------ passwords
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, r, p, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Run a dummy verification so unknown usernames take as long as wrong passwords. */
const DUMMY_HASH = hashPassword(newSecret(12));
export function burnPasswordCheck(password: string): void {
  verifyPassword(password, DUMMY_HASH);
}

// ------------------------------------------------------------------ staff sessions
export interface StaffUserRow {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  active: number;
  is_fixture: number;
  password_hash: string;
  failed_logins: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface StaffContext {
  user: StaffUserRow;
  sessionId: string;
  can: (perm: Permission) => boolean;
  permissions: Permission[];
  actor: Actor;
}

function cookieBase() {
  return { httpOnly: true, secure: config.cookieSecure, path: '/' } as const;
}

export function startStaffSession(c: Context, userId: string): void {
  const token = newSecret(32);
  const now = new Date();
  insert('staff_sessions', {
    id: sha256(token),
    user_id: userId,
    created_at: now.toISOString(),
    last_seen_at: now.toISOString(),
    expires_at: new Date(now.getTime() + config.staffSessionHours * 3_600_000).toISOString(),
  });
  setCookie(c, STAFF_COOKIE, token, { ...cookieBase(), sameSite: 'Strict', maxAge: config.staffSessionHours * 3600 });
}

export function endStaffSession(c: Context): void {
  const token = getCookie(c, STAFF_COOKIE);
  if (token) run('UPDATE staff_sessions SET revoked_at = :now WHERE id = :id AND revoked_at IS NULL', { id: sha256(token), now: nowIso() });
  pokeStreams();
  deleteCookie(c, STAFF_COOKIE, { path: '/', secure: config.cookieSecure });
}

export function loadStaff(c: Context): StaffContext | null {
  const token = getCookie(c, STAFF_COOKIE);
  if (!token) return null;
  const id = sha256(token);
  const row = one<StaffUserRow & { session_id: string; expires_at: string; last_seen_at: string }>(
    `SELECT u.*, s.id AS session_id, s.expires_at, s.last_seen_at FROM staff_sessions s
       JOIN staff_users u ON u.id = s.user_id
      WHERE s.id = :id AND s.revoked_at IS NULL AND u.active = 1`,
    { id },
  );
  if (!row) return null;
  // Demo accounts (published passwords) have no access while the restaurant is live.
  if (row.is_fixture === 1 && getSettings().operating_mode === 'live') return null;
  const now = Date.now();
  if (new Date(row.expires_at).getTime() <= now) return null;
  if (now - new Date(row.last_seen_at).getTime() > 60_000) {
    run('UPDATE staff_sessions SET last_seen_at = :now WHERE id = :id', { id, now: nowIso() });
  }
  return buildStaffContext(row, row.session_id);
}

export function buildStaffContext(row: StaffUserRow, sessionId: string): StaffContext {
  const overrides = getSettings().role_permissions;
  return {
    user: row,
    sessionId,
    can: (perm) => can(row.role, perm, overrides),
    permissions: permissionsFor(row.role, overrides),
    actor: { type: 'staff', id: row.id, label: row.display_name },
  };
}

/** Middleware: require a signed-in staff member (and optionally permissions). */
export function requireStaff(...perms: Permission[]): MiddlewareHandler {
  return async (c, next) => {
    const staff = loadStaff(c);
    if (!staff) throw new AppError('auth_required', 'Please sign in.');
    for (const p of perms) {
      if (!staff.can(p)) throw new AppError('forbidden', 'Your role cannot do this.', { permission: p });
    }
    c.set('staff', staff);
    await next();
  };
}

export function staffOf(c: Context): StaffContext {
  const s = c.get('staff') as StaffContext | undefined;
  if (!s) throw new AppError('auth_required');
  return s;
}

/** Throw forbidden unless the signed-in staff member holds `perm`. */
export function assertCan(c: Context, perm: Permission): StaffContext {
  const s = staffOf(c);
  if (!s.can(perm)) throw new AppError('forbidden', 'Your role cannot do this.', { permission: perm });
  return s;
}

// ------------------------------------------------------------------ guest sessions
export interface GuestContext {
  guestId: string;
  guestNo: number;
  visitId: string;
  visitStatus: VisitStatus;
  tableId: string;
  tableLabel: string;
  seatedAt: string;
  billRequestedAt: string | null;
  isFixture: boolean;
  actor: Actor;
}

export function issueGuestCookie(c: Context, token: string): void {
  setCookie(c, GUEST_COOKIE, token, { ...cookieBase(), sameSite: 'Lax', maxAge: config.guestSessionHours * 3600 });
}

export function clearGuestCookie(c: Context): void {
  deleteCookie(c, GUEST_COOKIE, { path: '/', secure: config.cookieSecure });
}

interface GuestLookup {
  guest_id: string; guest_no: number; revoked_at: string | null; created_at: string;
  visit_id: string; visit_status: VisitStatus; table_id: string; table_label: string;
  seated_at: string; bill_requested_at: string | null; is_fixture: number;
}

/** Resolve the guest cookie; returns a reason code when access is not valid. */
export function resolveGuest(c: Context): { guest: GuestContext } | { error: 'visit_access_required' | 'visit_access_revoked' | 'visit_closed' } {
  const token = getCookie(c, GUEST_COOKIE);
  if (!token) return { error: 'visit_access_required' };
  const row = one<GuestLookup>(
    `SELECT g.id AS guest_id, g.guest_no, g.revoked_at, g.created_at, v.id AS visit_id, v.status AS visit_status,
            v.table_id, t.label AS table_label, v.seated_at, v.bill_requested_at, v.is_fixture
       FROM guest_sessions g JOIN visits v ON v.id = g.visit_id JOIN dining_tables t ON t.id = v.table_id
      WHERE g.token_hash = :hash`,
    { hash: sha256(token) },
  );
  if (!row) return { error: 'visit_access_required' };
  if (row.visit_status === 'closed') return { error: 'visit_closed' };
  if (row.revoked_at) return { error: 'visit_access_revoked' };
  if (Date.now() - new Date(row.created_at).getTime() > config.guestSessionHours * 3_600_000) return { error: 'visit_access_required' };
  return {
    guest: {
      guestId: row.guest_id,
      guestNo: row.guest_no,
      visitId: row.visit_id,
      visitStatus: row.visit_status,
      tableId: row.table_id,
      tableLabel: row.table_label,
      seatedAt: row.seated_at,
      billRequestedAt: row.bill_requested_at,
      isFixture: row.is_fixture === 1,
      actor: { type: 'guest', id: row.guest_id, label: `Guest ${row.guest_no}` },
    },
  };
}

/** Middleware: require valid access to an active dining visit. */
export function requireGuest(): MiddlewareHandler {
  return async (c, next) => {
    const r = resolveGuest(c);
    if ('error' in r) {
      if (r.error !== 'visit_access_required') clearGuestCookie(c);
      throw new AppError(r.error);
    }
    const now = nowIso();
    run('UPDATE guest_sessions SET last_seen_at = :now WHERE id = :id AND last_seen_at < :cut', {
      id: r.guest.guestId, now, cut: new Date(Date.now() - 60_000).toISOString(),
    });
    c.set('guest', r.guest);
    await next();
  };
}

export function guestOf(c: Context): GuestContext {
  const g = c.get('guest') as GuestContext | undefined;
  if (!g) throw new AppError('visit_access_required');
  return g;
}

/**
 * A guest mutation's transaction. requireGuest() checks the cookie before the
 * body is read; staff may revoke the session while a slow phone is still
 * uploading, so the session is checked again inside the transaction and a
 * revoked guest creates nothing.
 */
export function guestTx<T>(guestId: string, fn: () => T): T {
  return tx(() => {
    const row = one<{ revoked_at: string | null }>('SELECT revoked_at FROM guest_sessions WHERE id = ?', [guestId]);
    if (!row) throw new AppError('visit_access_required');
    if (row.revoked_at) throw new AppError('visit_access_revoked');
    return fn();
  });
}

/** Hash a new guest token for storage. */
export function guestTokenHash(token: string): string {
  return sha256(token);
}
