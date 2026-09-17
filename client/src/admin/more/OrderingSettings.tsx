// Ordering settings (brief 25): guest ordering on/off (pausing always asks
// first), the pause message in both languages, an honest optional wait
// estimate, the intake limit, and weekly opening hours with the
// "confirmed by the restaurant" flag that enforcement depends on.
import type { DayHours, Settings } from '../../../../shared/settings.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Button, Checkbox, IconButton, Switch, TextArea, TextField } from '../../ui/index.ts';
import { NumberField, numberProblem } from './shared.tsx';
import { FieldRow, SettingsSection, SwitchRow, useRangeHelp, type DraftApi } from './settingsParts.tsx';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const MAX_RANGES = 3;

/** 24-hour text entry: "930" -> "09:30", "21.5" stays as typed so validation can flag it. */
function toHhmm(raw: string): string {
  const s = raw.trim().replace(/[.\s]/g, ':');
  const digits = s.replace(':', '');
  let m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m && /^\d{3,4}$/.test(digits) && !s.includes(':')) m = /^(\d{1,2})(\d{2})$/.exec(digits);
  if (!m && /^\d{1,2}$/.test(s)) return `${s.padStart(2, '0')}:00`;
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : raw.trim();
}

type Ordering = Settings['ordering'];

/**
 * Called inline from the section's render (not as a component) so the section
 * knows which errors are already shown next to their day.
 */
function hoursEditor(d: DraftApi<'ordering'>, t: (key: string, vars?: Record<string, string | number>) => string) {
  const week = d.draft.ordering.weekly_hours;
  const setDay = (i: number, ranges: DayHours[]) => {
    const next = week.map((r, j) => (j === i ? ranges : r));
    d.merge('ordering', { weekly_hours: next });
  };
  return (
    <fieldset className="hours">
      <legend className="hours__legend">{t('settings.ordering.hours')}</legend>
      <p className="setswitch__help">{t('settings.ordering.hoursHelp')}</p>
      <ol className="hours__days">
        {week.map((ranges, i) => {
          const day = t(`settings.wd.${i}`);
          const err = d.err(`ordering.weekly_hours.${i}`);
          const closed = ranges.length === 0;
          return (
            <li key={i} className={closed ? 'hours__day is-closed' : 'hours__day'}>
              <span className="hours__name" id={`hours-d${i}`}>{day}</span>
              <div className="hours__ranges" role="group" aria-labelledby={`hours-d${i}`}>
                {closed ? <span className="hours__closed">{t('settings.ordering.closed')}</span> : null}
                {ranges.map((r, j) => (
                  <span key={j} className="hours__range">
                    {(['open', 'close'] as const).map((edge, n) => (
                      <span key={edge} className="hours__edge">
                        {n === 1 ? <span aria-hidden="true" className="hours__dash">–</span> : null}
                        <TextField
                          density="staff"
                          hideLabel
                          label={t(edge === 'open' ? 'settings.ordering.opensAt' : 'settings.ordering.closesAt', { day, n: j + 1 })}
                          value={r[edge]}
                          inputMode="numeric"
                          maxLength={5}
                          placeholder={edge === 'open' ? '11:00' : '21:00'}
                          autoComplete="off"
                          lang="en"
                          aria-invalid={err ? true : undefined}
                          onChange={(e) => setDay(i, ranges.map((x, k) => (k === j ? { ...x, [edge]: e.target.value } : x)))}
                          onBlur={(e) => {
                            const fixed = toHhmm(e.target.value);
                            if (fixed !== r[edge]) setDay(i, ranges.map((x, k) => (k === j ? { ...x, [edge]: fixed } : x)));
                          }}
                        />
                      </span>
                    ))}
                    <IconButton
                      icon="x"
                      size="staff"
                      label={t('settings.ordering.removeRange', { day, from: r.open, to: r.close })}
                      onClick={() => setDay(i, ranges.filter((_, k) => k !== j))}
                    />
                  </span>
                ))}
                {ranges.length < MAX_RANGES ? (
                  <Button
                    variant="ghost"
                    size="staff"
                    icon="plus"
                    onClick={() => setDay(i, [...ranges, ranges.length ? { open: '17:00', close: '21:00' } : { open: '11:00', close: '21:00' }])}
                  >
                    {closed ? t('settings.ordering.openDay') : t('settings.ordering.addRange')}
                    <span className="sr"> · {day}</span>
                  </Button>
                ) : null}
              </div>
              {err ? <p className="field__error hours__err">{err}</p> : null}
            </li>
          );
        })}
      </ol>
    </fieldset>
  );
}

