// Parcel-style tracking (DESIGN §10.14, brief 35):
//   Timeline       done (actual time) · current (ember dot, "ตอนนี้") · upcoming (muted, no time) · skipped ("ไม่ได้บันทึก")
//   RoundCard      round head, perforation, live state block, timeline, honest foot note, dishes
//   DishLines      <details> per-dish list; long rounds show 3 lines then "ดูทั้งหมด"
//   DishStatusLine one dish: status leader, six-segment trail, skipped step spelled out, cancellation beside the dish
//   PastRound      collapsed earlier round with overlapping thumbnails
// Animation: a newly current step's ring scales 0.8 → 1 once, only when
// `animate` is true (a committed staff event). Reconnects pass animate={false}.
import {
  Children, forwardRef, useEffect, useRef, useState,
  type DetailsHTMLAttributes, type HTMLAttributes, type ReactNode,
} from 'react';
import { clock } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import { guestStepKey, type LineStatus } from '../../../shared/status.ts';
import { cx } from './cx.ts';
import { Icon, type IconName } from './Icon.tsx';
import { Leader } from './Price.tsx';
import { Button } from './Button.tsx';
import { DishImage, type DishImageSource, dishImageUrl } from './DishImage.tsx';

// ---------------------------------------------------------------- Timeline
export type StepState = 'done' | 'current' | 'upcoming' | 'skipped';

export interface TimelineStep {
  key: string;
  label: ReactNode;
  state: StepState;
  /** Actual event time (ISO). Done steps show it; upcoming steps never do. */
  at?: string | null;
  /** Current step sub-line: "เริ่ม 19:46 · เสิร์ฟแล้ว 1 จาน · กำลังปรุง 2 จาน" */
  sub?: ReactNode;
}

export interface TimelineProps extends Omit<HTMLAttributes<HTMLOListElement>, 'children'> {
  steps: ReadonlyArray<TimelineStep>;
  /** "ความคืบหน้ารอบที่ 2" */
  label: string;
  /** Animate a changed current step once (committed staff events only). */
  animate?: boolean;
}

const CLASS: Record<StepState, string> = { done: 'is-done', current: 'is-current', upcoming: 'is-todo', skipped: 'is-skipped' };

export const Timeline = forwardRef<HTMLOListElement, TimelineProps>(function Timeline(
  { steps, label, animate = true, className, ...rest },
  ref,
) {
  const { t } = useI18n();
  const currentKey = steps.find((s) => s.state === 'current')?.key ?? null;
  const prev = useRef<string | null | undefined>(undefined);
  const [arrived, setArrived] = useState<string | null>(null);

  useEffect(() => {
    if (prev.current !== undefined && currentKey && currentKey !== prev.current && animate) setArrived(currentKey);
    prev.current = currentKey;
  }, [currentKey, animate]);

  return (
    <ol ref={ref} className={cx('tl', className)} aria-label={label} {...rest}>
      {steps.map((s) => {
        const time = s.at ? clock(s.at) : null;
        let value: ReactNode = null;
        let valueAs: 'span' | 'time' = 'span';
        if (s.state === 'done' && time) { value = time; valueAs = 'time'; }
        else if (s.state === 'current') value = <span className="tag-now">{t('common.now')}</span>;
        else if (s.state === 'skipped') value = <span className="tl__skip">{t('track.notRecorded')}</span>;
        return (
          <li
            key={s.key}
            className={cx('tl__step', CLASS[s.state], arrived === s.key && 'is-arrived')}
            aria-current={s.state === 'current' ? 'step' : undefined}
            onAnimationEnd={arrived === s.key ? () => setArrived(null) : undefined}
          >
            <span className="tl__node" aria-hidden="true">
              {s.state === 'done' ? <Icon name="check" /> : null}
            </span>
            {value !== null ? (
              <Leader
                label={s.label}
                labelClassName="tl__label"
                value={value}
                valueAs={valueAs}
                valueClassName={valueAs === 'time' ? 'tl__time' : undefined}
              />
            ) : (
              <span className="tl__label">
                {s.label}
                {s.state === 'upcoming' ? <span className="visually-hidden"> · {t('common.stepUpcoming')}</span> : null}
              </span>
            )}
            {s.sub ? <p className="tl__sub">{s.sub}</p> : null}
          </li>
        );
      })}
    </ol>
  );
});

