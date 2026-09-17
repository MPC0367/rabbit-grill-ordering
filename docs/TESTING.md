# Testing

Automated tests for the ordering platform: focused integration tests over real
HTTP against a real server process, plus unit tests for the money and
Bangkok-time modules. Brief section 31 asks for exactly this split: automated
integration tests for authorization, money, state transitions and
idempotency; end-to-end tests for the browser journeys.

## Latest result

| Run (2026-09-17) | Command | Tests | Pass | Fail | Skipped | Duration |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `node --test --test-concurrency=1 --test-reporter=spec "test/unit/**/*.test.ts" "test/integration/**/*.test.ts"` | 174 | 174 | 0 | 0 | 87.2 s |
| 2 | `npm test` | 174 | 174 | 0 | 0 | 86.5 s |
| 3 | `npm test` | 174 | 174 | 0 | 0 | 86.9 s |

Runs 2 and 3 ran back to back on the final code, and both passed 174 of 174.
The runs used Windows 11, Node 24.20.0 and the installed Microsoft Edge, so
the PDF tests really printed PDFs. `npm run typecheck` shows no errors in
`server/`, `shared/`, `scripts/` or `test/`. The only errors it reports are
in `client/src/admin/*` files that the client streams are still building
(missing `admin/menu` tabs and one `BoardView.tsx` type), which this suite
does not load.

Totals: 148 integration tests in 14 files and 26 unit tests in 6 suites, in
one file.

## How to run

Prerequisites: Node 24 or newer, `npm install`, and for the PDF tests an
installed Edge or Chrome. The PDF code looks in the standard install paths, or
at `BROWSER_PATH` if set.

```powershell
Set-Location C:\Users\marky\NOVA\rabbit-grill\ordering
npm test                      # unit + integration, one file at a time (~90 s)
npm run test:unit             # unit only (<1 s)
node --test --test-concurrency=1 test/integration/billing.test.ts   # one file
npm run typecheck
```

- **Use PowerShell (or any normal desktop shell) on Windows.**
  `reports.test.ts` launches the browser to print the annual PDF. Its two PDF
  tests call `t.skip` with the reason when the report job fails with
  `browser_unavailable`. They do not fail in that case.
- **Keep `--test-concurrency=1`.** Each file starts its own server, so files
  could run in parallel. Serial runs keep timing-sensitive race tests and the
  PDF job away from CPU contention.
- **Avoid the few minutes around 00:00 Bangkok time.** The insights and
  engagement tests measure "today" as before/after differences. The one test
  that plants rounds at 00:00:30 and 23:59:30 skips itself from 23:58 to
  00:01. The
  other date-based tests assume the business date does not change during a
  run of about 90 seconds.
- **No external services are needed.** Everything runs on 127.0.0.1 with
  temporary SQLite files.

## How the harness works

`test/helpers/harness.ts`:

- **One server per file.** `startServer()` builds a fresh database with the
  deterministic fixtures in `test/helpers/fixtures.ts`, in a child process.
  It then starts `node server/main.ts` on a free port (live mode, PIN
  required) and waits for `/api/health`.
- **Clients.** `srv.staff(role)`, `srv.openVisit()` and `srv.guest()` give
  cookie-aware clients. `client.clone()` is a second tab on the same device;
  `srv.client()` is another device.
- **Database access.** `srv.sql()` reads the database for assertions.
  `srv.exec()` writes only historical facts the API cannot create, such as
  past dates.
- **Isolation.** Tests stay independent by using their own table, or by
  creating one through the API, and by opening a new visit.
- **One phone, one address.** Most files start the server with
  `TRUST_PROXY_HOPS=1` and give each simulated phone its own
  `X-Forwarded-For` address. The join limit is 10 per minute per address, so
  a whole file joining from 127.0.0.1 would be throttled.
  `access.test.ts` proves that limit separately.
