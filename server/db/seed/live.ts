// "Right now" fixtures so the staff screens look alive on the first run:
// tables dining with rounds in every state, a table checking out with a
// finalized unpaid bill, a bill request, open service requests, one Prime Rib
// portion waiting to be weighed and one with an active quote, and a disabled
// table. Every row is is_fixture = 1. Times are relative to the seed moment.
import { newJoinPin, newSecret } from '../../../shared/ids.ts';
import type { LineStatus } from '../../../shared/status.ts';
import { measuredAmount } from '../../../shared/money.ts';
import { looksLikeAllergyNote } from '../../domain/pricing.ts';
import { sha256 } from '../../lib/http.ts';
import { getSettings } from '../../lib/settings.ts';
import { run } from '../index.ts';
import { writeDiningSession, type AnalyticsEnv } from './analytics.ts';
import type { Course, MenuModel, ModelItem } from './menu-model.ts';
import {
  guestActor, newReference, pricedLine, revisionTotals, staffActor, writeAudit, writeBill, writeGuest,
  writeOrder, writePortion, writeService, writeVisit,
  type ActorRef, type SeedCtx, type SimGuest, type SimLine, type SimOrder, type SimPortion, type SimQuote, type SimService, type SimVisit, type Step,
} from './records.ts';
import type { StaffByRole } from './staff.ts';
import type { SeedTable } from './tables.ts';
import { iso, MINUTE, type Rng } from './util.ts';
import { finishVisit, type VisitSim } from './visit-sim.ts';

type Stage = Exclude<LineStatus, 'rejected' | 'cancelled'>;
const PATH: Stage[] = ['submitted', 'accepted', 'preparing', 'almost_done', 'ready', 'served'];
const DEFAULT_GAP: Record<Stage, number> = { submitted: 0, accepted: 1.5, preparing: 1.5, almost_done: 8, ready: 10, served: 1.5 };

interface LineSpec {
  key: string;
  course: Course;
  qty?: number;
  variant?: string;
  blend?: boolean;
  note?: string;
  stage: Stage;
  /** Minutes ago for specific steps; others follow DEFAULT_GAP. */
  ago?: Partial<Record<Stage, number>>;
}

interface RoundSpec {
  ago: number;
  /** Index into the visit's guests, or null for a staff-entered round. */
  guest: number | null;
  lines: LineSpec[];
}

interface LiveInput {
  ctx: SeedCtx;
  r: Rng;
  model: MenuModel;
  staff: StaffByRole;
  tables: SeedTable[];
  now: number;
}

export interface LiveResult {
  pins: Array<{ table: string; pin: string; status: string }>;
  visits: number;
  orders: number;
  disabledTable: string;
}

