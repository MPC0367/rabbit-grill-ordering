// The straightforward settings sections (brief 25): restaurant, business
// day, services, joining, menu display, portions, checkout, alcohol,
// analytics, data retention and notifications.
import type { PublicConfigDTO } from '../../../../shared/dto.ts';
import type { Settings } from '../../../../shared/settings.ts';
import { SERVICE_TYPES } from '../../../../shared/status.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { useResource } from '../../lib/live.tsx';
import { ChoiceGroup, KeyValue, Pill, RadioCard, Select, Skeleton, Switch, TextField } from '../../ui/index.ts';
import { fullDateTime, NumberField, numberProblem, useTopicRefresh } from './shared.tsx';
import { FieldRow, SettingsSection, SwitchRow, useRangeHelp, useSettingsCtx } from './settingsParts.tsx';
import { useEffect } from 'react';

type Errors = Record<string, string>;

/** Adds a range error for each out-of-range number. */
function useRangeCheck() {
  const { t } = useI18n();
  return (errors: Errors, path: string, v: number | null, min: number, max: number, nullable = false) => {
    const p = numberProblem(v, min, max, nullable);
    if (p === 'empty') errors[path] = t('settings.err.empty');
    else if (p === 'range') errors[path] = t('settings.err.range', { min, max });
  };
}

// ------------------------------------------------------------------ restaurant
export function RestaurantSection() {
  const { t } = useI18n();
  return (
    <SettingsSection
      id="restaurant"
      keys={['restaurant', 'default_locale'] as const}
      title={t('settings.restaurant.title')}
      description={t('settings.restaurant.d')}
      validate={(d) => {
        const e: Errors = {};
        for (const k of ['name_th', 'name_en', 'short_th', 'short_en'] as const) {
          if (!d.restaurant[k].trim()) e[`restaurant.${k}`] = t('settings.err.required');
        }
        return e;
      }}
    >
      {({ draft, merge, set, err }) => (
        <>
          <FieldRow>
            <TextField density="staff" label={t('settings.restaurant.nameTh')} value={draft.restaurant.name_th} maxLength={80} onChange={(e) => merge('restaurant', { name_th: e.target.value })} error={err('restaurant.name_th')} />
            <TextField density="staff" lang="en" label={t('settings.restaurant.nameEn')} value={draft.restaurant.name_en} maxLength={80} onChange={(e) => merge('restaurant', { name_en: e.target.value })} error={err('restaurant.name_en')} />
          </FieldRow>
          <FieldRow>
            <TextField density="staff" label={t('settings.restaurant.shortTh')} value={draft.restaurant.short_th} maxLength={40} onChange={(e) => merge('restaurant', { short_th: e.target.value })} help={t('settings.restaurant.shortHelp')} error={err('restaurant.short_th')} />
            <TextField density="staff" lang="en" label={t('settings.restaurant.shortEn')} value={draft.restaurant.short_en} maxLength={40} onChange={(e) => merge('restaurant', { short_en: e.target.value })} error={err('restaurant.short_en')} />
          </FieldRow>
          <FieldRow>
            <Select
              density="staff"
              label={t('settings.restaurant.locale')}
              value={draft.default_locale}
              onChange={(e) => set('default_locale', e.target.value as Settings['default_locale'])}
              options={[{ value: 'th', label: 'ไทย' }, { value: 'en', label: 'English' }]}
              help={t('settings.restaurant.localeHelp')}
              error={err('default_locale')}
            />
          </FieldRow>
        </>
      )}
    </SettingsSection>
  );
}

// ------------------------------------------------------------------ business day
export function BusinessDaySection() {
  const { t } = useI18n();
  return (
    <SettingsSection
      id="day"
      keys={['business_day_cutoff_hour'] as const}
      title={t('settings.day.title')}
      description={t('settings.day.d')}
    >
      {({ draft, set, err }) => (
        <FieldRow>
          <Select
            density="staff"
            label={t('settings.day.cutoff')}
            value={String(draft.business_day_cutoff_hour)}
            onChange={(e) => set('business_day_cutoff_hour', Number(e.target.value))}
            options={[0, 1, 2, 3, 4, 5, 6].map((h) => ({ value: String(h), label: h === 0 ? t('settings.day.midnight') : t('settings.day.hour', { h: `0${h}:00` }) }))}
            help={t('settings.day.help')}
            error={err('business_day_cutoff_hour')}
          />
        </FieldRow>
      )}
    </SettingsSection>
  );
}

