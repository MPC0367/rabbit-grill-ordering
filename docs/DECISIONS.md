# Decision log

Routine, reversible decisions made while building. Each one records what was
decided and why, so an owner or developer can change it knowingly.
Append new entries at the end.

**D-01 · Location.** The ordering platform lives in `rabbit-grill/ordering/` with
its own git history, and the marketing repo ignores `ordering/`. The marketing
site is published by GitHub Pages from its repo root, so anything committed there
becomes public; the ordering system's source should not be.

**D-02 · Stack.** One Node 24 process: Hono, `node:sqlite`, zod, React 19 and Vite 8.
It is a simple deployable app with real transactions and no native database
driver, so it runs on a restaurant mini-PC or a small VPS. It is not serverless:
it needs one long-running process with a persistent disk. See ARCHITECTURE.md.

**D-03 · Realtime.** Server-Sent Events with polling fallback, fed by an `events`
outbox table written in the same transaction as each change. Clients treat
events as "refetch" signals. Commit comes before broadcast, and a missed event
can never hide a persisted order.

**D-04 · Guest access.** The permanent table QR carries an opaque 256-bit token.
Joining the current visit also needs the 4-digit visit PIN that staff show at
seating (default on, configurable). The guest cookie is HttpOnly, SameSite=Lax,
and valid only while that visit is open or billing and the membership is not
revoked. Known limitation: a person who has both the QR photo and the current
PIN can order remotely until staff revoke access or close the visit. The PIN
rotates per visit and is cleared at checkout.

**D-05 · Carts.** One private draft per browser per visit, stored locally under a
key namespaced by visit and guest session. Submitted rounds and the bill are
shared by the whole table. A draft is restored only after the visit is
revalidated and the lines are re-quoted.

**D-06 · Submission.** All-or-nothing, with a client idempotency key that is
UNIQUE per visit and a stored payload hash. A replay returns the original
order. The same key with a different payload returns `idempotency_mismatch`. After a
timeout the client first calls `GET /orders/attempts/:key`. Because the driver
is synchronous and the server is a single process, "not found" is definitive.

**D-07 · Money.** Integer satang throughout. The pricing policy is set out in
`shared/money.ts`:
- a variant price replaces the base price (never both);
- included modifier picks pay only their upgrade premium;
- no tax or service charge is assumed;
- charges are owner-configured, apply half-up on (subtotal + adjustments), and are
  snapshotted onto each visit at seating.

**D-08 · Measured-weight cuts.** Prime rib (490 THB per 100 g) is never a cart
line. The guest requests a portion, staff weigh it and quote it, and the guest
confirms. Only confirmation creates the order line (source `portion_quote`,
quantity 1, measured grams recorded).

**D-09 · Catalog truth.** Every record is imported from the restaurant's own menu
scans as `review_status = unverified`. Live mode orders only `verified` items.
Demo mode additionally allows items flagged `demo_orderable` (clean, unambiguous
prices) and shows a persistent "Demo data" banner. Ambiguous records such as the
lamb rack's two prices, the seasonal avocado menu and the beer promotion stay
unorderable even in demo mode.

**D-10 · Fixtures.** While `operating_mode = demo`, every new visit, order,
payment, request and analytics session is stamped `is_fixture = 1`. Reports
exclude fixtures unless the viewer explicitly ticks "include demo data", and
then the view is labelled. Switching to live mode never deletes history.

**D-11 · Business day.** Asia/Bangkok is UTC+7 all year, so a fixed offset is
exact. The business day starts at 00:00 (configurable). A business date is
stamped on each record when it is written, so changing the cutoff affects only
future records. Attribution:
- order rounds count by `submitted_at`;
- covers count by `seated_at`;
- checkout counts by `closed_at`;
- payments count by `confirmed_at`.

**D-12 · Billing.** Each dining visit has one bill.
- "Start checkout" moves the visit to `billing`, which blocks new orders.
- "Finalize" writes an immutable, payable revision.
- A confirmed settlement is unique per revision, enforced by a partial UNIQUE index.
- Reopening needs a manager and a reason. It supersedes the payable revision and
  keeps its history.

**D-13 · Checkout reset.** One idempotent transaction checks settlement and
fulfilment, then:
- closes open service requests with an attributable reason;
- revokes guest sessions and clears the PIN;
- closes the visit and emits `visit.closed`.

After that the table shows Available, because table state is derived from the
active visit. A manager exception with a reason can close despite blockers,
and the exception is recorded on the visit and in the audit log.

**D-14 · Dates on screen.** Gregorian years are shown in both languages. The
restaurant's own menu uses no Buddhist-era dates, and mixed calendars in
reports cause errors. This can be revisited with the owner.

**D-15 · Annual PDF.** The report is HTML printed by the installed Chromium-family
browser (Edge on this machine), driven by puppeteer-core with Noto Sans Thai
self-hosted. Thai shaping is exact and the report shares the app's design
tokens. A server without Chrome, Chromium or Edge reports `browser_unavailable`
rather than producing a broken PDF. Set `BROWSER_PATH` in that case.

**D-16 · Services.** Enabled by default: Call staff, Request the bill, Ask to
change an order and Ask about allergies. These exist because of how the
ordering model works. Water and utensils are off until the owner confirms they
are offered.

**D-17 · Hours.** The third-party listings say 11:00–21:00, closed Wednesdays.
These hours are stored but not enforced (`enforce_hours = false`,
`hours_verified = false`) until the restaurant confirms them.

**D-18 · Table QR cards and rotation (S2).** Each table has exactly one active
QR token; rotating it revokes the old one immediately (a scan answers
`qr_disabled`, distinct from `qr_invalid`) and the table tile carries
`qr.reprint_required` until the new card is fetched through
`GET /tables/qr-cards` or `GET /tables/:id/qr.svg?download=1` (a plain preview
does not count). We cannot know whether a card was physically printed, so the
flag means "downloaded since rotation". Guests already joined keep access:
their cookie belongs to the visit, not to the card.

**D-19 · Join PIN policy (S2).** Wrong PINs are counted on the visit; after
`join.max_failures` joining locks for `join.lockout_minutes` (even the right PIN
waits) and staff can unlock at once by rotating the PIN. A malformed PIN
(non-digits) is a typing error and is not counted. A visit opened while PINs
were switched off has no PIN; if PINs are switched back on, nobody can join it
until staff rotate a PIN. "Leave" revokes that browser's own membership
server-side; other guests are unaffected.

**D-20 · Table badges and transfers (S2).** Attention badges mean "someone must
act": `new_order` (a round with a submitted line), `ready_food`,
`service_request` (open non-bill request, sent or acknowledged),
`bill_requested` (visit still open with a bill request, or a bill request not
yet acknowledged) and `portion_request` (a cut waiting to be weighed). The
overview uses the same definitions, so its counts reconcile with the tiles.
Disabling a table that has an active visit is allowed: it blocks new orders
(`table_disabled`) but the party keeps its bill and order view. Transferring a
visit keeps every order's `table_label` snapshot, while open service and
portion requests move to the new table because they describe where staff must
go now.

