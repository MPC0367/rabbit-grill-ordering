// Restaurant settings administration (brief 25).
//
// PATCH takes any subset of top-level keys. Object-valued keys may be sent
// partially: the patch is merged over the current value and the merged value
// is validated in full with that key's schema. Arrays (charges, payment
// methods) and the permission overrides are replaced whole. Every changed key
// is stored, audited with before/after, and announced as `settings.updated`
// (plus `ordering.updated` / `menu.updated` when guests are affected).
import { z } from 'zod';
import { OWNER_ONLY, PERMISSIONS, ROLES, type Permission } from '../../shared/permissions.ts';
import { FUTURE_ONLY_SETTINGS, type Settings } from '../../shared/settings.ts';
import { SERVICE_TYPES } from '../../shared/status.ts';
import { nowIso } from '../../shared/time.ts';
import { many } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import type { StaffContext } from '../lib/auth.ts';
import { AppError } from '../lib/errors.ts';
import { emit } from '../lib/events.ts';
import { getSettings, putSetting } from '../lib/settings.ts';

type Key = keyof Settings;

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM');
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

const DayHours = z.array(z.strictObject({ open: hhmm, close: hhmm })).max(3).superRefine((ranges, ctx) => {
  const sorted = [...ranges].sort((a, b) => minutesOf(a.open) - minutesOf(b.open));
  sorted.forEach((r, i) => {
    if (minutesOf(r.close) <= minutesOf(r.open)) ctx.addIssue({ code: 'custom', message: 'Closing time must be after opening time (overnight hours are not supported).' });
    if (i > 0 && minutesOf(r.open) < minutesOf(sorted[i - 1].close)) ctx.addIssue({ code: 'custom', message: 'Opening hours on the same day must not overlap.' });
  });
});

const ChargeRule = z.strictObject({
  id: z.string().regex(/^[a-z0-9_-]{2,32}$/, 'Use 2-32 lowercase letters, digits, - or _'),
  label_th: text(1, 60),
  label_en: text(1, 60),
  kind: z.enum(['percent', 'fixed']),
  basis_points: z.number().int().min(1).max(3000).optional(),
  amount_minor: z.number().int().min(1).max(1_000_000).optional(),
  inclusive: z.boolean(),
  enabled: z.boolean(),
  sort: z.number().int().min(0).max(100),
}).superRefine((r, ctx) => {
  if (r.kind === 'percent' && (r.basis_points === undefined || r.amount_minor !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['basis_points'], message: 'A percentage charge needs basis_points (1000 = 10%) and no fixed amount.' });
  }
  if (r.kind === 'fixed' && (r.amount_minor === undefined || r.basis_points !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['amount_minor'], message: 'A fixed charge needs amount_minor (satang) and no percentage.' });
  }
  if (r.kind === 'fixed' && r.inclusive) {
    ctx.addIssue({ code: 'custom', path: ['inclusive'], message: 'A fixed charge is always added to the bill; it cannot be marked as included.' });
  }
});

const uniqueIds = <T extends { id: string }>(label: string) => (list: T[], ctx: z.RefinementCtx) => {
  const seen = new Set<string>();
  for (const x of list) {
    if (seen.has(x.id)) ctx.addIssue({ code: 'custom', message: `Each ${label} needs a unique id ("${x.id}" is repeated).` });
    seen.add(x.id);
  }
};

const PaymentMethod = z.strictObject({
  id: z.string().regex(/^[a-z0-9_-]{2,32}$/),
  label_th: text(1, 40),
  label_en: text(1, 40),
  enabled: z.boolean(),
  tendered: z.boolean(),
  payment_qr_image: z.string().regex(/^[a-z0-9-]{1,80}(\.(png|jpe?g|webp))?$/).nullable().optional(),
});

const RoleList = z.array(z.enum(ROLES)).max(ROLES.length).refine((l) => new Set(l).size === l.length, 'Roles must not repeat');

