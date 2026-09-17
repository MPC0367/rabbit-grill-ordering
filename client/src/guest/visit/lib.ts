// Stream C2 helpers: honest timeline derivation from recorded line steps,
// attempt keys that survive a reload until the server answers, error words,
// and the small "close the sheet, then navigate" dance.
import { ApiError } from '../../lib/api.ts';
import { clock } from '../../lib/format.ts';
import { navigate } from '../../lib/router.ts';
import { storage } from '../../lib/store.ts';
import { FORWARD, forwardIndex, guestStepKey, isActive, type LineStatus } from '../../../../shared/status.ts';
import { newIdempotencyKey } from '../../../../shared/ids.ts';
import type { OrderDTO, OrderLineDTO } from '../../../../shared/dto.ts';
import type { StepState, TimelineStep, TrailSegment } from '../../ui/index.ts';

type T = (key: string, vars?: Record<string, string | number>) => string;

// ------------------------------------------------------------------ storage and attempt keys
const PREFIX = 'rg.c2.';

/**
 * One idempotency key per logical attempt (scope). It is kept until the
 * server gives a definitive answer, so a retry after a lost response
 * replays the same request instead of creating a second one.
 */
export function attemptKey(scope: string): string {
  const k = `${PREFIX}key.${scope}`;
  const existing = storage.get<string | null>(k, null);
  if (typeof existing === 'string' && existing.length >= 12) return existing;
  const fresh = newIdempotencyKey();
  storage.set(k, fresh);
  return fresh;
}

export function settleKey(scope: string): void {
  storage.remove(`${PREFIX}key.${scope}`);
}

/** After a request: forget the key unless the outcome is unknown (network, timeout, 5xx). */
export function settleUnlessAmbiguous(scope: string, err: unknown): void {
  if (err instanceof ApiError && err.ambiguous) return;
  settleKey(scope);
}

export function visitFlag(visitId: string, name: string): boolean {
  return storage.get<boolean>(`${PREFIX}flag.${visitId}.${name}`, false) === true;
}

export function setVisitFlag(visitId: string, name: string): void {
  storage.set(`${PREFIX}flag.${visitId}.${name}`, true);
}

/** Last table this browser joined (shown on the ended page after the session is gone). */
export function rememberTable(label: string): void {
  storage.set(`${PREFIX}lastTable`, label);
}

export function rememberedTable(): string | null {
  const v = storage.get<string | null>(`${PREFIX}lastTable`, null);
  return typeof v === 'string' ? v : null;
}

/** Everything this stream stored for the visit that just ended. */
export function clearVisitStorage(keepTable = true): void {
  for (const k of storage.keys(PREFIX)) {
    if (keepTable && k === `${PREFIX}lastTable`) continue;
    storage.remove(k);
  }
}

// ------------------------------------------------------------------ errors
export const ACCESS_ENDED = new Set(['visit_closed', 'visit_access_revoked']);

export function isAccessEnded(err: unknown): err is ApiError {
  return err instanceof ApiError && ACCESS_ENDED.has(err.code);
}

export function isAccessRequired(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === 'visit_access_required';
}

function detail<V>(err: ApiError, key: string): V | undefined {
  const d = err.details;
  return d && typeof d === 'object' && key in d ? (d as Record<string, V>)[key] : undefined;
}

export function retryAfterSeconds(err: ApiError): number | null {
  const s = detail<number>(err, 'retry_after_seconds');
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? Math.ceil(s) : null;
}

export function detailOf<V>(err: unknown, key: string): V | undefined {
  return err instanceof ApiError ? detail<V>(err, key) : undefined;
}

/** Guest-facing words for any failure, using the API code and its details. */
export function errorWords(t: T, has: (k: string) => boolean, err: unknown): string {
  if (!(err instanceof ApiError)) return t('error.internal');
  if (err.code === 'rate_limited') {
    const s = retryAfterSeconds(err);
    return s ? `${t('error.rate_limited')} ${t('visit.error.retryIn', { n: s })}` : t('error.rate_limited');
  }
  if (err.code === 'idempotency_mismatch') return t('visit.error.idempotency');
  const key = `error.${err.code}`;
  return has(key) ? t(key) : t('error.internal');
}

