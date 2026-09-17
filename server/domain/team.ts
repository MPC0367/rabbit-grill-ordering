// Team management (brief 18): staff accounts, roles, passwords, sessions.
//
// Rules:
//  - only team.manage (owner) manages accounts; anyone may change their own
//    password with their current password;
//  - there is always at least one active owner (`last_owner`);
//  - a role change, deactivation or password reset revokes the account's
//    sessions, so a removed permission takes effect immediately;
//  - passwords are stored only as scrypt hashes and never logged or audited.
// All functions run inside tx().
import type { z } from 'zod';
import type { StaffUserDTO } from '../../shared/dto.ts';
import { newId } from '../../shared/ids.ts';
import type { Role } from '../../shared/permissions.ts';
import type { CreateStaffBody, SetPasswordBody, UpdateStaffBody } from '../../shared/schemas.ts';
import { nowIso } from '../../shared/time.ts';
import { insert, isConstraintError, many, one, run, updateVersioned } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { hashPassword, verifyPassword, type StaffContext, type StaffUserRow } from '../lib/auth.ts';
import { AppError, staleVersion } from '../lib/errors.ts';
import { hit, LIMITS } from '../lib/ratelimit.ts';

export function teamUserDTO(u: StaffUserRow): StaffUserDTO {
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

function getUser(id: string): StaffUserRow {
  const u = one<StaffUserRow>('SELECT * FROM staff_users WHERE id = ?', [id]);
  if (!u) throw new AppError('not_found', 'Staff account not found');
  return u;
}

/** Everyone except the audit-irrelevant fields; active accounts first, then by role and name. */
export function listTeam(): StaffUserDTO[] {
  return many<StaffUserRow>(
    `SELECT * FROM staff_users
      ORDER BY active DESC,
               CASE role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'cashier' THEN 2 WHEN 'floor' THEN 3 ELSE 4 END,
               display_name COLLATE NOCASE`).map(teamUserDTO);
}

function validationIssue(path: string, message: string): AppError {
  return new AppError('validation_failed', message, { issues: [{ path, message, code: 'custom' }] });
}

/** A password must not simply repeat the username or display name. */
function checkPasswordQuality(password: string, user: { username: string; display_name: string }): void {
  const p = password.toLowerCase();
  if (p.includes(user.username.toLowerCase()) || (user.display_name.length >= 4 && p.includes(user.display_name.toLowerCase()))) {
    throw validationIssue('password', 'Choose a password that does not contain the username or name.');
  }
}

export function revokeSessions(userId: string, opts: { keepSessionId?: string } = {}): number {
  return run(
    `UPDATE staff_sessions SET revoked_at = :now WHERE user_id = :id AND revoked_at IS NULL AND id <> :keep`,
    { id: userId, now: nowIso(), keep: opts.keepSessionId ?? '' },
  ).changes;
}

function otherActiveOwners(userId: string): number {
  return one<{ n: number }>(`SELECT COUNT(*) AS n FROM staff_users WHERE role = 'owner' AND active = 1 AND id <> ?`, [userId])?.n ?? 0;
}

export function createStaff(input: z.infer<typeof CreateStaffBody>, staff: StaffContext): StaffUserDTO {
  const username = input.username.trim().toLowerCase();
  checkPasswordQuality(input.password, { username, display_name: input.display_name });
  const now = nowIso();
  const id = newId('usr');
  try {
    insert('staff_users', {
      id,
      username,
      display_name: input.display_name.trim(),
      role: input.role,
      password_hash: hashPassword(input.password),
      active: 1,
      is_fixture: 0,
      created_at: now,
      updated_at: now,
    });
  } catch (err) {
    if (isConstraintError(err, 'username')) throw validationIssue('username', 'That username is already in use.');
    throw err;
  }
  audit(staff.actor, 'team.create', { type: 'staff_user', id }, { after: { username, display_name: input.display_name, role: input.role } });
  return teamUserDTO(getUser(id));
}

export function updateStaff(id: string, input: z.infer<typeof UpdateStaffBody>, staff: StaffContext): StaffUserDTO {
  const user = getUser(id);
  if (user.version !== input.version) staleVersion(teamUserDTO(user));
  const patch: Record<string, unknown> = {};
  if (input.display_name !== undefined && input.display_name.trim() !== user.display_name) patch.display_name = input.display_name.trim();
  if (input.role !== undefined && input.role !== user.role) patch.role = input.role;
  if (input.active !== undefined && (input.active ? 1 : 0) !== user.active) patch.active = input.active ? 1 : 0;
  if (Object.keys(patch).length === 0) return teamUserDTO(user);

  const losesOwner = user.role === 'owner' && user.active === 1 && ((patch.role !== undefined && patch.role !== 'owner') || patch.active === 0);
  if (losesOwner && otherActiveOwners(user.id) === 0) {
    throw new AppError('last_owner', 'At least one active owner account is required. Add or reactivate another owner first.');
  }
  if (patch.active === 1) {
    patch.failed_logins = 0;
    patch.locked_until = null;
  }
  patch.updated_at = nowIso();
  if (!updateVersioned('staff_users', id, input.version, patch)) staleVersion(teamUserDTO(getUser(id)));

  const accessChanged = patch.role !== undefined || patch.active === 0;
  const revoked = accessChanged ? revokeSessions(id) : 0;
  const before = { display_name: user.display_name, role: user.role as Role, active: user.active === 1 };
  const after = {
    display_name: (patch.display_name as string | undefined) ?? user.display_name,
    role: (patch.role as Role | undefined) ?? user.role,
    active: patch.active === undefined ? user.active === 1 : patch.active === 1,
  };
  const action = patch.active === 0 ? 'team.deactivate' : patch.active === 1 ? 'team.reactivate' : patch.role !== undefined ? 'team.role_change' : 'team.update';
  audit(staff.actor, action, { type: 'staff_user', id }, { before, after: { ...after, sessions_revoked: revoked } });
  return teamUserDTO(getUser(id));
}

/**
 * Set a password. Changing your own password requires the current one and
 * keeps this session; resetting someone else's needs team.manage and signs
 * them out everywhere.
 */
export function setStaffPassword(id: string, input: z.infer<typeof SetPasswordBody>, staff: StaffContext): void {
  const user = getUser(id);
  const self = user.id === staff.user.id;
  if (self) {
    hit(`password-change:${user.id}`, LIMITS.loginPerUser);
    if (!input.current_password || !verifyPassword(input.current_password, user.password_hash)) {
      throw validationIssue('current_password', 'Your current password is not correct.');
    }
    if (input.current_password === input.password) throw validationIssue('password', 'Choose a password different from the current one.');
  } else if (!staff.can('team.manage')) {
    throw new AppError('forbidden', 'Your role cannot change other accounts.', { permission: 'team.manage' });
  }
  checkPasswordQuality(input.password, user);
  run(
    `UPDATE staff_users SET password_hash = :hash, failed_logins = 0, locked_until = NULL, updated_at = :now, version = version + 1 WHERE id = :id`,
    { id, hash: hashPassword(input.password), now: nowIso() },
  );
  const revoked = revokeSessions(id, self ? { keepSessionId: staff.sessionId } : {});
  audit(staff.actor, self ? 'team.password_changed' : 'team.password_reset', { type: 'staff_user', id }, { after: { sessions_revoked: revoked } });
}

export function revokeStaffSessions(id: string, staff: StaffContext): number {
  getUser(id);
  const revoked = revokeSessions(id);
  audit(staff.actor, 'team.sessions_revoked', { type: 'staff_user', id }, { after: { sessions_revoked: revoked } });
  return revoked;
}
