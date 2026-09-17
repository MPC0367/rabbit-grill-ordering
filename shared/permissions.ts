// Role matrix (brief 18). The server enforces every permission; the client
// only uses the same table to hide controls a role cannot use.
// Owners may override individual permissions in settings (`role_permissions`).

export const ROLES = ['owner', 'manager', 'cashier', 'floor', 'kitchen'] as const;
export type Role = (typeof ROLES)[number];

const ALL: readonly Role[] = ROLES;
const MGMT: readonly Role[] = ['owner', 'manager'];

export const DEFAULT_PERMISSIONS = {
  // live service
  'orders.view': ALL,
  'orders.accept': ['owner', 'manager', 'floor', 'kitchen'],          // accept or reject a new round
  'orders.prepare': ['owner', 'manager', 'kitchen', 'floor'],          // preparing / almost done / ready
  'orders.serve': ['owner', 'manager', 'floor', 'cashier'],            // mark served, finish order
  'orders.cancel_unstarted': ['owner', 'manager', 'floor'],            // cancel an accepted, not-yet-preparing line
  'orders.cancel_started': MGMT,                                       // cancel preparing / almost done / ready
  'orders.correct': MGMT,                                              // move a line backwards, with reason
  'orders.assist': ['owner', 'manager', 'floor', 'cashier'],           // staff-assisted ordering
  'orders.recover_manual': MGMT,                                       // enter orders taken on paper during an outage
  'orders.view_bill_values': ['owner', 'manager', 'cashier', 'floor'],
  'service.handle': ['owner', 'manager', 'floor', 'cashier'],
  'service.cancel': MGMT,
  'portions.quote': ['owner', 'manager', 'floor', 'kitchen'],
  'portions.confirm_in_person': ['owner', 'manager', 'floor'],
  // tables and visits
  'tables.view': ['owner', 'manager', 'cashier', 'floor'],
  'tables.manage': MGMT,
  'tables.qr_rotate': MGMT,
  'visits.open': ['owner', 'manager', 'floor', 'cashier'],
  'visits.pin_rotate': ['owner', 'manager', 'floor'],
  'visits.revoke_guests': ['owner', 'manager', 'floor'],
  'visits.transfer': MGMT,
  'visits.close_exception': MGMT,
  'visits.covers': ['owner', 'manager', 'floor', 'cashier'],
  // billing
  'billing.view': ['owner', 'manager', 'cashier', 'floor'],
  'billing.start': ['owner', 'manager', 'cashier', 'floor'],           // move a visit into Checking out
  'billing.finalize': ['owner', 'manager', 'cashier'],
  'billing.reopen': MGMT,
  'billing.adjust': MGMT,
  'payments.view': ['owner', 'manager', 'cashier'],
  'payments.confirm': ['owner', 'manager', 'cashier'],
  'payments.correct': MGMT,
  'checkout.complete': ['owner', 'manager', 'cashier'],
  // catalog
  'menu.view': ALL,
  'menu.availability': ['owner', 'manager', 'kitchen'],
  'menu.edit': MGMT,
  'menu.publish': MGMT,
  'menu.review': ['owner'],                                            // verify prices, allergens, translations
  'menu.import': MGMT,
  'ordering.pause': MGMT,
  // insight
  'stats.view': MGMT,
  'stats.engagement': MGMT,
  'reports.view': MGMT,
  'reports.generate': MGMT,
  'reports.financial': ['owner'],
  'reports.export_raw': ['owner'],
  // administration
  'team.manage': ['owner'],
  'settings.manage': ['owner'],
  'audit.view': MGMT,
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof DEFAULT_PERMISSIONS;
export const PERMISSIONS = Object.keys(DEFAULT_PERMISSIONS) as Permission[];

export type PermissionOverrides = Partial<Record<Permission, Role[]>>;

/** Permissions that can never be granted away from the owner. */
export const OWNER_ONLY: readonly Permission[] = ['team.manage', 'settings.manage'];

export function rolesFor(perm: Permission, overrides?: PermissionOverrides): readonly Role[] {
  if (OWNER_ONLY.includes(perm)) return ['owner'];
  const o = overrides?.[perm];
  const roles = o ?? DEFAULT_PERMISSIONS[perm];
  return roles.includes('owner') ? roles : ['owner', ...roles];
}

export function can(role: Role, perm: Permission, overrides?: PermissionOverrides): boolean {
  return rolesFor(perm, overrides).includes(role);
}

export function permissionsFor(role: Role, overrides?: PermissionOverrides): Permission[] {
  return PERMISSIONS.filter((p) => can(role, p, overrides));
}

/** Where each role lands after login (brief 33). */
export const DEFAULT_LANDING: Record<Role, string> = {
  owner: '/admin',
  manager: '/admin/orders',
  cashier: '/admin/tables',
  floor: '/admin/tables',
  kitchen: '/admin/orders',
};
