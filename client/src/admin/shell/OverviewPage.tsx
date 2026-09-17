// /admin overview (brief 17, 33): what needs action now, how the floor looks,
// and whether anything is blocking guest orders. Numbers only, each one a way
// into the destination that deals with it. No decorative charts.
import { useId, type ReactNode } from 'react';
import type { OverviewDTO, StaffOrderingDTO } from '../../../../shared/dto.ts';
import type { Permission } from '../../../../shared/permissions.ts';
import { TABLE_STATES, type TableState } from '../../../../shared/status.ts';
import { elapsed, num } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { linkHandler } from '../../lib/router.ts';
import { useNow } from '../../lib/store.ts';
import {
  Button, EmptyState, Icon, KeyValue, LinkButton, Skeleton, STATE_SWATCH, type IconName,
} from '../../ui/index.ts';
import { useAttention } from './attention.tsx';
import { useLayoutMode } from './layout-mode.ts';
import { useOrderingActions, useStaffOrdering } from './ordering.tsx';
import { useStaff } from './session.tsx';

/** Minutes after which the oldest wait is written in the warm "late" tone (words carry it too). */
const WAIT_WARN_MIN = 5;

interface CardSpec {
  id: string;
  icon: IconName;
  label: string;
  value: number;
  detail: ReactNode;
  href: string | null;
  go: string;
  urgent: boolean;
}

export default function OverviewPage() {
  const { t, lang } = useI18n();
  const { can, canAny } = useStaff();
  const attention = useAttention();
  const staffOrdering = useStaffOrdering();
  const now = useNow(15_000);
  const data = attention.data;

  if (!data) {
    if (attention.error) {
      const denied = attention.error.code === 'forbidden';
      return (
        <div className="aover">
          <EmptyState
            icon={denied ? 'lock' : 'alert'}
            headingLevel={2}
            title={denied ? t('overview.denied') : t('overview.loadFailed')}
            action={denied ? undefined : (
              <Button variant="primary" size="staff" icon="refresh" onClick={() => void attention.refresh()}>
                {t('common.retry')}
              </Button>
            )}
          >
            {t(`error.${attention.error.code}`)}
          </EmptyState>
        </div>
      );
    }
    return <OverviewSkeleton />;
  }

  // Elapsed times use the server's clock, whatever this device's clock says.
  const skew = attention.fetchedAt ? Date.parse(data.server_time) - attention.fetchedAt : 0;
  const serverNow = now + skew;
  const minutesSince = (iso: string) => Math.floor((serverNow - Date.parse(iso)) / 60_000);
  const since = (iso: string) => elapsed(iso, serverNow, lang);

  const cards = actionCards(data, { t, can, since, minutesSince });
  const waiting = cards.reduce((n, c) => n + c.value, 0);

  return (
    <div className="aover">
      {attention.stale ? (
        <p className="aover__stale" role="status">
          <Icon name="refresh" size="sm" />
          {t('overview.stale')}
          <Button variant="ghost" size="md" onClick={() => void attention.refresh()}>{t('common.retry')}</Button>
        </p>
      ) : null}

      <section className="aover__sec" aria-labelledby="ov-now">
        <div className="aover__head">
          <h2 id="ov-now">{t('overview.now')}</h2>
          <p>{waiting === 0 ? t('overview.nowClear') : t('overview.nowHint')}</p>
        </div>
        <ul className="aover__cards">
          {cards.map((c) => <ActionCard key={c.id} card={c} />)}
        </ul>
      </section>

      <div className="aover__pair">
        <TablesSection counts={data.counts} canOpen={can('tables.view')} />
        <OrderingSection data={data} detail={staffOrdering.data} />
      </div>

      <Shortcuts canAny={canAny} />
    </div>
  );
}

