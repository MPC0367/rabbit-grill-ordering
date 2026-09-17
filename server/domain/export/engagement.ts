// Engagement summary for the annual report (brief 39, 41 item 5), with the
// same definitions as the Engagement screen (D-S6-09):
//  - measured sessions: distinct sessions with a stored event in the year;
//  - active menu time: per session, the sum of menu-route active chunks;
//  - active detail time: one value per detail open (session, item, interaction);
//  - category exposure: sessions with a category view / measured sessions;
//  - add rate: sessions that saw the dish and added it / sessions that saw it
//    (per session on both sides, so it can never pass 100%, D-S8-06);
//  - scroll depth: the deepest menu-route depth per session, over sessions
//    with a menu-route event (D-S8-05); attributed quantity: every line of rounds
//    whose analytics session is a stored, not-opted-out session;
//  - the funnel covers measured dining sessions (public browsers cannot order).
//
// Raw events can run to millions of rows a year, so everything here is read
// one business day at a time and folded into small accumulators. Days whose
// raw events were already removed by the retention policy fall back to the
// rebuildable daily item aggregates (impressions, detail opens, adds only).
import type { Bilingual } from '../../../shared/dto.ts';
import type { SnapshotReader } from './reader.ts';
import { ratio, statOf } from './quantiles.ts';
import type { EngagementItem, EngagementSnap } from './types.ts';

export const SCROLL_THRESHOLDS = [25, 50, 75, 100];

export interface EngagementInput {
  dates: string[];
  from: string;
  to: string;
  startUtc: string;
  fx: 0 | 1;
  analyticsEnabled: boolean;
  instrumentationStartedAt: string | null;
  rawRetentionDays: number;
  /** Published categories, listed even with no exposure. */
  categories: Array<{ id: string; name: Bilingual }>;
  /** Ordering visits of the year (for measured-visit coverage). */
  orderingVisits: Set<string>;
  /** analytics_session_id -> quantity per item over all lines of its rounds. */
  attributedQty: Map<string, Map<string, number>>;
  /** analytics_session_id -> number of rounds that carried it. */
  orderSessions: Map<string, number>;
  totalRounds: number;
  staffRounds: number;
  itemName: (id: string) => Bilingual;
  categoryName: (id: string) => Bilingual;
}

interface SessionInfo { kind: string; visit_id: string | null; opted_out: number }
interface SessionFlags { imp: boolean; det: boolean; add: boolean; qa: boolean; menu: boolean; depth: number }