- **Races.** Races use `Promise.all` over separate clients. The long races in
  `concurrency.test.ts` repeat 4 to 12 times with a rotating stagger and
  print which outcome won each time (`ℹ` lines). The assertions accept only
  the documented consistent end states.

## Files

| File | Tests | Time* | What it proves |
| --- | --- | --- | --- |
| `test/unit/money-time.test.ts` | 26 | <1 s | Half-up rounding, measured-weight amounts, the included-side allowance, line totals, the exclusive and inclusive charges policy, and money formatting. Also Bangkok business dates: midnight, cutoff hour, New Year weeks, leap days, UTC ranges and interval splitting. |
| `test/integration/smoke.test.ts` | 1 | 1 s | Harness check: the server boots with fixtures and a guest can order. |
| `test/integration/journey.test.ts` | 3 | 2 s | Scenarios 1 and 2 end to end. Details under Brief 31 below. |
| `test/integration/access.test.ts` | 19 | 10 s | Table access and visit isolation. Covers the QR code, PIN, lockout, rate limits, QR rotation, disabled tables, leaving, session expiry, revocation, CSRF and secrets in logs. Also scenario 5 (queries, mutations and subscriptions) and scenario 6. |
| `test/integration/orders.test.ts` | 10 | 3 s | Scenarios 3 and 4. Also state-matrix rows: restaurant pause racing submissions, kitchen intake paused, the automatic intake limit, table pause, and a visit in billing until a manager reopens it. |
| `test/integration/pricing.test.ts` | 7 | 3 s | Scenarios 7 and 8. Also the charges policy (10% exclusive plus 7% inclusive, half-up, frozen at seating) and paper recovery never pricing a dish at 0 THB. |
| `test/integration/realtime.test.ts` | 5 | 3 s | Scenario 12. Also the stall regression for hidden events, a cursor ahead of the server, and event payloads with no notes, PINs or tokens. |
| `test/integration/billing.test.ts` | 14 | 5 s | Complete checkout (brief 36): exact blockers, revocation, PIN clearing, request resolution, table reset, lost-response replay, disabled tables, zero bills, manager exceptions, reopen, reversal, refunds, adjustments, charge snapshots, and table counts matching the tiles. |
| `test/integration/concurrency.test.ts` | 15 | 22 s | Scenarios 9, 10 and 11. Also checkout racing an order, a payment, a reversal or a portion confirmation. |
| `test/integration/roles.test.ts` | 8 | 7 s | Scenario 14: the server enforces the role matrix, and every refused request changes nothing. Includes the kitchen stream hiding payment and bill topics and the stall regression. |
| `test/integration/service.test.ts` | 11 | 3 s | Scenario 15: service-request deduplication, versioned staff handling, cancellation rules, and checkout resolving requests. Also paper-order recovery with no duplicate preparation, and feedback. |
| `test/integration/portions.test.ts` | 17 | 5 s | Brief 44A (every step and every listed test), 44B, 44D and 44F. |
| `test/integration/insights.test.ts` | 16 | 3 s | Brief 37, 38 and 43: rounds, visits and diners; shared phones; weekly bars; comparisons; New Year weeks; year clipping; rankings; availability; measured-weight servings and grams; fixture filtering; stats permissions. |
| `test/integration/engagement.test.ts` | 14 | 3 s | Brief 39 and 43: deduplication of retried telemetry, the active-chunk cap, active time versus seated time, the midnight split, opt-out, public and dining sessions, the grace window, the rate limit, funnel attribution, QR adoption, financial KPI gating, and ordering while analytics is down or disabled. |
| `test/integration/reports.test.ts` | 8 | 12 s | Brief 40, 41 and 43. Details under Brief 43 below. |

\* Sum of the test durations in run 2, excluding each file's server start of
about 1 s.

## Brief 31: acceptance scenarios

