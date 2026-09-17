-- Rabbit Grill ordering platform - initial schema.
-- Conventions: TEXT ids with a type prefix; UTC ISO-8601 timestamps;
-- money in integer satang (*_minor); business_date = Asia/Bangkok local date
-- stamped at write time; `version` columns for optimistic concurrency;
-- `is_fixture` marks development/demo data that real reports exclude.

-- ============================================================ configuration
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,              -- JSON
  updated_by  TEXT,
  updated_at  TEXT NOT NULL
);

-- ============================================================ staff
CREATE TABLE staff_users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name   TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('owner','manager','cashier','floor','kitchen')),
  password_hash  TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  is_fixture     INTEGER NOT NULL DEFAULT 0 CHECK (is_fixture IN (0,1)),
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   TEXT,
  last_login_at  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE staff_sessions (
  id            TEXT PRIMARY KEY,         -- sha256(token), never the token
  user_id       TEXT NOT NULL REFERENCES staff_users(id),
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT
);
CREATE INDEX staff_sessions_user ON staff_sessions(user_id);

-- ============================================================ tables, QR, visits
CREATE TABLE dining_tables (
  id               TEXT PRIMARY KEY,
  label            TEXT NOT NULL,
  zone             TEXT,
  location_type    TEXT NOT NULL DEFAULT 'table' CHECK (location_type IN ('table','room','zone')),
  sort             INTEGER NOT NULL DEFAULT 0,
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  ordering_paused  INTEGER NOT NULL DEFAULT 0 CHECK (ordering_paused IN (0,1)),
  archived_at      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX dining_tables_label_live ON dining_tables(label COLLATE NOCASE) WHERE archived_at IS NULL;

CREATE TABLE table_qr_tokens (
  id          TEXT PRIMARY KEY,
  table_id    TEXT NOT NULL REFERENCES dining_tables(id),
  token       TEXT NOT NULL UNIQUE,       -- opaque, high entropy; printed in the QR
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at  TEXT NOT NULL,
  created_by  TEXT,
  revoked_at  TEXT,
  revoked_by  TEXT,
  reason      TEXT
);
CREATE UNIQUE INDEX table_qr_one_active ON table_qr_tokens(table_id) WHERE active = 1;

CREATE TABLE visits (
  id                   TEXT PRIMARY KEY,
  table_id             TEXT NOT NULL REFERENCES dining_tables(id),
  status               TEXT NOT NULL CHECK (status IN ('open','billing','closed')),
  join_pin             TEXT,               -- cleared on close
  pin_rotated_at       TEXT,
  pin_failures         INTEGER NOT NULL DEFAULT 0,
  pin_locked_until     TEXT,
  covers               INTEGER CHECK (covers IS NULL OR covers BETWEEN 1 AND 99),
  charges_json         TEXT NOT NULL DEFAULT '[]',  -- charge rules snapshotted at seating
  seated_at            TEXT NOT NULL,
  seated_business_date TEXT NOT NULL,
  opened_by            TEXT REFERENCES staff_users(id),
  open_idempotency_key TEXT UNIQUE,
  bill_requested_at    TEXT,
  billing_started_at   TEXT,
  billing_started_by   TEXT,
  closed_at            TEXT,
  closed_by            TEXT,
  close_business_date  TEXT,
  close_idempotency_key TEXT UNIQUE,
  close_exception      TEXT,               -- manager exception reason, if any
  is_fixture           INTEGER NOT NULL DEFAULT 0 CHECK (is_fixture IN (0,1)),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  version              INTEGER NOT NULL DEFAULT 1
);
-- One active dining visit per table (brief 07, 27).
CREATE UNIQUE INDEX visits_one_active_per_table ON visits(table_id) WHERE status <> 'closed';
CREATE INDEX visits_seated_date ON visits(seated_business_date);
CREATE INDEX visits_close_date ON visits(close_business_date);

CREATE TABLE guest_sessions (
  id             TEXT PRIMARY KEY,
  visit_id       TEXT NOT NULL REFERENCES visits(id),
  token_hash     TEXT NOT NULL UNIQUE,     -- sha256 of the cookie token
  guest_no       INTEGER NOT NULL,         -- "Guest 1, Guest 2" within the visit
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  revoked_at     TEXT,
  revoke_reason  TEXT,
  UNIQUE (visit_id, guest_no)
);
CREATE INDEX guest_sessions_visit ON guest_sessions(visit_id);

CREATE TABLE visit_transfers (
  id             TEXT PRIMARY KEY,
  visit_id       TEXT NOT NULL REFERENCES visits(id),
  from_table_id  TEXT NOT NULL REFERENCES dining_tables(id),
  to_table_id    TEXT NOT NULL REFERENCES dining_tables(id),
  reason         TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- ============================================================ catalog
CREATE TABLE menu_groups (
  id       TEXT PRIMARY KEY,
  key      TEXT NOT NULL UNIQUE CHECK (key IN ('food','drinks')),
  name_th  TEXT NOT NULL,
  name_en  TEXT NOT NULL,
  sort     INTEGER NOT NULL
);

CREATE TABLE menu_categories (
  id               TEXT PRIMARY KEY,
  key              TEXT NOT NULL UNIQUE,
  group_id         TEXT NOT NULL REFERENCES menu_groups(id),
  name_th          TEXT,
  name_en          TEXT NOT NULL,
  note_th          TEXT,
  note_en          TEXT,
  sort             INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('draft','published','archived')),
  seasonal         INTEGER NOT NULL DEFAULT 0 CHECK (seasonal IN (0,1)),
  active_from      TEXT,                   -- local date, inclusive
  active_until     TEXT,                   -- local date, inclusive
  station          TEXT NOT NULL DEFAULT 'kitchen' CHECK (station IN ('kitchen','bar')),
  alcohol          INTEGER NOT NULL DEFAULT 0 CHECK (alcohol IN (0,1)),
  ordering_paused  INTEGER NOT NULL DEFAULT 0 CHECK (ordering_paused IN (0,1)),
  source_note      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  updated_by       TEXT,
  version          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE menu_items (
  id                     TEXT PRIMARY KEY,
  key                    TEXT NOT NULL UNIQUE,
  category_id            TEXT NOT NULL REFERENCES menu_categories(id),
  sort                   INTEGER NOT NULL,
  name_th                TEXT,
  name_en                TEXT,
  name_th_source         TEXT,
  desc_th                TEXT,
  desc_en                TEXT,
  desc_verified          INTEGER NOT NULL DEFAULT 0 CHECK (desc_verified IN (0,1)),
  portion_note_th        TEXT,
  portion_note_en        TEXT,
  pricing_type           TEXT NOT NULL CHECK (pricing_type IN ('fixed','variant','measured_weight')),
  price_minor            INTEGER CHECK (price_minor IS NULL OR price_minor >= 0),
  rate_minor             INTEGER CHECK (rate_minor IS NULL OR rate_minor >= 0),
  rate_basis_grams       INTEGER CHECK (rate_basis_grams IS NULL OR rate_basis_grams > 0),
  status                 TEXT NOT NULL CHECK (status IN ('draft','published','archived')),
  review_status          TEXT NOT NULL CHECK (review_status IN ('unverified','needs_review','verified')),
  demo_orderable         INTEGER NOT NULL DEFAULT 0 CHECK (demo_orderable IN (0,1)),
  sold_out               INTEGER NOT NULL DEFAULT 0 CHECK (sold_out IN (0,1)),
  sold_out_since         TEXT,
  notes_allowed          INTEGER NOT NULL DEFAULT 1 CHECK (notes_allowed IN (0,1)),
  note_max               INTEGER NOT NULL DEFAULT 140,
  max_qty                INTEGER NOT NULL DEFAULT 20 CHECK (max_qty BETWEEN 1 AND 99),
  station                TEXT NOT NULL DEFAULT 'kitchen' CHECK (station IN ('kitchen','bar')),
  alcohol                INTEGER NOT NULL DEFAULT 0 CHECK (alcohol IN (0,1)),
  requires_staff_confirm INTEGER NOT NULL DEFAULT 0 CHECK (requires_staff_confirm IN (0,1)),
  image                  TEXT,
  image_alt_th           TEXT,
  image_alt_en           TEXT,
  allergen_status        TEXT NOT NULL DEFAULT 'unknown' CHECK (allergen_status IN ('unknown','verified')),
  allergen_verified_by   TEXT,
  allergen_verified_at   TEXT,
  source_url             TEXT,
  source_ref             TEXT,
  source_text            TEXT,
  retrieved_at           TEXT,
  translation_status     TEXT,
  reviewer               TEXT,
  approved_at            TEXT,
  review_notes           TEXT,
  published_version      INTEGER,          -- `version` at last publish; differs = unpublished changes
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  updated_by             TEXT,
  version                INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX menu_items_category ON menu_items(category_id, sort);

CREATE TABLE item_variants (
  id           TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES menu_items(id),
  key          TEXT NOT NULL,
  name_th      TEXT,
  name_en      TEXT,
  price_minor  INTEGER CHECK (price_minor IS NULL OR price_minor >= 0),
  available    INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0,1)),
  archived_at  TEXT,
  sort         INTEGER NOT NULL DEFAULT 0,
  source_text  TEXT,
  UNIQUE (item_id, key)
);

CREATE TABLE modifier_groups (
  id              TEXT PRIMARY KEY,
  key             TEXT NOT NULL UNIQUE,
  name_th         TEXT,
  name_en         TEXT NOT NULL,
  min_select      INTEGER NOT NULL DEFAULT 0,
  max_select      INTEGER NOT NULL DEFAULT 1,
  included_count  INTEGER NOT NULL DEFAULT 0,
  archived_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  CHECK (min_select >= 0 AND max_select >= 1 AND max_select >= min_select AND included_count >= 0)
);

CREATE TABLE modifier_options (
  id                 TEXT PRIMARY KEY,
  group_id           TEXT NOT NULL REFERENCES modifier_groups(id),
  key                TEXT NOT NULL,
  name_th            TEXT,
  name_en            TEXT NOT NULL,
  price_delta_minor  INTEGER NOT NULL DEFAULT 0 CHECK (price_delta_minor >= 0),
  upgrade_minor      INTEGER NOT NULL DEFAULT 0 CHECK (upgrade_minor >= 0),
  is_default         INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  available          INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0,1)),
  archived_at        TEXT,
  sort               INTEGER NOT NULL DEFAULT 0,
  UNIQUE (group_id, key)
);

