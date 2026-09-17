// Whole-page states for the staff shell: not found, permission denied, a page
// that failed to load or crashed, and the quiet loading placeholder.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useI18n } from '../../lib/i18n.tsx';
import { Button, EmptyState, LinkButton, Skeleton } from '../../ui/index.ts';
import { useStaff } from './session.tsx';

export function NotFoundPanel({ home }: { home: string }) {
  const { t } = useI18n();
  return (
    <section className="apanel" aria-labelledby="apanel-title">
      <EmptyState
        icon="search"
        headingLevel={2}
        title={<span id="apanel-title">{t('admin.notFound.title')}</span>}
        action={<LinkButton href={home} variant="primary" size="staff" icon="arrow-r">{t('admin.notFound.action')}</LinkButton>}
      >
        {t('admin.notFound.body')}
      </EmptyState>
    </section>
  );
}

export function ForbiddenPanel({ home, homeLabel }: { home: string; homeLabel: string }) {
  const { t } = useI18n();
  const { me } = useStaff();
  return (
    <section className="apanel" aria-labelledby="apanel-title">
      <EmptyState
        icon="lock"
        headingLevel={2}
        title={<span id="apanel-title">{t('admin.forbidden.title')}</span>}
        action={<LinkButton href={home} variant="primary" size="staff" icon="arrow-r">{t('admin.forbidden.action', { page: homeLabel })}</LinkButton>}
      >
        {t('admin.forbidden.body', { name: me.user.display_name, role: t(`admin.role.${me.user.role}`) })}
      </EmptyState>
    </section>
  );
}

/** Placeholder while a page module loads (nothing appears for the first 400 ms). */
export function PageLoading() {
  const { t } = useI18n();
  return (
    <div className="apanel apanel--loading" role="status" aria-live="polite">
      <span className="visually-hidden">{t('common.loading')}</span>
      <div className="apanel__skel" aria-hidden="true">
        <Skeleton shape="block" height={56} />
        <div className="apanel__skelrow">
          <Skeleton shape="block" height={132} />
          <Skeleton shape="block" height={132} />
          <Skeleton shape="block" height={132} />
        </div>
        <Skeleton shape="block" height={220} />
      </div>
    </div>
  );
}

function CrashPanel({ chunk, onRetry }: { chunk: boolean; onRetry(): void }) {
  const { t } = useI18n();
  return (
    <section className="apanel" aria-labelledby="apanel-title">
      <EmptyState
        icon="alert"
        headingLevel={2}
        title={<span id="apanel-title">{chunk ? t('admin.crash.chunkTitle') : t('admin.crash.title')}</span>}
        action={<Button variant="primary" size="staff" icon="refresh" onClick={onRetry}>{t('admin.crash.action')}</Button>}
      >
        {chunk ? t('admin.crash.chunkBody') : t('admin.crash.body')}
      </EmptyState>
    </section>
  );
}

interface BoundaryProps { resetKey: string; children: ReactNode }
interface BoundaryState { error: Error | null; key: string }

/** Keeps one broken page from blanking the whole shell. Resets when the route changes. */
export class PageBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[admin page]', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // A new deployment replaced the page chunk: reloading fetches the new one.
    const chunk = /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(error.message);
    return <CrashPanel chunk={chunk} onRetry={() => (chunk ? window.location.reload() : this.setState({ error: null }))} />;
  }
}