| # | Scenario | Where | Notes |
| --- | --- | --- | --- |
| 1 | Open a table, join by QR and PIN, customise, submit, another staff client sees it, fulfilment updates the guest | `journey.test.ts` "scenario 1…", "Preparing -> Ready directly…"; `smoke.test.ts` | Uses fixture table T01, not Table 07. |
| 2 | Second device: independent carts, one combined bill | `journey.test.ts` "scenario 2…"; `orders.test.ts` scenario 4 | |
| 3 | Same attempt repeated and with a lost response gives one order | `orders.test.ts` "scenario 3" (×3); `portions.test.ts` "response lost after confirmation"; `billing.test.ts` "a lost checkout response…" | |
| 4 | Different concurrent attempts are never suppressed | `orders.test.ts` "scenario 4" (×2); `journey.test.ts` scenario 2 | Identical carts under different keys stay separate rounds. |
| 5 | Tampered table or session ids are denied across queries, mutations and subscriptions | `access.test.ts` "scenario 5…", "scenario 5 (subscriptions)…", cross-site test; `roles.test.ts` "signed-out browsers and guest cookies…" | |
| 6 | New visit at the same table: old credentials reveal and change nothing | `access.test.ts` "scenario 6…"; `billing.test.ts` "complete checkout…" | |
| 7 | Prices, availability or options change after the cart is prepared | `pricing.test.ts` "scenario 7…"; `portions.test.ts` "goes out of season or sells out while in a draft…"; `journey.test.ts` (stale total gives `cart_changed`) | |
| 8 | Required modifiers, included and paid choices, quantities, rounding, cancellations, charges | `pricing.test.ts` "scenario 8" (×4) and "charges policy…"; `money-time.test.ts` | |
| 9 | Bill finalization racing a new order | `concurrency.test.ts` "Start checkout racing guest submissions…", "reopen racing finalize…", "two cashiers finalizing…"; `orders.test.ts` "a visit in billing…" | |
| 10 | Two cashiers confirming payment give one settlement | `concurrency.test.ts` "cashiers confirming the same revision…", "a payment must match…", "a guest has no way to mark the bill paid" | |
| 11 | Two staff updating one order: stale version | `concurrency.test.ts` "two staff moving the same line…", "bulk transition…", "two floor tablets finishing…"; `service.test.ts` and `portions.test.ts` versioned races | |
| 12 | Realtime down, submit over HTTP, reconnect, catch up | `realtime.test.ts` "scenario 12" (×2) and cursor tests | |
| 13 | Language switch mid-cart and while tracking | **Not covered by this suite** | See the note below. |
| 14 | Role restrictions: payments, menu, cancellations, team | `roles.test.ts` (all); `billing.test.ts` exception close; `insights.test.ts` and `engagement.test.ts` permission tests | |
| 15 | Service-request deduplication and offline manual entry without duplicate preparation | `service.test.ts` (all) | |
| 16 | Online-payment callbacks | **Not applicable** | See the note below. |

**Scenario 13: language switching (not covered).** Language is purely a
client concern:

- **Server side.** The API takes no language input: no `lang` parameter and
  no `Accept-Language` handling outside the PDF renderer. It returns
  bilingual fields (`name_th` / `name_en`). Quoting, submitting and tracking
  requests are the same in either language, so a language switch cannot
  change the visit, the chosen options or the server totals.
- **Client side.** Keeping the draft cart and the tracker open across a
  switch belongs to the browser end-to-end suite. That suite does not exist
  yet: `npm run e2e` and `npm run shots` point to `test/e2e/run.ts` and
  `test/visual/shots.ts`, which are not in the repository.

**Scenario 16: online-payment callbacks (not applicable).** The online
adapter is deferred in V1 (brief 24), and no provider is enabled:

- **The boundary.** It is in `server/domain/payments.ts`: the
  `PaymentAdapter`, `VerifiedCallback` and `PaymentAttemptInput` contracts.
  `getPaymentAdapter()` always returns `null`, even when `PAYMENT_PROVIDER`
  is set; it only logs a warning. `requirePaymentAdapter()` throws
  `payments_not_configured` (503).
