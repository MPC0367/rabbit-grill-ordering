// Engagement telemetry (brief 39): ingestion of guest UI events and the
// Engagement page figures.
//
// Ingestion is best-effort and never blocks ordering: a bad event is counted
// as rejected rather than failing the batch, duplicates are ignored by
// event_id, the server receive time is the reporting timestamp, and nothing
// that could identify a person (notes, PINs, tokens, free text) is stored.
// Reporting describes observed active time and exposure; it never labels long
// dwell as "interest" or an unsubmitted cart as "abandonment".
// Definitions: docs/DECISIONS.md D-S6-08 and D-S6-09.
import { z } from 'zod';
import type { EngagementDTO } from '../../shared/dto.ts';
import { AnalyticsBatchBody, AnalyticsEvent } from '../../shared/schemas.ts';
import { addDays, businessDate, nowIso, splitByBusinessDay } from '../../shared/time.ts';
import { many, one, run, tx } from '../db/index.ts';
import type { GuestContext } from '../lib/auth.ts';
import { AppError } from '../lib/errors.ts';
import { hit, LIMITS } from '../lib/ratelimit.ts';
import { fixtureFlag, getSettings } from '../lib/settings.ts';
import { bi } from './pricing.ts';
import { clockOf, datesBetween, distribution, fixtureSql, resolvePeriod, type StatsParams } from './aggregates.ts';

// ================================================================== ingestion
/** Longest active interval one event may carry (the schema maximum). */
export const MAX_ACTIVE_MS = 120_000;
/** Longer than this cannot be a single foreground interval; such events are dropped, not capped. */
const IMPOSSIBLE_ACTIVE_MS = 24 * 3_600_000;
/** Allowance for clock jitter between elapsed_ms and active_ms. */
const ELAPSED_SLACK_MS = 5_000;
const PER_IP_LIMIT = { limit: 600, windowMs: 60_000 };
/** How long after checkout a dining session may still deliver its final batch. */
export const CLOSED_VISIT_GRACE_MS = 15 * 60_000;

function recentlyClosed(visitId: string | null, nowMs: number): boolean {
  if (!visitId) return false;
  const v = one<{ status: string; closed_at: string | null }>('SELECT status, closed_at FROM visits WHERE id = ?', [visitId]);
  if (!v || v.status !== 'closed' || !v.closed_at) return false;
  const age = nowMs - Date.parse(v.closed_at);
  return age >= 0 && age <= CLOSED_VISIT_GRACE_MS;
}

const Envelope = AnalyticsBatchBody.extend({ events: z.array(z.unknown()).max(100) });

const ITEM_EVENTS = new Set(['item_impression', 'item_detail_open', 'item_detail_active_time', 'cart_add', 'cart_remove']);
const DURATION_EVENTS = new Set(['active_time_chunk', 'item_detail_active_time']);
/** Opaque references only: never free text that could carry a note or a secret. */
const SAFE_REF = /^[A-Za-z0-9_.:-]{1,64}$/;

export interface IngestContext {
  /** Valid guest access from the `rg_guest` cookie, when present. */
  guest: GuestContext | null;
  /** Why the cookie did not resolve (visit_closed rejects dining telemetry). */
  guestError?: 'visit_access_required' | 'visit_access_revoked' | 'visit_closed' | null;
  /** Caller address for the secondary rate limit. */
  ip?: string;
  /** Clock override for tests. Routes never pass it. */
  now?: string;
}

export interface IngestResult { accepted: number; duplicates: number; rejected: number }

interface SessionRow {
  id: string; kind: 'public' | 'dining'; visit_id: string | null; guest_session_id: string | null;
  opted_out: number; is_fixture: number;
}

type CleanEvent = AnalyticsEvent;

