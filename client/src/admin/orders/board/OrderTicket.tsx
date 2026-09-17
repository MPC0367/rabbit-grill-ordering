// One staff round as a kit Ticket: lines with chips, weight, notes and per-line
// state, the allergy band, and the one counted action for its column.
import { memo } from 'react';
import type { OrderLineDTO, StaffOrderDTO } from '../../../../../shared/dto.ts';
import type { Permission } from '../../../../../shared/permissions.ts';
import type { LineStatus } from '../../../../../shared/status.ts';
import { clock, grams, money } from '../../../lib/format.ts';
import { useI18n } from '../../../lib/i18n.tsx';
import {
  Ticket, type BoardStage, type TicketAction, type TicketChip, type TicketFlagSpec, type TicketLineData,
} from '../../../ui/index.ts';
import { LATE_AFTER_MINUTES, minutesSince, staffName, sumQty, textLang, tn } from '../support.ts';
import { lastStep, readyPartOf, readySince, stageLines, STAGE_ACTION, tableOf, type Placement } from './model.ts';

type Pick = ReturnType<typeof useI18n>['pick'];
type T = ReturnType<typeof useI18n>['t'];

const DONENESS = /doneness|ความสุก/i;

/** Staff-confirmation snapshot on a line, once the server sends it (D-FX-OPS-02). */
type ConfirmFields = { requires_staff_confirm?: boolean; alcohol?: boolean };

/** The server snapshots the staff-confirmation flag on every line. */
export function linesCarryConfirm(lines: readonly OrderLineDTO[]): boolean {
  return lines.every((l) => typeof (l as OrderLineDTO & ConfirmFields).requires_staff_confirm === 'boolean');
}

/**
 * How a line shows staff confirmation. With the line snapshot: alcohol lines
 * that need it get the kit's "Alcohol · staff to confirm" row, other flagged
 * dishes a "Staff to confirm" chip, and nothing when the owner turned it off.
 * Older payloads fall back to the live menu's alcohol flag.
 */
export function staffConfirmOf(l: OrderLineDTO, alcoholItems: ReadonlySet<string>): { alcohol: boolean; chip: boolean } {
  const f = l as OrderLineDTO & ConfirmFields;
  if (typeof f.requires_staff_confirm !== 'boolean') return { alcohol: alcoholItems.has(l.item_id), chip: false };
  if (!f.requires_staff_confirm) return { alcohol: false, chip: false };
  const isAlcohol = f.alcohol ?? alcoholItems.has(l.item_id);
  return { alcohol: isAlcohol, chip: !isAlcohol };
}

function lineChips(l: OrderLineDTO, pick: Pick, extra: TicketChip[]): TicketChip[] {
  const chips: TicketChip[] = [];
  if (l.variant_name) {
    const v = pick(l.variant_name);
    if (v.text) chips.push({ label: v.text, lang: v.lang });
  }
  for (const g of l.modifiers) {
    const group = `${g.group.en ?? ''} ${g.group.th ?? ''}`;
    // Doneness chosen per steak: one chip per choice with its count (DESIGN §10.16).
    const counts = new Map<string, { label: string; lang: string; n: number }>();
    for (const o of g.options) {
      const p = pick(o.name);
      const key = `${p.lang}:${p.text}`;
      const cur = counts.get(key);
      if (cur) cur.n += 1;
      else counts.set(key, { label: p.text, lang: p.lang, n: 1 });
    }
    const split = DONENESS.test(group) && l.quantity > 1 && g.options.length === l.quantity;
    for (const c of counts.values()) {
      chips.push({ label: c.label, lang: c.lang, quantity: c.n > 1 || split ? c.n : undefined });
    }
  }
  return [...chips, ...extra];
}

