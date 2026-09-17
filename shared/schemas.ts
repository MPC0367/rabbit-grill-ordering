// Request validation (zod v4). Every API body is parsed with one of these on
// the server; the client imports the same schemas for form validation.
import { z } from 'zod';
import { LINE_STATUSES, SERVICE_STATUSES, SERVICE_TYPES, ITEM_STATUSES, REVIEW_STATUSES, PRICING_TYPES, STATIONS } from './status.ts';
import { ROLES } from './permissions.ts';

const id = z.string().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/);
export const idempotencyKey = z.string().min(12).max(64).regex(/^[A-Za-z0-9_-]+$/);
const minor = z.number().int().safe();
const nonNegMinor = minor.min(0);
const shortText = (max: number) => z.string().trim().max(max);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoInstant = z.string().datetime({ offset: true });
export const locale = z.enum(['th', 'en']);
/** Longest image alt text (admin form and CSV import share it). */
export const IMAGE_ALT_MAX = 160;

// ------------------------------------------------------------------ guest access
export const QrResolveBody = z.object({ token: z.string().min(16).max(128) });
export const JoinBody = z.object({
  token: z.string().min(16).max(128),
  pin: z.string().regex(/^\d{4,8}$/).optional(),
});

// ------------------------------------------------------------------ cart
export const CartLineInput = z.object({
  item_id: id,
  variant_id: id.nullish(),
  quantity: z.number().int().min(1).max(99),
  modifiers: z.array(z.object({ group_id: id, option_ids: z.array(id).max(20) })).max(20).default([]),
  // Notes are stored exactly as typed (trim only). Length is re-checked per item.
  note: z.string().max(500).nullish(),
  /** Guest ticked "this note is about an allergy": the ticket shows it prominently. */
  allergy_note: z.boolean().nullish(),
  /** What the guest saw per unit (price + choices); a mismatch returns price_changed rather than charging a different amount. */
  expected_unit_minor: nonNegMinor.nullish(),
});
export type CartLineInput = z.infer<typeof CartLineInput>;

export const QuoteBody = z.object({ lines: z.array(CartLineInput).max(60) });

export const SubmitOrderBody = z.object({
  idempotency_key: idempotencyKey,
  lines: z.array(CartLineInput).min(1).max(60),
  expected_subtotal_minor: nonNegMinor,
  locale: locale.default('th'),
  analytics_session_id: z.string().max(64).nullish(),
});
export type SubmitOrderBody = z.infer<typeof SubmitOrderBody>;

// ------------------------------------------------------------------ service, feedback, portions
export const ServiceRequestBody = z.object({
  type: z.enum(SERVICE_TYPES),
  note: shortText(200).nullish(),
  idempotency_key: idempotencyKey,
});

export const BillRequestBody = z.object({ idempotency_key: idempotencyKey });

export const FeedbackBody = z.object({
  rating: z.number().int().min(1).max(5).nullish(),
  comment: shortText(500).nullish(),
  idempotency_key: idempotencyKey,
});

export const PortionRequestBody = z.object({
  item_id: id,
  preferred_grams: z.number().int().min(50).max(5000).nullish(),
  note: shortText(200).nullish(),
  idempotency_key: idempotencyKey,
});

export const PortionConfirmBody = z.object({
  quote_id: id,
  revision: z.number().int().min(1),
  idempotency_key: idempotencyKey,
});

export const PortionDeclineBody = z.object({ quote_id: id, revision: z.number().int().min(1) });

// ------------------------------------------------------------------ analytics
export const ANALYTICS_EVENT_TYPES = [
  'menu_view', 'active_time_chunk', 'category_view', 'item_impression', 'item_detail_open',
  'item_detail_active_time', 'scroll_depth', 'cart_add', 'cart_remove', 'session_end',
] as const;

export const AnalyticsEvent = z.object({
  event_id: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  type: z.enum(ANALYTICS_EVENT_TYPES),
  seq: z.number().int().min(0),
  /** Milliseconds since the session started, from a monotonic clock. */
  elapsed_ms: z.number().int().min(0).max(24 * 3_600_000),
  route: z.enum(['menu', 'item', 'cart', 'track', 'bill', 'join', 'other']).default('menu'),
  item_id: id.nullish(),
  category_id: id.nullish(),
  active_ms: z.number().int().min(0).max(120_000).nullish(),
  depth: z.number().int().min(0).max(100).nullish(),
  position: z.number().int().min(0).max(500).nullish(),
  quantity_delta: z.number().int().min(-99).max(99).nullish(),
  quick_add: z.boolean().nullish(),
  interaction_ref: z.string().max(64).nullish(),
  layout_version: z.string().max(32).nullish(),
  menu_version: z.string().max(64).nullish(),
});
export type AnalyticsEvent = z.infer<typeof AnalyticsEvent>;

export const AnalyticsBatchBody = z.object({
  session_id: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  locale: locale.default('th'),
  opted_out: z.boolean().default(false),
  events: z.array(AnalyticsEvent).max(100),
});

