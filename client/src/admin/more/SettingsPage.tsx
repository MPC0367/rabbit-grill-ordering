// /admin/settings (settings.manage): grouped sections that each save on
// their own, a section index (sticky on wide screens, a jump menu on
// phones), an unsaved-changes guard, and the backup/restore procedure.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../lib/i18n.tsx';
import { useResource } from '../../lib/live.tsx';
import { useMedia } from '../../lib/store.ts';
import { Select, prefersReducedMotion } from '../../ui/index.ts';
import { useStaff } from '../shell/session.tsx';
import { ChargesSection, PaymentMethodsSection } from './ChargesSettings.tsx';
import { ModeSection, PermissionsSection } from './ModeAndPermissions.tsx';
import { OrderingSection } from './OrderingSettings.tsx';
import { SettingsContext, type SettingsCtx, type SettingsView } from './settingsParts.tsx';
import {
  AlcoholSection, AnalyticsSection, BusinessDaySection, CheckoutSection, JoinSection, MenuDisplaySection, NotificationsSection,
  PortionsSection, RestaurantSection, RetentionSection, ServicesSection,
} from './settingsSections.tsx';
import { Denied, MorePageFrame, ResourceGate, StaleBanner, usePlural, useTopicRefresh } from './shared.tsx';

const GROUPS: Array<{ id: string; sections: Array<{ id: string; key: string }> }> = [
  { id: 'place', sections: [{ id: 'restaurant', key: 'restaurant' }, { id: 'mode', key: 'mode' }, { id: 'day', key: 'day' }] },
  { id: 'service', sections: [{ id: 'ordering', key: 'ordering' }, { id: 'services', key: 'services' }, { id: 'join', key: 'join' }, { id: 'menu', key: 'menu' }, { id: 'portions', key: 'portions' }, { id: 'alcohol', key: 'alcohol' }] },
  { id: 'money', sections: [{ id: 'charges', key: 'charges' }, { id: 'payments', key: 'pay' }, { id: 'checkout', key: 'checkout' }] },
  { id: 'data', sections: [{ id: 'analytics', key: 'analytics' }, { id: 'retention', key: 'retention' }, { id: 'notifications', key: 'notify' }, { id: 'backup', key: 'backup' }] },
  { id: 'access', sections: [{ id: 'permissions', key: 'perm' }] },
];

function jumpTo(id: string) {
  const el = document.getElementById(`set-${id}`);
  if (!el) return;
  el.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  const h = el.querySelector<HTMLElement>('h2');
  if (h) {
    h.setAttribute('tabindex', '-1');
    h.focus({ preventScroll: true });
  }
  history.replaceState(history.state, '', `#${id}`);
}

function BackupSection() {
  const { t } = useI18n();
  return (
    <section id="set-backup" className="setsec setsec--static" aria-labelledby="set-backup-h">
      <header className="setsec__head">
        <div className="setsec__t"><h2 id="set-backup-h">{t('settings.backup.title')}</h2></div>
        <p className="setsec__d">{t('settings.backup.d')}</p>
      </header>
      <div className="setsec__body backup">
        <div>
          <h3 className="backup__h">{t('settings.backup.make')}</h3>
          <p>{t('settings.backup.makeD')}</p>
          <pre className="mp-code" lang="en"><code>npm run jobs -- backup --out backups/rabbit-grill-2026-09-17.db --with-reports</code></pre>
          <ul className="mp-list">
            <li>{t('settings.backup.m1')}</li>
            <li>{t('settings.backup.m2')}</li>
            <li>{t('settings.backup.m3')}</li>
          </ul>
        </div>
        <div>
          <h3 className="backup__h">{t('settings.backup.restore')}</h3>
          <ol className="mp-steps">
            <li>{t('settings.backup.r1')}</li>
            <li>{t('settings.backup.r2')}</li>
            <li>{t('settings.backup.r3')}</li>
            <li>{t('settings.backup.r4')}</li>
            <li>{t('settings.backup.r5')}</li>
            <li>{t('settings.backup.r6')}</li>
          </ol>
          <p className="mp-meta">{t('settings.backup.restoreCmd')} <code lang="en">npm run jobs -- restore</code></p>
        </div>
      </div>
    </section>
  );
}

