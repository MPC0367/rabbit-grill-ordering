// Pure board logic: where a round sits, what its one counted action is, and
// which exception actions a selection of dishes allows (brief 19, 35).
import type { OrderLineDTO, StaffOrderDTO } from '../../../../../shared/dto.ts';
import type { Permission } from '../../../../../shared/permissions.ts';
import {
  EXCEPTION_TRANSITIONS, FORWARD_TRANSITIONS, forwardIndex, isActive, FORWARD,
  type LineStatus, type Station,
} from '../../../../../shared/status.ts';
import type { BoardStage } from '../../../ui/index.ts';
import { compareLabels } from '../support.ts';

export type StationFilter = Station | 'all';
export type SortKey = 'oldest' | 'newest' | 'table' | 'late';
/** Where a round shows: a board column, the served-but-unfinished list, or the rejected/cancelled group. */
export type Placement = BoardStage | 'served' | 'void';

export function tableOf(o: StaffOrderDTO): string {
  return o.current_table_label ?? o.table_label;
}

/** Lines shown for the current station filter. */
export function visibleLines(o: StaffOrderDTO, station: StationFilter): OrderLineDTO[] {
  return station === 'all' ? o.lines : o.lines.filter((l) => l.station === station);
}

/** The column of the least-advanced active, unserved line (brief 35). */
export function placementOf(lines: readonly OrderLineDTO[]): Placement {
  const active = lines.filter((l) => isActive(l.status));
  if (active.length === 0) return 'void';
  const open = active.filter((l) => l.status !== 'served');
  if (open.length === 0) return 'served';
  const min = Math.min(...open.map((l) => forwardIndex(l.status)));
  return FORWARD[min] as BoardStage;
}

export interface StageAction {
  to: LineStatus;
  permission: Permission;
  /** i18n key of the counted action label. */
  label: string;
  /** i18n key explaining why this role cannot do it. */
  denied: string;
  icon?: 'check' | 'pan' | 'cloche';
}

export const STAGE_ACTION: Record<BoardStage, StageAction> = {
  submitted: { to: 'accepted', permission: 'orders.accept', label: 'orders.act.accept', denied: 'orders.denied.accept', icon: 'check' },
  accepted: { to: 'preparing', permission: 'orders.prepare', label: 'orders.act.start', denied: 'orders.denied.prepare' },
  preparing: { to: 'ready', permission: 'orders.prepare', label: 'orders.act.ready', denied: 'orders.denied.ready' },
  almost_done: { to: 'ready', permission: 'orders.prepare', label: 'orders.act.ready', denied: 'orders.denied.ready' },
  ready: { to: 'served', permission: 'orders.serve', label: 'orders.act.serve', denied: 'orders.denied.serve', icon: 'check' },
};

/** The lines the primary action changes: those currently at the ticket's stage. */
export function stageLines(lines: readonly OrderLineDTO[], stage: BoardStage): OrderLineDTO[] {
  return lines.filter((l) => l.status === stage);
}

/** Latest recorded step of a line. */
export function lastStep(l: OrderLineDTO) {
  let best = l.steps[0] ?? null;
  for (const s of l.steps) if (!best || s.at >= best.at) best = s;
  return best;
}

/** When the round reached the pass (earliest ready time of its ready lines). */
export function readySince(lines: readonly OrderLineDTO[]): string | null {
  let at: string | null = null;
  for (const l of lines) {
    if (l.status !== 'ready') continue;
    const s = [...l.steps].reverse().find((x) => x.status === 'ready');
    if (s && (!at || s.at < at)) at = s.at;
  }
  return at;
}

/** Who changed the round last, and when (for the conflict banner). */
export function lastChange(o: StaffOrderDTO): { by: string; at: string } | null {
  let best: { by: string; at: string } | null = null;
  for (const l of o.lines) {
    for (const s of l.steps) {
      if (!best || s.at > best.at) best = { by: s.actor ?? '', at: s.at };
    }
  }
  return best;
}

