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

## Review fixes: guest interface

**D-G-01 · Feedback outlives checkout on the device.**
- The bill page offers the feedback form from the moment the bill is asked
  for (stages requested, billing, final and paid), not only after payment:
  a cashier who records payment and completes checkout in one go used to
  leave no window at all.
- What the guest types is kept per visit in this tab's sessionStorage
  (`rg.feedback.<visit>`, 3 h, outside the `rg.c2.` prefix that the ended
  page clears), so checkout swapping the bill page for the ended page no
  longer throws it away.
- The ended page asks `GET /api/guest/feedback/eligibility`
  (`{ eligible, submitted, until }`; server side, see the fix report) and
  shows the form, with the kept draft, while the API still accepts it. A
  server without that endpoint (404) falls back to the old session probe.
  When feedback can no longer be sent and a draft existed, the page says so
  ("feedback.closedDraft") instead of dropping it silently.

**D-G-02 · Analytics notice and opt-out on guest screens (brief 39).**
A quiet block at the end of the menu and at the foot of the service sheet,
shown only while `config.analytics.enabled`: what is measured, what is never
collected, and a switch "Measure menu use on this device · On/Off" wired to
`useAnalyticsOptOut()` (D-C3-03 mechanics: one `session_end` marked
`opted_out`, nothing more). Never a modal or a banner; ordering is the same
either way. This makes the owner-side copy ("guests can turn measurement off
on their phone") true.

**D-G-03 · Join PIN length follows the visit.**
The join screen reads `QrResolveDTO.pin_digits` (the length of the visit's
actual code, 4 to 8) for the boxes, the auto-submit and the copy. Until the
server sends it, the field accepts 4 to 8 digits, grows a box per digit past
four and waits for the Join button, so a six-digit code is never cut at four
digits (each wrong attempt counts toward the lockout).

**D-G-04 · Guest screens read a leftover live 'offline' against the network.**
`LiveProvider` sets 'offline' only from the browser's offline signal and does
not clear it when the network returns unless the stream errors or says hello
again; a stream that survived a short blip never does, so Send stayed
disabled until a reload. `useGuestLiveState()` treats 'offline' as live while
`navigator.onLine` is true (a stream that really died reports 'reconnecting'
on its next retry). Cart, review, service sheet, Track, Bill and the shell
banners use it. The provider itself still needs the fix (see the report).

**D-G-05 · The ended screen has no dead navigation.**
With `mode === 'ended'` the dock is not rendered, the masthead keeps only the
Menu link (nothing marked current on the thank-you page) and the header
service key is gone. The page's own "Browse the menu" is the way forward.
Page bottom padding is unchanged, so nothing jumps.

**D-G-06 · The restaurant's wait estimate reaches guests.**
When `ordering.estimated_wait_minutes` is set it is shown: as a second line
of the paused or busy banner, and, while ordering is open, as a one-line info
banner on the menu, order and Track pages. Nothing is shown when it is empty
(Settings: "Leave empty to show nothing").

**D-G-07 · Weighed-cut quotes, search aliases, bundle weight.**
- A priced quote card shows the staff note ("From the restaurant"), the
  choices staff set (group: options) and what those choices add. The guest's
  own request note stays visible in every state. The realtime payload is
  unchanged (notes still come only from the authenticated GET).
- Menu search also matches owner-verified aliases when the menu API sends
  them (`aliases_th`/`aliases_en`, or `aliases` as a list or `{th, en}`): an
  alias prefix ranks with a name contains, an alias contains with an
  all-words match. Printed names are never changed.
- The weighed-cut sheet keeps its gram bounds in `guest/visit/limits.ts`
  instead of importing `shared/schemas.ts` (all of zod) at start-up;
  `test/unit/guest-limits.test.ts` fails if they drift from the schema.

## Review fixes: UI kit, styles and client lib

**D-K-01 · The live client follows the server after a database restore.**
The event bookkeeping now lives in `client/src/lib/live-cursor.ts` (tested in
`test/unit/live-cursor.test.ts`). A cursor from the server that is lower than
the page's own (a `hello` that did not replay, or a poll answered with
`resync: true` below the `since` it was sent) means the event history
restarted. The page then takes the server's cursor and clears its seen ids,
instead of keeping its maximum, which made polling resync every 5 s and
dropped recycled ids as duplicates. The SSE `resync` event's cursor is
applied too. If hello or poll ever carry an `epoch` (a database identity),
a changed epoch resets the same way; the server does not send one yet.
Resync handlers receive `{ reset, cursor }`, so anything that remembers
event ids (the staff alert floor) can restart from the new cursor. A poll
answer that arrives after the transport changed (new stream, page parked)
is dropped. An `online` event also returns a stream that survived the blip
from 'offline' to 'live' (the provider half of D-G-04).

**D-K-02 · Status words follow the top-most modal.**
`announce()` picks its region when it writes, 80 ms after the call: inside
the top-most `dialog:modal` (each modal sheet gets a polite and an assertive
region when it opens), otherwise the page regions under `<body>`. The page
behind a modal is inert and outside the accessibility tree, so the old body
regions were silent while a sheet or drawer was open. `ListRow` marks an
unavailable row with `aria-disabled` and ignores the click, instead of
`disabled`, so focus stays on a row that turns unavailable as it is pressed.

**D-K-03 · Keyboard focus clears pinned bars (WCAG 2.4.11).**
`usePinnedEdge()` (ui/hooks.ts) lets the guest dock, the staff phone bar, the
guest masthead, the category row and the workspace header report the band
they cover. `<html>` carries the largest band per edge (`--pinned-top`,
`--pinned-bottom`, with `data-pinned-*` flags). The bottom band becomes root
`scroll-padding-bottom`. The top band is a `scroll-margin-top` on focused
controls only: pages already give their own scroll targets a
`scroll-margin-top` (menu sections, Track rounds, editor cards), and a root
`scroll-padding-top` would have doubled those offsets.

**D-K-04 · Roving groups keep a visible ring and one tab stop.**
The base reset that hides the ring on `[tabindex="-1"]` now spares controls
(buttons, links, form fields, menu items, options, tabs, `[data-rove]`), so
arrow-key focus onto an item outside the tab order shows the ring. Programmatic
focus targets (`#main`, step headings, drawer panels) still show none.
`roveKeys` moves the one tab stop to the focused item, so Tab leaves the group
from there; `roveBlur` on the group hands the stop back to the chosen item
(pressed, checked, selected or current) when focus leaves, matching what
`roveIndex()` renders.

**D-K-05 · Only the connection state word is a live region.**
The staff pill and the Track pill keep `role="status"` on the state word
alone. The synced time ("synced 19:52:04", "last update 19:52") changes with
every restaurant-wide event and is plain text beside it, so it is no longer
re-announced on every staff screen for each event.

**D-K-06 · The staff kit stylesheet loads with the staff platform.**
`styles/admin-kit.css` is no longer in the entry: App.tsx loads it before the
admin code (and before the /ui-kit gallery), so the admin screens' own
stylesheets still come after it. Guest screens were checked for kit selectors
in every state at 390, 820 and 1280; the only one in use (hiding the native
search clear button) moved to components.css. The production entry
stylesheet went from 141,957 to 114,058 bytes; the kit is a separate
28.8 KB file that only staff pages load. `ui/index.ts` still re-exports the
staff kit, which costs guests nothing in production (tree-shaken) but loads
those modules in development.

**D-K-07 · Language switch fades.**
`setLang` sets `html[data-lang-switch]` for one run of `lang-fade` (opacity
0.35 to 1 over `--dur-base`) on the app root and on the contents of an open
sheet. The dialog itself is not animated, so its rise does not replay, and
nothing remounts. Reduced motion shortens it to 1 ms.

**D-K-08 · /ui-kit screen frames scale to fit.**
Below its minimum layout width (1024 px for the desktop frame, 820 for the
tablet frame) a frame lays its screen out at that width and scales it down
with `zoom`; the label says "shown at N%". A narrow floor strip puts
"Open Tables" on its own row under the legend (container query).

## Admin operations fix pass (orders, tables, billing, shell)

