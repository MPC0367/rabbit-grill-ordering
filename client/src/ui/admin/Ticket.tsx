// Staff docket (DESIGN.md §10.16): framed table number, reference, wait,
// flags, the full-bleed oxblood allergy band, dish lines with per-line state,
// the per-dish progress meter and one counted primary action.
import { forwardRef, type HTMLAttributes } from 'react';
import type { LineStatus } from '../../../../shared/status.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Button, IconButton } from '../Button.tsx';
import { Flag, Tag } from '../Badge.tsx';
import { cx, Ico, type AdminIconName } from './parts.tsx';

// ------------------------------------------------------------------ flags

export type TicketFlagKind = 'oldest' | 'late' | 'just' | 'ready' | 'station';

export interface TicketFlagSpec {
  kind: TicketFlagKind;
  /** Overrides the default words (required for "station": Kitchen / Bar). */
  label?: string;
  /** late: the owner threshold; ready: minutes at the pass. */
  minutes?: number;
}

export function TicketFlag({ kind, label, minutes, className }: TicketFlagSpec & { className?: string }) {
  const { t, lang } = useI18n();
  let words = label;
  if (!words) {
    if (kind === 'oldest') words = t('common.ticket.oldest');
    else if (kind === 'late') words = t('common.ticket.late', { n: minutes ?? 20 });
    else if (kind === 'just') words = t('common.ticket.justIn');
    else if (kind === 'ready') words = minutes != null ? t('common.ticket.readyFor', { n: minutes }) : t('common.ticket.waitingServe');
    else words = '';
  }
  return (
    <Flag kind={kind} className={className} lang={kind === 'station' ? lang : undefined}>
      {words}
    </Flag>
  );
}

// ------------------------------------------------------------------ allergy + note

export interface AllergyBandProps {
  /** The guest's words, verbatim and untranslated. */
  text: string;
  /** Language the guest wrote in (sets the text's lang). */
  lang?: string;
  className?: string;
}

/** Full-bleed oxblood band under the ticket head, above every line. */
export function AllergyBand({ text, lang: textLang, className }: AllergyBandProps) {
  const { t, lang } = useI18n();
  return (
    <div className={cx('allergy', className)} role="note">
      <p className="allergy__k" lang={lang}>
        <Ico name="alert" />
        {t('common.ticket.allergy')}
      </p>
      <p className="allergy__q" lang={textLang}>“{text}”</p>
      <p className="allergy__s">{t('common.ticket.asWritten')}</p>
    </div>
  );
}

/** Sunken guest-note well with the words verbatim. */
export function GuestNote({ text, lang: textLang, label, className }: { text: string; lang?: string; label?: string; className?: string }) {
  const { t, lang } = useI18n();
  return (
    <p className={cx('wellnote', className)}>
      <Ico name="note" />
      <span>
        <small lang={lang}>{label ?? t('common.ticket.guestNote')}</small>
        <span lang={textLang}>{text}</span>
      </span>
    </p>
  );
}

// ------------------------------------------------------------------ lines

export interface TicketChip {
  label: string;
  /** Doneness split by quantity: "มีเดียมแรร์ × 1". */
  quantity?: number;
  lang?: string;
}

export interface TicketLineData {
  id: string;
  quantity: number;
  /** Primary name (Thai when on file). */
  name: string;
  nameLang?: string;
  /** Secondary line (English name, variant words). */
  secondary?: string;
  secondaryLang?: string;
  /** The catalogue has no Thai name: appends "no Thai name on file". */
  noThaiName?: boolean;
  /** Modifier chips (split by quantity) and verified variant chips (500 ml, Iced). */
  chips?: TicketChip[];
  /** Placeholder configuration: adds the dashed Example tag. */
  example?: boolean;
  /** Measured-weight line, preformatted: "380 g · ฿1,862". */
  weight?: { text: string; confirmedAt?: string };
  alcohol?: boolean;
  /** Per-line guest note, verbatim. */
  note?: string;
  noteLang?: string;
  status: LineStatus;
  /** Clock time of the latest step ("19:46"). */
  statusAt?: string;
  /** Who recorded it ("Ploy", "Kitchen 1"). */
  actor?: string;
  /** Cancel / reject reason ("out of stock"). */
  reason?: string;
}

