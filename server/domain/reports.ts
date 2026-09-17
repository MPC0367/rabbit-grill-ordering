// Annual report archive: years, the durable job queue, generation and download
// (brief 40, 41).
//
// Jobs are rows in report_jobs: queued -> generating -> ready | failed. A job
// stores who asked (role_scope), what it may contain (financial, raw_events)
// and, once ready, the snapshot it was built from (data_cutoff, data_version,
// summary_json) and the file's sha256. Files live under REPORTS_DIR/<year>/
// with an unguessable job id as the name and are only served through the
// download route, which re-checks permissions every time.
//
// Labels: the current (or a future) year is always "provisional"; a completed
// year gets "final" first and "revised" (with a reason) once a ready final
// exists. Nothing is ever overwritten: a revision is a new job and a new file.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { config } from '../config.ts';
import { insert, many, one, run, tx } from '../db/index.ts';
import { audit, SYSTEM, type Actor } from '../lib/audit.ts';
import type { StaffContext } from '../lib/auth.ts';
import { AppError } from '../lib/errors.ts';
import { emit } from '../lib/events.ts';
import { cutoffHour } from '../lib/settings.ts';
import type { ReportJobDTO, ReportYearDTO } from '../../shared/dto.ts';
import { newId } from '../../shared/ids.ts';
import type { Permission } from '../../shared/permissions.ts';
import type { JobStatus, ReportLabel } from '../../shared/status.ts';
import { nowIso, todayBusinessDate, yearOf } from '../../shared/time.ts';
import { writeCsvBundle } from './export/bundle.ts';
import { openSnapshotReader } from './export/reader.ts';
import { buildSnapshot, requesterLabel, summaryOf } from './export/snapshot.ts';
import type { JobInfo } from './export/types.ts';
import { buildReportHtml, footerTemplate } from './pdf/document.ts';
import { isTaggedPdf } from './pdf/parts.ts';
import { renderPdf } from './pdf/render.ts';

export type ReportKind = 'annual_pdf' | 'annual_csv';
export const MAX_ATTEMPTS = 3;

export interface ReportJobRow {
  id: string; kind: ReportKind; year: number; status: JobStatus; label: ReportLabel; revision: number;
  reason: string | null; data_cutoff: string | null; data_version: number | null; include_fixture: number;
  role_scope: string; financial: number; raw_events: number; requested_by: string; requested_at: string;
  started_at: string | null; finished_at: string | null; file_path: string | null; file_sha256: string | null;
  file_bytes: number | null; error: string | null; attempts: number; supersedes_job_id: string | null;
  summary_json: string | null;
}

/** Who asked for a report: a signed-in staff member, the year-end job, or the command line. */
export interface ReportRequester {
  id: string;
  role: string;
  label: string;
  actor: Actor;
  can: (perm: Permission) => boolean;
}

export const SYSTEM_REQUESTER: ReportRequester = {
  id: 'system', role: 'system', label: requesterLabel('system'), actor: SYSTEM, can: () => true,
};

export const CLI_REQUESTER: ReportRequester = {
  id: 'cli', role: 'cli', label: requesterLabel('cli'), actor: { type: 'system', id: null, label: 'command line' }, can: () => true,
};

export function staffRequester(s: StaffContext): ReportRequester {
  return { id: s.user.id, role: s.user.role, label: s.user.display_name, actor: s.actor, can: s.can };
}

const toRequester = (who: StaffContext | ReportRequester): ReportRequester => ('user' in who ? staffRequester(who) : who);

// ------------------------------------------------------------------ reads
const JOB_SELECT = `SELECT j.*, su.display_name AS requester_name FROM report_jobs j LEFT JOIN staff_users su ON su.id = j.requested_by`;

type JobWithName = ReportJobRow & { requester_name: string | null };

export function getJob(id: string): ReportJobRow | undefined {
  return one<ReportJobRow>('SELECT * FROM report_jobs WHERE id = ?', [id]);
}

