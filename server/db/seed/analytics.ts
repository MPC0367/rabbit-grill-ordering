// Fixture engagement telemetry in the shape the guest client sends
// (shared/schemas.ts AnalyticsBatchBody), stored as the ingest would store it.
//
// A dining session follows its browser's real fixture orders: every dish a
// guest submitted was seen (impression), usually opened (detail), and added
// (cart_add) shortly before the round's submission time. Active time comes in
// 10-15 s heartbeat chunks. Public sessions browse without ordering.
import type { MenuModel, ModelItem } from './menu-model.ts';
import type { SeedCtx, SimGuest } from './records.ts';
import { bangkokMs, iso, MINUTE, type Rng } from './util.ts';
import type { VisitSim } from './visit-sim.ts';

type Route = 'menu' | 'item' | 'cart' | 'track' | 'bill' | 'join' | 'other';

interface Ev {
  type: string;
  at: number;
  route: Route;
  item_id?: string | null;
  category_id?: string | null;
  active_ms?: number | null;
  depth?: number | null;
  position?: number | null;
  quantity_delta?: number | null;
  quick_add?: boolean | null;
  interaction_ref?: string | null;
}

export interface AnalyticsEnv {
  r: Rng;
  ctx: SeedCtx;
  model: MenuModel;
}

// Same shape as the tracker (D-C3-02): <app layout>:<orientation><width class>.
const LAYOUTS = ['menu-v1:ps', 'menu-v1:ps', 'menu-v1:ps', 'menu-v1:pm'];
const MENU_VERSION = 'fx-menu-1';
const FLUSH_MS = 12_000;
const DEPTHS = [25, 50, 75, 100];
const DEPTH_CHANCE = [0.95, 0.75, 0.5, 0.3];

/**
 * Heartbeat chunks (10-15 s each, about 14 s) totalling about `activeMs` over
 * [from, to]. Each chunk is reported when it ends and never overlaps the
 * previous one; one interval id (`ivl_`) per stretch of activity.
 */
function chunks(r: Rng, evs: Ev[], from: number, to: number, activeMs: number, route: Route): void {
  const span = to - from;
  if (span < 12_000 || activeMs < 10_000) return;
  const total = Math.min(activeMs, span * 0.85);
  const n = Math.max(1, Math.round(total / 14_000));
  const per = Math.max(10_000, Math.min(15_000, Math.round(total / n)));
  if (per > span) return;
  const ref = `ivl_${r.chars(12)}`;
  for (let i = 0; i < n; i++) {
    const at = from + ((i + 1) / n) * span;
    evs.push({ type: 'active_time_chunk', at, route, active_ms: Math.max(10_000, per - r.int(0, 400)), interaction_ref: ref });
  }
}

/** Impressions are counted once per session per dish (re-scrolling does not add more). */
class Exposure {
  private seen = new Set<string>();
  private r: Rng;
  private evs: Ev[];
  private started: number;
  constructor(r: Rng, evs: Ev[], started: number) {
    this.r = r;
    this.evs = evs;
    this.started = started;
  }

  impression(item: ModelItem, at: number): void {
    if (this.seen.has(item.id)) return;
    this.seen.add(item.id);
    this.evs.push({ type: 'item_impression', at, route: 'menu', item_id: item.id, category_id: item.category_id, position: Math.min(500, item.menu_index) });
  }

  /** Detail open + active dwell ending at `end` (one `dop_` reference per opening, D-C3-02). */
  detail(item: ModelItem, end: number): void {
    const room = end - this.started - 3_000;
    if (room < 2_000) return;
    const dwell = Math.min(this.r.int(3_000, 40_000), room - 1_000);
    const ref = `dop_${this.r.chars(12)}`;
    const openAt = Math.max(this.started + 1_000, end - dwell - this.r.int(500, 2_000));
    this.evs.push({ type: 'item_detail_open', at: openAt, route: 'item', item_id: item.id, category_id: item.category_id, position: Math.min(500, item.menu_index), interaction_ref: ref });
    this.evs.push({ type: 'item_detail_active_time', at: end - this.r.int(200, 900), route: 'item', item_id: item.id, category_id: item.category_id, active_ms: dwell, interaction_ref: ref });
  }
}

