// The private draft ("Your order") for this device and this dining visit
// (stream C1b; docs/CLIENT.md, brief 12, DECISIONS D-05).
//
//   bindCart(visitId, guestId)   GuestApp, whenever the session changes
//   const cart = useCart()       lines, count, subtotal, issues, quote, add/update/remove, requote
//   const n = useCartCount()     badge / order slip
//
// - Drafts are stored with lib/store `storage` under rg.cart.<visit>.<guest>.
//   Binding a visit drops every draft (and pending submission) of any other
//   visit, so an old cart never follows the next party (brief 36).
// - Every change is re-quoted against the live catalog (debounced), and again
//   on 'menu.' events, after a reconnect and when the catalog version moves.
//   Totals come from the latest quote; while offline they fall back to the
//   prices the guest saw and say so (`estimated`).
// - Tracker cart_add / cart_remove fire only after the draft really changed.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { QuoteDTO, QuoteIssue, QuoteLineDTO } from '../../../../shared/dto.ts';
import { api, ApiError } from '../../lib/api.ts';
import { useLive } from '../../lib/live.tsx';
import { createStore, storage } from '../../lib/store.ts';
import { trackCartChange } from '../../lib/tracker.ts';
import { useGuestSession } from '../shell/session.tsx';
import {
  CART_PREFIX, EMPTY_NAME, MAX_QTY_FALLBACK, SUBMIT_PREFIX, cartKey, cleanNote, defaultVariant, keyVisit, mergeKey,
  newUid, normalizePicks, optionNames, quoteSig, toInput, unitPrice,
  type CartLine, type NewCartLine,
} from './model.ts';
import { resumeSubmission, submissionBound, useSubmissionNotice } from './submit.ts';

export type { CartLine, NewCartLine } from './model.ts';

export type QuoteStatus = 'idle' | 'loading' | 'fresh' | 'offline' | 'denied' | 'error';

interface QuotedEntry { sig: string; line: QuoteLineDTO | null; issues: QuoteIssue[] }

interface CartState {
  visitId: string | null;
  guestId: string | null;
  lines: CartLine[];
  /** Latest quote response (raw). */
  quote: QuoteDTO | null;
  /** Latest quote result per draft line, with the line signature it was computed for. */
  quoted: Record<string, QuoteEntryOrUndefined>;
  quoteStatus: QuoteStatus;
  quoteError: ApiError | null;
  quotedAt: number | null;
  /** Lines inside an unresolved submission: they cannot change until it resolves. */
  frozen: string[];
}
type QuoteEntryOrUndefined = QuotedEntry | undefined;

interface StoredDraft { v: 1; lines: CartLine[]; updated_at: string }

const initial: CartState = {
  visitId: null, guestId: null, lines: [], quote: null, quoted: {},
  quoteStatus: 'idle', quoteError: null, quotedAt: null, frozen: [],
};

export const cartStore = createStore<CartState>(initial);

/** Drafts older than this are never restored (a dining visit is far shorter). */
const STALE_MS = 12 * 60 * 60 * 1000;
const QUOTE_DEBOUNCE_MS = 220;

function nowIso(): string {
  return new Date().toISOString();
}

// ------------------------------------------------------------------ persistence
function currentKey(s: CartState = cartStore.get()): string | null {
  return s.visitId && s.guestId ? cartKey(s.visitId, s.guestId) : null;
}

function persist(lines: CartLine[]): void {
  const key = currentKey();
  if (!key) return;
  if (lines.length === 0) storage.remove(key);
  else storage.set(key, { v: 1, lines, updated_at: nowIso() } satisfies StoredDraft);
}

function validLine(l: unknown): l is CartLine {
  const x = l as Partial<CartLine> | null;
  return Boolean(x && typeof x.uid === 'string' && typeof x.item_id === 'string' && Number.isInteger(x.quantity) && (x.quantity ?? 0) > 0 && Array.isArray(x.modifiers));
}