/** One schema per top-level key. The value validated is the merged, complete value. */
const SCHEMAS: { [K in Key]: z.ZodType } = {
  restaurant: z.strictObject({ name_th: text(1, 80), name_en: text(1, 80), short_th: text(1, 40), short_en: text(1, 40) }),
  operating_mode: z.enum(['demo', 'live']),
  default_locale: z.enum(['th', 'en']),
  business_day_cutoff_hour: z.number().int().min(0).max(6),
  ordering: z.strictObject({
    enabled: z.boolean(),
    paused_message_th: text(1, 300),
    paused_message_en: text(1, 300),
    estimated_wait_minutes: z.number().int().min(1).max(240).nullable(),
    intake_limit: z.number().int().min(1).max(500).nullable(),
    enforce_hours: z.boolean(),
    weekly_hours: z.array(DayHours).length(7, 'Provide hours for Monday to Sunday (7 days)'),
    hours_verified: z.boolean(),
  }).superRefine((o, ctx) => {
    if (o.enforce_hours && !o.hours_verified) {
      ctx.addIssue({ code: 'custom', path: ['enforce_hours'], message: 'Confirm the opening hours (hours_verified) before enforcing them.' });
    }
  }),
  services: z.record(z.enum(SERVICE_TYPES), z.boolean()),
  service_cooldown_seconds: z.number().int().min(0).max(600),
  charges: z.array(ChargeRule).max(6).superRefine(uniqueIds('charge')),
  charges_confirmed: z.boolean(),
  payment_methods: z.array(PaymentMethod).min(1).max(10).superRefine(uniqueIds('payment method')).refine(
    (list) => list.some((m) => m.enabled), 'At least one payment method must stay enabled.'),
  join: z.strictObject({
    pin_required: z.boolean(),
    pin_digits: z.number().int().min(4).max(8),
    max_failures: z.number().int().min(3).max(20),
    lockout_minutes: z.number().int().min(1).max(120),
  }),
  menu: z.strictObject({ sold_out_display: z.enum(['show_disabled', 'hide']), note_max_length: z.number().int().min(0).max(500) }),
  portions: z.strictObject({ quote_expiry_minutes: z.number().int().min(1).max(120), allow_preferred_weight: z.boolean() }),
  checkout: z.strictObject({ after_checkout: z.enum(['available', 'needs_clearing']) }).superRefine((c, ctx) => {
    if (c.after_checkout === 'needs_clearing') {
      ctx.addIssue({
        code: 'custom',
        path: ['after_checkout'],
        message: '"Needs clearing" is not available yet: tables return to Available as soon as checkout completes.',
      });
    }
  }),
  alcohol: z.strictObject({ enabled: z.boolean(), staff_confirmation_note: z.boolean() }),
  analytics: z.strictObject({
    enabled: z.boolean(),
    idle_threshold_seconds: z.number().int().min(10).max(600),
    heartbeat_seconds: z.number().int().min(5).max(60),
    instrumentation_started_at: z.string().datetime().nullable(),
  }).superRefine((a, ctx) => {
    if (a.heartbeat_seconds >= a.idle_threshold_seconds) {
      ctx.addIssue({ code: 'custom', path: ['heartbeat_seconds'], message: 'The heartbeat must be shorter than the idle threshold.' });
    }
  }),
  retention: z.strictObject({
    notes_days: z.number().int().min(30).max(3650),
    feedback_days: z.number().int().min(30).max(3650),
    audit_days: z.number().int().min(365).max(3650),
    raw_events_days: z.number().int().min(30).max(3650),
  }),
  notifications: z.strictObject({ sound_default: z.boolean() }),
  role_permissions: z.partialRecord(z.enum(PERMISSIONS as [Permission, ...Permission[]]), RoleList).superRefine((o, ctx) => {
    for (const key of Object.keys(o) as Permission[]) {
      if (OWNER_ONLY.includes(key)) ctx.addIssue({ code: 'custom', path: [key], message: `${key} always belongs to the owner and cannot be reassigned.` });
    }
  }),
};

/** Keys replaced whole rather than merged. */
const REPLACE_WHOLE = new Set<Key>(['charges', 'payment_methods', 'role_permissions']);
/** Keys whose change guests see (ordering state, services, orderability). */
const ORDERING_KEYS = new Set<Key>(['ordering', 'services', 'service_cooldown_seconds', 'join']);
const MENU_KEYS = new Set<Key>(['operating_mode', 'alcohol', 'menu', 'portions', 'restaurant', 'default_locale', 'analytics']);

export interface SettingsView {
  settings: Settings;
  updated: Partial<Record<Key, string>>;
  future_only: string[];
}

export function settingsView(): SettingsView {
  const updated: Partial<Record<Key, string>> = {};
  const settings = getSettings();
  for (const r of many<{ key: string; updated_at: string }>('SELECT key, updated_at FROM settings')) {
    if (r.key in settings) updated[r.key as Key] = r.updated_at;
  }
  return { settings, updated, future_only: [...FUTURE_ONLY_SETTINGS] };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Validate and apply a settings patch. Runs inside tx(). All keys succeed or none do. */
export function patchSettings(patch: Record<string, unknown>, staff: StaffContext): SettingsView {
  const current = getSettings();
  const issues: Array<{ path: string; message: string; code: string }> = [];
  const next = new Map<Key, unknown>();

  for (const [rawKey, value] of Object.entries(patch)) {
    if (!(rawKey in SCHEMAS)) {
      issues.push({ path: rawKey, message: `Unknown setting "${rawKey}".`, code: 'unrecognized_keys' });
      continue;
    }
    const key = rawKey as Key;
    let merged: unknown = value;
    if (!REPLACE_WHOLE.has(key) && isPlainObject(current[key]) && isPlainObject(value)) {
      merged = { ...(current[key] as object), ...value };
    }
    if (key === 'analytics' && isPlainObject(merged)) {
      // The measurement start is recorded by the server, never typed in.
      const started = current.analytics.instrumentation_started_at;
      merged = { ...merged, instrumentation_started_at: started ?? (merged.enabled === true ? nowIso() : null) };
    }
    const parsed = SCHEMAS[key].safeParse(merged);
    if (!parsed.success) {
      for (const i of parsed.error.issues) issues.push({ path: [key, ...i.path.map(String)].join('.'), message: i.message, code: i.code });
      continue;
    }
    next.set(key, parsed.data);
  }
  if (issues.length) throw new AppError('validation_failed', 'Some settings are not valid', { issues });

  const changed: Key[] = [];
  for (const [key, value] of next) {
    const before = current[key];
    if (same(before, value)) continue;
    putSetting(key, value as Settings[typeof key], staff.user.id);
    audit(staff.actor, 'settings.update', { type: 'settings', id: key }, {
      before,
      after: value,
      reason: FUTURE_ONLY_SETTINGS.includes(key) ? 'Applies to orders and visits created from now on' : null,
    });
    changed.push(key);
  }
  if (changed.length) {
    emit('settings.updated', { audience: 'all', payload: { keys: changed } });
    if (changed.some((k) => ORDERING_KEYS.has(k))) emit('ordering.updated', { audience: 'all', payload: { keys: changed.filter((k) => ORDERING_KEYS.has(k)) } });
    if (changed.some((k) => MENU_KEYS.has(k))) emit('menu.updated', { audience: 'all', payload: { reason: 'settings', keys: changed.filter((k) => MENU_KEYS.has(k)) } });
  }
  return settingsView();
}
