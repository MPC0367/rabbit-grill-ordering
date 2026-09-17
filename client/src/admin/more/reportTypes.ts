// Operational-report fields the client reads only when the server sends them.
// shared/dto.ts KpiDTO is the stable contract; these additions are optional so
// an older server simply hides the matching UI (see docs/API.md, KPI filters,
// refunds after checkout, guest feedback).
import type { Bilingual, KpiDTO } from '../../../../shared/dto.ts';

/** Filters the server applied to /api/staff/stats/kpis (echoed back, null = all). */
export interface KpiFilters {
  table_id: string | null;
  category_id: string | null;
  staff_id: string | null;
}

/** Choices for the filters, from the same request (so a manager never needs team.manage to list staff). */
export interface KpiFilterOptions {
  tables: Array<{ id: string; label: string }>;
  categories: Array<{ id: string; name: Bilingual }>;
  staff: Array<{ id: string; name: string }>;
}

export type KpiFigure =
  | 'qr_adoption' | 'guest_order_time' | 'average_order_value' | 'average_table_value' | 'operational_errors'
  | 'accept' | 'ack' | 'open_bills' | 'payment_exceptions' | 'refunds' | 'totals' | 'cancellations' | 'hourly' | 'service_requests';

export type KpiView = KpiDTO & {
  filters?: KpiFilters;
  filter_options?: KpiFilterOptions;
  /** Figures the active filters do not narrow (they show all tables / categories / staff). */
  unfiltered?: KpiFigure[];
};

export interface FeedbackItemDTO {
  id: string;
  submitted_at: string;
  business_date: string;
  /** Table label as it was at the visit. */
  table_label: string | null;
  rating: number | null;
  comment: string | null;
}

/** GET /api/staff/feedback?from&to&include_fixture (reports.view). Never sent on the live stream. */
export interface FeedbackListDTO {
  from: string;
  to: string;
  include_fixture: boolean;
  /** Feedback entries in range. */
  count: number;
  /** Entries with a rating, and their mean (null when none). */
  rated: number;
  average_rating: number | null;
  /** Count per score 1..5. */
  distribution?: Array<{ rating: number; count: number }>;
  with_comment: number;
  /** Newest first; may be capped (truncated = true). */
  items: FeedbackItemDTO[];
  truncated?: boolean;
  generated_at: string;
}