// ------------------------------------------------------------------ services
function GuestServicesPreview() {
  const { t } = useI18n();
  const cfg = useResource<PublicConfigDTO>('/api/public/config', { topics: ['settings.', 'ordering.'] });
  // Also re-read right after this page saves the services (the event may arrive before the cache clears).
  const savedAt = useSettingsCtx().view.updated.services;
  const { refresh } = cfg;
  useTopicRefresh(['settings.', 'ordering.'], refresh);
  useEffect(() => {
    if (!savedAt) return;
    const timer = setTimeout(() => void refresh(), 300);
    return () => clearTimeout(timer);
  }, [savedAt, refresh]);
  return (
    <div className="setpreview" aria-live="polite">
      <p className="setpreview__k">{t('settings.services.preview')}</p>
      {cfg.data ? (
        cfg.data.services.length ? (
          <ul className="setpreview__list">
            {cfg.data.services.map((s) => <li key={s}><Pill tone="line" icon="bell" size="sm">{t(`service.${s}`)}</Pill></li>)}
          </ul>
        ) : <p className="mp-meta">{t('settings.services.previewNone')}</p>
      ) : cfg.error ? (
        <p className="mp-meta">{t('settings.services.previewFailed')}</p>
      ) : (
        <Skeleton width="60%" />
      )}
    </div>
  );
}

export function ServicesSection() {
  const { t } = useI18n();
  const check = useRangeCheck();
  const range = useRangeHelp();
  return (
    <SettingsSection
      id="services"
      keys={['services', 'service_cooldown_seconds'] as const}
      title={t('settings.services.title')}
      description={t('settings.services.d')}
      validate={(d) => {
        const e: Errors = {};
        check(e, 'service_cooldown_seconds', d.service_cooldown_seconds, 0, 600);
        return e;
      }}
      after={<GuestServicesPreview />}
    >
      {({ draft, merge, set, err }) => (
        <>
          <ul className="setlist">
            {SERVICE_TYPES.map((type) => (
              <li key={type} className="setlist__i">
                <SwitchRow help={<>{t(`settings.service.${type}.d`)}{type === 'water' || type === 'utensils' ? <> <b>{t('settings.services.confirmFirst')}</b></> : null}</>}>
                  <Switch
                    density="staff"
                    checked={draft.services[type]}
                    onChange={(v) => merge('services', { [type]: v } as Partial<Settings['services']>)}
                    label={t(`settings.service.${type}`)}
                  />
                </SwitchRow>
              </li>
            ))}
          </ul>
          <FieldRow>
            <NumberField
              label={t('settings.services.cooldown')}
              value={draft.service_cooldown_seconds}
              onChange={(v) => set('service_cooldown_seconds', v as number)}
              min={0}
              max={600}
              suffix={t('settings.unit.sec')}
              help={`${t('settings.services.cooldownHelp')} ${range(0, 600, t('settings.unit.seconds'))}`}
              error={err('service_cooldown_seconds')}
            />
          </FieldRow>
        </>
      )}
    </SettingsSection>
  );
}