/** Categories scrolled past near the top of the menu, with one or two cards each. */
function browseCategories(r: Rng, model: MenuModel, exp: Exposure, evs: Ev[], from: number, to: number, count: number, offset: number): void {
  const cats = model.categories;
  for (let k = 0; k < count; k++) {
    const cat = cats[(offset + k) % cats.length];
    const at = from + (to - from) * (0.05 + (0.55 * k) / Math.max(1, count));
    evs.push({ type: 'category_view', at, route: 'menu', category_id: cat.id });
    const cards = Math.min(cat.items.length, r.chance(0.3) ? 2 : 1);
    for (let c = 0; c < cards; c++) exp.impression(cat.items[c], at + r.int(1_000, 3_000));
  }
}

function scroll(r: Rng, evs: Ev[], from: number, to: number, reached: { depth: number }, chanceScale: number): void {
  DEPTHS.forEach((d, i) => {
    if (d <= reached.depth || !r.chance(DEPTH_CHANCE[i] * chanceScale)) return;
    if (reached.depth < (DEPTHS[i - 1] ?? 0)) return; // thresholds are reached in order
    reached.depth = d;
    evs.push({ type: 'scroll_depth', at: from + (to - from) * (0.2 + 0.18 * i), route: 'menu', depth: d });
  });
}

interface Stamped { ev: Ev; at: number; received: number }

/** Order events, give them client sequence numbers and the time a batch flush would deliver them. */
function stamp(r: Rng, started: number, evs: Ev[]): { rows: Stamped[]; last: number } {
  evs.sort((a, b) => a.at - b.at);
  let last = started;
  const rows = evs.map((ev) => {
    const at = Math.max(started + 1, Math.round(ev.at));
    const received = started + Math.ceil((at - started) / FLUSH_MS) * FLUSH_MS + r.int(80, 600);
    last = Math.max(last, received);
    return { ev, at, received };
  });
  return { rows, last };
}

/** Events reference their session, so this runs after the session row is written. */
function writeEvents(env: AnalyticsEnv, sessionId: string, visitId: string | null, started: number, rows: Stamped[]): void {
  const { r, ctx } = env;
  const layout = r.pick(LAYOUTS);
  rows.forEach(({ ev: e, at, received }, seq) => {
    ctx.w.put('analytics_events', {
      event_id: `ev_${r.chars(16)}`, session_id: sessionId, type: e.type, visit_id: visitId, route: e.route,
      item_id: e.item_id ?? null, category_id: e.category_id ?? null, active_ms: e.active_ms ?? null,
      depth: e.depth ?? null, position: e.position ?? null, quantity_delta: e.quantity_delta ?? null,
      quick_add: e.quick_add ?? null, interaction_ref: e.interaction_ref ?? null,
      layout_version: e.type === 'scroll_depth' || e.type === 'item_impression' || e.type === 'category_view' ? layout : null,
      menu_version: MENU_VERSION,
      client_seq: seq, client_elapsed_ms: at - started,
      received_at: iso(received), business_date: ctx.bdate(received), is_fixture: 1,
    });
  });
}