// ------------------------------------------------------------------ navigation after a sheet
/**
 * Close an overlay, then navigate once its history entry has been popped,
 * so the new page is not undone by the overlay's own Back.
 */
export function closeThenNavigate(close: () => void, to: string): void {
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    window.removeEventListener('popstate', onPop);
    // Let the router settle on the popped entry first.
    setTimeout(() => navigate(to), 0);
  };
  const onPop = () => go();
  window.addEventListener('popstate', onPop);
  close();
  setTimeout(go, 450);
}

export function prefersReduced(): boolean {
  if (typeof window === 'undefined') return true;
  if (document.documentElement.dataset.motion === 'reduce') return true;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

// ------------------------------------------------------------------ tracking
export type Reached = Partial<Record<LineStatus, string>>;

/**
 * When a line reached each state, from its recorded steps only. A
 * correction clears later milestones (their times no longer describe the
 * dish) and keeps the target's original time.
 */
export function lineReached(line: OrderLineDTO, submittedAt: string): Reached {
  const r: Reached = {};
  for (const s of line.steps) {
    const idx = FORWARD.indexOf(s.status);
    if (s.kind === 'correction') {
      if (idx >= 0) for (const later of FORWARD.slice(idx + 1)) delete r[later];
      if (!r[s.status]) r[s.status] = s.at;
      continue;
    }
    r[s.status] = s.at;
  }
  if (!r.submitted) r.submitted = submittedAt;
  return r;
}

const latest = (times: string[]) => times.reduce((a, b) => (b > a ? b : a));
const earliest = (times: string[]) => times.reduce((a, b) => (b < a ? b : a));

export type Bucket = 'served' | 'ready' | 'almost_done' | 'cooking' | 'preparing' | 'accepted' | 'submitted' | 'cancelled' | 'rejected';
const BUCKET_ORDER: Bucket[] = ['served', 'ready', 'almost_done', 'cooking', 'preparing', 'accepted', 'submitted', 'cancelled', 'rejected'];

export function bucketOf(line: OrderLineDTO): Bucket {
  if (line.status === 'preparing') return line.prep_kind === 'prepare' ? 'preparing' : 'cooking';
  return line.status as Bucket;
}

/** "เสิร์ฟแล้ว 1 · กำลังปรุง 2 · ยกเลิก 1", by quantity. */
export function summaryParts(t: T, lines: ReadonlyArray<OrderLineDTO>, opts: { exceptions?: boolean } = {}): string[] {
  const counts = new Map<Bucket, number>();
  for (const l of lines) {
    const b = bucketOf(l);
    if (!opts.exceptions && (b === 'cancelled' || b === 'rejected')) continue;
    counts.set(b, (counts.get(b) ?? 0) + l.quantity);
  }
  return BUCKET_ORDER.filter((b) => counts.has(b)).map((b) => t(`track.sum.${b}`, { n: counts.get(b)! }));
}

/** Wording kind for an order: "preparing" only when every relevant line is a drink or dessert. */
export function orderPrep(lines: ReadonlyArray<OrderLineDTO>): 'cook' | 'prepare' {
  const active = lines.filter((l) => isActive(l.status));
  return active.length > 0 && active.every((l) => l.prep_kind === 'prepare') ? 'prepare' : 'cook';
}

export function itemCount(order: OrderDTO): number {
  return order.lines.reduce((s, l) => s + l.quantity, 0);
}

/** Words for when the current step was reached: sent, started (preparing), or since. */
function sinceKey(status: LineStatus): string {
  if (status === 'submitted') return 'common.sentAt';
  if (status === 'preparing' || status === 'almost_done') return 'common.startedAt';
  return 'track.since';
}

export interface OrderTimeline {
  steps: TimelineStep[];
  /** Key of the current step, null when everything is served. */
  current: LineStatus | null;
}

/**
 * The round's parcel timeline. The round is only as far along as its least
 * advanced unserved dish. Done steps show the latest recorded time among
 * the dishes (never an estimate); a passed step nobody recorded reads
 * "not recorded". Rejected or cancelled dishes are not on this rail.
 */
export function orderTimeline(t: T, order: OrderDTO): OrderTimeline | null {
  const active = order.lines.filter((l) => isActive(l.status));
  if (active.length === 0) return null;
  const reached = active.map((l) => lineReached(l, order.submitted_at));
  const unserved = active.filter((l) => l.status !== 'served');
  const curIdx = unserved.length ? Math.min(...unserved.map((l) => forwardIndex(l.status))) : FORWARD.length;
  const prep = orderPrep(active);
  const mixed = new Set(active.map(bucketOf)).size > 1;

  const steps = FORWARD.map((status, i): TimelineStep => {
    const label = t(guestStepKey(status, prep));
    if (i < curIdx) {
      const times = reached.map((r) => r[status]).filter((x): x is string => Boolean(x));
      const state: StepState = times.length ? 'done' : 'skipped';
      return { key: status, label, state, at: times.length ? latest(times) : null };
    }
    if (i === curIdx) {
      const here = unserved.filter((l) => l.status === status);
      const started = here.map((l) => lineReached(l, order.submitted_at)[status]).filter((x): x is string => Boolean(x));
      const parts: string[] = [];
      // 'Started' only where something really started (preparation); 'Since' otherwise.
      if (started.length) parts.push(t(sinceKey(status), { time: clock(earliest(started)) }));
      if (mixed) parts.push(...summaryParts(t, active));
      return { key: status, label, state: 'current', sub: parts.length ? parts.join(' · ') : undefined };
    }
    return { key: status, label, state: 'upcoming' };
  });
  return { steps, current: curIdx < FORWARD.length ? FORWARD[curIdx] : null };
}

/** Six-segment trail and skipped milestones for one dish. */
export function lineTrail(t: T, line: OrderLineDTO, submittedAt: string): { trail: TrailSegment[]; skipped: string[]; at: string | null } {
  const r = lineReached(line, submittedAt);
  if (!isActive(line.status)) return { trail: [], skipped: [], at: r[line.status] ?? null };
  const idx = forwardIndex(line.status);
  const skipped: string[] = [];
  const trail = FORWARD.map((status, i): TrailSegment => {
    if (i < idx) {
      if (r[status]) return 'done';
      skipped.push(t(`track.skip.${status}`));
      return 'skipped';
    }
    if (i === idx) return line.status === 'served' ? 'done' : 'now';
    return 'todo';
  });
  return { trail, skipped, at: r[line.status] ?? null };
}

/** Headline and honest one-liner for a round. */
export function orderState(t: T, order: OrderDTO): { title: string; message: string } {
  const prep = orderPrep(order.lines);
  switch (order.status) {
    case 'partially_served': {
      const unserved = order.lines.filter((l) => isActive(l.status) && l.status !== 'served');
      const least = unserved.length ? FORWARD[Math.min(...unserved.map((l) => forwardIndex(l.status)))] : 'served';
      const lprep = orderPrep(unserved);
      const message = least === 'preparing' ? t(`track.msg.preparing.${lprep}`)
        : least === 'submitted' ? t('track.msg.received')
          : least === 'accepted' ? t('track.msg.confirmed')
            : t(`track.msg.${least}`);
      return { title: t('track.step.partiallyServed'), message };
    }
    case 'preparing':
      return { title: t(guestStepKey('preparing', prep)), message: t(`track.msg.preparing.${prep}`) };
    case 'received':
    case 'confirmed':
    case 'almost_done':
    case 'ready':
    case 'served':
    case 'rejected':
    case 'cancelled':
      return { title: t(guestStepKey(order.status, prep)), message: t(`track.msg.${order.status}`) };
  }
}

/** A round is "finished" for the guest when no dish is still on its way. */
export function isFinished(order: OrderDTO): boolean {
  return order.lines.every((l) => l.status === 'served' || !isActive(l.status));
}