export function toTicketLine(
  l: OrderLineDTO,
  opts: { t: T; pick: Pick; lang: string; showMoney: boolean; alcohol: boolean; confirmChip?: boolean; allergyChip: boolean; confirmedAt?: string },
): TicketLineData {
  const n = staffName(l.name);
  const last = lastStep(l);
  const extra: TicketChip[] = opts.allergyChip ? [{ label: opts.t('orders.line.allergyChip'), lang: opts.lang }] : [];
  if (opts.confirmChip) extra.push({ label: opts.t('orders.line.staffConfirm'), lang: opts.lang });
  let weight: TicketLineData['weight'];
  if (l.measured_grams !== null) {
    const g = grams(l.measured_grams, opts.lang === 'th' ? 'th' : 'en');
    weight = { text: opts.showMoney ? `${g} · ${money(l.line_total_minor)}` : g, confirmedAt: opts.confirmedAt };
  }
  return {
    id: l.id,
    quantity: l.quantity,
    name: n.text,
    nameLang: n.lang,
    secondary: n.secondary ?? undefined,
    secondaryLang: 'en',
    noThaiName: n.noThai,
    chips: lineChips(l, opts.pick, extra),
    weight,
    alcohol: opts.alcohol,
    // The allergy words already lead the ticket in the band; other notes stay on their dish.
    note: l.allergy_flag ? undefined : l.note ?? undefined,
    noteLang: l.note ? textLang(l.note) : undefined,
    status: l.status,
    statusAt: last ? clock(last.at) : undefined,
    actor: last?.actor ?? undefined,
    reason: l.status_reason ?? undefined,
  };
}

export interface OrderTicketProps {
  order: StaffOrderDTO;
  /** Lines for the current station filter. */
  lines: OrderLineDTO[];
  placement: Placement;
  now: number;
  flags: TicketFlagSpec[];
  /** First render after arriving live: the outline animates once. */
  fresh: boolean;
  busy: 'primary' | 'secondary' | null;
  conflict: { by: string; at: string } | null;
  alcoholItems: ReadonlySet<string>;
  showMoney: boolean;
  can: (p: Permission) => boolean;
  onAdvance: (order: StaffOrderDTO, lines: OrderLineDTO[], to: LineStatus, which: 'primary' | 'secondary') => void;
  onMore: (order: StaffOrderDTO) => void;
  onReview: (orderId: string) => void;
  onFinish?: (order: StaffOrderDTO) => void;
  readOnly?: boolean;
}