/** Download permission for a job, re-checked on every download. */
export function canDownload(job: Pick<ReportJobRow, 'financial' | 'raw_events'>, can: (p: Permission) => boolean): boolean {
  if (!can('reports.view')) return false;
  if (job.financial === 1 && !can('reports.financial')) return false;
  if (job.raw_events === 1 && !can('reports.export_raw')) return false;
  return true;
}

export function jobDTO(row: ReportJobRow & { requester_name?: string | null }, viewer?: { can: (p: Permission) => boolean }): ReportJobDTO {
  const downloadable = row.status === 'ready' && (!viewer || canDownload(row, viewer.can));
  return {
    id: row.id,
    kind: row.kind,
    year: row.year,
    status: row.status,
    label: row.label,
    revision: row.revision,
    reason: row.reason,
    data_cutoff: row.data_cutoff,
    requested_by: row.requester_name ?? requesterLabel(row.requested_by),
    requested_at: row.requested_at,
    finished_at: row.finished_at,
    file_bytes: row.file_bytes,
    error: row.error,
    attempts: row.attempts,
    include_fixture: row.include_fixture === 1,
    download_url: downloadable ? `/api/staff/reports/jobs/${row.id}/download` : null,
    financial: row.financial === 1,
    raw_events: row.raw_events === 1,
    data_version: row.data_version,
    supersedes_job_id: row.supersedes_job_id,
  };
}

export function jobDTOById(id: string, viewer?: { can: (p: Permission) => boolean }): ReportJobDTO {
  const row = one<JobWithName>(`${JOB_SELECT} WHERE j.id = ?`, [id]);
  if (!row) throw new AppError('not_found', 'Report not found');
  return jobDTO(row, viewer);
}

export function currentReportYear(): number {
  return yearOf(todayBusinessDate(cutoffHour()));
}

/**
 * The archive: the current year plus every year with orders, visits or report
 * jobs. Coverage counts real (non-fixture) records; `fixture_order_rounds`
 * shows how much demo data a year holds.
 */
export function reportYears(viewer?: { can: (p: Permission) => boolean }): ReportYearDTO[] {
  const current = currentReportYear();
  type Cov = { y: string; real: number; fixture: number; first: string | null; last: string | null };
  const orders = new Map(many<Cov>(
    `SELECT substr(business_date, 1, 4) AS y, SUM(is_fixture = 0) AS real, SUM(is_fixture = 1) AS fixture,
            MIN(CASE WHEN is_fixture = 0 THEN business_date END) AS first, MAX(CASE WHEN is_fixture = 0 THEN business_date END) AS last
       FROM orders GROUP BY y`).map((r) => [Number(r.y), r]));
  const visits = new Map(many<{ y: string; real: number; n: number }>(
    'SELECT substr(seated_business_date, 1, 4) AS y, SUM(is_fixture = 0) AS real, COUNT(*) AS n FROM visits GROUP BY y').map((r) => [Number(r.y), r]));
  const telemetry = new Map(many<{ y: string; since: string | null }>(
    'SELECT substr(business_date, 1, 4) AS y, MIN(started_at) AS since FROM analytics_sessions WHERE is_fixture = 0 GROUP BY y').map((r) => [Number(r.y), r.since]));
  const versions = new Map(many<{ year: number; version: number }>('SELECT year, version FROM report_data_versions').map((r) => [r.year, r.version]));
  const jobs = many<JobWithName>(`${JOB_SELECT} ORDER BY j.requested_at DESC, j.revision DESC`);

  const years = new Set<number>([current]);
  for (const y of orders.keys()) years.add(y);
  for (const [y, v] of visits) if (v.n > 0) years.add(y);
  for (const j of jobs) years.add(j.year);

  return [...years].filter((y) => Number.isFinite(y) && y > 1999).sort((a, b) => b - a).map((year) => {
    const o = orders.get(year);
    const yearJobs = jobs.filter((j) => j.year === year);
    const version = versions.get(year) ?? 0;
    // Compare with the most recently finished ready report (real data preferred).
    // Each job also carries its own data_version so a stale companion export can be flagged per job.
    const ready = yearJobs.filter((j) => j.status === 'ready').sort((a, b) => (b.finished_at ?? '').localeCompare(a.finished_at ?? ''));
    const latest = ready.find((j) => j.include_fixture === 0) ?? ready[0];
    const needsRevision = Boolean(latest && version > (latest.data_version ?? 0));
    return {
      year,
      state: year >= current ? 'current' : 'completed',
      coverage: {
        first_date: o?.first ?? null,
        last_date: o?.last ?? null,
        order_rounds: o?.real ?? 0,
        visits: visits.get(year)?.real ?? 0,
        telemetry_since: telemetry.get(year) ?? null,
      },
      jobs: yearJobs.map((j) => jobDTO(j, viewer)),
      needs_revision: needsRevision,
      fixture_order_rounds: o?.fixture ?? 0,
      data_version: version,
    };
  });
}