// ---------------------------------------------------------------- action cards
function actionCards(
  d: OverviewDTO,
  { t, can, since, minutesSince }: {
    t: (k: string, v?: Record<string, string | number>) => string;
    can: (p: Permission) => boolean;
    since: (iso: string) => string;
    minutesSince: (iso: string) => number;
  },
): CardSpec[] {
  const cards: CardSpec[] = [];
  const late = d.oldest_unaccepted_at ? minutesSince(d.oldest_unaccepted_at) >= WAIT_WARN_MIN : false;
  cards.push({
    id: 'rounds',
    icon: 'orders',
    label: t('overview.card.rounds'),
    value: d.unaccepted_rounds,
    detail: d.unaccepted_rounds > 0 && d.oldest_unaccepted_at
      ? <span className={late ? 'aover__late' : undefined}>{t('overview.card.roundsOldest', { time: since(d.oldest_unaccepted_at) })}</span>
      : t('overview.card.roundsNone'),
    href: '/admin/orders',
    go: t('overview.go.board'),
    urgent: d.unaccepted_rounds > 0,
  });
  cards.push({
    id: 'ready',
    icon: 'cloche',
    label: t('overview.card.ready'),
    value: d.ready_lines,
    detail: d.ready_lines > 0 ? t('overview.card.readyHint') : t('overview.card.readyNone'),
    // Opens the Ready status directly on tablets and phones (one status at a time).
    href: '/admin/orders?stage=ready',
    go: t('overview.go.board'),
    urgent: d.ready_lines > 0,
  });
  if (can('service.handle')) {
    cards.push({
      id: 'requests',
      icon: 'hand',
      label: t('overview.card.requests'),
      value: d.open_requests,
      detail: d.open_requests > 0 && d.oldest_request_at
        ? <span className={minutesSince(d.oldest_request_at) >= WAIT_WARN_MIN ? 'aover__late' : undefined}>{t('overview.card.requestsOldest', { time: since(d.oldest_request_at) })}</span>
        : t('overview.card.requestsNone'),
      href: '/admin/orders/requests',
      go: t('overview.go.requests'),
      urgent: d.open_requests > 0,
    });
  }
  if (can('portions.quote')) {
    cards.push({
      id: 'portions',
      icon: 'scale',
      label: t('overview.card.portions'),
      value: d.open_portion_requests,
      detail: d.open_portion_requests > 0 ? t('overview.card.portionsHint') : t('overview.card.portionsNone'),
      href: '/admin/orders/requests',
      go: t('overview.go.requests'),
      urgent: false,
    });
  }
  if (can('tables.view')) {
    cards.push({
      id: 'bills',
      icon: 'receipt',
      label: t('overview.card.bills'),
      value: d.bills_requested,
      detail: d.bills_requested > 0 ? t('overview.card.billsHint') : t('overview.card.billsNone'),
      href: '/admin/tables',
      go: t('overview.go.tables'),
      urgent: d.bills_requested > 0,
    });
  }
  return cards;
}