/** Validate and normalise one event; null = rejected. */
function cleanEvent(raw: unknown): CleanEvent | null {
  let input = raw;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const r = input as Record<string, unknown>;
    // A delayed heartbeat may report a little more than the cap: count the cap.
    if (typeof r.active_ms === 'number' && r.active_ms > MAX_ACTIVE_MS && r.active_ms <= IMPOSSIBLE_ACTIVE_MS) {
      input = { ...r, active_ms: MAX_ACTIVE_MS };
    }
  }
  const parsed = AnalyticsEvent.safeParse(input);
  if (!parsed.success) return null;
  const e = { ...parsed.data };
  if (ITEM_EVENTS.has(e.type) && !e.item_id) return null;
  if (e.type === 'category_view' && !e.category_id) return null;
  if (e.type === 'scroll_depth' && (e.depth === null || e.depth === undefined)) return null;
  if (DURATION_EVENTS.has(e.type)) {
    if (!e.active_ms || e.active_ms <= 0) return null;
    // Nobody can be active for longer than the browsing session has existed.
    if (e.active_ms > e.elapsed_ms + ELAPSED_SLACK_MS) return null;
  } else {
    e.active_ms = null;
  }
  if (e.type === 'cart_add') {
    const d = e.quantity_delta ?? 1;
    if (d < 1) return null;
    e.quantity_delta = d;
  } else if (e.type === 'cart_remove') {
    const d = e.quantity_delta ?? -1;
    if (d === 0) return null;
    e.quantity_delta = -Math.abs(d);
  } else {
    e.quantity_delta = null;
  }
  if (e.type !== 'scroll_depth') e.depth = null;
  for (const k of ['interaction_ref', 'layout_version', 'menu_version'] as const) {
    const v = e[k];
    if (v !== null && v !== undefined && !SAFE_REF.test(v)) e[k] = null;
  }
  return e;
}

function existingIds(table: 'menu_items' | 'menu_categories', ids: Set<string>): Set<string> {
  if (!ids.size) return new Set();
  return new Set(many<{ id: string }>(`SELECT id FROM ${table} WHERE id IN (SELECT value FROM json_each(:ids))`, { ids: [...ids] }).map((r) => r.id));
}

/**
 * Store one telemetry batch (POST /api/analytics/batch).
 * Throws only for an invalid envelope or the rate limit; individual events are
 * counted as accepted / duplicates / rejected.
 */
