# API contract

All bodies are JSON. Request schemas live in `shared/schemas.ts`, response
shapes in `shared/dto.ts`, error codes in `shared/errors.ts`
(`{ error: { code, message, details } }`). Every non-GET request must send
`X-RG-Client: 1`. Money is integer satang. Times are UTC ISO strings.

Legend: **Body** = schema name · **→** = response DTO · **perm** = staff permission.

## Public (no sign-in)

| Method & path | Body | → | Notes |
| --- | --- | --- | --- |
| GET /api/health | | `{ok}` | |
| GET /api/public/config | | PublicConfigDTO | ordering state, services, analytics settings |
| GET /api/public/menu | | CatalogDTO | published catalog only, no admin fields; `ETag` = catalog version |
| POST /api/public/qr/resolve | QrResolveBody | QrResolveDTO | rate limited; never reveals PIN, bill or orders |
| POST /api/public/qr/join | JoinBody | GuestSessionDTO | sets `rg_guest`; PIN attempts counted per visit, lockout |
| POST /api/analytics/batch | AnalyticsBatchBody | `{accepted, duplicates, rejected}` | guest cookie optional; opt-out respected; never blocks ordering |

## Guest (cookie `rg_guest`, valid only for an open/billing visit)

Access errors: `visit_access_required` (401), `visit_access_revoked` (401), `visit_closed` (410, cookie cleared).

| Method & path | Body | → | Notes |
| --- | --- | --- | --- |
| GET /api/guest/session | | GuestSessionDTO | |
| POST /api/guest/leave | | `{ok}` | clears this browser's cookie only |
| GET /api/guest/events | | SSE | `hello`, `change`, `resync`, `access` |
| GET /api/guest/events/poll?since= | | `{cursor, events, resync}` | polling fallback |
| POST /api/guest/quote | QuoteBody | QuoteDTO | validates a draft against the live catalog |
| POST /api/guest/orders | SubmitOrderBody | SubmitResultDTO | 201 created / 200 replayed; `cart_changed` (409, details.quote), `idempotency_mismatch`, `ordering_paused`, `table_paused`, `outside_hours`, `intake_full`, `visit_billing` |
| GET /api/guest/orders/attempts/:key | | AttemptLookupDTO | resolves an ambiguous submission |
| GET /api/guest/orders | | `{ orders: OrderDTO[], portions: PortionRequestDTO[] }` | the whole table's rounds; `mine` marks this browser's |
| GET /api/guest/service | | `{ requests: ServiceRequestDTO[] }` | |
| POST /api/guest/service | ServiceRequestBody | ServiceRequestDTO | returns the existing active request of the same type (200) |
| GET /api/guest/bill | | GuestBillDTO | |
| POST /api/guest/bill/request | BillRequestBody | GuestBillDTO | creates/returns the `bill` service request, stamps `bill_requested_at` |
| POST /api/guest/portions | PortionRequestBody | PortionRequestDTO | measured-weight cuts; idempotent |
| POST /api/guest/portions/:id/confirm | PortionConfirmBody | `{ request: PortionRequestDTO, order: OrderDTO }` | atomic; `quote_expired`, `quote_superseded` |
| POST /api/guest/portions/:id/decline | PortionDeclineBody | PortionRequestDTO | |
| POST /api/guest/portions/:id/cancel | | PortionRequestDTO | only before confirmation |
| POST /api/guest/feedback | FeedbackBody | `{ok}` | optional, one per guest session |

## Staff (cookie `rg_staff`)

### Auth, streams, overview
| Method & path | Body | → | perm |
| --- | --- | --- | --- |
| POST /api/staff/auth/login | LoginBody | StaffMeDTO | – |
| POST /api/staff/auth/logout | | `{ok}` | – |
| GET /api/staff/auth/me | | StaffMeDTO | signed in |
| GET /api/staff/events (+ /poll) | | SSE | signed in; topics filtered by role |
| GET /api/staff/overview | | OverviewDTO | orders.view |

### Orders and fulfilment (S3)
| Method & path | Body | → | perm |
| --- | --- | --- | --- |
| GET /api/staff/orders?scope=active\|history&status=&table=&station=&date=&limit= | | `{ orders: StaffOrderDTO[], server_time }` | orders.view |
| GET /api/staff/orders/:id | | StaffOrderDTO | orders.view |
| POST /api/staff/orders/transition | TransitionBody | `{ orders: StaffOrderDTO[] }` | by target: accepted/rejected → orders.accept; preparing/almost_done/ready → orders.prepare; served → orders.serve; cancelled → orders.cancel_unstarted (from accepted) or orders.cancel_started; backward → orders.correct. All-or-nothing; any stale line → `stale_version` with current orders |
| POST /api/staff/orders/:id/finish | FinishOrderBody | StaffOrderDTO | orders.serve (+ cancel perms for cancel resolutions) |
| POST /api/staff/orders/quote | StaffQuoteBody | QuoteDTO | orders.assist |
| POST /api/staff/orders/assist | AssistOrderBody | SubmitResultDTO | orders.assist (source `staff`) |
| POST /api/staff/orders/recover | RecoverOrderBody | SubmitResultDTO | orders.recover_manual (source `manual_recovery`; `already` sets line status without re-sending to the kitchen) |

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
| GET /api/staff/tables | | TablesDTO | tables.view |
| POST /api/staff/tables | CreateTableBody | TableTileDTO | tables.manage |
| PATCH /api/staff/tables/:id | UpdateTableBody | TableTileDTO | tables.manage (ordering_paused alone: ordering.pause) |
| POST /api/staff/tables/:id/rotate-qr | RotateQrBody | TableTileDTO | tables.qr_rotate |
| GET /api/staff/tables/:id/qr.svg | | image/svg+xml | tables.view |
| GET /api/staff/tables/qr-cards?ids=a,b | | `{ cards: [{ table_id, label, url, svg }] }` | tables.view |
| POST /api/staff/tables/:id/visits | OpenVisitBody | VisitDetailDTO | visits.open |
| GET /api/staff/visits/:id | | VisitDetailDTO | tables.view (PIN only with visits.open; money only with billing.view) |
| PATCH /api/staff/visits/:id | UpdateVisitBody | VisitDetailDTO | visits.covers |
| POST /api/staff/visits/:id/rotate-pin | VersionBody | VisitDetailDTO | visits.pin_rotate |
| POST /api/staff/visits/:id/revoke-guests | VersionReasonBody | VisitDetailDTO | visits.revoke_guests |
| POST /api/staff/visits/:id/transfer | TransferVisitBody | VisitDetailDTO | visits.transfer |