// ------------------------------------------------------------------ joining
export function JoinSection() {
  const { t } = useI18n();
  const check = useRangeCheck();
  const range = useRangeHelp();
  return (
    <SettingsSection
      id="join"
      keys={['join'] as const}
      title={t('settings.join.title')}
      description={t('settings.join.d')}
      validate={(d) => {
        const e: Errors = {};
        check(e, 'join.pin_digits', d.join.pin_digits, 4, 8);
        check(e, 'join.max_failures', d.join.max_failures, 3, 20);
        check(e, 'join.lockout_minutes', d.join.lockout_minutes, 1, 120);
        return e;
      }}
      confirm={(d, b) => (b.join.pin_required && !d.join.pin_required ? {
        title: t('settings.join.offTitle'),
        body: <p>{t('settings.join.offBody')}</p>,
        confirmLabel: t('settings.join.offConfirm'),
        tone: 'danger',
      } : null)}
    >
      {({ draft, merge, err }) => (
        <>
          <SwitchRow help={draft.join.pin_required ? t('settings.join.pinOnHelp') : <b className="mp-warn-text">{t('settings.join.pinOffHelp')}</b>}>
            <Switch density="staff" checked={draft.join.pin_required} onChange={(v) => merge('join', { pin_required: v })} label={t('settings.join.pin')} />
          </SwitchRow>
          <FieldRow cols={3}>
            <NumberField label={t('settings.join.digits')} value={draft.join.pin_digits} onChange={(v) => merge('join', { pin_digits: v as number })} min={4} max={8} suffix={t('settings.unit.digits')} help={`${t('settings.join.digitsHelp')} ${range(4, 8, t('settings.unit.digitsLong'))}`} error={err('join.pin_digits')} disabled={!draft.join.pin_required} />
            <NumberField label={t('settings.join.failures')} value={draft.join.max_failures} onChange={(v) => merge('join', { max_failures: v as number })} min={3} max={20} suffix={t('settings.unit.times')} help={range(3, 20, t('settings.unit.attempts'))} error={err('join.max_failures')} disabled={!draft.join.pin_required} />
            <NumberField label={t('settings.join.lockout')} value={draft.join.lockout_minutes} onChange={(v) => merge('join', { lockout_minutes: v as number })} min={1} max={120} suffix={t('settings.unit.min')} help={range(1, 120, t('settings.unit.minutes'))} error={err('join.lockout_minutes')} disabled={!draft.join.pin_required} />
          </FieldRow>
        </>
      )}
    </SettingsSection>
  );
}

// ------------------------------------------------------------------ menu display
export function MenuDisplaySection() {
  const { t } = useI18n();
  const check = useRangeCheck();
  const range = useRangeHelp();
  return (
    <SettingsSection
      id="menu"
      keys={['menu'] as const}
      title={t('settings.menu.title')}
      description={t('settings.menu.d')}
      validate={(d) => {
        const e: Errors = {};
        check(e, 'menu.note_max_length', d.menu.note_max_length, 0, 500);
        return e;
      }}
    >
      {({ draft, merge, err }) => (
        <>
          <ChoiceGroup legend={t('settings.menu.soldOut')} className="setchoice">
            <RadioCard name="sold-out" type="radio" checked={draft.menu.sold_out_display === 'show_disabled'} onChange={() => merge('menu', { sold_out_display: 'show_disabled' })} label={t('settings.menu.soldOutShow')} description={t('settings.menu.soldOutShowD')} />
            <RadioCard name="sold-out" type="radio" checked={draft.menu.sold_out_display === 'hide'} onChange={() => merge('menu', { sold_out_display: 'hide' })} label={t('settings.menu.soldOutHide')} description={t('settings.menu.soldOutHideD')} />
          </ChoiceGroup>
          <FieldRow>
            <NumberField label={t('settings.menu.noteMax')} value={draft.menu.note_max_length} onChange={(v) => merge('menu', { note_max_length: v as number })} min={0} max={500} suffix={t('settings.unit.chars')} help={`${t('settings.menu.noteMaxHelp')} ${range(0, 500, t('settings.unit.characters'))}`} error={err('menu.note_max_length')} />
          </FieldRow>
        </>
      )}
    </SettingsSection>
  );
}

