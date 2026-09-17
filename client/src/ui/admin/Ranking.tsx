// Menu Stats ranking (DESIGN.md §10.22): role="table" rows with rank numeral,
// plate, dish, servings + share meter, orders, visits, change in words, and
// the data-quality context ("Low count is not proof of low demand").
import { useId, useState, type HTMLAttributes, type ReactNode } from 'react';
import { num } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { cx, Ico, safeId } from './parts.tsx';

export type RankChange = { label: 'up' | 'down' | 'flat' | 'new' | 'no_baseline'; delta?: number | null };

export type RankContext =
  | { kind: 'available' }
  | { kind: 'partial'; availableDays: number; openDays: number }
  | { kind: 'sold_out'; soldOutDays: number; openDays: number }
  | { kind: 'by_weight'; total?: string }
  | { kind: 'never_ordered' }
  | { kind: 'insufficient' }
  | { kind: 'custom'; title: ReactNode; text?: ReactNode; tone?: 'ok' | 'alert' | 'neutral' };

export interface RankingRowProps {
  rank: number;
  /** Thumbnail URL (/media/dish/…-240.webp); null renders a text-led row without a plate. */
  image?: string | null;
  name: string;
  nameLang?: string;
  english?: string | null;
  category?: string;
  servings: number;
  /** "13%" (plus a unit note for by-weight rows: "5% · servings"). */
  shareText?: string;
  /** Meter width relative to the top row, 0..1. */
  bar?: number;
  orders: number;
  visits: number;
  change: RankChange;
  context: RankContext;
  /** Variant breakdown, expandable under the parent. */
  variants?: Array<{ name: string; lang?: string; servings: number }>;
  /** Thumbnail loading; rankings usually sit below the fold. */
  imageLoading?: 'lazy' | 'eager';
  className?: string;
}

export function Delta({ change, className }: { change: RankChange; className?: string }) {
  const { t, lang } = useI18n();
  const d = change.delta ?? 0;
  if (change.label === 'new') return <span className={cx('tag tag--ink', className)} lang={lang}>{t('common.stats.new')}</span>;
  if (change.label === 'no_baseline') return <span className={cx('delta', className)}><small>{t('common.stats.noBaseline')}</small></span>;
  if (change.label === 'flat' || d === 0) {
    return (
      <span className={cx('delta', className)}>
        <span aria-hidden="true">= 0</span>
        <small>{t('common.stats.noChange')}</small>
      </span>
    );
  }
  const up = change.label === 'up';
  return (
    <span className={cx('delta', up ? 'delta--up' : 'delta--down', className)}>
      <span aria-hidden="true">{up ? '▲' : '▼'} {Math.abs(d)}</span>
      <span className="sr">{up ? t('common.stats.up', { n: Math.abs(d) }) : t('common.stats.down', { n: Math.abs(d) })}</span>
    </span>
  );
}

function ContextCell({ context }: { context: RankContext }) {
  const { t } = useI18n();
  switch (context.kind) {
    case 'available':
      return <p className="rank__q"><b><Ico name="check-c" />{t('common.rank.available')}</b></p>;
    case 'partial':
      return <p className="rank__q"><b><Ico name="clock" />{t('common.rank.partial', { n: context.availableDays, m: context.openDays })}</b>{t('common.rank.lowCount')}</p>;
    case 'sold_out':
      return <p className="rank__q"><b className="is-alert"><Ico name="slash" />{t('common.rank.soldOut', { n: context.soldOutDays, m: context.openDays })}</b>{t('common.rank.lowCount')}</p>;
    case 'by_weight':
      return <p className="rank__q"><b><Ico name="scale" />{t('common.rank.byWeight')}</b>{context.total ? `${t('common.rank.byServings')} · ${context.total}` : t('common.rank.byServings')}</p>;
    case 'never_ordered':
      return <p className="rank__q"><b><Ico name="info" />{t('common.rank.never')}</b></p>;
    case 'insufficient':
      return <p className="rank__q"><b><Ico name="info" />{t('common.rank.insufficient')}</b></p>;
    default:
      return <p className="rank__q"><b className={context.tone === 'alert' ? 'is-alert' : undefined}>{context.title}</b>{context.text}</p>;
  }
}