- **Storage.** The tables are ready in `server/db/migrations/001_init.sql`:
  `payment_attempts` (unique `provider_ref`) and `payment_callbacks` (keyed
  by provider event id).
- **Configuration.** `PAYMENT_PROVIDER` / `PAYMENT_PROVIDER_SECRET` are read
  in `server/config.ts` and listed in `.env.example`.
- **No routes.** No route mounts the adapter, so there is no callback
  endpoint to forge, repeat or reorder.
- **Covered instead.**
  - Staff confirmation is the only way to settle:
    `concurrency.test.ts` "a guest has no way to mark the bill paid".
  - Duplicate settlements are impossible: scenario 10.
  - Payment references never leak: `roles.test.ts` and `concurrency.test.ts`.
- **When a provider is added.** Its tests must cover forged, duplicate, late,
  mismatched, missing and out-of-order callbacks in the provider's test mode.

## Brief 30: state matrix

| Condition | Where |
| --- | --- |
| No valid table authorization | `access.test.ts` "no valid authorization…" |
| Closed or rotated visit | `access.test.ts` "rotated PIN and revoked guests…", "QR rotation…", "no open visit… after its visit closes", "scenario 6…" |
| Copied permanent QR | `access.test.ts` "copied permanent QR…" |
| Item sold out during cart review | `pricing.test.ts` scenario 7 (the wine sells out); `portions.test.ts` "…sells out while in a draft…" |
| Price changed before submit | `pricing.test.ts` scenario 7; `journey.test.ts` scenario 1 (`cart_changed`) |
| Rapid repeated submission | `orders.test.ts` scenario 3 (8 concurrent sends) |
| Response lost after server commit | `orders.test.ts` "a lost response is recovered…"; `portions.test.ts`; `billing.test.ts` |
| Two guests order simultaneously | `orders.test.ts` scenario 4; `journey.test.ts` scenario 2 |
| Two staff update same item | `concurrency.test.ts` scenario 11 tests; `service.test.ts`; `portions.test.ts` |
| Network reconnect | `realtime.test.ts` |
| Kitchen intake paused | `orders.test.ts` "kitchen intake paused…", "the intake limit pauses…" |
| Partial fulfillment | `journey.test.ts` scenario 1 (`partially_served`, line-level steps) |
| Bill being finalized | `orders.test.ts` "a visit in billing…"; `concurrency.test.ts` scenario 9 tests; `portions.test.ts` "billing blocks new portion requests…" |
| Duplicate cashier confirmation | `concurrency.test.ts` "cashiers confirming the same revision…" |
| Payment callback missing, if enabled | Not applicable: online payments are deferred (scenario 16) |
| Backend unreachable | Server side: paper-order recovery in `service.test.ts`. The client's offline state is not covered here (browser suite). |
| Table reused by new party | `access.test.ts` "scenario 6…"; `billing.test.ts` "complete checkout…" |

## Brief 43: additional acceptance criteria

