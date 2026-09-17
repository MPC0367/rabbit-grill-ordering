// /admin/reports: Reports -> Annual archive -> year -> coverage/status ->
// generate -> download (brief 40, 41), and the operational report for a date
// range (brief 26). Jobs refresh on report.* events and are polled while any
// is queued or generating; status changes are announced one job at a time.
import { useEffect, useRef, useState } from 'react';
import type { ReportJobDTO, ReportYearDTO } from '../../../../shared/dto.ts';
import { ApiError, api } from '../../lib/api.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { useResource } from '../../lib/live.tsx';
import { setQuery, useRoute } from '../../lib/router.ts';
import { Dialog, SectionHeader, SegmentedControl, useAnnounce, useToast } from '../../ui/index.ts';
import { useStaff } from '../shell/session.tsx';
import { downloadFile } from './csv.ts';
import OperationalReport from './OperationalReport.tsx';
import { nextLabel, ReportYearCard, type NextLabel, type ReportKind } from './ReportYearCard.tsx';
import { Denied, issuesOf, MorePageFrame, ResourceGate, StaleBanner, useErrorWords, useTopicRefresh } from './shared.tsx';

interface YearsDTO { years: ReportYearDTO[] }

interface Ask {
  year: ReportYearDTO;
  kind: ReportKind;
  next: NextLabel;
}

const ACTIVE = new Set(['queued', 'generating']);
const POLL_MS = 3000;

function ExportScope({ canFinancial, canRaw, includeDemo }: { canFinancial: boolean; canRaw: boolean; includeDemo: boolean }) {
  const { t } = useI18n();
  return (
    <div className="rscope-list">
      <p>{t('reports.export.lede')}</p>
      <h3 className="rscope-list__h">{t('reports.export.inside')}</h3>
      <ul>
        <li>{t('reports.export.i.orders')}</li>
        <li>{t('reports.export.i.visits')}</li>
        <li>{t('reports.export.i.service')}</li>
        <li>{t('reports.export.i.menu')}</li>
        <li>{t('reports.export.i.engagement')}</li>
        <li>{canFinancial ? t('reports.export.i.moneyYes') : t('reports.export.i.moneyNo')}</li>
        <li>{canRaw ? t('reports.export.i.rawYes') : t('reports.export.i.rawNo')}</li>
        <li>{includeDemo ? t('reports.export.i.demoYes') : t('reports.export.i.demoNo')}</li>
        <li>{t('reports.export.i.readme')}</li>
      </ul>
      <h3 className="rscope-list__h">{t('reports.export.never')}</h3>
      <ul>
        <li>{t('reports.export.n.notes')}</li>
        <li>{t('reports.export.n.secrets')}</li>
        <li>{t('reports.export.n.ids')}</li>
      </ul>
    </div>
  );
}

