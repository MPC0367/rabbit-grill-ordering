// Top-level split: /admin/* is the staff platform, everything else is the guest menu.
// /ui-kit (development builds only) renders the design-system gallery.
import { lazy, Suspense } from 'react';
import { useRoute } from './lib/router.ts';
import { I18nProvider } from './lib/i18n.tsx';
import { ConfigProvider } from './lib/config.tsx';

const GuestApp = lazy(() => import('./guest/GuestApp.tsx'));
const AdminApp = lazy(() => import('./admin/AdminApp.tsx'));
const Gallery = lazy(() => import('./ui/Gallery.tsx'));

function Loading() {
  return <div className="app-loading" role="status" aria-live="polite"><span className="visually-hidden">Loading…</span></div>;
}

export function App() {
  const { path } = useRoute();
  const admin = path === '/admin' || path.startsWith('/admin/');
  const gallery = import.meta.env.DEV && path === '/ui-kit';
  return (
    <ConfigProvider>
      <I18nProvider scope={admin || gallery ? 'admin' : 'guest'}>
        <Suspense fallback={<Loading />}>
          {gallery ? <Gallery /> : admin ? <AdminApp /> : <GuestApp />}
        </Suspense>
      </I18nProvider>
    </ConfigProvider>
  );
}
