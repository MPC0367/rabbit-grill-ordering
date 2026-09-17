-- Review fixes (server stream). Additive except for one index swap.

-- Bill adjustments: an idempotent create (a retried or double-sent discount is
-- stored once) and a void trail. voided_at / voided_by / void_reason already
-- exist; nothing wrote them before.
ALTER TABLE bill_adjustments ADD COLUMN idempotency_key TEXT;
ALTER TABLE bill_adjustments ADD COLUMN payload_hash TEXT;
CREATE UNIQUE INDEX bill_adjustments_key ON bill_adjustments(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX bill_adjustments_line ON bill_adjustments(order_line_id) WHERE order_line_id IS NOT NULL;

-- Join PIN: lockouts escalate within a visit; rotating the PIN resets them.
ALTER TABLE visits ADD COLUMN pin_lockouts INTEGER NOT NULL DEFAULT 0;

-- "Currently cooking" / "Currently preparing" wording: NULL = derived from
-- station and group (drinks, bar and desserts prepare; the rest cook).
ALTER TABLE menu_categories ADD COLUMN prep_kind TEXT CHECK (prep_kind IS NULL OR prep_kind IN ('cook', 'prepare'));
ALTER TABLE menu_items ADD COLUMN prep_kind TEXT CHECK (prep_kind IS NULL OR prep_kind IN ('cook', 'prepare'));
-- The raw salads on the printed menu are assembled, not cooked. Grilled Caesar
-- (grilled) keeps the derived wording. Owners can change either in the editor.
UPDATE menu_items SET prep_kind = 'prepare'
 WHERE key IN ('green-beans-peas-salad', 'green-salad-balsamic', 'tomato-salad', 'burrata-tomato-salad');

-- Engagement statistics read only these columns: a covering index saves one
-- row lookup per event (about half the time of a year view). It starts with
-- the columns of the index it replaces, so every existing plan still applies.
CREATE INDEX analytics_events_date_cover ON analytics_events(
  business_date, type, session_id, route, item_id, category_id, active_ms, depth, quick_add, is_fixture);
DROP INDEX analytics_events_date;

-- The retention task finds old feedback and portion quotes by date.
CREATE INDEX IF NOT EXISTS feedback_date ON feedback(business_date);
