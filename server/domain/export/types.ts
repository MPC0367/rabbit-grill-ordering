// The annual report snapshot: every figure the PDF prints and the ZIP's
// summary files carry, computed once from one consistent database snapshot.
// Money fields are integer satang and are only filled when the job is
// financial; otherwise they stay 0 and the renderers never print them.
import type { Bilingual } from '../../../shared/dto.ts';
import type { ItemStatus, LineStatus, OrderStatus, PricingType, ReportLabel, ReviewStatus, ServiceType, Station } from '../../../shared/status.ts';

export interface JobInfo {
  id: string;
  kind: 'annual_pdf' | 'annual_csv';
  year: number;
  label: ReportLabel;
  revision: number;
  reason: string | null;
  requested_at: string;
  requested_by: string;
  role_scope: string;
  financial: boolean;
  raw_events: boolean;
  include_fixture: boolean;
  supersedes_job_id: string | null;
}

export interface Stat {
  median: number | null;
  p90: number | null;
  sample: number;
}

/** Day state in the daily table. `before_records` = before the first operating day (first seated visit). */
export type DayState = 'complete' | 'partial' | 'future' | 'before_records';

export interface Counters {
  submitted: number;   // order rounds created (incl. later rejected/cancelled)
  accepted: number;    // rounds with at least one accepted, non-cancelled line
  rejected: number;    // rounds whose every line was rejected
  cancelled: number;   // rounds with no active line that are not all-rejected
  visits: number;      // distinct dining visits with a submitted round
  devices: number;     // distinct guest browser sessions that submitted (not people)
  seated: number;      // visits seated (covers attribution, D-11)
  covered: number;     // seated visits with covers entered
  diners: number;      // sum of staff-entered covers; missing covers are not estimated
  items: number;       // net accepted quantity (servings)
  submitted_items: number;
  grams: number;       // measured grams on accepted measured-weight lines
  closed: number;      // visits checked out (closed_at, D-11)
  accepted_minor: number;
}

export interface DailyRow extends Counters {
  date: string;
  weekday: number; // 0 = Monday
  state: DayState;
}

export interface PeriodRow extends Counters {
  key: string;
  label: string;
  from: string;   // first in-year date of the period
  to: string;     // last in-year date of the period
  /** before_records: the whole period precedes the platform's first record. */
  state: 'complete' | 'partial' | 'future' | 'before_records';
  /** Week rows: the seven-day window crosses a year boundary and is clipped to this year. */
  clipped: boolean;
  window_from?: string;
  window_to?: string;
}

export interface Overview extends Counters {
  guest_rounds: number;
  staff_rounds: number;
  recovered_rounds: number;
  portion_rounds: number;
  rejected_items: number;
  cancelled_items: number;
  measured_servings: number;
  lines: number;
  lines_with_note: number;
  lines_with_allergy_flag: number;
  active_days: number;
  elapsed_days: number;
  busiest_day: { date: string; submitted: number } | null;
  busiest_month: { key: string; submitted: number } | null;
  service_requests: number;
  portion_requests: number;
  records_begin: string | null;
  open_visits_at_cutoff: number;
}

export interface RankRow {
  rank: number;
  item_id: string;
  key: string;
  name: Bilingual;
  former_names: string[];
  category: Bilingual;
  category_id: string;
  category_sort: number;
  group: 'food' | 'drinks' | null;
  status: ItemStatus;
  review_status: ReviewStatus;
  archived: boolean;
  measured: boolean;
  pricing_type: PricingType;
  station: Station;
  net_qty: number;
  submitted_qty: number;
  rejected_qty: number;
  cancelled_qty: number;
  orders: number;
  visits: number;
  grams: number;
  accepted_minor: number;
  share: number | null;
  category_share: number | null;
  available_days: number | null;
  period_days: number;
  per_available_day: number | null;
  availability: 'full' | 'partial' | 'insufficient' | 'unknown' | 'never';
  quality: 'never_ordered_despite_availability' | 'insufficient_availability' | 'availability_unknown' | null;
  sold_out_now: boolean;
  variants: Array<{ name: Bilingual; net_qty: number; submitted_qty: number }>;
  first_ordered: string | null;
  last_ordered: string | null;
}

export interface RankingSnap {
  rows: RankRow[];
  total_net: number;
  zero_order_items: number;
  /** Items without lines that were left out, by reason (D-S6-07 eligibility). */
  excluded: { unpublished: number; archived: number; not_orderable: number; out_of_season: number; not_available: number };
  tie_policy: string;
}

export interface EngagementItem {
  item_id: string;
  name: Bilingual;
  impressions: number;
  impression_sessions: number;
  detail_opens: number;
  adds: number;
  add_sessions: number;
  add_rate: number | null;
  attributed_qty: number;
}

export interface EngagementSnap {
  enabled_now: boolean;
  instrumentation_started_at: string | null;
  first_event_at: string | null;
  last_event_at: string | null;
  /** Measured sessions: distinct sessions with a stored event in the year (D-S6-09). */
  sessions: number;
  dining_sessions: number;
  public_sessions: number;
  opted_out_sessions: number;
  raw_events: number;
  raw_first_date: string | null;
  raw_retention_days: number;
  agg_fallback_days: number;
  ordering_visits: number;
  measured_visits: number;
  menu_active_ms: Stat;
  detail_active_ms: Stat;
  total_active_ms: number;
  categories: Array<{ category_id: string; name: Bilingual; sessions: number; share: number | null }>;
  items: EngagementItem[];
  funnel: {
    sessions: number; impression_sessions: number; detail_sessions: number; add_sessions: number;
    quick_add_sessions: number; submit_sessions: number;
    attributed_orders: number; unattributed_orders: number; staff_orders: number;
  };
  scroll: Array<{ threshold: number; sessions: number }>;
  monthly: Array<{ key: string; sessions: number; dining_sessions: number; active_ms: number; events: number }>;
  daily: Array<{ date: string; sessions: number; dining_sessions: number; public_sessions: number; opted_out: number; active_ms: number; menu_active_ms: number; events: number; impressions: number; detail_opens: number; adds: number }>;
  event_types: Array<{ type: string; count: number }>;
}

