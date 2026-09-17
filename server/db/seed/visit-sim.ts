// One fixture day: plan dining visits, play their rounds in time order,
// resolve portions, service requests and checkout, then seat them at tables.
//
// The phases matter:
//   1. plan      - seat times, devices, round times and sizes (no dishes yet)
//   2. play      - every round and portion request across the day in time
//                  order, so a dish that sells out at 19:10 is rejected for the
//                  first order after that and never ordered again that night
//   3. checkout  - bill request, billing, revisions, cash payment, close
//   4. seat      - tables assigned in seating order; a visit that finds no free
//                  table is dropped, so no table ever holds two visits at once
import { measuredAmount } from '../../../shared/money.ts';
import type { LineStatus } from '../../../shared/status.ts';
import { looksLikeAllergyNote } from '../../domain/pricing.ts';
import { pickItem, nextMorning, type Availability, type Course, type MenuModel, type ModelItem } from './menu-model.ts';
import {
  cashTendered, finalStatus, guestActor, isChargeableStatus, lineEnd, newReference, portionLine, pricedLine, revisionTotals, staffActor,
  type ActorRef, type SeedCtx, type SimAdjustment, type SimGuest, type SimLine, type SimOrder, type SimPayment,
  type SimPortion, type SimQuote, type SimRevision, type SimService, type SimVisit, type Step,
} from './records.ts';
import type { SeedStaff, StaffByRole } from './staff.ts';
import type { SeedTable } from './tables.ts';
import { bangkokMs, MINUTE, type Rng } from './util.ts';

// ------------------------------------------------------------------ fixture wording
const DRINK_NOTES = ['no ice', 'น้ำแข็งน้อย', 'หวานน้อย', 'less sweet'];
const FOOD_NOTES = ['ไม่เผ็ด', 'sauce on the side', 'ไม่ใส่ผักชี', 'แยกซอส', 'no chili'];
const SOLD_OUT_REASON = 'Sold out tonight';
const DUPLICATE_REASON = 'Duplicate of the previous round (checked with the table)';
const OTHER_REJECT_REASONS = ['Kitchen cannot make this right now', 'Ingredient ran short - staff offered an alternative'];
const CHANGED_MIND = 'Guest changed their mind';
const CANCEL_REASONS = [CHANGED_MIND, CHANGED_MIND, 'Taking too long - guest cancelled', 'Entered twice by mistake', 'Kitchen ran out after accepting'];
const COMP_REASONS = ['Comp: long wait for mains', 'Comp: dish sent back to the kitchen'];
const BILL_HANDLED_AT_CHECKOUT = 'Bill handled at checkout';
const DECLINED_BY_GUEST = 'Declined by guest';
const LATE_ROUND_REASON = 'Guest ordered one more round after the bill was printed';
const EXCEPTION_REASONS = ['Guest left without paying - reported to the owner', 'Settlement to be confirmed with the owner next day'];
const RATINGS = [5, 4, 3, 2, 1];
const RATING_WEIGHTS = [55, 30, 10, 3, 2];

// ------------------------------------------------------------------ day state
export interface RunOut {
  item: ModelItem;
  /** Local time from which the kitchen has none left. */
  at: number;
  triggered: boolean;
}

export interface AvailabilityChange {
  itemId: string;
  available: boolean;
  reason: string;
  at: number;
  by: SeedStaff;
  auditReason: string;
}

export interface DayEnv {
  r: Rng;
  date: string;
  ctx: SeedCtx;
  model: MenuModel;
  av: Availability;
  staff: StaffByRole;
  runOut: RunOut | null;
  availabilityChanges: AvailabilityChange[];
}

export interface VisitSim {
  visit: SimVisit;
  planned: number; // planned stay, minutes
  evening: boolean;
  guests: SimGuest[];
  orders: SimOrder[];
  portions: SimPortion[];
  services: SimService[];
  revisions: SimRevision[];
  adjustments: SimAdjustment[];
  payment: SimPayment | null;
  bill: { id: string; status: 'open' | 'finalized' | 'settled'; created: number; updated: number; version: number } | null;
  feedback: Array<{ guest: SimGuest; at: number; rating: number; key: string }>;
  /** Routine audit rows are written for a sample of visits only (exceptions always). */
  sampled: boolean;
  audits: Array<{ actor: ActorRef; action: string; type: string; id: string | null; at: number; reason?: string | null; after?: unknown }>;
  plan: { rounds: RoundPlan[]; call: number | null; allergyHelp: number | null; portion: number | null; billRequest: boolean };
}