**D-FX-OPS-01 · Food at the pass is never hidden by round placement (updates D-C4b-01, D-C4a-01, D-C4a-03).**
- A round still sits in the column of its least-advanced dish (D-C4b-01),
  but its ready dishes also reach the Ready column: a compact "Ready first"
  slip at the top of the column lists only those dishes, with
  Mark served · n (the ready lines only) and Show ticket (switches the
  status on tablets and phones, then focuses and outlines the ticket). The
  ticket itself offers Serve ready · n as its secondary action. On a
  Preparing ticket that has ready dishes, Serve ready takes the place of
  the optional Almost done, which stays in the ⋯ panel. Kitchen-only roles
  (no `orders.serve`) keep Almost done.
- The Ready count is the number of rounds with any dish at the pass (whole
  tickets plus slips), so the phone and tablet status switch, the column
  head and Overview agree, and "No tickets here right now" never shows while
  food waits. Pure rules: `readyPartOf` and `readyRoundCount` in
  board/model.ts, covered by test/unit/board-model.test.ts.
- `/admin/orders?stage=` opens a status directly (Overview's ready card links
  to `?stage=ready`); a tap writes it back. With `?table=` and no stage, the
  board opens on the first status that has that table's rounds.
- After a forward step on a tablet or phone, a toast says where the ticket
  went ("Table 02 moved to Preparing") with Show. After any board or request
  action, focus moves to the ticket's next action, else the ticket, else the
  ticket now in the same place, else the column head or the status switch
  (WCAG 2.4.3). The request card keeps one Complete element in both states.
- On desktop each column scrolls on its own with a sticky head (DESIGN
  §10.17). On phones the five statuses (and the Tables state filter, and the
  History outcome chips) wrap 3 + 2 instead of hiding behind a sideways swipe.
- Kitchen sign-ins start on the Kitchen station while the device has no
  stored choice, so one Mark ready does not announce bar drinks.
- The Orders badge and the Requests count include cuts to weigh or confirm
  for roles with `portions.quote` (the same number the Requests tab lists);
  the server's `portions_to_weigh` is used instead when the overview sends it.
- Alert sound: the owner's `notifications.sound_default` applies to devices
  that never chose (read from `/api/staff/auth/me` as `sound_default` or
  `notifications.sound_default` once the server sends it; never written to
  the device). While alerts are on but the browser has not started audio, a
  "Alert sound is paused · Tap to turn on sound" notice shows on every page.
- Outage: after 10 s of a reconnecting stream the shell probes the server
  every 15 s; when the probe fails too, every page shows "Can't reach the
  restaurant system" with the paper procedure. The table grid refetches every
  30 s so its own "out of date" banner appears. A board tap whose answer was
  lost says the board is checking again and refetches now and on reconnect;
  a stale conflict whose newer change is by the same person says "Your
  earlier tap went through".
- Pause wording: the header control pauses new orders from guests and from
  staff (Take an order); paper orders are still accepted. The dialog, banner
  and staff error say so. `orders.err.orderingPaused` replaces the guest
  wording on staff screens.
- A refund recorded after checkout shows as "Refunded after checkout ·
  amount at time" on the staff bill (from `payment_state` / `refund`).
- QR cards print the table label and a six-character token id in the
  footer, never the URL (DESIGN §10.28). Table management and the print page
  offer the SVG download (`qr.svg?download=1`, which clears "reprint needed").
- Checking-out tables fold their checkout blockers into one line on desktop
  too, so the bill stays in view. Checking-out tiles show the seated time;
  every tile's fact line states what is not served yet (ready and to-accept
  counts are on the attention badges).
- Weighing: "Weigh again" after an expired or withdrawn quote starts from an
  empty field with "Last weighed 420 g (quote 1)" for reference; a live
  quote's weight is selected on focus. The staff weighing-request note is
  labelled as seen by the guest, the quote sheet calls it "Note on the
  request", and the in-person confirmation note says it is kept in the
  history only (the server stores it as the audit reason).

**D-FX-OPS-02 · Staff confirmation comes from the line, not the live menu.**
Tickets read `requires_staff_confirm` (and `alcohol`) from each order line
once the server snapshots them: alcohol lines that need it keep the
"Alcohol · staff to confirm" row, other flagged dishes get a "Staff to
confirm" chip, and nothing shows when neither the item nor the owner's
alcohol switch asks for it. The board and history stop loading
`/api/public/menu` when every line carries the field; until then they fall
back to the menu's alcohol flag as before.

## Review fixes: admin data (Insights, Reports, Audit, Menu review)

**D-AD-01 · Staff dates follow the server's business-day cutoff.**
`admin/insights/query.ts` owns the staff clock: `useBusinessToday()` applies
`PublicConfigDTO.server_time` once per new value (re-applying an old timestamp
would drift the skew) and reads `business_day_cutoff_hour` (and
`business_date`) when the config carries them. Order Stats also learns the
server's current business date from the partial bucket of a period that
contains today, trusted for ten minutes on the same calendar day, so the
"same weekday last week" card and the period labels line up before the config
field exists. The Operational report presets and date caps, and the audit
log's "Today" and day groups, use the same hook (`businessDateOf()` for the
groups, matching the server's date filters). Until the server sends the
cutoff, screens outside Insights still fall back to 00:00 (D-11).

**D-AD-02 · Missing is not zero in the Order Stats headline.**
When every bucket is before records began or still ahead (or there is no
first operating date), the headline shows "—" and "No records for this
period, <dates>", with no comparison and no selected-day card, and the view
change is announced as "no records". The client derives this from the bucket
states; `OrderStatsDTO.total` stays a number.

**D-AD-03 · Live refetches have a maximum wait.**
`useLiveResource` (Insights, Operational report) and `useTopicRefresh` (More)
keep the trailing debounce but fire at most 30 s after the first event they
hold back, so a screen left open during steady service still refreshes. Menu
Stats listens to order, line and portion events only for a period that
contains today; a past period refreshes on `menu.*` and `report.*`, like the
day drill-down.

**D-AD-04 · Operational report: optional server fields, shown only when sent.**
`admin/more/reportTypes.ts` lists what the report reads beyond the stable
`KpiDTO`: `filters` + `filter_options` + `unfiltered` (table, category and
staff filters) and `GET /api/staff/feedback`. The filter selects appear only
when the KPI response lists the choices, the scope line names only the
filters the server echoes, and each figure in `unfiltered` says "Not split by
this filter". The guest-feedback panel stays hidden while the endpoint
answers `not_found` or `forbidden` and the page stops asking. The report CSV
writes the filter scope, `refunds_after_checkout` and the feedback count,
average and score distribution; comment text is never exported. Custom ranges
use the API's 400-day limit (`MAX_CUSTOM_DAYS`) and say so under the fields.

**D-AD-05 · Refunds after checkout get their own card.**
When `KpiDTO.refunds_after_checkout` is present (financial viewers only), the
report shows "Refunds after checkout" beside Payment exceptions, and the
exceptions definition says those bills are counted there instead.

**D-AD-06 · Phone layouts for Insights and Reports.**
Below 480 px the period switch and the Top 5 / Top 10 / All control span the
column, and the custom-range date fields stack. The day drill-down becomes a
stacked list below 600 px (reference and status, then table · round · sent ·
items, then source) with an "Order by" select; the wider table now shows
Status right after Reference. The annual-archive card lets its year tag and
range wrap, and `.mp__body` / `.insx-section` use a `minmax(0, 1fr)` column so
a long child can no longer widen the page. Checked at 320, 360 and 375 in
both languages: no sideways scroll on Insights, Reports, Audit, Team,
Settings or Menu.

**D-AD-07 · Codes use Oswald; the shell command stays monospace.**
Usernames, audit record ids and payment-method ids use `--font-display` with
`--track-ref` (DESIGN §4.1, §10.23). The one CLI sample on the Team page
(`npm run admin:create …`) keeps the system monospace so it can be copied
exactly; it is the only monospace text in the staff app.

