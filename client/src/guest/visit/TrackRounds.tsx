// Round views for Track: the live RoundCard (parcel timeline + per-dish
// lines) and the collapsed line for earlier, fully served rounds.
import { forwardRef } from 'react';
import type { OrderDTO, OrderLineDTO } from '../../../../shared/dto.ts';
import { isActive } from '../../../../shared/status.ts';
import { clock, grams } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import {
  DishLines, DishStatusLine, PastRound, RoundCard, Tag, Timeline,
  type DishImageSource,
} from '../../ui/index.ts';
import { useCatalog } from '../shell/catalog.tsx';
import { isFinished, itemCount, lineReached, lineTrail, orderState, orderTimeline, summaryParts } from './lib.ts';

/** Dish name in the reading language, with the variant, the weighed grams and the fallback marker. */
export function LineName({ line, marker = true }: { line: Pick<OrderLineDTO, 'name' | 'variant_name' | 'measured_grams'>; marker?: boolean }) {
  const { t, pick, lang } = useI18n();
  const name = pick(line.name);
  const variant = line.variant_name ? pick(line.variant_name) : null;
  return (
    <>
      <span lang={name.lang}>{name.text}</span>
      {variant && variant.text ? <span className="meta vfallback" lang={variant.lang}>· {variant.text}</span> : null}
      {line.measured_grams ? <span className="meta vfallback">· {grams(line.measured_grams, lang)}</span> : null}
      {marker && name.fallback && name.text && lang === 'th' ? <span className="venonly" lang="th">{t('common.enOnly')}</span> : null}
    </>
  );
}

function useLineViews(order: OrderDTO) {
  const { t } = useI18n();
  const { item } = useCatalog();
  return order.lines.map((line) => {
    const view = lineTrail(t, line, order.submitted_at);
    const image = (item(line.item_id)?.image ?? null) as DishImageSource | null;
    return (
      <DishStatusLine
        key={line.id}
        name={<LineName line={line} />}
        quantity={line.quantity}
        image={image}
        status={line.status}
        prep={line.prep_kind}
        at={view.at}
        trail={view.trail}
        skipped={view.skipped}
        reason={line.status_reason}
        data-line={line.id}
        data-status={line.status}
      />
    );
  });
}

function RoundMeta({ order }: { order: OrderDTO }) {
  const { t } = useI18n();
  const n = itemCount(order);
  const items = t(n === 1 ? 'common.itemOne' : 'common.items', { n });
  const source = order.source === 'staff' || order.source === 'manual_recovery'
    ? t('track.byStaff')
    : order.source === 'portion_quote' ? t('track.byPortion') : null;
  return (
    <>
      <span>{t('track.meta', { time: clock(order.submitted_at), items, label: order.table_label })}</span>
      <span className="vmeta2">
        {t('track.updated', { time: clock(order.last_update_at) })}
        {order.mine || source ? (
          <span className="vtag-row">
            {order.mine ? <Tag tone="line" icon="user">{t('track.mine')}</Tag> : null}
            {source ? <Tag tone="neutral">{source}</Tag> : null}
          </span>
        ) : null}
      </span>
    </>
  );
}

export interface RoundViewProps {
  order: OrderDTO;
  /** A committed staff event changed this data: let the timeline animate its new step once. */
  animate: boolean;
  highlight?: boolean;
}

export const RoundView = forwardRef<HTMLElement, RoundViewProps>(function RoundView({ order, animate, highlight }, ref) {
  const { t } = useI18n();
  const timeline = orderTimeline(t, order);
  const state = orderState(t, order);
  const lines = useLineViews(order);
  const summary = summaryParts(t, order.lines, { exceptions: true }).join(' · ');
  return (
    <RoundCard
      ref={ref}
      id={`round-${order.reference}`}
      tabIndex={-1}
      data-round={order.round_no}
      data-status={order.status}
      title={t('track.round', { n: order.round_no })}
      meta={<RoundMeta order={order} />}
      reference={order.reference}
      stateTitle={state.title}
      stateMessage={state.message}
      highlight={highlight}
      footnote={timeline ? undefined : null}
      dishes={(
        <DishLines title={t('track.dishes')} summary={summary}>
          {lines}
        </DishLines>
      )}
    >
      {timeline ? (
        <Timeline steps={timeline.steps} label={t('track.progress', { n: order.round_no })} animate={animate} />
      ) : null}
    </RoundCard>
  );
});

export function PastRoundView({ order }: { order: OrderDTO }) {
  const { t } = useI18n();
  const { item } = useCatalog();
  const lines = useLineViews(order);
  const servedTimes = order.lines
    .filter((l) => l.status === 'served')
    .map((l) => lineReached(l, order.submitted_at).served)
    .filter((x): x is string => Boolean(x));
  const servedAt = servedTimes.length ? servedTimes.reduce((a, b) => (b > a ? b : a)) : order.last_update_at;
  const images: DishImageSource[] = [];
  const seen = new Set<string>();
  for (const l of order.lines) {
    if (!isActive(l.status)) continue;
    const img = item(l.item_id)?.image;
    if (img && !seen.has(img.name)) { seen.add(img.name); images.push(img); }
  }
  const withoutPhoto = order.lines.filter((l) => isActive(l.status)).length - images.length;
  const n = itemCount(order);
  const items = t(n === 1 ? 'common.itemOne' : 'common.items', { n });
  const exceptions = summaryParts(t, order.lines.filter((l) => !isActive(l.status)), { exceptions: true });
  return (
    <PastRound
      id={`round-${order.reference}`}
      data-round={order.round_no}
      data-status={order.status}
      title={<>{t('track.past.served', { time: clock(servedAt) })}</>}
      meta={(
        <>
          {t('track.past.meta', { n: order.round_no })} · <span className="vref" lang="en">{order.reference}</span>
          {' · '}{t('track.past.sent', { time: clock(order.submitted_at) })} · {items}
          {exceptions.length ? ` · ${exceptions.join(' · ')}` : ''}
          {order.mine ? ` · ${t('track.mine')}` : ''}
        </>
      )}
      thumbs={images}
      extra={Math.max(0, withoutPhoto)}
    >
      <ul className="vpast-list">{lines}</ul>
    </PastRound>
  );
}

/** The visible marker for an English name shown to a Thai reader. */
export function EnOnlyMark({ name }: { name: OrderLineDTO['name'] }) {
  const { t, pick, lang } = useI18n();
  const p = pick(name);
  if (!(p.fallback && p.text && lang === 'th')) return null;
  return <p className="vreceipt__sub" lang="th">{t('common.enOnly')}</p>;
}

/** Collapse a round when every dish is served (never an exception-only round). */
export function collapses(order: OrderDTO): boolean {
  return isFinished(order) && order.lines.some((l) => l.status === 'served');
}
