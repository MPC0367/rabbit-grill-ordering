-- S7 reports & admin: extra report-job scope and audit lookup.
--
-- raw_events:   the job's companion data contains raw engagement events, so a
--               download must re-check reports.export_raw as well as
--               reports.view (and reports.financial when `financial` = 1).
-- summary_json: headline totals of the snapshot the file was built from, so a
--               later revision can show exactly which figures changed.
ALTER TABLE report_jobs ADD COLUMN raw_events INTEGER NOT NULL DEFAULT 0 CHECK (raw_events IN (0,1));
ALTER TABLE report_jobs ADD COLUMN summary_json TEXT;

CREATE INDEX report_jobs_status ON report_jobs(status, attempts, requested_at);

-- Audit screen filters by actor and pages backwards by id.
CREATE INDEX audit_actor ON audit_events(actor_id, id);
