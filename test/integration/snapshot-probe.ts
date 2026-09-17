// Test helper (not a test): build the annual report snapshot for DATABASE_PATH
// in this separate process and print its payments block as JSON.
//   node test/integration/snapshot-probe.ts <year>
import { closeDatabase, openDatabase } from '../../server/db/index.ts';
import { openSnapshotReader } from '../../server/domain/export/reader.ts';
import { buildSnapshot } from '../../server/domain/export/snapshot.ts';

openDatabase();
const year = Number(process.argv[2]);
const reader = openSnapshotReader();
const snap = await buildSnapshot(reader, {
  id: 'rpt_probe', kind: 'annual_pdf', year, label: 'provisional', revision: 1, reason: null,
  requested_at: new Date().toISOString(), requested_by: 'cli', role_scope: 'cli', financial: true, raw_events: false,
  include_fixture: true, supersedes_job_id: null,
});
reader.close();
closeDatabase();
const p = snap.payments!;
process.stdout.write(JSON.stringify({
  settled_minor: p.settled_minor,
  settlements: p.settlements,
  reversal_minor: p.reversal_minor,
  reversals: p.reversals,
  refund_minor: p.refund_minor,
  refunds: p.refunds,
  net_paid_minor: p.net_paid_minor,
  monthly: p.monthly,
  exception_count: p.exception_count,
  exceptions: p.exceptions.map((e) => ({ kind: e.kind, visit_id: e.visit_id, amount_minor: e.amount_minor })),
  lines_with_note: snap.overview.lines_with_note,
}));
