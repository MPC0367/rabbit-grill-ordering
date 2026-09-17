// Response shapes shared by the API and both interfaces.
// Money is always integer satang (`*_minor`); times are UTC ISO strings.
import type { ChargeLine, Minor } from './money.ts';
import type { Permission, Role } from './permissions.ts';
import type { Locale, PaymentMethod } from './settings.ts';
import type {
  BillStatus, JobStatus, LineStatus, OrderStatus, PaymentKind, PaymentStatus, PortionRequestStatus,
  PricingType, QuoteStatus, ReportLabel, ReviewStatus, ItemStatus, ServiceStatus, ServiceType, Station,
  TableState, VisitStatus, LineCounts,
} from './status.ts';

export interface Bilingual { th: string | null; en: string | null }

// ------------------------------------------------------------------ public config
export interface PublicConfigDTO {
  restaurant: { name_th: string; name_en: string; short_th: string; short_en: string };
  operating_mode: 'demo' | 'live';
  default_locale: Locale;
  ordering: {
    enabled: boolean;
    paused_message: Bilingual;
    estimated_wait_minutes: number | null;
    within_hours: boolean | null; // null when hours are not enforced
  };
  services: ServiceType[];
  analytics: { enabled: boolean; idle_threshold_seconds: number; heartbeat_seconds: number };
  notes_max_length: number;
  sold_out_display: 'show_disabled' | 'hide';
  server_time: string;
  /** The hour (Bangkok) a business day starts, and today's business date by that rule, so staff screens date things like the server. */
  business_day_cutoff_hour?: number;
  business_date?: string;
}

// ------------------------------------------------------------------ catalog
export interface ModifierOptionDTO {
  id: string;
  name: Bilingual;
  price_delta_minor: Minor;
  upgrade_minor: Minor;
  is_default: boolean;
  available: boolean;
}

export interface ModifierGroupDTO {
  id: string;
  name: Bilingual;
  min_select: number;
  max_select: number;
  included_count: number;
  options: ModifierOptionDTO[];
}

export interface VariantDTO {
  id: string;
  key: string;
  name: Bilingual;
  price_minor: Minor | null;
  available: boolean;
}

export type AllergenState = 'contains' | 'may_contain';
export interface AllergenInfoDTO {
  /** unknown = not verified. Unknown never means allergen-free. */
  status: 'unknown' | 'verified';
  entries: Array<{ allergen: string; state: AllergenState; note: string | null }>;
  verified_at: string | null;
}

export interface MenuItemDTO {
  id: string;
  key: string;
  category_id: string;
  name: Bilingual;
  description: Bilingual | null; // only verified descriptions are public
  portion_note: Bilingual | null;
  pricing_type: PricingType;
  price_minor: Minor | null;               // fixed
  rate_minor: Minor | null;                // measured_weight
  rate_basis_grams: number | null;
  variants: VariantDTO[];
  modifier_groups: ModifierGroupDTO[];
  image: { name: string; alt: Bilingual; w: number; h: number; sizes: number[] } | null;
  station: Station;
  alcohol: boolean;
  notes_allowed: boolean;
  note_max: number;
  max_qty: number;
  sold_out: boolean;
  /** Can be added to a draft right now (published, priced, verified or demo, not sold out, category active). */
  orderable: boolean;
  /** Why not, when not orderable: sold_out | price_pending | not_verified | seasonal | paused | alcohol_disabled */
  unavailable_reason: string | null;
  /** Fixed-price item with no required choices: may be quick-added. */
  quick_add: boolean;
  allergens: AllergenInfoDTO;
  badges: string[]; // evidence-based only, e.g. "demo_fixture", "staff_confirms_portion"
  sort: number;
  version: number;
}

export interface MenuCategoryDTO {
  id: string;
  key: string;
  group: 'food' | 'drinks';
  name: Bilingual;
  note: Bilingual | null;
  seasonal: boolean;
  alcohol: boolean;
  sort: number;
  item_ids: string[];
}

export interface CatalogDTO {
  version: string; // changes whenever anything guest-visible changes
  groups: Array<{ key: 'food' | 'drinks'; name: Bilingual; category_ids: string[] }>;
  categories: MenuCategoryDTO[];
  items: MenuItemDTO[];
  generated_at: string;
}