interface RoundPlan {
  at: number;
  guest: SimGuest | null;
  lines: number;
  index: number;
  duplicateOf?: SimOrder;
  replacement?: Course;
  late?: boolean;
}

type QueueEntry =
  | { at: number; kind: 'round'; vs: VisitSim; plan: RoundPlan }
  | { at: number; kind: 'portion'; vs: VisitSim };

const min = (m: number) => m * MINUTE;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function pickStaff(r: Rng, staff: StaffByRole, weights: Partial<Record<keyof StaffByRole, number>>): SeedStaff {
  const roles = Object.keys(weights) as Array<keyof StaffByRole>;
  return staff[r.weighted(roles, (role) => weights[role] ?? 0)];
}

const step = (status: LineStatus, at: number, actor: ActorRef, kind: Step['kind'] = 'forward', reason: string | null = null): Step =>
  ({ status, at, kind, actor, reason });

// ------------------------------------------------------------------ phase 1: plan
function seatMinutes(r: Rng): number {
  const u = r.next();
  let m: number;
  if (u < 0.38) m = r.normal(12 * 60 + 40, 45);
  else if (u < 0.9) m = r.normal(18 * 60 + 40, 55);
  else m = r.between(14 * 60, 17 * 60 + 30);
  return clamp(Math.round(m), 11 * 60, 20 * 60 + 30);
}

function coversFor(r: Rng): number | null {
  if (!r.chance(0.8)) return null;
  return r.weighted([1, 2, 3, 4, 5, 6, 7, 8], (n) => [8, 40, 18, 20, 6, 5, 2, 1][n - 1]);
}

export function planDay(env: DayEnv, count: number): VisitSim[] {
  const { r, staff } = env;
  const sims: VisitSim[] = [];
  const seats = Array.from({ length: count }, () => seatMinutes(r)).sort((a, b) => a - b);
  for (const minutes of seats) {
    const seated = bangkokMs(env.date, minutes) + r.int(0, 59) * 1000;
    const planned = clamp(Math.round(r.normal(80, 18)), 54, 116);
    const visit: SimVisit = {
      id: r.id('vis'), table: null, status: 'closed', seated, covers: coversFor(r),
      opened_by: pickStaff(r, staff, { floor: 70, cashier: 20, manager: 10 }).id,
      join_pin: null, bill_requested_at: null, billing_started_at: null, billing_started_by: null,
      closed_at: null, closed_by: null, close_exception: null, version: 1,
    };
    const vs: VisitSim = {
      visit, planned, evening: minutes >= 17 * 60, guests: [], orders: [], portions: [], services: [],
      revisions: [], adjustments: [], payment: null, bill: null, feedback: [],
      sampled: r.chance(0.03), audits: [],
      plan: { rounds: [], call: null, allergyHelp: null, portion: null, billRequest: false },
    };

    // devices that joined (15% of visits are ordered entirely through staff)
    const devices = r.chance(0.15) ? 0 : r.weighted([1, 2, 3], (n) => [62, 30, 8][n - 1]);
    let joined = seated + r.between(0.5, 4) * MINUTE;
    for (let g = 1; g <= devices; g++) {
      vs.guests.push({
        id: r.id('gst'), visit_id: visit.id, guest_no: g, joined, last_seen: joined,
        locale: r.chance(0.68) ? 'th' : 'en', analytics_id: null,
      });
      joined += r.between(0.5, 6) * MINUTE;
    }

    // rounds: when, by whom, how many lines
    const rounds = r.weighted([1, 2, 3], (n) => [45, 40, 15][n - 1]);
    const firstGuest = vs.guests[0] ?? null;
    let at = firstGuest ? firstGuest.joined + r.between(2, 9) * MINUTE : seated + r.between(3, 10) * MINUTE;
    const lastRoundBy = seated + min(planned - 30);
    for (let i = 0; i < rounds; i++) {
      if (i > 0) at += r.between(12, 35) * MINUTE;
      if (i > 0 && at > lastRoundBy) break;
      const byGuest = vs.guests.length > 0 && r.chance(0.88);
      const guest = byGuest ? (i === 0 ? firstGuest : r.pick(vs.guests)) : null;
      // a guest can only order after joining
      const when = guest ? Math.max(at, guest.joined + 45_000) : at;
      const lines = i === 0 ? r.weighted([1, 2, 3, 4, 5], (n) => [14, 30, 28, 17, 11][n - 1]) : r.weighted([1, 2, 3], (n) => [50, 35, 15][n - 1]);
      vs.plan.rounds.push({ at: when, guest, lines, index: i });
    }
    const firstRound = vs.plan.rounds[0].at;
    if (env.model.primeRib && r.chance(0.09)) vs.plan.portion = firstRound + r.between(1, 6) * MINUTE;
    if (r.chance(0.2)) vs.plan.call = seated + r.between(5, Math.max(6, planned - 25)) * MINUTE;
    if (vs.guests.length > 0 && r.chance(0.02)) vs.plan.allergyHelp = vs.guests[0].joined + r.between(0.5, 2) * MINUTE;
    vs.plan.billRequest = vs.guests.length > 0 && r.chance(0.55);
    sims.push(vs);
  }
  return sims;
}

