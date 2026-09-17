// Synthetic fixture history (brief 37-41): every open day from `from` to
// `to`, written one calendar month per transaction.
//
// Shape of the fixture restaurant (invented demo parameters, not facts):
//  - closed on Wednesdays, as the third-party hours say: real zero days;
//  - busier Friday to Sunday and in the cool season (Nov-Feb), a little
//    busier in 2026, with natural day-to-day noise and one rainy quiet week;
//  - seated 11:00-20:30, lunch and dinner peaks, 12 tables;
//  - telemetry exists only from `instrumentationFrom`, so 2025 engagement
//    coverage is honestly partial.
import { addDays, isoWeekday } from '../../../shared/time.ts';
import { tx } from '../index.ts';
import { writeDiningSession, writePublicSession, type AnalyticsEnv } from './analytics.ts';
import { INTRODUCED, nextMorning, OPENING_PREP_MINUTES, PRAWN_SELL_OUTS, STATIC_SOLD_OUT, staticAvailability, type Availability, type MenuModel } from './menu-model.ts';
import {
  fixtureTokenHash, staffActor, writeAdjustment, writeAudit, writeAvailability, writeBill, writeGuest, writeOrder,
  writePayment, writePortion, writeService, writeVisit, type SeedCtx,
} from './records.ts';
import type { StaffByRole } from './staff.ts';
import type { SeedTable } from './tables.ts';
import { bangkokMs, hasColumn, iso, rng, yieldToLoop, type Rng } from './util.ts';
import { checkoutVisit, finishVisit, planDay, playDay, playLateRound, seatVisits, type DayEnv, type RunOut, type VisitSim } from './visit-sim.ts';

export interface HistoryInput {
  ctx: SeedCtx;
  model: MenuModel;
  staff: StaffByRole;
  tables: SeedTable[];
}

export interface HistoryResult {
  days: number;
  openDays: number;
  visits: number;
  turnedAway: number;
  orders: number;
  publicSessions: number;
  diningSessions: number;
}

/** Fixed-date Thai public holidays (fixture demand bump only). MM-DD. */
const HOLIDAYS = new Set(['01-01', '04-13', '04-14', '04-15', '05-01', '07-28', '08-12', '10-13', '10-23', '12-05', '12-10', '12-31']);
/** A rainy week with fewer guests - ordinary variation, not a closure. */
const QUIET_WEEK = { from: '2025-09-15', to: '2025-09-21' };
/** Base visits by weekday, Monday..Sunday (Wednesday closed). */
const WEEKDAY_BASE = [10, 9, 0, 11, 16, 22, 19];

function visitsForDay(r: Rng, date: string): number {
  const month = Number(date.slice(5, 7));
  const season = month >= 11 || month <= 2 ? 1.22 : month <= 5 ? 0.92 : 0.84;
  const growth = date >= '2026-01-01' ? 1.08 : 1;
  const holiday = HOLIDAYS.has(date.slice(5)) ? 1.3 : 1;
  const quiet = date >= QUIET_WEEK.from && date <= QUIET_WEEK.to ? 0.55 : 1;
  const n = WEEKDAY_BASE[isoWeekday(date)] * season * growth * holiday * quiet * r.between(0.8, 1.2);
  return Math.max(quiet < 1 ? 5 : 8, Math.min(36, Math.round(n)));
}

/** One evening's "we ran out" event for a popular dish (about a third of open days). */
function runOutFor(r: Rng, model: MenuModel, date: string): RunOut | null {
  if (!r.chance(0.35)) return null;
  const pool = [...model.byCourse.main, ...model.byCourse.starter, ...model.byCourse.dessert].filter((i) => i.key !== 'grilled-river-prawns');
  if (!pool.length) return null;
  return { item: r.weighted(pool, (i) => i.weight), at: bangkokMs(date, r.between(17 * 60 + 30, 19 * 60 + 30)), triggered: false };
}

/** Availability rows known before the days are played: introductions, the Wagyu week, prawn evenings. */
function staticSpells(input: HistoryInput, av: Availability, from: string, to: string): void {
  const { ctx, model, staff } = input;
  const kitchen = staff.kitchen;
  const log = (itemId: string, available: boolean, reason: string, at: number, auditReason: string) => {
    writeAvailability(ctx, itemId, available, reason, at, kitchen.id);
    writeAudit(ctx, staffActor(kitchen), available ? 'menu.item_restocked' : 'menu.item_sold_out', { type: 'menu_item', id: itemId }, at, { reason: auditReason });
  };
  for (const [key, date] of Object.entries(INTRODUCED)) {
    const item = model.byKey.get(key);
    if (item && date >= from && date <= to) log(item.id, true, 'published', bangkokMs(date, OPENING_PREP_MINUTES), 'New drink added to the menu');
  }
  for (const s of STATIC_SOLD_OUT) {
    const item = model.byKey.get(s.key);
    if (!item || s.from > to) continue;
    log(item.id, false, 'sold_out', bangkokMs(s.from, OPENING_PREP_MINUTES), s.reason);
    if (s.to <= to) log(item.id, true, 'restocked', bangkokMs(s.to, OPENING_PREP_MINUTES), 'Delivery arrived');
  }
  const prawns = model.byKey.get('grilled-river-prawns');
  if (prawns) {
    for (const date of PRAWN_SELL_OUTS) {
      if (date < from || date > to) continue;
      const r = rng(`prawns:${date}`);
      const at = bangkokMs(date, r.between(18 * 60, 19 * 60 + 30));
      const until = nextMorning(date);
      av.add(prawns.id, at, until);
      log(prawns.id, false, 'sold_out', at, 'River prawns sold out for tonight');
      if (addDays(date, 1) <= to) log(prawns.id, true, 'restocked', until, 'Restocked for the next service');
    }
  }
}