CREATE TABLE item_modifier_groups (
  item_id   TEXT NOT NULL REFERENCES menu_items(id),
  group_id  TEXT NOT NULL REFERENCES modifier_groups(id),
  sort      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, group_id)
);

CREATE TABLE item_allergens (
  item_id   TEXT NOT NULL REFERENCES menu_items(id),
  allergen  TEXT NOT NULL,
  state     TEXT NOT NULL CHECK (state IN ('contains','may_contain')),
  note      TEXT,
  PRIMARY KEY (item_id, allergen)
);

CREATE TABLE item_flags (
  id           TEXT PRIMARY KEY,
  item_id      TEXT REFERENCES menu_items(id),
  category_id  TEXT REFERENCES menu_categories(id),
  code         TEXT NOT NULL,
  detail       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  resolved_at  TEXT,
  resolved_by  TEXT,
  resolution   TEXT
);
CREATE INDEX item_flags_item ON item_flags(item_id);

CREATE TABLE price_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id      TEXT NOT NULL REFERENCES menu_items(id),
  variant_id   TEXT REFERENCES item_variants(id),
  price_minor  INTEGER,
  rate_minor   INTEGER,
  changed_at   TEXT NOT NULL,
  changed_by   TEXT,
  reason       TEXT
);
CREATE INDEX price_history_item ON price_history(item_id);