// ------------------------------------------------------------------ phase 2: play rounds in time order
function drinkCourse(r: Rng, evening: boolean): Course {
  return r.chance(evening ? 0.2 : 0.06) ? 'alcohol' : 'drink';
}

function chooseCourses(r: Rng, n: number, first: boolean, evening: boolean): Course[] {
  const out: Course[] = [];
  if (first) {
    if (n >= 2) out.push(drinkCourse(r, evening), 'main');
    while (out.length < n) {
      const hasMain = out.includes('main');
      const c = r.weighted<Course>(['main', 'starter', 'side', 'drink'], (k) => ({ main: 30, starter: 22, side: hasMain ? 18 : 0, drink: 30 } as Record<string, number>)[k]);
      out.push(c === 'drink' ? drinkCourse(r, evening) : c);
    }
  } else {
    while (out.length < n) {
      const c = r.weighted<Course>(['drink', 'dessert', 'side', 'starter', 'main'], (k) => ({ drink: 50, dessert: 25, side: 10, starter: 10, main: 5 } as Record<string, number>)[k]);
      out.push(c === 'drink' ? drinkCourse(r, evening) : c);
    }
  }
  return out;
}

function quantityFor(r: Rng, course: Course): number {
  if (course === 'alcohol') return r.weighted([1, 2, 3], (n) => [55, 30, 15][n - 1]);
  if (course === 'drink') return r.weighted([1, 2, 3], (n) => [60, 28, 12][n - 1]);
  return r.weighted([1, 2, 3], (n) => [75, 20, 5][n - 1]);
}

function noteFor(r: Rng, item: ModelItem): string | null {
  if (!r.chance(0.04)) return null;
  return r.pick(item.station === 'bar' ? DRINK_NOTES : FOOD_NOTES);
}

function newOrder(env: DayEnv, vs: SimVisit, source: SimOrder['source'], guest: SimGuest | null, staffId: string | null, at: number): SimOrder {
  const { r } = env;
  return {
    id: r.id('ord'), reference: newReference(env.ctx, r), visit: vs, round_no: 0, source,
    guest, staff_id: staffId, key: `att_${r.chars(24)}`,
    locale: guest?.locale ?? 'th', at, lines: [], duplicate: false,
  };
}

type LineFate = { kind: 'normal' } | { kind: 'reject'; reason: string } | { kind: 'cancel'; reason: string };

/** Add the accepted -> served (or rejected / cancelled) journey to a submitted line. */
function playLine(env: DayEnv, vs: VisitSim, line: SimLine, acceptAt: number, acceptor: SeedStaff, fate: LineFate): void {
  const { r, staff } = env;
  if (fate.kind === 'reject') {
    line.steps.push(step('rejected', acceptAt, staffActor(acceptor), 'reject', fate.reason));
    vs.audits.push({ actor: staffActor(acceptor), action: 'order.lines_rejected', type: 'order_line', id: line.id, at: acceptAt, reason: fate.reason });
    return;
  }
  const kitchen = line.item.station === 'kitchen';
  line.steps.push(step('accepted', acceptAt, staffActor(acceptor)));
  const prepStart = acceptAt + (kitchen ? r.between(0.5, 5) : r.between(0.2, 3)) * MINUTE;
  const readyAt = prepStart + r.between(line.item.cook[0], line.item.cook[1]) * MINUTE;
  const preparer = staffActor(kitchen ? staff.kitchen : staff.floor);

  if (fate.kind === 'cancel') {
    if (r.chance(0.5)) {
      const at = r.between(acceptAt + 15_000, Math.max(acceptAt + 20_000, prepStart));
      line.steps.push(step('cancelled', at, staffActor(staff.floor), 'cancel', fate.reason));
      vs.audits.push({ actor: staffActor(staff.floor), action: 'order.lines_cancelled', type: 'order_line', id: line.id, at, reason: fate.reason });
    } else {
      line.steps.push(step('preparing', prepStart, preparer));
      const at = r.between(prepStart + 30_000, Math.max(prepStart + 40_000, readyAt - 30_000));
      line.steps.push(step('cancelled', at, staffActor(staff.manager), 'cancel', fate.reason));
      vs.audits.push({ actor: staffActor(staff.manager), action: 'order.lines_cancelled', type: 'order_line', id: line.id, at, reason: fate.reason });
    }
    if (fate.reason === CHANGED_MIND) {
      const at = lineEnd(line);
      const asked = at - r.between(1, 3) * MINUTE;
      const guest = vs.guests.length ? r.pick(vs.guests) : null;
      vs.services.push(service(env, vs, 'order_change', Math.max(asked, line.steps[0].at + 10_000), guest, at));
    }
    return;
  }

  line.steps.push(step('preparing', prepStart, preparer));
  if (kitchen && line.item.prep_kind === 'cook' && r.chance(0.3)) {
    line.steps.push(step('almost_done', prepStart + (readyAt - prepStart) * r.between(0.72, 0.9), preparer));
  }
  line.steps.push(step('ready', readyAt, preparer));
  const server = pickStaff(r, staff, { floor: 80, cashier: 20 });
  line.steps.push(step('served', readyAt + r.between(0.5, 4) * MINUTE, staffActor(server)));
}