| Criterion | Where |
| --- | --- |
| Image- and description-led menu; missing content surfaced in admin | Not covered here (visual QA and catalog review) |
| Almost done only after staff input; drink wording; partial timelines | `journey.test.ts` (both tests); `portions.test.ts` "one shared cut plus separately prepared drinks…" |
| Finish order changes fulfilment only; Complete checkout validates, closes, revokes and resets | `billing.test.ts` "finish order changes fulfilment only…", "checkout refuses with the exact remaining blockers…", "complete checkout…", "a disabled table stays Disabled…"; `concurrency.test.ts` "two floor tablets finishing…" |
| Checkout racing an order or cashier action ends in one state; stale guests cannot submit to the new visit | `concurrency.test.ts` checkout races; `access.test.ts` "scenario 6…" |
| Available / Dining / Checking out counts match the grid on two staff clients | `billing.test.ts` "Available, Dining and Checking out counts reconcile…" |
| Three rounds = three rounds and one visit; four covers = four diners | `insights.test.ts` test 1 |
| One shared phone is never two people; missing covers visible | `insights.test.ts` test 2 |
| Weekly bars: today partial, future days, zero, missing, prior zero, cross-year | `insights.test.ts` tests 3–8 |
| Rankings: zero-order items, drafts excluded, ties, archived and renamed items, sold-out disclosure | `insights.test.ts` tests 9–12 |
| Active time pauses and deduplicates; excludes dining duration; ordering works without analytics | `engagement.test.ts` tests 1–5, 13, 14 |
| Funnel: quick-add, multiple devices, missing telemetry, staff-assisted | `engagement.test.ts` "funnel attribution…", "QR adoption…" |
| New Year: active year changes without deleting facts, logging guests out or changing open orders | `reports.test.ts` "the New Year rollover…"; `insights.test.ts` "the year view is clipped…" |
| Annual totals match the snapshot; old reports downloadable; late corrections create a revision | `reports.test.ts` "the annual data export…", "a late cancellation…", "a revised report…" |
| PDF: Thai fonts, appendices, coverage; exports do not freeze service | `reports.test.ts` "the annual PDF…", "an identical request while a report is generating…" |
| Visual QA of guest menu, tracker, table grid, weekly chart, rankings and report | Not covered here (browser and visual suites) |

Brief 43 checks that are only partly proven:

- **The PDF test.** It checks the PDF structure, the embedded fonts (only
  Noto Sans Thai, Oswald and Cormorant; no system fallback) and real Thai
  text. The snapshot tests check the report data (coverage and totals). The
  printed appendix layout is left to visual review.
- **The "service not frozen" check.** It only runs when the test catches the
  job while it is generating. The test prints which case happened. In runs 2
  and 3, an order went through in 15 ms while the PDF was generating.

## Brief 44: grill-specific rules

| Section | Where |
| --- | --- |
| A. Weight-priced cuts | `portions.test.ts` covers every numbered step and every test in the brief's list: duplicate request, double confirmation, changed revision, expired quote, two staff edits, closure while pending, lost response after confirmation, in-person confirmation, and fixed-price dishes while a request is pending. Also rate approval and half-up rounding. `pricing.test.ts` checks that a measured cut can never be a cart line. `money-time.test.ts` covers `measuredAmount`. |
| B. Doneness, sides, sharing | `journey.test.ts` scenario 1 (required doneness; included, upgraded and paid sides); `pricing.test.ts` scenario 8; `portions.test.ts` "different doneness on two steaks…"; `money-time.test.ts` `allocateGroupPicks` |
| C. Variants and alcohol | `pricing.test.ts`: hot and iced variants, unavailable decaf, variant-specific prices at submission. The alcohol flag (fixture wine, `requires_staff_confirm`) takes part in the pricing and sold-out tests. Legal eligibility rules are not modelled. |
| D. Seasonal items and promotions | `portions.test.ts` "an item that goes out of season or sells out while in a draft…" (an expired seasonal category gives `cart_changed`; accepted orders keep their snapshot). The beer promotion is kept as an unorderable source record (D-09), and V1 has no promotional pricing to test. |
| E. Menu organization | Not covered here (catalog and client) |
| F. Grill insights and checks | `insights.test.ts` "measured-weight cuts count servings…", "the item detail shows… the weighed-cut funnel"; `portions.test.ts` (an unconfirmed request is not a sale); `portions.test.ts` and `concurrency.test.ts` for the listed cases (shared cut plus drinks, two doneness levels, included versus upgraded sides, seasonal expiry, quote racing checkout, in-person confirmation) |

## Server bugs found by this suite (all fixed)