export async function readEngagement(r: SnapshotReader, input: EngagementInput): Promise<EngagementSnap> {
  const { fx } = input;
  const info = new Map<string, SessionInfo>();
  const optedOutStarted = new Set<string>();
  const menuMs = new Map<string, number>();
  const detailMs = new Map<string, number>();
  const catSessions = new Map<string, Set<string>>();
  const items = new Map<string, EngagementItem>();
  const flags = new Map<string, SessionFlags>();
  const typeCounts = new Map<string, number>();
  /** item -> sessions (summed per day) that saw the dish and added it. */
  const converted = new Map<string, number>();
  const monthly = new Map<string, { key: string; sessions: number; dining_sessions: number; active_ms: number; events: number }>();
  const monthSessions = new Map<string, { all: Set<string>; dining: Set<string> }>();
  const daily: EngagementSnap['daily'] = [];
  let totalActive = 0;
  let rawEvents = 0;
  let firstAt: string | null = null;
  let lastAt: string | null = null;

  const itemAcc = (id: string): EngagementItem => {
    let it = items.get(id);
    if (!it) {
      it = { item_id: id, name: input.itemName(id), impressions: 0, impression_sessions: 0, detail_opens: 0, adds: 0, add_sessions: 0, add_rate: null, attributed_qty: 0 };
      items.set(id, it);
    }
    return it;
  };
  const month = (d: string) => {
    const key = d.slice(0, 7);
    let m = monthly.get(key);
    if (!m) { m = { key, sessions: 0, dining_sessions: 0, active_ms: 0, events: 0 }; monthly.set(key, m); }
    return m;
  };

  // Sessions that started before this year but sent events in it.
  for (const s of r.all<SessionInfo & { id: string }>(
    `SELECT id, kind, visit_id, opted_out FROM analytics_sessions
      WHERE business_date < :from AND last_event_at >= :start AND (:fx = 1 OR is_fixture = 0)`,
    { from: input.from, start: input.startUtc, fx })) info.set(s.id, s);

  const rawFirst = r.get<{ d: string | null }>(
    `SELECT MIN(business_date) AS d FROM analytics_events WHERE business_date BETWEEN :from AND :to AND (:fx = 1 OR is_fixture = 0)`,
    { from: input.from, to: input.to, fx })?.d ?? null;

  for (const d of input.dates) {
    const p = { d, fx };
    const day = { date: d, sessions: 0, dining_sessions: 0, public_sessions: 0, opted_out: 0, active_ms: 0, menu_active_ms: 0, events: 0, impressions: 0, detail_opens: 0, adds: 0 };
    const m = month(d);

    for (const s of r.all<SessionInfo & { id: string }>(
      `SELECT id, kind, visit_id, opted_out FROM analytics_sessions WHERE business_date = :d AND (:fx = 1 OR is_fixture = 0)`, p)) {
      info.set(s.id, s);
      if (s.opted_out === 1) { optedOutStarted.add(s.id); day.opted_out++; }
    }

    const types = r.all<{ type: string; n: number; mn: string; mx: string }>(
      `SELECT type, COUNT(*) AS n, MIN(received_at) AS mn, MAX(received_at) AS mx FROM analytics_events
        WHERE business_date = :d AND (:fx = 1 OR is_fixture = 0) GROUP BY type`, p);
    for (const t of types) {
      typeCounts.set(t.type, (typeCounts.get(t.type) ?? 0) + t.n);
      day.events += t.n;
      if (!firstAt || t.mn < firstAt) firstAt = t.mn;
      if (!lastAt || t.mx > lastAt) lastAt = t.mx;
    }
    rawEvents += day.events;
    m.events += day.events;

    if (day.events > 0) {
      // Per-session flags; every session with an event today is a measured session.
      for (const f of r.all<{ session_id: string; imp: number; det: number; addf: number; qa: number; menu: number; depth: number | null }>(
        `SELECT session_id,
                MAX(type = 'item_impression') AS imp,
                MAX(type = 'item_detail_open') AS det,
                MAX(type = 'cart_add') AS addf,
                MAX(type = 'cart_add' AND quick_add = 1) AS qa,
                MAX(route = 'menu') AS menu,
                MAX(CASE WHEN type = 'scroll_depth' AND route = 'menu' THEN depth END) AS depth
           FROM analytics_events WHERE business_date = :d AND (:fx = 1 OR is_fixture = 0) GROUP BY session_id`, p)) {
        const prev = flags.get(f.session_id);
        const dining = info.get(f.session_id)?.kind === 'dining';
        day.sessions++;
        if (dining) day.dining_sessions++; else day.public_sessions++;
        const ms = monthSessions.get(m.key) ?? { all: new Set<string>(), dining: new Set<string>() };
        monthSessions.set(m.key, ms);
        ms.all.add(f.session_id);
        if (dining) ms.dining.add(f.session_id);
        flags.set(f.session_id, {
          imp: (prev?.imp ?? false) || f.imp === 1,
          det: (prev?.det ?? false) || f.det === 1,
          add: (prev?.add ?? false) || f.addf === 1,
          qa: (prev?.qa ?? false) || f.qa === 1,
          menu: (prev?.menu ?? false) || f.menu === 1,
          depth: Math.max(prev?.depth ?? 0, f.depth ?? 0),
        });
      }

      for (const a of r.all<{ session_id: string; route: string | null; ms: number }>(
        `SELECT session_id, route, SUM(active_ms) AS ms FROM analytics_events
          WHERE business_date = :d AND type = 'active_time_chunk' AND (:fx = 1 OR is_fixture = 0) GROUP BY session_id, route`, p)) {
        const ms = a.ms ?? 0;
        day.active_ms += ms;
        if (a.route === 'menu') {
          day.menu_active_ms += ms;
          menuMs.set(a.session_id, (menuMs.get(a.session_id) ?? 0) + ms);
        }
      }
      totalActive += day.active_ms;
      m.active_ms += day.active_ms;

      for (const a of r.all<{ k: string; ms: number }>(
        `SELECT session_id || '|' || IFNULL(item_id, '') || '|' || IFNULL(interaction_ref, event_id) AS k, SUM(active_ms) AS ms
           FROM analytics_events
          WHERE business_date = :d AND type = 'item_detail_active_time' AND (:fx = 1 OR is_fixture = 0)
          GROUP BY session_id, item_id, IFNULL(interaction_ref, event_id)`, p)) {
        detailMs.set(a.k, (detailMs.get(a.k) ?? 0) + (a.ms ?? 0));
      }

      for (const c of r.all<{ category_id: string; session_id: string }>(
        `SELECT DISTINCT category_id, session_id FROM analytics_events
          WHERE business_date = :d AND type = 'category_view' AND category_id IS NOT NULL AND (:fx = 1 OR is_fixture = 0)`, p)) {
        let set = catSessions.get(c.category_id);
        if (!set) { set = new Set(); catSessions.set(c.category_id, set); }
        set.add(c.session_id);
      }

      for (const it of r.all<{ item_id: string; type: string; n: number; s: number }>(
        `SELECT item_id, type, COUNT(*) AS n, COUNT(DISTINCT session_id) AS s FROM analytics_events
          WHERE business_date = :d AND type IN ('item_impression','item_detail_open','cart_add') AND item_id IS NOT NULL
            AND (:fx = 1 OR is_fixture = 0) GROUP BY item_id, type`, p)) {
        const acc = itemAcc(it.item_id);
        if (it.type === 'item_impression') { acc.impressions += it.n; acc.impression_sessions += it.s; day.impressions += it.n; }
        else if (it.type === 'item_detail_open') { acc.detail_opens += it.n; day.detail_opens += it.n; }
        else { acc.adds += it.n; acc.add_sessions += it.s; day.adds += it.n; }
      }

      for (const c of r.all<{ item_id: string; conv: number }>(
        `SELECT item_id, SUM(imp AND addf) AS conv FROM (
           SELECT item_id, session_id, MAX(type = 'item_impression') AS imp, MAX(type = 'cart_add') AS addf
             FROM analytics_events
            WHERE business_date = :d AND type IN ('item_impression','cart_add') AND item_id IS NOT NULL
              AND (:fx = 1 OR is_fixture = 0)
            GROUP BY item_id, session_id)
          GROUP BY item_id HAVING conv > 0`, p)) {
        converted.set(c.item_id, (converted.get(c.item_id) ?? 0) + c.conv);
      }
    }
    daily.push(day);
    await r.tick();
  }

  // Days before the first retained raw event: use the daily item aggregates.
  let aggDays = 0;
  if (!rawFirst || rawFirst > input.from) {
    const agg = r.all<{ business_date: string; item_id: string; imp: number; det: number; adds: number }>(
      `SELECT business_date, item_id, SUM(impressions) AS imp, SUM(detail_opens) AS det, SUM(adds) AS adds
         FROM agg_item_daily
        WHERE business_date >= :from AND business_date < :until AND (:fx = 1 OR is_fixture = 0)
          AND (impressions > 0 OR detail_opens > 0 OR adds > 0)
        GROUP BY business_date, item_id`,
      { from: input.from, until: rawFirst ?? `${input.to}~`, fx });
    const dates = new Set<string>();
    for (const a of agg) {
      dates.add(a.business_date);
      const acc = itemAcc(a.item_id);
      acc.impressions += a.imp;
      acc.detail_opens += a.det;
      acc.adds += a.adds;
    }
    aggDays = dates.size;
  }

  // Order attribution: rounds whose session is stored (at any date, e.g. a visit that
  // started browsing before New Year) and did not opt out.
  const unknownIds = [...input.orderSessions.keys()].filter((sid) => !info.has(sid));
  for (let i = 0; i < unknownIds.length; i += 500) {
    for (const s of r.all<SessionInfo & { id: string }>(
      `SELECT id, kind, visit_id, opted_out FROM analytics_sessions
        WHERE id IN (SELECT value FROM json_each(:ids)) AND (:fx = 1 OR is_fixture = 0)`,
      { ids: JSON.stringify(unknownIds.slice(i, i + 500)), fx })) info.set(s.id, s);
    await r.tick();
  }
  const attributable = (sid: string) => info.has(sid) && info.get(sid)!.opted_out !== 1;
  let attributedRounds = 0;
  const submitSessions = new Set<string>();
  for (const [sid, count] of input.orderSessions) {
    if (!attributable(sid)) continue;
    attributedRounds += count;
    submitSessions.add(sid);
    for (const [itemId, qty] of input.attributedQty.get(sid) ?? []) itemAcc(itemId).attributed_qty += qty;
  }
  for (const it of items.values()) it.add_rate = ratio(converted.get(it.item_id) ?? 0, it.impression_sessions);

  // Funnel over measured dining sessions.
  let funnelSessions = 0, imp = 0, det = 0, add = 0, qa = 0, submitted = 0, dining = 0, publicSessions = 0;
  const measuredVisits = new Set<string>();
  const scroll = SCROLL_THRESHOLDS.map((threshold) => ({ threshold, sessions: 0 }));
  let scrollSessions = 0;
  for (const [sid, f] of flags) {
    const s = info.get(sid);
    if (f.menu) scrollSessions++;
    for (const t of scroll) if (f.depth >= t.threshold) t.sessions++;
    if (s?.kind !== 'dining') { publicSessions++; continue; }
    dining++;
    if (s.visit_id) measuredVisits.add(s.visit_id);
    if (s.opted_out === 1) continue;
    funnelSessions++;
    if (f.imp) imp++;
    if (f.det) det++;
    if (f.add) add++;
    if (f.qa) qa++;
    if (submitSessions.has(sid)) submitted++;
  }

  const measured = flags.size;
  for (const m of monthly.values()) {
    m.sessions = monthSessions.get(m.key)?.all.size ?? 0;
    m.dining_sessions = monthSessions.get(m.key)?.dining.size ?? 0;
  }
  const catRows = new Map(input.categories.map((c) => [c.id, { category_id: c.id, name: c.name, sessions: 0, share: ratio(0, measured) }]));
  for (const [id, set] of catSessions) catRows.set(id, { category_id: id, name: input.categoryName(id), sessions: set.size, share: ratio(set.size, measured) });

  return {
    enabled_now: input.analyticsEnabled,
    instrumentation_started_at: input.instrumentationStartedAt,
    first_event_at: firstAt,
    last_event_at: lastAt,
    sessions: measured,
    dining_sessions: dining,
    public_sessions: publicSessions,
    opted_out_sessions: optedOutStarted.size,
    raw_events: rawEvents,
    raw_first_date: rawFirst,
    raw_retention_days: input.rawRetentionDays,
    agg_fallback_days: aggDays,
    ordering_visits: input.orderingVisits.size,
    measured_visits: [...input.orderingVisits].filter((v) => measuredVisits.has(v)).length,
    menu_active_ms: statOf([...menuMs.values()]),
    detail_active_ms: statOf([...detailMs.values()]),
    total_active_ms: totalActive,
    categories: [...catRows.values()].sort((a, b) => b.sessions - a.sessions),
    items: [...items.values()].sort((a, b) => b.impressions - a.impressions || b.adds - a.adds),
    funnel: {
      sessions: funnelSessions,
      impression_sessions: imp,
      detail_sessions: det,
      add_sessions: add,
      quick_add_sessions: qa,
      submit_sessions: submitted,
      attributed_orders: attributedRounds,
      unattributed_orders: input.totalRounds - attributedRounds,
      staff_orders: input.staffRounds,
    },
    scroll,
    scroll_sessions: scrollSessions,
    monthly: [...monthly.values()].sort((a, b) => a.key.localeCompare(b.key)),
    daily,
    event_types: [...typeCounts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
  };
}