function ActionCard({ card }: { card: CardSpec }) {
  const id = useId();
  const quiet = card.value === 0;
  return (
    <li className={`acard${card.urgent ? ' acard--urgent' : ''}${quiet ? ' acard--quiet' : ''}`}>
      <h3 className="acard__k" id={id}>
        <Icon name={card.icon} size="sm" />
        {card.href ? (
          <a className="acard__link" href={card.href} onClick={linkHandler} aria-describedby={`${id}-v ${id}-d`}>
            {card.label}
          </a>
        ) : card.label}
      </h3>
      <p className="acard__v" id={`${id}-v`}>{num(card.value)}</p>
      <p className="acard__d" id={`${id}-d`}>{card.detail}</p>
      {card.href ? (
        <span className="acard__go" aria-hidden="true">
          {card.go}
          <Icon name="chev-r" size="sm" />
        </span>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------- tables
function TablesSection({ counts, canOpen }: { counts: Record<TableState, number>; canOpen: boolean }) {
  const { t } = useI18n();
  const total = TABLE_STATES.reduce((n, s) => n + counts[s], 0);
  const sum = TABLE_STATES.map((s) => counts[s]).join(' + ');
  return (
    <section className="aover__sec aover__panel" aria-labelledby="ov-tables">
      <div className="aover__head">
        <h2 id="ov-tables">{t('overview.tables.title')}</h2>
        {canOpen ? (
          <LinkButton href="/admin/tables" variant="ghost" size="staff" iconEnd="chev-r" className="aover__more">
            {t('overview.go.tables')}
          </LinkButton>
        ) : null}
      </div>
      <ul className="aover__states">
        {TABLE_STATES.map((s) => (
          <li key={s} className={`aover__state aover__state--${s}`}>
            <span className="aover__state-k">
              <i className={`sw sw--${STATE_SWATCH[s]}`} aria-hidden="true" />
              {t(`table.${s}`)}
            </span>
            <b className="aover__state-v">{num(counts[s])}</b>
          </li>
        ))}
      </ul>
      <p className="aover__sum">
        {t('overview.tables.total', { n: total })}
        <span className="aover__sum-eq" aria-hidden="true"> = {sum}</span>
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- guest ordering
function OrderingSection({ data, detail }: { data: OverviewDTO; detail: StaffOrderingDTO | undefined }) {
  const { t, pick } = useI18n();
  const o = useOrderingActions();
  // Wider layouts carry Pause…/Resume… in the workspace header already.
  const inlineAction = useLayoutMode() === 'bar';
  const paused = !data.ordering.enabled;
  const message = pick(data.ordering.paused_message);
  const blockers = data.blockers.filter((b) => b !== 'demo_mode');
  const demo = data.blockers.includes('demo_mode');
  const wait = data.ordering.estimated_wait_minutes;

  const hours = data.ordering.within_hours === null ? t('overview.ordering.hoursOff')
    : data.ordering.within_hours ? t('overview.ordering.hoursIn') : t('overview.ordering.hoursOut');

  const items = [
    { term: t('overview.ordering.backlog'), value: detail ? num(detail.backlog) : num(data.unaccepted_rounds) },
    {
      term: t('overview.ordering.limit'),
      value: detail ? (detail.intake_limit === null ? t('overview.ordering.noLimit') : t('overview.ordering.limitValue', { n: detail.intake_limit })) : '—',
      muted: !detail || detail.intake_limit === null,
    },
    { term: t('overview.ordering.wait'), value: wait ? t('admin.paused.waitValue', { n: wait }) : t('overview.ordering.noWait'), muted: !wait },
    { term: t('overview.ordering.hours'), value: hours, muted: data.ordering.within_hours === null },
  ];

  return (
    <section className={`aover__sec aover__panel aover__ordering${paused ? ' is-paused' : ''}`} aria-labelledby="ov-ordering">
      <div className="aover__head">
        <h2 id="ov-ordering">{t('common.staff.guestOrdering')}</h2>
      </div>
      <div className="aover__okline">
        <p className={`aover__okstate${paused ? ' is-paused' : ''}`}>
          <Icon name={paused ? 'pause' : 'check'} size="sm" bold />
          <b>{paused ? t('overview.ordering.paused') : t('overview.ordering.open')}</b>
        </p>
        {o.canChange && inlineAction ? (
          paused ? (
            <Button variant="primary" size="staff" opensDialog onClick={o.openResume} loading={o.busy}>{t('common.staff.resume')}</Button>
          ) : (
            <Button variant="outline" size="staff" icon="pause" opensDialog onClick={o.openPause} loading={o.busy}>{t('common.staff.pause')}</Button>
          )
        ) : null}
      </div>
      {paused ? (
        <div className="aover__pausenote">
          {o.pausedDetail ? <p className="aover__by">{t('overview.ordering.pausedBy', { detail: o.pausedDetail })}</p> : null}
          {message.text ? (
            <p>
              {t('admin.paused.guestsSee')}{' '}
              <q lang={message.lang}>{message.text}</q>
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="aover__blockers">
        <h3 className="aover__h3">{t('overview.ordering.blockersTitle')}</h3>
        {blockers.length === 0 ? (
          <p className="aover__none"><Icon name="check-c" size="sm" />{t('overview.ordering.noBlockers')}</p>
        ) : (
          <ul className="aover__blist">
            {blockers.map((b) => (
              <li key={b}>
                <Icon name="alert" size="sm" />
                <span>
                  <b>{t(`overview.blocker.${b}`)}</b>
                  {' '}
                  {b === 'intake_full'
                    ? (detail?.intake_limit
                      ? t('overview.blocker.intake_full_detail', { n: detail.backlog, limit: detail.intake_limit })
                      : t('overview.blocker.intake_full_generic'))
                    : t(`overview.blocker.${b}_detail`)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {demo ? <p className="aover__demo"><span className="demo">{t('common.demoData')}</span>{t('overview.blocker.demo_mode')}</p> : null}
      </div>

      <KeyValue items={items} className="aover__kv" />
    </section>
  );
}

// ---------------------------------------------------------------- shortcuts
function Shortcuts({ canAny }: { canAny: (ps: readonly Permission[]) => boolean }) {
  const { t } = useI18n();
  const links: Array<{ href: string; label: string }> = [];
  if (canAny(['menu.availability'])) links.push({ href: '/admin/menu', label: t('overview.link.availability') });
  if (canAny(['stats.view'])) links.push({ href: '/admin/stats/orders', label: t('overview.link.stats') });
  if (canAny(['payments.view'])) links.push({ href: '/admin/payments', label: t('overview.link.payments') });
  if (canAny(['reports.view'])) links.push({ href: '/admin/reports', label: t('overview.link.reports') });
  if (links.length === 0) return null;
  return (
    <nav className="aover__links" aria-label={t('overview.link.label')}>
      <span className="aover__links-k">{t('overview.link.label')}</span>
      {links.map((l) => (
        <a key={l.href} href={l.href} onClick={linkHandler} className="aover__link">
          {l.label}
          <Icon name="chev-r" size="sm" />
        </a>
      ))}
    </nav>
  );
}

function OverviewSkeleton() {
  const { t } = useI18n();
  return (
    <div className="aover" role="status" aria-live="polite">
      <span className="visually-hidden">{t('common.loading')}</span>
      <div aria-hidden="true" className="aover__sec">
        <Skeleton width={260} height={28} />
        <ul className="aover__cards">
          {[0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="acard acard--quiet"><Skeleton width="70%" height={18} /><Skeleton width={56} height={40} /><Skeleton width="80%" height={14} /><Skeleton width={96} height={16} /></li>
          ))}
        </ul>
      </div>
      <div aria-hidden="true" className="aover__pair">
        <div className="aover__panel"><Skeleton shape="block" height={180} /></div>
        <div className="aover__panel"><Skeleton shape="block" height={180} /></div>
      </div>
    </div>
  );
}