export default function ReportsPage() {
  const { t, lang } = useI18n();
  const { can } = useStaff();
  const toast = useToast();
  const announce = useAnnounce();
  const { errorText } = useErrorWords();
  const { query } = useRoute();
  const includeDemo = query.get('demo') === '1';
  const allowed = can('reports.view');
  const canGenerate = can('reports.generate');
  const canFinancial = can('reports.financial');
  const canRaw = can('reports.export_raw');
  // Labels are decided inside the scope this viewer's own copy would have (D-S8-13).
  const scope = { canFinancial, canRaw };

  const res = useResource<YearsDTO>(allowed ? '/api/staff/reports/years' : null, { topics: ['report.'] });
  useTopicRefresh(['report.'], () => (allowed ? res.refresh() : undefined), 250);
  const years = res.data?.years;

  const [ask, setAsk] = useState<Ask | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [retrying, setRetrying] = useState<string | null>(null);

  const jobTitle = (j: Pick<ReportJobDTO, 'kind' | 'year'>) => t(j.kind === 'annual_pdf' ? 'reports.job.pdf' : 'reports.job.csv', { year: j.year });

  // ---- announce status changes of individual jobs (never the whole list)
  const known = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (!years) return;
    const next = new Map<string, string>();
    for (const y of years) for (const j of y.jobs) next.set(j.id, j.status);
    const prev = known.current;
    if (prev) {
      for (const y of years) {
        for (const j of y.jobs) {
          const before = prev.get(j.id);
          if (before && before !== j.status) announce(t('reports.announce', { title: jobTitle(j), status: t(`common.job.${j.status}`) }), { assertive: j.status === 'failed' });
        }
      }
    }
    known.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [years]);

  // ---- poll queued/generating jobs (events also refresh; polling covers a lost stream)
  const activeIds = (years ?? []).flatMap((y) => y.jobs).filter((j) => ACTIVE.has(j.status)).map((j) => `${j.id}:${j.status}`).join('|');
  const refreshRef = useRef(res.refresh);
  refreshRef.current = res.refresh;
  useEffect(() => {
    if (!activeIds) return;
    const watched = activeIds.split('|').map((s) => s.split(':') as [string, string]);
    let stopped = false;
    const timer = setInterval(async () => {
      for (const [id, status] of watched) {
        try {
          const j = await api.get<ReportJobDTO>(`/api/staff/reports/jobs/${id}`);
          if (stopped) return;
          if (j.status !== status) { void refreshRef.current(); return; }
        } catch { /* the stale banner covers a failing server */ }
      }
    }, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [activeIds]);

  // ---- actions
  const submit = async (year: ReportYearDTO, kind: ReportKind, reason?: string) => {
    const key = `${year.year}:${kind}`;
    const before = new Set(year.jobs.map((j) => j.id));
    setPending((p) => new Set(p).add(key));
    setAskError(null);
    try {
      const job = await api.post<ReportJobDTO>('/api/staff/reports/jobs', { year: year.year, kind, reason: reason || null, include_fixture: includeDemo });
      setAsk(null);
      toast.show(t(before.has(job.id) ? 'reports.toast.already' : 'reports.toast.queued', {
        title: jobTitle(job),
        label: job.label === 'revised' ? t('common.job.revised', { n: job.revision }) : t(`common.job.${job.label}`),
      }));
      void res.refresh();
    } catch (err) {
      const needsReason = issuesOf(err).some((i) => i.path === 'reason');
      if (needsReason) {
        // Someone finished a final report meanwhile: ask for the reason.
        setAsk({ year, kind, next: { label: 'revised', revision: nextLabel(year, kind, includeDemo, scope).revision } });
        setAskError(t('reports.err.reasonRequired'));
        void res.refresh();
      } else if (ask) {
        setAskError(errorText(err));
      } else {
        toast.show({ tone: 'error', message: errorText(err) });
      }
    } finally {
      setPending((p) => { const n = new Set(p); n.delete(key); return n; });
    }
  };

  const onGenerate = (year: ReportYearDTO, kind: ReportKind) => {
    const next = nextLabel(year, kind, includeDemo, scope);
    if (kind === 'annual_pdf' && next.label !== 'revised') {
      void submit(year, kind);
      return;
    }
    setAskError(null);
    setAsk({ year, kind, next });
  };

  const onRetry = async (job: ReportJobDTO) => {
    setRetrying(job.id);
    try {
      await api.post<ReportJobDTO>(`/api/staff/reports/jobs/${job.id}/retry`);
      toast.show(t('reports.toast.retry', { title: jobTitle(job) }));
      void res.refresh();
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) });
      if (err instanceof ApiError && err.code === 'invalid_transition') void res.refresh();
    } finally {
      setRetrying(null);
    }
  };

  const onDownload = async (job: ReportJobDTO) => {
    if (!job.download_url) return;
    toast.show({ tone: 'info', message: t('reports.toast.downloading', { title: jobTitle(job) }) });
    try {
      const f = await downloadFile(job.download_url, `rabbit-grill-${job.year}-${job.label}-r${job.revision}.${job.kind === 'annual_pdf' ? 'pdf' : 'zip'}`);
      toast.show(t('reports.toast.downloaded', { name: f.name }));
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) });
      void res.refresh();
    }
  };

  if (!allowed) {
    return (
      <MorePageFrame title={t('reports.title')}>
        <Denied what={t('reports.title')} />
      </MorePageFrame>
    );
  }

  const nextWords = (n: NextLabel) => (n.label === 'revised' ? t('common.job.revised', { n: n.revision }) : t(`common.job.${n.label}`));

  return (
    <MorePageFrame title={t('reports.title')} description={t('reports.lede')} wide>
      <div className="rscope" role="group" aria-labelledby="rscope-l">
        <div className="rscope__row">
          <span className="rscope__k" id="rscope-l">{t('reports.scope.label')}</span>
          <SegmentedControl<'0' | '1'>
            size="staff"
            tone="box"
            label={t('reports.scope.label')}
            value={includeDemo ? '1' : '0'}
            onChange={(v) => setQuery({ demo: v === '1' ? '1' : null })}
            options={[{ value: '0', label: t('reports.scope.out') }, { value: '1', label: t('reports.scope.in') }]}
          />
        </div>
        <p className="rscope__d">{includeDemo ? t('reports.scope.inD') : t('reports.scope.outD')}</p>
      </div>

      <section className="rarch" aria-labelledby="rarch-h">
        <SectionHeader titleId="rarch-h" title={t('reports.archive.title')} description={t('reports.archive.lede')} />
        <StaleBanner error={years ? res.error : null} onRetry={() => void res.refresh()} busy={res.loading} />
        {!years ? (
          <ResourceGate error={res.error} loading={res.loading} onRetry={() => void res.refresh()} what={t('reports.archive.title')} rows={2} />
        ) : (
          <div className="rarch__years">
            {years.map((y) => (
              <ReportYearCard
                key={y.year}
                year={y}
                includeDemo={includeDemo}
                canGenerate={canGenerate}
                canFinancial={canFinancial}
                canRaw={canRaw}
                onGenerate={onGenerate}
                onRetry={(j) => void onRetry(j)}
                onDownload={(j) => void onDownload(j)}
                retrying={retrying}
                pendingKinds={pending}
              />
            ))}
          </div>
        )}
        <p className="mp-meta rarch__note">{t('reports.archive.note')}</p>
      </section>

      {can('stats.view') ? <OperationalReport includeDemo={includeDemo} /> : null}

      <Dialog
        open={ask !== null}
        onClose={() => { setAsk(null); setAskError(null); }}
        wide
        density="staff"
        title={ask ? t(ask.kind === 'annual_pdf' ? 'reports.ask.pdfTitle' : 'reports.ask.csvTitle', { year: ask.year.year, label: nextWords(ask.next) }) : ''}
        confirmLabel={ask ? t(ask.kind === 'annual_pdf' ? 'reports.ask.pdfConfirm' : 'reports.ask.csvConfirm', { label: nextWords(ask.next) }) : ''}
        busy={ask ? pending.has(`${ask.year.year}:${ask.kind}`) : false}
        error={askError}
        reason={ask?.next.label === 'revised' ? {
          label: t('reports.ask.reason'),
          required: true,
          limit: 200,
          placeholder: t('reports.ask.reasonPh'),
          help: t('reports.ask.reasonHelp'),
        } : undefined}
        onConfirm={async (reason) => { if (ask) await submit(ask.year, ask.kind, reason); }}
      >
        {ask ? (
          <div className="rask">
            {ask.next.label === 'revised' ? <p>{t('reports.ask.revisedBody', { year: ask.year.year, label: nextWords(ask.next) })}</p> : null}
            {ask.next.label === 'provisional' ? <p>{t('reports.ask.provisionalBody', { year: ask.year.year })}</p> : null}
            {ask.kind === 'annual_csv' ? <ExportScope canFinancial={canFinancial} canRaw={canRaw} includeDemo={includeDemo} /> : null}
            <p className="mp-meta rask__note" lang={lang}>{t('reports.ask.background')}</p>
          </div>
        ) : null}
      </Dialog>
    </MorePageFrame>
  );
}