// ------------------------------------------------------------------ guest session
export interface GuestSessionDTO {
  guest_id: string;
  visit: {
    id: string;
    status: VisitStatus;
    table_label: string;
    seated_at: string;
    bill_requested_at: string | null;
  };
  ordering: { allowed: boolean; reason: string | null };
  services: ServiceType[];
}

export interface QrResolveDTO {
  table_label: string;
  state: 'ready' | 'no_open_visit' | 'disabled';
  pin_required: boolean;
  /** true when this browser already holds valid access to this table's current visit */
  already_joined: boolean;
}

// ------------------------------------------------------------------ cart / quote
export interface QuoteIssue {
  line_index: number;
  code: 'item_missing' | 'sold_out' | 'not_orderable' | 'price_changed' | 'variant_unavailable' | 'variant_required'
    | 'modifier_unavailable' | 'modifier_invalid' | 'modifier_required' | 'quantity_invalid' | 'note_too_long'
    | 'notes_not_allowed' | 'measured_weight_needs_quote';
  message: string;
  current?: { unit_price_minor?: Minor; line_total_minor?: Minor };
}

export interface QuoteLineDTO {
  line_index: number;
  ok: boolean;
  item_id: string;
  name: Bilingual;
  variant_name: Bilingual | null;
  modifiers: Array<{ group: Bilingual; options: Array<{ name: Bilingual; price_minor: Minor }> }>;
  unit_price_minor: Minor;
  modifiers_minor: Minor;
  quantity: number;
  line_total_minor: Minor;
}

export interface QuoteDTO {
  lines: QuoteLineDTO[];
  issues: QuoteIssue[];
  subtotal_minor: Minor;
  /** Charges are applied on the table bill; shown here for transparency. */
  charges_preview: ChargeLine[];
  estimated_total_minor: Minor;
  catalog_version: string;
}

// ------------------------------------------------------------------ orders
export interface LineStepDTO {
  status: LineStatus;
  at: string;
  kind: 'forward' | 'reject' | 'cancel' | 'correction' | 'recovery';
  reason: string | null;
  actor: string | null; // staff display name (staff views only)
}

export interface OrderLineDTO {
  id: string;
  item_id: string;
  name: Bilingual;
  variant_name: Bilingual | null;
  modifiers: Array<{ group: Bilingual; options: Array<{ name: Bilingual; price_minor: Minor }> }>;
  quantity: number;
  unit_price_minor: Minor;
  modifiers_minor: Minor;
  line_total_minor: Minor;
  measured_grams: number | null;
  rate_minor: Minor | null;
  rate_basis_grams: number | null;
  note: string | null;
  allergy_flag: boolean;
  station: Station;
  prep_kind: 'cook' | 'prepare';
  status: LineStatus;
  status_reason: string | null;
  steps: LineStepDTO[];
  version: number;
}

export interface OrderDTO {
  id: string;
  reference: string;
  table_label: string;
  round_no: number;
  source: 'guest' | 'staff' | 'manual_recovery' | 'portion_quote';
  submitted_at: string;
  status: OrderStatus;
  counts: LineCounts;
  lines: OrderLineDTO[];
  subtotal_minor: Minor;
  /** Guest view: whether this browser placed it. */
  mine?: boolean;
  last_update_at: string;
  version: number;
}

export interface StaffOrderDTO extends OrderDTO {
  visit_id: string;
  table_id: string;
  guest_label: string | null; // "Guest 2" style, never a device id
  staff_name: string | null;
  manual_reference: string | null;
  finished_at: string | null;
  is_fixture: boolean;
  has_allergy_note: boolean;
  oldest_unaccepted_at: string | null;
  /** Where the party sits now (differs from `table_label` after a visit transfer; S3). */
  current_table_label?: string;
  current_table_id?: string;
  /** The viewer lacks orders.view_bill_values: every amount in this order is sent as 0 (not a real price). */
  money_hidden?: boolean;
}

export interface SubmitResultDTO {
  order: OrderDTO;
  replayed: boolean;
}

export interface AttemptLookupDTO {
  status: 'created' | 'not_found';
  order?: OrderDTO;
}

// ------------------------------------------------------------------ service & feedback
export interface ServiceRequestDTO {
  id: string;
  type: ServiceType;
  note: string | null;
  status: ServiceStatus;
  table_label: string;
  visit_id: string;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  completed_at: string | null;
  close_reason: string | null;
  version: number;
  /** Staff views only (null for guests): who completed / cancelled it, and when it was cancelled. */
  completed_by?: string | null;
  cancelled_at?: string | null;
  cancelled_by?: string | null;
}

