// Measured-weight portions (brief 44A, 44F; D-08).
//
// A cut priced by weight (prime rib: a rate per 100 g) is never a cart line.
// The guest - or staff on their behalf - requests a portion; staff weigh it
// and quote it; only the guest's confirmation, or staff recording that the
// guest confirmed in person, creates the ONE order line through S3's
// createOrder(). Until then nothing is an order: nothing reaches the kitchen
// board, nothing counts as sold, nothing is on the bill.
//
//   requested --quote--> quoted --confirm--------------> confirmed (order line)
//       ^                 |   \--decline--> declined
//       |                 |----cancel----> cancelled      (also from requested)
//       +---- expiry -----+
//
// Every quote is a numbered revision holding its own snapshot (grams, the
// item's rate at that moment, choices, amount). A new quote supersedes the
// active one, so a changed weight, rate or choice always needs a fresh
// confirmation. The guest can never supply the weight, the rate or the amount.
import type { Bilingual, PortionQuoteDTO, PortionRequestDTO } from '../../shared/dto.ts';
import { newId } from '../../shared/ids.ts';
import { measuredAmount, type Minor } from '../../shared/money.ts';
import type { CartLineInput } from '../../shared/schemas.ts';
import type { PortionRequestStatus, QuoteStatus } from '../../shared/status.ts';
import { businessDate, nowIso } from '../../shared/time.ts';
import { insert, isConstraintError, many, one, run, tx, updateVersioned } from '../db/index.ts';
import { audit, SYSTEM, type Actor } from '../lib/audit.ts';
import { AppError, staleVersion } from '../lib/errors.ts';
import { emit } from '../lib/events.ts';
import { payloadHash } from '../lib/http.ts';
import { cutoffHour, fixtureFlag, getSettings } from '../lib/settings.ts';
import { assertCanOrder, getVisit } from './guards.ts';
import { createOrder } from './orders.ts';
import {
  bi, getCategory, getItem, itemVariants, looksLikeAllergyNote, prepKind, priceCart, unavailableReason,
  type GroupRow, type ItemRow, type OptionRow, type PricedLine, type PricedModifierGroup,
} from './pricing.ts';

// ------------------------------------------------------------------ rows
export interface PortionRequestRow {
  id: string; visit_id: string; table_id: string; item_id: string;
  guest_session_id: string | null; created_by_staff: string | null;
  preferred_grams: number | null; note: string | null;
  status: PortionRequestStatus; idempotency_key: string;
  created_at: string; business_date: string;
  resolved_at: string | null; resolved_by: string | null; resolution_reason: string | null;
  is_fixture: number; updated_at: string; version: number;
}

export interface PortionQuoteRow {
  id: string; request_id: string; revision: number;
  grams: number; rate_minor: number; rate_basis_grams: number; amount_minor: number;
  choices_json: string; note: string | null; expires_at: string; status: QuoteStatus;
  created_by: string; created_at: string;
  confirmed_at: string | null; confirmed_via: 'guest' | 'in_person' | null;
  confirmed_guest_session_id: string | null; confirmed_staff_id: string | null;
  confirm_idempotency_key: string | null; order_line_id: string | null;
}

/** Stored in portion_quotes.choices_json: the picks with names and charged prices at quote time. */
interface StoredChoice {
  group_id: string;
  group: Bilingual;
  options: Array<{ id: string; name: Bilingual; price_minor: Minor }>;
}

interface RequestViewRow extends PortionRequestRow {
  table_label: string;
  item_name_th: string | null;
  item_name_en: string | null;
  item_pricing_type: string;
  item_rate_minor: number | null;
  item_rate_basis_grams: number | null;
}

export const OPEN_PORTION_STATUSES: readonly PortionRequestStatus[] = ['requested', 'quoted'];
export const DEFAULT_PORTION_CHECKOUT_REASON = 'Closed at checkout';
const DECLINED_BY_GUEST = 'Declined by guest';
const CANCELLED_BY_GUEST = 'Cancelled by guest';

// The table label is the visit's CURRENT table: a transferred party gets its cut where it sits.
const REQUEST_SELECT = `
  SELECT r.*, t.label AS table_label,
         i.name_th AS item_name_th, i.name_en AS item_name_en, i.pricing_type AS item_pricing_type,
         i.rate_minor AS item_rate_minor, i.rate_basis_grams AS item_rate_basis_grams
    FROM portion_requests r
    JOIN visits v ON v.id = r.visit_id
    JOIN dining_tables t ON t.id = v.table_id
    JOIN menu_items i ON i.id = r.item_id`;

