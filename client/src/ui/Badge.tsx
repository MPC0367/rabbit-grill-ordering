// Badge, Pill, StatusPill, Tag, Flag, Chip (DESIGN §10.10).
// Never colour alone: every pill and flag carries a word, most an icon.
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { guestStepKey, type JobStatus, type LineStatus, type OrderStatus, type ServiceStatus, type TableState } from '../../../shared/status.ts';
import { useI18n } from '../lib/i18n.tsx';
import { cx } from './cx.ts';
import { Icon, type IconName } from './Icon.tsx';

const THAI = /[฀-๿]/;
/** lang for plain-text labels whose language is not known up front (Thai labels are never tracked). */
function textLang(children: ReactNode): string | undefined {
  return typeof children === 'string' && THAI.test(children) ? 'th' : undefined;
}

// ---------------------------------------------------------------- Badge
export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  count: number;
  /** ink (default) · alert (Requests) · ember (rail "new") */
  tone?: 'ink' | 'alert' | 'ember';
  /** 2px surface ring when it overlaps an icon */
  ring?: boolean;
  /** Words for screen readers ("2 รายการ"). Without it the badge is decorative. */
  label?: string;
  max?: number;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { count, tone = 'ink', ring, label, max = 99, className, ...rest },
  ref,
) {
  if (!count || count < 0) return null;
  return (
    <>
      <span
        ref={ref}
        aria-hidden="true"
        className={cx('badge', tone !== 'ink' && `badge--${tone}`, ring && 'badge--ring', className)}
        {...rest}
      >
        {count > max ? `${max}+` : count}
      </span>
      {label ? <span className="visually-hidden">{label}</span> : null}
    </>
  );
});

// ---------------------------------------------------------------- Pill
export type PillTone = 'ok' | 'neutral' | 'alert' | 'heat' | 'line' | 'ink';

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone;
  icon?: IconName;
  /** Ember-coloured icon (the half disc on cooking lines). */
  iconNow?: boolean;
  /** Leading 8px dot (live state) */
  live?: boolean;
  /** md 30 · sm 26 (drawers) */
  size?: 'md' | 'sm';
}

export const Pill = forwardRef<HTMLSpanElement, PillProps>(function Pill(
  { tone = 'neutral', icon, iconNow, live, size = 'md', className, children, ...rest },
  ref,
) {
  return (
    <span ref={ref} className={cx('pill', `pill--${tone}`, live && 'pill--live', size === 'sm' && 'pill--sm', className)} {...rest}>
      {icon ? <Icon name={icon} size="sm" className={iconNow ? 'is-now' : undefined} /> : null}
      {children}
    </span>
  );
});

// ---------------------------------------------------------------- StatusPill
export type StatusPillSubject =
  | { kind: 'line'; status: LineStatus; prep?: 'cook' | 'prepare' }
  | { kind: 'order'; status: OrderStatus; prep?: 'cook' | 'prepare' }
  | { kind: 'service'; status: ServiceStatus }
  | { kind: 'table'; status: TableState }
  | { kind: 'job'; status: JobStatus };

export type StatusPillProps = StatusPillSubject & Omit<PillProps, 'tone' | 'icon' | 'children'> & {
  /** Override the wording (the icon and tone still follow the state). */
  label?: ReactNode;
  /** Extra words after the state, e.g. a time: "ส่งแล้ว · 19:52" */
  detail?: ReactNode;
};

interface Look { tone: PillTone; icon: IconName; now?: boolean }

const LINE_LOOK: Record<LineStatus, Look> = {
  submitted: { tone: 'ink', icon: 'plus' },
  accepted: { tone: 'neutral', icon: 'check' },
  preparing: { tone: 'neutral', icon: 'half', now: true },
  almost_done: { tone: 'neutral', icon: 'half', now: true },
  ready: { tone: 'ok', icon: 'cloche' },
  served: { tone: 'ok', icon: 'check' },
  rejected: { tone: 'alert', icon: 'slash' },
  cancelled: { tone: 'alert', icon: 'slash' },
};
const ORDER_LOOK: Record<OrderStatus, Look> = {
  received: { tone: 'ink', icon: 'plus' },
  confirmed: { tone: 'neutral', icon: 'check' },
  preparing: { tone: 'neutral', icon: 'half', now: true },
  almost_done: { tone: 'neutral', icon: 'half', now: true },
  ready: { tone: 'ok', icon: 'cloche' },
  partially_served: { tone: 'neutral', icon: 'half', now: true },
  served: { tone: 'ok', icon: 'check-c' },
  rejected: { tone: 'alert', icon: 'slash' },
  cancelled: { tone: 'alert', icon: 'slash' },
};
const SERVICE_LOOK: Record<ServiceStatus, Look> = {
  sent: { tone: 'neutral', icon: 'check' },
  acknowledged: { tone: 'ok', icon: 'check' },
  completed: { tone: 'ok', icon: 'check-c' },
  cancelled: { tone: 'alert', icon: 'slash' },
};
const TABLE_LOOK: Record<TableState, Look> = {
  available: { tone: 'line', icon: 'seat' },
  dining: { tone: 'ink', icon: 'cutlery' },
  checking_out: { tone: 'ok', icon: 'receipt' },
  disabled: { tone: 'neutral', icon: 'lock' },
};
const JOB_LOOK: Record<JobStatus, Look> = {
  queued: { tone: 'neutral', icon: 'clock' },
  generating: { tone: 'heat', icon: 'refresh' },
  ready: { tone: 'ok', icon: 'check' },
  failed: { tone: 'alert', icon: 'alert' },
};

