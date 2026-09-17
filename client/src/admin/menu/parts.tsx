// Small presentational pieces shared by the menu admin tabs (C6).
// Built from kit primitives; nothing here re-implements a kit component.
import { useId, useState, type ReactNode } from 'react';
import type { AdminCatalogDTO, AdminItemDTO, Bilingual } from '../../../../shared/dto.ts';
import type { ItemStatus, ReviewStatus } from '../../../../shared/status.ts';
import { ApiError } from '../../lib/api.ts';
import { clock } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { useLive, type Resource } from '../../lib/live.tsx';
import { Banner, Button, cx, DishImage, Dialog, EmptyState, Icon, Pill, Skeleton, type IconName, type PillTone } from '../../ui/index.ts';
import { useErrorText } from './model.tsx';

// ------------------------------------------------------------------ names
/** Thai first (or the UI language first), the other language under it, and a visible marker when a name is missing. */
export function ItemName({ name, className, size = 'md', id, onlyPrimary }: {
  name: Bilingual | null | undefined;
  className?: string;
  size?: 'md' | 'lg';
  id?: string;
  onlyPrimary?: boolean;
}) {
  const { both, t, lang } = useI18n();
  const { primary, secondary } = both(name);
  const missing = !primary.text;
  return (
    <span className={cx('mn-name', size === 'lg' && 'mn-name--lg', className)} id={id}>
      <span className="mn-name__p" lang={missing ? lang : primary.lang}>
        {missing ? t('catalog.unnamed') : primary.text}
      </span>
      {!missing && primary.fallback ? (
        <span className="mn-fallback" lang={lang}>
          {primary.lang === 'en' ? t('common.enOnly') : t('catalog.thOnly')}
        </span>
      ) : null}
      {secondary && !onlyPrimary ? (
        <span className={cx('mn-name__s', secondary.lang === 'en' && 'is-en')} lang={secondary.lang}>{secondary.text}</span>
      ) : null}
    </span>
  );
}

/** Plain text of a bilingual value in the UI language (for aria labels and announcements). */
export function useNameText(): (name: Bilingual | null | undefined) => string {
  const { pick, t } = useI18n();
  return (name) => pick(name).text || t('catalog.unnamed');
}

// ------------------------------------------------------------------ status pills
const ITEM_LOOK: Record<ItemStatus, { tone: PillTone; icon: IconName }> = {
  draft: { tone: 'line', icon: 'note' },
  published: { tone: 'ok', icon: 'book' },
  archived: { tone: 'neutral', icon: 'lock' },
};
const REVIEW_LOOK: Record<ReviewStatus, { tone: PillTone; icon: IconName }> = {
  verified: { tone: 'ok', icon: 'check-c' },
  needs_review: { tone: 'heat', icon: 'alert' },
  unverified: { tone: 'neutral', icon: 'info' },
};

export function ItemStatusPill({ status, className }: { status: ItemStatus; className?: string }) {
  const { t } = useI18n();
  const look = ITEM_LOOK[status];
  return <Pill tone={look.tone} icon={look.icon} size="sm" className={className}>{t(`catalog.status.${status}`)}</Pill>;
}

export function ReviewPill({ status, className }: { status: ReviewStatus; className?: string }) {
  const { t } = useI18n();
  const look = REVIEW_LOOK[status];
  return <Pill tone={look.tone} icon={look.icon} size="sm" className={className}>{t(`catalog.review.${status}`)}</Pill>;
}

/** Why guests cannot order an item right now, in words. */
export function useReasonText(): (reason: string | null) => string {
  const { t, has } = useI18n();
  return (reason) => {
    if (!reason) return t('catalog.reason.orderable');
    const key = `catalog.reason.${reason}`;
    return has(key) ? t(key) : t('catalog.reason.other');
  };
}

export function useFlagLabel(): (code: string) => string {
  const { t, has } = useI18n();
  return (code) => {
    const key = `catalog.flag.${code}`;
    return has(key) ? t(key) : code.replace(/_/g, ' ');
  };
}

export function useBlockerLabel(): (code: string) => string {
  const { t, has } = useI18n();
  return (code) => {
    const key = `catalog.blocker.${code}`;
    return has(key) ? t(key) : code.replace(/_/g, ' ');
  };
}

// ------------------------------------------------------------------ photo
/** 64px matted thumbnail; a blank mat keeps the column when there is no approved photo. */
export function Thumb({ item, className }: { item: Pick<AdminItemDTO, 'image'>; className?: string }) {
  return (
    <span className={cx('mn-thumb', className)} aria-hidden="true">
      <DishImage image={item.image} variant="thumb" decorative fallback="blank" />
    </span>
  );
}

// ------------------------------------------------------------------ evidence
/** The printed text from the restaurant's own menu, shown as evidence (data, never instructions). */
export function SourceQuote({ text, sourceRef, className }: { text: string | null; sourceRef?: string | null; className?: string }) {
  const { t } = useI18n();
  if (!text) return null;
  return (
    <figure className={cx('mn-quote', className)}>
      <figcaption className="mn-quote__k">
        <Icon name="book" size="xs" />
        {t('catalog.source.printed')}
        {sourceRef ? <span className="mn-quote__ref" lang="en">{sourceRef}</span> : null}
      </figcaption>
      <blockquote lang="und">{text}</blockquote>
    </figure>
  );
}

