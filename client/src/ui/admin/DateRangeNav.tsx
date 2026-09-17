// Period bar (DESIGN.md §10.21): previous / exact range + time zone / next,
// This week, Pick a date (native date input), and the Week-Month-Year switch.
import { useRef, type ReactNode } from 'react';
import type { StatsPeriod } from '../../../../shared/dto.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { SegmentedControl } from '../SegmentedControl.tsx';
import { Button, IconButton } from '../Button.tsx';
import { cx } from './parts.tsx';

export interface PeriodSwitchProps {
  value: StatsPeriod;
  onChange: (period: StatsPeriod) => void;
  periods?: ReadonlyArray<StatsPeriod>;
  className?: string;
}

export function PeriodSwitch({ value, onChange, periods = ['week', 'month', 'year'], className }: PeriodSwitchProps) {
  const { t } = useI18n();
  return (
    <SegmentedControl<StatsPeriod>
      size="staff"
      className={className}
      label={t('common.period.label')}
      value={value}
      onChange={onChange}
      options={periods.map((p) => ({ value: p, label: t(`common.period.${p}`) }))}
    />
  );
}

const PREV_KEY: Record<StatsPeriod, string> = { week: 'common.period.prevWeek', month: 'common.period.prevMonth', year: 'common.period.prevYear', custom: 'common.staff.previous' };
const NEXT_KEY: Record<StatsPeriod, string> = { week: 'common.period.nextWeek', month: 'common.period.nextMonth', year: 'common.period.nextYear', custom: 'common.staff.next' };
const THIS_KEY: Record<StatsPeriod, string> = { week: 'common.period.thisWeek', month: 'common.period.thisMonth', year: 'common.period.thisYear', custom: 'common.period.thisWeek' };

export interface DateRangeNavProps {
  period: StatsPeriod;
  onPeriod?: (period: StatsPeriod) => void;
  periods?: ReadonlyArray<StatsPeriod>;
  /** Bold line: "This week" or "Mon 14 – Thu 17 Sep 2026". */
  label: string;
  /** Exact dates: "Mon 14 – Sun 20 Sep 2026". */
  range: string;
  timeZone?: string;
  onPrev?: () => void;
  onNext?: () => void;
  prevDisabled?: boolean;
  nextDisabled?: boolean;
  /** Jump to the current period; shown as unavailable while already there. */
  onCurrent?: () => void;
  isCurrent?: boolean;
  /** Native date picker: YYYY-MM-DD in, YYYY-MM-DD out. */
  date?: string;
  onPickDate?: (date: string) => void;
  minDate?: string;
  maxDate?: string;
  /** "stats": arrows first, switch on the right. "ranking": switch first (Menu Stats). */
  layout?: 'stats' | 'ranking';
  /** Extra controls after the range (category select, most/least). */
  children?: ReactNode;
  className?: string;
}

export function DateRangeNav({
  period, onPeriod, periods, label, range, timeZone, onPrev, onNext, prevDisabled, nextDisabled,
  onCurrent, isCurrent, date, onPickDate, minDate, maxDate, layout = 'stats', children, className,
}: DateRangeNavProps) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const openPicker = () => {
    const el = input.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
      el.click();
    }
  };
  const switcher = onPeriod ? <PeriodSwitch value={period} onChange={onPeriod} periods={periods} className={layout === 'stats' ? 'periodbar__switch' : undefined} /> : null;
  const arrow = (dir: 'prev' | 'next') => {
    const on = dir === 'prev' ? onPrev : onNext;
    const off = dir === 'prev' ? prevDisabled : nextDisabled;
    if (!on) return null;
    return (
      <IconButton
        variant="framed"
        size="staff"
        icon={dir === 'prev' ? 'chev-l' : 'chev-r'}
        label={t(dir === 'prev' ? PREV_KEY[period] : NEXT_KEY[period])}
        aria-disabled={off || undefined}
        className={off ? 'is-off' : undefined}
        onClick={() => { if (!off) on(); }}
      />
    );
  };
  return (
    <div className={cx('periodbar', `periodbar--${layout}`, className)}>
      {layout === 'ranking' ? switcher : null}
      <div className="periodbar__nav">
        {arrow('prev')}
        <div className="periodbar__range" aria-live="polite">
          <b>{label}</b>
          <span>{timeZone ? `${range} · ${timeZone}` : range}</span>
        </div>
        {arrow('next')}
      </div>
      {onCurrent ? (
        <Button variant="outline" size="staff" aria-disabled={isCurrent || undefined} onClick={onCurrent}>
          {t(THIS_KEY[period])}
        </Button>
      ) : null}
      {onPickDate ? (
        <span className="datepick">
          <Button variant="outline" size="staff" icon="calendar" opensDialog onClick={openPicker}>
            {t('common.period.pick')}
          </Button>
          <input
            ref={input}
            className="datepick__input"
            type="date"
            tabIndex={-1}
            aria-hidden="true"
            value={date ?? ''}
            min={minDate}
            max={maxDate}
            onChange={(e) => { if (e.target.value) onPickDate(e.target.value); }}
          />
        </span>
      ) : null}
      {children}
      {layout === 'stats' ? switcher : null}
    </div>
  );
}
