// Operational KPIs (brief 26). Each figure states its own denominator and
// sample; totals are labelled submitted / accepted / finalized / paid and are
// never called "revenue". Payment figures are only filled in for callers with
// reports.financial. Definitions: docs/DECISIONS.md D-S6-10.
import type { KpiDTO } from '../../shared/dto.ts';
import { divRoundHalfUp } from '../../shared/money.ts';
import { SERVICE_TYPES, type ServiceType } from '../../shared/status.ts';
import { bangkokParts, nowIso } from '../../shared/time.ts';
import { many, one } from '../db/index.ts';
import { getSettings } from '../lib/settings.ts';
import {
  CHARGEABLE_SQL, acceptanceSeconds, businessHours, distribution, fixtureSql, resolvePeriod, secondsBetween,
  type StatsParams,
} from './aggregates.ts';

export interface KpiParams extends StatsParams {
  /** Caller holds reports.financial (payment exceptions and paid totals). */
  financial?: boolean;
}

const ratio = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 10_000) / 10_000 : null);
const reasonSql = (col: string) => `COALESCE(NULLIF(TRIM(${col}), ''), 'unspecified')`;

export function kpis(q: KpiParams): KpiDTO {
  const period = q.period ?? (q.from && q.to ? 'custom' : 'week');
  const rp = resolvePeriod({ ...q, period });
  const { from, to, clock } = rp;
  const include = rp.include_fixture;
  const financial = q.financial === true;
  const range = { from, to };
  const fo = fixtureSql('o', include);

  // ---- QR adoption: visits seated in range that ordered through a channel
  // where the QR was usable (any round other than manual recovery) and had at
  // least one customer-origin round.
  const adoption = one<{ eligible: number; adopted: number }>(
    `SELECT COALESCE(SUM(eligible), 0) AS eligible, COALESCE(SUM(eligible AND adopted), 0) AS adopted FROM (
       SELECT v.id,
              MAX(o.source IN ('guest', 'staff', 'portion_quote')) AS eligible,
              MAX(o.source = 'guest' OR (o.source = 'portion_quote' AND o.guest_session_id IS NOT NULL)) AS adopted
         FROM visits v INDEXED BY visits_seated_date JOIN orders o ON o.visit_id = v.id
        WHERE v.seated_business_date BETWEEN :from AND :to AND ${fixtureSql('v', include)}
        GROUP BY v.id)`, range)!;

  // ---- Guest order time: per visit, join of the guest session that placed the
  // visit's first guest round -> that round.
  const orderTimes = many<{ s: string; j: string }>(
    `SELECT o.submitted_at AS s, gs.created_at AS j
       FROM orders o JOIN guest_sessions gs ON gs.id = o.guest_session_id
      WHERE o.source = 'guest' AND o.business_date BETWEEN :from AND :to AND ${fo}
        AND NOT EXISTS (SELECT 1 FROM orders p WHERE p.visit_id = o.visit_id AND p.source = 'guest'
                         AND (p.submitted_at < o.submitted_at OR (p.submitted_at = o.submitted_at AND p.id < o.id)))`,
    range,
  ).map((r) => secondsBetween(r.j, r.s)).filter((s) => s >= 0);
  const orderTime = distribution(orderTimes);

  // ---- Round values (current line statuses; charges and bill adjustments excluded).
  // INDEXED BY keeps the per-round GROUP BY on the date range (see stats.ts).
  const values = one<{ submitted: number; accepted: number; rounds: number }>(
    `SELECT COALESCE(SUM(sub), 0) AS submitted, COALESCE(SUM(acc), 0) AS accepted, COALESCE(SUM(n > 0), 0) AS rounds FROM (
       SELECT o.id, SUM(l.line_total_minor) AS sub,
              SUM(CASE WHEN l.status IN ${CHARGEABLE_SQL} THEN l.line_total_minor ELSE 0 END) AS acc,
              SUM(CASE WHEN l.status IN ${CHARGEABLE_SQL} THEN 1 ELSE 0 END) AS n
         FROM orders o INDEXED BY orders_business_date JOIN order_lines l ON l.order_id = o.id
        WHERE o.business_date BETWEEN :from AND :to AND ${fo}
        GROUP BY o.id)`, range)!;

  // ---- Finalized bills: the current (non-superseded) revision, by its finalize date.
  const revisions = many<{ id: string; total_minor: number; business_date: string; visit_status: string; settled: number | null }>(
    `SELECT r.id, r.total_minor, r.business_date, v.status AS visit_status,
            (SELECT p.amount_minor FROM payments p
              WHERE p.bill_revision_id = r.id AND p.kind = 'settlement' AND p.status = 'confirmed') AS settled
       FROM bills b
       JOIN bill_revisions r ON r.id = b.current_revision_id
       JOIN visits v ON v.id = b.visit_id
      WHERE r.status IN ('payable', 'settled') AND r.business_date BETWEEN :from AND :to AND ${fixtureSql('r', include)}`,
    range,
  );
  const finalizedTotal = revisions.reduce((s, r) => s + r.total_minor, 0);

  // ---- Payment exceptions: finalized bills with no confirmed settlement once
  // the visit closed or the day ended, or a settlement that differs.
  const exceptions = { count: 0, value_minor: 0 };
  let paid = 0;
  if (financial) {
    for (const r of revisions) {
      if (r.settled === null) {
        // A zero-total revision owes nothing: checkout records it as settled without a
        // payment row (checkout.ts), and the payments screen does not list it either.
        if (r.total_minor > 0 && (r.visit_status === 'closed' || r.business_date < clock.today)) {
          exceptions.count++;
          exceptions.value_minor += r.total_minor;
        }
      } else if (r.settled !== r.total_minor) {
        exceptions.count++;
        exceptions.value_minor += Math.abs(r.total_minor - r.settled);
      }
    }
    paid = one<{ v: number }>(
      `SELECT COALESCE(SUM(p.amount_minor), 0) AS v FROM payments p
        WHERE p.kind = 'settlement' AND p.status = 'confirmed' AND p.business_date BETWEEN :from AND :to
          AND ${fixtureSql('p', include)}`, range)!.v;
  }

  // ---- Operational errors: rounds with a rejected line or a correction.
  const submittedRounds = one<{ n: number }>(`SELECT COUNT(*) AS n FROM orders o WHERE o.business_date BETWEEN :from AND :to AND ${fo}`, range)!.n;
  const errorRows = [
    ...many<{ order_id: string; reason: string }>(
      `SELECT l.order_id, ${reasonSql('l.status_reason')} AS reason
         FROM order_lines l JOIN orders o ON o.id = l.order_id
        WHERE l.status = 'rejected' AND o.business_date BETWEEN :from AND :to AND ${fo}`, range)
      .map((r) => ({ ...r, kind: 'rejected' as const })),
    ...many<{ order_id: string; reason: string }>(
      `SELECT e.order_id, ${reasonSql('e.reason')} AS reason
         FROM line_events e JOIN orders o ON o.id = e.order_id
        WHERE e.kind = 'correction' AND o.business_date BETWEEN :from AND :to AND ${fo}`, range)
      .map((r) => ({ ...r, kind: 'corrected' as const })),
  ];
  const errorRounds = new Set(errorRows.map((r) => r.order_id));
  const byReason = new Map<string, Set<string>>();
  const byKind = new Map<string, { kind: 'rejected' | 'corrected'; reason: string; rounds: Set<string> }>();
  for (const r of errorRows) {
    (byReason.get(r.reason) ?? byReason.set(r.reason, new Set()).get(r.reason)!).add(r.order_id);
    const k = `${r.kind}|${r.reason}`;
    (byKind.get(k) ?? byKind.set(k, { kind: r.kind, reason: r.reason, rounds: new Set() }).get(k)!).rounds.add(r.order_id);
  }
  const sortCount = <T extends { count: number; reason: string }>(a: T, b: T) => b.count - a.count || a.reason.localeCompare(b.reason);

  // ---- Staff response: rounds to first acceptance; service requests to the first
  // staff response. Staff completion stamps acknowledged_at (D-21); a bill request
  // completed by checkout has none and is not a response, so it is left out.
  const accept = distribution(acceptanceSeconds(from, to, include));
  const ack = distribution(many<{ c: string; r: string }>(
    `SELECT s.created_at AS c,
            COALESCE(s.acknowledged_at, CASE WHEN s.close_reason IS NULL THEN s.completed_at END) AS r
       FROM service_requests s
      WHERE s.business_date BETWEEN :from AND :to AND ${fixtureSql('s', include)}
        AND COALESCE(s.acknowledged_at, CASE WHEN s.close_reason IS NULL THEN s.completed_at END) IS NOT NULL`, range)
    .map((x) => secondsBetween(x.c, x.r)).filter((s) => s >= 0));

  // ---- Cancellations (lines) by reason.
  const cancellations = many<{ reason: string; count: number; value_minor: number }>(
    `SELECT ${reasonSql('l.status_reason')} AS reason, COUNT(*) AS count, COALESCE(SUM(l.line_total_minor), 0) AS value_minor
       FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE l.status = 'cancelled' AND o.business_date BETWEEN :from AND :to AND ${fo}
      GROUP BY reason`, range)
    .map((r) => ({ reason: r.reason, count: r.count, value_minor: r.value_minor }))
    .sort(sortCount);

  // ---- Rounds by Bangkok hour (recovered paper orders use their original time).
  const hours = new Map(businessHours(clock.cutoff).map((h) => [h, 0]));
  for (const r of many<{ at: string }>(
    `SELECT COALESCE(o.manual_original_time, o.submitted_at) AS at FROM orders o
      WHERE o.business_date BETWEEN :from AND :to AND ${fo}`, range)) {
    const h = bangkokParts(r.at).hour;
    hours.set(h, (hours.get(h) ?? 0) + 1);
  }

  // ---- Current open bills: active visits with chargeable lines and no settled bill.
  const openBills = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM visits v
      WHERE v.status <> 'closed' AND ${fixtureSql('v', include)}
        AND EXISTS (SELECT 1 FROM order_lines l WHERE l.visit_id = v.id AND l.status IN ${CHARGEABLE_SQL})
        AND NOT EXISTS (SELECT 1 FROM bills b WHERE b.visit_id = v.id AND b.status = 'settled')`)!.n;

  // ---- Service requests by type (enabled types always listed).
  const requestCounts = new Map(many<{ type: ServiceType; n: number }>(
    `SELECT s.type, COUNT(*) AS n FROM service_requests s
      WHERE s.business_date BETWEEN :from AND :to AND ${fixtureSql('s', include)} GROUP BY s.type`, range).map((r) => [r.type, r.n]));
  const enabled = getSettings().services;
  const serviceRequests = SERVICE_TYPES
    .filter((t) => enabled[t] || requestCounts.has(t))
    .map((type) => ({ type, count: requestCounts.get(type) ?? 0 }));

  return {
    from,
    to,
    qr_adoption: { value: ratio(adoption.adopted, adoption.eligible), numerator: adoption.adopted, denominator: adoption.eligible },
    guest_order_time: { median_s: orderTime.median, p90_s: orderTime.p90, sample: orderTime.sample },
    average_order_value: { value_minor: values.rounds > 0 ? divRoundHalfUp(values.accepted, values.rounds) : null, rounds: values.rounds },
    average_table_value: { value_minor: revisions.length > 0 ? divRoundHalfUp(finalizedTotal, revisions.length) : null, visits: revisions.length },
    operational_errors: {
      rate: ratio(errorRounds.size, submittedRounds),
      by_reason: [...byReason].map(([reason, set]) => ({ reason, count: set.size })).sort(sortCount),
      submitted_rounds: submittedRounds,
    },
    payment_exceptions: exceptions,
    staff_response: {
      accept_median_s: accept.median, accept_p90_s: accept.p90,
      ack_median_s: ack.median, ack_p90_s: ack.p90,
      accept_sample: accept.sample, ack_sample: ack.sample,
    },
    totals: { submitted_minor: values.submitted, accepted_minor: values.accepted, finalized_minor: finalizedTotal, paid_minor: financial ? paid : 0 },
    cancellations,
    hourly: [...hours].map(([hour, rounds]) => ({ hour, rounds })),
    open_bills: openBills,
    service_requests: serviceRequests,
    include_fixture: include,
    operational_error_kinds: [...byKind.values()]
      .map((k) => ({ kind: k.kind, reason: k.reason, count: k.rounds.size }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || sortCount(a, b)),
    error_rounds: errorRounds.size,
    financial_visible: financial,
    generated_at: nowIso(),
  };
}