**D-AD-08 · Audit numbers that are identifiers print as plain digits.**
Years, revisions, versions, `*_no`, `*_id` and sequence numbers show as
"2026", not "2,026". Money fields keep baht formatting and other counts keep
grouping.

**D-AD-09 · Menu review attention uses a heat tag, not the ember mark.**
Open notes, ambiguous prices and pending by-weight rules show a "Needs
review" heat tag beside the figure when above zero (DESIGN §9 keeps the ember
mark for "current"). From 480 px the card label reserves two lines, so a
wrapped label no longer drops its figure below the rest of the row.

**D-AD-10 · The payment QR setting says what V1 does.**
The note under a payment method that has `payment_qr_image` now says the
image is on file, is not shown to guests in this version, and that staff
check transfers in person (brief 03, 16).

## Docs and tooling pass

**D-DT-01 · The development server shows the network the app, nothing else.**
`npm run dev` binds Vite to the LAN for phone testing (brief 29). Vite's
default allow-list is the whole project, so `/@fs/<path>` served the SQLite
database (live visit PINs, QR tokens, password hashes), report files and the
server source to anyone on the Wi-Fi.
- Vite now starts through `scripts/vite-dev.ts` (`createServer` with
  `vite.config.ts`, plus `server.fs`). Only `client/`, `shared/`, `public/`
  and `node_modules/` are allowed.
- The deny list repeats Vite's defaults and adds `*.db`, `*.db-*`, `*.sqlite*`,
  `var/`, `server/`, `scripts/`, `data-src/` and `test/`. Setting `deny`
  replaces the defaults, which is why they are repeated.
- The API child listens on 127.0.0.1 only, and Vite proxies to it.
- A fs block in `vite.config.ts` would be merged with this one (arrays
  concatenate), so the two can coexist.
- `npm run e2e` checks the result from the LAN address (test `files`): every
  sensitive path gets 403, `shared/` still gets 200, and the API port refuses
  LAN connections.

**D-DT-02 · QR cards in development point at the LAN address.**
When `PUBLIC_BASE_URL` is set neither in the shell nor in `.env`,
`scripts/dev.ts` uses `http://<first LAN IPv4>:PORT`.
- Physical adapters come before virtual ones (vEthernet, VirtualBox, WSL,
  Docker, VPN). Then 192.168.x comes before 10.x, and 10.x before 172.16–31.x.
- It prints every candidate address, which address the QR cards use and why,
  and warns when only a loopback address is left.
- `.env.example` ships the variable commented out. A copied `.env` therefore
  no longer pins it to localhost.
- `npm start` does not guess an address. The server warns at start instead,
  because a restaurant install needs a deliberate address.

**D-DT-03 · Seeding never runs inside a watched or production process.**
- `npm run dev` runs `node server/db/seed.ts` to completion before any
  watcher starts. It then starts the API with `SEED_DEMO=0`, so a file save
  during the ~15 s first seed can no longer leave a half-seeded database.
- `SEED_DEMO=0` (from the shell or `.env`) skips the step, and
  `SEED_HISTORY=0` skips only the synthetic year.
- `npm start` is now `scripts/start.ts`. It sets `SEED_DEMO` and
  `SEED_HISTORY` to 0 unless one of them is set explicitly, so a first
  `npm start` without `NODE_ENV` no longer creates the demo accounts, whose
  passwords are public. It also warns when `NODE_ENV` is not `production` or
  `dist/` is missing.
- `npm run seed` (`scripts/seed.ts`) keeps including the synthetic year
  unless `SEED_HISTORY=0`. That stays true even if the server's own default
  changes.
- Still open, in the server area: `server/config.ts` defaults, detection of a
  partial seed, and refusing fixture staff logins in live mode.

**D-DT-04 · Browser suites.**
- **`npm run e2e`** (`test/e2e/run.ts`) is a node:test file.
  - Each journey collects soft checks and fails its test with the full list,
    so one broken step still reports the rest.
  - It starts one seeded throwaway instance through the `npm run dev` path
    (`var/e2e/<name>/`, free ports or `--port`), or uses a running instance
    with `--base`.
  - Journeys a–f share one visit and run in order.
  - `--prod` runs the same journeys against `vite build` + `npm run seed` +
    `npm start`, with QR cards on the LAN address. It swaps the dev-file
    exposure test for a production one: bundles are served, while source maps
    and missing bundles answer 404. The gallery check is skipped there.
- **Scenario 12.** Browser offline emulation does not close an established
  EventSource. The board therefore reaches the app through a small HTTP proxy
  (`test/e2e/cutproxy.ts`) that drops the live channel at the socket level
  while ordinary requests pass.
- **Kitchen tablet.** It is set to "all stations" for the fulfilment journey,
  because kitchen tablets now default to the Kitchen station.
- **`npm run shots`** (`test/visual/shots.ts`) captures:
  - guest screens at 320, 390, 768 and 1440 px, and staff screens at 390,
    768, 1024 and 1440 px, in both languages;
  - the brief-34 states;
  - an in-page audit of each screen: overflow, Thai line height and tracking,
    minimum text size, and 44 px targets;
  - `index.html`, a contact sheet beside the reference mocks.
- **What fails a shots run.** Page errors, missing translation keys and
  horizontal overflow fail it. Other audit notes fail it only with `--strict`,
  because they need a person's judgement.

**D-DT-05 · Delivery documents.**
- **README.md** covers the quick start, phones, going live, commands and
  status.
- **docs/OPERATIONS.md** covers first admin, environment, local startup, LAN
  QR testing, backup and restore, deployment preparation, the PDF browser
  context and jobs.
- **docs/OWNER-CHECKLIST.md** is the file `shared/settings.ts` has always
  pointed to. It uses the source-audit counts and the 21 owner questions.
- **docs/FEATURE-MATRIX.md** gives every brief requirement with its state and
  evidence. It is also the implementation checklist brief 32 asks for.
  ARCHITECTURE.md now names it instead of the `docs/CHECKLIST.md` that was
  never written.
- **Honesty rule.** Every "Verified" names a test, a journey or a capture, and
  the documents say throughout that verification is local only.

## Review fixes: server

**D-S8-01 · Bill adjustments: linked comps leave with their dish; one attempt, one row.**
- A dish that leaves the bill (rejected or cancelled) voids every adjustment
  linked to it in the same transaction (`voided_at`, `voided_by`,
  `void_reason` "Dish cancelled: <reason>", audit `bill.adjust_void`, bill
  version bumped). As a backstop, the running bill counts a linked adjustment
  only while its dish is chargeable. A comp can no longer be linked to a dish
  that is not on the bill.
- `POST /visits/:id/adjustments` takes `idempotency_key` (same key and
  details replay and return the bill; other details answer
  `idempotency_mismatch`) and `bill_version` (a newer bill answers
  `stale_version` with the current bill). Both are optional in the schema
  only so an older client keeps working; the adjustment dialog must send
  both and keep the key until it gets a definitive answer.
- `POST /visits/:id/adjustments/:adj/void` (`billing.adjust`,
  `{ bill_version, reason }`) voids one adjustment while the bill is open.
  The staff bill lists `adjustments` and `voided_adjustments` (who, when, why).
- Finalized revisions keep their own copy of the adjustments; nothing is
  deleted.

