// First-admin setup (and password recovery) from the server's own shell.
// Shell access to the server is the authentication for this step.
//
//   npm run admin:create -- --username owner --name "Owner" [--role owner]
//
// The password is read from the terminal (not echoed) or from the
// RG_ADMIN_PASSWORD environment variable for unattended installs.
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { migrate, openDatabase, one, run, tx, insert } from '../server/db/index.ts';
import { hashPassword } from '../server/lib/auth.ts';
import { audit } from '../server/lib/audit.ts';
import { newId } from '../shared/ids.ts';
import { ROLES, type Role } from '../shared/permissions.ts';
import { PasswordRule } from '../shared/schemas.ts';
import { nowIso } from '../shared/time.ts';

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 ? args[i + 1] : undefined;
};

const username = arg('username');
const displayName = arg('name') ?? username;
const role = (arg('role') ?? 'owner') as Role;
if (!username || !ROLES.includes(role)) {
  console.error('usage: npm run admin:create -- --username <name> [--name "Display name"] [--role owner|manager|cashier|floor|kitchen]');
  process.exit(2);
}

async function readPassword(prompt: string): Promise<string> {
  if (process.env.RG_ADMIN_PASSWORD) return process.env.RG_ADMIN_PASSWORD;
  let muted = false;
  const out = new Writable({ write(chunk, _enc, cb) { if (!muted) process.stdout.write(chunk); cb(); } });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    muted = true;
  });
}

const password = await readPassword(`Password for ${username} (min 10 characters): `);
const valid = PasswordRule.safeParse(password);
if (!valid.success) {
  console.error('Password must be 10-256 characters.');
  process.exit(1);
}

openDatabase();
migrate();
const now = nowIso();
tx(() => {
  const existing = one<{ id: string }>('SELECT id FROM staff_users WHERE username = ?', [username]);
  if (existing) {
    run('UPDATE staff_users SET password_hash = :h, role = :role, active = 1, failed_logins = 0, locked_until = NULL, updated_at = :now, version = version + 1 WHERE id = :id',
      { id: existing.id, h: hashPassword(password), role, now });
    run('UPDATE staff_sessions SET revoked_at = :now WHERE user_id = :id AND revoked_at IS NULL', { id: existing.id, now });
    audit({ type: 'system', id: null, label: 'admin:create' }, 'staff.password_reset_cli', { type: 'staff_user', id: existing.id });
    console.log(`Updated ${username} (${role}); existing sessions signed out.`);
  } else {
    const id = newId('stf');
    insert('staff_users', {
      id, username, display_name: displayName, role, password_hash: hashPassword(password),
      active: 1, is_fixture: 0, created_at: now, updated_at: now,
    });
    audit({ type: 'system', id: null, label: 'admin:create' }, 'staff.created_cli', { type: 'staff_user', id }, { after: { username, role } });
    console.log(`Created ${username} (${role}).`);
  }
});