// ------------------------------------------------------------------ staff auth & team
export const LoginBody = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(256) });
export const PasswordRule = z.string().min(10).max(256);
export const CreateStaffBody = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[a-z0-9._-]+$/i),
  display_name: shortText(60).min(1),
  role: z.enum(ROLES),
  password: PasswordRule,
});
export const UpdateStaffBody = z.object({
  display_name: shortText(60).min(1).optional(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
  version: z.number().int(),
});
export const SetPasswordBody = z.object({ password: PasswordRule, current_password: z.string().max(256).optional() });

// ------------------------------------------------------------------ fulfilment
export const TransitionBody = z.object({
  lines: z.array(z.object({ id, version: z.number().int() })).min(1).max(100),
  to: z.enum(LINE_STATUSES),
  reason: shortText(200).nullish(),
});
export type TransitionBody = z.infer<typeof TransitionBody>;

export const FinishOrderBody = z.object({
  version: z.number().int(),
  /** Explicit resolutions for lines that are not yet served. */
  resolutions: z.array(z.object({ line_id: id, version: z.number().int(), action: z.enum(['served', 'cancel']), reason: shortText(200).nullish() })).max(100).default([]),
});

export const AssistOrderBody = z.object({
  visit_id: id,
  idempotency_key: idempotencyKey,
  lines: z.array(CartLineInput).min(1).max(60),
  expected_subtotal_minor: nonNegMinor,
});

export const StaffQuoteBody = z.object({ visit_id: id, lines: z.array(CartLineInput).max(60) });

export const RecoverOrderBody = z.object({
  visit_id: id,
  manual_reference: z.string().trim().min(1).max(40),
  original_time: isoInstant,
  lines: z.array(CartLineInput).min(1).max(60),
  already: z.enum(['none', 'prepared', 'served']),
  reason: shortText(200).min(3),
});

export const ServiceTransitionBody = z.object({
  to: z.enum(SERVICE_STATUSES),
  version: z.number().int(),
  reason: shortText(200).nullish(),
});

export const StaffPortionRequestBody = PortionRequestBody.extend({ visit_id: id });
export const PortionQuoteBody = z.object({
  grams: z.number().int().min(1).max(10_000),
  choices: z.array(z.object({ group_id: id, option_ids: z.array(id).max(20) })).max(10).default([]),
  note: shortText(200).nullish(),
  expires_minutes: z.number().int().min(1).max(120).nullish(),
  version: z.number().int(),
});
export const PortionInPersonBody = PortionConfirmBody.extend({ note: shortText(200).nullish() });
export const PortionCancelBody = z.object({ reason: shortText(200).min(2), version: z.number().int() });

// ------------------------------------------------------------------ tables & visits
export const CreateTableBody = z.object({ label: shortText(24).min(1), zone: shortText(40).nullish(), sort: z.number().int().optional() });
export const UpdateTableBody = z.object({
  label: shortText(24).min(1).optional(),
  zone: shortText(40).nullish(),
  sort: z.number().int().optional(),
  enabled: z.boolean().optional(),
  ordering_paused: z.boolean().optional(),
  version: z.number().int(),
});
export const RotateQrBody = z.object({ version: z.number().int(), reason: shortText(200).min(3) });
export const OpenVisitBody = z.object({ covers: z.number().int().min(1).max(99).nullish(), idempotency_key: idempotencyKey });
export const UpdateVisitBody = z.object({ covers: z.number().int().min(1).max(99).nullable(), version: z.number().int() });
export const VersionBody = z.object({ version: z.number().int() });
export const VersionReasonBody = z.object({ version: z.number().int(), reason: shortText(200).min(3) });
export const TransferVisitBody = z.object({ to_table_id: id, version: z.number().int(), reason: shortText(200).min(3) });

// ------------------------------------------------------------------ billing
export const FinalizeBillBody = z.object({ bill_version: z.number().int(), expected_total_minor: nonNegMinor });
export const AdjustmentBody = z.object({
  kind: z.enum(['discount', 'comp', 'correction']),
  amount_minor: minor.refine((v) => v !== 0, 'amount must not be zero'),
  reason: shortText(200).min(3),
  order_line_id: id.nullish(),
});
export const PaymentBody = z.object({
  revision_id: id,
  method: z.string().min(1).max(32),
  amount_minor: nonNegMinor,
  tendered_minor: nonNegMinor.nullish(),
  reference: shortText(80).nullish(),
  idempotency_key: idempotencyKey,
});
export const ReversePaymentBody = z.object({ reason: shortText(200).min(3), idempotency_key: idempotencyKey });
export const CheckoutBody = z.object({
  idempotency_key: idempotencyKey,
  /** Manager exception: close despite unresolved items / unpaid bill, with a reason. */
  exception_reason: shortText(200).nullish(),
  /** Attributable closure reason for any still-open non-food service requests. */
  request_close_reason: shortText(200).nullish(),
});

// ------------------------------------------------------------------ catalog admin
const bil = (max: number) => shortText(max).nullish();
export const ItemInput = z.object({
  category_id: id,
  name_th: bil(120), name_en: bil(120),
  desc_th: bil(400), desc_en: bil(400),
  desc_verified: z.boolean().optional(),
  portion_note_th: bil(60), portion_note_en: bil(60),
  pricing_type: z.enum(PRICING_TYPES),
  price_minor: nonNegMinor.nullish(),
  rate_minor: nonNegMinor.nullish(),
  rate_basis_grams: z.number().int().min(1).max(1000).nullish(),
  variants: z.array(z.object({ id: id.nullish(), key: z.string().min(1).max(40), name_th: bil(60), name_en: bil(60), price_minor: nonNegMinor.nullish(), available: z.boolean() })).max(12).optional(),
  modifier_group_ids: z.array(id).max(10).optional(),
  notes_allowed: z.boolean().optional(),
  note_max: z.number().int().min(0).max(500).optional(),
  max_qty: z.number().int().min(1).max(99).optional(),
  station: z.enum(STATIONS).optional(),
  alcohol: z.boolean().optional(),
  requires_staff_confirm: z.boolean().optional(),
  image: z.string().max(80).regex(/^[a-z0-9-]+$/).nullish(),
  // 160, not the usual 125 guideline: the audited photo descriptions in
  // data-src/catalog.json run to ~145 characters and must stay editable.
  image_alt_th: bil(IMAGE_ALT_MAX), image_alt_en: bil(IMAGE_ALT_MAX),
  review_notes: bil(1000),
  price_change_reason: bil(200),
});
export const CreateItemBody = ItemInput;
export const UpdateItemBody = ItemInput.partial().extend({ version: z.number().int() });
export const AvailabilityBody = z.object({ sold_out: z.boolean(), version: z.number().int().optional() });
export const ItemStatusBody = z.object({ status: z.enum(ITEM_STATUSES), version: z.number().int() });
export const ReviewBody = z.object({
  review_status: z.enum(REVIEW_STATUSES),
  notes: shortText(1000).nullish(),
  allergens: z.object({
    status: z.enum(['unknown', 'verified']),
    entries: z.array(z.object({ allergen: z.string().min(1).max(40), state: z.enum(['contains', 'may_contain']), note: shortText(120).nullish() })).max(20),
  }).optional(),
  version: z.number().int(),
});
export const CategoryInput = z.object({
  group: z.enum(['food', 'drinks']),
  name_th: bil(80), name_en: shortText(80).min(1),
  note_th: bil(200), note_en: bil(200),
  status: z.enum(ITEM_STATUSES).optional(),
  seasonal: z.boolean().optional(),
  active_from: isoDate.nullish(), active_until: isoDate.nullish(),
  station: z.enum(STATIONS).optional(),
  alcohol: z.boolean().optional(),
  ordering_paused: z.boolean().optional(),
});
export const UpdateCategoryBody = CategoryInput.partial().extend({ version: z.number().int() });
export const ModifierGroupInput = z.object({
  key: z.string().min(2).max(40).regex(/^[a-z0-9-]+$/),
  name_th: bil(80), name_en: shortText(80).min(1),
  min_select: z.number().int().min(0).max(20),
  max_select: z.number().int().min(1).max(20),
  included_count: z.number().int().min(0).max(20),
  options: z.array(z.object({
    id: id.nullish(), key: z.string().min(1).max(40), name_th: bil(80), name_en: shortText(80).min(1),
    price_delta_minor: nonNegMinor, upgrade_minor: nonNegMinor.default(0), is_default: z.boolean().default(false), available: z.boolean().default(true),
  })).min(1).max(30),
}).refine((g) => g.max_select >= g.min_select, { message: 'max_select must be >= min_select' });
export const ReorderBody = z.object({ entity: z.enum(['category', 'item']), ids: z.array(id).min(1).max(500) });
export const ResolveFlagBody = z.object({ resolution: shortText(300).min(2) });
export const ImportPreviewBody = z.object({ filename: shortText(120).default('menu.csv'), csv: z.string().max(2_000_000) });

// ------------------------------------------------------------------ ordering state & settings
export const OrderingStateBody = z.object({
  enabled: z.boolean().optional(),
  paused_message_th: shortText(300).optional(),
  paused_message_en: shortText(300).optional(),
  estimated_wait_minutes: z.number().int().min(1).max(240).nullable().optional(),
  intake_limit: z.number().int().min(1).max(500).nullable().optional(),
  reason: shortText(200).nullish(),
});
export const SettingsPatchBody = z.record(z.string(), z.unknown());

// ------------------------------------------------------------------ insights & reports
export const StatsQuery = z.object({
  period: z.enum(['week', 'month', 'year', 'custom']).default('week'),
  anchor: isoDate.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  include_fixture: z.enum(['0', '1']).default('0'),
});
export const ReportJobBody = z.object({
  year: z.number().int().min(2020).max(2100),
  kind: z.enum(['annual_pdf', 'annual_csv']),
  reason: shortText(200).nullish(),
  include_fixture: z.boolean().default(false),
});

export { id as IdSchema, isoDate as IsoDateSchema };
