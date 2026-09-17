// One year in the annual archive (brief 40, 41): coverage, state, the
// "data changed" warning, the two generate actions and every file ever
// made for the year (revisions stay listed, never replaced).
import { useState } from 'react';
import type { ReportJobDTO, ReportYearDTO } from '../../../../shared/dto.ts';
import type { ReportLabel } from '../../../../shared/status.ts';
import { dateLabel, dateTime, num } from '../../lib/format.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { Banner, Button, EmptyState, JobList, JobStatusRow, Tag } from '../../ui/index.ts';
import { langOf } from './shared.tsx';

export type ReportKind = ReportJobDTO['kind'];

export interface NextLabel { label: ReportLabel; revision: number }

/** What the server will call the next file of this kind (D-S7-01), for the buttons and the reason prompt. */
export function nextLabel(year: ReportYearDTO, kind: ReportKind, includeDemo: boolean): NextLabel {
  const same = year.jobs.filter((j) => j.kind === kind && j.include_fixture === includeDemo);
  const revision = same.reduce((m, j) => Math.max(m, j.revision), 0) + 1;
  if (year.state === 'current') return { label: 'provisional', revision };
  const finalReady = same.some((j) => j.status === 'ready' && (j.label === 'final' || j.label === 'revised'));
  return { label: finalReady ? 'revised' : 'final', revision };
}