-- Availability history makes "least ordered" fair: a dish sold out all week
-- is not "unpopular". One row per change; `available` is the new state.
CREATE TABLE availability_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     TEXT NOT NULL REFERENCES menu_items(id),
  available   INTEGER NOT NULL CHECK (available IN (0,1)),
  reason      TEXT NOT NULL,              -- sold_out | restocked | published | archived | seasonal | category_paused | orderability
  changed_at  TEXT NOT NULL,
  changed_by  TEXT
);
CREATE INDEX availability_log_item ON availability_log(item_id, changed_at);

CREATE TABLE menu_placement_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('category','item')),
  entity_id    TEXT NOT NULL,
  old_sort     INTEGER,
  new_sort     INTEGER,
  changed_at   TEXT NOT NULL,
  changed_by   TEXT
);

CREATE TABLE menu_import_batches (
  id          TEXT PRIMARY KEY,
  filename    TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('previewed','applied','discarded')),
  rows_json   TEXT NOT NULL,
  errors_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  applied_at  TEXT,
  applied_by  TEXT
);

-- ============================================================ orders
CREATE TABLE orders (
  id                    TEXT PRIMARY KEY,
  reference             TEXT NOT NULL UNIQUE,
  visit_id              TEXT NOT NULL REFERENCES visits(id),
  table_id              TEXT NOT NULL REFERENCES dining_tables(id),
  table_label           TEXT NOT NULL,     -- snapshot at submission
  round_no              INTEGER NOT NULL,
  source                TEXT NOT NULL CHECK (source IN ('guest','staff','manual_recovery','portion_quote')),
  guest_session_id      TEXT REFERENCES guest_sessions(id),
  staff_user_id         TEXT REFERENCES staff_users(id),
  analytics_session_id  TEXT,
  idempotency_key       TEXT NOT NULL,
  payload_hash          TEXT NOT NULL,
  locale                TEXT,
  submitted_at          TEXT NOT NULL,
  business_date         TEXT NOT NULL,
  manual_reference      TEXT,
  manual_original_time  TEXT,
  subtotal_minor        INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  first_accepted_at     TEXT,
  finished_at           TEXT,
  finished_by           TEXT,
  is_fixture            INTEGER NOT NULL DEFAULT 0 CHECK (is_fixture IN (0,1)),
  updated_at            TEXT NOT NULL,
  version               INTEGER NOT NULL DEFAULT 1,
  UNIQUE (visit_id, idempotency_key),
  UNIQUE (visit_id, round_no)
);
CREATE UNIQUE INDEX orders_manual_reference ON orders(manual_reference) WHERE manual_reference IS NOT NULL;
CREATE INDEX orders_business_date ON orders(business_date);
CREATE INDEX orders_visit ON orders(visit_id);

