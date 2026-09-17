// Safe order submission (brief 13, 29, 30; DECISIONS D-06, D-23). Stream C1b.
//
// Phases the guest can see:
//   idle      nothing pending
//   sending   the request is on its way (key + exact payload already persisted)
//   checking  the outcome is unknown (network error, timeout, 5xx, reload
//             mid-send): we look the attempt up by its key, with backoff, and
//             NEVER offer a new submission meanwhile
//   retry     the lookup said not_found: nothing was created, so sending again
//             with the SAME key and payload is safe ("Try sending again")
//   rejected  refused before creation (cart_changed, pause, billing, hours,
//             intake, access): the reason is shown and the draft is kept
//   received  the server created the round (reference) - only ever from a
//             server response, never from local state
//
// The idempotency key is created when the guest presses Place order and is
// stored (namespaced by visit + guest) together with the exact payload and the
// draft line uids until the outcome is known. A retry re-sends that stored
// payload byte for byte, so "same key, different payload" cannot happen here.
// On success only the submitted lines leave the draft.
import { useEffect, useSyncExternalStore } from 'react';
import type { AttemptLookupDTO, OrderDTO, QuoteDTO, SubmitResultDTO } from '../../../../shared/dto.ts';
import { newIdempotencyKey } from '../../../../shared/ids.ts';
import type { SubmitOrderBody } from '../../../../shared/schemas.ts';
import type { Locale } from '../../../../shared/settings.ts';
import { api, ApiError, type ClientErrorCode } from '../../lib/api.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { navigate } from '../../lib/router.ts';
import { useLive } from '../../lib/live.tsx';
import { createStore, storage } from '../../lib/store.ts';
import { analyticsSessionId } from '../../lib/tracker.ts';
import { useToast } from '../../ui/Toast.tsx';
import { submitKey, toInput } from './model.ts';
import { applyQuote, cartStore, cartView, endCartVisit, removeSubmitted, requote, setFrozen } from './store.ts';

export type SubmitPhase = 'idle' | 'sending' | 'checking' | 'retry' | 'rejected' | 'received';

interface PendingAttempt {
  v: 1;
  key: string;
  payload: SubmitOrderBody;
  uids: string[];
  /** Where the attempt stood when last written; 'sending' after a reload means unknown. */
  phase: 'sending' | 'checking' | 'retry';
  created_at: string;
  updated_at: string;
}

export interface SubmitRejection {
  code: ClientErrorCode;
  status: number;
  details: unknown;
}

export interface SubmitState {
  visitId: string | null;
  guestId: string | null;
  phase: SubmitPhase;
  pending: PendingAttempt | null;
  order: OrderDTO | null;
  error: SubmitRejection | null;
  /** Attempt lookups made for the current pending key. */
  checks: number;
  /** The last lookup could not reach the server either. */
  checkFailed: boolean;
  lastCheckAt: number | null;
  /** A received outcome has been shown to the guest (toast or navigation). */
  handled: boolean;
}

const initial: SubmitState = {
  visitId: null, guestId: null, phase: 'idle', pending: null, order: null, error: null,
  checks: 0, checkFailed: false, lastCheckAt: null, handled: false,
};

export const submitStore = createStore<SubmitState>(initial);

/** Codes that mean "nothing was created, the draft is fine, ordering is blocked right now". */
export const BLOCKING_CODES: readonly ClientErrorCode[] = ['ordering_paused', 'table_paused', 'outside_hours', 'intake_full', 'visit_billing', 'table_disabled'];

const BACKOFF_MS = [800, 1500, 2500, 4000, 6000, 9000, 12000, 15000];

let sendingNow = false;
let checkTimer: ReturnType<typeof setTimeout> | null = null;
let checkSeq = 0;

function nowIso(): string {
  return new Date().toISOString();
}

function storeKey(s: SubmitState = submitStore.get()): string | null {
  return s.visitId && s.guestId ? submitKey(s.visitId, s.guestId) : null;
}

function writePending(p: PendingAttempt | null): void {
  const key = storeKey();
  if (!key) return;
  if (p) storage.set(key, p);
  else storage.remove(key);
}

function readPending(key: string): PendingAttempt | null {
  const p = storage.get<PendingAttempt | null>(key, null);
  if (!p || p.v !== 1 || typeof p.key !== 'string' || !p.payload || !Array.isArray(p.uids)) return null;
  return p;
}

function stopChecking(): void {
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = null;
  checkSeq++;
}

// ------------------------------------------------------------------ binding (called by store.bindCart)
export function submissionBound(visitId: string | null, guestId: string | null): void {
  stopChecking();
  sendingNow = false;
  if (!visitId || !guestId) {
    submitStore.set({ ...initial });
    setFrozen([]);
    return;
  }
  const pending = readPending(submitKey(visitId, guestId));
  submitStore.set({
    ...initial,
    visitId,
    guestId,
    pending,
    phase: pending ? (pending.phase === 'retry' ? 'retry' : 'checking') : 'idle',
  });
  setFrozen(pending ? pending.uids : []);
}

