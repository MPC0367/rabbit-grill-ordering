// Report data versions: a per-year counter bumped whenever something changes
// that an already-generated annual report may have counted. The reports
// screen compares a report's data_version with the current one to offer an
// explicit revised report instead of silently replacing the old file.
import { run } from '../db/index.ts';
import { nowIso, yearOf } from '../../shared/time.ts';

export function touchReportData(businessDate: string): void {
  run(
    `INSERT INTO report_data_versions (year, version, changed_at) VALUES (:year, 1, :at)
     ON CONFLICT(year) DO UPDATE SET version = version + 1, changed_at = excluded.changed_at`,
    { year: yearOf(businessDate), at: nowIso() },
  );
}
