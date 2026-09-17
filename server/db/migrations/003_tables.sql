-- S2 tables & visits.
-- A rotated QR invalidates every printed card for that table. Remember when
-- staff last downloaded the current card so the table tile keeps saying
-- "print the new card" until somebody has actually fetched it.
ALTER TABLE table_qr_tokens ADD COLUMN card_downloaded_at TEXT;

-- Tile and overview queries look up a table's tokens and a visit's lines/requests.
CREATE INDEX IF NOT EXISTS s2_qr_tokens_table ON table_qr_tokens(table_id, active);
CREATE INDEX IF NOT EXISTS s2_service_requests_visit ON service_requests(visit_id, status);