function playRound(env: DayEnv, vs: VisitSim, plan: RoundPlan, queue: QueueEntry[]): void {
  const { r, staff, model, av } = env;
  const at = plan.at;
  const staffRound = plan.guest === null;
  const author = staffRound ? pickStaff(r, staff, { floor: 70, cashier: 20, manager: 10 }) : null;
  const order = newOrder(env, vs.visit, staffRound ? 'staff' : 'guest', plan.guest, author?.id ?? null, at);
  const submitter: ActorRef = plan.guest ? guestActor(plan.guest) : staffActor(author!);
  const acceptAt = at + clamp(Math.exp(r.normal(Math.log(100), 0.6)), 30, 360) * 1000;
  const acceptor = pickStaff(r, staff, { kitchen: 55, floor: 35, manager: 10 });

  // ---- choose dishes
  if (plan.duplicateOf) {
    order.duplicate = true;
    for (const src of plan.duplicateOf.lines) {
      const line = pricedLine(r, src.item, {
        line_no: src.line_no, quantity: src.quantity, variant: src.variant, blend: src.blend,
        note: src.note, allergy: src.allergy, submitted: step('submitted', at, submitter),
      });
      playLine(env, vs, line, acceptAt, acceptor, { kind: 'reject', reason: DUPLICATE_REASON });
      order.lines.push(line);
    }
    vs.orders.push(order);
    return;
  }

  const courses = plan.replacement ? [plan.replacement] : chooseCourses(r, plan.lines, plan.index === 0, vs.evening);
  const used = new Set<string>();
  let exception = false;
  for (const course of courses) {
    const item = pickItem(r, model, av, course, at, used) ?? pickItem(r, model, av, 'drink', at, used);
    if (!item) continue;
    used.add(item.id);
    const variant = item.variants.length ? r.weighted(item.variants, (v) => (v.key === 'iced' ? 3 : 1)) : null;
    const note = noteFor(r, item);
    const line = pricedLine(r, item, {
      line_no: order.lines.length + 1, quantity: quantityFor(r, course), variant,
      blend: item.beans ? r.chance(0.2) : null,
      note, allergy: looksLikeAllergyNote(note), submitted: step('submitted', at, submitter),
    });
    order.lines.push(line);

    let fate: LineFate = { kind: 'normal' };
    const ro = env.runOut;
    if (ro && !plan.late && ro.item.id === item.id && !ro.triggered && at >= ro.at) {
      // First order after the kitchen ran out: rejected, and the dish is marked sold out.
      ro.triggered = true;
      fate = { kind: 'reject', reason: SOLD_OUT_REASON };
      const kitchen = staff.kitchen;
      const until = nextMorning(env.date);
      av.add(item.id, acceptAt, until);
      env.availabilityChanges.push({ itemId: item.id, available: false, reason: 'sold_out', at: acceptAt, by: kitchen, auditReason: SOLD_OUT_REASON });
      env.availabilityChanges.push({ itemId: item.id, available: true, reason: 'restocked', at: until, by: kitchen, auditReason: 'Restocked for the next service' });
      // the table orders something else instead
      const replacementAt = acceptAt + r.between(2, 6) * MINUTE;
      insertQueue(queue, { at: replacementAt, kind: 'round', vs, plan: { at: replacementAt, guest: plan.guest, lines: 1, index: plan.index + 1, replacement: course } });
      exception = true;
    } else if (!exception && courses.length >= 2 && !plan.late) {
      if (r.chance(0.012)) {
        fate = { kind: 'reject', reason: r.pick(OTHER_REJECT_REASONS) };
        exception = true;
      } else if (r.chance(0.018)) {
        fate = { kind: 'cancel', reason: r.pick(CANCEL_REASONS) };
        exception = true;
      }
    }
    playLine(env, vs, line, acceptAt, acceptor, fate);
  }
  if (order.lines.length === 0) return;
  vs.orders.push(order);
  if (vs.sampled) vs.audits.push({ actor: submitter, action: 'order.created', type: 'order', id: order.id, at, after: { reference: order.reference, lines: order.lines.length } });

  // an impatient double tap from a guest phone: a second identical round, rejected
  if (plan.guest && plan.index === 0 && !plan.replacement && r.chance(0.015)) {
    const dupAt = at + r.between(20, 60) * 1000;
    insertQueue(queue, { at: dupAt, kind: 'round', vs, plan: { at: dupAt, guest: plan.guest, lines: order.lines.length, index: plan.index, duplicateOf: order } });
  }
}