### Billing, payments and checkout (S5)
| Method & path | Body | → | perm |
| --- | --- | --- | --- |
| GET /api/staff/visits/:id/bill | | StaffBillDTO | billing.view |
| POST /api/staff/visits/:id/billing/start | VersionBody | StaffBillDTO | billing.start (visit → billing; blocks ordering) |
| POST /api/staff/visits/:id/billing/reopen | VersionReasonBody | StaffBillDTO | billing.reopen (supersedes payable revision) |
| POST /api/staff/visits/:id/bill/finalize | FinalizeBillBody | StaffBillDTO | billing.finalize (`unresolved_orders` if submitted lines remain; `bill_changed` if total differs) |
| POST /api/staff/visits/:id/adjustments | AdjustmentBody | StaffBillDTO | billing.adjust (only while not finalized) |
| POST /api/staff/visits/:id/payments | PaymentBody | StaffBillDTO | payments.confirm (idempotent; one settlement per revision; `amount_mismatch`) |
| POST /api/staff/payments/:id/reverse | ReversePaymentBody | StaffBillDTO | payments.correct |
| POST /api/staff/visits/:id/checkout | CheckoutBody | CheckoutResultDTO | checkout.complete (exception_reason → visits.close_exception); idempotent |
| GET /api/staff/payments?date=&status= | | `{ payments: PaymentDTO[], exceptions: [...] }` | payments.view |

### Catalog (S1)
| Method & path | Body | → | perm |
| --- | --- | --- | --- |
| GET /api/staff/menu | | AdminCatalogDTO | menu.view |
| POST /api/staff/menu/items | CreateItemBody | AdminItemDTO | menu.edit (always created as draft) |
| PATCH /api/staff/menu/items/:id | UpdateItemBody | AdminItemDTO | menu.edit (price change → price_history + review_status needs_review) |
| POST /api/staff/menu/items/:id/availability | AvailabilityBody | AdminItemDTO | menu.availability |
| POST /api/staff/menu/items/:id/status | ItemStatusBody | AdminItemDTO | menu.publish (`publish_blockers` enforced) |
| POST /api/staff/menu/items/:id/review | ReviewBody | AdminItemDTO | menu.review |
| POST /api/staff/menu/categories | CategoryInput | AdminCatalogDTO | menu.edit |
| PATCH /api/staff/menu/categories/:id | UpdateCategoryBody | AdminCatalogDTO | menu.edit (ordering_paused alone: ordering.pause) |
| POST /api/staff/menu/modifier-groups | ModifierGroupInput | AdminCatalogDTO | menu.edit |
| PATCH /api/staff/menu/modifier-groups/:id | ModifierGroupInput + version | AdminCatalogDTO | menu.edit (response lists affected items) |
| POST /api/staff/menu/reorder | ReorderBody | AdminCatalogDTO | menu.edit (menu_placement_log) |
| POST /api/staff/menu/flags/:id/resolve | ResolveFlagBody | AdminItemDTO | menu.review |
| GET /api/staff/menu/export.csv | | text/csv | menu.view |
| GET /api/staff/menu/import-template.csv | | text/csv | menu.import |
| POST /api/staff/menu/import/preview | ImportPreviewBody | `{ batch_id, rows, errors, summary }` | menu.import |
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
| GET /api/staff/stats/engagement?period=&anchor=&include_fixture= | EngagementDTO | stats.engagement |
| GET /api/staff/stats/kpis?from=&to=&include_fixture= | KpiDTO | stats.view (payment figures: reports.financial) |
| GET /api/staff/stats/export.csv?view=orders\|menu\|engagement&… | text/csv (formula-injection safe) | stats.view |

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
| GET /api/staff/settings | | `{ settings, updated: Record<key, at>, future_only: string[] }` | settings.manage |
| PATCH /api/staff/settings | SettingsPatchBody | same | settings.manage (validated per key) |
| GET /api/staff/audit?entity_type=&entity_id=&visit_id=&actor=&from=&to=&before= | | `{ entries: AuditEntryDTO[], next_before }` | audit.view |

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