function readDraft(key: string): CartLine[] {
  const d = storage.get<StoredDraft | null>(key, null);
  if (!d || d.v !== 1 || !Array.isArray(d.lines)) return [];
  if (Date.parse(d.updated_at) < Date.now() - STALE_MS) {
    storage.remove(key);
    return [];
  }
  return d.lines.filter(validLine).map((l) => ({
    ...l,
    variant_id: l.variant_id ?? null,
    note: l.note ?? null,
    allergy_note: Boolean(l.allergy_note),
    expected_unit_minor: l.expected_unit_minor ?? null,
    name: l.name ?? EMPTY_NAME,
    variant_name: l.variant_name ?? null,
    option_names: Array.isArray(l.option_names) ? l.option_names : [],
    image: l.image ?? null,
    category_id: l.category_id ?? null,
    max_qty: l.max_qty ?? MAX_QTY_FALLBACK,
  }));
}

/** Forget drafts and pending submissions that belong to any other visit, and very old ones. */
function pruneOtherVisits(visitId: string | null): void {
  for (const prefix of [CART_PREFIX, SUBMIT_PREFIX]) {
    for (const key of storage.keys(prefix)) {
      if (visitId && keyVisit(key, prefix) !== visitId) {
        storage.remove(key);
        continue;
      }
      const d = storage.get<{ updated_at?: string; created_at?: string } | null>(key, null);
      const at = Date.parse(d?.updated_at ?? d?.created_at ?? '');
      if (!Number.isFinite(at) || at < Date.now() - STALE_MS) storage.remove(key);
    }
  }
}

// ------------------------------------------------------------------ binding
/**
 * Called by GuestApp whenever the guest session changes. A visit id binds this
 * device's draft for that visit and membership; null unbinds (nothing is shown,
 * nothing is deleted except drafts past their age limit).
 */
export function bindCart(visitId: string | null, guestId: string | null): void {
  const s = cartStore.get();
  const v = visitId && guestId ? visitId : null;
  const g = visitId && guestId ? guestId : null;
  pruneOtherVisits(v);
  if (s.visitId === v && s.guestId === g) return;
  cancelQuote();
  cartStore.set({ ...initial, visitId: v, guestId: g, lines: v && g ? readDraft(cartKey(v, g)) : [] });
  submissionBound(v, g);
  if (v && g) {
    scheduleQuote(0);
    resumeSubmission();
  }
}

/** The visit ended on this device (Visit ended screen, 410): drop its draft and pending submission. */
export function endCartVisit(): void {
  const s = cartStore.get();
  if (s.visitId) {
    for (const key of [...storage.keys(`${CART_PREFIX}${s.visitId}.`), ...storage.keys(`${SUBMIT_PREFIX}${s.visitId}.`)]) storage.remove(key);
  }
  cancelQuote();
  cartStore.set({ ...initial });
  submissionBound(null, null);
}

// Another tab of this browser changed the same draft.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    const key = currentKey();
    if (!key || e.key !== key) return;
    cartStore.set((s) => ({ ...s, lines: readDraft(key) }));
    scheduleQuote();
  });
}

// ------------------------------------------------------------------ mutations
function commit(lines: CartLine[]): void {
  cartStore.set((s) => ({ ...s, lines }));
  persist(lines);
  scheduleQuote();
}

function isFrozen(uid: string): boolean {
  return cartStore.get().frozen.includes(uid);
}

export interface AddResult { uid: string; merged: boolean; quantity: number }