function OrderTicketInner({
  order, lines, placement, now, flags, fresh, busy, conflict, alcoholItems, showMoney, can,
  onAdvance, onMore, onReview, onFinish, readOnly,
}: OrderTicketProps) {
  const { t, pick, lang, has } = useI18n();
  const allergyLines = lines.filter((l) => l.allergy_flag && l.note);
  const allergyText = [...new Set(allergyLines.map((l) => l.note!.trim()))].join(' · ');
  const activeCount = lines.filter((l) => l.status !== 'rejected' && l.status !== 'cancelled').length;
  const confirmedAt = order.source === 'portion_quote' && !order.staff_name ? clock(order.submitted_at) : undefined;
  const ticketLines = lines.map((l) => {
    const confirm = staffConfirmOf(l, alcoholItems);
    return toTicketLine(l, {
      t, pick, lang, showMoney,
      alcohol: confirm.alcohol,
      confirmChip: confirm.chip,
      allergyChip: l.allergy_flag && activeCount > 1,
      confirmedAt: l.measured_grams !== null ? confirmedAt : undefined,
    });
  });

  const stage: LineStatus = placement === 'void'
    ? (lines.every((l) => l.status === 'rejected') ? 'rejected' : 'cancelled')
    : placement;
  const readyAt = placement === 'ready' ? readySince(lines) : null;
  const wait = readyAt ? minutesSince(readyAt, now) : minutesSince(order.submitted_at, now);
  const finished = placement === 'served' || placement === 'void';
  // The kit's own late flag ("Longer than usual · over 20 min") wraps in a 216 px column: a short one on one line.
  const lateFlag: TicketFlagSpec | null = !finished && placement !== 'ready' && wait > LATE_AFTER_MINUTES && !flags.some((f) => f.kind === 'late')
    ? { kind: 'late', label: t('orders.flag.late', { n: LATE_AFTER_MINUTES }) }
    : null;

  let primary: TicketAction | null = null;
  let secondary: TicketAction | null = null;
  if (!readOnly && !finished) {
    const stageKey = placement as BoardStage;
    const spec = STAGE_ACTION[stageKey];
    const targets = stageLines(lines, stageKey);
    const count = sumQty(targets);
    // Dishes already at the pass on a round that sits in an earlier column:
    // serving them is one tap from the card (D-FX-OPS-01).
    const readyPart = readyPartOf(lines, placement);
    const readyCount = sumQty(readyPart);
    const serveReady: TicketAction | null = readyPart.length > 0 && can('orders.serve')
      ? {
          label: t('orders.act.serveReady'),
          count: readyCount,
          icon: 'check',
          busy: busy === 'secondary',
          disabled: busy !== null,
          ariaLabel: tn({ t, has }, 'orders.act.aria', readyCount, { action: t('orders.act.serveReadyAria'), table: tableOf(order) }),
          onClick: () => onAdvance(order, readyPart, 'served', 'secondary'),
        }
      : null;
    secondary = serveReady;
    if (can(spec.permission)) {
      primary = {
        label: t(spec.label),
        count,
        icon: spec.icon,
        busy: busy === 'primary',
        disabled: busy !== null,
        ariaLabel: tn({ t, has }, 'orders.act.aria', count, { action: t(spec.label), table: tableOf(order) }),
        onClick: () => onAdvance(order, targets, spec.to, 'primary'),
      };
      // Almost done is optional: food waiting at the pass takes its place (the ⋯ panel still has it).
      if (stageKey === 'preparing' && !serveReady) {
        secondary = {
          label: t('orders.act.almost'),
          count,
          busy: busy === 'secondary',
          disabled: busy !== null,
          ariaLabel: tn({ t, has }, 'orders.act.aria', count, { action: t('orders.act.almost'), table: tableOf(order) }),
          onClick: () => onAdvance(order, targets, 'almost_done', 'secondary'),
        };
      }
    } else {
      // Visible reason instead of a silent missing button; still focusable (aria-disabled).
      primary = { label: t(spec.denied), icon: 'lock', disabled: true, ariaLabel: t(spec.denied) };
    }
  } else if (!readOnly && placement === 'served' && onFinish) {
    primary = can('orders.serve')
      ? { label: t('orders.act.finish'), icon: 'check', disabled: busy !== null, busy: busy === 'primary', onClick: () => onFinish(order) }
      : null;
  }

  return (
    <Ticket
      id={`ticket-${order.id}`}
      data-order={order.id}
      className={fresh ? undefined : 'is-seen'}
      table={tableOf(order)}
      reference={order.reference}
      round={order.round_no}
      time={clock(readyAt ?? order.submitted_at)}
      timeKind={readyAt ? 'ready' : 'sent'}
      waitMinutes={finished ? null : wait}
      lateAfterMinutes={placement === 'ready' || finished ? null : LATE_AFTER_MINUTES}
      stage={stage}
      flags={lateFlag ? [lateFlag, ...flags] : flags}
      allergy={allergyText ? { text: allergyText, lang: textLang(allergyText) } : null}
      lines={ticketLines}
      lineStatus={finished ? 'always' : 'auto'}
      isNew={placement === 'submitted'}
      primary={primary}
      secondary={secondary}
      onMore={() => onMore(order)}
      moreLabel={t('orders.ticket.moreAria', {
        label: placement === 'submitted' ? t('common.ticket.detailsReject') : t('common.ticket.details'),
        table: tableOf(order),
        round: order.round_no,
      })}
      conflict={conflict ? { by: conflict.by, at: clock(conflict.at), onReview: () => onReview(order.id) } : null}
    />
  );
}

export const OrderTicket = memo(OrderTicketInner);
