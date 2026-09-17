# API contract

All bodies are JSON. Request schemas live in `shared/schemas.ts`, response
shapes in `shared/dto.ts`, error codes in `shared/errors.ts`
(`{ error: { code, message, details } }`). Every non-GET request must send
`X-RG-Client: 1`. Money is integer satang. Times are UTC ISO strings.

Legend: **Body** = schema name · **→** = response DTO · **perm** = staff permission.
Behaviour added by the review rounds carries its decision (`D-S8-xx`,
[DECISIONS.md](DECISIONS.md)). Optional response fields (`field?`) are new:
a client that does not read them is unaffected.

## Public (no sign-in)

| Method & path | Body | → | Notes |
| --- | --- | --- | --- |
| GET /api/health | | `{ok}` | |
| GET /api/public/config | | PublicConfigDTO | ordering state, services, analytics settings; also `business_day_cutoff_hour` and today's `business_date` (Bangkok, computed with that cutoff) and `service_cooldown_seconds` (D-S8-23) |
| GET /api/public/menu | | CatalogDTO | published catalog only, no admin fields; `ETag` = catalog version. Items carry `aliases_th` / `aliases_en` only once a reviewer approved them (D-S8-28) |
| POST /api/public/qr/resolve | QrResolveBody | QrResolveDTO | rate limited; never reveals PIN, bill or orders. `pin_digits` gives the length (4–8) of *this visit's* code, or null when no PIN is asked for (D-S8-24) |
| POST /api/public/qr/join | JoinBody | GuestSessionDTO | sets `rg_guest`; PIN attempts counted per visit; lockouts escalate and the third asks for a new PIN (`pin_locked` details: `until`, or `staff_unlock_required: true` with no `until`, D-S8-07). Only failed joins use the per-address budget (D-S8-10) |
| POST /api/analytics/batch | AnalyticsBatchBody | `{accepted, duplicates, rejected}` | guest cookie optional; opt-out respected; never blocks ordering |

## Guest (cookie `rg_guest`, valid only for an open/billing visit)

Access errors: `visit_access_required` (401), `visit_access_revoked` (401), `visit_closed` (410, cookie cleared).

One exception (D-S8-22): for 30 minutes after checkout closed the visit, the two feedback routes still accept the session checkout revoked. Every other route answers `visit_closed`, and the cookie is cleared by the first request after the window.

