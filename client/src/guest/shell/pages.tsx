// Shell-level pages: not found, a page that failed to open, and the quiet
// placeholder shown while another page's code loads.
import { useI18n } from '../../lib/i18n.tsx';
import { Button, EmptyState, LinkButton, Skeleton } from '../../ui/index.ts';

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <main className="g-main g-main--narrow gpage">
      <h1 className="visually-hidden">{t('shell.title.notFound')}</h1>
      <EmptyState
        icon="info"
        headingLevel={2}
        title={t('shell.notFound.title')}
        action={<LinkButton href="/menu" variant="primary" icon="book">{t('shell.notFound.action')}</LinkButton>}
      >
        {t('shell.notFound.body')}
      </EmptyState>
    </main>
  );
}

export function PageErrorPanel({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <main className="g-main g-main--narrow gpage">
      <h1 className="visually-hidden">{t('shell.pageError.title')}</h1>
      <EmptyState
        icon="alert"
        headingLevel={2}
        title={t('shell.pageError.title')}
        action={<Button variant="primary" icon="refresh" onClick={onRetry}>{t('shell.pageError.action')}</Button>}
      >
        {t('shell.pageError.body')}
      </EmptyState>
    </main>
  );
}

/** Suspense fallback: the page's reserved shape, no spinner flash. */
export function PageLoading() {
  const { t } = useI18n();
  return (
    <div className="g-main g-main--narrow gpage gpage--loading" role="status" aria-live="polite">
      <span className="visually-hidden">{t('shell.loadingPage')}</span>
      <Skeleton width="38%" height={14} />
      <Skeleton width="62%" height={30} />
      <Skeleton shape="block" height={120} />
      <Skeleton shape="block" height={120} />
    </div>
  );
}