**D-S8-02 · Data retention is applied by a daily task.**
`server/domain/retention.ts` (`npm run jobs -- retention [--dry-run]`, and
once per business day in the server; off by default under `NODE_ENV=test`,
`RETENTION_JOB=1` turns it on). Past each horizon (Bangkok business dates):
guest note text on order lines, service requests, weighing requests and
quotes is removed (`note_removed_at` remembers that a note existed, so "lines
with a guest note" in old reports does not change; the allergy flag stays);
feedback comments are removed (ratings stay); raw engagement events are
deleted one day at a time, only after that day's item aggregates exist; audit
entries older than `audit_days` are deleted. Housekeeping: the event outbox
keeps 7 days and at least the newest 1,000 rows; staff sessions that ended
30 days ago are deleted. Orders, visits, bills and payments are never
touched. Each run leaves a `retention.run` audit entry with its counts and
records `raw_events_purged_through`; the Engagement page's
`raw_events_retention` note now uses that date, and Settings returns
`retention_status` (`last_run_at`, `raw_events_purged_through`). Analytics
sessions are kept: they carry no free text and old rounds still need them for
attribution.

**D-S8-03 · A payment correction counts against the settlement it corrects.**
In the annual snapshot every settlement (confirmed or since reversed) counts
in its own confirmation month; its reversal or refund record, whatever its
date, is subtracted in that same month. "Recorded payments, net" for any
period is therefore exactly the settlements of that period still in force,
the same figure as the KPI screen's paid total, and nothing is subtracted
twice (the snapshot used to subtract a refunded or next-month-reversed
settlement once as "marked reversed" and again as its own row). A late
correction is listed with `late = true`. Confirming a payment on a bill
finalized on an earlier business date, and every reversal, also bump the
report data version of the revision's year.

**D-S8-04 · A refund after checkout: the bill is history, not "paid".**
The settled revision and `bill_status: settled` stay as recorded. The staff
bill now derives `paid` from a confirmed settlement still in force (a
zero-total bill counts as paid) and adds `payment_state`
(`none | paid | reversed | refunded`) and `refund` (amount, reason, who,
when). The KPI screen reports such bills as `refunds_after_checkout`, not as
payment exceptions; the payments list shows them once, as the refund record;
the annual report lists them once, as "Refund recorded", and not as unpaid.
Cashier, owner KPI and report agree.

**D-S8-05 · Engagement: menu means the menu page.**
Scroll depth counts only `route = 'menu'` events, over the sessions with a
menu-route event (`scroll_sessions`, now in the Engagement DTO, the CSV
denominator and the annual PDF caption). The dashboard's daily and monthly
`active_ms` series are menu-route time, like the headline "active menu time";
the annual export still keeps the all-routes total separately. The daily
query is skipped in the year view, which only needs months.

**D-S8-06 · Add rate is per session (updates D-S6-06).**
add rate = sessions that saw the dish and added it / sessions that saw it.
Impressions are recorded once per session and adds on every tap, so the old
adds / impressions mixed units and passed 100%. The Engagement items carry
`impression_sessions` and `add_sessions`; the dish drill-down and the export
(raw-event days) use the same rate.

**D-S8-07 · Join-PIN lockouts escalate within a visit.**
First lockout: `lockout_minutes`; second: three times as long (capped at
60 minutes, or the setting if longer); third: until staff rotate the PIN
(`pin_locked` details then say `staff_unlock_required: true` with no
`until`). Rotating the PIN, revoking guests and closing the visit reset the
count (`visits.pin_lockouts`). The table tile's visit carries `pin_locked`
and the visit detail `pin_lock_requires_rotation`, so floor staff see it
without opening the drawer.

**D-S8-08 · Revoked access ends at once, also mid-request.**
A staff event stream re-checks its session before every read and ends with
`event: access`: `{ state: 'ended' }` when the session is revoked or signed
out or the account is deactivated or demoted (role changes revoke sessions),
and `{ state: 'changed' }` when the account is still signed in but its
permission set changed (permission settings): the client then reconnects and
gets the new topic filter. Revocation and sign-out wake every stream.
Guest mutations (orders, service, feedback, portions, bill request) re-check
the guest session inside their transaction, so a phone revoked while its
upload was still arriving creates nothing.

**D-S8-09 · HTTP hardening for a real install.**
- Request bodies are capped before they are read: 16 KB for `/api/public/*`,
  8 MB for the menu CSV preview, 256 KB for everything else (the analytics
  batch keeps its own 128 KB); larger bodies answer `413 payload_too_large`
  with `Connection: close` (the unread body stays on that socket, so a
  keep-alive client must not send its next request on it).
- API JSON and CSV, and HTML, CSS and JS files above 1 KB, are gzip-compressed
  when the browser accepts it; event streams never are. Hashed bundles are served from a
  `.br` / `.gz` sibling when one exists.
- Static files: hashed assets are immutable for a year and a missing one is a
  plain 404 (never index.html); `/media` is cached for a week; every static
  file gets a weak ETag and answers 304 to If-None-Match / If-Modified-Since;
  `/` and `/index.html` are `no-cache`; a path with a file extension that
  matches nothing is a 404; source maps are not served unless
  `SERVE_SOURCEMAPS=1`.
- `COOKIE_SECURE` unset now follows the scheme of `PUBLIC_BASE_URL` (https =
  Secure). A production build on a plain-http LAN address could otherwise
  sign nobody in. The server warns at start when the QR base points at this
  computer while listening on the network, and when Secure cookies meet an
  http base URL. The QR print batch returns `qr_base_url` and
  `qr_base_is_local` for the print page to warn before printing.

**D-S8-10 · Sign-in and join budgets count failures by address.**
Sign-in: 10 failures per address, 5 per account from one address (the stop
a guesser meets), 20 per account from anywhere in 15 minutes, and the
account lock after 20 consecutive failures (15 minutes). A locked account
answers like a full budget (`429 rate_limited`), so a response never reveals
whether a username exists, and a guesser on another device does not lock the
kitchen tablet out. QR join: only failed joins use the 10-a-minute address
budget; every attempt counts against a looser 60 a minute. A request that
arrives with `X-Forwarded-For` while `TRUST_PROXY_HOPS=0` logs a one-time
warning.

**D-S8-11 · Demo staff accounts and live mode.**
Switching to live is refused (`409 demo_accounts_active`, with the
usernames) while an active demo account (`is_fixture`) exists. The same
settings request with `deactivate_demo_staff: true` deactivates them, signs
them out and audits it, in one transaction; it is refused when the acting
owner is itself a demo account or no real owner would remain. While live, a
demo account can neither sign in nor use an existing session.

**D-S8-12 · The availability log also records settings and seasons.**
Settings changes to `operating_mode` or `alcohol` log every dish whose
orderability changed (reason `settings`). A job logs seasonal dishes that
opened or closed at the business-day boundary (reason `seasonal`, stamped at
the start of the business day), at start and every 10 minutes. Menu Stats
and the annual ranking no longer apply today's alcohol or mode setting to a
past period when the dish has an availability log.

**D-S8-13 · Report labels are per scope (updates D-S7-02).**
"final" and "revised" are decided within the same scope (kind, year, demo
data, financial, raw events). A manager's first non-financial copy of a
completed year is therefore its own "final" and needs no reason; only a
further copy in that scope is "revised". The year list's
`coverage.telemetry_since` is a Bangkok business date, and the PDF's
"Measured since" prints the business date of the measurement start.

**D-S8-14 · Heavy reads stay off the service path.**
A covering index on `analytics_events` (date, type, session, route, item,
category, active time, depth, quick add, fixture) replaces the date index;
the active order board is driven from open visits instead of scanning order
history; the raw engagement CSV is streamed one business day at a time with
a yield between days.

**D-S8-15 · Paper orders cannot belong to the previous party.**
A recovered paper order may be dated before its visit was opened (during an
outage the party is often entered afterwards), but not before the previous
party at the same table checked out (`validation_failed`,
`before_previous_party`).

**D-S8-16 · A manager exception close resolves the dishes that never came.**
Completing checkout with an exception rejects each unaccepted line and
cancels each accepted-but-unserved line, with "Closed by manager exception:
<reason>" and a line step, so nothing stays "accepted" forever or counts as
sold. The checkout audit records how many lines were resolved; a finalized
revision keeps what it recorded.

**D-S8-17 · "See prices on orders" is enforced by the server (updates D-23).**
Staff without `orders.view_bill_values` receive every amount of a staff
order (subtotal, unit, choices, line totals, rate) as 0 with
`money_hidden: true`, on the board, the order detail and every transition,
finish or recovery response. The client already hides money for them.

**D-S8-18 · "Currently cooking" or "Currently preparing" is editable.**
Categories and dishes take an optional `prep_kind` (`cook` | `prepare`,
null = default: drinks, bar items and desserts prepare, the rest cook). The
dish's choice wins over its category's. Each order line keeps the wording it
was given. The raw salads on the printed menu are set to "prepare" (seed and
migration); the grilled Caesar keeps "cook".

**D-S8-19 · Paper recovery: "paused" and "sold out" never hide other reasons (updates D-25).**
A recovered line that is sold out or in a paused category is re-checked with
those two states ignored; anything else (not verified, price pending, not
published, out of season, alcohol off) sends the order to review. An
unverified dish, or one whose new price awaits approval, is never recorded
from paper at that price.

## Docs and tooling: review round 2

**D-DT-06 · The development proxy tells the API which phone is calling.**
`npm run dev` serves phones through Vite and proxies `/api` to the API, so
every request reached the API as `127.0.0.1`: one guest typing wrong PINs, or
one busy table, used up the join and sign-in budgets of the whole restaurant
Wi-Fi (D-S8-10 counts by address).
- `scripts/vite-dev.ts` adds `xfwd: true` to every proxy entry
  `vite.config.ts` defines (a `config` hook, so it holds whatever keys that
  file uses), and `scripts/dev.ts` starts the API with `TRUST_PROXY_HOPS=1`.
  `vite.config.ts` sets `xfwd` on its own entries too (D-K2-11), so a bare
  `npx vite` behaves the same; the hook stays as the guarantee for whatever
  that file defines next.
- The value in `.env` is deliberately ignored in development: the API there
  always sits behind exactly one proxy, and a higher number would let a phone
  choose its own address by sending `X-Forwarded-For` itself. `npm run dev`
  prints a line when a different value was configured.
- Checked on this laptop: 10 failed joins from `localhost` used that address's
  budget (11th and 12th answered `429 rate_limited`), the same request with a
  forged `X-Forwarded-For: 9.9.9.9` still answered 429 (the proxy appends the
  real address last, and hops=1 reads the last one), and the first attempt from
  the LAN address answered the ordinary `404 qr_invalid`.
- `npm start` is unchanged: `TRUST_PROXY_HOPS` there is the operator's, and
  the default 0 is right for a server phones reach directly.

**D-DT-07 · The build precompresses the bundles.**
`npm run build` is `vite build` followed by `scripts/precompress.ts`, which
writes a `.br` and a `.gz` beside every text asset above 1 KB in `dist/assets`
(Brotli quality 11, gzip 9; a sibling is kept only when it is smaller, and
stale siblings are removed first). The server already prefers such a sibling
(D-S8-09), so the one restaurant process no longer compresses the same bundle
for every guest, and phones get the maximum ratio: the staff bundle goes from
494,805 bytes to 80,491 (gzip on the fly gave 103,798). Skipping the step only
costs speed. `npm run e2e -- --prod` builds the same two steps and checks that
a bundle arrives Brotli-encoded and that a client accepting no compression
still gets the plain bytes.

**D-DT-08 · The annual PDF is now checked as pages, not only as HTML.**
`npm run pdf:pages -- <file.pdf> [--pages 1-3,40,last] [--scale] [--text]`
(`scripts/pdf-pages.ts`) renders pages of a finished PDF to PNG with pdf.js
inside the same headless Edge or Chrome the rest of the tooling uses. A
local-only HTTP server serves one page, the PDF and the pdf.js files from
`node_modules`; nothing is downloaded, and `--text` writes each page's text,
which keeps Thai where `pdftotext` drops it.
- `pdfjs-dist` is a devDependency at an exact version (6.3.289), like every
  other dependency.
- It asserts nothing beyond "the file opens and the page renders": judging a
  printed page is a person's job. Four pages of the 520-page synthetic 2025
  report were looked at this way (cover, an appendix page in landscape, the
  last page); TESTING.md records what they showed.

## Round 2: guest screens on the real server fields

**D-G2-01 · The join screen takes this visit's code length (completes D-G-03).**
`QrResolveDTO.pin_digits` is now sent, so the boxes, the auto-submit, the
lead, the field label and the "enter all N digits" message follow the visit's
own code (checked with a six-digit code: six boxes, "รหัส 6 หลัก", joining on
the last digit). The 4-to-8 fallback stays for a visit with no code yet, where
the server sends null.

**D-G2-02 · A third wrong-code lockout asks for a new code instead of a clock.**
`pin_locked` with `staff_unlock_required` and no `until` (D-S8-07) shows
"ขอรหัสใหม่จากพนักงาน · ใส่รหัสผิดหลายรอบ รหัสเดิมของโต๊ะนี้ใช้ต่อไม่ได้แล้ว"
and, unlike a timed lockout, leaves the field open and unmarked: the way out is
the code staff issue when they rotate the PIN, and the guest types it on the
same screen. Checked end to end: third lockout, staff rotate, the new code
joins without a reload.

**D-G2-03 · Feedback after checkout follows the server's window (completes D-G-01).**
The ended page reads `GET /api/guest/feedback/eligibility`
(`{ eligible, submitted, until }`, D-S8-22): it offers the form only while the
API would accept it, says how long ("ส่งได้ถึง 01:59"), and at `until` asks
the API again rather than trusting the phone's clock (if the API still says
yes, it waits at least another 15 seconds). `submitted` shows the thank-you.
An unknown outcome - no network, a timeout - keeps the form and the draft,
because sending is what settles it. The old 404 fallback to the session probe
is gone: the endpoint is part of the API now.

