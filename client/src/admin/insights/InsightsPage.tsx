// Insights (brief 26, 37–40, 43; mock design-lab/final/admin-stats.html).
// Three views under /admin/stats/orders|menu|engagement. The admin layout
// (C4a) draws the workspace header and its subtabs and moves focus on
// navigation; this page draws the demo-data notice and the view. Every
// choice lives in the URL query.
import type { StaffMeDTO } from '../../../../shared/dto.ts';
import { useConfig } from '../../lib/config.tsx';
import { useI18n } from '../../lib/i18n.tsx';
import { useRoute } from '../../lib/router.ts';
import { ErrorPanel, DemoNotice, LoadingBlock, PermissionPanel, useLiveResource } from './parts.tsx';
import { readFixture, useBusinessToday } from './query.ts';
import OrderStats from './OrderStats.tsx';
import MenuStats from './MenuStats.tsx';
import Engagement from './Engagement.tsx';
import './insights.css';

export type InsightsTab = 'orders' | 'menu' | 'engagement';

export default function InsightsPage({ tab }: { tab: InsightsTab }) {
  const { t } = useI18n();
  const { query } = useRoute();
  const { config } = useConfig();
  const me = useLiveResource<StaffMeDTO>('/api/staff/auth/me', { topics: ['settings.'] });
  const headingId = `insx-h-${tab}`;

  // Server clock and business-day cutoff for every view below (and a re-render each minute).
  useBusinessToday();

  if (!me.data) {
    if (me.error) {
      return (
        <div className="insx">
          <div className="ins"><ErrorPanel error={me.error} onRetry={() => void me.refresh()} /></div>
        </div>
      );
    }
    return (
      <div className="insx">
        <div className="ins"><LoadingBlock label={t('insights.state.loading')} height={480} /></div>
      </div>
    );
  }

  const perms = new Set(me.data.permissions);
  if (!perms.has('stats.view')) {
    return <div className="insx"><div className="ins"><PermissionPanel need="stats" /></div></div>;
  }
  if (tab === 'engagement' && !perms.has('stats.engagement')) {
    return <div className="insx"><div className="ins"><PermissionPanel need="engagement" /></div></div>;
  }

  const demoMode = (me.data.operating_mode ?? config?.operating_mode) === 'demo';
  const includeFixture = readFixture(query, demoMode);

  return (
    <div className="insx" data-tab={tab}>
      <DemoNotice demoMode={demoMode} included={includeFixture} />
      <div className="ins insx-body">
        {tab === 'orders' ? (
          <>
            <h2 id={headingId} className="visually-hidden">{t('insights.tab.orders')}</h2>
            <OrderStats includeFixture={includeFixture} headingId={headingId} />
          </>
        ) : (
          <>
            {tab === 'menu' ? (
              <MenuStats includeFixture={includeFixture} headingId={headingId} />
            ) : (
              <Engagement
                includeFixture={includeFixture}
                headingId={headingId}
                canExportRaw={perms.has('reports.export_raw')}
                canSettings={perms.has('settings.manage')}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