export function getPortionRequest(id: string): PortionRequestRow | undefined {
  return one<PortionRequestRow>('SELECT * FROM portion_requests WHERE id = ?', [id]);
}

function requestByKey(visitId: string, key: string): PortionRequestRow | undefined {
  return one<PortionRequestRow>('SELECT * FROM portion_requests WHERE visit_id = ? AND idempotency_key = ?', [visitId, key]);
}

function activeQuote(requestId: string): PortionQuoteRow | undefined {
  return one<PortionQuoteRow>(`SELECT * FROM portion_quotes WHERE request_id = ? AND status = 'active'`, [requestId]);
}

function latestQuote(requestId: string): PortionQuoteRow | undefined {
  return one<PortionQuoteRow>('SELECT * FROM portion_quotes WHERE request_id = ? ORDER BY revision DESC LIMIT 1', [requestId]);
}

/** The quote a screen should show: the confirmed one, else the active one, else the latest revision. */
function shownQuote(requestId: string): PortionQuoteRow | undefined {
  return one<PortionQuoteRow>(
    `SELECT * FROM portion_quotes WHERE request_id = ?
      ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, revision DESC LIMIT 1`,
    [requestId],
  );
}

function storedChoices(json: string): StoredChoice[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as StoredChoice[]) : [];
  } catch {
    return [];
  }
}

const choicesMinor = (choices: StoredChoice[]): Minor =>
  choices.reduce((sum, c) => sum + c.options.reduce((s, o) => s + o.price_minor, 0), 0);

const isPast = (iso: string, now: string): boolean => iso <= now; // both are toISOString() output

// ------------------------------------------------------------------ DTOs
export function portionQuoteDTO(q: PortionQuoteRow, now = nowIso()): PortionQuoteDTO {
  const choices = storedChoices(q.choices_json);
  const modifiers = choicesMinor(choices);
  return {
    id: q.id,
    revision: q.revision,
    grams: q.grams,
    rate_minor: q.rate_minor,
    rate_basis_grams: q.rate_basis_grams,
    amount_minor: q.amount_minor,
    choices: choices.map((c) => ({ group: c.group, options: c.options.map((o) => ({ name: o.name })) })),
    note: q.note,
    expires_at: q.expires_at,
    // An active quote past its expiry is shown as expired even before the sweep marks it.
    status: q.status === 'active' && isPast(q.expires_at, now) ? 'expired' : q.status,
    created_at: q.created_at,
    measured_minor: q.amount_minor - modifiers,
    modifiers_minor: modifiers,
    confirmed_at: q.confirmed_at,
    confirmed_via: q.confirmed_via,
  };
}

function buildRequestDTO(r: RequestViewRow, now: string): PortionRequestDTO {
  const q = shownQuote(r.id);
  const quote = q ? portionQuoteDTO(q, now) : null;
  const order = q?.order_line_id
    ? one<{ id: string; reference: string }>(
      'SELECT o.id, o.reference FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.id = ?', [q.order_line_id])
    : undefined;
  // A quoted request whose quote lapsed is waiting for staff again.
  const status: PortionRequestStatus = r.status === 'quoted' && quote?.status === 'expired' ? 'requested' : r.status;
  const priced = r.item_pricing_type === 'measured_weight' && r.item_rate_minor !== null && r.item_rate_basis_grams !== null;
  return {
    id: r.id,
    item_id: r.item_id,
    item_name: bi(r.item_name_th, r.item_name_en),
    table_label: r.table_label,
    visit_id: r.visit_id,
    preferred_grams: r.preferred_grams,
    note: r.note,
    status,
    quote,
    order_reference: order?.reference ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    version: r.version,
    order_id: order?.id ?? null,
    source: r.created_by_staff && !r.guest_session_id ? 'staff' : 'guest',
    current_rate: priced ? { rate_minor: r.item_rate_minor!, rate_basis_grams: r.item_rate_basis_grams! } : null,
    resolution_reason: r.resolution_reason,
  };
}

export function portionRequestDTO(id: string): PortionRequestDTO {
  const row = one<RequestViewRow>(`${REQUEST_SELECT} WHERE r.id = ?`, [id]);
  if (!row) throw new AppError('not_found', 'Portion request not found');
  return buildRequestDTO(row, nowIso());
}