// ---------------------------------------------------------------- RoundCard
export interface RoundCardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** "รอบที่ 2" */
  title: ReactNode;
  /** "ส่งเมื่อ 19:42 · 4 รายการ · โต๊ะ 07" */
  meta?: ReactNode;
  /** Order reference, e.g. RG-4K7P */
  reference: string;
  referenceLabel?: ReactNode;
  /** State block: headline (26/600 with the 28×2 ember underline) and one honest line. Polite live region. */
  stateTitle: ReactNode;
  stateMessage?: ReactNode;
  /** Timeline, then DishLines. */
  children?: ReactNode;
  /** Honest foot note under the timeline (default common.honestStatus). null hides it. */
  footnote?: ReactNode | null;
  /** Newly placed round (?placed=): 2px ink outline. */
  highlight?: boolean;
  /** Content after the foot note (DishLines). */
  dishes?: ReactNode;
}

export const RoundCard = forwardRef<HTMLElement, RoundCardProps>(function RoundCard(
  { title, meta, reference, referenceLabel, stateTitle, stateMessage, children, footnote, highlight, dishes, className, id, ...rest },
  ref,
) {
  const { t } = useI18n();
  const titleId = `${id ?? `round-${reference}`}-t`;
  return (
    <article ref={ref} id={id} aria-labelledby={titleId} className={cx('card round', highlight && 'is-highlight', className)} {...rest}>
      <header className="round__head">
        <div>
          <h2 className="round__t" id={titleId}>{title}</h2>
          {meta ? <p className="meta">{meta}</p> : null}
        </div>
        <div>
          <p className="round__refk">{referenceLabel ?? t('common.reference')}</p>
          <p className="round__ref" lang="en">{reference}</p>
        </div>
      </header>
      <div className="perf" aria-hidden="true" />
      <div className="state" aria-live="polite" aria-atomic="true">
        <p className="state__t">{stateTitle}</p>
        {stateMessage ? <p className="state__m">{stateMessage}</p> : null}
      </div>
      {children}
      {footnote === null ? null : (
        <p className="tl__foot"><Icon name="info" />{footnote ?? t('common.honestStatus')}</p>
      )}
      {dishes}
    </article>
  );
});

// ---------------------------------------------------------------- DishLines
export interface DishLinesProps extends Omit<DetailsHTMLAttributes<HTMLDetailsElement>, 'title'> {
  /** "รายจาน" */
  title: ReactNode;
  /** "เสิร์ฟแล้ว 1 · กำลังปรุง 2 · ยกเลิก 1" */
  summary?: ReactNode;
  /** DishStatusLine elements */
  children: ReactNode;
  /** Rounds with more lines than this show the first 3, then "ดูทั้งหมด". */
  collapseAfter?: number;
  defaultOpen?: boolean;
}

export function DishLines({ title, summary, children, collapseAfter = 6, defaultOpen = true, className, ...rest }: DishLinesProps) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const list = Children.toArray(children);
  const long = list.length > collapseAfter;
  const shown = long && !all ? list.slice(0, 3) : list;
  return (
    <details className={cx('dishes', className)} open={defaultOpen} {...rest}>
      <summary>
        <span>{title}{summary ? <span className="meta"> · {summary}</span> : null}</span>
        <Icon name="chev-d" />
      </summary>
      <ul>{shown}</ul>
      {long && !all ? (
        <div className="dishes__more">
          <Button variant="quiet" onClick={() => setAll(true)} iconEnd="chev-d">
            {t('common.showAll')} ({list.length})
          </Button>
        </div>
      ) : null}
    </details>
  );
}

// ---------------------------------------------------------------- DishStatusLine
export type TrailSegment = 'done' | 'now' | 'todo' | 'skipped';

export interface DishStatusLineProps extends Omit<HTMLAttributes<HTMLLIElement>, 'children'> {
  name: ReactNode;
  nameLang?: string;
  quantity: number;
  image?: DishImageSource | null;
  status: LineStatus;
  /** Drinks and desserts say "กำลังเตรียม" instead of "กำลังปรุง". */
  prep?: 'cook' | 'prepare';
  /** Override the status words. */
  statusLabel?: ReactNode;
  /** Time of the status (ISO): preparing shows "เริ่ม 19:46", served / cancelled show the time. */
  at?: string | null;
  /** Six segments (submitted → served). aria-hidden: the words carry the meaning. */
  trail?: ReadonlyArray<TrailSegment>;
  /** Optional steps that were skipped, spelled out: "ขั้นใกล้เสร็จ: ไม่ได้บันทึก" */
  skipped?: ReadonlyArray<string>;
  /** Cancellation / rejection reason (shown beside the dish with "ไม่คิดในบิล"). */
  reason?: string | null;
  /** Show "ไม่คิดในบิล" (default true for cancelled / rejected). */
  notCharged?: boolean;
}

