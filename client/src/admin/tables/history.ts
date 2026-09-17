// Visit audit entries as drawer history rows: time, one bold event, details
// and the person (newest first). Unknown actions still show, in plain words.
import type { AuditEntryDTO } from '../../../../shared/dto.ts';
import type { HistoryItem } from '../../ui/index.ts';
import { clock, money } from '../../lib/format.ts';
import { tn } from './shared.ts';

type T = (k: string, v?: Record<string, string | number>) => string;
type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

const SIMPLE: Record<string, string> = {
  'visit.pin_rotated': 'tables.hist.pinRotated',
  'visit.guests_revoked': 'tables.hist.guestsRevoked',
  'visit.access_revoked': 'tables.hist.accessEnded',
  'visit.pin_locked': 'tables.hist.pinLocked',
  'visit.bill_requested': 'tables.hist.billRequested',
  'visit.billing_start': 'tables.hist.billingStart',
  'visit.checkout': 'tables.hist.checkout',
  'visit.close_exception': 'tables.hist.closeException',
  'guest.joined': 'tables.hist.guestJoined',
  'guest.left': 'tables.hist.guestLeft',
  'order.finished': 'tables.hist.roundFinished',
  'order.lines_rejected': 'tables.hist.rejected',
  'order.lines_cancelled': 'tables.hist.cancelled',
  'order.lines_corrected': 'tables.hist.corrected',
  'portion.request': 'tables.hist.portionRequested',
  'portion.confirm': 'tables.hist.portionConfirmed',
  'portion.confirm_in_person': 'tables.hist.portionInPerson',
  'portion.decline': 'tables.hist.portionDeclined',
  'portion.quote_expired': 'tables.hist.portionExpired',
  'portion.cancel': 'tables.hist.portionCancelled',
  'portion.cancelled_at_checkout': 'tables.hist.portionCancelledCheckout',
  'bill.reopen': 'tables.hist.billReopened',
  'payment.reverse': 'tables.hist.paymentReversed',
  'payment.refund_record': 'tables.hist.refundRecorded',
  'service.completed_at_checkout': 'tables.hist.requestClosedCheckout',
  'service.cancelled_at_checkout': 'tables.hist.requestClosedCheckout',
};

function describe(e: AuditEntryDTO, t: T): { event: string; parts: string[] } {
  const a = obj(e.after);
  const b = obj(e.before);
  const parts: string[] = [];
  const reference = str(a.reference);
  switch (e.action) {
    case 'visit.opened': {
      const covers = num(a.covers);
      parts.push(covers === null ? t('tables.covers.notRecorded') : tn(t, 'tables.covers.n', covers));
      return { event: t('tables.hist.opened'), parts };
    }
    case 'visit.covers_updated': {
      const from = num(b.covers);
      const to = num(a.covers);
      parts.push(`${from === null ? '—' : from} → ${to === null ? '—' : to}`);
      return { event: t('tables.hist.covers'), parts };
    }
    case 'visit.transferred': {
      const from = str(b.table_label) ?? '';
      const to = str(a.table_label) ?? '';
      return { event: t('tables.hist.transferred', { from, to }), parts };
    }
    case 'order.created': {
      const round = num(a.round_no);
      const items = num(a.item_count);
      if (items !== null) parts.push(tn(t, 'tables.hist.items', items));
      if (reference) parts.push(reference);
      const staffRound = a.source === 'staff';
      return { event: round !== null ? t(staffRound ? 'tables.hist.roundStaff' : 'tables.hist.round', { n: round }) : t('tables.hist.roundAny'), parts };
    }
    case 'order.recovered': {
      const ref = str(a.manual_reference);
      if (ref) parts.push(t('tables.hist.paper', { ref }));
      if (reference) parts.push(reference);
      return { event: t('tables.hist.recovered'), parts };
    }
    case 'order.lines_advanced': {
      const lines = Array.isArray(a.lines) ? (a.lines as unknown[]).map(obj) : [];
      const status = str(lines[0]?.status) ?? 'accepted';
      parts.push(tn(t, 'tables.hist.dishes', lines.length));
      if (reference) parts.push(reference);
      return { event: t(`common.staff.status.${status}`), parts };
    }
    case 'service.request':
      return { event: t('tables.hist.request', { type: t(`service.${str(a.type) ?? 'call_staff'}`) }), parts };
    case 'service.acknowledged':
    case 'service.completed':
    case 'service.cancelled':
      parts.push(t(`service.${str(a.type) ?? 'call_staff'}`));
      return { event: t(`service.status.${e.action.slice(8)}`), parts };
    case 'portion.quote':
    case 'portion.requote': {
      const g = num(a.grams);
      const amt = num(a.amount_minor);
      if (g !== null) parts.push(t('billing.grams', { g }));
      if (amt !== null) parts.push(money(amt));
      return { event: t(e.action === 'portion.quote' ? 'tables.hist.quote' : 'tables.hist.requote'), parts };
    }
    case 'bill.finalize': {
      const rev = num(a.revision_no);
      const total = num(a.total_minor);
      if (rev !== null) parts.push(t('billing.revision', { n: rev }));
      if (total !== null) parts.push(money(total));
      return { event: t('tables.hist.finalised'), parts };
    }
    case 'bill.adjust': {
      const amt = num(a.amount_minor);
      const kind = str(a.kind);
      if (kind) parts.push(t(`billing.adjust.kind.${kind}`));
      if (amt !== null) parts.push(money(amt, { sign: true }));
      return { event: t('tables.hist.adjusted'), parts };
    }
    case 'payment.confirm': {
      const amt = num(a.amount_minor);
      if (amt !== null) parts.push(money(amt));
      const change = num(a.change_minor);
      if (change) parts.push(t('billing.payment.change', { amount: money(change) }));
      return { event: t('tables.hist.paid'), parts };
    }
    default: {
      const key = SIMPLE[e.action];
      if (key) return { event: t(key), parts };
      return { event: e.action.replace(/[._]/g, ' '), parts };
    }
  }
}

export function historyItems(entries: AuditEntryDTO[], t: T): HistoryItem[] {
  return [...entries].reverse().map((e) => {
    const { event, parts } = describe(e, t);
    if (e.reason && e.action !== 'visit.access_revoked') parts.push(e.reason);
    const who = e.actor_type === 'system' ? t('common.audit.system') : e.actor_label;
    if (who) parts.push(who);
    return { id: String(e.id), time: clock(e.at), event, detail: parts.join(' · ') || undefined };
  });
}