**D-G2-04 · The ended page still knows the visit after a reload.**
A reload in the seconds after checkout answered `410 visit_closed` before this
tab had loaded its session, and the ended mark was overwritten with a
session-less one: the page could then name neither the table nor the visit its
feedback draft belongs to, so typed words were dropped with no word about it.
The session provider now keeps the remembered visit when it has none of its
own, and, as a last resort, the ended page takes the visit id from the one
draft this tab is keeping (unsent, under 30 minutes old). Checked: reload
inside the window brings the form and the draft back; after it, the page says
the feedback could not be sent.

**D-G2-05 · The service sheet honours the repeat-request wait (D-S8-23).**
A refusal (`rate_limited` with `retry_after_seconds`, reason
`service_cooldown`) disables that one request and counts down in its row -
"เรียบร้อยแล้ว 01:28 · ขอใหม่ได้ในอีก 41 วินาที" - instead of reading as a
failure. The public config now carries `service_cooldown_seconds`, so the row
also holds itself back from the moment the last request of that type was sent,
by the server's own rule (never for asking for the bill): the second tap does
not even leave the phone. Zero, or a server that sends no value, means nothing
is held back here and the server's answer alone decides.

**D-G2-06 · Menu search reads only the aliases the menu API publishes.**
`aliases_th` / `aliases_en` on `MenuItemDTO` (the reviewed ones only)
replace the tolerant shapes the client accepted while the field did not exist;
`test/unit/guest-menu-search.test.ts` now also asserts that nothing else on an
item is searched. Checked against the real menu API: a reviewed Thai
alias finds an English-only drink, an unreviewed one finds nothing, because the
server never sends it.

## Round 2: server fields the screens already read

**D-S8-20 · A ticket carries its own facts, and tiles count dishes.**
- Order lines snapshot `alcohol` and `requires_staff_confirm` (the item's flag,
  or alcohol while the owner's confirmation note is on) when the round is sent,
  and staff views carry both. Turning the note off, or editing the dish, never
  rewrites a ticket the kitchen already has. Guest views do not carry them: the
  menu says what a dish is, and the guest is the one being asked to confirm.
  Migration 011 backfills old lines from today's menu, which is the best
  available answer for rounds taken before the snapshot existed.
- A tile's visit adds `ready_dishes` and `unresolved_dishes`, and the overview
  adds `ready_dishes`: quantities, which is what a ticket's buttons count
  ("Mark served · 3"). The `*_lines` figures stay as they were, so nothing
  changes meaning under a screen that has not switched yet.
- The overview adds `portions_to_weigh` (cuts still `requested`), a subset of
  `open_portion_requests`: the badge staff act on first.
- `/api/staff/auth/me` carries the owner's `sound_default` (and
  `notifications.sound_default`, so either name works on the client).