function service(env: DayEnv, vs: VisitSim, type: SimService['type'], created: number, guest: SimGuest | null, completeBy?: number): SimService {
  const { r, staff } = env;
  const handler = pickStaff(r, staff, { floor: 70, cashier: 30 });
  const ackAt = created + r.between(0.2, 3) * MINUTE;
  const doneAt = completeBy !== undefined ? Math.max(completeBy, ackAt + 10_000) : ackAt + r.between(0.5, 5) * MINUTE;
  return {
    id: r.id('svc'), visit: vs.visit, type, status: 'completed', guest,
    created_by_staff: guest ? null : handler.id, created,
    ack: { at: ackAt, by: handler.display_name }, done: { at: doneAt, by: handler.display_name }, cancelled: null,
    close_reason: null, key: `svc_${r.chars(20)}`,
  };
}

function quoteFor(env: DayEnv, item: ModelItem, revision: number, grams: number, at: number, by: SeedStaff, note: string | null): SimQuote {
  const { r } = env;
  const rate = item.rate_minor!;
  const basis = item.rate_basis_grams!;
  return {
    id: r.id('pqt'), revision, grams, rate_minor: rate, basis,
    amount_minor: measuredAmount(grams, rate, basis),
    note, created: at, expires: at + min(10), status: 'active', created_by: by.id,
    confirmed: null, order_line_id: null,
  };
}