/** After a reload (or rebinding) with an unresolved attempt: look it up again automatically. */
export function resumeSubmission(): void {
  const s = submitStore.get();
  if (s.pending && s.phase === 'checking') scheduleCheck(0);
}

// ------------------------------------------------------------------ outcomes
function succeed(order: OrderDTO): void {
  const s = submitStore.get();
  const uids = s.pending?.uids ?? [];
  stopChecking();
  writePending(null);
  removeSubmitted(uids);
  setFrozen([]);
  submitStore.set({ ...s, phase: 'received', pending: null, order, error: null, checkFailed: false, handled: false });
}

function refuse(err: ApiError): void {
  const s = submitStore.get();
  const uids = s.pending?.uids ?? [];
  stopChecking();
  writePending(null);
  setFrozen([]);
  submitStore.set({ ...s, phase: 'rejected', pending: null, order: null, error: { code: err.code, status: err.status, details: err.details }, checkFailed: false });
  if (err.code === 'cart_changed') {
    const quote = (err.details as { quote?: QuoteDTO } | null)?.quote;
    if (quote && Array.isArray(quote.lines)) applyQuote(quote, uids);
    else void requote();
  }
  if (err.code === 'visit_closed') endCartVisit();
}

function unknownOutcome(): void {
  const s = submitStore.get();
  if (!s.pending) return;
  const pending: PendingAttempt = { ...s.pending, phase: 'checking', updated_at: nowIso() };
  writePending(pending);
  submitStore.set({ ...s, phase: 'checking', pending, checkFailed: false });
  scheduleCheck(BACKOFF_MS[0]);
}

function isUnknown(err: ApiError): boolean {
  return err.ambiguous || err.status >= 500 || err.code === 'aborted';
}

async function send(pending: PendingAttempt): Promise<void> {
  if (sendingNow) return;
  sendingNow = true;
  try {
    const result = await api.post<SubmitResultDTO>('/api/guest/orders', pending.payload, { timeoutMs: 20_000 });
    if (submitStore.get().pending?.key !== pending.key) return;
    succeed(result.order);
  } catch (err) {
    if (submitStore.get().pending?.key !== pending.key) return;
    const e = err instanceof ApiError ? err : new ApiError('network_error', 0, String(err));
    if (isUnknown(e)) unknownOutcome();
    else refuse(e);
  } finally {
    sendingNow = false;
  }
}

// ------------------------------------------------------------------ attempt lookup
function scheduleCheck(delay: number): void {
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = setTimeout(() => { checkTimer = null; void checkOnce(); }, delay);
}

async function checkOnce(): Promise<void> {
  const s = submitStore.get();
  const pending = s.pending;
  if (!pending || s.phase !== 'checking') return;
  const my = ++checkSeq;
  try {
    const r = await api.get<AttemptLookupDTO>(`/api/guest/orders/attempts/${encodeURIComponent(pending.key)}`, { timeoutMs: 10_000 });
    if (my !== checkSeq || submitStore.get().pending?.key !== pending.key) return;
    if (r.status === 'created' && r.order) {
      succeed(r.order);
      return;
    }
    // Definitive (single process, synchronous creation): nothing was created.
    const next: PendingAttempt = { ...pending, phase: 'retry', updated_at: nowIso() };
    writePending(next);
    const cur = submitStore.get();
    submitStore.set({ ...cur, phase: 'retry', pending: next, checks: cur.checks + 1, checkFailed: false, lastCheckAt: Date.now() });
  } catch (err) {
    if (my !== checkSeq || submitStore.get().pending?.key !== pending.key) return;
    const e = err instanceof ApiError ? err : new ApiError('network_error', 0, String(err));
    const cur = submitStore.get();
    if (e.code === 'visit_closed') {
      stopChecking();
      endCartVisit();
      return;
    }
    if (e.code === 'visit_access_revoked' || e.code === 'visit_access_required') {
      // We cannot look it up any more; keep the record in case access returns, show why.
      stopChecking();
      submitStore.set({ ...cur, error: { code: e.code, status: e.status, details: e.details }, checkFailed: true, lastCheckAt: Date.now() });
      return;
    }
    const checks = cur.checks + 1;
    submitStore.set({ ...cur, checks, checkFailed: true, lastCheckAt: Date.now() });
    scheduleCheck(BACKOFF_MS[Math.min(checks, BACKOFF_MS.length - 1)]);
  }
}

/** Look the pending attempt up right away (reconnect, "Check again"). */
export function checkNow(): void {
  const s = submitStore.get();
  if (s.phase === 'checking' && s.pending) {
    stopChecking();
    scheduleCheck(0);
  }
}

// ------------------------------------------------------------------ guest actions
export type PlaceResult = 'sent' | 'review' | 'offline' | 'busy' | 'empty';

