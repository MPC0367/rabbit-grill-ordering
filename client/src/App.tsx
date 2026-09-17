// Top-level split: /admin/* is the staff platform, everything else is the guest menu.
// /ui-kit (development builds only) renders the design-system gallery.
import { lazy, Suspense } from 'react';
import { useRoute } from './lib/router.ts';
import { I18nProvider, useI18n } from './lib/i18n.tsx';
import { ConfigProvider } from './lib/config.tsx';

const GuestApp = lazy(() => import('./guest/GuestApp.tsx'));
// The staff kit stylesheet is staff-only, so guest phones never download it.
// It loads BEFORE the admin code: the admin screens' own stylesheets come
// after it and override it where they share a specificity (as they did when
// it sat in the entry).
const staffKitCss = () => import('./styles/admin-kit.css');
// The staff copy is large, plain data: fetch it beside the admin code, not inside it.
const AdminApp = lazy(() => staffKitCss()
  .then(() => Promise.all([import('./admin/AdminApp.tsx'), import('./i18n/admin-bundle.ts')]))
  .then(([m]) => m));
// Development only: the conditional lets the production build drop the gallery chunk.
const Gallery = import.meta.env.DEV
  ? lazy(() => Promise.all([staffKitCss(), import('./i18n/admin-bundle.ts')]).then(() => import('./ui/Gallery.tsx')))
  : null;

function Loading() {
  const { t } = useI18n();
  return <div className="app-loading" role="status" aria-live="polite"><span className="visually-hidden">{t('common.loading')}</span></div>;
}

export function App() {
  const { path } = useRoute();
  const admin = path === '/admin' || path.startsWith('/admin/');
  const gallery = Gallery !== null && path === '/ui-kit';
  return (
    <ConfigProvider>
      <I18nProvider scope={admin || gallery ? 'admin' : 'guest'}>
        <Suspense fallback={<Loading />}>
          {gallery && Gallery ? <Gallery /> : admin ? <AdminApp /> : <GuestApp />}
        </Suspense>
      </I18nProvider>
    </ConfigProvider>
  );
}