function emitPortion(requestId: string, visitId: string, version: number, status: PortionRequestStatus, extra: Record<string, unknown> = {}): void {
  // Ids, versions and states only - never notes.
  emit('portion.updated', {
    audience: 'all',
    visit_id: visitId,
    entity: { type: 'portion_request', id: requestId, version },
    payload: { status, ...extra },
  });
}

function entity(req: Pick<PortionRequestRow, 'id' | 'visit_id'>) {
  return { type: 'portion_request', id: req.id, visit_id: req.visit_id };
}

/** A request is visible to a guest only through their own visit. */
function loadRequest(id: string, visitId?: string): PortionRequestRow {
  const req = getPortionRequest(id);
  if (!req || (visitId !== undefined && req.visit_id !== visitId)) throw new AppError('not_found', 'Portion request not found');
  return req;
}

function assertOpenVisit(visitId: string): void {
  const visit = getVisit(visitId);
  if (!visit) throw new AppError('not_found', 'Visit not found');
  if (visit.status === 'closed') throw new AppError('visit_closed');
  if (visit.status === 'billing') throw new AppError('visit_billing');
}

function closedRequestError(req: PortionRequestRow): AppError {
  if (req.status === 'confirmed') {
    return new AppError('already_done', 'This portion is already confirmed and ordered.', { current: portionRequestDTO(req.id) });
  }
  return new AppError('invalid_transition', `This portion request is ${req.status}.`, { current: portionRequestDTO(req.id) });
}

// ------------------------------------------------------------------ request
export interface CreatePortionRequestArgs {
  visitId: string;
  itemId: string;
  preferredGrams?: number | null;
  note?: string | null;
  idempotencyKey: string;
  guestSessionId?: string | null;
  staffUserId?: string | null;
  actor: Actor;
}

/**
 * Ask staff to weigh and quote a cut. Idempotent per (visit, key). The visit
 * must be able to order (open, not paused); billing → visit_billing.
 */
export function createPortionRequest(args: CreatePortionRequestArgs): { request: PortionRequestDTO; existing: boolean } {
  const preferred = args.preferredGrams ?? null;
  const note = args.note?.trim() ? args.note.trim() : null;
  return tx(() => {
    const replay = requestByKey(args.visitId, args.idempotencyKey);
    if (replay) {
      if (replay.item_id !== args.itemId || replay.preferred_grams !== preferred) {
        throw new AppError('idempotency_mismatch', 'This request key was already used for a different portion.');
      }
      return { request: portionRequestDTO(replay.id), existing: true };
    }

    const visit = getVisit(args.visitId);
    if (!visit) throw new AppError('not_found', 'Visit not found');
    assertCanOrder(visit, 'portion_quote');

    const item = getItem(args.itemId);
    const category = item ? getCategory(item.category_id) : undefined;
    if (!item || !category) throw new AppError('not_found', 'This dish is no longer on the menu.');
    if (item.pricing_type !== 'measured_weight') {
      throw new AppError('bad_request', 'This dish is ordered from the menu, not by weight.', { reason: 'not_measured_weight' });
    }
    const reason = unavailableReason(item, category, itemVariants(item.id));
    if (reason) throw new AppError('item_unavailable', 'This cut cannot be requested right now.', { reason, item_id: item.id });
    if (preferred !== null && !getSettings().portions.allow_preferred_weight) {
      throw new AppError('bad_request', 'A preferred weight is not taken here; staff will agree the portion with you.', {
        reason: 'preferred_weight_disabled', field: 'preferred_grams',
      });
    }

    const now = nowIso();
    const row = {
      id: newId('por'),
      visit_id: visit.id,
      table_id: visit.table_id,
      item_id: item.id,
      guest_session_id: args.guestSessionId ?? null,
      created_by_staff: args.staffUserId ?? null,
      preferred_grams: preferred,
      note,
      status: 'requested' as const,
      idempotency_key: args.idempotencyKey,
      created_at: now,
      business_date: businessDate(now, cutoffHour()),
      is_fixture: visit.is_fixture === 1 ? 1 : fixtureFlag(),
      updated_at: now,
      version: 1,
    };
    try {
      tx(() => insert('portion_requests', row));
    } catch (err) {
      if (!isConstraintError(err)) throw err;
      const winner = requestByKey(visit.id, args.idempotencyKey);
      if (!winner) throw err;
      return { request: portionRequestDTO(winner.id), existing: true };
    }

    audit(args.actor, 'portion.request', entity(row), {
      after: { item_id: item.id, preferred_grams: preferred, status: row.status, has_note: note !== null, by_staff: Boolean(args.staffUserId) },
    });
    emitPortion(row.id, visit.id, 1, 'requested', { item_id: item.id });
    return { request: portionRequestDTO(row.id), existing: false };
  });
}

