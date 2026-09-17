-- Round 2 cross-area work (server): order-line confirmation snapshots, menu
-- search aliases, the service-request responder id, and a small key/value
-- table for facts about the database itself (identity, seed state).
-- Additive only.

-- ---------------------------------------------------------------- order lines
-- Kitchen tickets must not ask today's menu whether a dish needed staff
-- confirmation: an alcohol switch or an item edit would rewrite history. Both
-- flags are snapshotted when the line is created (D-S8-20).
ALTER TABLE order_lines ADD COLUMN alcohol INTEGER NOT NULL DEFAULT 0 CHECK (alcohol IN (0,1));
ALTER TABLE order_lines ADD COLUMN requires_staff_confirm INTEGER NOT NULL DEFAULT 0 CHECK (requires_staff_confirm IN (0,1));

-- Backfill from the menu as it stands now, with the owner's current alcohol
-- switch: the best available answer for rounds taken before the snapshot.
UPDATE order_lines SET alcohol = 1
 WHERE EXISTS (
   SELECT 1 FROM menu_items i LEFT JOIN menu_categories c ON c.id = i.category_id
    WHERE i.id = order_lines.item_id AND (i.alcohol = 1 OR c.alcohol = 1));
UPDATE order_lines SET requires_staff_confirm = 1
 WHERE EXISTS (SELECT 1 FROM menu_items i WHERE i.id = order_lines.item_id AND i.requires_staff_confirm = 1)
    OR (alcohol = 1
        AND COALESCE(json_extract((SELECT value FROM settings WHERE key = 'alcohol'), '$.staff_confirmation_note'), 1) = 1);

-- ---------------------------------------------------------------- menu aliases
-- Other spellings and nicknames guests search for (brief 09, 44E). Stored as
-- JSON arrays of plain strings; printed names never change. Only aliases a
-- reviewer approved (aliases_verified) are published in the guest menu.
ALTER TABLE menu_items ADD COLUMN aliases_th TEXT NOT NULL DEFAULT '[]';
ALTER TABLE menu_items ADD COLUMN aliases_en TEXT NOT NULL DEFAULT '[]';
ALTER TABLE menu_items ADD COLUMN aliases_verified INTEGER NOT NULL DEFAULT 0 CHECK (aliases_verified IN (0,1));

-- ---------------------------------------------------------------- service requests
-- acknowledged_by holds the display name shown on staff screens. Reports need
-- the account, which survives a rename: record the id as well and backfill it
-- from the audit trail of the first staff response.
ALTER TABLE service_requests ADD COLUMN acknowledged_by_id TEXT;
UPDATE service_requests SET acknowledged_by_id = (
  SELECT a.actor_id FROM audit_events a
   WHERE a.entity_type = 'service_request' AND a.entity_id = service_requests.id
     AND a.actor_type = 'staff' AND a.action IN ('service.acknowledged', 'service.completed')
   ORDER BY a.id LIMIT 1)
 WHERE acknowledged_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS service_requests_ack_by ON service_requests(acknowledged_by_id) WHERE acknowledged_by_id IS NOT NULL;

-- KPI filters read payments by the staff member who recorded them.
CREATE INDEX IF NOT EXISTS payments_confirmed_by ON payments(confirmed_by);

-- ---------------------------------------------------------------- database facts
-- Facts about this database file rather than about the restaurant:
--   db_epoch   a random identity, so a live client can tell "restored from a
--              backup / reset" from "nothing happened" (event ids restart)
--   seed_state running | complete: an interrupted demo seed is detectable
--              instead of leaving a half-built development database
CREATE TABLE app_meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
INSERT INTO app_meta (key, value, updated_at)
VALUES ('db_epoch', lower(hex(randomblob(8))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