| File | Bug | Fix |
| --- | --- | --- |
| `server/lib/events.ts` | Topics hidden from a role were filtered *after* `LIMIT 200`. A run of 200 or more hidden events (e.g. `bill.updated` on a kitchen tablet) returned nothing, so the cursor never moved and new orders never reached that board. | Filter in SQL before the limit. Regression tests are in `realtime.test.ts` and `roles.test.ts`. |
| `server/lib/events.ts` | A client cursor ahead of the newest event (after a database restore or reset) silently skipped new events. | The stream restarts from the latest event without replaying. Poll answers `resync: true` with the real cursor. |
| `server/domain/pricing.ts` | A line with no current price (missing or unavailable variant, weighed cut) also got a false `price_changed` issue showing "0". | Compare prices only when the line has one. |
| `server/routes/orders.ts` | Paper-order recovery recorded a published dish with a withdrawn price at 0 THB when its category was paused or it was sold out. | Any fixed-price dish without a price needs review. |
| `server/domain/kpi.ts`, `server/domain/export/snapshot.ts` | A correctly closed zero-total bill counted as a payment exception (count 1, value 0) on the KPI screen and in the annual report. | Count a missing settlement only when the total is above zero (DECISIONS D-T3-01). |
| `server/domain/pdf/fonts.ts` | The display and serif font stacks (Latin-only Oswald and Cormorant) had no Thai fallback, so Thai text and ฿ printed in a system font such as Tahoma (blank boxes on servers without Thai fonts). | Both stacks fall back to the embedded Noto Sans Thai. |
| `server/domain/pdf/styles.ts` | `<code>` in the event-type table used the browser's monospace font, so Consolas was embedded. | `code { font-family: 'RG Sans', sans-serif }`. |

Test tooling: `npm test` now runs the unit and integration suites (it used to
run integration only), and `npm run test:unit` was added.

## Open questions and known gaps

These are documented by the tests as current behaviour, or reported without
an assertion. None of them fails the suite.

- **Polling fallback after a restore.** The server now returns a lower
  cursor, but `client/src/lib/live.tsx` keeps `cursor = Math.max(...)` and
  ignores it. This needs a client fix.
- **Paper recovery of unapproved prices.** A paused category takes priority
  over "not verified". Paper recovery can therefore record an unverified
  dish, or one whose new price the owner hasn't approved, at that price.
  D-25 only excuses sold-out and paused items. `pricing.test.ts` asserts
  neither behaviour.
- **Weighing note visible to guests.** The guest's portion quote includes
  the staff weighing note (`quote.note`). This may be intentional (brief 44A).
- **Refund after checkout.** The staff bill still reads paid / settled, while
  the KPI screen and the payments list treat the refund as an exception.
  This needs an owner decision (`billing.test.ts` line ~704).
- **Exception close from Dining.** A manager's exception close from a table
  still in Dining answers `invalid_transition`: the table must be moved to
  Checking out first. This is a product question (`billing.test.ts`
  line ~504).
- **Over-long active-time chunk.** The brief says reject it. The server
  follows D-S6-08: 120 s to 24 h is capped at 120 s; longer, longer than the
  session, or 0 is rejected. The test follows D-S6-08.
- **Opt-out attribution.** Attribution uses the session's *current* opt-out
  flag, so opting back in under the same session id would attribute earlier
  rounds after the fact. The browser client always starts a new session
  (D-C3-01). This is worth a decision note.
- **CSV consistency.** The annual `engagement_events.csv` includes
  `visit_id`; the dashboard raw-events CSV omits it (D-S6-12). No secret is
  exposed, but the two are inconsistent.
- **PDF size.** A 20-page PDF for a year with no orders is about 7.4 MB,
  because font subsets are embedded repeatedly.
- **`divRoundHalfUp(-4, 10)` returns `-0`.** It serialises as `0`.
- **Conditional skips.** Two can occur:
  - `insights.test.ts` "the current week is compared…" skips from 23:58 to
    00:01 Bangkok time.
  - The two PDF tests in `reports.test.ts` skip if no Edge or Chrome can be
    launched.

  Neither skipped in the runs above.
- **Not covered by this suite.** Scenario 13, visual QA, the client offline
  banner, menu images and organization (44E) all need the browser
  end-to-end and screenshot suites, which are not written yet.
