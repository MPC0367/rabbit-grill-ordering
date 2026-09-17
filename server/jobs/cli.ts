// Operator commands for the background work the server normally does itself.
//
//   npm run jobs -- report --year 2025 [--kind annual_pdf|annual_csv] [--fixture] [--reason "..."] [--html <dir>]
//   npm run jobs -- run                       run every queued report job now
//   npm run jobs -- rollover [--run]          queue final reports for completed years (and run them)
//   npm run jobs -- aggregates [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//   npm run jobs -- expire-quotes
//   npm run jobs -- retention [--dry-run]      apply the data-retention settings now
//   npm run jobs -- backup --out <file.db> [--with-reports]
//   npm run jobs -- restore                   prints the restore procedure (does not restore)
//
// Shell access to the server is the authority for these commands; report jobs
// they queue are recorded as requested by "command line" with full scope.
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.ts';
import { closeDatabase, db, migrate, openDatabase, tx } from '../db/index.ts';
import { addDays, nowIso, todayBusinessDate } from '../../shared/time.ts';
import { AppError } from '../lib/errors.ts';
import { cutoffHour } from '../lib/settings.ts';
import { CLI_REQUESTER, ensureFinalReports, enqueueReport, getJob, runNextReportJob, runReportJob, type ReportKind } from '../domain/reports.ts';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'help';
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : undefined;
};
const flag = (name: string) => argv.includes(`--${name}`);
const isDate = (v: string | undefined) => v === undefined || /^\d{4}-\d{2}-\d{2}$/.test(v);

function fail(message: string, code = 2): never {
  console.error(message);
  closeDatabase();
  process.exit(code);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runQueued(): Promise<number> {
  let n = 0;
  for (;;) {
    const r = await runNextReportJob({ htmlOut: opt('html') });
    if (!r) break;
    n++;
    console.log(`${r.id}: ${r.status}${r.file ? ` -> ${r.file}` : ''}${r.error ? ` (${r.error})` : ''} [${r.ms} ms${r.pages ? `, ${r.pages} pages` : ''}]`);
    if (r.status === 'queued') await sleep(1000); // a retry is due; give the cause a moment
  }
  return n;
}

async function reportCommand(): Promise<void> {
  const year = Number(opt('year'));
  if (!Number.isInteger(year) || year < 2020 || year > 2100) fail('report: --year YYYY is required');
  const kind = (opt('kind') ?? 'annual_pdf') as ReportKind;
  if (kind !== 'annual_pdf' && kind !== 'annual_csv') fail('report: --kind must be annual_pdf or annual_csv');
  const job = tx(() => enqueueReport({ kind, year, reason: opt('reason') ?? null, includeFixture: flag('fixture'), staff: CLI_REQUESTER }));
  console.log(`queued ${job.id}: ${kind} ${year} ${job.label} revision ${job.revision}`);
  const result = await runReportJob(job.id, { htmlOut: opt('html') });
  if (result.status === 'ready') {
    console.log(`ready: ${result.file} (${result.bytes} bytes${result.pages ? `, ${result.pages} pages` : ''}, ${result.ms} ms)`);
    return;
  }
  if (result.status === 'generating') {
    // The running server picked it up first: wait for it.
    console.log('the server is generating this report; waiting...');
    const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline) {
      await sleep(1500);
      const row = getJob(job.id);
      if (row?.status === 'ready') {
        console.log(`ready: ${resolve(config.reportsDir, row.file_path!)} (${row.file_bytes} bytes)`);
        return;
      }
      if (row?.status === 'failed') fail(`failed: ${row.error}`, 1);
    }
    fail('timed out waiting for the server', 1);
  }
  fail(`${result.status}: ${result.error ?? 'not generated'}${result.status === 'queued' ? ' (will be retried; run `npm run jobs -- run`)' : ''}`, 1);
}