**D-21 · Service requests (S4).** One active request per type per visit:
- A repeated tap, or another guest at the same table, gets the request that is
  already waiting (HTTP 200) rather than a second page to staff.
- A new request of that type is possible once the old one is completed or
  cancelled.
- `service_cooldown_seconds` is left to the guest screen, which disables the
  button for that long. The server enforces only the active-request rule and a
  per-guest rate limit.
- Staff names (acknowledged/completed/cancelled by) are shown only on staff
  screens.
- Completing a request straight from "sent" also stamps it as acknowledged,
  because it was the first staff response.
- At checkout, an open bill request is completed ("Bill handled at checkout").
  Every other open request is cancelled with the checkout's reason and the
  staff member's name. It is never marked completed.
- Feedback is one entry per guest session. It needs a rating or a comment, is
  never emitted or published, and is audited only as "has comment".

**D-22 · Measured-weight quotes (S4).** A quote stores its own snapshot: grams,
the item's rate at quoting time, the validated choices with their charged
prices, and `amount = round_half_up(grams × rate / basis) + charged choices`.
Choices are usually free, so the amount is usually just the weighed price.
- The order line keeps the measured amount as its unit price and the choice
  charges as `modifiers_minor`, so `line_total = amount`.
- Choices are validated with the same rules as a cart line.
- Re-quoting creates a new revision. The previous active quote becomes
  `superseded`, or `expired` if it had already lapsed.
- A lapsed quote is shown as expired immediately, even before the sweep runs.
  The request returns to "requested" for staff to weigh again. Confirming a
  lapsed quote records the expiry and then answers `quote_expired`.
- A request can be created only while the visit can take orders: a pause,
  billing or closed visit blocks it. Confirmation re-checks the same guards.
- Unconfirmed requests are cancelled at checkout. They never block it.
- The guest's request note goes onto the kitchen ticket with the confirmed
  line.

**D-23 · Order submission and tracking (S3).**
- The replay check runs before every ordering guard. A retried submission gets
  its order back even if ordering paused or billing started in the meantime.
  The payload hash covers item, variant, quantity, choices (in any order),
  the trimmed note and the allergy tick. Expected prices are not part of it.
- A new attempt checks pauses, billing and hours before pricing. A paused
  kitchen shows the pause message, not a cart review.
- `GET /api/guest/orders` lists rounds oldest first (`round_no`). The
  interface chooses how to present them.
- A round keeps the table it was ordered at (D-20). `StaffOrderDTO` also
  carries `current_table_label` and `current_table_id`, so staff know where to
  take the food after a transfer. The board's `table=` filter matches either.
- Guests see the reasons for rejections and cancellations. Correction and
  recovery notes are for staff only. Staff views name who took each step;
  guest views never name anyone.
- Staff order DTOs show prices to every role, because dish prices are public
  on the menu. The admin client hides amounts from roles without
  `orders.view_bill_values`.

**D-24 · Fulfilment rules (S3).**
- A transition request is all-or-nothing. If any line is stale, the reply is
  `stale_version` and `details.current` holds the affected `StaffOrderDTO[]`
  (for Finish order, the single order).
- A correction clears the times of later milestones and keeps the target's
  original time. `line_events` keeps the full history. A correction that
  reopens a served dish also un-finishes its order.