/** Measured-weight cut: request -> quote(s) -> confirm / decline / cancel (brief 44A). */
function playPortion(env: DayEnv, vs: VisitSim, at: number): void {
  const { r, staff } = env;
  const item = env.model.primeRib!;
  const guest = vs.guests.length ? r.pick(vs.guests.filter((g) => g.joined < at).length ? vs.guests.filter((g) => g.joined < at) : vs.guests) : null;
  const requestAt = guest ? Math.max(at, guest.joined + 30_000) : at;
  const preferred = r.chance(0.4) ? r.pick([250, 300, 350, 400, 450, 500]) : null;
  const p: SimPortion = {
    id: r.id('por'), visit: vs.visit, item, guest,
    created_by_staff: guest ? null : staff.floor.id,
    preferred_grams: preferred, status: 'requested', created: requestAt, resolved: null,
    quotes: [], key: `por_${r.chars(20)}`, version: 1,
  };
  vs.portions.push(p);

  if (r.chance(0.03)) {
    p.status = 'cancelled';
    p.resolved = { at: requestAt + r.between(2, 6) * MINUTE, by: staff.floor.display_name, reason: 'Guest changed their mind before weighing' };
    p.version = 2;
    return;
  }
  const kitchen = staff.kitchen;
  let grams = preferred ? clamp(preferred + r.int(-4, 4) * 10, 250, 600) : r.int(25, 60) * 10;
  let quote = quoteFor(env, item, 1, grams, requestAt + r.between(3, 9) * MINUTE, kitchen, null);
  p.quotes.push(quote);
  p.status = 'quoted';
  if (r.chance(0.21)) {
    quote.status = 'superseded';
    grams = clamp(grams + r.pick([-1, 1]) * r.int(2, 6) * 10, 250, 600);
    quote = quoteFor(env, item, 2, grams, quote.created + r.between(1, 4) * MINUTE, kitchen, 'Re-weighed after trimming');
    p.quotes.push(quote);
  } else if (r.chance(0.05)) {
    quote.status = 'expired';
    quote = quoteFor(env, item, 2, grams, quote.expires + r.between(1, 3) * MINUTE, kitchen, 'Quoted again after the first quote expired');
    p.quotes.push(quote);
  }
  p.version = 1 + p.quotes.length;
  if (vs.sampled) vs.audits.push({ actor: staffActor(kitchen), action: 'portion.quote', type: 'portion_request', id: p.id, at: quote.created, after: { revision: quote.revision, grams } });

  const respondAt = quote.created + r.between(0.5, 6) * MINUTE;
  const decideAt = Math.min(respondAt, quote.expires - 10_000);
  if (r.chance(0.15)) {
    quote.status = 'withdrawn';
    p.status = 'declined';
    p.resolved = { at: decideAt, by: guest ? guestActor(guest).label : staff.floor.display_name, reason: DECLINED_BY_GUEST };
    p.version++;
    return;
  }
  const inPerson = !guest || r.chance(0.15);
  const confirmer = staff.floor;
  quote.status = 'confirmed';
  quote.confirmed = {
    at: decideAt, via: inPerson ? 'in_person' : 'guest',
    guest_id: inPerson ? null : guest!.id, staff_id: inPerson ? confirmer.id : null,
    key: `pcf_${r.chars(20)}`,
  };
  p.status = 'confirmed';
  p.resolved = { at: decideAt, by: inPerson ? confirmer.display_name : guestActor(guest!).label, reason: null };
  p.version++;
  if (inPerson) {
    vs.audits.push({ actor: staffActor(confirmer), action: 'portion.confirm_in_person', type: 'portion_request', id: p.id, at: decideAt, after: { revision: quote.revision, grams: quote.grams, amount_minor: quote.amount_minor } });
  }

  // Only confirmation creates the order line (D-08).
  const order = newOrder(env, vs.visit, 'portion_quote', inPerson ? null : guest, inPerson ? confirmer.id : null, decideAt);
  const submitter = inPerson ? staffActor(confirmer) : guestActor(guest!);
  const line = portionLine(r, item, quote, step('submitted', decideAt, submitter));
  quote.order_line_id = line.id;
  order.lines.push(line);
  const acceptor = pickStaff(r, staff, { kitchen: 80, manager: 20 });
  playLine(env, vs, line, decideAt + r.between(0.5, 4) * MINUTE, acceptor, { kind: 'normal' });
  vs.orders.push(order);
}

function insertQueue(queue: QueueEntry[], entry: QueueEntry): void {
  let lo = 0;
  let hi = queue.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (queue[mid].at <= entry.at) lo = mid + 1;
    else hi = mid;
  }
  queue.splice(lo, 0, entry);
}

export function playDay(env: DayEnv, sims: VisitSim[]): void {
  const queue: QueueEntry[] = [];
  for (const vs of sims) {
    for (const plan of vs.plan.rounds) insertQueue(queue, { at: plan.at, kind: 'round', vs, plan });
    if (vs.plan.portion !== null) insertQueue(queue, { at: vs.plan.portion, kind: 'portion', vs });
  }
  while (queue.length) {
    const next = queue.shift()!;
    if (next.kind === 'round') playRound(env, next.vs, next.plan, queue);
    else playPortion(env, next.vs, next.at);
  }
}

// ------------------------------------------------------------------ phase 3: checkout
function lastActivity(vs: VisitSim): number {
  let last = vs.visit.seated;
  for (const o of vs.orders) for (const l of o.lines) last = Math.max(last, lineEnd(l));
  for (const p of vs.portions) last = Math.max(last, p.resolved?.at ?? p.created);
  for (const s of vs.services) last = Math.max(last, s.done?.at ?? s.created);
  return last;
}

function revision(env: DayEnv, vs: VisitSim, no: number, at: number, by: SeedStaff): SimRevision {
  const lines: SimLine[] = [];
  const orders = new Map<string, SimOrder>();
  for (const o of [...vs.orders].sort((a, b) => a.at - b.at)) {
    for (const l of o.lines) {
      if (l.steps[0].at > at) continue;
      lines.push(l);
      orders.set(l.id, o);
    }
  }
  return {
    id: env.r.id('rev'), revision_no: no, status: 'payable', finalized: at, finalized_by: by.id,
    superseded: null, lines, orders, adjustments: vs.adjustments.filter((a) => a.at <= at),
  };
}