export function RankingRow({
  rank, image, name, nameLang, english, category, servings, shareText, bar, orders, visits, change, context, variants,
  imageLoading = 'lazy', className,
}: RankingRowProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const varId = `rv-${safeId(useId())}`;
  const width = `${Math.round(Math.max(0, Math.min(1, bar ?? 0)) * 100)}%`;
  return (
    <>
      <div className={cx('rank', rank === 1 && 'is-first', !image && 'rank--textled', className)} role="row">
        <span className="rank__n" role="cell">
          <span aria-hidden="true">{String(rank).padStart(2, '0')}</span>
          <span className="sr">{t('common.rank.rankN', { n: rank })}</span>
        </span>
        <span className="rank__plate" role="cell" aria-hidden="true">
          {image ? <span className="plate"><img src={image} alt="" width={240} height={180} loading={imageLoading} decoding="async" /></span> : null}
        </span>
        <div className="rank__name" role="rowheader">
          <b lang={nameLang}>{name}</b>
          {english ? <span className="en" lang="en">{english}</span> : null}
          {category ? <span className="rank__cat">{english ? ' · ' : ''}{category}</span> : null}
          {variants && variants.length > 0 ? (
            <button type="button" className="rank__more" aria-expanded={open} aria-controls={varId} onClick={() => setOpen(!open)}>
              <Ico name="chev-d" size="xs" className={open ? 'is-open' : undefined} />
              {t('common.rank.variants', { n: variants.length })}
            </button>
          ) : null}
        </div>
        <div className="rank__qty" role="cell" data-label={t('common.rank.servings')}>
          <b>{num(servings)}{shareText ? <small>{shareText}</small> : null}</b>
          <span className="share" aria-hidden="true"><i style={{ width }} /></span>
        </div>
        <span className="rank__num rank__num--orders" role="cell" data-label={t('common.rank.orders')}>{num(orders)}</span>
        <span className="rank__num rank__num--visits" role="cell" data-label={t('common.rank.visits')}>{num(visits)}</span>
        <span className="rank__delta" role="cell"><Delta change={change} /></span>
        <div className="rank__ctx" role="cell"><ContextCell context={context} /></div>
      </div>
      {variants && variants.length > 0 ? (
        <div id={varId} hidden={!open} className="rank__variants">
          {variants.map((v) => (
            <div key={v.name} className="rank rank--variant" role="row">
              <span role="cell" />
              <span role="cell" />
              <span className="rank__name" role="rowheader"><span lang={v.lang}>{v.name}</span></span>
              <span className="rank__num rank__num--left" role="cell">{num(v.servings)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

export interface RankingTableProps extends HTMLAttributes<HTMLDivElement> {
  /** Accessible table name ("Most ordered dishes this week"). */
  label: string;
  /** Header for the change column ("vs last week" / "vs last month"). */
  changeHeader?: string;
  /** Footer row: honest counts ("Showing 6 of 34 …") and the Full ranking action. */
  footerText?: ReactNode;
  footerAction?: ReactNode;
  /** Explicit refresh or filter change: rows crossfade, never reorder under a finger. */
  refreshing?: boolean;
  empty?: ReactNode;
}

export function RankingTable({ label, changeHeader, footerText, footerAction, refreshing, empty, children, className, ...rest }: RankingTableProps) {
  const { t, lang } = useI18n();
  return (
    <div {...rest} className={cx('ranks', refreshing && 'is-refreshing', className)} role="table" aria-label={label} aria-busy={refreshing || undefined}>
      <div className="rank rank--head" role="row" lang={lang}>
        <span role="columnheader">{t('common.rank.rank')}</span>
        <span role="columnheader" />
        <span role="columnheader">{t('common.rank.dish')}</span>
        <span role="columnheader">{t('common.rank.servings')}</span>
        <span role="columnheader" className="n">{t('common.rank.orders')}</span>
        <span role="columnheader" className="n">{t('common.rank.visits')}</span>
        <span role="columnheader" className="rank__delta">{changeHeader ?? t('common.rank.change')}</span>
        <span role="columnheader">{t('common.rank.context')}</span>
      </div>
      {children}
      {empty ? <div role="row" className="rank rank--empty"><div role="cell">{empty}</div></div> : null}
      {footerText || footerAction ? (
        <div className="rank rank--foot" role="row">
          <div role="cell" className="rank__foot">
            {footerText ? <p className="stat__c">{footerText}</p> : null}
            {footerAction}
          </div>
        </div>
      ) : null}
    </div>
  );
}