export function formatBytes(bytes: number | null): string | undefined {
  if (bytes === null) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const SHOW = 4;

export interface ReportYearCardProps {
  year: ReportYearDTO;
  includeDemo: boolean;
  canGenerate: boolean;
  canFinancial: boolean;
  onGenerate: (year: ReportYearDTO, kind: ReportKind) => void;
  onRetry: (job: ReportJobDTO) => void;
  onDownload: (job: ReportJobDTO) => void;
  retrying: string | null;
  pendingKinds: Set<string>;
}

export function ReportYearCard({ year, includeDemo, canGenerate, canFinancial, onGenerate, onRetry, onDownload, retrying, pendingKinds }: ReportYearCardProps) {
  const { t, lang, has } = useI18n();
  const [all, setAll] = useState(false);
  const y = year.year;
  const cov = year.coverage;
  const headId = `ryear-${y}`;
  const jobs = [...year.jobs].sort((a, b) => b.requested_at.localeCompare(a.requested_at) || b.revision - a.revision);
  const shown = all ? jobs : jobs.slice(0, SHOW);
  const pdfNext = nextLabel(year, 'annual_pdf', includeDemo);
  const csvNext = nextLabel(year, 'annual_csv', includeDemo);
  const labelWords = (n: NextLabel) => (n.label === 'revised' ? t('common.job.revised', { n: n.revision }) : t(`common.job.${n.label}`));
  const fixtures = year.fixture_order_rounds ?? 0;
  const version = year.data_version ?? 0;

  const jobTitle = (j: ReportJobDTO) => t(j.kind === 'annual_pdf' ? 'reports.job.pdf' : 'reports.job.csv', { year: j.year });
  const errorWords = (e: string) => {
    const code = e.split(':')[0].trim();
    if (/^[a-z_]+$/.test(code) && has(`error.${code}`) && code !== 'internal') return t(`error.${code}`);
    if (/interrupted/i.test(e)) return t('reports.job.interrupted');
    return t('reports.job.failedGeneric');
  };

  const meta = (j: ReportJobDTO) => {
    const parts: string[] = [];
    parts.push(t('reports.job.requested', { who: j.requested_by ?? t('common.audit.system'), at: dateTime(j.requested_at, lang) }));
    if (j.status === 'ready' && j.finished_at) parts.push(t('reports.job.finished', { at: dateTime(j.finished_at, lang) }));
    if (j.data_cutoff) parts.push(t('reports.job.cutoff', { at: dateTime(j.data_cutoff, lang) }));
    parts.push(j.financial ? t('reports.job.withMoney') : t('reports.job.noMoney'));
    if (j.kind === 'annual_csv') parts.push(j.raw_events ? t('reports.job.withRaw') : t('reports.job.noRaw'));
    const superseded = j.supersedes_job_id ? year.jobs.find((x) => x.id === j.supersedes_job_id) : null;
    return (
      <>
        {parts.join(' · ')}
        {j.reason ? <span className="rjob__line"><b>{t('common.audit.reason')}:</b> <span lang={langOf(j.reason)}>{j.reason}</span></span> : null}
        {superseded ? (
          <span className="rjob__line">
            {t('reports.job.follows', { label: superseded.label === 'revised' ? t('common.job.revised', { n: superseded.revision }) : t(`common.job.${superseded.label}`), at: dateTime(superseded.finished_at ?? superseded.requested_at, lang) })}
          </span>
        ) : null}
        {j.status === 'ready' && j.data_version != null && version > j.data_version ? (
          <span className="rjob__line rjob__warn">{t('reports.job.stale')}</span>
        ) : null}
        {j.status === 'ready' && !j.download_url ? (
          <span className="rjob__line rjob__warn">{t(j.financial && !canFinancial ? 'reports.job.noAccessMoney' : 'reports.job.noAccess')}</span>
        ) : null}
        {j.status === 'failed' && j.error ? <span className="sr"> {j.error}</span> : null}
      </>
    );
  };

  return (
    <article className="ryear" aria-labelledby={headId}>
      <header className="ryear__head">
        <div className="ryear__id">
          <h3 id={headId} className="ryear__y">
            <span className="sr">{t('reports.year.sr')} </span>{y}
          </h3>
          <div className="ryear__tags">
            {year.state === 'current'
              ? <Tag tone="heat" icon="clock">{t('reports.year.current')}</Tag>
              : <Tag tone="line" icon="check">{t('reports.year.completed')}</Tag>}
          </div>
          <p className="ryear__range">{t('reports.year.range', { from: dateLabel(`${y}-01-01`, lang, { year: false }), to: dateLabel(`${y}-12-31`, lang, { year: true }) })}</p>
        </div>
        {canGenerate ? (
          <div className="ryear__actions">
            <Button
              variant="secondary"
              size="staff"
              icon="download"
              loading={pendingKinds.has(`${y}:annual_pdf`)}
              opensDialog={pdfNext.label === 'revised'}
              onClick={() => onGenerate(year, 'annual_pdf')}
            >
              {t('reports.gen.pdf')}
              <span className="ryear__next"> · {labelWords(pdfNext)}</span>
            </Button>
            <Button
              variant="outline"
              size="staff"
              icon="table-view"
              loading={pendingKinds.has(`${y}:annual_csv`)}
              opensDialog
              onClick={() => onGenerate(year, 'annual_csv')}
            >
              {t('reports.gen.csv')}
            </Button>
          </div>
        ) : null}
      </header>

      {year.needs_revision ? (
        <Banner
          staff
          variant="warning"
          title={t('reports.revise.title')}
          action={canGenerate ? (
            <Button variant="outline" size="staff" opensDialog={pdfNext.label === 'revised'} onClick={() => onGenerate(year, 'annual_pdf')}>
              {year.state === 'current' ? t('reports.revise.actionCurrent') : t('reports.revise.action')}
            </Button>
          ) : undefined}
        >
          {year.state === 'current' ? t('reports.revise.bodyCurrent') : t('reports.revise.body')}
        </Banner>
      ) : null}

      <dl className="rcov">
        <div className="rcov__c">
          <dt>{t('reports.cov.records')}</dt>
          <dd>
            {cov.first_date && cov.last_date
              ? <b>{dateLabel(cov.first_date, lang)} – {dateLabel(cov.last_date, lang, { year: true })}</b>
              : <b className="is-muted">{t('reports.cov.none')}</b>}
          </dd>
        </div>
        <div className="rcov__c">
          <dt>{t('reports.cov.rounds')}</dt>
          <dd><b className="num">{num(cov.order_rounds)}</b></dd>
        </div>
        <div className="rcov__c">
          <dt>{t('reports.cov.visits')}</dt>
          <dd><b className="num">{num(cov.visits)}</b></dd>
        </div>
        <div className="rcov__c">
          <dt>{t('reports.cov.telemetry')}</dt>
          <dd>{cov.telemetry_since ? <b>{dateLabel(cov.telemetry_since.slice(0, 10), lang, { year: true })}</b> : <b className="is-muted">{t('reports.cov.noTelemetry')}</b>}</dd>
        </div>
        <div className="rcov__c">
          <dt>{t('reports.cov.demo')}</dt>
          <dd>
            <b className="num">{num(fixtures)}</b>
            <small>{fixtures ? (includeDemo ? t('reports.cov.demoIn') : t('reports.cov.demoOut')) : t('reports.cov.demoNone')}</small>
          </dd>
        </div>
      </dl>
      {cov.order_rounds === 0 && fixtures > 0 && !includeDemo ? (
        <p className="ryear__hint">{t('reports.year.onlyDemo')}</p>
      ) : null}

      <div className="ryear__files">
        <h4 className="ryear__fh">
          {t('reports.files.title')}
          {jobs.length ? <span className="ryear__count"> · {num(jobs.length)}</span> : null}
        </h4>
        {jobs.length === 0 ? (
          <EmptyState compact icon="book" headingLevel={4} title={t('reports.files.none', { year: y })}>
            {canGenerate ? t('reports.files.noneHint') : t('reports.files.noneAsk')}
          </EmptyState>
        ) : (
          <>
            <JobList aria-label={t('reports.files.list', { year: y })}>
              {shown.map((j) => (
                <JobStatusRow
                  key={j.id}
                  as="li"
                  className="rjob"
                  title={jobTitle(j)}
                  status={j.status}
                  label={j.label}
                  revision={j.revision}
                  fixture={j.include_fixture}
                  size={formatBytes(j.file_bytes)}
                  error={j.status === 'failed' && j.error ? errorWords(j.error) : null}
                  attempts={j.status === 'failed' ? j.attempts : undefined}
                  meta={meta(j)}
                  onDownload={j.status === 'ready' && j.download_url ? () => onDownload(j) : undefined}
                  onRetry={j.status === 'failed' && canGenerate ? () => onRetry(j) : undefined}
                  retrying={retrying === j.id}
                />
              ))}
            </JobList>
            {jobs.length > SHOW ? (
              <Button variant="ghost" size="staff" className="ryear__more" aria-expanded={all} iconEnd={all ? undefined : 'chev-d'} onClick={() => setAll(!all)}>
                {all ? t('reports.files.fewer') : t('reports.files.all', { n: num(jobs.length) })}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </article>
  );
}