- `GET /api/staff/tables` carries `qr_base_url` and `qr_base_is_local`, like
  the print batch already did (D-S8-09), so the table screen can warn before
  anyone prints cards that open on no phone. The print batch also says
  `pin_required`: a card printed while PINs are off must not tell guests to
  ask for a table code.

**D-S8-21 · Weighed cuts can be recovered from paper.**
An outage ticket may include a cut that was weighed at the counter, so a
recovery line takes `measured: { grams }`: the line is priced at the item's
approved rate (grams x rate / basis, half-up), quantity 1, with no portion
quote behind it. Grams on a dish that is not sold by weight, or a quantity
other than 1, answer `422 validation_failed` on `lines.N.measured` /
`lines.N.quantity` (codes `not_measured_weight`, `one_cut_per_line`); a weighed
cut with no grams still answers `cart_changed` with
`measured_weight_needs_quote`, as before. The weights are part of the ticket's
identity: the same paper reference with a different weight is a conflict, not a
second order. What already applied still applies: an unverified dish, or one
whose new price awaits approval, is never recorded from paper (D-S8-19).

**D-S8-22 · Feedback outlives checkout by half an hour.**
Checkout closes the visit and revokes every phone at the table, which left no
window at all for the one thing a guest may still want to do. For 30 minutes
after `closed_at`, a session that CHECKOUT ended (not one staff revoked, and
not one whose guest left) may still `POST /api/guest/feedback`, and
`GET /api/guest/feedback/eligibility` answers `{ eligible, submitted, until }`
so the ended page offers the form only while the API would take it. Every other
route keeps answering `visit_closed`, and the cookie - which now grants nothing
but feedback - is kept until the window closes, then cleared by the next
request. Still one entry per guest session.
Staff read the result through `GET /api/staff/feedback?from&to&include_fixture`
(`reports.view`): counts, the mean, the 1-5 distribution, how many carried a
comment, and up to 500 entries newest first (`truncated` past that) with the
table each party sat at. Demo data is excluded unless asked for, comments
removed by retention read as null, and feedback is never pushed on the live
stream: it is not a queue anyone works.

**D-S8-23 · The repeat-request wait is the server's rule.**
`service_cooldown_seconds` was left to the guest screen (D-21), so a reloaded
phone could page staff again at once. A guest request of a type whose last
request was sent less than that long ago now answers `429 rate_limited` with
`{ reason: 'service_cooldown', type, retry_after_seconds, available_at }`.
Asking for the bill is never held back, staff-created requests never are, and 0
turns it off. The active-request rule (D-21) still answers first, so a double
tap still returns the request already waiting. The value is in the public
config, so the sheet can hold a row back before it sends.

**D-S8-24 · A QR resolve says how long this visit's PIN is.**
`QrResolveDTO.pin_digits` carries the length of the visit's actual code (4-8),
or null when no PIN is asked for or the visit has none yet: the join screen can
then draw the right number of boxes instead of guessing from a setting that may
have changed since the party sat down. The code itself is never sent.

**D-S8-25 · Report filters: a figure is narrowed, or plainly unfiltered.**
`/api/staff/stats/kpis` (and `export.csv?view=orders&rows=order`) accept
`table_id`, `category_id` and `staff_id`, and echo `filters`, `filter_options`
(tables, categories and staff, so a manager needs no `team.manage` to filter by
a colleague) and `unfiltered`. Not every figure can follow every filter: a bill
belongs to a table but not to a dish category, and "how fast were requests
answered" belongs to the person who answered. A figure is narrowed only when it
supports EVERY active filter; otherwise it is computed with no filter at all
and named in `unfiltered`, so a number is either exactly what the filter line
claims or marked as covering everything. Table narrows every figure; category
narrows the line figures (values, errors, cancellations, hourly, acceptance);
staff narrows acceptance (`line_events.actor_id`) and the service-request
figures (a new `acknowledged_by_id`, backfilled from the audit trail, because
a display name can be edited). Payment figures follow the table only:
"recorded by this person" would hide unpaid bills from the very figure whose
job is to show them. An unknown id is refused, not ignored.

**D-S8-26 · Settings sections save on the version they were drawn from.**
A PATCH may carry `expected_updated`: `{ key: updated_at | null }` for each key
the section edits. Any key saved since answers `409 stale_version` with
`{ keys, current }` (the whole current view) and nothing is written, so two
managers editing different sections never overwrite each other and the one who
is behind sees what changed. Without the field the PATCH behaves as before.

**D-S8-27 · Going live and the demo accounts are one request.**
`deactivate_demo_staff: true` belongs with `operating_mode: 'live'`: on its own
it answers `422`. Refusing to go live (`demo_accounts_active`) now also says
`self` (the acting owner is itself a demo account), `real_owner` and
`can_deactivate`, so the screen offers "Deactivate demo accounts and switch"
only when that request would be allowed. The answer lists
`deactivated_demo_staff`. Sending the same request again is safe: a patch that
sets live while the restaurant is already live still retires any demo account
that is somehow still active.

**D-S8-28 · Menu search aliases are reviewed before guests search them.**
`menu_items.aliases_th` / `aliases_en` (JSON arrays, up to 12 per dish, 60
characters each) hold other spellings and nicknames; printed names never
change. They reach `MenuItemDTO` only once `aliases_verified` is set, which
needs `menu.review` - an edit by anyone else clears it, like a description
(D-S1.2). The admin catalog carries the drafts plus the flag, so the editor can
show what is waiting. The CSV export and import carry both columns
(`|`-separated), and an imported list always lands unreviewed.

**D-S8-29 · An interrupted demo seed is detectable.**
`app_meta.seed_state` is written 'running' in the same transaction as the
catalog and 'complete' after the last step. `npm run seed` and `npm run dev`
refuse a database whose seed never finished and say to reset it; the server
warns at start. Databases seeded before the marker have none and are taken as
complete.

**D-S8-30 · A bare server start never invents demo data.**
`config.seedDemo` now defaults to OFF: `node server/main.ts` against a
restaurant database can no longer create demo staff (published passwords),
fixture visits or a synthetic year. `npm run dev` and `npm run seed` set
`SEED_DEMO=1` explicitly, so development is unchanged (D-DT-03).

**D-S8-31 · The live stream says which database it is (completes D-K-01).**
`app_meta.db_epoch` is a random value written when the database is created. The
SSE `hello` and every poll answer carry it, so a client that reconnects to a
restored or reset database - where event ids start again, possibly above its
own cursor - sees the epoch change and starts from the server's cursor instead
of keeping a history that no longer exists.

## Round 2: admin data (Insights, Reports, Settings, Audit, Menu editor)

**D-AD2-01 · Every settings save carries a version check.**
A section sends `expected_updated` (each key it edits -> the `updated` time its
draft started from, null when never saved). The server answers 409
`stale_version` with the whole current view and writes nothing (D-S8-26); the
section then shows that version, keeps the draft, says "Not saved: someone
saved this section first" and offers "Load the saved version". A save
elsewhere that stored the same values still moves the stamp, so the section
notices it and no longer overwrites silently. `SettingsSection` also takes
`refusal(err)`, a section's own words for an answer the generic error line
cannot explain, and a `ConfirmSpec` may carry `extra` fields and a `retry` that
replaces the open dialog with what the refusal asks for.

**D-AD2-02 · Going live offers to switch the demo accounts off.**
The confirmation lists the active demo staff accounts (read from
`/api/staff/team`) and its button becomes "Deactivate demo accounts and
switch", which sends `deactivate_demo_staff: true` (D-S8-11). The offer is made
only when this owner may make it: a demo account cannot switch the restaurant
live, and the dialog says so instead. A refusal that names accounts the screen
did not know about re-opens the same dialog with them; `self` and
`real_owner: false` answers are spoken as "sign in with your own owner account"
and "create an owner account of your own first".

**D-AD2-03 · Data retention shows what the clean-up task did, and what it keeps.**
Under the section: when the task last ran and the business date raw menu events
are removed through (`retention_status`, D-S8-02). Each field says what
survives: note text goes but "a note existed" and the allergy flag stay,
comment text goes but ratings (and the average) stay, per-dish daily counts
stay when raw events go. The Engagement page's retention note now says the
clean-up removed those days rather than guessing they might be gone.