export default function SettingsPage() {
  const { t } = useI18n();
  const { can } = useStaff();
  const plural = usePlural();
  const allowed = can('settings.manage');
  const res = useResource<SettingsView>(allowed ? '/api/staff/settings' : null, { topics: ['settings.', 'ordering.'] });
  useTopicRefresh(['settings.', 'ordering.'], () => (allowed ? res.refresh() : undefined));
  const wide = useMedia('(min-width: 1080px)');
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(new Set());

  const setDirty = useCallback((id: string, dirty: boolean) => {
    setDirtyIds((prev) => {
      if (prev.has(id) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(id); else next.delete(id);
      return next;
    });
  }, []);

  const { mutate, refresh } = res;
  const view = res.data;
  const ctx = useMemo<SettingsCtx | null>(() => (view ? { view, apply: (v) => mutate(v), refresh, setDirty } : null), [view, mutate, refresh, setDirty]);

  // Leaving the page with unsaved sections asks first (browser navigation and reload).
  useEffect(() => {
    if (dirtyIds.size === 0) return;
    const onLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirtyIds]);

  // Deep link: /admin/settings#charges
  useEffect(() => {
    if (!view) return;
    const id = window.location.hash.slice(1);
    if (id) requestAnimationFrame(() => jumpTo(id));
    // only once, when the data first arrives
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(view)]);

  if (!allowed) {
    return (
      <MorePageFrame title={t('settings.title')}>
        <Denied what={t('settings.title')} />
      </MorePageFrame>
    );
  }

  const label = (key: string) => t(`settings.${key}.title`);
  const index = (
    wide ? (
      <nav className="setnav" aria-label={t('settings.index')}>
        {GROUPS.map((g) => (
          <div key={g.id} className="setnav__g">
            <p className="setnav__k">{t(`settings.group.${g.id}`)}</p>
            <ul>
              {g.sections.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} onClick={(e) => { e.preventDefault(); jumpTo(s.id); }}>
                    <span>{label(s.key)}</span>
                    {dirtyIds.has(s.id) ? <span className="setnav__dot" title={t('settings.unsaved')}><span className="sr">{t('settings.unsaved')}</span></span> : null}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    ) : (
      <div className="setjump">
        <Select
          density="staff"
          label={t('settings.jump')}
          value=""
          placeholder={t('settings.jumpPh')}
          onChange={(e) => { if (e.target.value) jumpTo(e.target.value); }}
        >
          {GROUPS.map((g) => (
            <optgroup key={g.id} label={t(`settings.group.${g.id}`)}>
              {g.sections.map((s) => (
                <option key={s.id} value={s.id}>{label(s.key)}{dirtyIds.has(s.id) ? ` · ${t('settings.unsaved')}` : ''}</option>
              ))}
            </optgroup>
          ))}
        </Select>
      </div>
    )
  );

  return (
    <MorePageFrame
      title={t('settings.title')}
      description={t('settings.lede')}
      wide
      actions={dirtyIds.size ? <span className="setdirty" role="status">{plural('settings.dirtyCount', dirtyIds.size)}</span> : undefined}
    >
      <StaleBanner error={view ? res.error : null} onRetry={() => void res.refresh()} busy={res.loading} />
      {!ctx ? (
        <ResourceGate error={res.error} loading={res.loading} onRetry={() => void res.refresh()} what={t('settings.title')} rows={4} />
      ) : (
        <SettingsContext.Provider value={ctx}>
          <div className="setlayout">
            {index}
            <div className="setmain">
              {GROUPS.map((g) => (
                <div key={g.id} className="setgroup" role="group" aria-labelledby={`setg-${g.id}`}>
                  <p className="setgroup__k" id={`setg-${g.id}`}>{t(`settings.group.${g.id}`)}</p>
                  {g.sections.map((s) => {
                    switch (s.id) {
                      case 'restaurant': return <RestaurantSection key={s.id} />;
                      case 'mode': return <ModeSection key={s.id} />;
                      case 'day': return <BusinessDaySection key={s.id} />;
                      case 'ordering': return <OrderingSection key={s.id} />;
                      case 'services': return <ServicesSection key={s.id} />;
                      case 'join': return <JoinSection key={s.id} />;
                      case 'menu': return <MenuDisplaySection key={s.id} />;
                      case 'portions': return <PortionsSection key={s.id} />;
                      case 'alcohol': return <AlcoholSection key={s.id} />;
                      case 'charges': return <ChargesSection key={s.id} />;
                      case 'payments': return <PaymentMethodsSection key={s.id} />;
                      case 'checkout': return <CheckoutSection key={s.id} />;
                      case 'analytics': return <AnalyticsSection key={s.id} />;
                      case 'retention': return <RetentionSection key={s.id} />;
                      case 'notifications': return <NotificationsSection key={s.id} />;
                      case 'backup': return <BackupSection key={s.id} />;
                      case 'permissions': return <PermissionsSection key={s.id} />;
                      default: return null;
                    }
                  })}
                </div>
              ))}
            </div>
          </div>
        </SettingsContext.Provider>
      )}
    </MorePageFrame>
  );
}