// ------------------------------------------------------------------ quote
export interface QuotePortionArgs {
  requestId: string;
  grams: number;
  choices: Array<{ group_id: string; option_ids: string[] }>;
  note?: string | null;
  expiresMinutes?: number | null;
  version: number;
  staffUserId: string;
  actor: Actor;
}

/**
 * Validate choices exactly like a cart line does (same groups, availability,
 * min/max, inclusion allowance) and snapshot names and charged prices.
 */
function validateChoices(itemId: string, choices: QuotePortionArgs['choices']): StoredChoice[] {
  const probe: CartLineInput = { item_id: itemId, variant_id: null, quantity: 1, modifiers: choices, note: null, allergy_note: null, expected_unit_minor: null };
  const result = priceCart([probe]);
  const issues = result.quote.issues.filter((i) => i.code.startsWith('modifier_'));
  if (issues.length) {
    throw new AppError('validation_failed', 'Some choices are not valid for this cut.', {
      issues: issues.map((i) => ({ path: 'choices', message: i.message, code: i.code })),
    });
  }
  const line = result.priced[0];
  if (!line) throw new AppError('not_found', 'This dish is no longer on the menu.');
  return line.groups.map((g, gi) => ({
    group_id: g.group.id,
    group: bi(g.group.name_th, g.group.name_en),
    options: g.options.map((o, oi) => ({
      id: o.id,
      name: bi(o.name_th, o.name_en),
      price_minor: line.modifiers_snapshot[gi]?.options[oi]?.price_minor ?? 0,
    })),
  }));
}

function quotableItem(req: PortionRequestRow): ItemRow & { rate_minor: number; rate_basis_grams: number } {
  const item = getItem(req.item_id);
  const category = item ? getCategory(item.category_id) : undefined;
  if (!item || !category) throw new AppError('item_unavailable', 'This cut is no longer on the menu.');
  if (item.pricing_type !== 'measured_weight' || item.rate_minor === null || item.rate_basis_grams === null) {
    throw new AppError('item_unavailable', 'This cut has no approved rate.', { reason: 'price_pending' });
  }
  const reason = unavailableReason(item, category, itemVariants(item.id));
  if (reason) throw new AppError('item_unavailable', 'This cut cannot be served right now.', { reason });
  return item as ItemRow & { rate_minor: number; rate_basis_grams: number };
}

/**
 * Staff quote (or re-quote) a request: weighed grams, the item's current
 * rate, validated choices. Creates revision max+1 and supersedes the active
 * one. Two staff quoting from the same version: the second gets stale_version.
 */