// ------------------------------------------------------------------ portions
export interface PortionQuoteDTO {
  id: string;
  revision: number;
  grams: number;
  rate_minor: Minor;
  rate_basis_grams: number;
  amount_minor: Minor;
  choices: Array<{ group: Bilingual; options: Array<{ name: Bilingual }> }>;
  note: string | null;
  expires_at: string;
  status: QuoteStatus;
  created_at: string;
  /** amount_minor = measured_minor (grams x rate, half-up) + modifiers_minor (charged choices, usually 0). */
  measured_minor?: Minor;
  modifiers_minor?: Minor;
  confirmed_at?: string | null;
  confirmed_via?: 'guest' | 'in_person' | null;
}

export interface PortionRequestDTO {
  id: string;
  item_id: string;
  item_name: Bilingual;
  table_label: string;
  visit_id: string;
  preferred_grams: number | null;
  note: string | null;
  status: PortionRequestStatus;
  quote: PortionQuoteDTO | null;
  order_reference: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  /** The order created by confirmation (with order_reference). */
  order_id?: string | null;
  /** Who started the request. */
  source?: 'guest' | 'staff';
  /** The item's current approved rate, for the staff quote form preview (null when not priced). */
  current_rate?: { rate_minor: Minor; rate_basis_grams: number } | null;
  /** Why a declined / cancelled request ended. */
  resolution_reason?: string | null;
}

// ------------------------------------------------------------------ bills and payments
export interface BillLineDTO {
  order_reference: string;
  line_id: string;
  name: Bilingual;
  variant_name: Bilingual | null;
  quantity: number;
  measured_grams: number | null;
  line_total_minor: Minor;
  status: LineStatus;
}

export interface BillRevisionDTO {
  id: string;
  revision_no: number;
  status: 'payable' | 'superseded' | 'settled';
  lines: BillLineDTO[];
  subtotal_minor: Minor;
  adjustments: Array<{ id: string; kind: string; amount_minor: Minor; reason: string }>;
  adjustments_minor: Minor;
  charges: ChargeLine[];
  total_minor: Minor;
  finalized_at: string;
  finalized_by: string | null;
  superseded_at: string | null;
  supersede_reason: string | null;
}

export interface PaymentDTO {
  id: string;
  kind: PaymentKind;
  status: PaymentStatus;
  method: string;
  method_label: Bilingual;
  amount_minor: Minor;
  tendered_minor: Minor | null;
  change_minor: Minor | null;
  reference: string | null; // staff with payments.view only
  bill_revision_id: string;
  confirmed_by: string | null;
  confirmed_at: string;
  reverses_payment_id: string | null;
  reason: string | null;
  /** S5: which visit/table the record belongs to (payments list). */
  visit_id?: string;
  table_label?: string;
}

export interface GuestBillDTO {
  visit_status: VisitStatus;
  bill_status: BillStatus;
  table_label: string;
  /** Accepted, chargeable lines (running view until a revision is finalized). */
  lines: BillLineDTO[];
  /** Submitted but not yet accepted: shown separately, not in the amount due. */
  pending_lines: BillLineDTO[];
  excluded_lines: BillLineDTO[];
  subtotal_minor: Minor;
  adjustments_minor: Minor;
  charges: ChargeLine[];
  total_minor: Minor;
  revision_no: number | null;
  paid: boolean;
  bill_requested_at: string | null;
  checkout_complete: boolean;
}

export interface StaffBillDTO extends GuestBillDTO {
  visit_id: string;
  bill_id: string;
  bill_version: number;
  visit_version: number;
  current_revision: BillRevisionDTO | null;
  revisions: BillRevisionDTO[];
  payments: PaymentDTO[];
  unresolved: { submitted_lines: number; unserved_lines: number; open_requests: number; open_portion_requests: number };
  payment_methods: PaymentMethod[];
  can_checkout: boolean;
  checkout_blockers: string[];
  /** S5: the live total from current lines (equals total_minor until a revision is finalized). */
  running_total_minor?: Minor;
  /** S5: the payable revision no longer matches the lines (an item was cancelled after finalizing): finalize again. */
  revision_stale?: boolean;
  /**
   * What happened to the money of the current revision (D-S8-04):
   * none = nothing settled; paid = a confirmed settlement is in force (or the bill owed 0);
   * reversed = the settlement was reversed on an open visit;
   * refunded = the settlement was refunded after checkout (bill_status stays "settled" as history, paid is false).
   */
  payment_state?: 'none' | 'paid' | 'reversed' | 'refunded';
  /** The refund recorded after checkout, when payment_state is "refunded". */
  refund?: { amount_minor: Minor; reason: string | null; by: string | null; at: string } | null;
  /** Adjustments counting on the running bill (a dish-linked one only while that dish is on the bill). */
  adjustments?: Array<{
    id: string; kind: 'discount' | 'comp' | 'correction'; amount_minor: Minor; reason: string; order_line_id: string | null;
    created_at: string; created_by: string | null; voided_at: string | null; voided_by: string | null; void_reason: string | null;
  }>;
  /** Voided adjustments, newest first (voided by a manager, or because their dish was cancelled or rejected). */
  voided_adjustments?: StaffBillDTO['adjustments'];
}