// ------------------------------------------------------------------ enqueue
/**
 * Queue a report. Runs inside tx(). A request identical in scope to a job that
 * is still queued or generating returns that job instead of queueing twice.
 */
export function enqueueReport(args: {
  kind: ReportKind;
  year: number;
  reason?: string | null;
  includeFixture?: boolean;
  staff: StaffContext | ReportRequester;
}): ReportJobDTO {
  const req = toRequester(args.staff);
  if (!req.can('reports.generate')) throw new AppError('forbidden', 'Your role cannot generate reports.', { permission: 'reports.generate' });
  const { kind, year } = args;
  const fx = args.includeFixture ? 1 : 0;
  const financial = req.can('reports.financial') ? 1 : 0;
  const raw = kind === 'annual_csv' && req.can('reports.export_raw') ? 1 : 0;
  const scope = { kind, year, fx };

  const pending = one<JobWithName>(
    `${JOB_SELECT} WHERE j.kind = :kind AND j.year = :year AND j.include_fixture = :fx AND j.financial = :financial
       AND j.raw_events = :raw AND j.status IN ('queued', 'generating') ORDER BY j.requested_at DESC LIMIT 1`, { ...scope, financial, raw });
  if (pending) return jobDTO(pending, req);

  const current = currentReportYear();
  const readyFinal = one<{ id: string }>(
    `SELECT id FROM report_jobs WHERE kind = :kind AND year = :year AND include_fixture = :fx AND status = 'ready'
       AND label IN ('final', 'revised') ORDER BY revision DESC LIMIT 1`, scope);
  const label: ReportLabel = year >= current ? 'provisional' : readyFinal ? 'revised' : 'final';
  const reason = args.reason?.trim() || null;
  if (label === 'revised' && !reason) {
    throw new AppError('validation_failed', 'A revised report needs a reason.', {
      issues: [{ path: 'reason', message: `A final ${year} report already exists. Explain why a revised report is needed.`, code: 'required' }],
    });
  }
  const latestReady = one<{ id: string }>(
    `SELECT id FROM report_jobs WHERE kind = :kind AND year = :year AND include_fixture = :fx AND status = 'ready'
      ORDER BY revision DESC LIMIT 1`, scope);
  const revision = (one<{ n: number | null }>(
    'SELECT MAX(revision) AS n FROM report_jobs WHERE kind = :kind AND year = :year AND include_fixture = :fx', scope)?.n ?? 0) + 1;

  const id = newId('rpt');
  const now = nowIso();
  insert('report_jobs', {
    id, kind, year, status: 'queued', label, revision, reason,
    include_fixture: fx, role_scope: req.role, financial, raw_events: raw,
    requested_by: req.id, requested_at: now, attempts: 0,
    supersedes_job_id: latestReady?.id ?? null,
  });
  audit(req.actor, 'report.requested', { type: 'report_job', id }, {
    reason,
    after: { kind, year, label, revision, include_fixture: fx === 1, financial: financial === 1, raw_events: raw === 1 },
  });
  emitJob(id, 'queued');
  return jobDTOById(id, req);
}