export function checkoutVisit(env: DayEnv, vs: VisitSim, queueLate: (vs: VisitSim, at: number) => void): void {
  const { r, staff } = env;
  const v = vs.visit;

  // guest help requests during the meal
  if (vs.plan.allergyHelp !== null) vs.services.push(service(env, vs, 'allergy_help', vs.plan.allergyHelp, vs.guests[0] ?? null));
  if (vs.plan.call !== null) {
    const guest = vs.guests.length ? r.pick(vs.guests) : null;
    const s = service(env, vs, 'call_staff', vs.plan.call, guest);
    if (r.chance(0.015)) {
      s.status = 'cancelled';
      s.cancelled = { at: s.ack!.at + r.between(0.5, 3) * MINUTE, by: s.ack!.by };
      s.done = null;
      s.close_reason = 'Guest no longer needed help';
    }
    vs.services.push(s);
  }

  let foodDone = lastActivity(vs);
  const cashier = () => pickStaff(r, staff, { cashier: 85, manager: 15 });
  const tailStart = Math.max(foodDone + r.between(3, 12) * MINUTE, v.seated + min(vs.planned - 9));

  let billReq: SimService | null = null;
  if (vs.plan.billRequest) {
    const guest = r.pick(vs.guests);
    billReq = service(env, vs, 'bill', tailStart, guest);
    v.bill_requested_at = tailStart;
    vs.services.push(billReq);
  }
  let billingStart = tailStart + (billReq ? r.between(1, 4) : r.between(0, 3)) * MINUTE;
  let starter = pickStaff(r, staff, { cashier: 70, floor: 30 });
  // Staff either tick the bill request off when they start checkout, or checkout closes it (S4 wording).
  const billAtCheckout = billReq !== null && r.chance(0.5);
  if (billReq) billReq.done = { at: billingStart, by: starter.display_name };

  vs.bill = { id: r.id('bil'), status: 'finalized', created: billingStart, updated: billingStart, version: 2 };
  let finalizer = cashier();
  let finalized = billingStart + r.between(0.5, 2.5) * MINUTE;
  let rev = revision(env, vs, 1, finalized, finalizer);
  vs.revisions.push(rev);
  if (vs.sampled) {
    vs.audits.push({ actor: staffActor(starter), action: 'visit.billing_start', type: 'visit', id: v.id, at: billingStart });
    vs.audits.push({ actor: staffActor(finalizer), action: 'bill.finalize', type: 'bill', id: vs.bill.id, at: finalized, after: { revision_no: 1, total_minor: revisionTotals(rev).total } });
  }

  // manager exception: closed unpaid, with a reason (0.5%)
  if (r.chance(0.005)) {
    const manager = staff.manager;
    const closeAt = finalized + r.between(5, 20) * MINUTE;
    const reason = r.pick(EXCEPTION_REASONS);
    Object.assign(v, { billing_started_at: billingStart, billing_started_by: starter.id, closed_at: closeAt, closed_by: manager.id, close_exception: reason, version: v.version + 4 });
    vs.bill.updated = finalized;
    vs.audits.push({ actor: staffActor(manager), action: 'visit.close_exception', type: 'visit', id: v.id, at: closeAt, reason, after: { unpaid_minor: revisionTotals(rev).total } });
    return;
  }

  // a superseded first revision (2.5%): a comp, or one more round after the bill was printed
  if (r.chance(0.025)) {
    const manager = staff.manager;
    const reopenAt = finalized + r.between(1, 4) * MINUTE;
    const chargeable = rev.lines.filter((l) => isChargeableStatus(finalStatus(l)));
    if (r.chance(0.6) && chargeable.length > 0) {
      const target = chargeable.reduce((a, b) => (b.line_total_minor < a.line_total_minor ? b : a));
      const reason = r.pick(COMP_REASONS);
      rev.status = 'superseded';
      rev.superseded = { at: reopenAt, by: manager.id, reason: 'Reopened to apply a comp' };
      const adj: SimAdjustment = { id: r.id('adj'), kind: 'comp', amount_minor: -target.line_total_minor, reason, line_id: target.id, by: manager.id, at: reopenAt + 30_000 };
      vs.adjustments.push(adj);
      vs.audits.push({ actor: staffActor(manager), action: 'bill.reopen', type: 'bill', id: vs.bill.id, at: reopenAt, reason: rev.superseded.reason });
      vs.audits.push({ actor: staffActor(manager), action: 'bill.adjust', type: 'bill_adjustment', id: adj.id, at: adj.at, reason, after: { kind: adj.kind, amount_minor: adj.amount_minor } });
      // reopening sends the visit back to open; checkout starts again after the comp
      billingStart = adj.at + r.between(0.2, 1) * MINUTE;
      finalizer = manager;
      finalized = billingStart + r.between(0.5, 2) * MINUTE;
    } else {
      rev.status = 'superseded';
      rev.superseded = { at: reopenAt, by: manager.id, reason: LATE_ROUND_REASON };
      vs.audits.push({ actor: staffActor(manager), action: 'bill.reopen', type: 'bill', id: vs.bill.id, at: reopenAt, reason: LATE_ROUND_REASON });
      queueLate(vs, reopenAt + r.between(1, 3) * MINUTE);
      foodDone = lastActivity(vs);
      billingStart = foodDone + r.between(2, 6) * MINUTE;
      starter = pickStaff(r, staff, { cashier: 70, floor: 30 });
      finalizer = cashier();
      finalized = billingStart + r.between(0.5, 2) * MINUTE;
    }
    rev = revision(env, vs, 2, finalized, finalizer);
    vs.revisions.push(rev);
    vs.bill.version += 2;
  }

  // cash settlement of the payable revision
  const total = revisionTotals(rev).total;
  const payer = cashier();
  const paidAt = finalized + r.between(1, 6) * MINUTE;
  const tendered = cashTendered(r, total);
  vs.payment = { id: r.id('pay'), revision_id: rev.id, amount_minor: total, tendered_minor: tendered, change_minor: tendered - total, by: payer.id, at: paidAt, key: `pay_${r.chars(20)}` };
  rev.status = 'settled';
  vs.bill.status = 'settled';
  vs.bill.updated = paidAt;
  vs.bill.version += 1;
  const closeAt = paidAt + r.between(0.5, 2) * MINUTE;
  if (billReq && billAtCheckout) {
    // Half were never acknowledged: checkout closed them straight from "sent" (no staff response time).
    billReq.ack = r.chance(0.5) ? { at: Math.min(billReq.ack!.at, billingStart), by: billReq.ack!.by } : null;
    billReq.done = { at: closeAt, by: payer.display_name };
    billReq.close_reason = BILL_HANDLED_AT_CHECKOUT;
  }
  Object.assign(v, { billing_started_at: billingStart, billing_started_by: starter.id, closed_at: closeAt, closed_by: payer.id, version: v.version + 4 });

  for (const g of vs.guests) {
    if (r.chance(0.07)) {
      vs.feedback.push({ guest: g, at: r.between(finalized, paidAt), rating: r.weighted(RATINGS, (n) => RATING_WEIGHTS[RATINGS.indexOf(n)]), key: `fbk_${r.chars(20)}` });
    }
    g.last_seen = Math.max(g.last_seen, closeAt - r.between(1, 5) * MINUTE, g.joined);
  }
  if (vs.sampled) {
    vs.audits.push({ actor: staffActor(payer), action: 'payment.confirm', type: 'payment', id: vs.payment.id, at: paidAt, after: { amount_minor: total, method: 'cash' } });
    vs.audits.push({ actor: staffActor(payer), action: 'visit.checkout', type: 'visit', id: v.id, at: closeAt });
  }
}