export function quotePortion(args: QuotePortionArgs): PortionRequestDTO {
  if (!Number.isInteger(args.grams) || args.grams <= 0) {
    throw new AppError('validation_failed', 'Enter the weighed grams.', { issues: [{ path: 'grams', message: 'positive integer' }] });
  }
  return tx(() => {
    const req = loadRequest(args.requestId);
    if (req.version !== args.version) staleVersion(portionRequestDTO(req.id));
    if (req.status !== 'requested' && req.status !== 'quoted') throw closedRequestError(req);
    assertOpenVisit(req.visit_id);

    const item = quotableItem(req);
    const choices = validateChoices(item.id, args.choices);
    const measured = measuredAmount(args.grams, item.rate_minor, item.rate_basis_grams);
    const amount = measured + choicesMinor(choices);

    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const minutes = args.expiresMinutes ?? getSettings().portions.quote_expiry_minutes;
    const expiresAt = new Date(nowMs + minutes * 60_000).toISOString();

    const previous = activeQuote(req.id);
    if (previous) {
      // Must leave 'active' before the new revision is inserted (one active quote per request).
      run(`UPDATE portion_quotes SET status = :status WHERE id = :id AND status = 'active'`, {
        id: previous.id,
        status: isPast(previous.expires_at, now) ? 'expired' : 'superseded',
      });
    }
    const revision = (one<{ n: number | null }>('SELECT MAX(revision) AS n FROM portion_quotes WHERE request_id = ?', [req.id])?.n ?? 0) + 1;
    const quoteId = newId('pqt');
    const note = args.note?.trim() ? args.note.trim() : null;
    insert('portion_quotes', {
      id: quoteId,
      request_id: req.id,
      revision,
      grams: args.grams,
      rate_minor: item.rate_minor,
      rate_basis_grams: item.rate_basis_grams,
      amount_minor: amount,
      choices_json: JSON.stringify(choices),
      note,
      expires_at: expiresAt,
      status: 'active',
      created_by: args.staffUserId,
      created_at: now,
    });
    if (!updateVersioned('portion_requests', req.id, req.version, { status: 'quoted', updated_at: now })) {
      staleVersion(portionRequestDTO(req.id));
    }

    audit(args.actor, previous ? 'portion.requote' : 'portion.quote', entity(req), {
      before: previous ? { quote_id: previous.id, revision: previous.revision, grams: previous.grams, rate_minor: previous.rate_minor, amount_minor: previous.amount_minor } : { status: req.status },
      after: {
        quote_id: quoteId, revision, grams: args.grams, rate_minor: item.rate_minor, rate_basis_grams: item.rate_basis_grams,
        measured_minor: measured, amount_minor: amount, choices: choices.map((c) => ({ group_id: c.group_id, option_ids: c.options.map((o) => o.id) })),
        expires_at: expiresAt, has_note: note !== null,
      },
    });
    emitPortion(req.id, req.visit_id, req.version + 1, 'quoted', { revision, quote_id: quoteId });
    return portionRequestDTO(req.id);
  });
}

// ------------------------------------------------------------------ expiry
function expireQuote(quote: PortionQuoteRow, req: PortionRequestRow, now: string): void {
  run(`UPDATE portion_quotes SET status = 'expired' WHERE id = ? AND status = 'active'`, [quote.id]);
  let version = req.version;
  if (req.status === 'quoted') {
    if (updateVersioned('portion_requests', req.id, req.version, { status: 'requested', updated_at: now })) version++;
  }
  audit(SYSTEM, 'portion.quote_expired', entity(req), {
    before: { status: req.status }, after: { status: 'requested', quote_id: quote.id, revision: quote.revision, expires_at: quote.expires_at },
  });
  emitPortion(req.id, req.visit_id, version, 'requested', { revision: quote.revision, quote_expired: true });
}

/**
 * Sweep: every active quote past its expiry becomes 'expired' and its request
 * goes back to 'requested' for staff to weigh/quote again. Returns the count.
 */
export function expireQuotes(now: string = nowIso()): number {
  return tx(() => {
    const due = many<PortionQuoteRow>(`SELECT * FROM portion_quotes WHERE status = 'active' AND expires_at <= ? ORDER BY expires_at`, [now]);
    for (const q of due) {
      const req = getPortionRequest(q.request_id);
      if (req) expireQuote(q, req, now);
    }
    return due.length;
  });
}

// ------------------------------------------------------------------ confirm
export interface ConfirmPortionArgs {
  requestId: string;
  quoteId: string;
  revision: number;
  idempotencyKey: string;
  via: 'guest' | 'in_person';
  /** Guest confirmations: the visit their access belongs to. */
  visitId?: string;
  guestSessionId?: string | null;
  staffUserId?: string | null;
  /** In-person confirmations: optional staff note, kept in the audit trail. */
  note?: string | null;
  actor: Actor;
}

export type ConfirmPortionResult =
  | { outcome: 'confirmed'; request: PortionRequestDTO; orderId: string; replayed: boolean }
  /** The quote lapsed: it is now marked expired (commit this!) and the caller answers quote_expired. */
  | { outcome: 'expired'; request: PortionRequestDTO };