function lineLook(status: LineStatus): { cls: string; icon: IconName | null } {
  switch (status) {
    case 'served': return { cls: 'dline__st--ok', icon: 'check' };
    case 'ready': return { cls: 'dline__st--ok', icon: 'cloche' };
    case 'rejected':
    case 'cancelled': return { cls: 'dline__st--alert', icon: 'slash' };
    case 'preparing':
    case 'almost_done': return { cls: 'dline__st--cook', icon: 'half' };
    case 'accepted': return { cls: '', icon: 'check' };
    default: return { cls: '', icon: 'clock' };
  }
}

export function DishStatusLine({
  name, nameLang, quantity, image, status, prep = 'cook', statusLabel, at, trail, skipped, reason, notCharged, className, ...rest
}: DishStatusLineProps) {
  const { t } = useI18n();
  const look = lineLook(status);
  const stopped = status === 'cancelled' || status === 'rejected';
  const words = statusLabel ?? (
    status === 'served' ? t('status.served')
      : status === 'cancelled' ? t('status.cancelled')
        : status === 'rejected' ? t('status.rejected')
          : t(guestStepKey(status, prep))
  );
  const time = at ? clock(at) : null;
  const value = time
    ? (status === 'preparing' || status === 'almost_done'
      ? <span className="meta">{t('common.startedAt', { time: '' }).trim()} <time className="tl__time">{time}</time></span>
      : <time className="tl__time">{time}</time>)
    : null;
  return (
    <li className={cx('dline', stopped && 'dline--cancel', !image && 'dline--noimg', className)} {...rest}>
      {image ? <DishImage image={image} variant="thumb" decorative /> : null}
      <div>
        <p className="dline__name">
          <span lang={nameLang}>{name}</span>
          <span className="x">× {quantity}</span>
        </p>
        <Leader
          label={<span className={cx('dline__st', look.cls)}>{look.icon ? <Icon name={look.icon} /> : null}{words}</span>}
          value={value}
        />
        {trail && !stopped ? (
          <div className="trail" aria-hidden="true">
            {trail.map((seg, i) => <i key={i} className={seg === 'done' ? 'd' : seg === 'now' ? 'n' : seg === 'skipped' ? 's' : undefined} />)}
          </div>
        ) : null}
        {skipped?.map((step) => <p key={step} className="dline__why">{t('common.skippedStep', { step })}</p>)}
        {stopped && (reason || notCharged !== false) ? (
          <p className="dline__why">
            {reason ? t('common.reasonIs', { reason }) : null}
            {reason && notCharged !== false ? ' · ' : null}
            {notCharged !== false ? t('common.notCharged') : null}
          </p>
        ) : null}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- PastRound
export interface PastRoundProps extends Omit<DetailsHTMLAttributes<HTMLDetailsElement>, 'title'> {
  /** "เสิร์ฟครบทุกจาน 19:31" */
  title: ReactNode;
  /** "รอบที่ 1 · RG-3H2M · ส่งเมื่อ 19:08 · 3 รายการ" */
  meta?: ReactNode;
  /** Up to 2-3 photos; the rest count into "+N". */
  thumbs?: ReadonlyArray<DishImageSource>;
  extra?: number;
  /** Expanded content (a Timeline or DishLines). */
  children?: ReactNode;
}

export function PastRound({ title, meta, thumbs = [], extra = 0, children, className, ...rest }: PastRoundProps) {
  const shown = thumbs.slice(0, 2);
  const more = extra + Math.max(0, thumbs.length - shown.length);
  return (
    <details className={cx('card past', className)} {...rest}>
      <summary>
        <span>
          <span className="past__t"><Icon name="check-c" />{title}</span>
          {meta ? <span className="meta past__meta">{meta}</span> : null}
        </span>
        <span className="thumbs" aria-hidden="true">
          {shown.map((img) => <img key={img.name} src={dishImageUrl(img.name, [...img.sizes].sort((a, b) => a - b)[0])} alt="" width={36} height={36} loading="lazy" />)}
          {more > 0 ? <span>+{more}</span> : null}
        </span>
        <Icon name="chev-d" />
      </summary>
      {children ? <div className="past__body">{children}</div> : null}
    </details>
  );
}