export function ingestAnalytics(batch: unknown, ctx: IngestContext): IngestResult {
  const envelope = Envelope.safeParse(batch);
  if (!envelope.success) {
    throw new AppError('validation_failed', 'Invalid analytics batch', {
      issues: envelope.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const b = envelope.data;
  hit(`analytics:session:${b.session_id}`, LIMITS.analytics);
  if (ctx.ip) hit(`analytics:ip:${ctx.ip}`, PER_IP_LIMIT);

  const total = b.events.length;
  const rejectAll: IngestResult = { accepted: 0, duplicates: 0, rejected: total };
  const settings = getSettings();
  if (!settings.analytics.enabled) return rejectAll;

  const clock = clockOf(ctx.now);
  const now = clock.iso;
  const events = b.events.map(cleanEvent);
  const items = existingIds('menu_items', new Set(events.flatMap((e) => (e?.item_id ? [e.item_id] : []))));
  const categories = existingIds('menu_categories', new Set(events.flatMap((e) => (e?.category_id ? [e.category_id] : []))));

  return tx(() => {
    const guest = ctx.guest;
    // Dining telemetry needs a visit that is still active, re-read here.
    if (guest) {
      const status = one<{ status: string }>('SELECT status FROM visits WHERE id = ?', [guest.visitId])?.status;
      if (status !== 'open' && status !== 'billing') return rejectAll;
    }
    let session = one<SessionRow>('SELECT id, kind, visit_id, guest_session_id, opted_out, is_fixture FROM analytics_sessions WHERE id = ?', [b.session_id]);

    if (session) {
      if (session.kind === 'dining') {
        // Accepted only from a device that still holds access to the same
        // visit: a session id never links two visits. The one exception is the
        // tracker's final flush (last chunk + session_end), which the client
        // sends only after it learns the visit closed - by then its guest cookie
        // no longer resolves (or was already cleared by a 410). The existing,
        // unguessable session id is the proof; nothing is re-linked.
        if (guest) {
          if (guest.visitId !== session.visit_id) return rejectAll;
        } else if (!recentlyClosed(session.visit_id, clock.ms)) {
          return rejectAll;
        }
      } else if (guest) {
        // A public browser joined a table: from now on it is a dining session.
        run(
          `UPDATE analytics_sessions SET kind = 'dining', visit_id = :visit, guest_session_id = :guest,
                  first_join_at = COALESCE(first_join_at, :now), is_fixture = :fixture WHERE id = :id`,
          { id: session.id, visit: guest.visitId, guest: guest.guestId, now, fixture: guest.isFixture ? 1 : 0 },
        );
        session = { ...session, kind: 'dining', visit_id: guest.visitId, guest_session_id: guest.guestId, is_fixture: guest.isFixture ? 1 : 0 };
      }
    } else {
      if (!guest && ctx.guestError === 'visit_closed') return rejectAll;
      session = {
        id: b.session_id,
        kind: guest ? 'dining' : 'public',
        visit_id: guest?.visitId ?? null,
        guest_session_id: guest?.guestId ?? null,
        opted_out: b.opted_out ? 1 : 0,
        is_fixture: guest ? (guest.isFixture ? 1 : 0) : fixtureFlag(),
      };
      run(
        `INSERT INTO analytics_sessions (id, kind, visit_id, guest_session_id, locale, opted_out, started_at, first_join_at,
                                         last_event_at, business_date, is_fixture)
         VALUES (:id, :kind, :visit_id, :guest_session_id, :locale, :opted_out, :now, :joined, :now, :date, :is_fixture)`,
        { ...session, locale: b.locale, now, joined: guest ? now : null, date: clock.today },
      );
    }

    // The latest preference from this browser wins; opted-out batches store nothing.
    if (session.opted_out !== (b.opted_out ? 1 : 0)) {
      run('UPDATE analytics_sessions SET opted_out = ? WHERE id = ?', [b.opted_out ? 1 : 0, session.id]);
    }
    if (b.opted_out) return rejectAll;

    const result: IngestResult = { accepted: 0, duplicates: 0, rejected: 0 };
    const base = {
      session_id: session.id,
      visit_id: session.visit_id,
      received_at: now,
      is_fixture: session.is_fixture,
    };
    const insertEvent = (e: CleanEvent, eventId: string, activeMs: number | null, date: string): boolean =>
      run(
        `INSERT OR IGNORE INTO analytics_events (event_id, session_id, type, visit_id, route, item_id, category_id, active_ms,
                  depth, position, quantity_delta, quick_add, interaction_ref, layout_version, menu_version,
                  client_seq, client_elapsed_ms, received_at, business_date, is_fixture)
         VALUES (:event_id, :session_id, :type, :visit_id, :route, :item_id, :category_id, :active_ms,
                 :depth, :position, :quantity_delta, :quick_add, :interaction_ref, :layout_version, :menu_version,
                 :client_seq, :client_elapsed_ms, :received_at, :business_date, :is_fixture)`,
        {
          ...base,
          event_id: eventId,
          type: e.type,
          route: e.route,
          item_id: e.item_id ?? null,
          category_id: e.category_id ?? null,
          active_ms: activeMs,
          depth: e.depth ?? null,
          position: e.position ?? null,
          quantity_delta: e.quantity_delta ?? null,
          quick_add: e.quick_add === undefined || e.quick_add === null ? null : e.quick_add ? 1 : 0,
          interaction_ref: e.interaction_ref ?? null,
          layout_version: e.layout_version ?? null,
          menu_version: e.menu_version ?? null,
          client_seq: e.seq,
          client_elapsed_ms: e.elapsed_ms,
          business_date: date,
        },
      ).changes === 1;

    let ended = false;
    for (const e of events) {
      if (!e || (e.item_id && !items.has(e.item_id)) || (e.category_id && !categories.has(e.category_id))) {
        result.rejected++;
        continue;
      }
      let inserted: boolean;
      if (e.type === 'active_time_chunk') {
        // The interval ended when the server received it; split it at the
        // business-day boundary so no day is credited with the other's time.
        const start = new Date(clock.ms - e.active_ms!).toISOString();
        const parts = splitByBusinessDay(start, now, clock.cutoff);
        const first = parts[0] ?? { date: clock.today, ms: e.active_ms! };
        const restMs = parts.slice(1).reduce((s, p) => s + p.ms, 0);
        inserted = insertEvent(e, e.event_id, first.ms, first.date);
        if (inserted && restMs > 0) insertEvent(e, `${e.event_id}~2`, restMs, parts[parts.length - 1].date);
      } else {
        inserted = insertEvent(e, e.event_id, e.active_ms ?? null, clock.today);
      }
      if (!inserted) {
        result.duplicates++;
        continue;
      }
      result.accepted++;
      if (e.type === 'session_end') ended = true;
    }

    if (result.accepted > 0) {
      run(
        `UPDATE analytics_sessions SET last_event_at = :now,
                ended_at = CASE WHEN :ended = 1 THEN :now ELSE ended_at END,
                end_reason = CASE WHEN :ended = 1 THEN 'client' ELSE end_reason END
          WHERE id = :id`,
        { id: session.id, now, ended: ended ? 1 : 0 },
      );
    }
    return result;
  });
}

// ================================================================== engagement stats
export const SCROLL_THRESHOLDS = [25, 50, 75, 100] as const;

const share = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 10_000) / 10_000 : null);

/** The Engagement page for a period (brief 39). */
export function engagementStats(q: StatsParams): EngagementDTO {
  const rp = resolvePeriod(q);
  const include = rp.include_fixture;
  const { from, to, clock } = rp;
  const range = { from, to };
  const fe = fixtureSql('e', include);
  const inRange = `e.business_date BETWEEN :from AND :to AND ${fe}`;
  const settings = getSettings();

  // ---- coverage
  const sessions = many<{ id: string; kind: 'public' | 'dining' }>(
    `SELECT s.id, s.kind FROM analytics_sessions s
      WHERE s.id IN (SELECT DISTINCT e.session_id FROM analytics_events e WHERE ${inRange})`, range);
  const dining = new Set(sessions.filter((s) => s.kind === 'dining').map((s) => s.id));
  const optedOut = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM analytics_sessions s
      WHERE s.opted_out = 1 AND s.business_date BETWEEN :from AND :to AND ${fixtureSql('s', include)}`, range)!.n;
  const started = settings.analytics.instrumentation_started_at;
  const telemetrySince = started
    ? businessDate(started, clock.cutoff)
    : one<{ d: string | null }>(`SELECT MIN(e.business_date) AS d FROM analytics_events e WHERE ${fe}`)?.d ?? null;
  const rawHorizon = addDays(clock.today, -settings.retention.raw_events_days);
  const note = !settings.analytics.enabled ? 'analytics_disabled'
    : sessions.length === 0 ? 'no_telemetry'
      : telemetrySince && telemetrySince > from ? 'telemetry_started_in_period'
        : from < rawHorizon ? 'raw_events_retention'
          : null;

  // ---- active time (observed foreground time, not attention)
  const menuMs = many<{ ms: number }>(
    `SELECT SUM(e.active_ms) AS ms FROM analytics_events e
      WHERE e.type = 'active_time_chunk' AND e.route = 'menu' AND ${inRange}
      GROUP BY e.session_id HAVING ms > 0`, range).map((r) => r.ms);
  const detailMs = many<{ ms: number }>(
    `SELECT SUM(e.active_ms) AS ms FROM analytics_events e
      WHERE e.type = 'item_detail_active_time' AND ${inRange}
      GROUP BY e.session_id, e.item_id, COALESCE(e.interaction_ref, e.event_id) HAVING ms > 0`, range).map((r) => r.ms);

  // ---- category exposure
  const exposure = new Map(many<{ category_id: string; n: number }>(
    `SELECT e.category_id, COUNT(DISTINCT e.session_id) AS n FROM analytics_events e
      WHERE e.type = 'category_view' AND e.category_id IS NOT NULL AND ${inRange}
      GROUP BY e.category_id`, range).map((r) => [r.category_id, r.n]));
  const categories = many<{ id: string; name_th: string | null; name_en: string; status: string }>(
    `SELECT c.id, c.name_th, c.name_en, c.status FROM menu_categories c JOIN menu_groups g ON g.id = c.group_id
      ORDER BY g.sort, c.sort, c.key`)
    .filter((c) => c.status === 'published' || exposure.has(c.id))
    .map((c) => ({
      category_id: c.id,
      name: bi(c.name_th, c.name_en),
      sessions_exposed: exposure.get(c.id) ?? 0,
      share: share(exposure.get(c.id) ?? 0, sessions.length),
    }));

  // ---- item table
  // A round is attributed when it names a stored session that has not opted out.
  const attributedJoin = `LEFT JOIN analytics_sessions a ON a.id = o.analytics_session_id AND a.opted_out = 0`;
  const itemEvents = many<{ item_id: string; impressions: number; detail_opens: number; adds: number }>(
    `SELECT e.item_id, SUM(e.type = 'item_impression') AS impressions, SUM(e.type = 'item_detail_open') AS detail_opens,
            SUM(e.type = 'cart_add') AS adds
       FROM analytics_events e WHERE e.item_id IS NOT NULL AND ${inRange} GROUP BY e.item_id`, range);
  const submitted = new Map(many<{ item_id: string; qty: number }>(
    `SELECT l.item_id, SUM(l.quantity) AS qty FROM order_lines l JOIN orders o ON o.id = l.order_id ${attributedJoin}
      WHERE a.id IS NOT NULL AND o.business_date BETWEEN :from AND :to AND ${fixtureSql('o', include)}
      GROUP BY l.item_id`, range).map((r) => [r.item_id, r.qty]));
  const itemIds = new Set([...itemEvents.map((r) => r.item_id), ...submitted.keys()]);
  const names = new Map(many<{ id: string; key: string; name_th: string | null; name_en: string | null }>(
    'SELECT id, key, name_th, name_en FROM menu_items WHERE id IN (SELECT value FROM json_each(:ids))', { ids: [...itemIds] })
    .map((r) => [r.id, r]));
  const eventsBy = new Map(itemEvents.map((r) => [r.item_id, r]));
  const itemRows = [...itemIds].map((id) => {
    const ev = eventsBy.get(id);
    const n = names.get(id);
    const impressions = ev?.impressions ?? 0;
    const adds = ev?.adds ?? 0;
    return {
      item_id: id,
      name: bi(n?.name_th, n?.name_en),
      impressions,
      detail_opens: ev?.detail_opens ?? 0,
      adds,
      add_rate: share(adds, impressions),
      submitted: submitted.get(id) ?? 0,
      sortKey: `${(n?.name_en ?? '').toLowerCase()}|${n?.name_th ?? ''}|${n?.key ?? id}`,
    };
  }).sort((a, b) => b.impressions - a.impressions || b.adds - a.adds || a.sortKey.localeCompare(b.sortKey))
    .map(({ sortKey: _k, ...r }) => r);

  // ---- funnel over measured dining sessions (public browsers cannot submit)
  const flags = many<{ session_id: string; imp: number; det: number; add: number; qa: number }>(
    `SELECT e.session_id, MAX(e.type = 'item_impression') AS imp, MAX(e.type = 'item_detail_open') AS det,
            MAX(e.type = 'cart_add') AS "add", MAX(e.type = 'cart_add' AND e.quick_add = 1) AS qa
       FROM analytics_events e JOIN analytics_sessions s ON s.id = e.session_id
      WHERE s.kind = 'dining' AND ${inRange}
      GROUP BY e.session_id`, range);
  const orderRows = many<{ session: string | null; attributed: number }>(
    `SELECT o.analytics_session_id AS session, a.id IS NOT NULL AS attributed FROM orders o ${attributedJoin}
      WHERE o.business_date BETWEEN :from AND :to AND ${fixtureSql('o', include)}`, range);
  const submitSessions = new Set(orderRows.filter((o) => o.attributed === 1 && o.session && dining.has(o.session)).map((o) => o.session));
  const attributed = orderRows.filter((o) => o.attributed === 1).length;

  // ---- scroll depth (approximate; depends on layout and content height)
  const depths = many<{ d: number }>(
    `SELECT MAX(e.depth) AS d FROM analytics_events e WHERE e.type = 'scroll_depth' AND ${inRange} GROUP BY e.session_id`, range)
    .map((r) => r.d);

  // ---- daily (monthly in the year view), up to today
  const last = to < clock.today ? to : clock.today;
  const perDay = new Map(many<{ d: string; sessions: number; ms: number }>(
    `SELECT e.business_date AS d, COUNT(DISTINCT e.session_id) AS sessions,
            COALESCE(SUM(CASE WHEN e.type = 'active_time_chunk' THEN e.active_ms END), 0) AS ms
       FROM analytics_events e WHERE ${inRange} GROUP BY e.business_date`, range).map((r) => [r.d, r]));
  let daily: EngagementDTO['daily'];
  if (rp.unit === 'month') {
    const perMonth = new Map(many<{ m: string; sessions: number; ms: number }>(
      `SELECT substr(e.business_date, 1, 7) AS m, COUNT(DISTINCT e.session_id) AS sessions,
              COALESCE(SUM(CASE WHEN e.type = 'active_time_chunk' THEN e.active_ms END), 0) AS ms
         FROM analytics_events e WHERE ${inRange} GROUP BY m`, range).map((r) => [r.m, r]));
    daily = rp.buckets.filter((bk) => bk.from <= last).map((bk) => ({
      date: bk.key, sessions: perMonth.get(bk.key)?.sessions ?? 0, active_ms: perMonth.get(bk.key)?.ms ?? 0,
    }));
  } else {
    daily = datesBetween(from, last).map((d) => ({ date: d, sessions: perDay.get(d)?.sessions ?? 0, active_ms: perDay.get(d)?.ms ?? 0 }));
  }

  return {
    from,
    to,
    coverage: {
      measured_sessions: sessions.length,
      dining_sessions: dining.size,
      public_sessions: sessions.length - dining.size,
      opted_out_sessions: optedOut,
      telemetry_since: telemetrySince,
      note,
    },
    active_menu_ms: distribution(menuMs),
    active_detail_ms: distribution(detailMs),
    categories,
    items: itemRows,
    funnel: {
      sessions: dining.size,
      impression_sessions: flags.filter((f) => f.imp).length,
      detail_sessions: flags.filter((f) => f.det).length,
      add_sessions: flags.filter((f) => f.add).length,
      quick_add_sessions: flags.filter((f) => f.qa).length,
      submit_sessions: submitSessions.size,
      attributed_orders: attributed,
      unattributed_orders: orderRows.length - attributed,
    },
    scroll: SCROLL_THRESHOLDS.map((threshold) => ({ threshold, sessions: depths.filter((d) => d >= threshold).length })),
    daily,
    include_fixture: include,
    generated_at: nowIso(),
    period: rp.period,
  };
}