/** Add a selection. Identical selections (item, variant, choices, note, allergy tick) merge. */
export function addLine(input: NewCartLine): AddResult | null {
  const s = cartStore.get();
  if (!s.visitId) return null;
  const item = input.item;
  const variantId = input.variant_id !== undefined ? input.variant_id : item ? defaultVariant(item) : null;
  const modifiers = normalizePicks(input.modifiers, item);
  const maxQty = input.max_qty ?? item?.max_qty ?? MAX_QTY_FALLBACK;
  const qty = Math.max(1, Math.min(maxQty, Math.floor(input.quantity ?? 1)));
  const note = cleanNote(input.note);
  const draft = {
    item_id: input.item_id,
    variant_id: variantId ?? null,
    modifiers,
    note,
    allergy_note: Boolean(input.allergy_note && note),
  };
  const key = mergeKey(draft);
  const expected = input.expected_unit_minor !== undefined ? input.expected_unit_minor : item ? unitPrice(item, draft.variant_id, modifiers) : null;
  const at = nowIso();

  const existing = s.lines.find((l) => mergeKey(l) === key && !s.frozen.includes(l.uid));
  let result: AddResult;
  let lines: CartLine[];
  if (existing) {
    const next = Math.min(existing.max_qty || maxQty, existing.quantity + qty);
    const added = next - existing.quantity;
    if (added <= 0) return { uid: existing.uid, merged: true, quantity: 0 };
    lines = s.lines.map((l) => (l.uid === existing.uid
      ? { ...l, quantity: next, expected_unit_minor: l.expected_unit_minor ?? expected ?? null, updated_at: at }
      : l));
    result = { uid: existing.uid, merged: true, quantity: added };
  } else {
    const line: CartLine = {
      uid: newUid(),
      ...draft,
      quantity: qty,
      expected_unit_minor: expected ?? null,
      name: input.name ?? item?.name ?? EMPTY_NAME,
      variant_name: input.variant_name !== undefined ? input.variant_name : item?.variants.find((v) => v.id === draft.variant_id)?.name ?? null,
      option_names: input.option_names ?? (item ? optionNames(item, modifiers) : []),
      image: input.image !== undefined ? input.image : item?.image ?? null,
      category_id: input.category_id !== undefined ? input.category_id : item?.category_id ?? null,
      max_qty: maxQty,
      added_at: at,
      updated_at: at,
    };
    lines = [...s.lines, line];
    result = { uid: line.uid, merged: false, quantity: qty };
  }
  commit(lines);
  const target = lines.find((l) => l.uid === result.uid)!;
  trackCartChange({ itemId: target.item_id, quantityDelta: result.quantity, quickAdd: Boolean(input.quick_add), categoryId: target.category_id, ref: target.uid });
  return result;
}

/**
 * Change a line. A new selection that now matches another line merges into it.
 * Returns the uid that holds the result (it may differ after a merge).
 */
export function updateLine(uid: string, patch: Partial<NewCartLine>): string | null {
  const s = cartStore.get();
  const current = s.lines.find((l) => l.uid === uid);
  if (!current || isFrozen(uid)) return null;
  const item = patch.item;
  const modifiers = patch.modifiers !== undefined ? normalizePicks(patch.modifiers, item) : current.modifiers;
  const variantId = patch.variant_id !== undefined ? patch.variant_id ?? null : current.variant_id;
  const maxQty = patch.max_qty ?? item?.max_qty ?? current.max_qty ?? MAX_QTY_FALLBACK;
  const quantity = patch.quantity !== undefined ? Math.max(1, Math.min(maxQty, Math.floor(patch.quantity))) : current.quantity;
  const note = patch.note !== undefined ? cleanNote(patch.note) : current.note;
  const allergy = patch.allergy_note !== undefined ? patch.allergy_note : current.allergy_note;
  const selectionChanged = patch.modifiers !== undefined || patch.variant_id !== undefined;
  const expected = patch.expected_unit_minor !== undefined
    ? patch.expected_unit_minor
    : selectionChanged && item ? unitPrice(item, variantId, modifiers) : current.expected_unit_minor;
  const next: CartLine = {
    ...current,
    item_id: current.item_id,
    variant_id: variantId,
    modifiers,
    quantity,
    note,
    allergy_note: Boolean(allergy && note),
    expected_unit_minor: expected ?? null,
    name: patch.name ?? item?.name ?? current.name,
    variant_name: item ? item.variants.find((v) => v.id === variantId)?.name ?? null : patch.variant_name !== undefined ? patch.variant_name : current.variant_name,
    option_names: item ? optionNames(item, modifiers) : patch.option_names ?? current.option_names,
    image: patch.image !== undefined ? patch.image : item?.image ?? current.image,
    max_qty: maxQty,
    updated_at: nowIso(),
  };
  const delta = next.quantity - current.quantity;

  // Merge into an identical sibling instead of keeping two equal lines.
  const twin = s.lines.find((l) => l.uid !== uid && !s.frozen.includes(l.uid) && mergeKey(l) === mergeKey(next));
  let lines: CartLine[];
  let holder = uid;
  if (twin) {
    const merged = Math.min(twin.max_qty || maxQty, twin.quantity + next.quantity);
    lines = s.lines.filter((l) => l.uid !== uid).map((l) => (l.uid === twin.uid ? { ...l, quantity: merged, updated_at: next.updated_at } : l));
    holder = twin.uid;
    const lost = twin.quantity + next.quantity - merged;
    if (delta - lost !== 0) trackCartChange({ itemId: current.item_id, quantityDelta: delta - lost, categoryId: current.category_id, ref: twin.uid });
  } else {
    lines = s.lines.map((l) => (l.uid === uid ? next : l));
    if (delta !== 0) trackCartChange({ itemId: current.item_id, quantityDelta: delta, categoryId: current.category_id, ref: uid });
  }
  commit(lines);
  return holder;
}

