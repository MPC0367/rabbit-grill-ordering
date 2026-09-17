-- Data retention (D-S8-02). The daily retention task removes private text
-- past its horizon but keeps the record, and remembers that a note existed so
-- reports for old years keep the same "lines with a guest note" counts.
ALTER TABLE order_lines ADD COLUMN note_removed_at TEXT;
ALTER TABLE service_requests ADD COLUMN note_removed_at TEXT;
ALTER TABLE portion_requests ADD COLUMN note_removed_at TEXT;
ALTER TABLE portion_quotes ADD COLUMN note_removed_at TEXT;
ALTER TABLE feedback ADD COLUMN comment_removed_at TEXT;

-- The task walks old rows by date.
CREATE INDEX IF NOT EXISTS staff_sessions_expiry ON staff_sessions(expires_at);
CREATE INDEX IF NOT EXISTS events_created ON events(created_at);
