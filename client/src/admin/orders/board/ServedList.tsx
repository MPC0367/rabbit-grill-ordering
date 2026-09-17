// Rounds whose dishes are all served (or resolved) but nobody pressed Finish
// order yet. Compact rows under the pass: Finish order never closes a table.
import type { StaffOrderDTO } from '../../../../../shared/dto.ts';
import type { Permission } from '../../../../../shared/permissions.ts';
import { clock } from '../../../lib/format.ts';
import { useI18n } from '../../../lib/i18n.tsx';
import { Button, IconButton } from '../../../ui/index.ts';
import { sumQty, tn } from '../support.ts';
import { lastChange, tableOf } from './model.ts';

export function ServedList({ orders, can, busy, onFinish, onMore }: {
  orders: StaffOrderDTO[];
  can: (p: Permission) => boolean;
  busy: Record<string, unknown>;
  onFinish: (o: StaffOrderDTO) => void;
  onMore: (o: StaffOrderDTO) => void;
}) {
  const { t, lang, has } = useI18n();
  if (orders.length === 0) return null;
  return (
    <section className="served" aria-labelledby="served-h">
      <h3 id="served-h" className="served__h" lang={lang}>
        {t('orders.served.title')} <span className="served__n">{orders.length}</span>
      </h3>
      <ul className="served__list">
        {orders.map((o) => {
          const served = o.lines.filter((l) => l.status === 'served');
          const last = lastChange(o);
          return (
            <li key={o.id} className="served__row">
              <span className="served__tno" aria-hidden="true">{tableOf(o)}</span>
              <span className="served__txt">
                <b>
                  <span className="sr">{t('common.table', { label: tableOf(o) })} · </span>
                  <span lang="en" className="served__ref">{o.reference}</span> · {t('common.ticket.round', { n: o.round_no })}
                </b>
                <span>{tn({ t, has }, 'orders.served.line', sumQty(served), { time: last ? clock(last.at) : '' })}</span>
              </span>
              <span className="served__acts">
                {can('orders.serve') ? (
                  <Button
                    variant="outline"
                    size="staff"
                    icon="check"
                    opensDialog
                    aria-disabled={Boolean(busy[o.id]) || undefined}
                    aria-label={t('orders.served.finishAria', { ref: o.reference, table: tableOf(o) })}
                    onClick={() => onFinish(o)}
                  >
                    {t('orders.act.finish')}
                  </Button>
                ) : null}
                <IconButton
                  icon="more"
                  variant="framed"
                  size="staff"
                  opensDialog
                  label={t('orders.served.detailsAria', { ref: o.reference })}
                  onClick={() => onMore(o)}
                />
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