export function setQuantity(uid: string, quantity: number): void {
  updateLine(uid, { quantity });
}

/** Remove a line (the guest's own action). Returns the removed line for undo. */
export function removeLine(uid: string): CartLine | null {
  const s = cartStore.get();
  const line = s.lines.find((l) => l.uid === uid);
  if (!line || isFrozen(uid)) return null;
  commit(s.lines.filter((l) => l.uid !== uid));
  trackCartChange({ itemId: line.item_id, quantityDelta: -line.quantity, categoryId: line.category_id, ref: line.uid });
  return line;
}

/** Put a removed line back where it was (undo). */
export function restoreLine(line: CartLine, index?: number): void {
  const s = cartStore.get();
  if (!s.visitId || s.lines.some((l) => l.uid === line.uid)) return;
  const lines = [...s.lines];
  lines.splice(index === undefined ? lines.length : Math.max(0, Math.min(index, lines.length)), 0, line);
  commit(lines);
  trackCartChange({ itemId: line.item_id, quantityDelta: line.quantity, categoryId: line.category_id, ref: line.uid });
}

/** After the server confirmed a round: drop exactly the lines that were sent. Not a guest removal (no tracker event). */
export function removeSubmitted(uids: string[]): void {
  const s = cartStore.get();
  const set = new Set(uids);
  const quoted = { ...s.quoted };
  for (const u of uids) delete quoted[u];
  cartStore.set({ ...s, lines: s.lines.filter((l) => !set.has(l.uid)), frozen: s.frozen.filter((u) => !set.has(u)), quoted });
  persist(cartStore.get().lines);
  scheduleQuote();
}

export function setFrozen(uids: string[]): void {
  cartStore.set((s) => ({ ...s, frozen: uids }));
}

/** Store issues that arrived with a refused submission (409 cart_changed), mapped by the sent lines. */
export function applyQuote(quote: QuoteDTO, uids: string[]): void {
  const s = cartStore.get();
  const quoted = { ...s.quoted };
  uids.forEach((uid, index) => {
    const line = s.lines.find((l) => l.uid === uid);
    if (!line) return;
    quoted[uid] = {
      sig: quoteSig(line),
      line: quote.lines.find((q) => q.line_index === index) ?? null,
      issues: quote.issues.filter((i) => i.line_index === index),
    };
  });
  cartStore.set({ ...s, quote, quoted, quoteStatus: 'fresh', quoteError: null, quotedAt: Date.now() });
  fillExpected(uids, quote);
}

// ------------------------------------------------------------------ quoting
let quoteTimer: ReturnType<typeof setTimeout> | null = null;
let quoteSeq = 0;
let waiters: Array<() => void> = [];

function cancelQuote(): void {
  if (quoteTimer) clearTimeout(quoteTimer);
  quoteTimer = null;
  quoteSeq++;
  const w = waiters;
  waiters = [];
  w.forEach((fn) => fn());
}

function scheduleQuote(delay = QUOTE_DEBOUNCE_MS): void {
  if (!cartStore.get().visitId) return;
  if (quoteTimer) clearTimeout(quoteTimer);
  quoteTimer = setTimeout(() => { quoteTimer = null; void runQuote(); }, delay);
}

/** Lines added without a known price take the first quoted price as the one they saw. */
function fillExpected(uids: string[], quote: QuoteDTO): void {
  const s = cartStore.get();
  let changed = false;
  const lines = s.lines.map((l) => {
    const i = uids.indexOf(l.uid);
    if (i < 0 || l.expected_unit_minor !== null) return l;
    const q = quote.lines.find((x) => x.line_index === i);
    const blocked = quote.issues.some((x) => x.line_index === i);
    if (!q || !q.ok || blocked) return l;
    changed = true;
    return { ...l, expected_unit_minor: q.unit_price_minor + q.modifiers_minor };
  });
  if (!changed) return;
  const quoted = { ...s.quoted };
  for (const l of lines) {
    const e = quoted[l.uid];
    if (e && uids.includes(l.uid)) quoted[l.uid] = { ...e, sig: quoteSig(l) };
  }
  cartStore.set({ ...s, lines, quoted });
  persist(lines);
}