/** Maps a shared state machine value to icon + words (common.* keys) + tone. */
export function useStatusWording(subject: StatusPillSubject): Look & { text: string } {
  const { t } = useI18n();
  switch (subject.kind) {
    case 'line':
      return { ...LINE_LOOK[subject.status], text: t(subject.status === 'preparing' ? guestStepKey('preparing', subject.prep ?? 'cook') : `status.${subject.status}`) };
    case 'order':
      return { ...ORDER_LOOK[subject.status], text: t(guestStepKey(subject.status, subject.prep ?? 'cook')) };
    case 'service':
      return { ...SERVICE_LOOK[subject.status], text: t(`service.status.${subject.status}`) };
    case 'table':
      return { ...TABLE_LOOK[subject.status], text: t(`table.${subject.status}`) };
    case 'job':
      return { ...JOB_LOOK[subject.status], text: t(`common.job.${subject.status}`) };
  }
}

export const StatusPill = forwardRef<HTMLSpanElement, StatusPillProps>(function StatusPill(props, ref) {
  const { kind, status, label, detail, prep, ...rest } = props as StatusPillProps & { prep?: 'cook' | 'prepare' };
  const look = useStatusWording({ kind, status, prep } as StatusPillSubject);
  return (
    <Pill ref={ref} tone={look.tone} icon={look.icon} iconNow={look.now} data-status={status} {...rest}>
      {label ?? look.text}
      {detail ? <span className="pill__soft"> · {detail}</span> : null}
    </Pill>
  );
});

// ---------------------------------------------------------------- Tag
export type TagTone = 'ink' | 'line' | 'example' | 'ok' | 'alert' | 'heat' | 'neutral';

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  /** example = the mandatory dashed "ตัวอย่าง / Example" marker on placeholder configuration */
  tone?: TagTone;
  icon?: IconName;
}

export const Tag = forwardRef<HTMLSpanElement, TagProps>(function Tag(
  { tone = 'line', icon, className, children, lang, ...rest },
  ref,
) {
  const { t, lang: uiLang } = useI18n();
  const text = children ?? (tone === 'example' ? t('common.example') : null);
  return (
    <span ref={ref} lang={lang ?? (tone === 'example' && children === undefined ? uiLang : textLang(children))} className={cx('tag', `tag--${tone}`, className)} {...rest}>
      {icon ? <Icon name={icon} size="xs" /> : null}
      {text}
    </span>
  );
});

// ---------------------------------------------------------------- Flag
export type FlagKind = 'oldest' | 'late' | 'just' | 'ready' | 'station' | 'alcohol' | 'example';

const FLAG_ICON: Partial<Record<FlagKind, IconName>> = {
  oldest: 'clock',
  late: 'alert',
  ready: 'cloche',
  alcohol: 'glass',
};

export interface FlagProps extends HTMLAttributes<HTMLSpanElement> {
  kind: FlagKind;
  /** Words. alcohol and example have defaults; the others need text. */
  children?: ReactNode;
}

export const Flag = forwardRef<HTMLSpanElement, FlagProps>(function Flag(
  { kind, className, children, lang, ...rest },
  ref,
) {
  const { t, lang: uiLang } = useI18n();
  const fallback = kind === 'alcohol' ? t('common.alcoholConfirm') : kind === 'example' ? t('common.example') : null;
  const icon = FLAG_ICON[kind];
  return (
    <span ref={ref} lang={lang ?? (children === undefined && fallback ? uiLang : textLang(children))} className={cx('flag', `flag--${kind}`, className)} {...rest}>
      {icon ? <Icon name={icon} size="xs" /> : null}
      {children ?? fallback}
    </span>
  );
});

// ---------------------------------------------------------------- Chip
export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  /** Quantity split: "มีเดียมแรร์ × 1" */
  qty?: number;
  /** ink (verified variants, modifiers) · line (quiet) */
  tone?: 'ink' | 'line';
}

/** Ink modifier / variant chip used on tickets and order lines. */
export const Chip = forwardRef<HTMLSpanElement, ChipProps>(function Chip(
  { qty, tone = 'ink', className, children, ...rest },
  ref,
) {
  return (
    <span ref={ref} className={cx('chip-mod', tone === 'line' && 'chip-mod--line', className)} {...rest}>
      {children}
      {qty !== undefined ? <span className="x">× {qty}</span> : null}
    </span>
  );
});