CREATE TABLE order_lines (
  id                      TEXT PRIMARY KEY,
  order_id                TEXT NOT NULL REFERENCES orders(id),
  visit_id                TEXT NOT NULL REFERENCES visits(id),
  line_no                 INTEGER NOT NULL,
  item_id                 TEXT NOT NULL REFERENCES menu_items(id),
  variant_id              TEXT REFERENCES item_variants(id),
  category_id             TEXT NOT NULL REFERENCES menu_categories(id),
  -- snapshots: later menu edits never change what was ordered
  name_th                 TEXT,
  name_en                 TEXT,
  variant_name_th         TEXT,
  variant_name_en         TEXT,
  station                 TEXT NOT NULL CHECK (station IN ('kitchen','bar')),
  prep_kind               TEXT NOT NULL CHECK (prep_kind IN ('cook','prepare')),
  pricing_type            TEXT NOT NULL CHECK (pricing_type IN ('fixed','variant','measured_weight')),
  unit_price_minor        INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  modifiers_json          TEXT NOT NULL DEFAULT '[]',
  modifiers_minor         INTEGER NOT NULL DEFAULT 0 CHECK (modifiers_minor >= 0),
  quantity                INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  measured_grams          INTEGER CHECK (measured_grams IS NULL OR measured_grams > 0),
  rate_minor              INTEGER,
  rate_basis_grams        INTEGER,
  portion_quote_id        TEXT,
  line_total_minor        INTEGER NOT NULL CHECK (line_total_minor >= 0),
  note                    TEXT,
  allergy_flag            INTEGER NOT NULL DEFAULT 0 CHECK (allergy_flag IN (0,1)),
  status                  TEXT NOT NULL CHECK (status IN ('submitted','accepted','preparing','almost_done','ready','served','rejected','cancelled')),
  status_reason           TEXT,
  submitted_at            TEXT NOT NULL,
  accepted_at             TEXT,
  preparing_at            TEXT,
  almost_done_at          TEXT,
  ready_at                TEXT,
  served_at               TEXT,
  rejected_at             TEXT,
  cancelled_at            TEXT,
  prepared_before_entry   INTEGER NOT NULL DEFAULT 0 CHECK (prepared_before_entry IN (0,1)),
  is_fixture              INTEGER NOT NULL DEFAULT 0 CHECK (is_fixture IN (0,1)),
  updated_at              TEXT NOT NULL,
  version                 INTEGER NOT NULL DEFAULT 1,
  UNIQUE (order_id, line_no)
);
CREATE INDEX order_lines_order ON order_lines(order_id);
CREATE INDEX order_lines_visit_status ON order_lines(visit_id, status);
CREATE INDEX order_lines_item ON order_lines(item_id);
CREATE INDEX order_lines_status ON order_lines(status);