function settle(my: number): void {
  if (my !== quoteSeq) return;
  const w = waiters;
  waiters = [];
  w.forEach((fn) => fn());
}

async function runQuote(): Promise<void> {
  const my = ++quoteSeq;
  const s = cartStore.get();
  if (!s.visitId) { settle(my); return; }
  const snapshot = s.lines;
  const uids = snapshot.map((l) => l.uid);
  if (snapshot.length === 0) {
    cartStore.set((x) => ({ ...x, quote: null, quoted: {}, quoteStatus: 'fresh', quoteError: null, quotedAt: Date.now() }));
    settle(my);
    return;
  }
  cartStore.set((x) => (x.quoteStatus === 'loading' ? x : { ...x, quoteStatus: 'loading' }));
  try {
    const quote = await api.post<QuoteDTO>('/api/guest/quote', { lines: snapshot.map(toInput) }, { timeoutMs: 12_000 });
    if (my !== quoteSeq) return;
    const quoted: Record<string, QuoteEntryOrUndefined> = {};
    snapshot.forEach((line, index) => {
      quoted[line.uid] = {
        sig: quoteSig(line),
        line: quote.lines.find((q) => q.line_index === index) ?? null,
        issues: quote.issues.filter((i) => i.line_index === index),
      };
    });
    cartStore.set((x) => ({ ...x, quote, quoted, quoteStatus: 'fresh', quoteError: null, quotedAt: Date.now() }));
    fillExpected(uids, quote);
  } catch (err) {
    if (my !== quoteSeq) return;
    const e = err instanceof ApiError ? err : new ApiError('internal', 0, String(err));
    if (e.code === 'visit_closed') {
      endCartVisit();
      return;
    }
    const status: QuoteStatus = e.ambiguous || e.code === 'aborted' ? 'offline'
      : e.code === 'visit_access_required' || e.code === 'visit_access_revoked' ? 'denied'
        : 'error';
    cartStore.set((x) => ({ ...x, quoteStatus: status, quoteError: e }));
  } finally {
    settle(my);
  }
}

/** Re-validate the draft now (debounced callers share one request). Resolves when the latest quote settles. */
export function requote(): Promise<void> {
  if (!cartStore.get().visitId) return Promise.resolve();
  if (quoteTimer) clearTimeout(quoteTimer);
  quoteTimer = null;
  const done = new Promise<void>((resolve) => { waiters.push(resolve); });
  void runQuote();
  return done;
}

// Reconnects and network recovery re-validate.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => scheduleQuote(0));
}

// ------------------------------------------------------------------ derived view
export interface LineView {
  line: CartLine;
  /** The quote result when it still describes this exact line. */
  quoted: QuoteLineDTO | null;
  issues: QuoteIssue[];
  /** Line total: from the quote when fresh, otherwise from the prices the guest saw (null when unknown). */
  totalMinor: number | null;
  /** Total not confirmed by the server (offline or not yet quoted). */
  estimated: boolean;
  frozen: boolean;
}

export interface CartView {
  lines: CartLine[];
  views: LineView[];
  /** Items (sum of quantities). */
  count: number;
  /** Food subtotal of lines that can be sent. */
  subtotalMinor: number;
  /** Some totals are local estimates (offline, or the quote has not answered yet). */
  estimated: boolean;
  /** Issues from the latest quote, line_index re-mapped to the current `lines`. */
  issues: QuoteIssue[];
  quote: QuoteDTO | null;
  quoteStatus: QuoteStatus;
  quoteError: ApiError | null;
  quotedAt: number | null;
  /** Every line is quoted for its current selection and nothing needs review. */
  ready: boolean;
  reviewNeeded: boolean;
  bound: boolean;
  visitId: string | null;
}

const viewCache = new WeakMap<CartState, CartView>();

