// Client-side CSV for the operational report (the KPI endpoint returns JSON
// only). Same safety rules as the server's toCsv(): UTF-8 with a BOM, CRLF,
// every field quoted when needed, and text that a spreadsheet could read as a
// formula is prefixed with an apostrophe.
import type { KpiDTO } from '../../../../shared/dto.ts';
import { ApiError, type ClientErrorCode } from '../../lib/api.ts';

type Cell = string | number | boolean | null | undefined;

const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : typeof value === 'boolean' ? (value ? 'true' : 'false') : value;
  if (typeof value === 'string' && FORMULA.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Cell[][]): string {
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

const baht = (minor: number | null) => (minor === null ? null : (minor / 100).toFixed(2));

/**
 * One long table: section, metric, value, unit, sample, note. Money is in
 * baht with two decimals; durations in seconds; ratios as 0..1.
 */
export function kpiCsv(k: KpiDTO, opts: { generatedAt: string }): string {
  const rows: Cell[][] = [
    ['section', 'metric', 'key', 'value', 'unit', 'sample', 'note'],
    ['scope', 'range_from', '', k.from, 'business_date', '', 'Asia/Bangkok business days'],
    ['scope', 'range_to', '', k.to, 'business_date', '', 'inclusive'],
    ['scope', 'include_demo_data', '', k.include_fixture, '', '', ''],
    ['scope', 'generated_at', '', k.generated_at ?? opts.generatedAt, 'utc', '', ''],
    ['kpi', 'qr_adoption', '', k.qr_adoption.value, 'ratio', k.qr_adoption.denominator, `${k.qr_adoption.numerator} of ${k.qr_adoption.denominator} eligible visits had a customer-origin round`],
    ['kpi', 'guest_order_time_median', '', k.guest_order_time.median_s, 'seconds', k.guest_order_time.sample, 'join to first guest round'],
    ['kpi', 'guest_order_time_p90', '', k.guest_order_time.p90_s, 'seconds', k.guest_order_time.sample, ''],
    ['kpi', 'average_order_value', '', baht(k.average_order_value.value_minor), 'THB', k.average_order_value.rounds, 'accepted chargeable lines / accepted rounds; charges and adjustments excluded'],
    ['kpi', 'average_table_value', '', baht(k.average_table_value.value_minor), 'THB', k.average_table_value.visits, 'current bill revisions / finalised visits'],
    ['kpi', 'operational_error_rate', '', k.operational_errors.rate, 'ratio', k.operational_errors.submitted_rounds, `${k.error_rounds ?? ''} rounds rejected or corrected`],
    ['kpi', 'acceptance_median', '', k.staff_response.accept_median_s, 'seconds', k.staff_response.accept_sample, 'submitted to accepted'],
    ['kpi', 'acceptance_p90', '', k.staff_response.accept_p90_s, 'seconds', k.staff_response.accept_sample, ''],
    ['kpi', 'acknowledgement_median', '', k.staff_response.ack_median_s, 'seconds', k.staff_response.ack_sample, 'service request to acknowledged'],
    ['kpi', 'acknowledgement_p90', '', k.staff_response.ack_p90_s, 'seconds', k.staff_response.ack_sample, ''],
    ['kpi', 'open_bills_now', '', k.open_bills, 'visits', '', 'current, not limited to the range'],
  ];
  if (k.financial_visible !== false) {
    rows.push(['kpi', 'payment_exceptions', 'count', k.payment_exceptions.count, 'bills', '', 'recorded payments compared with bills, not bank records']);
    rows.push(['kpi', 'payment_exceptions', 'value', baht(k.payment_exceptions.value_minor), 'THB', '', '']);
  }
  rows.push(['totals', 'submitted', '', baht(k.totals.submitted_minor), 'THB', '', 'all submitted lines']);
  rows.push(['totals', 'accepted', '', baht(k.totals.accepted_minor), 'THB', '', 'chargeable lines (accepted, not rejected or cancelled)']);
  rows.push(['totals', 'finalised', '', baht(k.totals.finalized_minor), 'THB', '', 'current bill revisions']);
  if (k.financial_visible !== false) rows.push(['totals', 'paid', '', baht(k.totals.paid_minor), 'THB', '', 'confirmed settlements']);
  for (const e of k.operational_error_kinds ?? k.operational_errors.by_reason.map((r) => ({ kind: '', ...r }))) {
    rows.push(['operational_errors', e.kind || 'rejected_or_corrected', e.reason, e.count, 'rounds', '', '']);
  }
  for (const c of k.cancellations) rows.push(['cancellations', 'cancelled_lines', c.reason, c.count, 'lines', '', `value ${baht(c.value_minor)} THB`]);
  for (const h of k.hourly) rows.push(['hourly', 'order_rounds', `${String(h.hour).padStart(2, '0')}:00`, h.rounds, 'rounds', '', 'Asia/Bangkok clock hour']);
  for (const s of k.service_requests) rows.push(['service_requests', 'requests', s.type, s.count, 'requests', '', '']);
  return toCsv(rows);
}

/**
 * Download a protected file with the staff cookie. Errors come back as
 * ApiError (the server answers JSON), so the screen can explain them
 * instead of the browser showing a raw error page.
 */
export async function downloadFile(url: string, fallbackName: string): Promise<{ name: string; bytes: number }> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError('network_error', 0, 'Could not reach the restaurant server.');
  }
  if (!res.ok) {
    let body: { error?: { code?: ClientErrorCode; message?: string; details?: unknown } } | null = null;
    try { body = await res.json(); } catch { body = null; }
    throw new ApiError(body?.error?.code ?? (res.status >= 502 ? 'network_error' : 'internal'), res.status, body?.error?.message ?? res.statusText, body?.error?.details);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  saveBlob(blob, name);
  return { name, bytes: blob.size };
}

/** Save text as a file through a temporary object URL. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