// ------------------------------------------------------------------ portions
export function PortionsSection() {
  const { t } = useI18n();
  const check = useRangeCheck();
  const range = useRangeHelp();
  return (
    <SettingsSection
      id="portions"
      keys={['portions'] as const}
      title={t('settings.portions.title')}
      description={t('settings.portions.d')}
      validate={(d) => {
        const e: Errors = {};
        check(e, 'portions.quote_expiry_minutes', d.portions.quote_expiry_minutes, 1, 120);
        return e;
      }}
    >
      {({ draft, merge, err }) => (
        <>
          <FieldRow>
            <NumberField label={t('settings.portions.expiry')} value={draft.portions.quote_expiry_minutes} onChange={(v) => merge('portions', { quote_expiry_minutes: v as number })} min={1} max={120} suffix={t('settings.unit.min')} help={`${t('settings.portions.expiryHelp')} ${range(1, 120, t('settings.unit.minutes'))}`} error={err('portions.quote_expiry_minutes')} />
          </FieldRow>
          <SwitchRow help={t('settings.portions.preferredHelp')}>
            <Switch density="staff" checked={draft.portions.allow_preferred_weight} onChange={(v) => merge('portions', { allow_preferred_weight: v })} label={t('settings.portions.preferred')} />
          </SwitchRow>
        </>
      )}
    </SettingsSection>
  );
}

// ------------------------------------------------------------------ checkout
export function CheckoutSection() {
  const { t } = useI18n();
  return (
    <SettingsSection id="checkout" keys={['checkout'] as const} title={t('settings.checkout.title')} description={t('settings.checkout.d')}>
      {({ draft, merge }) => (
        <ChoiceGroup legend={t('settings.checkout.after')} className="setchoice">
          <RadioCard name="after-checkout" checked={draft.checkout.after_checkout === 'available'} onChange={() => merge('checkout', { after_checkout: 'available' })} label={t('settings.checkout.available')} description={t('settings.checkout.availableD')} />
          <RadioCard name="after-checkout" checked={draft.checkout.after_checkout === 'needs_clearing'} disabled aside={t('settings.checkout.notYet')} label={t('settings.checkout.clearing')} description={t('settings.checkout.clearingD')} />
        </ChoiceGroup>
      )}
    </SettingsSection>
  );
}

// ------------------------------------------------------------------ alcohol
export function AlcoholSection() {
  const { t } = useI18n();
  return (
    <SettingsSection id="alcohol" keys={['alcohol'] as const} title={t('settings.alcohol.title')} description={t('settings.alcohol.d')}>
      {({ draft, merge }) => (
        <>
          <SwitchRow help={draft.alcohol.enabled ? t('settings.alcohol.onHelp') : t('settings.alcohol.offHelp')}>
            <Switch density="staff" checked={draft.alcohol.enabled} onChange={(v) => merge('alcohol', { enabled: v })} label={t('settings.alcohol.enabled')} />
          </SwitchRow>
          <SwitchRow help={t('settings.alcohol.noteHelp')}>
            <Switch density="staff" checked={draft.alcohol.staff_confirmation_note} onChange={(v) => merge('alcohol', { staff_confirmation_note: v })} label={t('settings.alcohol.note')} />
          </SwitchRow>
        </>
      )}
    </SettingsSection>
  );
}