- Some changes move a line into or out of the bill: accepting, cancelling, or
  correcting back to Submitted. These answer `bill_changed` ("Reopen the bill
  first") while the visit has a payable revision or its current revision is
  settled. Forward kitchen work is never blocked by the bill.
- Changes on a closed visit answer `conflict` with `details.reason = visit_closed`.
  Reject, cancel and correction need a reason of at least 3 characters.
- Finish order:
  - Only a Ready dish can be resolved to Served.
  - A "cancel" resolution on a dish that was never accepted is recorded as a
    rejection, which needs `orders.accept`.
  - Every unserved dish needs an explicit resolution.
  - Finishing an order a second time answers `already_done`.
- The board's `status=` filter takes line states (comma-separated). The
  active scope covers visits that are not closed, where a round either has an
  unserved line or is unfinished and changed today. This scope is sorted
  oldest first. History covers one business date, newest first.
- Every exception, and any update to an earlier business date, calls
  `touchReportData`.

**D-25 · Manual recovery of paper orders (S3).**
- The paper reference is the attempt identity. Sending it again replays the
  order. The same reference with different details, or on another visit,
  answers `conflict`.
- `original_time` may be at most 5 minutes in the future and at most 24 hours
  in the past. It becomes the round's `submitted_at` and its business date.
- Sold-out items and items in a paused category can still be recorded,
  because the food was already ordered. Any other pricing problem needs
  review, for example unknown items, invalid choices, a price mismatch or a
  measured-weight cut (use the portion flow for those).
- `prepared` records the line as Ready and `served` records it as Served. Both
  set `prepared_before_entry = 1`, and the entry time becomes `ready_at` or
  `served_at`.
  - Acceptance and preparation times, and the order's `first_accepted_at`, stay
    empty rather than being invented.
  - Steps have the kind `recovery`.
  - The audit entry is `order.recovered`, with `flagged: true`.

**D-S1.1 · Catalog edits apply immediately (S1).** Nothing is staged.
- An edit to a published item is live at once. It moves the item's `version`
  past `published_version`, so the editor shows "unpublished changes" until
  someone re-publishes it (`status: published` on a published item clears the
  flag and re-checks the publish blockers).
- A sold-out toggle, a review or a status change keeps the two versions in
  step, so these actions never show as "unpublished changes".
- A change to an item's price, rate, rate basis, pricing type or any variant
  price does three things:
  - it writes `price_history`, using `variant_id` for variant prices;
  - it sets `review_status = needs_review`;
  - on a published item, it needs `price_change_reason`.
- In live mode, needs_review means the item cannot be ordered until the owner
  verifies it. A guest is never charged a price the owner has not approved.
- Changes to choice-group option prices do not reset review. They are
  audited, together with the affected item ids.
- Placement (reorder) changes only `sort` and `updated_at`, not `version`, so
  an editor that is already open is not made stale.

**D-S1.2 · Who verifies text (S1).**
- Only `menu.review` (the owner) can set `desc_verified`. When anyone else
  edits the description text, `desc_verified` is reset, so unreviewed prose
  never reaches guests.
- A name edit sets `translation_status`. It is `verified` when the editor has
  `menu.review`, and `needs_review` otherwise. A Thai name edit sets
  `name_th_source = staff_edit`, or `csv_import` for an import.
- An owner review to `verified` also marks the translation verified.

**D-S1.3 · Review-queue counters (S1).**
- `imported` counts every item record. The other counters leave out archived
  items.
- `missing_thai`: `name_th` is empty, or its source is not `menu_scan` and
  the translation is not verified.
- `live_ready`: published, verified and priced.
- `missing_description`: no verified description.
- `ambiguous_price`: an open `ambiguous_price` flag.
- `pending_portion_rules`: a measured-weight item that is not verified.
- `seasonal_disabled`: an item in a seasonal category that is not currently
  published and in season.

**D-S1.4 · What guests see (S1).**
- **Visibility.** The guest menu lists published items in published
  categories that are in season. Empty categories and empty groups are
  omitted. When `sold_out_display = hide`, sold-out items are omitted too.
- **Orderability.** Two cases count as `sold_out` so that no item looks
  orderable when submission would fail:
  - a variant item whose priced variants are all switched off;
  - an item whose required choice has fewer available options than it needs.
- **Live mode.** An unverified item shows no price (item, rate or variant),
  and its reason is `not_verified`.
- **Demo mode.** Prices are shown, and an unverified item carries the
  `demo_fixture` badge.
- **Descriptions and allergens.** Guests see a description only once it is
  verified, and allergen entries only when `allergen_status = verified`.
  Admin sees drafts of both.
- **Availability log.** A row is written only when an item's effective
  orderability actually changes. Publishing an item that still cannot be
  ordered writes no row. Consecutive duplicate states are skipped. Seasonal
  windows opening or closing by date write no rows, because no job runs, so
  reports must take the category dates into account.

**D-S1.5 · Menu CSV import (S1).**
- **Format.** One row per item, or one row per variant for variant-priced
  items. The item columns repeat on each variant row, or are left blank after
  the first. `key` is the identity.
- **Blank and absent cells.** When a column is absent, the current value is
  kept. When a column is present, a blank text or price cell clears the
  value, while a blank flag, number or station cell keeps it.
- **Prices.** Prices are baht with at most 2 decimals. A thousands separator
  is accepted ("1,590"). Conversion to satang is exact.
- **Classification.** Each row is create, update_draft, skip_published or
  skip_archived. Published and archived items are never changed by an
  import. The classification is checked again when the import is applied.
- **Applying.** Apply is refused while any row error remains; fix the file
  and preview it again. Apply creates or updates drafts with
  `review_status = unverified` and never publishes. It is idempotent: the
  batch status is claimed atomically.
- **Nameless drafts.** A row without a name becomes a draft with a note,
  because the editor also allows nameless drafts. Publishing then blocks the
  item with `missing_name`.
- **Variant availability.** The CSV has no variant availability column, so
  the existing availability of each variant is kept.
- **Formula-like text.** It is stored as plain text and flagged in the
  preview. Export prefixes it with an apostrophe, and import removes that
  apostrophe, so an export can be imported again unchanged.
- **Template.** The import template is the header row only, so no invented
  example dishes can be imported by mistake.

**D-S1.6 · Restaurant-wide ordering pause (S1).**
- A paused state needs a guest message in both languages.
- The reason is optional and recorded in the audit (`ordering.paused`,
  `ordering.resumed`, `ordering.updated`).
- `GET /api/staff/ordering` also returns `intake_full`.
- A category's `ordering_paused` can be changed with `ordering.pause` alone.
  Changing any other category field needs `menu.edit`.

## Metric dictionary (S6 insights)

Every figure below is computed from durable records. Reporting uses the stored
`business_date` columns (Asia/Bangkok, D-11) over inclusive date ranges,
which equals the half-open local interval [from 00:00, to+1 00:00). Fixtures
are excluded unless the request says `include_fixture=1`. Each DTO carries
`generated_at`, and all figures are computed live at that moment.

**D-S6-01 · Order rounds and their outcome.** A round is one row in `orders`,
counted on its submitted business date, including rounds rejected later.
Each round has exactly one outcome, based on its lines' current statuses:
- accepted: at least one chargeable line (`isChargeable`: accepted, preparing,
  almost done, ready or served);
- otherwise pending: at least one line still submitted;
- otherwise rejected: every line rejected;
- otherwise cancelled.
`breakdown.submitted` counts every round, so pending rounds are submitted
minus the other three. A late cancellation changes the day it was submitted,
and S3 calls `touchReportData` for it.

**D-S6-02 · People and quantity metrics.**
- Ordering visits: distinct `visit_id` among the period's rounds. This is
  recomputed for each bucket and again for the whole period, and never summed
  from days. A visit that orders before and after midnight is one visit in
  the week.
- Ordering devices: distinct `guest_session_id` among `guest`-source rounds.
  This approximates devices, not people. Staff, recovery and portion rounds
  are not devices.
- Recorded diners: SUM(`covers`) of visits by `seated_business_date`, with
  coverage `{with_covers, visits}`. Missing covers are never estimated, and
  rounds never multiply covers.
- Items: SUM(`quantity`) of chargeable lines. A measured-weight line is one
  serving; its grams are reported separately and never counted as units.

**D-S6-03 · Buckets.**
- Week: Monday to Sunday. Month: its days. Year: 12 monthly buckets keyed
  `YYYY-MM`, clipped to [Jan 1, Dec 31]. Custom: daily, up to 400 days.
  A week that crosses New Year stays seven days long.
- `future`: the bucket starts after today. Its value is null.
- `partial`: the bucket contains today.
- `missing`: the bucket ends before the first operating date, or nothing has
  operated yet. Its value is null. The first operating date is the earliest
  `seated_business_date` of a visit in scope, returned as
  `first_operating_date`.
- Every other bucket is `complete`, so a closed Wednesday is a real 0.

**D-S6-04 · Comparison with the previous period.**
- The previous period is the week before, the calendar month before, the year
  before, or for a custom range the same number of days just before it.
- If the current period contains today, only the same elapsed span counts.
  That means the same number of days in (for a year, the same month and day,
  with 29 Feb falling back to 28 Feb), up to the same local time. Rounds are
  cut on `submitted_at` and diners on `seated_at`. The note is
  `same_elapsed_span`.
- Other note codes:
  - `future_period`, `no_data_yet` and `no_prior_data`: the previous total is
    null and the label is `no_baseline`.
  - `prior_partial_coverage`: the previous period starts before the first
    operating date. `comparable` is false, the change is absolute only, and the
    label is `unequal_coverage`.
- A previous total of 0 gives `no_baseline` with an absolute change only.
  Otherwise `percent` is in percentage points with one decimal (-20 means
  -20 %). A percentage is never infinite.

**D-S6-05 · Today cards.**
- Orders today, visits ordering today, and diners today with coverage use
  the rules above for today's business date.
- Median acceptance time is the median of (`first_accepted_at`, or else the
  earliest line `accepted_at`) minus `submitted_at`, over today's rounds that
  waited to be accepted. That covers guest, staff-assisted and portion rounds.
  Recovered paper rounds have no acceptance time (D-25). The sample size is
  returned with it.
- Unresolved orders: rounds on visits that are not closed which still have a
  line that is submitted, accepted, preparing, almost done or ready.
- Percentiles: the median averages the two middle values; p90 uses the
  nearest rank. Durations are whole seconds or milliseconds.

**D-S6-06 · Menu ranking measures.**
- The default measure is `net`: SUM(quantity) of chargeable lines per item.
  Variants are totalled under their parent, with a per-variant breakdown.
- `submitted`: all lines, including rejected and cancelled ones.
- `grams`: measured grams of chargeable lines. Only measured-weight items are
  listed, so a gram is never ranked against a plate.
- `per_available_day`: net divided by available days, rounded to 2 decimals.
  Items without an availability log are listed last.
- `orders` and `visits` count distinct rounds and visits with a chargeable line
  of the item. `share` is the item's net quantity as a fraction (0..1) of the
  listed rows' net total, in the selected category or across the whole menu.
- History follows the stable `item_id`. The name, category and image come from
  the item as it is now, so a rename never splits a row. The category filter
  also uses the item's current category.
- Ranking is competition ranking (1, 2, 2, 4). Tied rows are listed by English
  name, then Thai name, then item key (`tie_policy`).
- Archived items with data in the period stay in the ranking, marked
  `archived`.

**D-S6-07 · Eligibility and availability.**
- An item with any line in the period is listed.
- An item with no line in the period is listed only when all of these hold:
  - the item and its category are published;
  - it can be ordered in principle: it has a price, and its verification fits
    the operating mode (D-09);
  - its category is seasonal but active during the period, or not seasonal;
  - it was available at some point in the period.
- Availability comes from `availability_log`. The last state before the
  period and the changes inside it give the available intervals. An item's
  state before its first log row is unknown, which counts as not available.
- Available days: business dates from the later of the period start and the
  first operating date, up to today, on which the item was available at any
  moment. `period_days` counts the same span.
- The availability label is `unknown` with no log, and `insufficient` below
  2 days or below 25 % of `period_days`. It is `full` when every day
  qualified, and `partial` otherwise.
- Quality flags:
  - `insufficient_availability` for insufficient availability, or unknown
    availability with no sales;
  - `never_ordered_despite_availability` for full or partial availability
    with no submitted lines at all;
  - otherwise null.
- The change label is `new` when the item's first available moment falls in
  the period (or, without a log, its first-ever round does). The label is
  `no_baseline` when the previous period is not comparable or its net was 0.
  Otherwise it is up, down or flat, against the same comparison window as
  D-S6-04 (returned as `previous`).
- Low numbers are described, never interpreted.

**D-S6-08 · Engagement ingestion (`POST /api/analytics/batch`).**
- The request is refused only for:
  - an invalid envelope (422);
  - a body over 128 KB (413);
  - the rate limit: 120 batches a minute per session and 600 per address (429).
- Each event is validated separately. An invalid event is counted as
  `rejected`, which covers:
  - schema errors;
  - an item or category that does not exist;
  - a missing item, category or depth for its event type;
  - a duration of 0 or less, or longer than the session's `elapsed_ms` plus
    5 s.
- `active_ms` above 120 s (and up to 24 h) is capped at 120 s. Anything longer
  is dropped.
- Free-text references (`interaction_ref`, layout and menu versions) are kept
  only if they match `[A-Za-z0-9_.:-]`. Notes, PINs and tokens have no field
  to arrive in.
- The guest cookie is optional and is never cleared here.
  - A valid cookie makes the session `dining` for that visit. The visit must
    still be open or billing, which is checked again inside the transaction.
  - A public session that later joins a table is upgraded to dining.
  - A dining session accepts events only from a device that still holds
    access to the same visit. A closed visit, lost access or a different visit
    rejects the whole batch.
  - A cookie for a closed visit never creates a session.
- `opted_out=true` marks the session opted out and stores nothing. The latest
  preference from the browser wins.
- If analytics is turned off in settings, nothing is stored.
- Events are stored with INSERT OR IGNORE on `event_id`; ignored rows count
  as `duplicates`.
- The server's receive time is the reporting time. An `active_time_chunk` is
  taken to end on receipt and is split with `splitByBusinessDay`. The second
  part is stored as `<event_id>~2`, with the next business date.
- `is_fixture` comes from the visit, or from `fixtureFlag()` for public
  sessions.
- Ingestion is telemetry, not a business state change, so it writes no audit
  entry and emits no event.

**D-S6-09 · Engagement reporting.**
- Measured sessions: distinct sessions with a stored event in the period,
  split into dining and public.
- Opted-out sessions: opted-out sessions that started in the period.
- `telemetry_since`: `analytics.instrumentation_started_at` as a business
  date, or else the first event's date.
- Note codes: `analytics_disabled`, `no_telemetry`,
  `telemetry_started_in_period` and `raw_events_retention`. The last one means
  the period starts before the raw-event retention horizon.
- Active menu time: per session, the sum of `active_time_chunk` with route
  `menu`. The median, p90 and sample are taken over sessions that have some.
- Active detail time: `item_detail_active_time` summed per session, item and
  `interaction_ref` (each event on its own when the reference is missing),
  giving one value per detail open.
- Category exposure: distinct sessions with a `category_view` of the
  category, divided by measured sessions. Published categories are listed even
  at 0.
- Item table:
  - impressions, detail opens and adds (`cart_add` events), with
    add rate = adds / impressions;
  - `submitted`: the quantity of all lines on rounds whose
    `orders.analytics_session_id` names a stored session that has not opted
    out.
- The funnel covers measured dining sessions only, because public browsers
  cannot submit. Its stages are sessions → with an impression → with a detail
  open → with an add → with a submitted round, plus quick-add sessions as a
  direct path that bypasses details.
- Attributed rounds are those described above. Every other round in the
  period is unattributed: staff-assisted, recovered, opted out, or without
  telemetry. Missing telemetry never reduces order counts.
- Scroll: sessions whose deepest `scroll_depth` reached 25, 50, 75 or 100.
  This is approximate, because depth depends on layout.
- Daily: sessions and active time per date up to today, or per month in the
  year view.
- Long dwell is not called "interest", and an unsubmitted cart is not called
  "abandonment".

**D-S6-10 · KPIs (`GET /stats/kpis`).**
- The range is from–to, or otherwise the period and anchor (default: this
  week).
- QR adoption: visits seated in the range that have a round other than manual
  recovery (eligible: the QR could be used), divided into those with a
  customer-origin round. A customer-origin round is a `guest` round, or a
  `portion_quote` round confirmed by a guest. Staff-only visits count in the
  denominator only.
- Guest order time: per visit, the time from the join of the guest session
  that placed the visit's first guest round to that round. It is attributed
  to that round's date, with the median, p90 and sample.
- Average order value: accepted chargeable line value divided by accepted
  rounds, rounded half-up to the satang. It uses current line statuses, so a
  later cancellation lowers it. Charges and bill adjustments are excluded.
- Average table value: the current non-superseded revision totals (payable or
  settled), by the revision's finalize date, divided by those visits.
- Operational errors: distinct rounds with a rejected line or a `correction`
  line event, divided by submitted rounds. Reasons come from
  `status_reason` or the event reason, or `unspecified`.
  `operational_error_kinds` splits them into rejected and corrected.
- Payment exceptions (`reports.financial` only) count current revisions that
  have no confirmed settlement once the visit is closed or the finalize date
  has passed. The value is the bill total. A settlement that differs from the
  total also counts, valued at the difference. This compares recorded
  payments, not bank records. Without the permission the figures are 0 and
  `financial_visible` is false.
- Staff response:
  - acceptance: D-S6-05 over the range;
  - acknowledgement: `acknowledged_at` minus `created_at`. Staff completion
    stamps `acknowledged_at` (D-21). A bill request completed by checkout
    has no response and is excluded.
- Totals are never called revenue:
  - submitted: all lines;
  - accepted: chargeable lines;
  - finalized: current revisions;
  - paid: confirmed settlements by `payments.business_date`, financial only.
- Cancellations: cancelled lines by reason, with count and line value.
- Hourly: rounds by Bangkok clock hour of `submitted_at` (the paper time for
  recovered rounds), listed from the business-day cutoff.
- Open bills (now): active visits with chargeable lines and no settled bill.
- Service requests by type: enabled types are always listed.

**D-S6-11 · Aggregates.** `refreshAggregates(from?, to?)` rebuilds
`agg_item_daily` one date at a time, each date in its own transaction
(delete, then insert). A crash leaves every date whole, and re-running is
safe.
- Each row holds net, submitted, grams and orders (from lines), impressions,
  detail opens, detail active time, adds and added quantity (from events),
  and `available_minutes` for every logged item from its first log date.
- `agg_state('agg_item_daily')` records `built_through` (which never moves
  backwards) and `built_at`.
- With no arguments the rebuild resumes from `built_through`, or from the
  earliest data, through today. It must not run inside a transaction.
- The dashboards read raw tables. The aggregates exist for jobs and reports,
  and to keep item history once raw events are purged.

**D-S6-12 · CSV exports (`GET /stats/export.csv`).** Exports need
`stats.view` and use the same query parameters as the screens. Files use
`toCsv()`: UTF-8 with a BOM, and formula-looking text is prefixed with an
apostrophe.
- `view=orders`:
  - by day: every metric per bucket, plus a period-total row that carries only
    the selected metric, because distinct totals cannot be summed across
    columns;
  - `rows=order`: one row per round, with Bangkok times written with `+07:00`.
    The value column appears only with `billing.view`, and manual paper
    references are not exported.
- `view=menu`: the ranking rows, including the variant breakdown.
- `view=engagement` needs `stats.engagement`. It exports summary rows with
  denominators. `raw=1` also needs `reports.export_raw` and exports retained
  events with pseudonymous session ids and no visit ids.
- File names carry the view, the range, and `-incl-demo` when fixtures are
  included.

**D-C3-01 · Engagement sessions in the browser (`client/src/lib/tracker.ts`).**
- One pseudonymous session (`ans_…`, random) per browser per context. The
  public menu is one context and each dining visit is another. Tabs of the
  same browser in the same context share the session, and so does a reload.
- A new session starts after 30 minutes without activity, when the visit
  changes, after the visit closes (`endVisit`) and after opting back in.
  Joining a table always starts a new session. This client therefore never
  uses the public-to-dining upgrade in D-S6-08, and pre-join browsing stays
  public.
- The guest cookie goes only with batches for the session of the visit the tab
  is in. Every other session is sent with `credentials: 'omit'`, so no
  session is ever linked to a visit it did not belong to.

**D-C3-02 · What counts as active time.**
- Counting starts at the first tap, key, wheel or touch, never at page open.
  Scrolling only extends attention the guest already showed, so scroll
  restoration and automatic jumps never start it.
- It stops at the idle threshold (measured from the last interaction), and on
  hide, blur, unload, visit close and opt-out. Only the most recently used
  tab of a browser counts (BroadcastChannel plus a localStorage lease).
- A gap of more than 3 s between ticks (a frozen page or a sleeping phone)
  adds nothing, and a new interaction is needed afterwards.
- Chunks are at most one heartbeat long, never straddle Bangkok midnight, and
  pieces under 250 ms are dropped.
- `interaction_ref` is the interval id (`ivl_…`) on `active_time_chunk`. On
  `item_detail_open` and `item_detail_active_time` it is the opening's
  reference (`dop_…`), so one dwell sums to one value per opening (D-S6-09).
- `layout_version` is `<app layout>:<orientation><width class>`, for example
  `menu-v1:ps`. It uses `:` because the server keeps only `[A-Za-z0-9_.:-]`.

**D-C3-03 · Delivery and opt-out.**
- Batches go by `fetch` with `keepalive: true`, which keeps `X-RG-Client`.
  Each batch holds one session, at most 100 events and at most 30 KB, so two
  batches fit the 64 KB keepalive budget at page hide.
- Batches are sent every 10 s, at 20 events, and at hide or unload. Failures
  are retried with the same event ids and backoff (10 s doubling, 5 tries).
  Status 400, 401, 403 and 422 are dropped, 413 halves the batch size, and
  429 waits for `retry_after_seconds`.
- A per-tab localStorage backup lets the next page resend unsent events.
- The envelope also carries `sent_elapsed_ms`, which the schema strips today.
  With it the server could date each event as
  `received_at - (sent_elapsed_ms - elapsed_ms)`, even for retried batches.
- Opting out (`rg.analytics.optout`, per browser) drops unsent events and
  local tracker data. It then sends one batch with `opted_out: true` that
  contains only `session_end`.
- When the restaurant turns analytics off, unsent events are discarded.

**D-S8-01 · Development fixtures (`server/db/seed.ts`, `server/db/seed/*`).**
Seeding runs on first start when `SEED_DEMO=1`, or through `npm run seed`. It
never runs with `NODE_ENV=production`, and it does nothing once `menu_groups`
has rows. The catalog, tables and staff go in one transaction, the history one
calendar month per transaction, and the live dining room in a last one. If a
run is interrupted, `npm run db:reset` starts over. For the length of the run
the connection uses a 128 MB page cache and `synchronous=OFF`, and both
settings are restored afterwards. A deterministic PRNG, seeded per day, makes
every reset produce the same history. Secrets do not come from that PRNG:
QR tokens, PINs, password salts and the guest token hashes of live visits use
Web Crypto. Every row that has an `is_fixture` column is set to 1. Fixture
feedback is written only when `feedback.is_fixture` exists.

**D-S8-02 · Fixture catalog.** `data-src/catalog.json` is imported as is.
- An item is published only if its category is. `review_status` is
  `needs_review` for the flags `ambiguous_price`, `needs_owner_explanation`,
  `seasonal_unconfirmed`, `volume_in_wrong_field`, `unspecified_variant` and
  `duplicate_name`, and `unverified` otherwise.
- An image is kept only when `public/media/manifest.json` has it. Otherwise
  the item gets a `missing_image` flag.
- The one sourced modifier is `coffee-beans`, the "+30 THB" special blend on
  bev-01. It is attached to the 12 espresso drinks only, not to "Ice Coffee",
  and each of those drinks carries a `demo_modifier_attachment` flag for the
  owner.
- The first `availability_log` row per item is stamped at the start of the
  history, so rankings see the dishes as available for the whole period.
  Only demo-orderable published items start available. Biscoff Latte and
  Black Orange start unavailable and "arrive" on 2026-03-02, so rankings can
  show New.

**D-S8-03 · Fixture history shape (demo parameters, not restaurant facts).**
- Dates run from 2025-01-01 to yesterday, Bangkok time. Wednesdays are
  closed, so they are real zeros.
- About 14 visits a day, from 5 in a rainy quiet week to 36 on cool-season
  Saturdays, seated 11:00-20:30 at 12 tables. A party that finds every table
  taken is dropped, so tables never overlap.
- 80 % of visits have covers. 15 % are staff-only, and the rest have 1-3
  devices. Rounds are about 70 % guest, 25 % staff and 5 % Prime Rib portion
  confirmations.
- About 2 % of lines are rejected: duplicate double-taps, "Sold out tonight"
  (which also logs the sell-out and a restock the next morning) and kitchen
  reasons. About 1.5 % are cancelled after acceptance, and "changed their
  mind" comes with an `order_change` request.
- Wagyu is sold out 2025-07-07 to 07-14. River prawns sell out on nine
  evenings.
- Portion requests: about 15 % are declined (quote `withdrawn`, "Declined by
  guest"), some are re-quoted (`superseded`) or `expired`, and 15 % are
  confirmed in person.
- Bills: about 2.5 % have a superseded first revision, either a comp or one
  more round after printing. About 0.5 % close unpaid with a manager
  exception. Every other bill is settled in cash, with tendered and change
  amounts. Half of the bill requests are closed by checkout ("Bill handled at
  checkout").
- Analytics begins on 2025-06-01, and
  `analytics.instrumentation_started_at` is set to match. About 65 % of
  guest-joined visits are measured, with one session per device starting at
  join and 3 % opted out with no events. Public browse-only sessions add 1-4
  a day. Chunks are 10-15 s with an `ivl_` reference, detail dwell uses a
  `dop_` reference, and chunk route is `menu` (or `track` after ordering).
- Routine audit rows are written for a 3 % sample of visits. Exceptions are
  always audited: rejections, cancellations, reopen/comp, unpaid closes and
  sell-outs.
- The result is about 7.8k visits, 12.7k rounds and 143k analytics events,
  taking about 15 s and about 136 MB, including the S6 aggregates.

**D-S8-04 · Live fixtures.** On first start, six tables are dining:
- 01 has a new round that has not been accepted;
- 03 has mains on the grill, including one with the allergy note "แพ้ถั่ว -
  allergic to peanuts", an active Prime Rib quote and a call-staff request;
- 04 has an almost-done line, ready lines and an acknowledged change request;
- 06 has a partially served round;
- 07 has an accepted round and a Prime Rib waiting to be weighed, with no
  covers recorded;
- 09 has asked for the bill.

Table 10 is checking out with a finalized, unpaid bill, table 12 is disabled,
and 02, 05, 08 and 11 are free. Their PINs are printed once to the console,
with the demo staff accounts (`demo-<role>` / `rabbit-<role>-demo`) under a
DEVELOPMENT ONLY banner. These are fixtures, not credentials.

**D-S7-01 · Annual report jobs.** Report files are rows in `report_jobs`. A job
moves queued → generating → ready or failed.
- **Labels.** The current (or a future) year is always `provisional`. A
  completed year gets `final` until a ready final exists, then `revised`, which
  needs a reason. Revisions are numbered per kind, year and demo scope.
- **Nothing is overwritten.** A revision is a new job with a new file.
  `supersedes_job_id` points to the ready report it follows.
- **Scope.** `role_scope`, `financial` (reports.financial) and `raw_events`
  (reports.export_raw, data export only) are stored on the job. Downloads
  check them again each time. Files live in `REPORTS_DIR/<year>/<job id>` and
  are served only through the download route.
- **Duplicates.** A request identical in scope to a job that is still queued
  or generating returns that job.
- **Failures.** A failed attempt is queued again after 30 s × attempts. After
  3 attempts the job stays failed until someone presses Retry, which resets
  the attempts. "No browser installed" fails immediately.
- **Restarts.** On start, jobs left `generating` are queued again.
- **Staleness.** `needs_revision` compares the year's `report_data_versions`
  with the latest ready report. Each job also returns its own `data_version`,
  so a stale companion export can be shown.

**D-S7-02 · New Year.** The runner checks at start and every 10 minutes. Each
completed year with real (non-demo) orders or visits, and no final or revised
job of that kind (in any state), gets a `final` annual PDF and a `final` data
export. They are requested by `system` with full scope, so the owner can open
them. Managers can generate their own non-financial copy. Nothing is deleted
or reset.

**D-S7-03 · Consistent, non-blocking generation.**
- **One snapshot.** Each report opens its own read-only SQLite connection and
  holds one read transaction. In WAL mode every page reconciles while service
  continues.
- **Small pieces.** Reads go one business day or one month at a time and
  yield to the event loop about every 8 ms.
- **Rendering.** The PDF is laid out and printed by the browser process. The
  shared launcher's synchronous profile cleanup is replaced by an async one,
  and the puppeteer module is preloaded 3 s after start.
- **Measured.** API p99 during a 104-page report is the same as at idle.

**D-S7-04 · Report metrics follow the dashboards.** The snapshot uses the S6
definitions (D-S6-01 to D-S6-10): outcomes, devices (guest rounds only), the
first operating day, availability labels and eligibility, tie order,
engagement denominators and payment exceptions. A check script confirmed
identical totals, month buckets, ranking rows, engagement rows and KPI values
for a synthetic 2025 and 2026. The yearly report clips Monday–Sunday weeks at
the year boundary, and says so on the page.

**D-S7-05 · Annual PDF form.**
- **Wordmark.** No approved logo file exists, so the cover uses a typographic
  "RABBIT GRILL" in Cormorant Garamond.
- **Fonts.** Noto Sans Thai (Thai, Latin and Latin Extended subsets), Oswald
  and Cormorant Garamond are embedded as base64.
- **Pages.** A4 portrait, with named landscape pages for the full ranking and
  the appendices. Table headers repeat on every page.
- **Tagging.** The PDF is tagged, with bookmarks, while the appendices hold no
  more than 2,500 rows. Above that it is printed untagged and says so: the
  structure tree costs about 8 KB per row, and a 1,900-row year is already
  13 MB (3 MB untagged).
- **Collapsed days.** Runs of future or before-records days in the daily table
  are grouped into one labelled line.
- **Not printed.** Raw engagement events and individual service requests are
  summarised, with their exact scope stated on the page, and are complete in
  the data export.

**D-S7-06 · Data export privacy.**
- Guest notes become `has_note` / `allergy_flag`.
- Payment references, PINs, tokens and passwords are never selected.
- Guest and analytics session ids become per-export pseudonyms
  (sha256 of export id + id).
- Price and money columns, `payments.csv` and `bills.csv` appear only with
  financial scope.
- `README.txt` lists the scope, the filters, the time zone and every
  exclusion.

**D-S7-07 · Team and settings rules.**
- **Owners.** There is always at least one active owner (`last_owner`).
- **Sessions.** A role change, deactivation or password reset revokes that
  account's sessions. Changing your own password needs the current one and
  keeps the session you are using.
- **Passwords.** A password may not contain the username or display name.
- **Settings patches.** A patch may be partial for object-valued keys. The
  merged value is validated in full. Arrays and `role_permissions` are
  replaced whole. `checkout.after_checkout = needs_clearing` is refused until
  it is implemented.
- **Hours.** `ordering.enforce_hours` needs `hours_verified`.
- **Analytics start.** `analytics.instrumentation_started_at` is set by the
  server the first time analytics is enabled. It is never taken from input.

## Integration pass

**D-INT-01 · Login rate limits count failures only.**
The per-address (10 / 5 min) and per-username (8 / 5 min) login budgets are
used up only by failed sign-ins (unknown user, inactive account, wrong
password). Several staff signing in at one shared tablet, or behind one proxy
address, no longer lock each other out; brute-force protection is unchanged.
`server/lib/ratelimit.ts` gained `assertUnderLimit()` (check without recording).

**D-INT-02 · Image alt text up to 160 characters.**
The audited photo descriptions in `data-src/catalog.json` run to about 145
characters. The admin item schema and the CSV importer share
`IMAGE_ALT_MAX = 160` (`shared/schemas.ts`), so an exported menu re-imports
cleanly and those items stay editable. 125 remains the writing guideline.

**D-INT-03 · The tracker's final flush after checkout is accepted.**
The guest tracker (C3) sends its last active-time chunk and `session_end` only
after it learns the visit closed, when its cookie no longer resolves (or was
cleared by a 410). Ingestion (S6) now accepts events for an EXISTING dining
session for 15 minutes after its visit closed, without a cookie; the
unguessable session id is the proof. No session is created or re-linked, and a
cookie for a different visit is still refused.

**D-INT-04 · The settings cache never keeps a rolled-back value.**
`putSetting()` inside a transaction marks the cache dirty: until that
transaction ends, `getSettings()` reads the database without caching, and the
first read afterwards reloads. A pause, settings patch or seed that fails
part-way can no longer leave its uncommitted value in memory.

**D-INT-05 · Fixture audit rows use the live action names.**
The seed writes `order.lines_rejected`, `order.lines_cancelled`,
`visit.billing_start`, `bill.finalize`, `bill.reopen`, `bill.adjust`,
`payment.confirm`, `visit.checkout`, `visit.close_exception`, `portion.quote`,
`portion.confirm_in_person` and `menu.item_restocked`, exactly as the running
server does, so audit filters treat demo and real rows alike.

**D-INT-06 · The report browser dies with the server.**
`scripts/browser.ts` launches Edge/Chrome with `pipe: true`: if the Node
process is killed mid-report the pipes close and the browser exits instead of
lingering, and a failed launch removes its throwaway profile.

**D-T3-01 · A settled zero bill is not a payment exception.**
Checkout records a finalized zero-total revision as settled without a payment
row (nothing is owed), and the payments screen never lists it. The KPI
"payment exceptions" (D-S6-10) and the annual report snapshot (D-S7-04) now
agree: a current revision with no confirmed settlement counts only when its
total is above zero. Found by the billing integration tests.

**D-C4a-01 · Staff alert sounds are per device, off by default, and never replay history.**
The chime is synthesised with Web Audio (`client/src/admin/shell/sound.ts`), so
there are no audio files. The on/off preference lives in this device's
storage, never in the account, and starts off: turning it on is the explicit
enable control (brief 19). Audio unlocks on that click, on Test, or on the
first tap or key press after a reload. `useOrderAlerts()` chimes for
`order.created`, and for `service.updated`/`portion.updated` creations
(entity version 1). It skips three kinds of event: those at or below the
event id at first connect, those older than the latest (re)connect (a
Last-Event-ID replay), and those more than 4 s old that arrive while the
stream reports reconnecting or offline (the polling fallback's catch-up
batch). A burst chimes once (2 s gap). The persistent cue is the Orders badge
(unaccepted rounds, plus open requests for roles with `service.handle`),
which is also shown in the tab title.

**D-C4a-02 · Navigation versus reachable pages.**
The five destinations show only what a role can use: kitchen gets Orders and
Menu, floor gets Orders and Tables, and cashier gets Orders, Tables and More.
`/admin/more` (its account section) and `/admin/team?self=1` (your own
password) open for every signed-in role, and the account menu links to the
password page. A page that needs a permission the role lacks shows a
permission-denied panel. Unknown paths show not-found. Sign-in returns to
the intended page only when the role can open it; otherwise it uses the
person's saved start page on this device ("Start on this page when I sign
in") or `me.landing`. Lock screen signs out and keeps the page for the next
sign-in. Sign out starts fresh.

**D-C4a-03 · Pausing guest ordering.**
Pause… always opens a dialog. It asks for the guest message in both languages
(prefilled from the current setting, required by the server), an optional
honest estimated wait (not shown, 15, 30, 45 or 60 min), and an optional
audit reason. Resume… offers to clear the estimated wait. Every staff page
shows the paused state in an ink banner. For roles with `audit.view`, the
banner also says who paused and when (from the latest `ordering.paused`
audit row).

**D-C1b-01 · The device draft follows the visit.**
Drafts live under `rg.cart.<visit>.<guest>`. `bindCart(visit, guest)` loads
that draft and deletes every draft and pending submission of any other visit;
`bindCart(null, null)` only unbinds (a session that is still loading must not
wipe a draft). An ended visit (`mode = 'ended'`, or a 410 from quote/submit)
deletes its own draft through `endCartVisit()`. Drafts older than 12 hours are
never restored. Lines added without a known price (e.g. a quick add that did
not pass the dish) take the first quoted price as the price the guest saw, so
a later change still surfaces as `price_changed`.

**D-C1b-02 · One unresolved submission at a time, and its lines are frozen.**
Place order re-quotes, then writes the attempt (key, exact payload, line uids)
to `rg.submit.<visit>.<guest>` before the request leaves. Network errors,
timeouts, 5xx and a reload mid-send all lead to the attempt lookup (backoff
0.8 s up to 15 s, immediately on reconnect or "Check again now"); no new
submission is offered meanwhile. While unresolved, the submitted lines cannot
be edited or merged into (new dishes can still be added as new lines).
`not_found` offers "Try sending again", which re-sends the stored payload with
the same key; "Edit the order instead" discards the attempt (safe, nothing was
created) and the next send uses a new key. Any definitive refusal (409, 423,
422, 429, 401) clears the attempt and keeps the draft; `cart_changed` maps
`details.quote` back to the sent lines and returns the guest to the list.
Only a server response (201/200 or a `created` lookup) removes lines, and
only the lines that were sent.

**D-C1b-03 · Blocked ordering is explained once.**
The guest shell banner owns the pause, hours, table-pause, intake and billing
messages. The order page and review step disable Send / Place order and repeat
only the short title plus "your draft is kept" beside the button. Adding to the
draft stays possible while ordering is paused (the draft waits on the device,
nothing is queued for automatic sending); the dish sheet refuses to add while
the table is checking out.

**D-C7a-01 · Insights screens (`client/src/admin/insights/*`).**
- Every view is a URL: `period`, `anchor`, `from`/`to`, `metric`, `category`,
  `direction`, `measure`, `include_fixture`, plus `day`, `q` and `top`.
  Changes to what is counted push a history entry; a chart selection, the
  search text and Top 5/10/All replace the current one.
- `include_fixture` defaults to 1 when `operating_mode` is `demo` (the seeded
  history is all fixtures) and to 0 in live mode. The page says which in a
  banner, and the switch is labelled "Include demo data".
- "All food" and "All drinks" are client-side scopes over the whole-menu
  ranking. Rows keep the server's order and tie rule; competition ranks and
  shares are recomputed over the group. The CSV for these scopes is the whole
  menu and is labelled so.
- The prior tick on each bar is the full value of the same day (week), date
  (month) or month (year) of the previous period. Today's bar has no tick,
  because the headline already compares the same elapsed span.
- While a period contains today, comparisons are described as "up to HH:MM",
  whatever the note code, because the server always cuts the previous total
  at the same elapsed point (D-S6-04).
- The day drill-down joins `GET /stats/orders/day` with
  `GET /orders?scope=history&date=` for round numbers, staff names and
  rejected/cancelled counts.

**D-C4b-01 · Orders board placement and actions (`client/src/admin/orders/*`).**
- A round sits in the column of its least-advanced active, unserved line. Its
  one counted action changes only the lines at that stage ("Mark ready · 2"
  leaves an almost-done dish alone); other dishes move from the ⋯ panel.
- Rounds whose dishes are all served (or resolved) but not finished show as
  compact "Served, not finished" rows under the Ready column, with Finish
  order. Fully rejected or cancelled rounds appear only behind the toolbar's
  "Show rejected · cancelled", in their own group under the board.
- With a Kitchen or Bar filter, a ticket shows that station's dishes and a
  "+N at the bar / in the kitchen" flag for the rest; the filter is stored
  per device (`rg.orders.station`).
- "Longer than usual" uses a fixed 20 minutes: no owner setting exists yet.
  The age filter is the Sort option "Only waiting over 20 min".
- Board history is `/admin/orders?view=history&date=` (read-only tickets; the
  ⋯ panel still allows permitted corrections). The shell has no History tab,
  so it is linked from the Ready column and the board foot.
- Confirmations (reject, cancel, move back, Finish order) replace the ⋯
  panel's body instead of stacking a second dialog (DESIGN §10.7). Finish
  order lists every unserved dish and needs an explicit choice for each; the
  server's `unresolved_orders` list replaces the device's when it differs.
- A role without the step sees a disabled primary that states why ("Your role
  can't mark dishes served"); it stays focusable.

**D-C4b-02 · Assisted ordering and paper orders.**
- One drawer (`AssistOrderPanel`) for both modes. Drafts and the attempt key
  are stored per visit and mode (`rg.orders.draft.<mode>.<visit>`). After an
  unanswered send the lines lock and the only ways on are "Send again" (same
  key, same lines, same expected subtotal) or "Start over" (the key is
  dropped; staff are told to check the board first).
- Weighed cuts are never cart lines: the panel sends a weighing request to
  the Requests tab instead. Paper orders cannot include them.
- In recovery mode sold-out and paused dishes stay addable (the server
  accepts them for paper orders) and their quote issues show as information.

**D-C4b-03 · Live refresh workaround.** `lib/live.tsx` re-creates
`subscribe` on every event, so `useResource`'s topic effect re-runs and its
cleanup cancels the pending debounced refetch: changes from another device
never refetch. The Orders screens add `useLiveRefresh()` (orders/liveRefresh.ts),
a debounce that is only cleared on unmount. The foundation fix is to keep
`subscribe`/`onResync` stable (useCallback) in LiveProvider.

## Client integration pass

**D-CI-01 · Live updates: stable subscriptions, parked streams.**
`LiveProvider` now keeps `subscribe` and `onResync` stable (useCallback), so
`useResource(path, { topics })` refetches on every matching event, not only
after a reconnect (the bug D-C4b-03 and the C2, C4a, C5 and C7a reports
describe). The Orders screens dropped their duplicate `useLiveRefresh` calls,
which had turned every event into two identical GETs; the other streams'
wrappers call `useResource` without topics and stay as they are. The stream is
also closed on `pagehide` and reopened on a back/forward-cache `pageshow`:
browsers allow six HTTP/1.1 connections per host, and documents parked in the
cache kept their EventSource open, so after six full navigations every request
(Resume guest ordering, for one) hung.

**D-CI-02 · The guest entry never carries staff code or copy.**
The entry bundle registers only `common` and `errors`. `i18n/guest-bundle.ts`
(imported by GuestApp) adds guest, cart and visit; `i18n/admin-bundle.ts`
(fetched beside AdminApp, and by the dev gallery) adds the staff areas and the
guest ones. The staff kit is re-exported by the ui barrel, so
`vite.config.ts` marks `client/src/ui/admin/*` side-effect-free: guest chunks
that use none of it no longer load it. zod reaches the guest only when the
weighed-cut sheet's bounds load (a dynamic import; the server validates
anyway). The `/ui-kit` gallery is left out of production builds.
`node scripts/i18n-check.ts` checks every `t('…')` key in both languages,
placeholder parity and that guest code uses only guest-loaded keys.

**D-CI-03 · Language switch inside guest sheets.**
A modal sheet makes the page (and its ไทย/EN box) inert, yet brief 08 asks
that switching language keeps the open sheet. `Sheet` takes `langSwitch`: a
44px framed button with the one language you can switch to, beside Close, on
the dish, service and weighed-cut sheets. Focus still opens on Close. The
masthead box collapses to the same single button below 360px (it used to hide
the pressed half, which left the only visible button out of the tab order).

**D-CI-04 · Shell routes.** Orders gains a routed History subtab
(`/admin/orders?view=history`, as in the approved board mock). The menu review
queue opens for every menu manager (read-only unless `menu.review`), as C6
asked.
