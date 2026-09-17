// Staff administration routes (mounted at /api/staff): annual reports,
// team, settings and the audit log.
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { tx } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { requireStaff, staffOf } from '../lib/auth.ts';
import { AppError } from '../lib/errors.ts';
import { body, query } from '../lib/http.ts';
import { hit, LIMITS } from '../lib/ratelimit.ts';
import { CreateStaffBody, IdSchema, IsoDateSchema, ReportJobBody, SetPasswordBody, SettingsPatchBody, UpdateStaffBody } from '../../shared/schemas.ts';
import { AuditQuery, listAudit } from '../domain/audit-view.ts';
import { listFeedback } from '../domain/feedback.ts';
import { enqueueReport, jobDTOById, reportFile, reportYears, retryReport } from '../domain/reports.ts';
import { patchSettings, settingsView } from '../domain/settings-admin.ts';
import { createStaff, listTeam, revokeStaffSessions, setStaffPassword, updateStaff } from '../domain/team.ts';
import { nudgeJobs } from '../jobs/runner.ts';

/** Route ids are opaque database ids; reject anything else before touching the database. */
function idParam(value: string): string {
  if (!IdSchema.safeParse(value).success) throw new AppError('not_found', 'Not found');
  return value;
}

/** GET /api/staff/feedback?from&to&include_fixture (business dates, inclusive). */
const FeedbackListQuery = z.object({
  from: IsoDateSchema,
  to: IsoDateSchema,
  include_fixture: z.enum(['0', '1']).default('0'),
});

function mutationLimit(staffId: string): void {
  hit(`staff-mutation:${staffId}`, LIMITS.staffMutation);
}

export const adminStaff = new Hono<AppEnv>()
  // ---------------------------------------------------------------- reports
  .get('/reports/years', requireStaff('reports.view'), (c) => {
    return c.json({ years: reportYears(staffOf(c)) });
  })
  .get('/reports/jobs/:id', requireStaff('reports.view'), (c) => {
    return c.json(jobDTOById(idParam(c.req.param('id')), staffOf(c)));
  })
  .post('/reports/jobs', requireStaff('reports.generate'), async (c) => {
    const input = await body(c, ReportJobBody);
    const staff = staffOf(c);
    mutationLimit(staff.user.id);
    const job = tx(() => enqueueReport({
      kind: input.kind,
      year: input.year,
      reason: input.reason ?? null,
      includeFixture: input.include_fixture,
      staff,
    }));
    nudgeJobs();
    return c.json(job, 202);
  })
  .post('/reports/jobs/:id/retry', requireStaff('reports.generate'), (c) => {
    const staff = staffOf(c);
    mutationLimit(staff.user.id);
    const job = tx(() => retryReport(idParam(c.req.param('id')), staff));
    nudgeJobs();
    return c.json(job, 202);
  })
  .get('/reports/jobs/:id/download', requireStaff('reports.view'), (c) => {
    const staff = staffOf(c);
    const id = idParam(c.req.param('id'));
    const file = reportFile(id, staff); // re-checks reports.view / financial / raw scope
    tx(() => audit(staff.actor, 'report.download', { type: 'report_job', id }, { after: { bytes: file.bytes } }));
    const stream = Readable.toWeb(createReadStream(file.path)) as unknown as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': file.contentType,
        'Content-Length': String(file.bytes),
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'Cache-Control': 'no-store, private',
        ...(file.sha256 ? { ETag: `"${file.sha256}"`, 'X-Content-SHA256': file.sha256 } : {}),
      },
    });
  })

  // ---------------------------------------------------------------- guest feedback
  // Read-only, for the operational report. Never pushed on the live stream:
  // ratings and comments are not a queue anyone works.
  .get('/feedback', requireStaff('reports.view'), (c) => {
    const q = query(c, FeedbackListQuery);
    return c.json(listFeedback({ from: q.from, to: q.to, include_fixture: q.include_fixture === '1' }));
  })

  // ---------------------------------------------------------------- team
  .get('/team', requireStaff('team.manage'), (c) => {
    return c.json({ users: listTeam() });
  })
  .post('/team', requireStaff('team.manage'), async (c) => {
    const input = await body(c, CreateStaffBody);
    const staff = staffOf(c);
    mutationLimit(staff.user.id);
    return c.json(tx(() => createStaff(input, staff)), 201);
  })
  .patch('/team/:id', requireStaff('team.manage'), async (c) => {
    const input = await body(c, UpdateStaffBody);
    const staff = staffOf(c);
    mutationLimit(staff.user.id);
    return c.json(tx(() => updateStaff(idParam(c.req.param('id')), input, staff)));
  })
  // Self-service with current_password, or team.manage for anyone (checked in the domain).
  .post('/team/:id/password', requireStaff(), async (c) => {
    const input = await body(c, SetPasswordBody);
    const staff = staffOf(c);
    mutationLimit(staff.user.id);
    const id = idParam(c.req.param('id'));
    if (id !== staff.user.id && !staff.can('team.manage')) {
      throw new AppError('forbidden', 'Your role cannot change other accounts.', { permission: 'team.manage' });
    }
    tx(() => setStaffPassword(id, input, staff));
    return c.json({ ok: true });
  })
  .post('/team/:id/revoke-sessions', requireStaff('team.manage'), (c) => {
    const staff = staffOf(c);
    mutationLimit(staff.user.id);
    const revoked = tx(() => revokeStaffSessions(idParam(c.req.param('id')), staff));
    return c.json({ ok: true, revoked });
  })

  // ---------------------------------------------------------------- settings
  .get('/settings', requireStaff('settings.manage'), (c) => {
    return c.json(settingsView());
  })
  .patch('/settings', requireStaff('settings.manage'), async (c) => {
    const input = await body(c, SettingsPatchBody);
    const staff = staffOf(c);
    mutationLimit(staff.user.id);
    return c.json(tx(() => patchSettings(input, staff)));
  })

  // ---------------------------------------------------------------- audit
  .get('/audit', requireStaff('audit.view'), (c) => {
    return c.json(listAudit(query(c, AuditQuery)));
  });