| Method & path | Body | → | Notes |
| --- | --- | --- | --- |
| GET /api/guest/session | | GuestSessionDTO | |
| POST /api/guest/leave | | `{ok}` | clears this browser's cookie only |
| GET /api/guest/events | | SSE | `hello`, `change`, `resync`, `access`: see [Live events](#live-events) |
| GET /api/guest/events/poll?since= | | `{cursor, events, resync, epoch}` | polling fallback |
| POST /api/guest/quote | QuoteBody | QuoteDTO | validates a draft against the live catalog |
| POST /api/guest/orders | SubmitOrderBody | SubmitResultDTO | 201 created / 200 replayed; `cart_changed` (409, details.quote), `idempotency_mismatch`, `ordering_paused`, `table_paused`, `outside_hours`, `intake_full`, `visit_billing` |
| GET /api/guest/orders/attempts/:key | | AttemptLookupDTO | resolves an ambiguous submission |
| GET /api/guest/orders | | `{ orders: OrderDTO[], portions: PortionRequestDTO[] }` | the whole table's rounds; `mine` marks this browser's |
| GET /api/guest/service | | `{ requests: ServiceRequestDTO[] }` | |
| POST /api/guest/service | ServiceRequestBody | ServiceRequestDTO | returns the existing active request of the same type (200). A repeat of a type whose last request is younger than `service_cooldown_seconds` answers `429 rate_limited` with `details: { reason: 'service_cooldown', type, retry_after_seconds, available_at }`; the bill request is never held back (D-S8-23) |
| GET /api/guest/bill | | GuestBillDTO | |
| POST /api/guest/bill/request | BillRequestBody | GuestBillDTO | creates/returns the `bill` service request, stamps `bill_requested_at` |
| POST /api/guest/portions | PortionRequestBody | PortionRequestDTO | measured-weight cuts; idempotent |
| POST /api/guest/portions/:id/confirm | PortionConfirmBody | `{ request: PortionRequestDTO, order: OrderDTO }` | atomic; `quote_expired`, `quote_superseded` |
| POST /api/guest/portions/:id/decline | PortionDeclineBody | PortionRequestDTO | |
| POST /api/guest/portions/:id/cancel | | PortionRequestDTO | only before confirmation |
| GET /api/guest/feedback/eligibility | | FeedbackEligibilityDTO | `{ eligible, submitted, until }`: whether the form may be offered, whether this session already sent one, and when the post-checkout window ends (null while the visit is open) (D-S8-22) |
| POST /api/guest/feedback | FeedbackBody | `{ok}` | optional, one per guest session; also accepted for 30 minutes after checkout (D-S8-22) |

## Staff (cookie `rg_staff`)

### Auth, streams, overview
| Method & path | Body | → | perm |
| --- | --- | --- | --- |
| POST /api/staff/auth/login | LoginBody | StaffMeDTO | – (a wrong password is `invalid_credentials`; a used-up budget or a locked account is `429 rate_limited` with `details.retry_after_seconds`, so the answer never says whether the username exists. `account_locked` is no longer returned, D-S8-10) |
| POST /api/staff/auth/logout | | `{ok}` | – |
| GET /api/staff/auth/me | | StaffMeDTO | signed in; carries the owner's alert-sound default as `sound_default` and `notifications.sound_default` (D-S8-20) |
| GET /api/staff/events (+ /poll) | | SSE | signed in; topics filtered by role; ends with `access` when the session is revoked or its permissions change: see [Live events](#live-events) |
| GET /api/staff/overview | | OverviewDTO | orders.view; adds `ready_dishes` (quantities, not lines) and `portions_to_weigh` (cuts still `requested`, a subset of `open_portion_requests`) (D-S8-20) |

### Orders and fulfilment (S3)
| Method & path | Body | → | perm |
| --- | --- | --- | --- |
| GET /api/staff/orders?scope=active\|history&status=&table=&station=&date=&limit= | | `{ orders: StaffOrderDTO[], server_time }` | orders.view |
| GET /api/staff/orders/:id | | StaffOrderDTO | orders.view |
| POST /api/staff/orders/transition | TransitionBody | `{ orders: StaffOrderDTO[] }` | by target: accepted/rejected → orders.accept; preparing/almost_done/ready → orders.prepare; served → orders.serve; cancelled → orders.cancel_unstarted (from accepted) or orders.cancel_started; backward → orders.correct. All-or-nothing; any stale line → `stale_version` with current orders |
| POST /api/staff/orders/:id/finish | FinishOrderBody | StaffOrderDTO | orders.serve (+ cancel perms for cancel resolutions) |
| POST /api/staff/orders/quote | StaffQuoteBody | QuoteDTO | orders.assist |
| POST /api/staff/orders/assist | AssistOrderBody | SubmitResultDTO | orders.assist (source `staff`) |
| POST /api/staff/orders/recover | RecoverOrderBody | SubmitResultDTO | orders.recover_manual (source `manual_recovery`; `already` sets line status without re-sending to the kitchen). A line may carry `measured: { grams }` for a cut weighed at the counter: priced at the approved rate, quantity 1 (D-S8-21). `placed_at` before the previous party's checkout at that table is `validation_failed` / `before_previous_party` (D-S8-15) |

Every staff order line carries what the ticket needs, snapshotted when the round was sent: `prep_kind` (`cook` | `prepare`, D-S8-18), and `alcohol` / `requires_staff_confirm` (D-S8-20; guest views do not carry these). Staff without `orders.view_bill_values` receive every amount as 0 with `money_hidden: true`, on the board, the detail and every transition, finish or recovery answer (D-S8-17).

### Service requests and portions (S4)
| Method & path | Body | → | perm |
| --- | --- | --- | --- |
| GET /api/staff/service?scope=active\|all&date= | | `{ requests: ServiceRequestDTO[] }` | service.handle |
| POST /api/staff/service/:id/transition | ServiceTransitionBody | ServiceRequestDTO | service.handle (cancel → service.cancel) |
| GET /api/staff/portions?scope=open\|all | | `{ requests: PortionRequestDTO[] }` | portions.quote |
| POST /api/staff/portions | StaffPortionRequestBody | PortionRequestDTO | portions.quote |
| POST /api/staff/portions/:id/quote | PortionQuoteBody | PortionRequestDTO | portions.quote (new revision; supersedes the active one) |
| POST /api/staff/portions/:id/confirm-in-person | PortionInPersonBody | `{ request, order }` | portions.confirm_in_person |
| POST /api/staff/portions/:id/cancel | PortionCancelBody | PortionRequestDTO | portions.quote |

### Tables, QR and visits (S2)
| Method & path | Body | → | perm |
| --- | --- | --- | --- |
| GET /api/staff/tables | | TablesDTO | tables.view; also `qr_base_url` and `qr_base_is_local` (true when the printed cards would open on this computer only, so the screen can warn before printing) and, per dining tile, `ready_dishes` / `unresolved_dishes` quantities and the visit's `pin_locked` (D-S8-09, D-S8-20) |
| POST /api/staff/tables | CreateTableBody | TableTileDTO | tables.manage |
| PATCH /api/staff/tables/:id | UpdateTableBody | TableTileDTO | tables.manage (ordering_paused alone: ordering.pause) |
| POST /api/staff/tables/:id/rotate-qr | RotateQrBody | TableTileDTO | tables.qr_rotate |
| GET /api/staff/tables/:id/qr.svg | | image/svg+xml | tables.view |
| GET /api/staff/tables/qr-cards?ids=a,b | | `{ cards: [{ table_id, label, url, svg }], qr_base_url, qr_base_is_local, pin_required }` | tables.view |
| POST /api/staff/tables/:id/visits | OpenVisitBody | VisitDetailDTO | visits.open |
| GET /api/staff/visits/:id | | VisitDetailDTO | tables.view (PIN only with visits.open; money only with billing.view); `pin_locked_until` and `pin_lock_requires_rotation` show a locked join PIN (D-S8-07) |
| PATCH /api/staff/visits/:id | UpdateVisitBody | VisitDetailDTO | visits.covers |
| POST /api/staff/visits/:id/rotate-pin | VersionBody | VisitDetailDTO | visits.pin_rotate |
| POST /api/staff/visits/:id/revoke-guests | VersionReasonBody | VisitDetailDTO | visits.revoke_guests |
| POST /api/staff/visits/:id/transfer | TransferVisitBody | VisitDetailDTO | visits.transfer |

### Billing, payments and checkout (S5)
| Method & path | Body | → | perm |
| --- | --- | --- | --- |
| GET /api/staff/visits/:id/bill | | StaffBillDTO | billing.view. `paid` follows a settlement still in force; `payment_state` (`none` \| `paid` \| `reversed` \| `refunded`) and `refund` `{ amount_minor, reason, by, at }` report a refund after checkout as history, not as "unpaid" (D-S8-04). `adjustments` and `voided_adjustments` are listed separately (D-S8-01) |
| POST /api/staff/visits/:id/billing/start | VersionBody | StaffBillDTO | billing.start (visit → billing; blocks ordering) |
| POST /api/staff/visits/:id/billing/reopen | VersionReasonBody | StaffBillDTO | billing.reopen (supersedes payable revision) |
| POST /api/staff/visits/:id/bill/finalize | FinalizeBillBody | StaffBillDTO | billing.finalize (`unresolved_orders` if submitted lines remain; `bill_changed` if total differs) |
| POST /api/staff/visits/:id/adjustments | AdjustmentBody | StaffBillDTO | billing.adjust (only while not finalized). Send `idempotency_key` (same key and details replay; other details → `idempotency_mismatch`) and `bill_version` (a newer bill → `stale_version` with the current bill). Both are optional in the schema only so an older client keeps working (D-S8-01) |
| POST /api/staff/visits/:id/adjustments/:adj/void | `{ bill_version, reason }` | StaffBillDTO | billing.adjust; voids one adjustment while the bill is open. A dish leaving the bill voids its linked comps by itself (D-S8-01) |
| POST /api/staff/visits/:id/payments | PaymentBody | StaffBillDTO | payments.confirm (idempotent; one settlement per revision; `amount_mismatch`) |
| POST /api/staff/payments/:id/reverse | ReversePaymentBody | StaffBillDTO | payments.correct |
| POST /api/staff/visits/:id/checkout | CheckoutBody | CheckoutResultDTO | checkout.complete (exception_reason → visits.close_exception); idempotent |
| GET /api/staff/payments?date=&status= | | `{ payments: PaymentDTO[], exceptions: [...] }` | payments.view |

### Catalog (S1)
| Method & path | Body | → | perm |
| --- | --- | --- | --- |
| GET /api/staff/menu | | AdminCatalogDTO | menu.view |
| POST /api/staff/menu/items | CreateItemBody | AdminItemDTO | menu.edit (always created as draft) |
| PATCH /api/staff/menu/items/:id | UpdateItemBody | AdminItemDTO | menu.edit (price change → price_history + review_status needs_review). `prep_kind` (`cook` \| `prepare` \| null = the category's, D-S8-18); `aliases_th` / `aliases_en` (≤12 each, ≤60 characters) with `aliases_verified` set by `menu.review` only — any other edit clears it, and guests search only verified aliases (D-S8-28) |
| POST /api/staff/menu/items/:id/availability | AvailabilityBody | AdminItemDTO | menu.availability |
| POST /api/staff/menu/items/:id/status | ItemStatusBody | AdminItemDTO | menu.publish (`publish_blockers` enforced) |
| POST /api/staff/menu/items/:id/review | ReviewBody | AdminItemDTO | menu.review |
| POST /api/staff/menu/categories | CategoryInput | AdminCatalogDTO | menu.edit |
| PATCH /api/staff/menu/categories/:id | UpdateCategoryBody | AdminCatalogDTO | menu.edit (ordering_paused alone: ordering.pause); takes `prep_kind` for its dishes (D-S8-18) |
| POST /api/staff/menu/modifier-groups | ModifierGroupInput | AdminCatalogDTO | menu.edit |
| PATCH /api/staff/menu/modifier-groups/:id | ModifierGroupInput + version | AdminCatalogDTO | menu.edit (response lists affected items) |
| POST /api/staff/menu/reorder | ReorderBody | AdminCatalogDTO | menu.edit (menu_placement_log) |
| POST /api/staff/menu/flags/:id/resolve | ResolveFlagBody | AdminItemDTO | menu.review |
| GET /api/staff/menu/export.csv | | text/csv | menu.view (carries `aliases_th` / `aliases_en`, `\|`-separated) |
| GET /api/staff/menu/import-template.csv | | text/csv | menu.import |
| POST /api/staff/menu/import/preview | ImportPreviewBody | `{ batch_id, rows, errors, summary }` | menu.import (body cap 8 MB; imported aliases always land unreviewed) |
| POST /api/staff/menu/import/:id/apply | | AdminCatalogDTO | menu.import (drafts only, never publishes) |
| GET /api/staff/ordering | | PublicConfigDTO['ordering'] & `{ intake_limit, backlog, oldest_unaccepted_at }` | orders.view |
| PATCH /api/staff/ordering | OrderingStateBody | same | ordering.pause |

### Insights (S6)
| Method & path | → | perm |
| --- | --- | --- |
| GET /api/staff/stats/orders?metric=&period=&anchor=&from=&to=&include_fixture= | OrderStatsDTO | stats.view |
| GET /api/staff/stats/orders/day?date=&include_fixture= | DayDrilldownDTO | stats.view (subtotal only with billing.view) |
| GET /api/staff/stats/menu?period=&anchor=&category=&direction=&measure=&include_fixture= | MenuStatsDTO | stats.view |
| GET /api/staff/stats/menu/items/:id?period=&anchor= | ItemStatsDTO | stats.view |
| GET /api/staff/stats/engagement?period=&anchor=&include_fixture= | EngagementDTO | stats.engagement. Scroll depth counts menu-route events over `scroll_sessions`; each item carries `impression_sessions` and `add_sessions`, and `add_rate` is adds per session that saw the dish (D-S8-05, D-S8-06) |
| GET /api/staff/stats/kpis?from=&to=&include_fixture=&table_id=&category_id=&staff_id= | KpiDTO | stats.view (payment figures: reports.financial). See [Report filters](#report-filters) |
| GET /api/staff/stats/export.csv?view=orders\|menu\|engagement&…&table_id=&category_id=&staff_id= | text/csv (formula-injection safe) | stats.view; the three filters apply to `view=orders&rows=order` |

### Reports, team, settings, audit (S7)
| Method & path | Body | → | perm |
| --- | --- | --- | --- |
| GET /api/staff/reports/years | | `{ years: ReportYearDTO[] }` | reports.view |
| POST /api/staff/reports/jobs | ReportJobBody | ReportJobDTO | reports.generate (financial sections only if reports.financial) |
| POST /api/staff/reports/jobs/:id/retry | | ReportJobDTO | reports.generate |
| GET /api/staff/reports/jobs/:id/download | | file | reports.view, re-checked; no public URL |
| GET /api/staff/team | | `{ users: StaffUserDTO[] }` | team.manage |
| POST /api/staff/team | CreateStaffBody | StaffUserDTO | team.manage |
| PATCH /api/staff/team/:id | UpdateStaffBody | StaffUserDTO | team.manage (cannot remove the last active owner) |
| POST /api/staff/team/:id/password | SetPasswordBody | `{ok}` | team.manage, or self with current_password |
| POST /api/staff/team/:id/revoke-sessions | | `{ok}` | team.manage |
| GET /api/staff/settings | | `{ settings, updated: Record<key, at>, future_only: string[], retention_status }` | settings.manage. `retention_status` = `{ last_run_at, raw_events_purged_through }` from the daily task (D-S8-02) |
| PATCH /api/staff/settings | SettingsPatchBody | same | settings.manage (validated per key). Two reserved fields, neither a setting: `expected_updated` `{ key: updated_at \| null }` for the keys this section edits → a key saved since answers `409 stale_version` with `details: { keys, current }` and writes nothing (D-S8-26); `deactivate_demo_staff: true` with `operating_mode: 'live'` retires the demo accounts in the same transaction and answers `deactivated_demo_staff: string[]` (alone it is `422`). Going live while a demo account is active and that field is absent is `409 demo_accounts_active` with `details: { usernames, self, real_owner, can_deactivate }` (D-S8-11, D-S8-27) |
| GET /api/staff/feedback?from=&to=&include_fixture= | | FeedbackListDTO | reports.view. `from` and `to` are **required** business dates, inclusive (a missing one is `422 validation_failed`). `{ from, to, include_fixture, count, rated, average_rating, distribution, with_comment, items, truncated?, generated_at }`, newest first, up to 500 entries; demo data only with `include_fixture=1`; comments removed by retention read as null; never pushed on the live stream (D-S8-22) |
| GET /api/staff/audit?entity_type=&entity_id=&visit_id=&actor=&from=&to=&before= | | `{ entries: AuditEntryDTO[], next_before }` | audit.view |

## Live events

`GET /api/guest/events` and `GET /api/staff/events` are Server-Sent Events; `…/events/poll?since=` is the same content for clients that cannot keep a stream open.

| Event | Data | Meaning |
| --- | --- | --- |
| `hello` | `{ cursor, server_time, replay, epoch }` | Sent first. `replay: false` means the client's `Last-Event-ID` was not usable and the cursor starts at now, so refetch. `epoch` identifies the database file: when it differs from the one the client held, the database was restored or reset and the client must take this cursor and refetch, even if its own id is higher (D-S8-31, D-K-01) |
| `change` | one WireEvent (ids and versions only: never note text, PINs or tokens) | Something the client may read changed. The SSE `id` is the cursor |
| `resync` | `{ cursor }` | More than 200 events were missed: refetch from this cursor |
| `access` | `{ state: 'ended' \| 'changed' }` | Staff only. `ended`: the session was revoked or signed out, or the account was deactivated or demoted — stop and re-check `/me`. `changed`: still signed in with a different permission set — reconnect to get the new topic filter (D-S8-08) |
| (comment) | `: keep-alive` | Every 20 s while nothing happens |

Poll answers are `{ cursor, events, resync, epoch }` with the same meanings. Topics a role may not see are filtered in SQL before the limit, so a long run of hidden events never stalls a cursor.

## Report filters

`/api/staff/stats/kpis` and `export.csv?view=orders&rows=order` take `table_id`, `category_id` and `staff_id` (an unknown id is refused, not ignored) and answer with (D-S8-25):

- `filters`: `{ table_id, category_id, staff_id }`, null meaning all;
- `filter_options`: `{ tables: [{id, label}], categories: [{id, name}], staff: [{id, name}] }`, so filtering by a colleague needs no `team.manage`;
- `unfiltered`: the keys of figures the active filters could not narrow, from `qr_adoption`, `guest_order_time`, `average_order_value`, `average_table_value`, `operational_errors`, `accept`, `ack`, `open_bills`, `payment_exceptions`, `refunds`, `totals`, `cancellations`, `hourly`, `service_requests`. A figure is narrowed only when it supports every active filter; otherwise it is computed unfiltered and named here.

The KPI answer also reports `refunds_after_checkout` `{ count, value_minor }` separately from payment exceptions (D-S8-04). Types: `client/src/admin/more/reportTypes.ts`.

## Limits, sizes and refusals

- **Body size** (before anything is read, D-S8-09): 16 KB for `/api/public/*`, 8 MB for the menu CSV preview, 128 KB for the analytics batch, 256 KB for everything else. Larger answers `413 payload_too_large` with `Connection: close`, so a keep-alive client must not send its next request on that socket.
- **Rate limits** (`429 rate_limited`, `details.retry_after_seconds`; `server/lib/ratelimit.ts`): QR resolve 30/min per address; joins 10 failed and 60 total per minute per address, 30/min per table; sign-in 10/5 min per address, 5/5 min per account from one address, 20/15 min per account, and a 15-minute account lock after 20 consecutive failures (answered as `rate_limited`, D-S8-10); guest orders 20/min, quotes 120/min, service and portions 20/min, feedback 5/min, analytics 120/min, staff mutations 600/min.
- **Repeat service requests**: `service_cooldown_seconds` (D-S8-23), above.
- **Compression and caching**: API JSON and CSV are gzipped when accepted; hashed bundles are served from a `.br` / `.gz` sibling when the build wrote one (D-DT-07); event streams are never compressed. Source maps are not served unless `SERVE_SOURCEMAPS=1`.
- **`X-Forwarded-For`** is only trusted for `TRUST_PROXY_HOPS` hops (0 by default; `npm run dev` runs its API with 1 behind Vite, D-DT-06).

## Internal module contracts

Streams import each other's domain functions only through these exports.
All are synchronous and expect to run inside `tx()` unless noted.

**server/domain/pricing.ts** (foundation): `priceCart(lines, {charges?})`,
`unavailableReason(item, cat, variants)`, `catalogVersion()`, `getItem`,
`getCategory`, `itemVariants`, `itemGroups`, `looksLikeAllergyNote`, `prepKind`, `bi`.
**server/domain/guards.ts** (foundation): `getVisit`, `getTable`,
`activeVisitForTable`, `orderingBlock`, `assertCanOrder`, `withinHours`,
`publicOrderingState`, `unacceptedRounds`.
**server/lib/reportdata.ts** (foundation): `touchReportData(businessDate)` - call
whenever a change can alter an already-reported period (late cancel,
correction, recovered order, payment reversal, adjustment).

**S1 catalog.ts**: `publicCatalog(): CatalogDTO`, `adminCatalog(): AdminCatalogDTO`,
`menuItemDTO(itemId): MenuItemDTO`, `adminItemDTO(itemId): AdminItemDTO`,
`logAvailability(itemId, available, reason, actor)`, `imageInfo(name)`.
**S2 visits.ts / tables.ts**: `tableTile(tableId): TableTileDTO`,
`listTables(): TablesDTO`, `visitDetail(visitId, staff): VisitDetailDTO`,
`revokeVisitAccess(visitId, reason, actor)` (clears PIN, revokes guest sessions),
`overview(staff): OverviewDTO`, `qrUrl(token)`, `guestSessionDTO(guest)`.
**S3 orders.ts**: `createOrder(args): { orderId, replayed }` - the only
insert path for orders and lines (guest, staff, recovery, portion quote);
`orderDTO(orderId, view)`, `listVisitOrders(visitId, view)`,
`findAttempt(visitId, key)`, `visitLineSummary(visitId): { submitted, unserved, ready, rounds, unaccepted_rounds }`.
`view` = `{ kind: 'guest', guestSessionId }` or `{ kind: 'staff', staff }`.
**S4 service.ts / portions.ts**: `createServiceRequest({ visit, type, note, idempotencyKey, guestSessionId?, staffUserId?, actor }): { request: ServiceRequestDTO, existing: boolean }`, `listVisitRequests(visitId)`,
`openRequestCount(visitId)`, `closeRequestsForCheckout(visitId, reason, actor)`,
`listVisitPortions(visitId)`, `openPortionCount(visitId)`,
`cancelPortionsForCheckout(visitId, reason, actor)`, `expireQuotes(now)`.
**S5 billing.ts / checkout.ts**: `guestBill(visitId): GuestBillDTO`,
`staffBill(visitId, staff): StaffBillDTO`, `checkoutBlockers(visitId): string[]`.
**S6 analytics.ts / stats.ts / kpi.ts**: `ingestAnalytics(batch, ctx)`,
`orderStats(q)`, `dayDrilldown(date, q)`, `menuStats(q)`, `itemStats(id, q)`,
`engagementStats(q)`, `kpis(q)`, `refreshAggregates(fromDate?, toDate?)` (not in tx).
**S7 reports.ts**: `enqueueReport(...)`, `runNextReportJob()` (async, outside tx),
`reportYears()`; **jobs/runner.ts**: `startJobs()`, `stopJobs()`.

## Integration notes (verified against the running server)

Behaviour the streams added or pinned down, beyond the tables above:

- **Status codes.** Creates answer 201 and idempotent replays 200:
  `POST /api/public/qr/join` (201 new membership, 200 this browser had
  already joined), guest orders, service requests, portions, feedback, staff
  assist/recover, open visit, tables, menu items/categories/modifier groups,
  team. `POST /api/staff/reports/jobs` and `/retry` answer 202.
- **Extra reads.** `GET /api/staff/reports/jobs/:id` (ReportJobDTO, for
  polling), `GET /api/guest/portions` (`{ requests }`), `GET /api/staff/audit?action=<prefix>`.
- **QR cards.** `GET /api/staff/tables/:id/qr.svg?download=1` serves an
  attachment and counts as the card being reprinted (clears
  `TableTileDTO.qr.reprint_required`); so does `GET /tables/qr-cards`. A plain
  `qr.svg` is a preview only.
- **CSV export.** `GET /api/staff/stats/export.csv?view=orders&rows=order`
  gives one row per round; `view=engagement&raw=1` gives raw events and needs
  `reports.export_raw`.
- **Pauses.** A restaurant or table pause, closed hours and the intake limit
  block guest AND staff-assisted rounds (423); a paused category makes its
  items unorderable for both (`cart_changed`). Only
  `POST /api/staff/orders/recover` (paper orders) bypasses them. Replays of an
  existing round always succeed.
- **Refusals that are not 409.** A disabled service type and a portion request
  for a fixed-price dish answer 400 `bad_request` with `details.reason`
  (`service_disabled`, `not_measured_weight`). Applying an import that still
  has row errors answers 422 `validation_failed` with `details.errors`.
- **Checkout twice.** A second `POST /visits/:id/checkout` on a closed visit
  returns the closed result with `replayed: true` whatever its key; a key that
  belongs to another visit is `idempotency_mismatch`.
- **Sessions.** A role change, deactivation or password reset signs that
  account out everywhere (`auth_required` on its next request).
- **Analytics.** An existing dining session may deliver its final batch for 15
  minutes after its visit closed (DECISIONS D-INT-03).
