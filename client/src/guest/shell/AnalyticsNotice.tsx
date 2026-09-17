// The analytics notice and the per-device opt-out (brief 39; DECISIONS
// D-C3-03, D-G-02). Shown only while the restaurant has menu measurement
// turned on. Never a modal or a banner that stands in the way: a quiet block
// at the end of the menu and at the foot of the service sheet. Turning it off
// stops collection on this browser (the tracker sends one final session_end
// marked opted_out) and ordering works exactly the same.
import { useId } from 'react';
import { useConfig } from '../../lib/config.tsx';
import { useI18n } from '../../lib/i18n.tsx';
import { useAnalyticsOptOut } from '../../lib/tracker.ts';
import { Icon, Switch, announce, cx } from '../../ui/index.ts';

export function AnalyticsNotice({ variant = 'footer', className }: { variant?: 'footer' | 'sheet'; className?: string }) {
  const { t } = useI18n();
  const { config } = useConfig();
  const { optedOut, setOptOut } = useAnalyticsOptOut();
  const id = useId();
  if (!config?.analytics.enabled) return null;
  const measuring = !optedOut;
  const Heading = variant === 'sheet' ? 'h3' : 'h2';
  return (
    <section className={cx('gmeasure', `gmeasure--${variant}`, className)} aria-labelledby={`${id}-t`} data-measuring={measuring}>
      <Heading className="gmeasure__t" id={`${id}-t`}>
        <Icon name="info" size="sm" />
        {t('shell.measure.title')}
      </Heading>
      <p className="gmeasure__body" id={`${id}-d`}>{t('shell.measure.body')}</p>
      <Switch
        className="gmeasure__switch"
        checked={measuring}
        onChange={(next) => {
          setOptOut(!next);
          announce(t(next ? 'shell.measure.onToast' : 'shell.measure.offToast'));
        }}
        label={t('shell.measure.switch')}
        onLabel={t('shell.measure.on')}
        offLabel={t('shell.measure.off')}
        aria-describedby={`${id}-d`}
      />
    </section>
  );
}
