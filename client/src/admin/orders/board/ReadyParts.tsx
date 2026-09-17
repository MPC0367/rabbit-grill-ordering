// Dishes waiting at the pass on rounds whose ticket sits in an earlier column
// (a round is placed by its least-advanced dish, D-C4b-01). Compact slips at
// the top of the Ready column: only the ready dishes, one Mark served for
// them, and a way to the full ticket (D-FX-OPS-01, brief 19, 35).
import type { OrderLineDTO, StaffOrderDTO } from '../../../../../shared/dto.ts';
import type { Permission } from '../../../../../shared/permissions.ts';
import { clock } from '../../../lib/format.ts';
import { useI18n } from '../../../lib/i18n.tsx';
import { Button, type BoardStage } from '../../../ui/index.ts';
import { minutesSince, staffName, sumQty, tn } from '../support.ts';
import { readySince, tableOf } from './model.ts';

export interface ReadyPart {
  order: StaffOrderDTO;
  /** Only the ready dishes (for the current station filter). */
  ready: OrderLineDTO[];
  /** Dishes of the same round (same filter) that are not at the pass yet. */
  rest: OrderLineDTO[];
  /** The column the full ticket sits in. */
  placement: BoardStage;
}

export function ReadyPartList({ parts, now, can, busy, onServe, onShow }: {
  parts: ReadyPart[];
  now: number;
  can: (p: Permission) => boolean;
  busy: Record<string, unknown>;
  onServe: (part: ReadyPart) => void;
  onShow: (part: ReadyPart) => void;
}) {
  const { t, lang, has } = useI18n();
  if (parts.length === 0) return null;
  const canServe = can('orders.serve');
  return (
    <section className="passpart" aria-labelledby="passpart-h">
      <h3 id="passpart-h" className="served__h passpart__h" lang={lang}>
        {t('orders.part.title')} <span className="served__n">{parts.length}</span>
      </h3>
      <ul className="passpart__list">
        {parts.map((p) => {
          const o = p.order;
          const table = tableOf(o);
          const n = sumQty(p.ready);
          const since = readySince(p.ready);
          const waited = since ? minutesSince(since, now) : 0;
          const isBusy = Boolean(busy[o.id]);
          return (
            <li key={o.id} className="passpart__row" data-order={o.id}>
              <span className="served__tno" aria-hidden="true">{table}</span>
              <span className="served__txt">
                <b>
                  <span className="sr">{t('common.table', { label: table })} · </span>
                  <span lang="en" className="served__ref">{o.reference}</span> · {t('common.ticket.round', { n: o.round_no })}
                </b>
                <span>
                  {since ? t('orders.part.since', { time: clock(since) }) : null}
                  {since && waited >= 1 ? ` · ${t('orders.part.waited', { n: waited })}` : null}
                </span>
              </span>
              <ul className="passpart__dishes">
                {p.ready.map((l) => {
                  const name = staffName(l.name);
                  return (
                    <li key={l.id}>
                      <b className="passpart__q">{l.quantity}×</b>
                      <span lang={name.lang}>{name.text}</span>
                    </li>
                  );
                })}
              </ul>
              {p.rest.length > 0 ? (
                <p className="passpart__rest">
                  {tn({ t, has }, 'orders.part.rest', sumQty(p.rest), { status: t(`common.staff.status.${p.placement}`).toLowerCase() })}
                </p>
              ) : null}
              <span className="served__acts">
                {canServe ? (
                  <Button
                    variant="primary"
                    size="staff"
                    icon="check"
                    iconBold
                    count={n}
                    loading={isBusy}
                    aria-disabled={isBusy || undefined}
                    aria-label={tn({ t, has }, 'orders.act.aria', n, { action: t('orders.act.serve'), table })}
                    onClick={() => onServe(p)}
                  >
                    {t('orders.act.serve')}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="staff"
                  className="passpart__show"
                  iconEnd="chev-r"
                  aria-label={t('orders.part.showAria', { ref: o.reference, table })}
                  onClick={() => onShow(p)}
                >
                  {t('orders.part.show')}
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