/** Put a failed job back in the queue (manual retry). Runs inside tx(). */
export function retryReport(id: string, staff: StaffContext | ReportRequester): ReportJobDTO {
  const req = toRequester(staff);
  const job = getJob(id);
  if (!job) throw new AppError('not_found', 'Report not found');
  if (!req.can('reports.generate')) throw new AppError('forbidden', 'Your role cannot generate reports.', { permission: 'reports.generate' });
  if (!canDownload(job, req.can)) throw new AppError('forbidden', 'This report includes sections your role cannot access.');
  if (job.status === 'queued' || job.status === 'generating') return jobDTOById(id, req);
  if (job.status === 'ready') throw new AppError('invalid_transition', 'This report is ready. Request a new report instead of retrying it.');
  run(`UPDATE report_jobs SET status = 'queued', attempts = 0, error = NULL, started_at = NULL, finished_at = NULL WHERE id = ? AND status = 'failed'`, [id]);
  audit(req.actor, 'report.retry', { type: 'report_job', id }, { before: { status: job.status, attempts: job.attempts, error: job.error } });
  emitJob(id, 'queued');
  return jobDTOById(id, req);
}

function emitJob(id: string, status: JobStatus): void {
  const job = getJob(id);
  emit('report.updated', {
    audience: 'staff',
    entity: { type: 'report_job', id },
    payload: { year: job?.year, kind: job?.kind, status, label: job?.label, revision: job?.revision },
  });
}

/** After a restart, jobs left "generating" were interrupted: queue them again (or fail them). */
export function requeueInterrupted(): number {
  return tx(() => {
    const stuck = many<{ id: string; attempts: number }>(`SELECT id, attempts FROM report_jobs WHERE status = 'generating'`);
    for (const j of stuck) {
      const failed = j.attempts >= MAX_ATTEMPTS;
      run(`UPDATE report_jobs SET status = :status, error = :error, started_at = NULL WHERE id = :id AND status = 'generating'`, {
        id: j.id,
        status: failed ? 'failed' : 'queued',
        error: 'interrupted: the server restarted during generation',
      });
      audit(SYSTEM, 'report.interrupted', { type: 'report_job', id: j.id }, { after: { requeued: !failed } });
      emitJob(j.id, failed ? 'failed' : 'queued');
    }
    return stuck.length;
  });
}

/**
 * Year-end rollover (brief 40): every completed year with real data gets a
 * final annual PDF and data export, requested by the system. Idempotent: a
 * year that already has a final/revised job of that kind (in any state) is
 * left alone, so a failed automatic job is retried by a person, not in a loop.
 */
export function ensureFinalReports(): string[] {
  const current = currentReportYear();
  const years = many<{ y: number }>(
    `SELECT CAST(substr(business_date, 1, 4) AS INTEGER) AS y FROM orders WHERE is_fixture = 0 GROUP BY y
     UNION SELECT CAST(substr(seated_business_date, 1, 4) AS INTEGER) AS y FROM visits WHERE is_fixture = 0 GROUP BY y`)
    .map((r) => r.y).filter((y) => y < current);
  const queued: string[] = [];
  for (const year of years) {
    for (const kind of ['annual_pdf', 'annual_csv'] as const) {
      const exists = one<{ id: string }>(
        `SELECT id FROM report_jobs WHERE kind = ? AND year = ? AND include_fixture = 0 AND label IN ('final', 'revised') LIMIT 1`, [kind, year]);
      if (exists) continue;
      const dto = tx(() => enqueueReport({ kind, year, reason: `Year ${year} completed: automatic final ${kind === 'annual_pdf' ? 'report' : 'data export'}`, staff: SYSTEM_REQUESTER }));
      queued.push(dto.id);
    }
  }
  return queued;
}

// ------------------------------------------------------------------ generation
export interface RunResult {
  id: string;
  status: JobStatus;
  file?: string;
  bytes?: number;
  pages?: number | null;
  error?: string;
  ms: number;
}

export interface RunOptions {
  /** QA: also write the report HTML to this directory as <job id>.html. */
  htmlOut?: string;
}