export function cartView(s: CartState): CartView {
  const hit = viewCache.get(s);
  if (hit) return hit;
  const views: LineView[] = s.lines.map((line) => {
    const e = s.quoted[line.uid];
    const fresh = Boolean(e && e.sig === quoteSig(line));
    const quoted = fresh ? e!.line : null;
    const issues = fresh ? e!.issues : e?.issues.filter((i) => i.code !== 'price_changed') ?? [];
    const local = line.expected_unit_minor !== null ? line.expected_unit_minor * line.quantity : null;
    const totalMinor = quoted && quoted.ok ? quoted.line_total_minor
      : issues.some((i) => i.code === 'price_changed') ? issues.find((i) => i.code === 'price_changed')?.current?.line_total_minor ?? local
        : local;
    return { line, quoted, issues, totalMinor, estimated: !(quoted && quoted.ok), frozen: s.frozen.includes(line.uid) };
  });
  const sendable = views.filter((v) => v.issues.length === 0);
  const issues: QuoteIssue[] = views.flatMap((v, index) => v.issues.map((i) => ({ ...i, line_index: index })));
  const allFresh = views.every((v) => v.quoted !== null);
  const view: CartView = {
    lines: s.lines,
    views,
    count: s.lines.reduce((n, l) => n + l.quantity, 0),
    subtotalMinor: sendable.reduce((sum, v) => sum + (v.totalMinor ?? 0), 0),
    estimated: views.some((v) => v.estimated && v.issues.length === 0),
    issues,
    quote: s.quote,
    quoteStatus: s.quoteStatus,
    quoteError: s.quoteError,
    quotedAt: s.quotedAt,
    ready: s.lines.length > 0 && allFresh && issues.length === 0 && s.quoteStatus === 'fresh',
    reviewNeeded: issues.length > 0,
    bound: Boolean(s.visitId),
    visitId: s.visitId,
  };
  viewCache.set(s, view);
  return view;
}

// ------------------------------------------------------------------ hooks
export interface UseCart extends CartView {
  add: (input: NewCartLine) => AddResult | null;
  update: (uid: string, patch: Partial<NewCartLine>) => string | null;
  remove: (uid: string) => CartLine | null;
  restore: (line: CartLine, index?: number) => void;
  removeSubmitted: (uids: string[]) => void;
  requote: () => Promise<void>;
  /** The live result for one line. */
  viewOf: (uid: string) => LineView | undefined;
}

const actions = {
  add: addLine,
  update: updateLine,
  remove: removeLine,
  restore: restoreLine,
  removeSubmitted,
  requote,
};

/** Keep quotes current while any cart consumer is mounted: menu events and reconnects. */
function useQuoteFreshness(): void {
  const live = useLive();
  useEffect(() => {
    const offEvent = live.subscribe(['menu.', 'settings.'], () => scheduleQuote(300));
    const offResync = live.onResync(() => scheduleQuote(0));
    return () => { offEvent(); offResync(); };
  }, [live.subscribe, live.onResync]);
}

/** The visit ended on this device (closed or access revoked): its draft must not outlive it. */
function useEndedCleanup(): void {
  const { mode } = useGuestSession();
  useEffect(() => {
    if (mode === 'ended' && cartStore.get().visitId) endCartVisit();
  }, [mode]);
}

function snapshot() {
  return cartStore.get();
}

export function useCart(): UseCart {
  const s = useSyncExternalStore(cartStore.subscribe, snapshot, snapshot);
  useQuoteFreshness();
  useEndedCleanup();
  return useMemo(() => {
    const view = cartView(s);
    return { ...view, ...actions, viewOf: (uid: string) => view.views.find((v) => v.line.uid === uid) };
  }, [s]);
}

export function useCartCount(): number {
  useSubmissionNotice();
  useEndedCleanup();
  return useSyncExternalStore(cartStore.subscribe, () => cartView(cartStore.get()).count, () => 0);
}

/**
 * Tell the cart which catalog version the menu is showing; a change re-quotes
 * the draft (seasonal expiry, price edits, sold-out toggles).
 */
let seenCatalogVersion: string | null = null;
export function noteCatalogVersion(version: string | null | undefined): void {
  if (!version || version === seenCatalogVersion) return;
  const first = seenCatalogVersion === null;
  seenCatalogVersion = version;
  if (!first || cartStore.get().quote?.catalog_version !== version) scheduleQuote(0);
}