// ------------------------------------------------------------------ tables & visits
export interface TableTileDTO {
  id: string;
  label: string;
  zone: string | null;
  sort: number;
  enabled: boolean;
  ordering_paused: boolean;
  state: TableState;
  version: number;
  visit: null | {
    id: string;
    status: VisitStatus;
    seated_at: string;
    covers: number | null;
    rounds: number;
    unresolved_lines: number;
    ready_lines: number;
    unaccepted_rounds: number;
    open_requests: number;
    bill_requested: boolean;
    guests: number;
    version: number;
    /** Joining is locked after too many wrong PINs (rotate the PIN to unlock). */
    pin_locked?: boolean;
  };
  attention: Array<'new_order' | 'ready_food' | 'service_request' | 'bill_requested' | 'portion_request'>;
  /**
   * Printed QR card state (S2). `rotated_at` is set once the table's QR has
   * been rotated: every card printed before that no longer works.
   * `reprint_required` stays true until the new card has been downloaded.
   */
  qr?: { issued_at: string; rotated_at: string | null; reprint_required: boolean };
}

export interface TablesDTO {
  tables: TableTileDTO[];
  counts: Record<TableState, number>;
  server_time: string;
}

export interface VisitDetailDTO {
  id: string;
  table: { id: string; label: string; state: TableState };
  status: VisitStatus;
  join_pin: string | null; // staff with visits.open only
  pin_rotated_at: string | null;
  covers: number | null;
  seated_at: string;
  opened_by: string | null;
  closed_at: string | null;
  guests: Array<{ label: string; joined_at: string; last_seen_at: string | null; revoked: boolean }>;
  orders: StaffOrderDTO[];
  requests: ServiceRequestDTO[];
  portions: PortionRequestDTO[];
  bill: StaffBillDTO | null;
  history: AuditEntryDTO[];
  qr_url: string;
  version: number;
  /** Too many wrong PINs: joining is locked until this time (rotating the PIN unlocks). */
  pin_locked_until?: string | null;
  /** Repeated lockouts: joining stays locked until staff rotate the PIN (D-S8-07). */
  pin_lock_requires_rotation?: boolean;
}

export interface CheckoutResultDTO {
  visit_id: string;
  status: 'closed';
  closed_at: string;
  table: TableTileDTO;
  replayed: boolean;
}

// ------------------------------------------------------------------ staff
export interface StaffUserDTO {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  active: boolean;
  is_fixture: boolean;
  created_at: string;
  last_login_at: string | null;
  version: number;
}

export interface StaffMeDTO {
  user: StaffUserDTO;
  permissions: Permission[];
  landing: string;
  operating_mode: 'demo' | 'live';
}

export interface OverviewDTO {
  ordering: PublicConfigDTO['ordering'];
  counts: Record<TableState, number>;
  unaccepted_rounds: number;
  oldest_unaccepted_at: string | null;
  ready_lines: number;
  open_requests: number;
  oldest_request_at: string | null;
  open_portion_requests: number;
  bills_requested: number;
  blockers: string[];
  server_time: string;
}

export interface AuditEntryDTO {
  id: number;
  at: string;
  actor_type: 'staff' | 'guest' | 'system';
  actor_label: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  visit_id: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
}