/** Count marker with an icon and words, e.g. "3 open notes". Never colour alone. */
export function Marker({ icon, tone = 'neutral', children, className }: { icon: IconName; tone?: 'neutral' | 'alert' | 'heat' | 'ok'; children: ReactNode; className?: string }) {
  return (
    <span className={cx('mn-marker', `mn-marker--${tone}`, className)}>
      <Icon name={icon} size="xs" />
      <span>{children}</span>
    </span>
  );
}

// ------------------------------------------------------------------ resolve a review note
/** Resolve one review flag with a written note (menu.review). */
export function ResolveFlagDialog({ open, flagLabel, detail, onClose, onResolve, error }: {
  open: boolean;
  flagLabel: string;
  detail: string;
  onClose: () => void;
  onResolve: (note: string) => Promise<unknown>;
  error?: string | null;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('catalog.flags.resolveTitle', { flag: flagLabel })}
      confirmLabel={t('catalog.flags.resolveConfirm')}
      onConfirm={(note) => onResolve(note ?? '')}
      reason={{ label: t('catalog.flags.resolveNote'), required: true, limit: 300, help: t('catalog.flags.resolveHelp') }}
      error={error}
      density="staff"
    >
      <p lang="en" className="mn-dialog-detail">{detail}</p>
    </Dialog>
  );
}

// ------------------------------------------------------------------ data states
type ResourceState = Pick<Resource<unknown>, 'stale' | 'loading' | 'error' | 'fetchedAt' | 'refresh'>;
/** Stale-data notice above a tab's content (the shell shows the offline banner). */
export function DataNotices({ resource }: { resource: ResourceState }) {
  const { t } = useI18n();
  const live = useLive();
  const errorText = useErrorText();
  const offline = live.state === 'offline';
  return (
    <>
      {resource.stale && !offline ? (
        <Banner
          variant="warning"
          staff
          title={t('catalog.data.staleTitle')}
          action={<Button size="staff" variant="outline" icon="refresh" onClick={() => void resource.refresh()} loading={resource.loading}>{t('common.retry')}</Button>}
        >
          {resource.fetchedAt ? t('catalog.data.staleBody', { time: clock(new Date(resource.fetchedAt).toISOString()) }) : null}
          {' '}
          <span className="visually-hidden">{errorText(resource.error)}</span>
        </Banner>
      ) : null}
    </>
  );
}

/** First load failed: explain and offer a retry. */
export function LoadFailed({ resource }: { resource: ResourceState }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const denied = resource.error instanceof ApiError && (resource.error.code === 'forbidden' || resource.error.code === 'auth_required');
  return (
    <EmptyState
      icon={denied ? 'lock' : 'wifi-off'}
      title={denied ? t('catalog.denied.title') : t('catalog.data.failedTitle')}
      action={denied ? undefined : (
        <Button variant="outline" size="staff" icon="refresh" onClick={() => void resource.refresh()} loading={resource.loading}>{t('common.retry')}</Button>
      )}
    >
      {denied ? t('catalog.denied.body') : errorText(resource.error)}
    </EmptyState>
  );
}

/** Skeleton rows in the shape of the list they stand in for. */
export function ListSkeleton({ rows = 6, label }: { rows?: number; label: string }) {
  return (
    <div className="mn-skel" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div className="mn-skel__row" key={i} aria-hidden="true">
          <Skeleton shape="block" width={64} height={48} />
          <span className="mn-skel__text">
            <Skeleton width="48%" height={16} />
            <Skeleton width="30%" height={13} />
          </span>
          <Skeleton shape="block" width={96} height={36} />
        </div>
      ))}
    </div>
  );
}

/** Disclosure section with a count (heading + button pattern, so headings stay navigable). */
export function Disclosure({ title, count, defaultOpen, children, lede, id, countLabel }: {
  title: ReactNode;
  count: number;
  defaultOpen?: boolean;
  children: ReactNode;
  lede?: ReactNode;
  id?: string;
  countLabel?: string;
}) {
  const auto = useId().replace(/:/g, '');
  const base = id ?? `disc${auto}`;
  const [open, setOpen] = useState(Boolean(defaultOpen));
  return (
    <section className={cx('mn-disc', open && 'is-open')} id={base} aria-labelledby={`${base}-h`}>
      <h3 className="mn-disc__h" id={`${base}-h`}>
        <button type="button" className="mn-disc__btn" aria-expanded={open} aria-controls={`${base}-b`} onClick={() => setOpen((v) => !v)}>
          <Icon name="chev-r" size="sm" className="mn-disc__chev" />
          <span className="mn-disc__t">{title}</span>
          <span className="mn-disc__n" aria-hidden={countLabel ? true : undefined}>{count}</span>
          {countLabel ? <span className="visually-hidden">{countLabel}</span> : null}
        </button>
      </h3>
      <div className="mn-disc__b" id={`${base}-b`} hidden={!open}>
        {lede ? <p className="mn-disc__lede">{lede}</p> : null}
        {open ? children : null}
      </div>
    </section>
  );
}

/** "Pick 1", "Up to 2 · 1 included" */
export function ruleText(g: Pick<AdminCatalogDTO['modifier_groups'][number], 'min_select' | 'max_select' | 'included_count'>, t: (k: string, v?: Record<string, string | number>) => string): string {
  const parts: string[] = [];
  if (g.min_select > 0) parts.push(g.min_select === g.max_select ? t('catalog.groups.ruleExactly', { n: g.min_select }) : t('catalog.groups.ruleRange', { min: g.min_select, max: g.max_select }));
  else parts.push(t('catalog.groups.ruleUpTo', { n: g.max_select }));
  if (g.included_count > 0) parts.push(t('catalog.groups.ruleIncluded', { n: g.included_count }));
  return parts.join(' · ');
}