function writeVisitSim(input: HistoryInput, env: DayEnv, vs: VisitSim, feedbackFixture: boolean): void {
  const { ctx } = input;
  const r = env.r;
  const v = vs.visit;
  writeVisit(ctx, v);
  for (const g of vs.guests) writeGuest(ctx, g, fixtureTokenHash(g.id), { at: v.closed_at!, reason: 'checkout' });
  for (const o of vs.orders) writeOrder(ctx, o);
  for (const p of vs.portions) writePortion(ctx, p);
  for (const s of vs.services) writeService(ctx, s);
  if (vs.bill) writeBill(ctx, v, vs.bill, vs.revisions);
  for (const a of vs.adjustments) writeAdjustment(ctx, v, a);
  if (vs.payment) writePayment(ctx, v, vs.payment);
  // Fixture ratings only where they can be flagged (feedback.is_fixture comes from a later migration).
  for (const f of feedbackFixture ? vs.feedback : []) {
    ctx.w.put('feedback', {
      id: r.id('fbk'), visit_id: v.id, guest_session_id: f.guest.id, rating: f.rating, comment: null,
      idempotency_key: f.key, created_at: iso(f.at), business_date: ctx.bdate(f.at), is_fixture: 1,
    });
  }
  if (vs.sampled) {
    const opener = Object.values(input.staff).find((s) => s.id === v.opened_by)!;
    writeAudit(ctx, staffActor(opener), 'visit.opened', { type: 'visit', id: v.id, visit_id: v.id }, v.seated, { after: { table: v.table!.label, covers: v.covers } });
  }
  for (const a of vs.audits) {
    writeAudit(ctx, a.actor, a.action, { type: a.type, id: a.id, visit_id: v.id }, a.at, { reason: a.reason ?? null, after: a.after });
  }
}

function simulateDay(input: HistoryInput, av: Availability, date: string, instrumented: boolean, feedbackFixture: boolean, result: HistoryResult): void {
  const { ctx, model, staff, tables } = input;
  const analytics: AnalyticsEnv = { r: rng(`analytics:${date}`), ctx, model };
  result.days++;

  if (isoWeekday(date) !== 2) {
    result.openDays++;
    const r = rng(`history:${date}`);
    const env: DayEnv = { r, date, ctx, model, av, staff, runOut: runOutFor(r, model, date), availabilityChanges: [] };
    const sims = planDay(env, visitsForDay(r, date));
    playDay(env, sims);
    for (const vs of sims) {
      checkoutVisit(env, vs, (late, at) => playLateRound(env, late, at));
      finishVisit(vs);
    }
    const kept = seatVisits(env, sims, tables);
    result.turnedAway += sims.length - kept.length;

    for (const vs of kept) {
      const measured = instrumented && vs.guests.length > 0 && analytics.r.chance(0.65);
      const sessions: Array<{ id: string; optedOut: boolean }> = [];
      for (const g of vs.guests) {
        if (!measured) continue;
        const optedOut = analytics.r.chance(0.03);
        const id = `ans_${analytics.r.chars(16)}`;
        g.analytics_id = optedOut ? null : id;
        sessions.push({ id, optedOut });
      }
      writeVisitSim(input, env, vs, feedbackFixture);
      vs.guests.forEach((g, i) => {
        const s = sessions[i];
        if (!s) return;
        writeDiningSession(analytics, vs, g, s.id, s.optedOut, vs.visit.closed_at!);
        result.diningSessions++;
      });
      result.visits++;
      result.orders += vs.orders.length;
    }
    for (const c of env.availabilityChanges) {
      writeAvailability(ctx, c.itemId, c.available, c.reason, c.at, c.by.id);
      writeAudit(ctx, staffActor(c.by), c.available ? 'menu.item_restocked' : 'menu.item_sold_out', { type: 'menu_item', id: c.itemId }, c.at, { reason: c.auditReason });
    }
  }

  // People also look at the menu from home, including on closed days.
  if (instrumented) {
    const n = isoWeekday(date) === 2 ? analytics.r.int(0, 1) : analytics.r.int(1, 4);
    for (let i = 0; i < n; i++) writePublicSession(analytics, date);
    result.publicSessions += n;
  }
}

export async function seedHistory(input: HistoryInput, opts: { from: string; to: string; instrumentationFrom: string }): Promise<HistoryResult> {
  const result: HistoryResult = { days: 0, openDays: 0, visits: 0, turnedAway: 0, orders: 0, publicSessions: 0, diningSessions: 0 };
  if (opts.to < opts.from) return result;
  const av = staticAvailability(input.model, bangkokMs(opts.from, 0));
  const feedbackFixture = hasColumn('feedback', 'is_fixture');
  tx(() => staticSpells(input, av, opts.from, opts.to));

  let date = opts.from;
  while (date <= opts.to) {
    const month = date.slice(0, 7);
    tx(() => {
      while (date <= opts.to && date.slice(0, 7) === month) {
        simulateDay(input, av, date, date >= opts.instrumentationFrom, feedbackFixture, result);
        date = addDays(date, 1);
      }
    });
    await yieldToLoop();
  }
  return result;
}