// ------------------------------------------------------------------ admin catalog
export interface AdminItemDTO extends MenuItemDTO {
  status: ItemStatus;
  review_status: ReviewStatus;
  demo_orderable: boolean;
  description_admin: Bilingual; // including unverified drafts
  desc_verified: boolean;
  name_th_source: string | null;
  translation_status: string | null;
  source: { url: string | null; ref: string | null; text: string | null; retrieved_at: string | null };
  reviewer: string | null;
  approved_at: string | null;
  review_notes: string | null;
  flags: Array<{ id: string; code: string; detail: string; resolved_at: string | null; resolution: string | null }>;
  price_history: Array<{ at: string; price_minor: Minor | null; rate_minor: Minor | null; by: string | null; reason: string | null }>;
  publish_blockers: string[];
  unpublished_changes: boolean;
  requires_staff_confirm: boolean;
  /** The dish's own tracker wording choice (null = follows its category / the default). */
  prep_kind_override?: 'cook' | 'prepare' | null;
  /** The wording new order lines get: "Currently cooking" (cook) or "Currently preparing" (prepare). */
  prep_kind?: 'cook' | 'prepare';
  modifier_group_ids: string[];
  updated_at: string;
  /** S1: price changes of individual variants (price_history above covers the item's own price/rate). */
  variant_price_history?: Array<{ at: string; variant_id: string; variant_key: string | null; variant_name: Bilingual | null; price_minor: Minor | null; by: string | null; reason: string | null }>;
}

export interface AdminCatalogDTO {
  groups: CatalogDTO['groups'];
  categories: Array<MenuCategoryDTO & { status: ItemStatus; ordering_paused: boolean; station: Station; active_from: string | null; active_until: string | null; source_note: string | null; version: number; prep_kind?: 'cook' | 'prepare' | null }>;
  items: AdminItemDTO[];
  modifier_groups: Array<ModifierGroupDTO & { key: string; item_ids: string[]; version: number }>;
  review: {
    imported: number; live_ready: number; demo_orderable: number; missing_photo: number; missing_description: number;
    missing_thai: number; ambiguous_price: number; pending_portion_rules: number; seasonal_disabled: number; open_flags: number;
  };
}

// ------------------------------------------------------------------ insights
export type StatsPeriod = 'week' | 'month' | 'year' | 'custom';
export type OrderMetric = 'rounds' | 'accepted_rounds' | 'visits' | 'devices' | 'diners' | 'items';

export interface DayBucketDTO {
  date: string;              // local business date (or YYYY-MM for year view)
  label: string;
  state: 'complete' | 'partial' | 'future' | 'missing';
  value: number | null;      // null for future / missing
  breakdown: { submitted: number; accepted: number; rejected: number; cancelled: number; visits: number; devices: number; diners: number; diners_coverage: { with_covers: number; visits: number }; items: number };
}

export interface OrderStatsDTO {
  metric: OrderMetric;
  period: StatsPeriod;
  from: string;
  to: string;
  buckets: DayBucketDTO[];
  total: number;             // recomputed at period level (distinct metrics are not summed)
  previous: { from: string; to: string; total: number | null; comparable: boolean; note: string | null };
  change: { absolute: number | null; percent: number | null; label: 'up' | 'down' | 'flat' | 'no_baseline' | 'unequal_coverage' };
  cards: {
    orders_today: number; visits_ordering_today: number;
    diners_today: number; diners_coverage_today: { with_covers: number; visits: number };
    median_accept_seconds: number | null; accept_sample: number;
    unresolved_orders: number;
  };
  include_fixture: boolean;
  generated_at: string;
  /** S6: earliest seated business date in scope; days before it are 'missing'. */
  first_operating_date?: string | null;
}

export interface DayDrilldownDTO {
  date: string;
  orders: Array<{ id: string; reference: string; table_label: string; submitted_at: string; source: string; items: number; status: OrderStatus; subtotal_minor: Minor | null }>;
  hourly: Array<{ hour: number; rounds: number; items: number }>;
  /** S6 additions. */
  include_fixture?: boolean;
  generated_at?: string;
}

export interface RankingRowDTO {
  rank: number;
  item_id: string;
  name: Bilingual;
  category: Bilingual;
  image: string | null;
  measured_weight: boolean;
  net_qty: number;
  submitted_qty: number;
  grams: number | null;
  orders: number;
  visits: number;
  share: number | null;        // of selected-category quantity, 0..1
  change: { previous: number | null; label: 'up' | 'down' | 'flat' | 'new' | 'no_baseline'; delta: number | null };
  available_days: number | null;
  period_days: number;
  per_available_day: number | null;
  availability: 'full' | 'partial' | 'insufficient' | 'unknown';
  quality: 'never_ordered_despite_availability' | 'insufficient_availability' | null;
  archived: boolean;
  variants: Array<{ name: Bilingual; net_qty: number }>;
}

