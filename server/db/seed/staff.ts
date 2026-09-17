// Demo staff accounts - one per role, flagged is_fixture = 1.
// The passwords are published development fixtures, not secrets: they are
// printed once at seed time with a DEVELOPMENT ONLY warning. A real
// deployment creates its owner with `npm run admin:create` and never seeds.
import { hashPassword } from '../../lib/auth.ts';
import type { Role } from '../../../shared/permissions.ts';
import { one } from '../index.ts';
import type { Rng, Writer } from './util.ts';

export interface SeedStaff {
  id: string;
  username: string;
  display_name: string;
  role: Role;
}

export type StaffByRole = Record<Role, SeedStaff>;

const ACCOUNTS: ReadonlyArray<{ role: Role; display: string }> = [
  { role: 'owner', display: 'Demo Owner' },
  { role: 'manager', display: 'Demo Manager' },
  { role: 'cashier', display: 'Demo Cashier' },
  { role: 'floor', display: 'Demo Floor' },
  { role: 'kitchen', display: 'Demo Kitchen' },
];

export const demoUsername = (role: Role) => `demo-${role}`;
export const demoPassword = (role: Role) => `rabbit-${role}-demo`;

export function seedStaff(w: Writer, r: Rng, now: string): { staff: StaffByRole; created: SeedStaff[] } {
  const staff = {} as StaffByRole;
  const created: SeedStaff[] = [];
  for (const a of ACCOUNTS) {
    const username = demoUsername(a.role);
    // Someone may already have created this username (admin:create); reuse it rather than fail.
    const existing = one<SeedStaff>('SELECT id, username, display_name, role FROM staff_users WHERE username = ?', [username]);
    if (existing) {
      staff[a.role] = existing;
      continue;
    }
    const row: SeedStaff = { id: r.id('usr'), username, display_name: a.display, role: a.role };
    w.put('staff_users', {
      id: row.id, username, display_name: a.display, role: a.role,
      password_hash: hashPassword(demoPassword(a.role)),
      active: 1, is_fixture: 1, failed_logins: 0, locked_until: null, last_login_at: null,
      created_at: now, updated_at: now, version: 1,
    });
    staff[a.role] = row;
    created.push(row);
  }
  return { staff, created };
}

/** The one-time console notice. Fixture passwords only - never real credentials. */
export function printStaffNotice(created: SeedStaff[]): void {
  if (created.length === 0) return;
  const lines = [
    '',
    '  ================= DEVELOPMENT ONLY - DEMO STAFF ACCOUNTS =================',
    '  These fixture accounts exist only because SEED_DEMO=1. Their passwords',
    '  are public development fixtures. Never use them on a real deployment:',
    '  deactivate them in Admin > More > Team, or start from an empty database.',
    '',
    ...created.map((s) => `    ${s.role.padEnd(8)} username: ${s.username.padEnd(14)} password: ${demoPassword(s.role)}`),
    '  ===========================================================================',
    '',
  ];
  console.log(lines.join('\n'));
}