**D-AD2-04 · Report labels are decided inside the viewer's own scope.**
`nextLabel()` filters the year's files by `financial` (reports.financial) and,
for a data export, `raw_events` (reports.export_raw) as well as demo data, so a
manager's first non-financial copy of a completed year is its own "Final" and
needs no reason (D-S8-13); the revision number still counts every file of that
kind and year. The data-export button names its next label like the PDF one,
and the action buttons wrap at 320 px instead of widening the card.

**D-AD2-05 · Engagement counts are divided by what they were measured over.**
Scroll depth is a share of `scroll_sessions`, the sessions that opened the menu
page (D-S8-05), and the card says so. The item note gives the per-session add
rate (D-S8-06) and warns that Seen and Adds are event counts, so the two are
never read as a fraction of each other.

**D-AD2-06 · The menu editor sets the tracker wording and the search words.**
A dish and a category each take "Wording while it is being made" (Automatic ·
by category and station / Currently cooking / Currently preparing, D-S8-18);
when the dish follows the default, the help line names what guests read now.
Search words are typed as a comma or line separated list (up to 12, 60
characters each, never printed) with the reviewer's "guests may search with
them" switch beside them (D-S8-28); the import column list carries
`aliases_th` / `aliases_en`, and a CSV that is too large is answered with
"split it into smaller files" rather than the generic error.

**D-AD2-07 · Repeated audit controls name their own record, and server English is translated.**
"Open dish", "History of this record" and "Everything for this visit" repeat on
every entry, so each carries the record (or the table) as hidden text. Reasons
the server writes in English - a dish leaving the bill, a manager exception
close, a demo account switched off, the automatic year-end file - are shown in
the reader's language, with the staff wording after the colon left exactly as
it was typed. The clean-up run and a voided adjustment have their own labels,
and both are filterable.

**D-AD2-08 · The "other language" marker names the language it is in.**
A dish printed only in Thai is marked "Thai name only" on an English screen,
not "English name as printed on the restaurant's menu"; Menu Stats, the dish
drawer and the Engagement table all decide it from the language actually shown.

## Round 2: admin operations (tables, billing, orders board, shell)

