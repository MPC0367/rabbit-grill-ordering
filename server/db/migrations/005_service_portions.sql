-- S4 service requests, feedback and measured-weight portions.
-- Additive only: indexes that back the portion invariants and the staff
-- queues, plus the fixture flag feedback was missing (D-10).

-- A confirmed portion quote becomes exactly one order line, even if two
-- confirmations race (guest phone + staff in person). The portion flow also
-- checks this in its transaction; the index is the backstop.
CREATE UNIQUE INDEX order_lines_one_per_portion_quote
  ON order_lines(portion_quote_id) WHERE portion_quote_id IS NOT NULL;

-- Staff portion queue across all visits (scope=open).
CREATE INDEX portion_requests_status ON portion_requests(status, created_at);
CREATE INDEX portion_requests_date ON portion_requests(business_date);

-- Quote expiry sweep only looks at active quotes.
CREATE INDEX portion_quotes_active_expiry ON portion_quotes(expires_at) WHERE status = 'active';

-- Service queue history by business date.
CREATE INDEX service_requests_date ON service_requests(business_date, created_at);

-- Demo feedback must be excludable from real reports like every other record.
ALTER TABLE feedback ADD COLUMN is_fixture INTEGER NOT NULL DEFAULT 0 CHECK (is_fixture IN (0,1));