/** Rebuild the priced line from the quote snapshot: quantity 1, unit = measured amount. */
function portionLine(req: PortionRequestRow, quote: PortionQuoteRow): PricedLine {
  const item = getItem(req.item_id);
  const category = item ? getCategory(item.category_id) : undefined;
  if (!item || !category) throw new AppError('item_unavailable', 'This cut is no longer on the menu.');
  const choices = storedChoices(quote.choices_json);
  const modifiersMinor = choicesMinor(choices);
  const measuredMinor = quote.amount_minor - modifiersMinor;
  if (measuredMinor !== measuredAmount(quote.grams, quote.rate_minor, quote.rate_basis_grams)) {
    throw new Error(`portion quote ${quote.id} amount does not match its weight and rate`);
  }
  const groups: PricedModifierGroup[] = [];
  for (const c of choices) {
    const group = one<GroupRow>('SELECT * FROM modifier_groups WHERE id = ?', [c.group_id]);
    if (!group) continue;
    const options = c.options
      .map((o) => one<OptionRow>('SELECT * FROM modifier_options WHERE id = ?', [o.id]))
      .filter((o): o is OptionRow => Boolean(o));
    groups.push({ group, options, minor: c.options.reduce((s, o) => s + o.price_minor, 0) });
  }
  const input: CartLineInput = {
    item_id: item.id,
    variant_id: null,
    quantity: 1,
    modifiers: choices.map((c) => ({ group_id: c.group_id, option_ids: c.options.map((o) => o.id) })),
    note: req.note,
    allergy_note: null,
    expected_unit_minor: null,
  };
  return {
    index: 0,
    input,
    item,
    category,
    variant: null,
    groups,
    unit_price_minor: measuredMinor,
    modifiers_minor: modifiersMinor,
    quantity: 1,
    line_total_minor: quote.amount_minor,
    // The guest's own words from the request travel to the kitchen ticket.
    note: req.note,
    allergy_flag: looksLikeAllergyNote(req.note),
    prep_kind: prepKind(item, category),
    modifiers_snapshot: choices.map((c) => ({ group: c.group, options: c.options.map((o) => ({ name: o.name, price_minor: o.price_minor })) })),
    measured: { grams: quote.grams, rate_minor: quote.rate_minor, rate_basis_grams: quote.rate_basis_grams, portion_quote_id: quote.id },
  };
}

function orderIdForLine(lineId: string | null): string {
  const row = lineId ? one<{ order_id: string }>('SELECT order_id FROM order_lines WHERE id = ?', [lineId]) : undefined;
  if (!row) throw new Error('confirmed portion quote has no order line');
  return row.order_id;
}

/**
 * Confirm the ACTIVE quote revision and create its single order line, in one
 * transaction. Replays of the same key return the same order; any other
 * confirmation of an already confirmed request is already_done.
 */