/**
 * Place order: re-validate, then create and persist the attempt, then send it.
 * Returns 'review' when the fresh quote found something to fix (nothing sent).
 */
export async function placeOrder(locale: Locale): Promise<PlaceResult> {
  const s = submitStore.get();
  if (!s.visitId || s.pending || sendingNow) return 'busy';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  let view = cartView(cartStore.get());
  if (view.lines.length === 0) return 'empty';
  if (!view.ready) {
    await requote();
    view = cartView(cartStore.get());
    if (view.quoteStatus === 'offline') return 'offline';
    if (!view.ready) return 'review';
  }
  if (submitStore.get().pending || sendingNow) return 'busy';
  const lines = view.lines.filter((l) => !cartStore.get().frozen.includes(l.uid));
  const at = nowIso();
  const pending: PendingAttempt = {
    v: 1,
    key: newIdempotencyKey(),
    payload: {
      idempotency_key: '',
      lines: lines.map(toInput),
      expected_subtotal_minor: view.subtotalMinor,
      locale,
      analytics_session_id: analyticsSessionId(),
    },
    uids: lines.map((l) => l.uid),
    phase: 'sending',
    created_at: at,
    updated_at: at,
  };
  pending.payload.idempotency_key = pending.key;
  writePending(pending);
  setFrozen(pending.uids);
  submitStore.set({ ...submitStore.get(), phase: 'sending', pending, order: null, error: null, checks: 0, checkFailed: false, lastCheckAt: null, handled: false });
  await send(pending);
  return 'sent';
}

/** The lookup said nothing was created: send the SAME attempt again. */
export async function retrySubmission(): Promise<void> {
  const s = submitStore.get();
  if (s.phase !== 'retry' || !s.pending || sendingNow) return;
  const pending: PendingAttempt = { ...s.pending, phase: 'sending', updated_at: nowIso() };
  writePending(pending);
  submitStore.set({ ...s, phase: 'sending', pending, error: null });
  await send(pending);
}

/** Only after a definitive not_found: give the lines back for editing (the next send uses a new key). */
export function discardAttempt(): void {
  const s = submitStore.get();
  if (s.phase !== 'retry') return;
  writePending(null);
  setFrozen([]);
  submitStore.set({ ...s, phase: 'idle', pending: null, error: null, checks: 0, checkFailed: false });
}

/** Clear a shown rejection or a handled success. */
export function resetOutcome(): void {
  const s = submitStore.get();
  if (s.phase === 'rejected' || s.phase === 'received') submitStore.set({ ...s, phase: 'idle', order: null, error: null, handled: false });
}

export function markOutcomeHandled(): void {
  const s = submitStore.get();
  if (!s.handled) submitStore.set({ ...s, handled: true });
}

// ------------------------------------------------------------------ hooks
function snap() {
  return submitStore.get();
}

/** Submission state; while checking, reconnects and coming back online trigger an immediate lookup. */
export function useSubmission(): SubmitState {
  const s = useSyncExternalStore(submitStore.subscribe, snap, snap);
  const live = useLive();
  const checking = s.phase === 'checking';
  useEffect(() => {
    if (!checking) return;
    const off = live.onResync(() => checkNow());
    const online = () => checkNow();
    window.addEventListener('online', online);
    return () => { off(); window.removeEventListener('online', online); };
  }, [checking, live.onResync]);
  return s;
}

/**
 * A round confirmed while the order page is not on screen (e.g. the lookup
 * resolved after a reload on the menu): say so once, with a way to Track.
 * Mounted through useCartCount(), which the dock always renders.
 */
export function useSubmissionNotice(): void {
  const s = useSyncExternalStore(submitStore.subscribe, snap, snap);
  const toast = useToast();
  const { t } = useI18n();
  useEffect(() => {
    if (s.phase !== 'received' || !s.order || s.handled) return;
    const id = setTimeout(() => {
      const cur = submitStore.get();
      if (cur.phase !== 'received' || !cur.order || cur.handled) return;
      const ref = cur.order.reference;
      markOutcomeHandled();
      resetOutcome();
      toast.show({
        message: t('submit.receivedShort', { ref }),
        spoken: t('submit.received', { ref }),
        duration: 8000,
        action: { label: t('submit.track'), onClick: () => navigate(`/menu/orders?placed=${encodeURIComponent(ref)}`) },
      });
    }, 60);
    return () => clearTimeout(id);
  }, [s.phase, s.order, s.handled, toast, t]);
}

/** For the order slip (CartBar state): a round on its way or being checked reads "กำลังส่ง…"; issues read "review". */
export function useSlipState(): 'idle' | 'sending' | 'review' {
  const s = useSyncExternalStore(submitStore.subscribe, snap, snap);
  const reviewNeeded = useSyncExternalStore(cartStore.subscribe, () => cartView(cartStore.get()).reviewNeeded, () => false);
  if (s.phase === 'sending' || s.phase === 'checking') return 'sending';
  return reviewNeeded || s.phase === 'retry' ? 'review' : 'idle';
}