CREATE TABLE line_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  line_id     TEXT NOT NULL REFERENCES order_lines(id),
  order_id    TEXT NOT NULL REFERENCES orders(id),
  visit_id    TEXT NOT NULL REFERENCES visits(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('forward','reject','cancel','correction','recovery')),
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('staff','guest','system')),
  actor_id    TEXT,
  reason      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX line_events_line ON line_events(line_id);
CREATE INDEX line_events_order ON line_events(order_id);

-- ============================================================ service & feedback
CREATE TABLE service_requests (
  id                TEXT PRIMARY KEY,
  visit_id          TEXT NOT NULL REFERENCES visits(id),
  table_id          TEXT NOT NULL REFERENCES dining_tables(id),
  table_label       TEXT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('call_staff','water','utensils','bill','order_change','allergy_help')),
  note              TEXT,
  status            TEXT NOT NULL CHECK (status IN ('sent','acknowledged','completed','cancelled')),
  idempotency_key   TEXT NOT NULL,
  guest_session_id  TEXT REFERENCES guest_sessions(id),
  created_by_staff  TEXT REFERENCES staff_users(id),
  created_at        TEXT NOT NULL,
  business_date     TEXT NOT NULL,
  acknowledged_at   TEXT,
  acknowledged_by   TEXT,
  completed_at      TEXT,
  completed_by      TEXT,
  cancelled_at      TEXT,
  cancelled_by      TEXT,
  close_reason      TEXT,
  is_fixture        INTEGER NOT NULL DEFAULT 0 CHECK (is_fixture IN (0,1)),
  updated_at        TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  UNIQUE (visit_id, idempotency_key)
);
-- Repeated taps never create a second active request of the same type.
CREATE UNIQUE INDEX service_one_active_per_type ON service_requests(visit_id, type) WHERE status IN ('sent','acknowledged');
CREATE INDEX service_requests_status ON service_requests(status);

CREATE TABLE feedback (
  id                TEXT PRIMARY KEY,
  visit_id          TEXT NOT NULL REFERENCES visits(id),
  guest_session_id  TEXT NOT NULL REFERENCES guest_sessions(id),
  rating            INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  comment           TEXT,
  idempotency_key   TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  business_date     TEXT NOT NULL,
  UNIQUE (guest_session_id),
  UNIQUE (visit_id, idempotency_key)
);

-- ============================================================ measured-weight portions
CREATE TABLE portion_requests (
  id                TEXT PRIMARY KEY,
  visit_id          TEXT NOT NULL REFERENCES visits(id),
  table_id          TEXT NOT NULL REFERENCES dining_tables(id),
  item_id           TEXT NOT NULL REFERENCES menu_items(id),
  guest_session_id  TEXT REFERENCES guest_sessions(id),
  created_by_staff  TEXT REFERENCES staff_users(id),
  preferred_grams   INTEGER,
  note              TEXT,
  status            TEXT NOT NULL CHECK (status IN ('requested','quoted','confirmed','declined','cancelled','expired')),
  idempotency_key   TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  business_date     TEXT NOT NULL,
  resolved_at       TEXT,
  resolved_by       TEXT,
  resolution_reason TEXT,
  is_fixture        INTEGER NOT NULL DEFAULT 0 CHECK (is_fixture IN (0,1)),
  updated_at        TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  UNIQUE (visit_id, idempotency_key)
);
CREATE INDEX portion_requests_visit ON portion_requests(visit_id, status);