export function confirmPortion(args: ConfirmPortionArgs): ConfirmPortionResult {
  return tx(() => {
    // 1. Replay: this key already confirmed a quote.
    const done = one<PortionQuoteRow>('SELECT * FROM portion_quotes WHERE confirm_idempotency_key = ?', [args.idempotencyKey]);
    if (done) {
      const owner = loadRequest(done.request_id, args.visitId);
      if (owner.id !== args.requestId || done.id !== args.quoteId || done.revision !== args.revision) {
        throw new AppError('idempotency_mismatch', 'This confirmation key was already used for another portion.');
      }
      return { outcome: 'confirmed', request: portionRequestDTO(owner.id), orderId: orderIdForLine(done.order_line_id), replayed: true };
    }

    // 2. The request, the quote and their states.
    const req = loadRequest(args.requestId, args.visitId);
    const quote = one<PortionQuoteRow>('SELECT * FROM portion_quotes WHERE id = ? AND request_id = ?', [args.quoteId, req.id]);
    if (!quote) throw new AppError('not_found', 'Quote not found');
    if (req.status !== 'requested' && req.status !== 'quoted') throw closedRequestError(req);
    if (quote.revision !== args.revision || quote.status === 'superseded' || quote.status === 'withdrawn') {
      throw new AppError('quote_superseded', 'Staff updated this quote. Please review the new amount.', { current: portionRequestDTO(req.id) });
    }
    if (quote.status === 'expired') {
      throw new AppError('quote_expired', 'This quote has expired. Staff will confirm the portion again.', { current: portionRequestDTO(req.id) });
    }
    if (quote.status !== 'active') throw closedRequestError(req);
    const now = nowIso();
    if (isPast(quote.expires_at, now)) {
      expireQuote(quote, req, now);
      return { outcome: 'expired', request: portionRequestDTO(req.id) };
    }

    // 3. The visit must still take orders (checkout / billing / pauses win if they committed first).
    const visit = getVisit(req.visit_id);
    if (!visit) throw new AppError('not_found', 'Visit not found');
    assertCanOrder(visit, 'portion_quote');

    // 4. The one order line, through the only order insert path.
    const created = createOrder({
      visit,
      source: 'portion_quote',
      actor: args.actor,
      guestSessionId: args.via === 'guest' ? (args.guestSessionId ?? null) : null,
      staffUserId: args.via === 'in_person' ? (args.staffUserId ?? null) : null,
      idempotencyKey: `pq_${quote.id}`,
      payloadHash: payloadHash({ portion_quote_id: quote.id, revision: quote.revision, amount_minor: quote.amount_minor }),
      priced: [portionLine(req, quote)],
    });
    const line = one<{ id: string }>('SELECT id FROM order_lines WHERE order_id = ? AND portion_quote_id = ? ORDER BY line_no LIMIT 1', [created.orderId, quote.id]);
    if (!line) throw new Error('portion order was created without its line');

    // 5. Quote and request become confirmed.
    const marked = run(
      `UPDATE portion_quotes SET status = 'confirmed', confirmed_at = :now, confirmed_via = :via,
              confirmed_guest_session_id = :guest, confirmed_staff_id = :staff,
              confirm_idempotency_key = :key, order_line_id = :line
        WHERE id = :id AND status = 'active'`,
      {
        id: quote.id, now, via: args.via,
        guest: args.via === 'guest' ? (args.guestSessionId ?? null) : null,
        staff: args.via === 'in_person' ? (args.staffUserId ?? null) : null,
        key: args.idempotencyKey, line: line.id,
      },
    );
    if (marked.changes !== 1) throw new AppError('conflict', 'This quote changed while confirming. Please try again.');
    if (!updateVersioned('portion_requests', req.id, req.version, { status: 'confirmed', resolved_at: now, resolved_by: args.actor.label, updated_at: now })) {
      staleVersion(portionRequestDTO(req.id));
    }

    audit(args.actor, args.via === 'guest' ? 'portion.confirm' : 'portion.confirm_in_person', entity(req), {
      reason: args.via === 'in_person' ? (args.note?.trim() || null) : null,
      before: { status: req.status },
      after: {
        status: 'confirmed', quote_id: quote.id, revision: quote.revision, grams: quote.grams,
        rate_minor: quote.rate_minor, rate_basis_grams: quote.rate_basis_grams, amount_minor: quote.amount_minor,
        order_id: created.orderId, order_line_id: line.id, via: args.via,
      },
    });
    emitPortion(req.id, req.visit_id, req.version + 1, 'confirmed', { revision: quote.revision, order_id: created.orderId });
    return { outcome: 'confirmed', request: portionRequestDTO(req.id), orderId: created.orderId, replayed: created.replayed };
  });
}

// ------------------------------------------------------------------ decline / cancel
export interface DeclinePortionArgs {
  requestId: string;
  quoteId: string;
  revision: number;
  visitId: string;
  actor: Actor;
}

/** The guest does not want the quoted portion: the quote is withdrawn, the request declined. */
export function declinePortion(args: DeclinePortionArgs): PortionRequestDTO {
  return tx(() => {
    const req = loadRequest(args.requestId, args.visitId);
    if (req.status === 'declined') return portionRequestDTO(req.id);
    if (req.status !== 'requested' && req.status !== 'quoted') throw closedRequestError(req);
    // The guest answers the latest revision they were shown (active, or one that just lapsed).
    const latest = latestQuote(req.id);
    if (!latest || latest.id !== args.quoteId || latest.revision !== args.revision) {
      throw new AppError('quote_superseded', 'Staff updated this quote. Please review the new amount.', { current: portionRequestDTO(req.id) });
    }
    if (latest.status !== 'active' && latest.status !== 'expired') throw closedRequestError(req);
    const now = nowIso();
    run(`UPDATE portion_quotes SET status = 'withdrawn' WHERE id = ? AND status = 'active'`, [latest.id]);
    if (!updateVersioned('portion_requests', req.id, req.version, {
      status: 'declined', resolved_at: now, resolved_by: args.actor.label, resolution_reason: DECLINED_BY_GUEST, updated_at: now,
    })) staleVersion(portionRequestDTO(req.id));
    audit(args.actor, 'portion.decline', entity(req), {
      before: { status: req.status }, after: { status: 'declined', quote_id: latest.id, revision: latest.revision },
    });
    emitPortion(req.id, req.visit_id, req.version + 1, 'declined', { revision: latest.revision });
    return portionRequestDTO(req.id);
  });
}