/** Automatic retries wait 30 s per failed attempt (started_at is the last attempt's start). */
const RETRY_BACKOFF_MS = 30_000;

function claimJob(id?: string): ReportJobRow | null {
  return tx(() => {
    const job = id
      ? one<ReportJobRow>(`SELECT * FROM report_jobs WHERE id = ? AND status = 'queued'`, [id])
      : many<ReportJobRow>(`SELECT * FROM report_jobs WHERE status = 'queued' ORDER BY attempts, requested_at, id LIMIT 20`)
        .find((j) => j.attempts === 0 || !j.started_at || Date.now() - Date.parse(j.started_at) >= RETRY_BACKOFF_MS * j.attempts);
    if (!job) return null;
    const now = nowIso();
    run(`UPDATE report_jobs SET status = 'generating', attempts = attempts + 1, started_at = :now, error = NULL WHERE id = :id AND status = 'queued'`, { id: job.id, now });
    emitJob(job.id, 'generating');
    return { ...job, status: 'generating', attempts: job.attempts + 1, started_at: now };
  });
}

function jobInfo(job: ReportJobRow): JobInfo {
  const name = one<{ display_name: string }>('SELECT display_name FROM staff_users WHERE id = ?', [job.requested_by])?.display_name;
  return {
    id: job.id,
    kind: job.kind,
    year: job.year,
    label: job.label,
    revision: job.revision,
    reason: job.reason,
    requested_at: job.requested_at,
    requested_by: name ?? requesterLabel(job.requested_by),
    role_scope: job.role_scope,
    financial: job.financial === 1,
    raw_events: job.raw_events === 1,
    include_fixture: job.include_fixture === 1,
    supersedes_job_id: job.supersedes_job_id,
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** One-line error stored on the job (never a stack trace). */
function shortError(err: unknown): string {
  const text = err instanceof AppError ? `${err.code}: ${err.message}` : `generation_failed: ${(err as Error)?.message ?? String(err)}`;
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function isPermanent(err: unknown): boolean {
  return err instanceof AppError && err.code === 'browser_unavailable' && (err.details as { permanent?: boolean } | undefined)?.permanent === true;
}

/** Run the oldest queued job, if any. Async and outside any transaction. */
export async function runNextReportJob(opts: RunOptions = {}): Promise<RunResult | null> {
  const job = claimJob();
  return job ? generate(job, opts) : null;
}

/** Run one specific queued job now (command line). */
export async function runReportJob(id: string, opts: RunOptions = {}): Promise<RunResult> {
  const job = claimJob(id);
  if (!job) {
    const row = getJob(id);
    if (!row) throw new AppError('not_found', 'Report not found');
    return { id, status: row.status, error: row.error ?? undefined, ms: 0 };
  }
  return generate(job, opts);
}

async function generate(job: ReportJobRow, opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const ext = job.kind === 'annual_pdf' ? 'pdf' : 'zip';
  const dir = join(config.reportsDir, String(job.year));
  const finalPath = join(dir, `${job.id}.${ext}`);
  const partial = `${finalPath}.partial`;
  const tick = () => new Promise<void>((r) => setImmediate(r));
  try {
    mkdirSync(dir, { recursive: true });
    const info = jobInfo(job);
    const reader = openSnapshotReader();
    let summary;
    let pages: number | null = null;
    let dataCutoff: string;
    let dataVersion: number;
    try {
      const snap = await buildSnapshot(reader, info);
      summary = summaryOf(snap);
      dataCutoff = snap.data_cutoff;
      dataVersion = snap.data_version;
      if (job.kind === 'annual_pdf') {
        reader.close(); // the snapshot is in memory; release the read transaction before printing
        const html = await buildReportHtml(snap, tick);
        if (opts.htmlOut) {
          mkdirSync(opts.htmlOut, { recursive: true });
          const { writeFile } = await import('node:fs/promises');
          await writeFile(join(opts.htmlOut, `${job.id}.html`), html);
        }
        pages = (await renderPdf(html, footerTemplate(snap), partial, { tagged: isTaggedPdf(snap) })).pages;
      } else {
        await writeCsvBundle(reader, snap, partial);
      }
    } finally {
      reader.close();
    }
    await rename(partial, finalPath);
    const sha = await sha256File(finalPath);
    const bytes = statSync(finalPath).size;
    const stored = relative(config.reportsDir, finalPath).split('\\').join('/');
    const status = tx(() => {
      const now = nowIso();
      const r = run(
        `UPDATE report_jobs SET status = 'ready', finished_at = :now, file_path = :path, file_sha256 = :sha, file_bytes = :bytes,
                data_cutoff = :cutoff, data_version = :version, summary_json = :summary, error = NULL
          WHERE id = :id AND status = 'generating'`,
        { id: job.id, now, path: stored, sha, bytes, cutoff: dataCutoff, version: dataVersion, summary: JSON.stringify(summary) });
      if (r.changes !== 1) return getJob(job.id)?.status ?? 'failed';
      audit(SYSTEM, 'report.ready', { type: 'report_job', id: job.id }, { after: { kind: job.kind, year: job.year, label: job.label, revision: job.revision, bytes, pages, data_version: dataVersion } });
      emitJob(job.id, 'ready');
      return 'ready' as const;
    });
    if (status !== 'ready') await rm(finalPath, { force: true });
    return { id: job.id, status, file: status === 'ready' ? finalPath : undefined, bytes, pages, ms: Date.now() - started };
  } catch (err) {
    await rm(partial, { force: true }).catch(() => {});
    const message = shortError(err);
    const next: JobStatus = isPermanent(err) || job.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
    console.error(`[reports] ${job.id} ${job.kind} ${job.year} attempt ${job.attempts} failed: ${message}`);
    tx(() => {
      run(`UPDATE report_jobs SET status = :status, error = :error, finished_at = :finished WHERE id = :id AND status = 'generating'`, {
        id: job.id, status: next, error: message, finished: next === 'failed' ? nowIso() : null,
      });
      audit(SYSTEM, next === 'failed' ? 'report.failed' : 'report.retry_scheduled', { type: 'report_job', id: job.id }, { after: { attempts: job.attempts, error: message } });
      emitJob(job.id, next);
    });
    return { id: job.id, status: next, error: message, ms: Date.now() - started };
  }
}

// ------------------------------------------------------------------ download
export interface ReportFile {
  path: string;
  filename: string;
  contentType: string;
  bytes: number;
  sha256: string | null;
}

/** Resolve a ready report for download after re-checking the viewer's permissions. */
export function reportFile(id: string, staff: StaffContext): ReportFile {
  const job = getJob(id);
  if (!job) throw new AppError('not_found', 'Report not found');
  if (!canDownload(job, staff.can)) {
    throw new AppError('forbidden', 'This report includes sections your role cannot access.', {
      permission: job.financial === 1 && !staff.can('reports.financial') ? 'reports.financial' : job.raw_events === 1 ? 'reports.export_raw' : 'reports.view',
    });
  }
  if (job.status !== 'ready' || !job.file_path) throw new AppError('report_not_ready', 'This report is not ready yet.', { status: job.status });
  const root = resolve(config.reportsDir);
  const path = resolve(root, job.file_path);
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new AppError('not_found', 'Report file not found');
  if (!existsSync(path)) throw new AppError('not_found', 'The report file is missing from the reports folder. Generate a new report.');
  const ext = job.kind === 'annual_pdf' ? 'pdf' : 'zip';
  const suffix = `${job.label}-r${job.revision}${job.include_fixture ? '-demo' : ''}`;
  return {
    path,
    filename: `rabbit-grill-${job.kind === 'annual_pdf' ? 'annual-report' : 'annual-data'}-${job.year}-${suffix}.${ext}`,
    contentType: ext === 'pdf' ? 'application/pdf' : 'application/zip',
    bytes: statSync(path).size,
    sha256: job.file_sha256,
  };
}