async function main(): Promise<void> {
  switch (command) {
    case 'report':
      await reportCommand();
      break;
    case 'run': {
      const n = await runQueued();
      console.log(n ? `${n} job run(s) finished` : 'no queued report jobs');
      break;
    }
    case 'rollover': {
      const queued = ensureFinalReports();
      console.log(queued.length ? `queued ${queued.join(', ')}` : 'every completed year already has its final report jobs');
      if (flag('run')) await runQueued();
      break;
    }
    case 'aggregates': {
      const from = opt('from');
      const to = opt('to');
      if (!isDate(from) || !isDate(to)) fail('aggregates: --from/--to must be YYYY-MM-DD');
      const today = todayBusinessDate(cutoffHour());
      const { refreshAggregates } = await import('../domain/aggregates.ts');
      const result = await refreshAggregates(from ?? addDays(today, -2), to ?? today);
      console.log('aggregates refreshed', JSON.stringify(result));
      break;
    }
    case 'retention': {
      const dryRun = flag('dry-run');
      const { runRetention } = await import('../domain/retention.ts');
      const r = await runRetention({ dryRun });
      console.log(`${dryRun ? 'would remove' : 'removed'} (before: notes ${r.horizons.notes_before}, feedback ${r.horizons.feedback_before}, `
        + `raw events ${r.horizons.raw_events_before}, audit ${r.horizons.audit_before})`);
      console.log(JSON.stringify({ ...r, horizons: undefined }, null, 2));
      break;
    }
    case 'expire-quotes': {
      const { expireQuotes } = await import('../domain/portions.ts');
      console.log(`${expireQuotes(nowIso())} quote(s) expired`);
      break;
    }
    case 'backup': {
      const out = opt('out');
      if (!out) fail('backup: --out <file> is required');
      const target = resolve(out);
      if (existsSync(target)) fail(`backup: ${target} already exists; choose a new file name`);
      mkdirSync(dirname(target), { recursive: true });
      // VACUUM INTO writes a consistent, compacted copy while the server keeps running.
      db().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
      console.log(`database backup written: ${target} (${statSync(target).size} bytes)`);
      if (flag('with-reports')) {
        const reportsCopy = `${target}.reports`;
        if (existsSync(config.reportsDir)) {
          cpSync(config.reportsDir, reportsCopy, { recursive: true, errorOnExist: true });
          console.log(`report files copied: ${reportsCopy}`);
        } else {
          console.log(`no report files yet (${config.reportsDir} does not exist)`);
        }
      } else {
        console.log(`report files are not inside the database; also copy ${config.reportsDir} (or rerun with --with-reports).`);
      }
      break;
    }
    case 'restore':
      console.log(`Restoring a backup replaces the live database. It is deliberately manual:

  1. Stop the server (Ctrl+C, or stop the service) and make sure no "npm run jobs" command is running.
  2. Keep the current files in case you need them:
       move  ${config.databasePath}      ${config.databasePath}.before-restore
       move  ${config.databasePath}-wal  (and -shm, if present) next to it
  3. Copy the backup file to ${config.databasePath}
  4. If the backup was made with --with-reports, copy <backup>.reports back to ${config.reportsDir}
  5. Start the server. It applies any newer migrations automatically.
  6. Sign in and check Reports > Annual archive and the latest orders before reopening service.

Report jobs that were "generating" when the backup was taken are queued again on start.`);
      break;
    default:
      console.log(`Rabbit Grill background jobs

  report --year YYYY [--kind annual_pdf|annual_csv] [--fixture] [--reason "..."] [--html <dir>]
      queue a report and generate it now, then print the file path
  run            generate every queued report job now
  rollover [--run]
      queue final reports for completed years that have none
  aggregates [--from YYYY-MM-DD] [--to YYYY-MM-DD]
      rebuild daily aggregates (default: the last three business days)
  expire-quotes  expire measured-weight quotes past their deadline
  retention [--dry-run]
      remove guest notes, feedback comments, raw engagement events and audit
      entries older than the retention settings (runs daily in the server)
  backup --out <file> [--with-reports]
      consistent copy of the database (VACUUM INTO), optionally with report files
  restore        print the restore procedure`);
      if (command !== 'help') process.exitCode = 2;
  }
}

openDatabase();
migrate();
try {
  await main();
} catch (err) {
  if (err instanceof AppError) {
    const issues = (err.details as { issues?: Array<{ path: string; message: string }> } | undefined)?.issues ?? [];
    console.error(`${err.code}: ${err.message}${issues.map((i) => `\n  ${i.path}: ${i.message}`).join('')}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
} finally {
  closeDatabase();
}
