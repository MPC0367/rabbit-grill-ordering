// Staff sign-in and the two live event streams.
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../app.ts';
import { body, clientIp } from '../lib/http.ts';
import { LoginBody } from '../../shared/schemas.ts';
import { AppError } from '../lib/errors.ts';
import { assertUnderLimit, hit, LIMITS } from '../lib/ratelimit.ts';
import {
  buildStaffContext, burnPasswordCheck, endStaffSession, guestOf, loadStaff, requireGuest, requireStaff,
  resolveGuest, staffOf, startStaffSession, verifyPassword, type StaffContext, type StaffUserRow,
} from '../lib/auth.ts';
import { one, run, tx } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { nowIso } from '../../shared/time.ts';
import { DEFAULT_LANDING } from '../../shared/permissions.ts';
import { getSettings } from '../lib/settings.ts';
import type { StaffMeDTO, StaffUserDTO } from '../../shared/dto.ts';
import { eventsSince, hiddenTopicsFor, sseStream } from '../lib/events.ts';

/** Consecutive failures (from any address) that lock an account; the per-address budget stops a guesser first. */
const LOCK_AFTER = 20;
const LOCK_MINUTES = 15;

export function staffUserDTO(u: StaffUserRow): StaffUserDTO {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    active: u.active === 1,
    is_fixture: u.is_fixture === 1,
    created_at: u.created_at,
    last_login_at: u.last_login_at,
    version: u.version,
  };
}

function meDTO(c: Context<AppEnv>): StaffMeDTO {
  const s = staffOf(c);
  const settings = getSettings();
  return {
    user: staffUserDTO(s.user),
    permissions: s.permissions,
    landing: DEFAULT_LANDING[s.user.role],
    operating_mode: settings.operating_mode,
    // The owner's alert-sound default for devices that never chose one
    // (D-FX-OPS-01). Sent twice so either name works on the client.
    sound_default: settings.notifications.sound_default,
    notifications: { sound_default: settings.notifications.sound_default },
  };
}

export const authRoutes = new Hono<AppEnv>()
  .post('/login', async (c) => {
    const input = await body(c, LoginBody);
    // Only FAILED attempts use up the budget: several staff signing in at one
    // shared tablet (or behind one proxy address) must not lock each other out.
    //
    // Budgets (D-S8-10): per address; per account from one address (the hard
    // stop a guesser meets); and a looser per-account total across addresses,
    // which the database lock also enforces across restarts. Someone guessing
    // from their phone therefore cannot lock the kitchen tablet out, and a
    // known username answers exactly like an unknown one: 401, then 429.
    const ip = clientIp(c);
    const name = input.username.toLowerCase();
    const keys = [
      [`login:ip:${ip}`, LIMITS.login],
      [`login:user-ip:${name}|${ip}`, LIMITS.loginPerUserAddress],
      [`login:user:${name}`, LIMITS.loginPerUser],
    ] as const;
    for (const [key, limit] of keys) assertUnderLimit(key, limit);
    const failed = () => {
      for (const [key, limit] of keys) hit(key, limit);
    };
    const refuse = (): never => {
      failed();
      throw new AppError('invalid_credentials', 'Username or password is incorrect.');
    };
    const user = one<StaffUserRow>('SELECT * FROM staff_users WHERE username = :u', { u: input.username });
    // Demo accounts have published passwords: they never sign in to a live restaurant.
    if (!user || user.active !== 1 || (user.is_fixture === 1 && getSettings().operating_mode === 'live')) {
      burnPasswordCheck(input.password);
      return refuse();
    }
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      // Same shape as a full per-account budget: the lock does not reveal that the account exists.
      burnPasswordCheck(input.password);
      failed();
      const retry = Math.max(1, Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000));
      throw new AppError('rate_limited', 'Too many attempts. Please wait a moment.', { retry_after_seconds: retry });
    }
    const ok = verifyPassword(input.password, user.password_hash);
    const actor = { type: 'staff' as const, id: user.id, label: user.display_name };
    tx(() => {
      if (!ok) {
        const failures = user.failed_logins + 1;
        const lock = failures >= LOCK_AFTER ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
        run('UPDATE staff_users SET failed_logins = :f, locked_until = :lock WHERE id = :id', { id: user.id, f: lock ? 0 : failures, lock });
        audit(actor, 'staff.login_failed', { type: 'staff_user', id: user.id }, { after: { locked: Boolean(lock) } });
        return;
      }
      run('UPDATE staff_users SET failed_logins = 0, locked_until = NULL, last_login_at = :now WHERE id = :id', { id: user.id, now: nowIso() });
      startStaffSession(c, user.id);
      audit(actor, 'staff.login', { type: 'staff_user', id: user.id });
    });
    if (!ok) refuse();
    const fresh = one<StaffUserRow>('SELECT * FROM staff_users WHERE id = ?', [user.id])!;
    c.set('staff', buildStaffContext(fresh, ''));
    return c.json(meDTO(c));
  })
  .post('/logout', (c) => {
    const s = loadStaff(c);
    tx(() => {
      endStaffSession(c);
      if (s) audit(s.actor, 'staff.logout', { type: 'staff_user', id: s.user.id });
    });
    return c.json({ ok: true });
  })
  .get('/me', requireStaff(), (c) => c.json(meDTO(c)));

// ------------------------------------------------------------------ live streams
// Mounted at /api/staff and /api/guest respectively.
/** What a staff stream was authorised with: the account and its exact permission set. */
const accessPrint = (s: StaffContext) => `${s.user.id}|${[...s.permissions].sort().join(',')}`;

export const streamsStaff = new Hono<AppEnv>()
  .get('/events', requireStaff(), (c) => {
    const s = staffOf(c);
    const print = accessPrint(s);
    // Signed out, deactivated, demoted or re-permissioned: the stream ends (D-S8-08).
    let signedIn = true;
    const stillValid = () => {
      const now = loadStaff(c);
      signedIn = now !== null && now.user.id === s.user.id;
      return signedIn && accessPrint(now!) === print;
    };
    const endState = () => (signedIn ? 'changed' as const : 'ended' as const);
    return sseStream(c, { kind: 'staff', hiddenTopics: hiddenTopicsFor(s.can), stillValid, endState });
  })
  // Polling fallback: GET /api/staff/events/poll?since=<id>
  .get('/events/poll', requireStaff(), (c) => {
    const s = staffOf(c);
    const since = Number(c.req.query('since') ?? 0) || 0;
    return c.json(eventsSince({ kind: 'staff', hiddenTopics: hiddenTopicsFor(s.can) }, since));
  });

export const streamsGuest = new Hono<AppEnv>()
  .get('/events', requireGuest(), (c) => {
    const g = guestOf(c);
    const stillValid = () => {
      const r = resolveGuest(c);
      return !('error' in r) && r.guest.visitId === g.visitId;
    };
    return sseStream(c, { kind: 'guest', visitId: g.visitId, stillValid });
  })
  .get('/events/poll', requireGuest(), (c) => {
    const g = guestOf(c);
    const since = Number(c.req.query('since') ?? 0) || 0;
    return c.json(eventsSince({ kind: 'guest', visitId: g.visitId, stillValid: () => true }, since));
  });