CREATE TABLE portion_quotes (
  id                          TEXT PRIMARY KEY,
  request_id                  TEXT NOT NULL REFERENCES portion_requests(id),
  revision                    INTEGER NOT NULL,
  grams                       INTEGER NOT NULL CHECK (grams > 0),
  rate_minor                  INTEGER NOT NULL CHECK (rate_minor >= 0),
  rate_basis_grams            INTEGER NOT NULL CHECK (rate_basis_grams > 0),
  amount_minor                INTEGER NOT NULL CHECK (amount_minor >= 0),
  choices_json                TEXT NOT NULL DEFAULT '[]',
  note                        TEXT,
  expires_at                  TEXT NOT NULL,
  status                      TEXT NOT NULL CHECK (status IN ('active','superseded','confirmed','expired','withdrawn')),
  created_by                  TEXT NOT NULL,
  created_at                  TEXT NOT NULL,
  confirmed_at                TEXT,
  confirmed_via               TEXT CHECK (confirmed_via IS NULL OR confirmed_via IN ('guest','in_person')),
  confirmed_guest_session_id  TEXT,
  confirmed_staff_id          TEXT,
  confirm_idempotency_key     TEXT UNIQUE,
  order_line_id               TEXT,
  UNIQUE (request_id, revision)
);
CREATE UNIQUE INDEX portion_quote_one_active ON portion_quotes(request_id) WHERE status = 'active';
CREATE UNIQUE INDEX portion_quote_one_confirmed ON portion_quotes(request_id) WHERE status = 'confirmed';

-- ============================================================ bills & payments
CREATE TABLE bills (
  id                   TEXT PRIMARY KEY,
  visit_id             TEXT NOT NULL UNIQUE REFERENCES visits(id),
  status               TEXT NOT NULL CHECK (status IN ('open','finalized','settled')),
  current_revision_id  TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  version              INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE bill_revisions (
  id                 TEXT PRIMARY KEY,
  bill_id            TEXT NOT NULL REFERENCES bills(id),
  visit_id           TEXT NOT NULL REFERENCES visits(id),
  revision_no        INTEGER NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('payable','superseded','settled')),
  lines_json         TEXT NOT NULL,        -- immutable BillLineDTO[] snapshot
  excluded_json      TEXT NOT NULL,
  adjustments_json   TEXT NOT NULL,
  subtotal_minor     INTEGER NOT NULL,
  adjustments_minor  INTEGER NOT NULL,
  charges_json       TEXT NOT NULL,
  total_minor        INTEGER NOT NULL CHECK (total_minor >= 0),
  finalized_at       TEXT NOT NULL,
  finalized_by       TEXT NOT NULL,
  business_date      TEXT NOT NULL,
  superseded_at      TEXT,
  superseded_by      TEXT,
  supersede_reason   TEXT,
  is_fixture         INTEGER NOT NULL DEFAULT 0 CHECK (is_fixture IN (0,1)),
  UNIQUE (bill_id, revision_no)
);
CREATE UNIQUE INDEX bill_one_payable ON bill_revisions(bill_id) WHERE status = 'payable';

CREATE TABLE bill_adjustments (
  id             TEXT PRIMARY KEY,
  visit_id       TEXT NOT NULL REFERENCES visits(id),
  kind           TEXT NOT NULL CHECK (kind IN ('discount','comp','correction')),
  amount_minor   INTEGER NOT NULL,         -- negative reduces the bill
  reason         TEXT NOT NULL,
  order_line_id  TEXT REFERENCES order_lines(id),
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  voided_at      TEXT,
  voided_by      TEXT,
  void_reason    TEXT
);
CREATE INDEX bill_adjustments_visit ON bill_adjustments(visit_id);