/** Engagement for one joined browser of a closed (or live) visit. */
export function writeDiningSession(env: AnalyticsEnv, vs: VisitSim, guest: SimGuest, sessionId: string, optedOut: boolean, until: number): void {
  const { r, ctx, model } = env;
  // Joining a table always starts a new session (D-C3-01); pre-join browsing stays public.
  const started = guest.joined;
  const evs: Ev[] = [];
  if (!optedOut) {
    const exp = new Exposure(r, evs, started);
    const reached = { depth: 0 };
    const rounds = vs.orders.filter((o) => o.guest === guest && o.source === 'guest' && !o.duplicate).sort((a, b) => a.at - b.at);
    const totalActive = 60_000 + 300_000 * Math.pow(r.next(), 2);

    evs.push({ type: 'menu_view', at: guest.joined + r.int(1_000, 3_000), route: 'menu' });
    const bounds = [guest.joined, ...rounds.map((o) => o.at)];
    if (rounds.length === 0) bounds.push(Math.min(until, guest.joined + r.between(2, 8) * MINUTE));
    for (let i = 0; i + 1 < bounds.length; i++) {
      const from = bounds[i] + 2_000;
      const to = bounds[i + 1] - 1_000;
      if (to - from < 20_000) continue;
      const first = i === 0;
      browseCategories(r, model, exp, evs, from, to, first ? r.int(2, 4) : 1, first ? 0 : r.int(0, model.categories.length - 1));
      scroll(r, evs, from, to, reached, first ? 1 : 0.5);
      chunks(r, evs, from, to, totalActive * (first ? 0.65 : 0.25 / Math.max(1, rounds.length - 1)), 'menu');

      const lines = rounds[i]?.lines ?? [];
      lines.forEach((line, j) => {
        const addAt = from + (to - from) * (0.55 + (0.4 * (j + 1)) / (lines.length + 1));
        exp.impression(line.item, Math.max(from, addAt - r.int(20_000, 60_000)));
        const detail = line.item.variants.length > 0 || line.item.beans !== null || r.chance(0.55);
        if (detail) exp.detail(line.item, addAt - r.int(500, 1_500));
        evs.push({
          type: 'cart_add', at: addAt, route: detail ? 'item' : 'menu', item_id: line.item.id, category_id: line.item.category_id,
          quantity_delta: line.quantity, quick_add: !detail, interaction_ref: `crt_${r.chars(12)}`,
        });
      });

      if (first && r.chance(0.08)) {
        const extra = r.pick(model.orderable);
        const addAt = from + (to - from) * 0.3;
        exp.impression(extra, addAt - 5_000);
        const ref = `crt_${r.chars(12)}`;
        evs.push({ type: 'cart_add', at: addAt, route: 'menu', item_id: extra.id, category_id: extra.category_id, quantity_delta: 1, quick_add: true, interaction_ref: ref });
        evs.push({ type: 'cart_remove', at: from + (to - from) * 0.45, route: 'cart', item_id: extra.id, category_id: extra.category_id, quantity_delta: -1, interaction_ref: ref });
      }
    }

    // a measured-weight cut is opened (and requested) rather than added to the cart
    for (const p of vs.portions) {
      if (p.guest !== guest) continue;
      exp.impression(p.item, p.created - r.int(40_000, 90_000));
      exp.detail(p.item, p.created - r.int(500, 2_000));
    }

    // watching the order tracker after the last round
    const lastRound = rounds.at(-1)?.at;
    if (lastRound !== undefined) {
      const end = Math.min(until - 5_000, lastRound + r.between(1, 4) * MINUTE);
      chunks(r, evs, lastRound + 5_000, end, totalActive * 0.1, 'track');
    }
    if (r.chance(0.6)) evs.push({ type: 'session_end', at: until - r.int(1_000, 60_000), route: 'other' });
  }
  const { rows, last } = stamp(r, started, evs.filter((e) => e.at < until));
  const closed = vs.visit.closed_at;
  ctx.w.put('analytics_sessions', {
    id: sessionId, kind: 'dining', visit_id: vs.visit.id, guest_session_id: guest.id, locale: guest.locale,
    opted_out: optedOut, started_at: iso(started), first_join_at: iso(guest.joined),
    last_event_at: iso(last), ended_at: closed === null ? null : iso(closed),
    end_reason: closed === null ? null : 'visit_closed',
    business_date: ctx.bdate(started), is_fixture: 1,
  });
  writeEvents(env, sessionId, vs.visit.id, started, rows);
}

/** Someone browsing the public menu without joining a table. */
export function writePublicSession(env: AnalyticsEnv, date: string): void {
  const { r, ctx, model } = env;
  const started = bangkokMs(date, r.between(9 * 60, 22 * 60));
  const span = r.between(0.5, 4) * MINUTE;
  const evs: Ev[] = [];
  const exp = new Exposure(r, evs, started);
  evs.push({ type: 'menu_view', at: started + r.int(500, 2_000), route: 'menu' });
  browseCategories(r, model, exp, evs, started, started + span, r.int(2, 6), r.chance(0.3) ? r.int(0, model.categories.length - 1) : 0);
  scroll(r, evs, started, started + span, { depth: 0 }, 0.8);
  const opens = r.int(0, 2);
  for (let i = 0; i < opens; i++) exp.detail(r.pick(model.visible), started + span * r.between(0.4, 0.95));
  chunks(r, evs, started, started + span, r.between(20_000, 180_000), 'menu');
  if (r.chance(0.5)) evs.push({ type: 'session_end', at: started + span + r.int(1_000, 20_000), route: 'other' });
  const id = `ans_${r.chars(16)}`;
  const { rows, last } = stamp(r, started, evs);
  ctx.w.put('analytics_sessions', {
    id, kind: 'public', visit_id: null, guest_session_id: null, locale: r.chance(0.6) ? 'th' : 'en',
    opted_out: 0, started_at: iso(started), first_join_at: null, last_event_at: iso(last),
    ended_at: iso(last + 30_000), end_reason: 'idle', business_date: ctx.bdate(started), is_fixture: 1,
  });
  writeEvents(env, id, null, started, rows);
}
