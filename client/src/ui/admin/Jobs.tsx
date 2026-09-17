// Report job row (brief 41): Queued / Generating / Ready / Failed, always in
// words with an icon, with Download when ready and Retry when failed.
import type { HTMLAttributes, ReactNode } from 'react';
import type { JobStatus, ReportLabel } from '../../../../shared/status.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { StatusPill, Tag } from '../Badge.tsx';
import { Button, LinkButton } from '../Button.tsx';
import { cx, Ico, type AdminIconName } from './parts.tsx';

const JOB_MARK: Record<JobStatus, AdminIconName> = {
  queued: 'clock',
  generating: 'refresh',
  ready: 'download',
  failed: 'alert',
};

export interface JobStatusRowProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** "Annual report 2026 · PDF" */
  title: string;
  /** "Requested by Nok · 17 Sep, 19:40 · data to 19:40" */
  meta?: ReactNode;
  status: JobStatus;
  label?: ReportLabel;
  /** Revision number for "Revised v2". */
  revision?: number;
  /** "2.4 MB" */
  size?: string;
  error?: string | null;
  attempts?: number;
  /** The file includes demo fixtures. */
  fixture?: boolean;
  /** Ready: a download link (preferred) or a callback. */
  downloadHref?: string;
  onDownload?: () => void;
  onRetry?: () => void;
  retrying?: boolean;
  as?: 'div' | 'li';
}

export function JobStatusRow({
  title, meta, status, label, revision, size, error, attempts, fixture, downloadHref, onDownload, onRetry, retrying,
  as = 'div', className, ...rest
}: JobStatusRowProps) {
  const { t, lang } = useI18n();
  const Row = as;
  const labelText = label === 'revised' ? t('common.job.revised', { n: revision ?? 2 })
    : label === 'final' ? t('common.job.final')
    : label === 'provisional' ? t('common.job.provisional')
    : null;
  return (
    <Row {...rest} className={cx('job', `job--${status}`, className)}>
      <span className="job__mark" aria-hidden="true"><Ico name={JOB_MARK[status]} /></span>
      <div className="job__main">
        <p className="job__t">
          <span className="job__name">{title}</span>
          {labelText ? <Tag tone={label === 'final' ? 'line' : 'heat'} lang={lang}>{labelText}</Tag> : null}
          {fixture ? <Tag tone="example" lang={lang}>{t('common.job.demo')}</Tag> : null}
        </p>
        {meta ? <p className="job__m">{meta}</p> : null}
        {status === 'failed' && error ? (
          <p className="job__err">
            <Ico name="alert" size="sm" />
            <span>
              {error}
              {attempts ? ` · ${t('common.job.attempt', { n: attempts })}` : ''}
            </span>
          </p>
        ) : null}
      </div>
      <span className="job__status" role="status">
        <StatusPill kind="job" status={status} />
        {status === 'ready' && size ? <span className="job__size">{size}</span> : null}
      </span>
      <span className="job__act">
        {status === 'ready' && downloadHref ? (
          <LinkButton variant="outline" size="staff" icon="download" href={downloadHref} download external>
            {t('common.job.download')}
            <span className="sr"> · {title}</span>
          </LinkButton>
        ) : status === 'ready' && onDownload ? (
          <Button variant="outline" size="staff" icon="download" onClick={onDownload}>
            {t('common.job.download')}
            <span className="sr"> · {title}</span>
          </Button>
        ) : status === 'failed' && onRetry ? (
          <Button variant="outline" size="staff" icon="refresh" loading={retrying} onClick={onRetry}>
            {t('common.retry')}
            <span className="sr"> · {title}</span>
          </Button>
        ) : null}
      </span>
    </Row>
  );
}

/** List wrapper for job rows. */
export function JobList({ className, children, ...rest }: HTMLAttributes<HTMLUListElement>) {
  return <ul {...rest} className={cx('jobs', className)}>{children}</ul>;
}