export function sortOrders(list: StaffOrderDTO[], sort: SortKey): StaffOrderDTO[] {
  const out = [...list];
  if (sort === 'newest') out.sort((a, b) => b.submitted_at.localeCompare(a.submitted_at) || b.round_no - a.round_no);
  else if (sort === 'table') out.sort((a, b) => compareLabels(tableOf(a), tableOf(b)) || a.round_no - b.round_no);
  else out.sort((a, b) => a.submitted_at.localeCompare(b.submitted_at) || a.round_no - b.round_no);
  return out;
}

export function matchesQuery(o: StaffOrderDTO, q: string, norm: (s: string) => string): boolean {
  if (!q) return true;
  const hay = [
    o.table_label, o.current_table_label ?? '', o.reference, o.manual_reference ?? '',
    ...o.lines.flatMap((l) => [l.name.th ?? '', l.name.en ?? '']),
  ].map(norm);
  return hay.some((h) => h.includes(q));
}

// ------------------------------------------------------------------ selection actions (details panel)

export type ExceptionKind = 'reject' | 'cancel' | 'correct';

export interface SelectionPlan {
  /** A forward step every selected line can take (Accept, Start preparing, Almost done, Mark ready, Mark served). */
  forward: Array<{ to: LineStatus; permission: Permission }>;
  /** Exception steps, each with its single target and permission. */
  reject: { to: 'rejected'; permission: Permission } | null;
  cancel: { to: 'cancelled'; permission: Permission } | null;
  correct: { to: LineStatus; permission: Permission } | null;
}

const FORWARD_PERMISSION = (to: LineStatus): Permission =>
  to === 'accepted' ? 'orders.accept' : to === 'served' ? 'orders.serve' : 'orders.prepare';

/** What a selection allows. A step is offered only when every selected line can take the same step. */
export function planSelection(lines: readonly OrderLineDTO[]): SelectionPlan {
  const plan: SelectionPlan = { forward: [], reject: null, cancel: null, correct: null };
  if (lines.length === 0) return plan;
  const statuses = [...new Set(lines.map((l) => l.status))];
  // forward: the intersection of each status's forward targets
  let common: LineStatus[] = [...FORWARD_TRANSITIONS[statuses[0]]];
  for (const s of statuses.slice(1)) common = common.filter((to) => FORWARD_TRANSITIONS[s].includes(to));
  plan.forward = common
    .sort((a, b) => forwardIndex(a) - forwardIndex(b))
    .map((to) => ({ to, permission: FORWARD_PERMISSION(to) }));

  const allHave = (kind: 'reject' | 'cancel' | 'correction') => statuses.every((s) => EXCEPTION_TRANSITIONS[s].some((x) => x.kind === kind));
  if (allHave('reject')) plan.reject = { to: 'rejected', permission: 'orders.accept' };
  if (allHave('cancel')) {
    const unstarted = statuses.every((s) => s === 'accepted');
    plan.cancel = { to: 'cancelled', permission: unstarted ? 'orders.cancel_unstarted' : 'orders.cancel_started' };
  }
  if (allHave('correction')) {
    const targets = [...new Set(statuses.map((s) => EXCEPTION_TRANSITIONS[s].find((x) => x.kind === 'correction')!.to))];
    if (targets.length === 1) plan.correct = { to: targets[0], permission: 'orders.correct' };
  }
  return plan;
}

/** Lines Finish order must resolve: every active line that is not served yet. */
export function unresolvedLines(o: StaffOrderDTO): OrderLineDTO[] {
  return o.lines.filter((l) => isActive(l.status) && l.status !== 'served');
}

/** Permission a "cancel" resolution needs for one line (a never-accepted dish is rejected instead). */
export function cancelPermission(status: LineStatus): Permission {
  if (status === 'submitted') return 'orders.accept';
  if (status === 'accepted') return 'orders.cancel_unstarted';
  return 'orders.cancel_started';
}
