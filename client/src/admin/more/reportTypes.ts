// Operational-report types. These fields began as client-only expectations
// (D-AD-04); the server now sends them, so the shapes live in shared/dto.ts
// and this module only keeps the names the report screens use.
//
// `filters`, `filter_options` and `unfiltered` stay optional on KpiDTO, so the
// filter controls still render only when the response carries the choices.
import type {
  FeedbackItemDTO, FeedbackListDTO, KpiDTO, KpiFigureKey, KpiFilterOptionsDTO, KpiFiltersDTO,
} from '../../../../shared/dto.ts';

/** Filters the server applied to /api/staff/stats/kpis (echoed back, null = all). */
export type KpiFilters = KpiFiltersDTO;
/** Choices for the filters, from the same request (so a manager never needs team.manage to list staff). */
export type KpiFilterOptions = KpiFilterOptionsDTO;
/** A figure the active filters may or may not narrow. */
export type KpiFigure = KpiFigureKey;
/** What the operational report reads from GET /api/staff/stats/kpis. */
export type KpiView = KpiDTO;

export type { FeedbackItemDTO, FeedbackListDTO };