export interface MenuStatsDTO {
  period: StatsPeriod;
  from: string;
  to: string;
  direction: 'most' | 'least';
  measure: 'net' | 'submitted' | 'per_available_day' | 'grams';
  category_id: string | null;
  rows: RankingRowDTO[];
  totals: { net_qty: number; items_ranked: number; zero_order_items: number };
  tie_policy: string;
  include_fixture: boolean;
  generated_at: string;
  /** S6: the comparison window behind each row's `change`. */
  previous?: { from: string; to: string; comparable: boolean; note: string | null };
}

export interface ItemStatsDTO {
  item_id: string;
  name: Bilingual;
  weekly: Array<{ week_start: string; net_qty: number }>;
  variants: Array<{ name: Bilingual; net_qty: number }>;
  /** add_rate: sessions that saw the dish and added it / sessions that saw it (D-S8-06). */
  engagement: { impressions: number; detail_opens: number; detail_active_ms_median: number | null; adds: number; add_rate: number | null; submitted_orders: number; sample_sessions: number };
  portion_funnel: null | { requests: number; quoted: number; confirmed: number; grams_total: number };
  availability_days: number | null;
  /** S6 additions: the period the figures cover. */
  from?: string;
  to?: string;
  period?: StatsPeriod;
  period_days?: number;
  include_fixture?: boolean;
  generated_at?: string;
}

export interface EngagementDTO {
  from: string;
  to: string;
  coverage: { measured_sessions: number; dining_sessions: number; public_sessions: number; opted_out_sessions: number; telemetry_since: string | null; note: string | null };
  active_menu_ms: { median: number | null; p90: number | null; sample: number };
  active_detail_ms: { median: number | null; p90: number | null; sample: number };
  categories: Array<{ category_id: string; name: Bilingual; sessions_exposed: number; share: number | null }>;
  /**
   * add_rate = sessions that saw the dish and added it / sessions that saw it (impression_sessions), D-S8-06.
   * impressions and adds are event counts (an impression is recorded once per session, an add on every tap).
   */
  items: Array<{ item_id: string; name: Bilingual; impressions: number; detail_opens: number; adds: number; add_rate: number | null; submitted: number; impression_sessions?: number; add_sessions?: number }>;
  funnel: {
    sessions: number; impression_sessions: number; detail_sessions: number; add_sessions: number; quick_add_sessions: number; submit_sessions: number;
    attributed_orders: number; unattributed_orders: number;
  };
  /** Sessions whose deepest MENU-route scroll reached each threshold (D-S8-05). */
  scroll: Array<{ threshold: number; sessions: number }>;
  /** The scroll-depth denominator: sessions with a menu-route event in the period. */
  scroll_sessions?: number;
  /** active_ms is menu-route active time (the same definition as active_menu_ms). */
  daily: Array<{ date: string; sessions: number; active_ms: number }>;
  include_fixture: boolean;
  generated_at: string;
  /** S6: the period (year view gives monthly `daily` rows keyed YYYY-MM). */
  period?: StatsPeriod;
}

export interface KpiDTO {
  from: string;
  to: string;
  qr_adoption: { value: number | null; numerator: number; denominator: number };
  guest_order_time: { median_s: number | null; p90_s: number | null; sample: number };
  average_order_value: { value_minor: number | null; rounds: number };
  average_table_value: { value_minor: number | null; visits: number };
  operational_errors: { rate: number | null; by_reason: Array<{ reason: string; count: number }>; submitted_rounds: number };
  payment_exceptions: { count: number; value_minor: number };
  /** Current bills whose settlement was refunded after checkout (not counted as payment exceptions; D-S8-04). */
  refunds_after_checkout?: { count: number; value_minor: number };
  staff_response: { accept_median_s: number | null; accept_p90_s: number | null; ack_median_s: number | null; ack_p90_s: number | null; accept_sample: number; ack_sample: number };
  totals: { submitted_minor: number; accepted_minor: number; finalized_minor: number; paid_minor: number };
  cancellations: Array<{ reason: string; count: number; value_minor: number }>;
  hourly: Array<{ hour: number; rounds: number }>;
  open_bills: number;
  service_requests: Array<{ type: ServiceType; count: number }>;
  include_fixture: boolean;
  /** S6: operational errors split by kind (a round can be both rejected and corrected). */
  operational_error_kinds?: Array<{ kind: 'rejected' | 'corrected'; reason: string; count: number }>;
  /** S6: distinct rounds counted as operational errors (numerator of the rate). */
  error_rounds?: number;
  /** S6: false when the caller lacks reports.financial (payment figures are then zeroed, not real zeros). */
  financial_visible?: boolean;
  generated_at?: string;
}