export function OrderingSection() {
  const { t } = useI18n();
  const range = useRangeHelp();
  return (
    <SettingsSection
      id="ordering"
      keys={['ordering'] as const}
      title={t('settings.ordering.title')}
      description={t('settings.ordering.d')}
      validate={({ ordering: o }) => {
        const e: Record<string, string> = {};
        if (!o.paused_message_th.trim()) e['ordering.paused_message_th'] = t('settings.err.required');
        if (!o.paused_message_en.trim()) e['ordering.paused_message_en'] = t('settings.err.required');
        const wait = numberProblem(o.estimated_wait_minutes, 1, 240, true);
        if (wait) e['ordering.estimated_wait_minutes'] = t('settings.err.range', { min: 1, max: 240 });
        const intake = numberProblem(o.intake_limit, 1, 500, true);
        if (intake) e['ordering.intake_limit'] = t('settings.err.range', { min: 1, max: 500 });
        o.weekly_hours.forEach((ranges, i) => {
          if (ranges.some((r) => !HHMM.test(r.open) || !HHMM.test(r.close))) { e[`ordering.weekly_hours.${i}`] = t('settings.err.hoursFormat'); return; }
          if (ranges.some((r) => mins(r.close) <= mins(r.open))) { e[`ordering.weekly_hours.${i}`] = t('settings.err.hoursOrder'); return; }
          const sorted = [...ranges].sort((a, b) => mins(a.open) - mins(b.open));
          if (sorted.some((r, j) => j > 0 && mins(r.open) < mins(sorted[j - 1].close))) e[`ordering.weekly_hours.${i}`] = t('settings.err.hoursOverlap');
        });
        if (o.enforce_hours && !o.hours_verified) e['ordering.enforce_hours'] = t('settings.err.enforceHours');
        return e;
      }}
      confirm={({ ordering: o }, { ordering: b }) => {
        if (b.enabled && !o.enabled) {
          return {
            title: t('settings.ordering.pauseTitle'),
            body: (
              <>
                <p>{t('settings.ordering.pauseBody')}</p>
                <blockquote className="setquote">
                  <p lang="th">{o.paused_message_th}</p>
                  <p lang="en">{o.paused_message_en}</p>
                </blockquote>
              </>
            ),
            confirmLabel: t('settings.ordering.pauseConfirm'),
            tone: 'danger',
          };
        }
        if (!b.enforce_hours && o.enforce_hours) {
          return { title: t('settings.ordering.enforceTitle'), body: <p>{t('settings.ordering.enforceBody')}</p>, confirmLabel: t('settings.ordering.enforceConfirm') };
        }
        return null;
      }}
    >
      {(d) => {
        const o: Ordering = d.draft.ordering;
        const m = (p: Partial<Ordering>) => d.merge('ordering', p);
        return (
          <>
            <SwitchRow help={o.enabled ? t('settings.ordering.enabledOn') : <b className="mp-warn-text">{t('settings.ordering.enabledOff')}</b>}>
              <Switch density="staff" checked={o.enabled} onChange={(v) => m({ enabled: v })} label={t('settings.ordering.enabled')} onLabel={t('settings.ordering.open')} offLabel={t('settings.ordering.paused')} />
            </SwitchRow>
            <FieldRow>
              <TextArea density="staff" label={t('settings.ordering.msgTh')} value={o.paused_message_th} limit={300} onChange={(v) => m({ paused_message_th: v })} help={t('settings.ordering.msgHelp')} error={d.err('ordering.paused_message_th')} />
              <TextArea density="staff" lang="en" label={t('settings.ordering.msgEn')} value={o.paused_message_en} limit={300} onChange={(v) => m({ paused_message_en: v })} error={d.err('ordering.paused_message_en')} />
            </FieldRow>
            <FieldRow>
              <NumberField
                optional
                label={t('settings.ordering.wait')}
                value={o.estimated_wait_minutes}
                onChange={(v) => m({ estimated_wait_minutes: v })}
                min={1}
                max={240}
                suffix={t('settings.unit.min')}
                help={`${t('settings.ordering.waitHelp')} ${range(1, 240, t('settings.unit.minutes'))}`}
                error={d.err('ordering.estimated_wait_minutes')}
              />
              <NumberField
                optional
                label={t('settings.ordering.intake')}
                value={o.intake_limit}
                onChange={(v) => m({ intake_limit: v })}
                min={1}
                max={500}
                suffix={t('settings.unit.rounds')}
                help={`${t('settings.ordering.intakeHelp')} ${range(1, 500, t('settings.unit.roundsLong'))}`}
                error={d.err('ordering.intake_limit')}
              />
            </FieldRow>
            {hoursEditor(d, t)}
            <div className="setswitch">
              <Checkbox
                checked={o.hours_verified}
                onChange={(e) => m(e.target.checked ? { hours_verified: true } : { hours_verified: false, enforce_hours: false })}
                label={t('settings.ordering.verified')}
                description={t('settings.ordering.verifiedHelp')}
              />
            </div>
            <SwitchRow help={o.hours_verified ? t('settings.ordering.enforceHelp') : t('settings.ordering.enforceLocked')}>
              <Switch
                density="staff"
                checked={o.enforce_hours}
                disabled={!o.hours_verified}
                onChange={(v) => m({ enforce_hours: v })}
                label={t('settings.ordering.enforce')}
                aria-invalid={d.err('ordering.enforce_hours') ? true : undefined}
              />
            </SwitchRow>
            {d.err('ordering.enforce_hours') ? <p className="field__error">{d.err('ordering.enforce_hours')}</p> : null}
          </>
        );
      }}
    </SettingsSection>
  );
}
