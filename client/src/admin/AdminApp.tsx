// Staff platform entry (docs/CLIENT.md): session gate, live stream, toasts,
// the shell layout and the routing table. Every /admin path renders
// something: a page, the sign-in form, a permission-denied or not-found
// panel, or an honest "cannot reach the restaurant system" state.
import '../i18n/admin-bundle.ts';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../lib/i18n.tsx';
import { LiveProvider } from '../lib/live.tsx';
import { navigate, useRoute } from '../lib/router.ts';
import { Button, Icon, ToastProvider, Wordmark } from '../ui/index.ts';
import { AdminLayout } from './shell/AdminLayout.tsx';
import { AttentionProvider } from './shell/attention.tsx';
import LoginPage from './shell/LoginPage.tsx';
import { OrderingProvider } from './shell/ordering.tsx';
import { ForbiddenPanel, NotFoundPanel, PageBoundary, PageLoading } from './shell/Panels.tsx';
import { allowed, canOpen, isAdminPath, landingFor, resolveRoute } from './shell/routes.tsx';
import { StaffSessionProvider, useSessionState, useStaff } from './shell/session.tsx';
import './shell/shell.css';

export default function AdminApp() {
  return (
    <StaffSessionProvider>
      <AdminGate />
    </StaffSessionProvider>
  );
}

function AppLoading() {
  const { t } = useI18n();
  return (
    <div className="app-loading" role="status" aria-live="polite">
      <span className="visually-hidden">{t('common.loading')}</span>
    </div>
  );
}

function AdminGate() {
  const session = useSessionState();
  if (session.status === 'loading') return <AppLoading />;
  if (session.status === 'unreachable') return <Unreachable onRetry={session.check} />;
  if (session.status === 'signed-out') return <SignedOut />;
  return <SignedIn />;
}

/** Signed out: every staff URL shows the sign-in form, remembering where the person was going. */
function SignedOut() {
  const session = useSessionState();
  const { path, query } = useRoute();
  useEffect(() => {
    if (path === '/admin/login') return;
    const intended = `${path}${query.toString() ? `?${query.toString()}` : ''}`;
    // A deliberate sign-out starts fresh; a lock, an ended session or a deep link returns to the page.
    const keep = session.reason !== 'signed-out' && isAdminPath(intended) && intended !== '/admin';
    navigate(keep ? `/admin/login?next=${encodeURIComponent(intended)}` : '/admin/login', { replace: true });
  }, [path, query, session.reason]);
  return <LoginPage />;
}

function Redirect({ to }: { to: string }) {
  useEffect(() => { navigate(to, { replace: true }); }, [to]);
  return <AppLoading />;
}

function SignedIn() {
  const { me, can } = useStaff();
  return (
    <LiveProvider key={me.user.id} url="/api/staff/events">
      <ToastProvider>
        <AttentionProvider enabled={can('orders.view')}>
          <OrderingProvider>
            <ShellRoutes />
          </OrderingProvider>
        </AttentionProvider>
      </ToastProvider>
    </LiveProvider>
  );
}

function ShellRoutes() {
  const { t } = useI18n();
  const { me, canAny } = useStaff();
  const { path, query } = useRoute();
  const search = query.toString() ? `?${query.toString()}` : '';
  const route = resolveRoute(path, search);
  const home = landingFor(me.user.id, me.landing, canAny);

  if (route.kind === 'login') {
    // Already signed in: continue to the intended page, or this person's start page.
    const next = query.get('next');
    const to = next && isAdminPath(next) && canOpen(next, canAny) ? next : home;
    return <Redirect to={to} />;
  }
  if (route.kind === 'redirect') return <Redirect to={route.to} />;

  const homeRoute = resolveRoute(new URL(home, window.location.origin).pathname);
  const homeLabel = homeRoute.kind === 'page' ? t(homeRoute.title) : t('admin.page.overview');

  let area = null as Parameters<typeof AdminLayout>[0]['area'];
  let body: ReactNode;
  let key: string;
  let title: string;
  let startable = false;
  let tab: string | undefined;
  if (route.kind === 'notfound') {
    key = `notfound:${path}`;
    title = 'admin.notFound.title';
    body = <NotFoundPanel home={home} />;
  } else if (!allowed(route, canAny)) {
    area = route.area;
    key = `forbidden:${route.key}`;
    title = 'admin.forbidden.title';
    body = <ForbiddenPanel home={home} homeLabel={homeLabel} />;
  } else {
    area = route.area;
    key = route.key;
    title = route.title;
    tab = route.tab;
    startable = true;
    body = route.render();
  }

  return (
    <AdminLayout area={area} tab={tab} pageKey={key} pageTitle={title} startable={startable}>
      <PageBoundary resetKey={path}>
        <Suspense fallback={<PageLoading />}>{body}</Suspense>
      </PageBoundary>
    </AdminLayout>
  );
}

function Unreachable({ onRetry }: { onRetry(): Promise<void> }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <div className="alogin alogin--simple">
      <main id="main" className="alogin__main">
        <div className="alogin__card">
          <Wordmark variant="staff" label={t('common.staff.home')} />
          {/* The kit EmptyState, with the page's h1 (EmptyState stops at h2). */}
          <div className="empty">
            <span className="empty__mark" aria-hidden="true"><Icon name="wifi-off" /></span>
            <h1>{t('admin.unreachable.title')}</h1>
            <p>{t('admin.unreachable.body')}</p>
            <div className="empty__act">
              <Button
                variant="primary"
                size="staff"
                icon="refresh"
                loading={busy}
                onClick={() => { setBusy(true); void onRetry().finally(() => setBusy(false)); }}
              >
                {t('admin.unreachable.action')}
              </Button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