export interface TicketLineProps extends TicketLineData {
  showStatus?: boolean;
  className?: string;
}

const LINE_ICON: Record<LineStatus, AdminIconName> = {
  submitted: 'plus',
  accepted: 'check',
  preparing: 'half',
  almost_done: 'half',
  ready: 'cloche',
  served: 'check',
  rejected: 'slash',
  cancelled: 'slash',
};

const LINE_TONE: Record<LineStatus, string> = {
  submitted: '',
  accepted: '',
  preparing: 'line__st--cook',
  almost_done: 'line__st--cook',
  ready: 'line__st--ready',
  served: 'line__st--ok',
  rejected: 'line__st--alert',
  cancelled: 'line__st--alert',
};

export function TicketLine({
  quantity, name, nameLang, secondary, secondaryLang, noThaiName, chips, example, weight, alcohol, note, noteLang,
  status, statusAt, actor, reason, showStatus = false, className,
}: TicketLineProps) {
  const { t, lang } = useI18n();
  const label = t(`common.staff.status.${status}`);
  const finished = status === 'served' || status === 'cancelled' || status === 'rejected';
  const statusParts = finished
    ? [statusAt ? `${label} ${statusAt}` : label, reason, actor]
    : [label, statusAt, actor];
  const hasSec = Boolean(secondary) || Boolean(noThaiName);
  const struck = status === 'served' ? 'is-served' : status === 'cancelled' || status === 'rejected' ? 'is-cancelled' : null;
  return (
    <li className={cx('line', struck, className)}>
      <span className="line__q">
        {quantity}
        <small aria-hidden="true">×</small>
      </span>
      <div className="line__body">
        <p className="line__th" lang={nameLang}>{name}</p>
        {hasSec ? (
          <p className="line__en" lang={noThaiName ? undefined : secondaryLang}>
            {secondary ? (noThaiName ? <span lang={secondaryLang}>{secondary}</span> : secondary) : null}
            {secondary && noThaiName ? ' · ' : null}
            {noThaiName ? <span lang={lang}>{t('common.ticket.noThaiName')}</span> : null}
          </p>
        ) : null}
        {(chips && chips.length > 0) || example ? (
          <div className="line__chips">
            {chips?.map((c, i) => (
              <span key={`${c.label}-${i}`} className="chip-mod" lang={c.lang}>
                {c.label}
                {c.quantity != null ? <span className="x"> × {c.quantity}</span> : null}
              </span>
            ))}
            {example ? <Tag tone="example" /> : null}
          </div>
        ) : null}
        {weight ? (
          <p className="line__weight">
            <Ico name="scale" />
            {weight.confirmedAt ? `${weight.text} · ${t('common.ticket.guestConfirmed', { time: weight.confirmedAt })}` : weight.text}
          </p>
        ) : null}
        {alcohol ? (
          <p className="line__st line__st--alert">
            <Ico name="glass" />
            {t('common.alcoholConfirm')}
          </p>
        ) : null}
        {note ? <GuestNote text={note} lang={noteLang} className="line__note" /> : null}
        {showStatus && status !== 'submitted' ? (
          <p className={cx('line__st', LINE_TONE[status])}>
            <Ico name={LINE_ICON[status]} />
            {statusParts.filter(Boolean).join(' · ')}
          </p>
        ) : null}
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ meter

export interface ProgressMeterProps {
  lines: ReadonlyArray<{ status: LineStatus; quantity: number }>;
  className?: string;
}

const METER_CAP = 16;

/** One 14×6 segment per active dish plus words. Cancelled and rejected dishes are excluded. */
export function ProgressMeter({ lines, className }: ProgressMeterProps) {
  const { t } = useI18n();
  const c = { served: 0, ready: 0, almost: 0, preparing: 0, waiting: 0 };
  for (const l of lines) {
    const n = Math.max(0, l.quantity);
    if (l.status === 'served') c.served += n;
    else if (l.status === 'ready') c.ready += n;
    else if (l.status === 'almost_done') c.almost += n;
    else if (l.status === 'preparing') c.preparing += n;
    else if (l.status === 'submitted' || l.status === 'accepted') c.waiting += n;
  }
  const segs: string[] = [
    ...Array<string>(c.served).fill('s'),
    ...Array<string>(c.ready).fill('r'),
    ...Array<string>(c.almost + c.preparing).fill('c'),
    ...Array<string>(c.waiting).fill(''),
  ].slice(0, METER_CAP);
  const words = [
    c.served ? t('common.ticket.served', { n: c.served }) : null,
    c.ready ? t('common.ticket.ready', { n: c.ready }) : null,
    c.almost ? t('common.ticket.almostDone', { n: c.almost }) : null,
    c.preparing ? t('common.ticket.preparing', { n: c.preparing }) : null,
    c.waiting ? t('common.ticket.waiting', { n: c.waiting }) : null,
  ].filter(Boolean);
  return (
    <div className={cx('meter', className)}>
      <span className="meter__bar" aria-hidden="true">
        {segs.map((s, i) => <i key={i} className={s || undefined} />)}
      </span>
      <span className="meter__t">{words.join(' · ')}</span>
    </div>
  );
}

// ------------------------------------------------------------------ ticket

export interface TicketAction {
  label: string;
  /** Exact number of dishes the action changes ("Accept · 5"). */
  count?: number;
  icon?: AdminIconName;
  onClick?: () => void;
  busy?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}

export interface TicketProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  table: string;
  reference: string;
  round: number;
  /** Clock time for the second head row ("19:48"). */
  time: string;
  timeKind?: 'sent' | 'ready';
  /** Whole minutes waiting; null hides the wait. */
  waitMinutes: number | null;
  /** Owner threshold: over it the wait turns oxblood and a "Longer than usual" flag appears. */
  lateAfterMinutes?: number | null;
  /** The ticket's column (used for its spoken label). */
  stage: LineStatus;
  flags?: TicketFlagSpec[];
  allergy?: { text: string; lang?: string } | null;
  note?: { text: string; lang?: string } | null;
  lines: TicketLineData[];
  /** Per-line status rows: auto shows them when the lines are at different states. */
  lineStatus?: 'auto' | 'always' | 'never';
  /** Progress meter: auto shows it when active dishes are at different stages. */
  meter?: 'auto' | 'always' | 'never';
  /** Not yet accepted: 2px ink outline (appears once, stays until accepted). */
  isNew?: boolean;
  primary?: TicketAction | null;
  /** Optional outline action on its own row (Almost done). */
  secondary?: TicketAction | null;
  /** Opens the details panel (per-line selection, reject/cancel with reason, correction, Finish order). */
  onMore?: () => void;
  moreLabel?: string;
  /** A newer version exists: actions are disabled until the card is reviewed. */
  conflict?: { by: string; at: string; onReview?: () => void } | null;
  /** Spoken label override. */
  label?: string;
}

function ActionButton({ action, variant, disabled }: { action: TicketAction; variant: 'primary' | 'outline'; disabled: boolean }) {
  const off = disabled || action.disabled;
  return (
    <Button
      variant={variant}
      size="staff"
      icon={action.icon}
      iconBold={action.icon === 'check'}
      count={action.count}
      loading={action.busy}
      aria-disabled={off || undefined}
      aria-label={action.ariaLabel}
      onClick={action.onClick}
    >
      {action.label}
    </Button>
  );
}

export const Ticket = forwardRef<HTMLElement, TicketProps>(function Ticket(
  {
    table, reference, round, time, timeKind = 'sent', waitMinutes, lateAfterMinutes, stage, flags = [], allergy, note,
    lines, lineStatus = 'auto', meter = 'auto', isNew, primary, secondary, onMore, moreLabel, conflict, label,
    className, ...rest
  },
  ref,
) {
  const { t, lang } = useI18n();
  const late = lateAfterMinutes != null && waitMinutes != null && waitMinutes > lateAfterMinutes;
  const allFlags: TicketFlagSpec[] = late && !flags.some((f) => f.kind === 'late')
    ? [{ kind: 'late', minutes: lateAfterMinutes ?? undefined }, ...flags]
    : flags;
  const active = lines.filter((l) => l.status !== 'cancelled' && l.status !== 'rejected');
  const mixedLines = new Set(lines.map((l) => l.status)).size > 1;
  const activeStages = new Set(active.map((l) => l.status));
  const showLineStatus = lineStatus === 'always' || (lineStatus === 'auto' && mixedLines);
  const showMeter = meter === 'always' || (meter === 'auto' && activeStages.size > 1 && active.length > 1);
  const spoken = label ?? [
    t('common.ticket.aria', { table, round, state: t(`common.staff.status.${stage}`).toLowerCase() }),
    late ? t('common.ticket.ariaLate') : null,
    allergy ? t('common.ticket.ariaAllergy') : null,
  ].filter(Boolean).join(lang === 'th' ? ' ' : ', ');
  const blocked = Boolean(conflict);

  return (
    <article
      ref={ref}
      {...rest}
      className={cx('ticket', isNew && 'is-new', blocked && 'has-conflict', className)}
      aria-label={spoken}
    >
      <header className="ticket__head">
        <div className="tno" aria-hidden="true">
          <span className="tno__k" lang={lang}>{t('common.ticket.table')}</span>
          <span className="tno__n">{table}</span>
        </div>
        <div className="ticket__r1">
          <span className="ticket__ref" lang="en">{reference}</span>
          {waitMinutes != null ? (
            <span className={cx('wait', late && 'wait--late')}>
              <Ico name="clock" />
              <b>{waitMinutes}</b>
              <small>{t('common.ticket.min')}</small>
            </span>
          ) : null}
        </div>
        <p className="ticket__r2">
          {t('common.ticket.round', { n: round })} · {t(timeKind === 'ready' ? 'common.ticket.readyAt' : 'common.ticket.sent', { time })}
        </p>
      </header>

      {allFlags.length > 0 ? (
        <div className="ticket__flags">
          {allFlags.map((f, i) => <TicketFlag key={`${f.kind}-${i}`} {...f} />)}
        </div>
      ) : null}

      {allergy ? <AllergyBand text={allergy.text} lang={allergy.lang} /> : null}

      {conflict ? (
        <div className="ticket__conflict" role="status">
          <Ico name="refresh" size="sm" />
          <span>{t('common.ticket.conflict', { name: conflict.by, time: conflict.at })}</span>
          {conflict.onReview ? (
            <button type="button" className="textlink" onClick={conflict.onReview}>{t('common.ticket.review')}</button>
          ) : null}
        </div>
      ) : null}

      <ul className="lines">
        {lines.map((l) => <TicketLine key={l.id} {...l} showStatus={showLineStatus} />)}
      </ul>

      {note ? (
        <div className="lines">
          <GuestNote text={note.text} lang={note.lang} />
        </div>
      ) : null}

      {showMeter ? <ProgressMeter lines={active} /> : null}

      {primary || secondary || onMore ? (
        <div className="ticket__actions">
          {primary ? <ActionButton action={primary} variant="primary" disabled={blocked} /> : null}
          {secondary ? <ActionButton action={secondary} variant="outline" disabled={blocked} /> : null}
          {onMore ? (
            <IconButton
              icon="more"
              variant="framed"
              size="staff"
              opensDialog
              label={moreLabel ?? (stage === 'submitted' ? t('common.ticket.detailsReject') : t('common.ticket.details'))}
              onClick={onMore}
            />
          ) : null}
        </div>
      ) : null}
    </article>
  );
});

