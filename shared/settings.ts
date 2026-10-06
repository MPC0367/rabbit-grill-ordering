// Restaurant configuration. Every value here is a PROPOSED default, not a
// verified restaurant policy (brief 02, 25). Owners change them in
// Admin -> More -> Settings; `docs/OWNER-CHECKLIST.md` lists what to confirm.
import type { ChargeRule } from './money.ts';
import type { PermissionOverrides } from './permissions.ts';
import type { ServiceType } from './status.ts';

export type Locale = 'th' | 'en';
export const LOCALES: readonly Locale[] = ['th', 'en'];

export interface DayHours { open: string; close: string } // "11:00" local

export interface PaymentMethod {
  id: string;
  label_th: string;
  label_en: string;
  enabled: boolean;
  /** Cash: record tendered and change. */
  tendered: boolean;
  /** A manual-transfer method may show a payment QR image; staff still verify. */
  payment_qr_image?: string | null;
}

export interface Settings {
  restaurant: { name_th: string; name_en: string; short_th: string; short_en: string };
  /** demo = development fixtures are orderable and flagged; live = only verified items. */
  operating_mode: 'demo' | 'live';
  default_locale: Locale;
  business_day_cutoff_hour: number;
  ordering: {
    enabled: boolean;
    paused_message_th: string;
    paused_message_en: string;
    estimated_wait_minutes: number | null;
    /** Max unaccepted order rounds before intake pauses automatically. null = no limit. */
    intake_limit: number | null;
    enforce_hours: boolean;
    /** Monday..Sunday; empty array = closed. Unverified until the owner confirms. */
    weekly_hours: DayHours[][];
    hours_verified: boolean;
  };
  services: Record<ServiceType, boolean>;
  service_cooldown_seconds: number;
  charges: ChargeRule[];
  charges_confirmed: boolean;
  payment_methods: PaymentMethod[];
  join: { pin_required: boolean; pin_digits: number; max_failures: number; lockout_minutes: number };
  menu: { sold_out_display: 'show_disabled' | 'hide'; note_max_length: number };
  portions: { quote_expiry_minutes: number; allow_preferred_weight: boolean };
  checkout: { after_checkout: 'available' | 'needs_clearing' };
  alcohol: { enabled: boolean; staff_confirmation_note: boolean };
  analytics: { enabled: boolean; idle_threshold_seconds: number; heartbeat_seconds: number; instrumentation_started_at: string | null };
  retention: { notes_days: number; feedback_days: number; audit_days: number; raw_events_days: number };
  notifications: { sound_default: boolean };
  role_permissions: PermissionOverrides;
}

const CLOSED: DayHours[] = [];
const DAY: DayHours[] = [{ open: '11:00', close: '21:00' }];

export const DEFAULT_SETTINGS: Settings = {
  restaurant: { name_th: 'Rabbit Grill เขาใหญ่', name_en: 'Rabbit Grill Khao Yai', short_th: 'Rabbit Grill', short_en: 'Rabbit Grill' },
  operating_mode: 'demo',
  default_locale: 'th',
  business_day_cutoff_hour: 0,
  ordering: {
    enabled: true,
    paused_message_th: 'ครัวขอพักรับออร์เดอร์ใหม่สักครู่ รายการที่สั่งไว้แล้วยังทำต่อตามปกติ',
    paused_message_en: 'The kitchen has paused new orders for a moment. Orders already placed are still being prepared.',
    estimated_wait_minutes: null,
    intake_limit: null,
    enforce_hours: false,
    // Third-party listings say 11:00-21:00, closed Wednesday. NOT confirmed by the restaurant.
    weekly_hours: [DAY, DAY, CLOSED, DAY, DAY, DAY, DAY],
    hours_verified: false,
  },
  services: { call_staff: true, bill: true, order_change: true, allergy_help: true, water: false, utensils: false },
  service_cooldown_seconds: 45,
  charges: [],
  charges_confirmed: false,
  payment_methods: [
    { id: 'cash', label_th: 'เงินสด', label_en: 'Cash', enabled: true, tendered: true },
    { id: 'transfer', label_th: 'โอนเงิน / พร้อมเพย์', label_en: 'Bank transfer / PromptPay', enabled: false, tendered: false, payment_qr_image: null },
    { id: 'card', label_th: 'บัตร (เครื่องรูดของร้าน)', label_en: 'Card (restaurant terminal)', enabled: false, tendered: false },
  ],
  // Off by default: a guest scans the card on their table and is in, with no
  // code to type (D-G-08). The PIN is still here, one switch away, for a
  // restaurant that wants a scanned-from-across-the-room card to be useless.
  join: { pin_required: false, pin_digits: 4, max_failures: 5, lockout_minutes: 5 },
  menu: { sold_out_display: 'show_disabled', note_max_length: 140 },
  portions: { quote_expiry_minutes: 10, allow_preferred_weight: true },
  checkout: { after_checkout: 'available' },
  alcohol: { enabled: true, staff_confirmation_note: true },
  analytics: { enabled: true, idle_threshold_seconds: 30, heartbeat_seconds: 12, instrumentation_started_at: null },
  retention: { notes_days: 400, feedback_days: 730, audit_days: 2555, raw_events_days: 400 },
  notifications: { sound_default: false },
  role_permissions: {},
};

/** Settings whose change affects only orders created afterwards. */
export const FUTURE_ONLY_SETTINGS: ReadonlyArray<keyof Settings> = ['charges', 'business_day_cutoff_hour', 'operating_mode'];