export interface TimingSnap {
  accept_s: Stat;
  accept_to_prepare_s: Stat;
  stations: Array<{ station: Station; lines: number; prepare_s: Stat; serve_s: Stat; total_s: Stat }>;
  visit_minutes: Stat;
  visits_closed: number;
  service: Array<{ type: ServiceType; count: number; completed: number; cancelled: number; open: number; ack_s: Stat; complete_s: Stat }>;
  hourly: number[];
  weekday: number[];
  excluded_recovered_rounds: number;
  excluded_prepared_before_entry: number;
  portions: { requests: number; quoted: number; confirmed: number; declined: number; cancelled: number; expired: number; open: number; grams_confirmed: number; confirmed_in_person: number };
}

export interface ReasonRow {
  kind: 'rejected' | 'cancelled';
  reason: string;
  lines: number;
  qty: number;
  value_minor: number;
}

export interface ExceptionSnap {
  reasons: ReasonRow[];
  cancel_stages: Array<{ from: string; lines: number; qty: number }>;
  late_changes: number;
  corrections: number;
  recoveries: number;
}

export interface PaymentException {
  /** finalized_unpaid and amount_mismatch are payment exceptions (D-S6-10); the rest are listed for context. */
  kind: 'finalized_unpaid' | 'amount_mismatch' | 'reversed' | 'close_exception' | 'refund_record';
  at: string;
  visit_id: string;
  table_label: string;
  amount_minor: number;
  detail: string;
}

export interface PaymentsSnap {
  submitted_minor: number;
  accepted_minor: number;
  finalized_minor: number;
  finalized_bills: number;
  settled_minor: number;
  settlements: number;
  reversal_minor: number;
  reversals: number;
  refund_minor: number;
  net_paid_minor: number;
  adjustments: { count: number; minor: number; voided: number };
  methods: Array<{ method: string; label: string; count: number; amount_minor: number; reversed_count: number; reversed_minor: number }>;
  monthly: Array<{ key: string; finalized_minor: number; paid_minor: number }>;
  exceptions: PaymentException[];
  exception_count: number;
  exception_minor: number;
  open_bills_at_cutoff: number;
}

export interface OrderRow {
  id: string;
  reference: string;
  submitted_at: string;
  /** Business date the round is attributed to (D-11). */
  business_date: string;
  table_label: string;
  source: string;
  round_no: number;
  manual_reference: string | null;
  status: OrderStatus;
  items: string;
  qty_total: number;
  qty_net: number;
  subtotal_minor: number;
  accepted_minor: number;
  flags: string[];
  staff_name: string | null;
}

export interface CorrectionRow {
  at: string;
  kind: string;
  reference: string;
  table_label: string;
  item: string;
  from: string;
  to: string;
  reason: string;
  actor: string;
  late: boolean;
}

export interface PortionRow {
  id: string;
  business_date: string;
  created_at: string;
  table_label: string;
  item: string;
  status: string;
  preferred_grams: number | null;
  quotes: number;
  grams: number | null;
  amount_minor: number | null;
  confirmed_via: string | null;
  order_reference: string | null;
  resolution: string | null;
}

export interface BillRow {
  id: string;
  business_date: string;
  finalized_at: string;
  visit_id: string;
  table_label: string;
  revision_no: number;
  status: string;
  subtotal_minor: number;
  adjustments_minor: number;
  charges_minor: number;
  total_minor: number;
  paid_minor: number;
  methods: string;
  note: string;
}

export interface VersionRow {
  id: string;
  revision: number;
  label: ReportLabel;
  status: string;
  requested_at: string;
  finished_at: string | null;
  requested_by: string;
  data_cutoff: string | null;
  data_version: number | null;
  reason: string | null;
  sha256: string | null;
  summary: SnapshotSummary | null;
  current: boolean;
}

/** Headline totals stored on the job (report_jobs.summary_json). */
export interface SnapshotSummary {
  submitted_rounds: number;
  accepted_rounds: number;
  ordering_visits: number;
  diners: number;
  items_net: number;
  accepted_minor?: number;
  paid_minor?: number;
}

export interface ReportSnapshot {
  job: JobInfo;
  restaurant: { name_th: string; name_en: string; short_en: string };
  default_locale: 'th' | 'en';
  operating_mode: 'demo' | 'live';
  range: { from: string; to: string; start_utc: string; end_utc: string; cutoff_hour: number; timezone: string };
  generated_at: string;
  data_cutoff: string;
  data_version: number;
  today: string;
  year_state: 'completed' | 'current' | 'future';
  isolated_snapshot: boolean;
  overview: Overview;
  daily: DailyRow[];
  monthly: PeriodRow[];
  weekly: PeriodRow[];
  ranking: RankingSnap;
  engagement: EngagementSnap;
  timings: TimingSnap;
  exceptions: ExceptionSnap;
  payments: PaymentsSnap | null;
  orders: OrderRow[];
  corrections: CorrectionRow[];
  portions: PortionRow[];
  bills: BillRow[];
  versions: VersionRow[];
  notes: string[];
  settings: {
    charges_confirmed: boolean;
    analytics_enabled: boolean;
    raw_events_days: number;
    notes_days: number;
    audit_days: number;
  };
  line_status_totals: Record<LineStatus, number>;
}