export function seedLive(input: LiveInput): LiveResult {
  const { ctx, r, model, staff, tables, now } = input;
  const ago = (m: number) => now - Math.round(m * MINUTE);
  const table = (label: string) => {
    const t = tables.find((x) => x.label === label);
    if (!t) throw new Error(`live fixtures need table ${label}`);
    return t;
  };
  const item = (key: string, course: Course): ModelItem => {
    const found = model.byKey.get(key);
    if (found?.orderable) return found;
    const fallback = model.byCourse[course][0] ?? model.orderable[0];
    if (!fallback) throw new Error('live fixtures need at least one orderable item');
    return fallback;
  };
  const kitchen = staffActor(staff.kitchen);
  const floor = staffActor(staff.floor);
  const result: LiveResult = { pins: [], visits: 0, orders: 0, disabledTable: '12' };
  const analytics: AnalyticsEnv = { r, ctx, model };
  const measured = getSettings().analytics.enabled;

  function lineFrom(order: SimOrder, spec: LineSpec, submitter: ActorRef): SimLine {
    const it = item(spec.key, spec.course);
    const variant = it.variants.find((v) => v.key === spec.variant) ?? it.variants[0] ?? null;
    const note = spec.note ?? null;
    const line = pricedLine(r, it, {
      line_no: order.lines.length + 1, quantity: spec.qty ?? 1, variant, blend: it.beans ? spec.blend ?? false : null,
      note, allergy: looksLikeAllergyNote(note), submitted: { status: 'submitted', at: order.at, kind: 'forward', actor: submitter, reason: null },
    });
    const target = PATH.indexOf(spec.stage);
    const wantsAlmost = spec.stage === 'almost_done' || spec.ago?.almost_done !== undefined;
    let prev = order.at;
    for (let i = 1; i <= target; i++) {
      const status = PATH[i];
      if (status === 'almost_done' && !wantsAlmost) continue;
      const given = spec.ago?.[status];
      const at = Math.min(now - 5_000, Math.max(prev + 5_000, given !== undefined ? ago(given) : prev + DEFAULT_GAP[status] * MINUTE));
      const actor = status === 'accepted' ? floor : status === 'served' ? floor : it.station === 'kitchen' ? kitchen : floor;
      line.steps.push({ status, at, kind: 'forward', actor, reason: null } satisfies Step);
      prev = at;
    }
    return line;
  }

  function openVisit(label: string, spec: { seatedAgo: number; covers: number | null; guestsAgo: number[]; status?: 'open' | 'billing' }): VisitSim {
    const t = table(label);
    const visit: SimVisit = {
      id: r.id('vis'), table: t, status: spec.status ?? 'open', seated: ago(spec.seatedAgo), covers: spec.covers,
      opened_by: staff.floor.id, join_pin: newJoinPin(4),
      bill_requested_at: null, billing_started_at: null, billing_started_by: null,
      closed_at: null, closed_by: null, close_exception: null, version: 2,
    };
    const guests: SimGuest[] = spec.guestsAgo.map((m, i) => ({
      id: r.id('gst'), visit_id: visit.id, guest_no: i + 1, joined: ago(m), last_seen: ago(Math.max(0.2, m - 20)),
      locale: i % 2 === 0 ? 'th' : 'en', analytics_id: null,
    }));
    return {
      visit, planned: 90, evening: false, guests, orders: [], portions: [], services: [], revisions: [], adjustments: [],
      payment: null, bill: null, feedback: [], sampled: true, audits: [],
      plan: { rounds: [], call: null, allergyHelp: null, portion: null, billRequest: false },
    };
  }

  function addRound(vs: VisitSim, spec: RoundSpec): SimOrder {
    const guest = spec.guest === null ? null : vs.guests[spec.guest];
    const at = ago(spec.ago);
    const order: SimOrder = {
      id: r.id('ord'), reference: newReference(ctx, r), visit: vs.visit, round_no: 0,
      source: guest ? 'guest' : 'staff', guest, staff_id: guest ? null : staff.floor.id,
      key: `att_${r.chars(24)}`, locale: guest?.locale ?? 'th', at, lines: [], duplicate: false,
    };
    const submitter = guest ? guestActor(guest) : floor;
    for (const l of spec.lines) order.lines.push(lineFrom(order, l, submitter));
    vs.orders.push(order);
    return order;
  }

  function request(vs: VisitSim, type: SimService['type'], createdAgo: number, guest: number | null, ackAgo?: number): SimService {
    const s: SimService = {
      id: r.id('svc'), visit: vs.visit, type, status: ackAgo === undefined ? 'sent' : 'acknowledged',
      guest: guest === null ? null : vs.guests[guest], created_by_staff: guest === null ? staff.floor.id : null,
      created: ago(createdAgo), ack: ackAgo === undefined ? null : { at: ago(ackAgo), by: staff.floor.display_name },
      done: null, cancelled: null, close_reason: null, key: `svc_${r.chars(20)}`,
    };
    vs.services.push(s);
    return s;
  }

  function portion(vs: VisitSim, guest: number, createdAgo: number, preferred: number | null): SimPortion | null {
    if (!model.primeRib) return null;
    const p: SimPortion = {
      id: r.id('por'), visit: vs.visit, item: model.primeRib, guest: vs.guests[guest], created_by_staff: null,
      preferred_grams: preferred, status: 'requested', created: ago(createdAgo), resolved: null, quotes: [],
      key: `por_${r.chars(20)}`, version: 1,
    };
    vs.portions.push(p);
    return p;
  }

  const sims: VisitSim[] = [];

  // Table 01 - a brand-new round nobody has accepted yet.
  const t01 = openVisit('01', { seatedAgo: 8, covers: 2, guestsAgo: [7] });
  addRound(t01, { ago: 1.5, guest: 0, lines: [
    { key: 'australian-striploin', course: 'main', stage: 'submitted' },
    { key: 'french-fries', course: 'side', stage: 'submitted' },
    { key: 'latte', course: 'drink', qty: 2, variant: 'iced', stage: 'submitted' },
  ] });
  sims.push(t01);

  // Table 03 - mains on the grill (one with an allergy note), a live Prime Rib quote, a call for staff.
  const t03 = openVisit('03', { seatedAgo: 35, covers: 4, guestsAgo: [34, 31] });
  addRound(t03, { ago: 30, guest: 0, lines: [
    { key: 'coconut-water-fresh', course: 'drink', qty: 2, stage: 'served', ago: { accepted: 29, preparing: 28, ready: 24, served: 22 } },
    { key: 'corn-rib', course: 'starter', stage: 'served', ago: { accepted: 29, preparing: 27, ready: 17, served: 15 } },
    { key: 'grilled-pork-ribs', course: 'main', note: 'แพ้ถั่ว - allergic to peanuts', stage: 'preparing', ago: { accepted: 29, preparing: 20 } },
    { key: 'basil-beef-rice', course: 'main', stage: 'preparing', ago: { accepted: 29, preparing: 18 } },
  ] });
  const quoted = portion(t03, 1, 12, 400);
  if (quoted) {
    const grams = 420;
    const created = ago(2);
    const quote: SimQuote = {
      id: r.id('pqt'), revision: 1, grams, rate_minor: quoted.item.rate_minor!, basis: quoted.item.rate_basis_grams!,
      amount_minor: measuredAmount(grams, quoted.item.rate_minor!, quoted.item.rate_basis_grams!),
      note: null, created, expires: created + getSettings().portions.quote_expiry_minutes * MINUTE,
      status: 'active', created_by: staff.kitchen.id, confirmed: null, order_line_id: null,
    };
    quoted.quotes.push(quote);
    quoted.status = 'quoted';
    quoted.version = 2;
  }
  request(t03, 'call_staff', 1, 0);
  sims.push(t03);

  // Table 04 - second round nearly done: one almost-done line, two ready; an acknowledged change request.
  const t04 = openVisit('04', { seatedAgo: 55, covers: 3, guestsAgo: [53] });
  addRound(t04, { ago: 50, guest: 0, lines: [
    { key: 'thai-tea', course: 'drink', variant: 'iced', stage: 'served' },
    { key: 'cappuccino', course: 'drink', variant: 'hot', blend: true, stage: 'served' },
    { key: 'grilled-baby-chicken', course: 'main', stage: 'served' },
    { key: 'mashed-potato', course: 'side', stage: 'served' },
  ] });
  addRound(t04, { ago: 22, guest: null, lines: [
    { key: 'grilled-squid', course: 'main', stage: 'almost_done', ago: { accepted: 21, preparing: 18, almost_done: 2 } },
    { key: 'sauteed-mushrooms', course: 'side', stage: 'ready', ago: { accepted: 21, preparing: 17, ready: 1 } },
    { key: 'beer-singha', course: 'alcohol', qty: 2, stage: 'ready', ago: { accepted: 21, preparing: 5, ready: 3 } },
  ] });
  request(t04, 'order_change', 6, 0, 5);
  sims.push(t04);

  // Table 06 - a partially served round.
  const t06 = openVisit('06', { seatedAgo: 70, covers: 2, guestsAgo: [68, 60] });
  addRound(t06, { ago: 62, guest: 0, lines: [
    { key: 'orange-juice-fresh', course: 'drink', stage: 'served' },
    { key: 'grilled-pork', course: 'main', stage: 'served' },
    { key: 'grilled-fish', course: 'main', stage: 'served' },
  ] });
  addRound(t06, { ago: 20, guest: 1, lines: [
    { key: 'chocolate', course: 'drink', variant: 'iced', stage: 'served', ago: { accepted: 19, preparing: 17, ready: 13, served: 12 } },
    { key: 'creme-brulee-lemon', course: 'dessert', stage: 'ready', ago: { accepted: 19, preparing: 9, ready: 2 } },
    { key: 'grilled-caesar-salad', course: 'starter', stage: 'preparing', ago: { accepted: 19, preparing: 10 } },
  ] });
  sims.push(t06);

  // Table 07 - an accepted round not started yet, and a Prime Rib waiting to be weighed. No covers recorded.
  const t07 = openVisit('07', { seatedAgo: 25, covers: null, guestsAgo: [24] });
  addRound(t07, { ago: 18, guest: 0, lines: [
    { key: 'nashville-hot-chicken', course: 'starter', stage: 'accepted', ago: { accepted: 16 } },
    { key: 'grilled-fish', course: 'main', stage: 'accepted', ago: { accepted: 16 } },
    { key: 'pepsi-original', course: 'drink', qty: 2, stage: 'accepted', ago: { accepted: 16 } },
  ] });
  portion(t07, 0, 4, null);
  sims.push(t07);

  // Table 09 - finished eating and asked for the bill.
  const t09 = openVisit('09', { seatedAgo: 95, covers: 2, guestsAgo: [93] });
  addRound(t09, { ago: 88, guest: 0, lines: [
    { key: 'long-black', course: 'drink', variant: 'hot', stage: 'served' },
    { key: 'wagyu-tenderloin', course: 'main', stage: 'served' },
    { key: 'green-salad-balsamic', course: 'starter', stage: 'served' },
  ] });
  addRound(t09, { ago: 50, guest: 0, lines: [
    { key: 'tiramisu', course: 'dessert', qty: 2, stage: 'served' },
  ] });
  request(t09, 'bill', 3, 0);
  t09.visit.bill_requested_at = ago(3);
  sims.push(t09);

  // Table 10 - checking out: bill finalized, payment not yet taken.
  const t10 = openVisit('10', { seatedAgo: 105, covers: 4, guestsAgo: [103, 100] });
  addRound(t10, { ago: 98, guest: 0, lines: [
    { key: 'beer-chang-classic', course: 'alcohol', qty: 3, stage: 'served' },
    { key: 'grilled-river-prawns', course: 'main', stage: 'served' },
    { key: 'grilled-tongue', course: 'main', stage: 'served' },
    { key: 'fried-sweet-potato', course: 'starter', stage: 'served' },
  ] });
  addRound(t10, { ago: 55, guest: 1, lines: [
    { key: 'coconut-matcha', course: 'drink', variant: 'iced', qty: 2, stage: 'served' },
  ] });
  const billReq = request(t10, 'bill', 9, 1, 8);
  billReq.status = 'completed';
  billReq.done = { at: ago(6), by: staff.cashier.display_name };
  t10.visit.bill_requested_at = ago(9);
  t10.visit.status = 'billing';
  t10.visit.billing_started_at = ago(6);
  t10.visit.billing_started_by = staff.cashier.id;
  t10.visit.version = 4;
  sims.push(t10);

  // write
  for (const vs of sims) {
    finishVisit(vs);
    const v = vs.visit;
    writeVisit(ctx, v);
    for (const g of vs.guests) {
      if (measured) g.analytics_id = `ans_${r.chars(16)}`;
      writeGuest(ctx, g, sha256(newSecret(32)), null); // nobody holds these tokens
    }
    for (const o of vs.orders) writeOrder(ctx, o);
    for (const p of vs.portions) writePortion(ctx, p);
    for (const s of vs.services) writeService(ctx, s);
    writeAudit(ctx, staffActor(staff.floor), 'visit.opened', { type: 'visit', id: v.id, visit_id: v.id }, v.seated, { after: { table: v.table!.label, covers: v.covers } });
    for (const g of vs.guests) {
      if (g.analytics_id) writeDiningSession(analytics, vs, g, g.analytics_id, false, now);
    }
    result.pins.push({ table: v.table!.label, pin: v.join_pin!, status: v.status });
    result.visits++;
    result.orders += vs.orders.length;
  }

  // Table 10's payable revision (written after its lines exist).
  const finalizedAt = ago(5);
  const rev = {
    id: r.id('rev'), revision_no: 1, status: 'payable' as const, finalized: finalizedAt, finalized_by: staff.cashier.id,
    superseded: null, lines: t10.orders.flatMap((o) => o.lines), adjustments: [],
    orders: new Map(t10.orders.flatMap((o) => o.lines.map((l) => [l.id, o] as const))),
  };
  const billId = r.id('bil');
  writeBill(ctx, t10.visit, { id: billId, status: 'finalized', created: ago(6), updated: finalizedAt, version: 2 }, [rev]);
  writeAudit(ctx, staffActor(staff.cashier), 'visit.billing_start', { type: 'visit', id: t10.visit.id, visit_id: t10.visit.id }, ago(6));
  writeAudit(ctx, staffActor(staff.cashier), 'bill.finalize', { type: 'bill', id: billId, visit_id: t10.visit.id }, finalizedAt, { after: { revision_no: 1, total_minor: revisionTotals(rev).total } });

  // Table 12 is switched off (e.g. being repaired) - shows the Disabled state.
  const disabled = table(result.disabledTable);
  run(`UPDATE dining_tables SET enabled = 0, updated_at = :at, version = version + 1 WHERE id = :id`, { id: disabled.id, at: iso(now) });
  writeAudit(ctx, staffActor(staff.manager), 'table.updated', { type: 'table', id: disabled.id }, now, { reason: 'Demo fixture: table out of service', before: { enabled: true }, after: { enabled: false } });
  return result;
}