/** Play a round added during checkout (after the bill was reopened). */
export function playLateRound(env: DayEnv, vs: VisitSim, at: number): void {
  const guest = vs.guests.length && env.r.chance(0.7) ? env.r.pick(vs.guests) : null;
  playRound(env, vs, { at, guest, lines: env.r.int(1, 2), index: 1, late: true }, []);
}

/** Number rounds by submission time, and track each guest's last activity. */
export function finishVisit(vs: VisitSim): void {
  vs.orders.sort((a, b) => a.at - b.at);
  vs.orders.forEach((o, i) => { o.round_no = i + 1; });
  for (const o of vs.orders) if (o.guest) o.guest.last_seen = Math.max(o.guest.last_seen, o.at);
}

// ------------------------------------------------------------------ phase 4: seat at tables
export function seatVisits(env: DayEnv, sims: VisitSim[], tables: SeedTable[]): VisitSim[] {
  const { r } = env;
  const freeAt = new Map<string, number>(tables.map((t) => [t.id, 0]));
  const kept: VisitSim[] = [];
  for (const vs of [...sims].sort((a, b) => a.visit.seated - b.visit.seated)) {
    const free = tables.filter((t) => freeAt.get(t.id)! <= vs.visit.seated);
    if (free.length === 0) continue; // the dining room is full: this party never sat down
    const table = r.pick(free);
    vs.visit.table = table;
    freeAt.set(table.id, (vs.visit.closed_at ?? vs.visit.seated) + r.between(3, 10) * MINUTE);
    kept.push(vs);
  }
  return kept;
}