CREATE TABLE payments (
  id                  TEXT PRIMARY KEY,
  visit_id            TEXT NOT NULL REFERENCES visits(id),
  bill_revision_id    TEXT NOT NULL REFERENCES bill_revisions(id),
  kind                TEXT NOT NULL CHECK (kind IN ('settlement','reversal','refund_record')),
  method              TEXT NOT NULL,
  amount_minor        INTEGER NOT NULL CHECK (amount_minor >= 0),
  tendered_minor      INTEGER,
  change_minor        INTEGER,
  reference           TEXT,
  status              TEXT NOT NULL CHECK (status IN ('confirmed','reversed','failed','claimed')),
  idempotency_key     TEXT NOT NULL UNIQUE,
  reverses_payment_id TEXT REFERENCES payments(id),
  reason              TEXT,
  confirmed_by        TEXT NOT NULL,
  confirmed_at        TEXT NOT NULL,
  business_date       TEXT NOT NULL,
  is_fixture          INTEGER NOT NULL DEFAULT 0 CHECK (is_fixture IN (0,1))
);
-- One effective full settlement per payable bill revision (brief 23).
CREATE UNIQUE INDEX payments_one_settlement ON payments(bill_revision_id) WHERE kind = 'settlement' AND status = 'confirmed';
CREATE UNIQUE INDEX payments_one_reversal ON payments(reverses_payment_id) WHERE reverses_payment_id IS NOT NULL;
CREATE INDEX payments_visit ON payments(visit_id);
CREATE INDEX payments_date ON payments(business_date);

-- Optional online-payment adapter boundary (deferred in V1; no provider wired).
CREATE TABLE payment_attempts (
  id                TEXT PRIMARY KEY,
  bill_revision_id  TEXT NOT NULL REFERENCES bill_revisions(id),
  provider          TEXT NOT NULL,
  amount_minor      INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'THB',
  status            TEXT NOT NULL CHECK (status IN ('created','pending','succeeded','failed','needs_review')),
  provider_ref      TEXT UNIQUE,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE TABLE payment_callbacks (
  event_id      TEXT PRIMARY KEY,            -- provider event id, deduplicated
  attempt_id    TEXT REFERENCES payment_attempts(id),
  payload_hash  TEXT NOT NULL,
  verified      INTEGER NOT NULL CHECK (verified IN (0,1)),
  outcome       TEXT NOT NULL,
  received_at   TEXT NOT NULL
);

-- ============================================================ events (outbox) & audit
-- Written in the same transaction as the change they describe. SSE streams
-- read from here after commit, so a missed notification never loses data.
CREATE TABLE events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  topic        TEXT NOT NULL,
  audience     TEXT NOT NULL CHECK (audience IN ('staff','guest','all')),
  visit_id     TEXT,
  entity_type  TEXT,
  entity_id    TEXT,
  entity_version INTEGER,
  payload      TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);
CREATE INDEX events_visit ON events(visit_id, id);

CREATE TABLE audit_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('staff','guest','system')),
  actor_id     TEXT,
  actor_label  TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  visit_id     TEXT,
  reason       TEXT,
  before_json  TEXT,
  after_json   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX audit_entity ON audit_events(entity_type, entity_id);
CREATE INDEX audit_visit ON audit_events(visit_id);
CREATE INDEX audit_created ON audit_events(created_at);

-- ============================================================ analytics
CREATE TABLE analytics_sessions (
  id                TEXT PRIMARY KEY,        -- pseudonymous, per browser tab-group, never cross-visit
  kind              TEXT NOT NULL CHECK (kind IN ('public','dining')),
  visit_id          TEXT REFERENCES visits(id),
  guest_session_id  TEXT REFERENCES guest_sessions(id),
  locale            TEXT,
  opted_out         INTEGER NOT NULL DEFAULT 0 CHECK (opted_out IN (0,1)),
  started_at        TEXT NOT NULL,
  first_join_at     TEXT,
  last_event_at     TEXT NOT NULL,
  ended_at          TEXT,
  end_reason        TEXT,
  business_date     TEXT NOT NULL,
  is_fixture        INTEGER NOT NULL DEFAULT 0 CHECK (is_fixture IN (0,1))
);
CREATE INDEX analytics_sessions_visit ON analytics_sessions(visit_id);
CREATE INDEX analytics_sessions_date ON analytics_sessions(business_date);