export interface CancelPortionArgs {
  requestId: string;
  /** Guests: the visit their access belongs to. */
  visitId?: string;
  /** Staff: the version they saw. Guests cancel without one. */
  version?: number;
  reason?: string | null;
  actor: Actor;
}

function cancelOpenRequest(req: PortionRequestRow, reason: string, actor: Actor, action: string): void {
  const now = nowIso();
  const withdrawn = activeQuote(req.id);
  if (withdrawn) run(`UPDATE portion_quotes SET status = 'withdrawn' WHERE id = ? AND status = 'active'`, [withdrawn.id]);
  if (!updateVersioned('portion_requests', req.id, req.version, {
    status: 'cancelled', resolved_at: now, resolved_by: actor.label, resolution_reason: reason, updated_at: now,
  })) staleVersion(portionRequestDTO(req.id));
  audit(actor, action, entity(req), {
    reason,
    before: { status: req.status }, after: { status: 'cancelled', withdrawn_quote_id: withdrawn?.id ?? null },
  });
  emitPortion(req.id, req.visit_id, req.version + 1, 'cancelled');
}

/** Cancel before confirmation. Guests: idempotent, no reason needed. Staff: version + reason. */
export function cancelPortion(args: CancelPortionArgs): PortionRequestDTO {
  return tx(() => {
    const req = loadRequest(args.requestId, args.visitId);
    if (args.version !== undefined && req.version !== args.version) staleVersion(portionRequestDTO(req.id));
    if (req.status === 'cancelled' && args.version === undefined) return portionRequestDTO(req.id);
    if (req.status !== 'requested' && req.status !== 'quoted') throw closedRequestError(req);
    const reason = args.reason?.trim() ? args.reason.trim() : CANCELLED_BY_GUEST;
    cancelOpenRequest(req, reason, args.actor, 'portion.cancel');
    return portionRequestDTO(req.id);
  });
}

/**
 * Checkout: unconfirmed requests never became food, so they are cancelled
 * with the checkout's attributable reason. Returns how many were closed.
 */
export function cancelPortionsForCheckout(visitId: string, reason: string | null | undefined, actor: Actor): number {
  const why = reason?.trim() ? reason.trim() : DEFAULT_PORTION_CHECKOUT_REASON;
  return tx(() => {
    const open = many<PortionRequestRow>(
      `SELECT * FROM portion_requests WHERE visit_id = ? AND status IN ('requested','quoted') ORDER BY created_at, id`, [visitId],
    );
    for (const req of open) cancelOpenRequest(req, why, actor, 'portion.cancelled_at_checkout');
    return open.length;
  });
}

// ------------------------------------------------------------------ read
export function listVisitPortions(visitId: string): PortionRequestDTO[] {
  const now = nowIso();
  return many<RequestViewRow>(`${REQUEST_SELECT} WHERE r.visit_id = ? ORDER BY r.created_at, r.id`, [visitId])
    .map((r) => buildRequestDTO(r, now));
}

/** Requests still waiting on staff or the guest (requested or quoted). */
export function openPortionCount(visitId: string): number {
  return one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM portion_requests WHERE visit_id = ? AND status IN ('requested','quoted')`, [visitId],
  )?.n ?? 0;
}

/**
 * Staff portion queue. `open`: requested/quoted on any visit, oldest first.
 * `all`: one business date (default today), newest first.
 */
export function listPortionQueue(q: { scope: 'open' | 'all'; date?: string }): PortionRequestDTO[] {
  const now = nowIso();
  if (q.scope === 'open') {
    return many<RequestViewRow>(`${REQUEST_SELECT} WHERE r.status IN ('requested','quoted') ORDER BY r.created_at, r.id`)
      .map((r) => buildRequestDTO(r, now));
  }
  const date = q.date ?? businessDate(now, cutoffHour());
  return many<RequestViewRow>(`${REQUEST_SELECT} WHERE r.business_date = ? ORDER BY r.created_at DESC, r.id LIMIT 500`, [date])
    .map((r) => buildRequestDTO(r, now));
}
