// Guest banners under the masthead (DESIGN §10.26, brief 30):
// offline, ordering paused / closed hours / busy kitchen, table paused,
// checking out, public browsing, visit ended, demo data. Most urgent first;
// never two banners that say the same thing. They push content down and
// never overlap the sticky chrome.
import type { ReactNode } from 'react';
import { useConfig } from '../../lib/config.tsx';
import { useI18n } from '../../lib/i18n.tsx';
import { Banner, Button, type BannerVariant } from '../../ui/index.ts';
import type { GuestRouteKey } from './hooks.ts';
import { useGuestConnection } from './hooks.ts';
import { useOverlays } from './overlays.tsx';
import { useGuestSession } from './session.tsx';

interface Item {
  key: string;
  variant: BannerVariant;
  title: string;
  body: ReactNode;
  icon?: 'clock' | 'lock';
  callStaff?: boolean;
}

export function GuestBanners({ route }: { route: GuestRouteKey }) {
  const { t, pick } = useI18n();
  const { config } = useConfig();
  const { mode, session, endedReason } = useGuestSession();
  const { openService } = useOverlays();

  const joined = mode === 'joined' && session !== null;
  const reason = joined ? session.ordering.reason : null;
  const items: Item[] = [];

  // 1. connection
  const { offline } = useGuestConnection(joined);
  if (offline) {
    items.push({ key: 'offline', variant: 'offline', title: t('shell.banner.offline.title'), body: t('shell.banner.offline.body') });
  }

  // 2. why ordering is blocked (restaurant-wide first, then this table)
  const showOrderingState = mode !== 'ended' && route !== 'join';
  if (showOrderingState) {
    const paused = (config && !config.ordering.enabled) || reason === 'ordering_paused';
    const closedHours = !paused && ((config && config.ordering.within_hours === false) || reason === 'outside_hours');
    if (paused) {
      const msg = config ? pick(config.ordering.paused_message) : null;
      items.push({
        key: 'paused',
        variant: 'paused',
        title: t('shell.banner.paused.title'),
        body: msg && msg.text ? <span lang={msg.lang}>{msg.text}</span> : t('shell.banner.paused.body'),
        callStaff: joined,
      });
    } else if (closedHours) {
      items.push({ key: 'hours', variant: 'paused', icon: 'clock', title: t('shell.banner.hours.title'), body: t('shell.banner.hours.body') });
    }
    if (joined) {
      const billing = session.visit.status === 'billing' || reason === 'visit_billing';
      if (billing) {
        items.push({ key: 'billing', variant: 'billing', title: t('shell.banner.billing.title'), body: t('shell.banner.billing.body'), callStaff: true });
      } else if (reason === 'table_paused') {
        items.push({ key: 'table-paused', variant: 'paused', title: t('shell.banner.tablePaused.title'), body: t('shell.banner.tablePaused.body'), callStaff: true });
      } else if (reason === 'table_disabled') {
        items.push({ key: 'table-off', variant: 'paused', title: t('shell.banner.tableOff.title'), body: t('shell.banner.tableOff.body'), callStaff: true });
      } else if (reason === 'intake_full' && !paused) {
        items.push({ key: 'busy', variant: 'warning', title: t('shell.banner.busy.title'), body: t('shell.banner.busy.body') });
      }
    }
  }

  // 3. who is looking (menu only; the visit pages explain themselves)
  if (route === 'menu') {
    if (mode === 'public') {
      items.push({ key: 'public', variant: 'info', title: t('shell.banner.public.title'), body: t('shell.banner.public.body') });
    } else if (mode === 'ended') {
      const revoked = endedReason === 'visit_access_revoked';
      items.push({
        key: 'ended',
        variant: 'info',
        icon: revoked ? 'lock' : undefined,
        title: t(revoked ? 'shell.banner.revoked.title' : 'shell.banner.closed.title'),
        body: t(revoked ? 'shell.banner.revoked.body' : 'shell.banner.closed.body'),
      });
    }
  }

  // 4. demo data, everywhere
  if (config?.operating_mode === 'demo') {
    items.push({ key: 'demo', variant: 'demo', title: t('shell.banner.demo.title'), body: t('shell.banner.demo.body') });
  }

  if (!items.length) return null;
  return (
    <div className="gshell-banners">
      {items.map((b) => (
        <Banner
          key={b.key}
          variant={b.variant}
          title={b.title}
          icon={b.icon}
          data-banner={b.key}
          action={b.callStaff && !offline ? (
            <Button variant="outline" icon="bell" opensDialog onClick={openService}>{t('shell.callStaff')}</Button>
          ) : undefined}
        >
          {b.body}
        </Banner>
      ))}
    </div>
  );
}