CREATE TABLE analytics_events (
  event_id         TEXT PRIMARY KEY,         -- client-generated, deduplicated
  session_id       TEXT NOT NULL REFERENCES analytics_sessions(id),
  type             TEXT NOT NULL,
  visit_id         TEXT,
  route            TEXT,
  item_id          TEXT,
  category_id      TEXT,
  active_ms        INTEGER,
  depth            INTEGER,
  position         INTEGER,
  quantity_delta   INTEGER,
  quick_add        INTEGER,
  interaction_ref  TEXT,
  layout_version   TEXT,
  menu_version     TEXT,
  client_seq       INTEGER,
  client_elapsed_ms INTEGER,
  received_at      TEXT NOT NULL,
  business_date    TEXT NOT NULL,
  is_fixture       INTEGER NOT NULL DEFAULT 0 CHECK (is_fixture IN (0,1))
);
CREATE INDEX analytics_events_session ON analytics_events(session_id, client_seq);
CREATE INDEX analytics_events_date ON analytics_events(business_date, type);
CREATE INDEX analytics_events_item ON analytics_events(item_id, type);

-- Rebuildable daily aggregates (never a mutable year counter).
CREATE TABLE agg_item_daily (
  business_date     TEXT NOT NULL,
  item_id           TEXT NOT NULL,
  is_fixture        INTEGER NOT NULL DEFAULT 0,
  impressions       INTEGER NOT NULL DEFAULT 0,
  detail_opens      INTEGER NOT NULL DEFAULT 0,
  detail_active_ms  INTEGER NOT NULL DEFAULT 0,
  adds              INTEGER NOT NULL DEFAULT 0,
  add_qty           INTEGER NOT NULL DEFAULT 0,
  submitted_qty     INTEGER NOT NULL DEFAULT 0,
  net_qty           INTEGER NOT NULL DEFAULT 0,
  grams             INTEGER NOT NULL DEFAULT 0,
  orders            INTEGER NOT NULL DEFAULT 0,
  available_minutes INTEGER,
  PRIMARY KEY (business_date, item_id, is_fixture)
);

CREATE TABLE agg_state (
  name           TEXT PRIMARY KEY,
  built_through  TEXT,
  built_at       TEXT NOT NULL,
  data_version   INTEGER NOT NULL DEFAULT 0
);

-- Monotonic counter bumped by any change that can alter a historical report
-- (late cancellation, correction, recovered manual order, payment reversal).
CREATE TABLE report_data_versions (
  year       INTEGER PRIMARY KEY,
  version    INTEGER NOT NULL DEFAULT 0,
  changed_at TEXT NOT NULL
);

-- ============================================================ reports
CREATE TABLE report_jobs (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('annual_pdf','annual_csv')),
  year              INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('queued','generating','ready','failed')),
  label             TEXT NOT NULL CHECK (label IN ('provisional','final','revised')),
  revision          INTEGER NOT NULL,
  reason            TEXT,
  data_cutoff       TEXT,
  data_version      INTEGER,
  include_fixture   INTEGER NOT NULL DEFAULT 0 CHECK (include_fixture IN (0,1)),
  role_scope        TEXT NOT NULL,           -- role that requested; download rechecks permission
  financial         INTEGER NOT NULL DEFAULT 0 CHECK (financial IN (0,1)),
  requested_by      TEXT NOT NULL,
  requested_at      TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT,
  file_path         TEXT,
  file_sha256       TEXT,
  file_bytes        INTEGER,
  error             TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  supersedes_job_id TEXT REFERENCES report_jobs(id),
  UNIQUE (kind, year, revision, include_fixture)
);
CREATE INDEX report_jobs_year ON report_jobs(year, kind);