export interface ReportJobDTO {
  id: string;
  kind: 'annual_pdf' | 'annual_csv';
  year: number;
  status: JobStatus;
  label: ReportLabel;
  revision: number;
  reason: string | null;
  data_cutoff: string | null;
  requested_by: string | null;
  requested_at: string;
  finished_at: string | null;
  file_bytes: number | null;
  error: string | null;
  attempts: number;
  include_fixture: boolean;
  download_url: string | null;
  /** S7: the file includes bill/payment sections (download needs reports.financial). */
  financial?: boolean;
  /** S7: the export includes raw engagement events (download needs reports.export_raw). */
  raw_events?: boolean;
  /** S7: report_data_versions.version the file was built from (null until ready). */
  data_version?: number | null;
  /** S7: the ready report this one follows (revision chain). */
  supersedes_job_id?: string | null;
}

export interface ReportYearDTO {
  year: number;
  state: 'current' | 'completed';
  /** telemetry_since: business date (YYYY-MM-DD) of the first real engagement session in the year. */
  coverage: { first_date: string | null; last_date: string | null; order_rounds: number; visits: number; telemetry_since: string | null };
  jobs: ReportJobDTO[];
  needs_revision: boolean; // data changed after the latest ready report
  /** S7: demo/fixture order rounds in this year (excluded from coverage and real reports). */
  fixture_order_rounds?: number;
  /** S7: current report_data_versions.version for the year. */
  data_version?: number;
}

// ------------------------------------------------------------------ payments list (S5)
export interface PaymentExceptionDTO {
  /** unpaid_finalized: a finalized bill with no settlement; closed_with_exception: a manager closed despite blockers. */
  kind: 'unpaid_finalized' | 'closed_with_exception' | 'reversal' | 'refund_record';
  visit_id: string;
  visit_status: VisitStatus | null;
  table_label: string;
  at: string;
  amount_minor: Minor;
  reason: string | null;
  revision_no: number | null;
  payment_id: string | null;
}

export interface PaymentsListDTO {
  date: string;
  payments: PaymentDTO[];
  exceptions: PaymentExceptionDTO[];
  summary: {
    confirmed: { count: number; value_minor: Minor };
    exceptions: { count: number; value_minor: Minor };
  };
  include_fixture: boolean;
}

// ------------------------------------------------------------------ catalog import & ordering state (S1)
export type ImportRowAction = 'create' | 'update_draft' | 'skip_published' | 'skip_archived' | 'error';

export interface ImportRowDTO {
  /** Sheet row number (the header is row 1). */
  row: number;
  key: string;
  variant_key: string | null;
  category_key: string;
  name: Bilingual;
  action: ImportRowAction;
  /** Why the row is skipped, or a non-blocking note (e.g. formula-like text stored as plain text). */
  message: string | null;
}

export interface ImportErrorDTO {
  row: number;
  column: string | null;
  /** missing_column | empty_file | too_many_rows | bad_key | unknown_category | bad_pricing_type | bad_number | bad_value | too_long | duplicate_key | duplicate_variant | variant_without_parent | missing_variants | conflicting_values */
  code: string;
  message: string;
}

export interface ImportSummaryDTO {
  rows: number; items: number; variants: number;
  create: number; update_draft: number; skip_published: number; skip_archived: number;
  errors: number;
  /** false while any error remains: apply is refused until the file is fixed and previewed again. */
  can_apply: boolean;
  applied?: { created: number; updated: number; unchanged: number; skipped: number };
}

export interface ImportPreviewDTO {
  batch_id: string;
  rows: ImportRowDTO[];
  errors: ImportErrorDTO[];
  summary: ImportSummaryDTO;
}

/** GET/PATCH /api/staff/ordering */
export type StaffOrderingDTO = PublicConfigDTO['ordering'] & {
  intake_limit: number | null;
  backlog: number;
  oldest_unaccepted_at: string | null;
  /** The intake limit is reached, so new guest rounds are refused right now. */
  intake_full: boolean;
};