**D-OPS2-01 · One adjustment attempt, one row, and a way back out.**
The adjustment dialog sends `idempotency_key` and `bill_version` (D-S8-01,
both now required by the schema). The key is kept in device storage until the
server gives a definitive answer, so a retry after a lost answer replays the
same attempt instead of discounting twice; an answer of `idempotency_mismatch`
says the earlier attempt was recorded and asks the manager to check the bill.
`bill_version` is the version the dialog's numbers came from, not whatever
arrived a moment ago: a change from another device shows a notice with the new
total, and the next press applies the adjustment to that bill (the same wording
the server's `stale_version` answer produces). The running bill lists each
adjustment with who added it, when and why, and `billing.adjust` may void one
while the bill is open (`POST /visits/:id/adjustments/:adj/void`, bill version
plus a reason, idempotent, so a lost answer is simply retried). Voided
adjustments - by a manager or because their dish left the bill - stay under
"Voided adjustments" with who, when and why.

**D-OPS2-02 · A refund after checkout is stated on the bill, not implied.**
When `payment_state` is `refunded` the staff bill prints "Paid, then refunded
฿X after checkout" with the reason, who recorded it and when (from `refund`),
beside the state pill. The revision stays settled: the bill is history, not
unpaid (D-S8-04).

**D-OPS2-03 · Paper recovery takes weighed cuts and knows whose ticket it is.**
In recover mode a dish sold by weight asks for the grams written on the paper
and prices them at the approved rate (`measured.grams`, D-S8-21) - the same
arithmetic as the server, shown before the line is added; one cut is one line,
so quantity stays 1 and two cuts never stack. The picker mirrors the recovery
rule (D-S8-19): only "sold out" and "category paused" are recoverable, and only
with an approved price; anything else says why it cannot be recorded. The
`original_time` errors are answered on the field: a ticket dated before the
previous party at that table checked out names that checkout time, and a
re-used paper reference names the order it belongs to.

**D-OPS2-04 · The staff screens read the server's own counts and snapshots.**
Food at the pass is counted in dishes (`ready_dishes`) on the tiles and the
Overview, like the ticket buttons; the cuts badge uses `portions_to_weigh`
(waiting for the scale) and says so. Tickets take `requires_staff_confirm` and
`alcohol` from each order line (D-S8-20) and the board no longer loads the
public menu. The rail, the sign-in page and the Payments day follow the
server's business-day cutoff through `useBusinessToday()` (D-AD-01). The alert
floor restarts from the server's cursor after a database restore, so recycled
event ids still chime.

**D-OPS2-05 · Wording that matches what the system now does.**
Sign-in errors never mention a locked account: too many attempts answer `429
rate_limited`, and the page says how long to wait (D-S8-10). A table tile shows
"Joining locked" when its visit is PIN-locked, and the drawer says when only
rotating the PIN will unlock it (`pin_lock_requires_rotation`, D-S8-07). The QR
sheet refuses to print while `qr_base_is_local`: a banner names the address,
the Print button and the SVG downloads are disabled, and printing from the
browser menu prints that notice instead of cards nobody could scan (D-S8-09).
Neither the seating dialog nor the printed card states a PIN length any more,
and the card's "ask staff for the table code" line is left out when the
restaurant does not use one.

**D-OPS2-06 · One h1 per staff page, and filters that survive a rotation.**
The workspace header title is a paragraph on the pages that print their own h1
(the More sub-pages and the QR sheet) and an h1 everywhere else, so route focus
still lands on the page heading. The Payments summary cards sit under a
visually hidden "Summary" heading. The orders board keeps its filter row
mounted and hides it with `hidden` on phones, and a resize that would hide it
while it holds the keyboard focus opens it instead.

## Round 2: UI kit, client lib and the dev server

**D-K2-01 · The poll fallback says it is polling, and keeps trying the stream.**
`useLive()` now reports `transport: 'stream' | 'poll'`. After four stream
failures the client used to poll every 5 s for good (a server restart longer
than about 12 s triggered nothing else) while every indicator still read
"Live". The poll loop now re-opens the stream as a trial (30 s, then 60 s,
then every 2 minutes) and keeps polling until that trial says hello; the
staff pill and the Track pill read "อัปเดตทุก 5 วินาที" / "Updating every 5s"
with the dash shape, never "Live", while polling. A poll that is answered
counts as a sync, so the time beside the state keeps up. Checked on the
running app: four stream errors put it on the 5-second loop within 2 s, the
trial 30 s later took over and polling stopped
(`var/scratch/fix-kit2/polling.ts`).

**D-K2-02 · The stream's own health, not the browser's opinion.**
`online` no longer waits for four failures: a stream that is OPEN goes
straight back to 'live' and refetches, a CONNECTING one reports
'reconnecting', and with no stream the client polls at once. Every delivered
event also sets 'live', so a blip the stream survived cannot leave ordering
blocked (D-G-04's provider half, widened). An SSE comment never reaches JS,
so the client watches for a named `ping` event instead: once the server sends
one, three times the announced interval (at least 45 s) of silence counts as
a dead stream and it reconnects. Until a server sends pings the watchdog
stays disarmed - a quiet 50 s stream was left alone in testing. **Server
side:** `event: ping` on the 15-second wake, and `ping_ms` in the hello data,
are still to be added (server/lib/events.ts).

**D-K2-03 · A staff stream that ends asks /me before believing it.**
The server ends a staff stream with `access {state:'ended'}` (signed out,
deactivated) or `{state:'changed'}` (same person, other permissions). The
client reconnects on 'changed' - the old stream would never carry the new
topics - and on 'ended' re-checks `GET /api/staff/auth/me`: a 401 or 403
means the session really is gone (state 'ended', `onEnded`), while a session
that is still valid reconnects, at most three times. A poll answered 401 for
staff ends the same way. Checked: taking `reports.view` from the manager role
mid-stream reconnected within 2 s and kept the pill live; signing out from
the page ended it and the shell showed the sign-in form.

**D-K2-04 · The live client reports a server outage itself.**
`useLive().outage` is `{ since }` once reads keep failing for more than 8 s
with the device online (a gateway answer, a timeout, no answer), and null the
moment anything answers. The shell no longer needs to guess from
'reconnecting' alone. Every connection indicator carries `data-outage` while
it is set. Checked by refusing every API request to a page: the mark appeared
after about 13 s and cleared on the first answer.

**D-K2-05 · The server's cursor is taken as it is, not as a maximum.**
`syncCursor` gained `authoritative` (hello, the `resync` event, a poll
answered with `resync`) and `replay` (a hello that replayed from this page's
own Last-Event-ID). An authoritative cursor is taken even when it is lower;
a lower one without a replay still means the database was restored, and then
the seen ids are cleared as before. Covered by two more cases in
`test/unit/live-cursor.test.ts`.

**D-K2-06 · Repeated buttons carry a name, and the actor gets a line.**
A board of tickets and a grid of tiles repeat one word ("Details",
"Accept · 5"). `TicketAction` and `TileAction` now take `ariaLabel`, and
without one the kit composes "Accept · 5, table 07, round 2" - the visible
label first (WCAG 2.5.3), then what it acts on (2.4.6). The ⋯ button and the
conflict "Review" link are named the same way. Pass `ariaLabel: null` to keep
the bare label. In a ticket's per-line status row, who recorded the step is
now a line of its own ("โดย Demo Kitchen"), so a staff name no longer wraps
mid-name after "Ready · 19:46". `WorkspaceHeader` takes `titleAs`, so a page
that prints its own h1 can make the workspace title a paragraph.

**D-K2-07 · "New · 3" carries the weight of the New column.**
A segmented option can ask for `emphasis`: its count becomes an ink chip.
The board status switch sets it while rounds wait to be accepted, matching
the ink head of the New column, and names that segment "New · 3 waiting to be
accepted".

**D-K2-08 · The toast steps out of the way of the focused control.**
The toast region moves to the top of the screen when it would cover whatever
has just taken keyboard focus, and closes if it would cover it at both edges
(WCAG 2.4.11). It clears any pinned top bar. This was the last case of the
obscured-focus finding: the 4-second welcome toast sat over the rows being
tabbed through, and at 320x256 over most of the page.

**D-K2-09 · Shared copy: honest steps, plain words.**
`track.step.received` / `confirmed` are "ส่งถึงร้านแล้ว" and "ร้านยืนยันแล้ว"
(two different facts, not two names for one), `status.submitted` is
"รอพนักงานยืนยัน", and a rejection no longer blames the kitchen in English.
"Staff are on their way" was a promise nobody made: an acknowledged request
now reads "Seen by staff". The Thai portion copy drops the paperwork word
"ใบเสนอ" and `common.honestStatus` drops "ระบบไม่เดาเวลา"; the staff header
says "อัปเดต 19:52" instead of "ซิงก์". New: `conn.polling`,
`track.step.confirmedAt` / `readyAt` (optional "Confirmed 19:41" lines),
`common.ticket.by`, `common.ticket.actionAria`, `common.tile.actionAria`,
`common.board.waitingAccept`.

**D-K2-10 · The double rule is opaque wherever it is used.**
`--rule-double` lays its translucent second line over an opaque canvas line,
so rows scrolling under a sticky header never show through it (the fix the
guest masthead had made for itself).

**D-K2-11 · `vite.config.ts` protects a bare `npx vite`.**
The file-serving allow-list and deny-list that `npm run dev` sets
(scripts/vite-dev.ts) are in the config file too, so `npx vite` does not hand
out the database, `server/`, `scripts/`, `data-src/`, `test/`, `docs/`,
`package.json` or `.env.example` over `/@fs/` on the LAN. Checked against a
bare `npx vite`: 403 for each of those, 200 for `client/`, `shared/`,
`public/` and `node_modules/`. Both proxy entries set `xfwd: true`, so the API
behind them (`TRUST_PROXY_HOPS=1`) sees each phone's own address. Production
source maps are built as `hidden`: no `sourceMappingURL` is emitted, so
nothing asks the server for a map it refuses to serve.

**D-DT-09 · What the delivery documents claim after round 2.**
The second review round added endpoints and fields in every area, so the four
delivery documents were re-checked against the code and the runs, not against
the review notes:
- **API.md** now carries every round-1 and round-2 change: the adjustment void
  endpoint and its idempotency and version fields, the bill's `payment_state`
  and `refund`, the guest feedback window and its eligibility route, the
  owner's feedback list (its `from` / `to` are required), `pin_digits`, the
  alert-sound default, `portions_to_weigh` and the dish counts, the order
  line's `alcohol` / `requires_staff_confirm` / `prep_kind` / `money_hidden`,
  paper recovery with `measured.grams`, the service cooldown, search aliases,
  the settings version check and the demo-account switch, `retention_status`,
  the KPI filters, and three new sections: Live events (`hello` with `epoch`,
  `access` states), Report filters, and Limits, sizes and refusals (the 413
  caps and every rate limit). Each claim was checked against the running
  server, which is how the required `from` / `to` and the extra `pin_required`
  on the QR card batch were found.
- **TESTING.md** lists this round's runs (245 unit and integration tests, both
  browser suites including the production path, 172 captures), the two new
  test files, and `npm run pdf:pages`. The stale open gaps are gone: the
  weighing note, paper recovery of unapproved prices, refunds after checkout
  and the polling fallback after a restore are all settled.
- **FEATURE-MATRIX.md** and **OWNER-CHECKLIST.md** were updated where the
  product actually changed (tickets, PIN length, service cooldown, feedback
  after checkout, aliases, demo accounts, retention status, QR warning, report
  filters), and nowhere else. What is still only "Implemented", still owner
  content, or still deferred is unchanged and still says so.
- The honesty rule from D-DT-05 stands: every "Verified" names a test, a
  journey, a capture or a rendered page, and all of it is local.

**D-RV2-01 · Round-2 re-verification: the six areas' work holds together.**
Everything the six area agents landed was re-checked as one tree, not six:
`npm run typecheck` and `npm run build` clean, `node scripts/i18n-check.ts`
with no missing keys, 245 unit and integration tests green (105 s), all 12
`npm run e2e` journeys green (282 s), 172 captures from `npm run shots` with
no failures and the same 43 known audit notes, and a production smoke on a
copy of a seeded database (`npm run build` + `NODE_ENV=production npm start`).
The cross-area contracts the client already coded against were exercised end
to end against a running instance, not read off the types: a 6-digit PIN
(`pin_digits` 6 -> six boxes over one field, "รหัส 6 หลัก"), feedback inside
the 30-minute post-checkout window (eligibility `{eligible, submitted, until}`,
`until` about 30 min, every other guest route still `visit_closed`, one entry
per session), the owner's feedback panel (`from`/`to` required, demo data out
unless asked), KPI `filters` / `filter_options` / `unfiltered` including the
CSV export and a refused unknown id, an adjustment sent twice with one
`idempotency_key` (one adjustment, unchanged total), `idempotency_mismatch`,
`stale_version`, the void endpoint and the "Voided adjustments" list, a refund
after checkout (`payment_state: 'refunded'` with amount, reason, who and
when, shown on the bill and on Payments), a paper ticket with a 380 g cut
priced at the approved rate (one cut per line, replay vs conflict on the
grams, `not_measured_weight`, `one_cut_per_line`, `before_previous_party`),
the QR print block while `qr_base_is_local` (Print disabled, no SVG
downloads, the base URL named), the owner's alert-sound default on
`/api/staff/auth/me`, and search by a reviewed alias (drafts stay out of the
guest menu). One copy fix was made here and nothing else: the Thai
`settings.retention.d` said "ไม่ถูกลบ", the only warning the i18n checker
still printed; it now reads "ระบบไม่เคยลบออร์เดอร์ บิล และการรับเงิน", so the
checker is silent. Scripts and screenshots: `var/scratch/reverify2/`.
