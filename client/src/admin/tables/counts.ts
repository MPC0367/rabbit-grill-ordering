// What the tables screens count, and the plain words they say about it.
//
// One unit everywhere: dishes (quantities), which is what the Orders board's
// ticket buttons count ("Mark served · 3"). A tile saying "3 dishes not served",
// the board button and the Overview card then always agree (round-1 finding 41).
// The server sends `unresolved_dishes` / `ready_dishes` beside the older line
// counts; an older server sends only the line counts, which are the same number
// until a line has a quantity above one.
import type { StaffBillDTO, TableTileDTO, VisitDetailDTO } from '../../../../shared/dto.ts';
import { ACTIVE_UNSERVED } from '../../../../shared/status.ts';
import { money } from '../../lib/format.ts';

type T = (k: string, v?: Record<string, string | number>) => string;
type TileVisit = NonNullable<TableTileDTO['visit']>;

/** Dishes ordered and not yet served (accepted, cooking or at the pass). */
export function unresolvedDishes(v: TileVisit): number {
  return typeof v.unresolved_dishes === 'number' ? v.unresolved_dishes : v.unresolved_lines;
}

/** Dishes at the pass, ready to carry out. */
export function readyDishes(v: TileVisit): number {
  return typeof v.ready_dishes === 'number' ? v.ready_dishes : v.ready_lines;
}

function sumQty(lines: ReadonlyArray<{ quantity: number }>): number {
  return lines.reduce((n, l) => n + l.quantity, 0);
}

/** Plain-words blockers (stop checkout) and notices (closed automatically at checkout). */
export function checkoutWords(t: T, bill: StaffBillDTO, detail: VisitDetailDTO | undefined): { blockers: string[]; notices: string[] } {
  const blockers: string[] = [];
  const notices: string[] = [];
  const codes = new Set(bill.checkout_blockers);
  if (codes.has('unresolved_orders')) {
    const rounds = [...(detail?.orders ?? [])].sort((a, b) => a.round_no - b.round_no);
    let described = false;
    for (const o of rounds) {
      // Counted in dishes, the same unit as the tile and the board's buttons.
      const waiting = sumQty(o.lines.filter((l) => l.status === 'submitted'));
      const cooking = sumQty(o.lines.filter((l) => l.status !== 'submitted' && ACTIVE_UNSERVED.includes(l.status)));
      if (waiting > 0) { blockers.push(t(waiting === 1 ? 'tables.block.toAcceptOne' : 'tables.block.toAccept', { n: waiting, r: o.round_no })); described = true; }
      if (cooking > 0) { blockers.push(t(cooking === 1 ? 'tables.block.unservedOne' : 'tables.block.unserved', { n: cooking, r: o.round_no })); described = true; }
    }
    // Only when the visit detail is not loaded: the bill counts lines, so this
    // line stays in the neutral "items" wording.
    if (!described) blockers.push(t('tables.block.unservedAny', { n: bill.unresolved.unserved_lines }));
  }
  if (codes.has('bill_not_finalized')) {
    if (bill.revision_stale) blockers.push(t('tables.block.stale'));
    else if (bill.visit_status === 'open') blockers.push(t('tables.block.notStarted'));
    else blockers.push(t('tables.block.notFinalised'));
  }
  if (codes.has('unpaid_bill')) {
    const due = bill.current_revision && !bill.revision_stale ? bill.current_revision.total_minor : bill.running_total_minor ?? bill.total_minor;
    blockers.push(t('tables.block.unpaid', { amount: money(due) }));
  }
  if (codes.has('open_requests')) {
    const n = bill.unresolved.open_requests;
    notices.push(t(n === 1 ? 'tables.notice.requestsOne' : 'tables.notice.requests', { n }));
  }
  if (codes.has('open_portions')) {
    const n = bill.unresolved.open_portion_requests;
    notices.push(t(n === 1 ? 'tables.notice.portionsOne' : 'tables.notice.portions', { n }));
  }
  return { blockers, notices };
}