// ------------------------------------------------------------------ analytics
export function AnalyticsSection() {
  const { t, lang } = useI18n();
  const check = useRangeCheck();
  const range = useRangeHelp();
  return (
    <SettingsSection
      id="analytics"
      keys={['analytics'] as const}
      title={t('settings.analytics.title')}
      description={t('settings.analytics.d')}
      validate={(d) => {
        const e: Errors = {};
        check(e, 'analytics.idle_threshold_seconds', d.analytics.idle_threshold_seconds, 10, 600);
        check(e, 'analytics.heartbeat_seconds', d.analytics.heartbeat_seconds, 5, 60);
        if (!e['analytics.heartbeat_seconds'] && !e['analytics.idle_threshold_seconds'] && d.analytics.heartbeat_seconds >= d.analytics.idle_threshold_seconds) {
          e['analytics.heartbeat_seconds'] = t('settings.err.heartbeat');
        }
        return e;
      }}
      toPatch={(d) => ({ analytics: { enabled: d.analytics.enabled, idle_threshold_seconds: d.analytics.idle_threshold_seconds, heartbeat_seconds: d.analytics.heartbeat_seconds } })}
    >
      {({ draft, merge, err }) => (
        <>
          <SwitchRow help={draft.analytics.enabled ? t('settings.analytics.onHelp') : t('settings.analytics.offHelp')}>
            <Switch density="staff" checked={draft.analytics.enabled} onChange={(v) => merge('analytics', { enabled: v })} label={t('settings.analytics.enabled')} />
          </SwitchRow>
          <FieldRow>
            <NumberField label={t('settings.analytics.idle')} value={draft.analytics.idle_threshold_seconds} onChange={(v) => merge('analytics', { idle_threshold_seconds: v as number })} min={10} max={600} suffix={t('settings.unit.sec')} help={`${t('settings.analytics.idleHelp')} ${range(10, 600, t('settings.unit.seconds'))}`} error={err('analytics.idle_threshold_seconds')} />
            <NumberField label={t('settings.analytics.heartbeat')} value={draft.analytics.heartbeat_seconds} onChange={(v) => merge('analytics', { heartbeat_seconds: v as number })} min={5} max={60} suffix={t('settings.unit.sec')} help={`${t('settings.analytics.heartbeatHelp')} ${range(5, 60, t('settings.unit.seconds'))}`} error={err('analytics.heartbeat_seconds')} />
          </FieldRow>
          <KeyValue
            items={[{
              key: 'start',
              term: t('settings.analytics.started'),
              value: draft.analytics.instrumentation_started_at ? fullDateTime(draft.analytics.instrumentation_started_at, lang) : t('settings.analytics.notStarted'),
              muted: !draft.analytics.instrumentation_started_at,
            }]}
          />
          <div className="setnotice">
            <p className="setnotice__k">{t('settings.analytics.noticeTitle')}</p>
            <ul className="mp-list">
              <li>{t('settings.analytics.n1')}</li>
              <li>{t('settings.analytics.n2')}</li>
              <li>{t('settings.analytics.n3')}</li>
              <li>{t('settings.analytics.n4')}</li>
            </ul>
          </div>
        </>
      )}
    </SettingsSection>
  );
}

// ------------------------------------------------------------------ retention
const RETENTION: Array<{ key: keyof Settings['retention']; min: number }> = [
  { key: 'notes_days', min: 30 },
  { key: 'feedback_days', min: 30 },
  { key: 'raw_events_days', min: 30 },
  { key: 'audit_days', min: 365 },
];

export function RetentionSection() {
  const { t } = useI18n();
  const check = useRangeCheck();
  const range = useRangeHelp();
  return (
    <SettingsSection
      id="retention"
      keys={['retention'] as const}
      title={t('settings.retention.title')}
      description={t('settings.retention.d')}
      validate={(d) => {
        const e: Errors = {};
        for (const r of RETENTION) check(e, `retention.${r.key}`, d.retention[r.key], r.min, 3650);
        return e;
      }}
      after={<p className="setnote"><b>{t('settings.retention.rollover')}</b> {t('settings.retention.rolloverD')}</p>}
    >
      {({ draft, merge, err }) => (
        <FieldRow>
          {RETENTION.map((r) => (
            <NumberField
              key={r.key}
              label={t(`settings.retention.${r.key}`)}
              value={draft.retention[r.key]}
              onChange={(v) => merge('retention', { [r.key]: v } as Partial<Settings['retention']>)}
              min={r.min}
              max={3650}
              suffix={t('settings.unit.days')}
              help={`${t(`settings.retention.${r.key}.d`)} ${range(r.min, 3650, t('settings.unit.daysLong'))}`}
              error={err(`retention.${r.key}`)}
            />
          ))}
        </FieldRow>
      )}
    </SettingsSection>
  );
}

// ------------------------------------------------------------------ notifications
export function NotificationsSection() {
  const { t } = useI18n();
  return (
    <SettingsSection id="notifications" keys={['notifications'] as const} title={t('settings.notify.title')} description={t('settings.notify.d')}>
      {({ draft, merge }) => (
        <SwitchRow help={t('settings.notify.soundHelp')}>
          <Switch density="staff" checked={draft.notifications.sound_default} onChange={(v) => merge('notifications', { sound_default: v })} label={t('settings.notify.sound')} />
        </SwitchRow>
      )}
    </SettingsSection>
  );
}
