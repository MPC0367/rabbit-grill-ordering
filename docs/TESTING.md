# Testing

The ordering platform has three test layers. Brief section 31 asks for this split: automated integration tests for authorization, money, state transitions and idempotency; end-to-end tests for the critical browser journeys; and visual inspection at phone, tablet and desktop widths.

| Layer | Command | What runs |
| --- | --- | --- |
| Unit and integration | `npm test` | Pure modules (money, Bangkok time, board placement, search, live cursor), and real server processes over HTTP with temporary SQLite files |
| Browser end-to-end | `npm run e2e` | Real Edge or Chrome sessions (several at once) against one seeded instance: [below](#browser-end-to-end-suite-npm-run-e2e) |
| Visual QA | `npm run shots` | Screens at 320–1440 px in both languages, audited in the page, plus a contact sheet for review: [below](#visual-qa-npm-run-shots) |

**Everything here is local.** It ran on one Windows 11 laptop (Node 24.20.0, Microsoft Edge), on `localhost` and the laptop's LAN address. No real phone, restaurant Wi-Fi, https proxy or hosted server has been tested. None of these results is a production deployment check.

## Latest result

Runs of 2026-09-17 and 18 (Bangkok), taken after the docs-and-tooling fixes while the other review-fix streams were still landing. Each run tested the working tree as it was at that moment.

| Run | Command | Tests | Pass | Fail | Skipped | Duration |
| --- | --- | --- | --- | --- | --- | --- |
| Unit + integration | `node --test --test-concurrency=1 "test/unit/**/*.test.ts" "test/integration/**/*.test.ts"` | 217 | 216 | 0 | 1 | 100.6 s |
| Browser end-to-end | `node test/e2e/run.ts --port 8771 --keep` (dev path, full synthetic year) | 12 | 12 | 0 | 0 | 283 s |
| Browser end-to-end, repeated after the last suite change | `node test/e2e/run.ts --port 8771` | 12 | 12 | 0 | 0 | 282 s |
| Browser end-to-end, production path | `node test/e2e/run.ts --port 8771 --prod --no-history` | 12 | 11 | 1 | 0 | 249 s |
| same, rerun of the failed parts | `… --prod --no-history --only files,a` | 2 | 2 | 0 | (10 not selected) | 33 s |
| Visual QA | `node test/visual/shots.ts --port 8771` | 172 captures | 0 failures | | | 545 s |
| Types | `npm run typecheck` | whole project | clean | | | |

Details:

- The e2e run used a fresh seeded instance started through `npm run dev` (instance log in `var/e2e/e2e/app.log`). Earlier runs that day failed because of the suite, not the product:
  - kitchen tablets now default to the Kitchen station, so a journey could not advance bar dishes;
  - the pause check read a field that exists in both states;
  - browser offline emulation does not drop an open event stream;
  - the file-exposure probes used paths that do not exist, and those get the app page.

  Those were fixed (D-DT-04).
- On the production path (`--prod`: `vite build`, `npm run seed`, `npm start`), the one failure was the suite's own. The test instance printed QR cards for `localhost`, and journey a correctly rejected that. The instance now uses the LAN address, as a restaurant install would, and the rerun passed. The same run checked that the built bundles are served, while source maps and missing bundles answer 404. Once, journey b also saw the board show Ready while the guest page stayed on Almost done past its 12 s wait. It has passed on every run since (a partial run of files, a, b and realtime, two full dev-path runs and the production-path run), but it is worth watching.
- The visual run's audit notes are listed under [Visual QA](#visual-qa-npm-run-shots).
- The annual report was checked separately. A 2025 PDF of the full synthetic year (`npm run jobs -- report --year 2025 --fixture --html <dir>`) came out at 520 pages and 14.4 MB in 31 s. Its print-rendered HTML was reviewed page by page: cover, year overview and appendix A, with Thai text shaped and repeated table headers. This laptop has no PDF rasteriser, so the PDF pages themselves were not viewed. `reports.test.ts` checks the PDF structure and its embedded fonts.
- The backup was checked by hand. `npm run jobs -- backup --out … --with-reports` copied a 144 MB seeded database (with its WAL) to a 138 MB file in 0.6 s while nothing else was using it. `PRAGMA integrity_check` returned `ok`, row counts matched, and a second run refused to overwrite the file. A full restore was not exercised.
- The production entry was checked by hand. `npm start` on an empty database did not seed: `demo-owner` sign-in answered 401. It warned about `NODE_ENV` and the localhost QR address. `npm run admin:create` with `RG_ADMIN_PASSWORD` then created an owner who could sign in (200).

## How to run

Prerequisites:

- Node 24 or newer, and `npm ci`
- For the PDF tests and both browser suites, an installed Edge or Chrome. It is found in the standard install paths, or at `BROWSER_PATH`.

```powershell
Set-Location C:\Users\marky\NOVA\rabbit-grill\ordering
npm test                      # unit + integration, one file at a time
npm run test:unit             # unit only (<1 s)
node --test --test-concurrency=1 test/integration/billing.test.ts   # one file
npm run typecheck

npm run e2e                   # browser journeys on a fresh seeded instance (free ports), ~5 min
npm run e2e -- --port 8771 --keep --only a,b,c   # fixed ports, keep var/e2e/e2e/, some journeys
npm run e2e -- --base http://localhost:8344      # against a running instance (its data changes)
npm run e2e -- --prod         # build + seed + npm start instead of npm run dev

npm run shots                 # screenshots + audit + test/visual/out/index.html, ~10 min
npm run shots -- guest states --port 8771 --strict
```

- **Use PowerShell (or any normal desktop shell) on Windows.** `reports.test.ts` and both browser suites launch the browser, and some sandboxed shells cannot. When the report job fails with `browser_unavailable`, the two PDF tests call `t.skip` with the reason instead of failing.
- **Keep `--test-concurrency=1`.** Each file starts its own server, so files could run in parallel. Serial runs keep timing-sensitive race tests and the PDF job away from CPU contention. Do not run the browser suites at the same time as `npm test` if you want stable timings.
- **Avoid the few minutes around 00:00 Bangkok time.** The insights and engagement tests measure "today" as before/after differences. The one test that plants rounds at 00:00:30 and 23:59:30 skips itself from 23:58 to 00:01. The other date-based tests assume the business date does not change during a run.
- **No external services are needed.** The integration suite runs on 127.0.0.1 with temporary SQLite files. The browser suites use `var/e2e/<name>/` for their database and reports, and never touch `var/rabbit-grill.db`.

## Browser end-to-end suite (`npm run e2e`)

`test/e2e/run.ts` is a `node:test` file. Its supporting files:

| File | Purpose |
| --- | --- |
| `instance.ts` | Starts a throwaway seeded instance and stops it |
| `lib.ts` | Browser sessions from `scripts/qa-shoot.ts`, soft checks, helpers |
| `journeys.ts` | The journeys |
| `cutproxy.ts` | An HTTP proxy that can cut only the live channel |

How it works:

- **One instance.** Without `--base`, the suite starts `scripts/dev.ts` (or build + seed + `scripts/start.ts` with `--prod`) on free ports, or on `--port P` and `P+1`. The database, reports and app log live in `var/e2e/<name>/`. The instance is seeded with the full synthetic year unless `--no-history`.
- **Several browsers.** Every guest phone and staff device is its own headless Edge with its own profile, at phone (390×844) or desktop (1440×900) size.
- **Shared state.** Journeys a–f build on one table visit and run in order. The others are independent.
- **Soft checks.** Each journey records every check, and a failed check does not stop the journey. The test then fails with the full list. Every journey also asserts no page errors and no missing translation keys. Screenshots go to `test/e2e/out/`, results to `test/e2e/out/results.json`.

| Test | Brief | What it proves |
| --- | --- | --- |
| dev server (`files`) | 29 | From localhost and the LAN address, the dev server refuses the instance database (also with `?raw` / `?import`), its WAL file, `server/`, `scripts/`, `package.json`, `.env.example` and `data-src/` (403). It still serves `shared/` and the fonts. The API port is not reachable from the network (D-DT-01). With `--prod`, it instead checks that bundles are served while source maps and missing bundles get 404. |
| a | 31 #1, 07, 10, 13 | Floor staff seat a free table and read the PIN. The QR card URL is a LAN address, not localhost, and never carries the PIN. The guest scans the QR, types the PIN, sees "Welcome … Table 05" and the table tag, quick-adds a dish, sees a hot variant marked unavailable, and chooses iced plus a paid bean (฿110) with a note. They send from Your order via review, land on Track with the reference and the new round highlighted, and the server holds 3 lines. |
| b | 31 #1, 14, 19, 35 | A kitchen tablet (set to all stations) sees the new ticket emphasised. Accept → Start → Almost done → Ready each reach the guest's Track live, and the guest page never reloads. The board stays silent with sound off. |
| c | 44A | The weighed cut has no Add button, only a weigh request. Track shows it waiting. Staff quote 420 g on the Requests tab. The guest sees the quote live with the server amount ฿2,058 and confirms. A portion round appears on the board. |
| d | 15 | Call staff (a repeated tap makes no duplicate) and Request bill. Staff see exactly two requests live and acknowledge them. |
| e | 31 #2, 12, 14 | A second phone joins the same table. Its draft is empty (phone A keeps its own), and both phones show the same rounds, the same bill and the same total. Phone B marks no round as its own. |
| f | 16, 23, 36 | Kitchen and floor finish and serve everything. The cashier starts checkout (ordering is then refused), finalises the bill, records cash with change, and completes checkout. The table is Available on the grid. The connected guest sees the end screen live, its draft is cleared, the old cookie cannot order, and rescanning the QR shows nothing of the previous party. |
| g | 31 #13, 08 | In the dish sheet, switching to English keeps the sheet, choices, note, quantity, total and focus. After adding, the menu keeps its scroll and group. Mid-cart, switching to Thai keeps the draft, total and scroll. On Track, switching keeps the rounds, table, scroll and visit session. |
| h | 25, 37–41 | The owner opens Order Stats (with chart), Menu Stats and Engagement. They generate a provisional annual PDF: the job reaches Ready, the archive lists it, and the download is a real PDF. They pause guest ordering in Settings: the public config says paused, the guest's Send is disabled live, the draft is kept, and the server answers `ordering_paused`. They resume from the Overview header, and the guest can send again without a reload. |
| realtime | 31 #12, 28 | The board's live channel is cut at the socket level (a proxy between the board and the app), and the board shows it is not live while plain HTTP still works. A guest orders over HTTP, and the board does not learn of it. When the channel returns, the round appears once and the board is live again. Browser offline emulation does not close an open EventSource, which is why a proxy is used. |
| offline | 29, 30 | A guest phone with a draft goes offline. The order page says so, Send is blocked, and the draft is kept. Back online, Send returns and nothing was sent automatically. |
| shell | 10, 17, 33 | The dev UI gallery renders (skipped with `--prod`). A manager opens the review queue with no Verify actions. Orders → History becomes current, and browser Back returns to Board. At 320 px there is one reachable 44 px language button and no sideways scroll. A dish sheet opens with focus inside, Back closes it, and focus returns to the dish. |

Not automated in the browser:

- a lost response after a submit (covered server-side by `orders.test.ts`)
- the on-screen keyboard
- screen readers
- reduced motion
- real phones and real networks

## Visual QA (`npm run shots`)

`test/visual/shots.ts` starts its own seeded instance, the same way as the e2e suite, and writes `test/visual/out/`:

- `<set>/*.png` captures
- `report.json`
- `index.html`, a contact sheet with the reference mocks from `design-lab/final/` at the bottom

| Set | Captures |
| --- | --- |
| guest | th-320, th-390, en-390, en-768, th-1440 and en-1440, each with:<br>• welcome toast, menu, full menu (phones), All categories<br>• item sheet, required-choice attempt, first item added<br>• Your order and review<br>• Track and full Track, bill<br>• service sheet, Track offline<br>• first scan, wrong PIN, browse-only |
| states | th-390 and en-1440: no open visit, bad link, empty order, empty Track, bill being prepared, visit ended (arriving live) |
| staff | en-1440: login, overview, board, history, requests, tables, drawer, availability, item editor, catalog, review queue, payments, reports, settings, team, audit, more, QR print. Thai: board, drawer, settings. Role landings (kitchen, floor, cashier) at 1024. |
| narrow | 1024, 768 and 390, both languages: board, tables, drawer. English also: requests, overview, availability. |
| stats | 1440 (en and th, full page) and 390 (en): Order Stats (week, month, year), Menu Stats (most, least), Engagement |

**The in-page audit** (DESIGN §14) runs on every capture. It checks:

- horizontal overflow
- Thai text with letter-spacing, or with line height under 1.5 (the baht sign alone does not count as Thai)
- text under 13 px (guest) or 12 px (staff); printed QR cards are exempt
- visible controls whose hit area is under 44 px, sampled with `elementFromPoint`, so padding and pseudo-element hit areas count

Page errors, missing translation keys and overflow fail the run. The other notes are for a person to judge, and fail the run only with `--strict`.

**Latest run** (2026-09-18, 00:00–00:09 Bangkok): 172 captures, 0 failures, 43 audit notes. None is a failure. They are for the client stream to decide:

- Your order's slip subtitle has a Thai line height of 1.30 at 320 px (`slip__sub`).
- Dish-name buttons are 27 px tall; the photo and the Add button beside them are full-size targets (`dish__open`, 7 notes).
- Month-view chart bars are 26 px wide (`wbc__hit`, 24 notes). They are keyboard-reachable, and the table equivalent lists every day.
- The metric definition buttons on Engagement are 32 px (`defbtn`).
- The item editor's language toggle is 38 px tall.
- The board's status filter on a 390 px phone is 42 px tall.

The first run of the day, with the earlier audit, reported 352 notes. Most of them were hit areas that padding already widens, text containing only the baht sign, and screen-reader-only text. The audit was corrected, not the app.

**Reviewed by eye** (not a pixel diff):

- guest menu at 320 (th)
- table drawer at 390 (th)
- visit ended at 1440 (en)
- Order Stats at 390 (en)
- the annual report pages listed above

They match the design system: paper and charcoal surfaces, Thai shaping, compact masthead with table tag, five-group staff navigation on phones.

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
  `X-Forwarded-For` address, as real phones have. Failed joins are limited to
  10 a minute per address, and all joins to 60 a minute (D-S8-10).
  `access.test.ts` and `hardening.test.ts` prove those limits separately.
- **Races.** Races use `Promise.all` over separate clients. The long races in
  `concurrency.test.ts` repeat 4 to 12 times with a rotating stagger and
  print which outcome won each time (`ℹ` lines). The assertions accept only
  the documented consistent end states.

## Files

Test counts are for the latest run; the whole suite takes about 100 s. Per-file durations are not listed.

| File | Tests | What it proves |
| --- | --- | --- |
| `test/unit/money-time.test.ts` | 26 | Money: half-up rounding, measured-weight amounts, the included-side allowance, line totals, the exclusive and inclusive charges policy, and money formatting. Bangkok business dates: midnight, the cutoff hour, New Year weeks, leap days, UTC ranges and interval splitting. |
| `test/unit/board-model.test.ts` | 6 | Orders board placement: a round sits in its least-advanced column, ready dishes still reach the Ready column, and the station filter is respected (D-C4b-01, D-FX-OPS-01). |
| `test/unit/guest-menu-search.test.ts` | 6 | Guest search: Thai and English names, verified aliases, categories, and normalisation that never alters Thai. |
| `test/unit/guest-limits.test.ts` | 1 | The guest bundle's copies of request bounds match the zod schemas. |
| `test/unit/live-cursor.test.ts` | 8 | Live client cursor and duplicate handling, including a database restore (D-K-01). |
| `test/integration/smoke.test.ts` | 1 | Harness check: the server boots with fixtures and a guest can order. |
| `test/integration/journey.test.ts` | 3 | Scenarios 1 and 2 end to end. Details under Brief 31 below. |
| `test/integration/access.test.ts` | 19 | Table access and visit isolation: QR code, PIN, lockout, rate limits, QR rotation, disabled tables, leaving, session expiry, revocation, CSRF and secrets in logs. Also scenario 5 (queries, mutations and subscriptions) and scenario 6. |
| `test/integration/orders.test.ts` | 10 | Scenarios 3 and 4. State-matrix rows: a restaurant pause racing submissions, kitchen intake paused, the automatic intake limit, a table pause, and a visit in billing until a manager reopens it. |
| `test/integration/pricing.test.ts` | 10 | Scenarios 7 and 8. The charges policy (10% exclusive plus 7% inclusive, half-up, frozen at seating). Paper recovery never prices a dish at 0 THB and never records an unverified dish (D-S8-19), and paper orders cannot predate the previous party (D-S8-15). Editable "preparing" wording (D-S8-18). |
| `test/integration/realtime.test.ts` | 5 | Scenario 12. The stall regression for hidden events, a cursor ahead of the server, and event payloads with no notes, PINs or tokens. |
| `test/integration/billing.test.ts` | 14 | Complete checkout (brief 36): exact blockers, revocation, PIN clearing, request resolution, table reset, lost-response replay, disabled tables, zero bills, manager exceptions, reopen, reversal, refunds, adjustments, charge snapshots, and table counts matching the tiles. |
| `test/integration/concurrency.test.ts` | 15 | Scenarios 9, 10 and 11. Checkout racing an order, a payment, a reversal or a portion confirmation. |
| `test/integration/roles.test.ts` | 8 | Scenario 14: the server enforces the role matrix, and every refused request changes nothing. Includes the kitchen stream hiding payment and bill topics, and the stall regression. |
| `test/integration/service.test.ts` | 11 | Scenario 15: service-request deduplication, versioned staff handling, cancellation rules, and checkout resolving requests. Paper-order recovery with no duplicate preparation, and feedback. |
| `test/integration/portions.test.ts` | 17 | Brief 44A (every step and every listed test), 44B, 44D and 44F. |
| `test/integration/insights.test.ts` | 16 | Brief 37, 38 and 43: rounds, visits and diners; shared phones; weekly bars; comparisons; New Year weeks; year clipping; rankings; availability; measured-weight servings and grams; fixture filtering; stats permissions. |
| `test/integration/engagement.test.ts` | 16 | Brief 39 and 43: retried telemetry deduplicated, the active-chunk cap, active time versus seated time, the midnight split, opt-out, public and dining sessions, the grace window, the rate limit, funnel attribution, QR adoption, financial KPI gating, ordering while analytics is down or off. Scroll depth on the menu page only (D-S8-05); add rate per session (D-S8-06). |
| `test/integration/reports.test.ts` | 9 | Brief 40, 41 and 43 (details under Brief 43 below). Report labels per scope (D-S8-13). |
| `test/integration/hardening.test.ts` | 16 | Review fixes: bill adjustments (D-S8-01); payment history in the annual snapshot (D-S8-03); the retention task (D-S8-02); body size limits and the local-QR warning (D-S8-09); revoked access mid-stream and mid-upload (D-S8-08); PIN lockout escalation (D-S8-07); sign-in and join budgets (D-S8-10); demo accounts in live mode (D-S8-11); the availability log (D-S8-12); server-side price hiding (D-S8-17). |

## Brief 31: acceptance scenarios

| # | Scenario | Where | Notes |
| --- | --- | --- | --- |
| 1 | Open a table, join by QR and PIN, customise, submit, another staff client sees it, fulfilment updates the guest | `journey.test.ts` "scenario 1…", "Preparing -> Ready directly…"; `smoke.test.ts`; **browser: e2e a + b** | The API test uses fixture table T01. The browser journey seats the first free demo table (05), because Table 07 is already dining in the demo data. |
| 2 | Second device: independent carts, one combined bill | `journey.test.ts` "scenario 2…"; `orders.test.ts` scenario 4; **browser: e2e e** | |
| 3 | Same attempt repeated and with a lost response gives one order | `orders.test.ts` "scenario 3" (×3); `portions.test.ts` "response lost after confirmation"; `billing.test.ts` "a lost checkout response…" | |
| 4 | Different concurrent attempts are never suppressed | `orders.test.ts` "scenario 4" (×2); `journey.test.ts` scenario 2 | Identical carts under different keys stay separate rounds. |
| 5 | Tampered table or session ids are denied across queries, mutations and subscriptions | `access.test.ts` "scenario 5…", "scenario 5 (subscriptions)…", cross-site test; `roles.test.ts` "signed-out browsers and guest cookies…" | |
| 6 | New visit at the same table: old credentials reveal and change nothing | `access.test.ts` "scenario 6…"; `billing.test.ts` "complete checkout…" | |
| 7 | Prices, availability or options change after the cart is prepared | `pricing.test.ts` "scenario 7…"; `portions.test.ts` "goes out of season or sells out while in a draft…"; `journey.test.ts` (stale total gives `cart_changed`) | |
| 8 | Required modifiers, included and paid choices, quantities, rounding, cancellations, charges | `pricing.test.ts` "scenario 8" (×4) and "charges policy…"; `money-time.test.ts` | |
| 9 | Bill finalization racing a new order | `concurrency.test.ts` "Start checkout racing guest submissions…", "reopen racing finalize…", "two cashiers finalizing…"; `orders.test.ts` "a visit in billing…" | |
| 10 | Two cashiers confirming payment give one settlement | `concurrency.test.ts` "cashiers confirming the same revision…", "a payment must match…", "a guest has no way to mark the bill paid" | |
| 11 | Two staff updating one order: stale version | `concurrency.test.ts` "two staff moving the same line…", "bulk transition…", "two floor tablets finishing…"; `service.test.ts` and `portions.test.ts` versioned races | |
| 12 | Realtime down, submit over HTTP, reconnect, catch up | `realtime.test.ts` "scenario 12" (×2) and cursor tests; `live-cursor.test.ts`; **browser: e2e realtime** | In the browser the channel is cut by a proxy (see the e2e table). |
| 13 | Language switch mid-cart and while tracking | **browser: e2e g** | Language is a client concern. See the note below. |
| 14 | Role restrictions: payments, menu, cancellations, team | `roles.test.ts` (all); `billing.test.ts` exception close; `insights.test.ts` and `engagement.test.ts` permission tests | |
| 15 | Service-request deduplication and offline manual entry without duplicate preparation | `service.test.ts` (all) | |
| 16 | Online-payment callbacks | **Not applicable** | See the note below. |

**Scenario 13: language switching.** The API takes no language input: no `lang` parameter, and no `Accept-Language` handling outside the PDF renderer. It returns bilingual fields (`name_th` / `name_en`), so a switch cannot change the visit, the choices or the server totals. What can break is the client: the open sheet, the draft, the scroll position and the tracker. `npm run e2e` journey g switches language:

- inside a dish sheet with choices, a note and quantity 2
- on Your order, scrolled
- on Track, scrolled

Each time it checks that the sheet, choices, note, quantity, total, focus, menu group, scroll position, rounds, table and visit session all survive.

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
| Backend unreachable | Server side: paper-order recovery in `service.test.ts`. Guest phone: **e2e offline** (offline notice, sending blocked, draft kept, no automatic send). Board: **e2e realtime** (not-live indicator). |
| Table reused by new party | `access.test.ts` "scenario 6…"; `billing.test.ts` "complete checkout…" |

## Brief 43: additional acceptance criteria

| Criterion | Where |
| --- | --- |
| Image- and description-led menu; missing content surfaced in admin | Visual QA: `guest/menu-*`, `staff/review-queue-en-1440` |
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
| Visual QA of guest menu, tracker, table grid, weekly chart, rankings and report | `npm run shots` (guest, narrow, stats sets). The report was reviewed as print-rendered HTML. |

Brief 43 checks that are only partly proven:

- **The PDF test.** It checks the PDF structure, the embedded fonts (only
  Noto Sans Thai, Oswald and Cormorant; no system fallback) and real Thai
  text. The snapshot tests check the report data (coverage and totals). The
  printed layout was reviewed from the print-rendered HTML of a full-year
  report (see Latest result). The PDF pages themselves were not rasterised.
- **The "service not frozen" check.** It only runs when the test catches the
  job while it is generating. The test prints which case happened. In runs 2
  and 3 of the earlier session, an order went through in 15 ms while the PDF was generating, and in the latest run in 24 ms.

## Brief 44: grill-specific rules

| Section | Where |
| --- | --- |
| A. Weight-priced cuts | `portions.test.ts` covers every numbered step and every test in the brief's list: duplicate request, double confirmation, changed revision, expired quote, two staff edits, closure while pending, lost response after confirmation, in-person confirmation, and fixed-price dishes while a request is pending. Also rate approval and half-up rounding. `pricing.test.ts` checks that a measured cut can never be a cart line. `money-time.test.ts` covers `measuredAmount`. |
| B. Doneness, sides, sharing | `journey.test.ts` scenario 1 (required doneness; included, upgraded and paid sides); `pricing.test.ts` scenario 8; `portions.test.ts` "different doneness on two steaks…"; `money-time.test.ts` `allocateGroupPicks` |
| C. Variants and alcohol | `pricing.test.ts`: hot and iced variants, unavailable decaf, variant-specific prices at submission. The alcohol flag (fixture wine, `requires_staff_confirm`) takes part in the pricing and sold-out tests. Legal eligibility rules are not modelled. |
| D. Seasonal items and promotions | `portions.test.ts` "an item that goes out of season or sells out while in a draft…" (an expired seasonal category gives `cart_changed`; accepted orders keep their snapshot). The beer promotion is kept as an unorderable source record (D-09), and V1 has no promotional pricing to test. |
| E. Menu organization | `guest-menu-search.test.ts`; visual QA (`guest/menu-*`, `guest/categories-*`) |
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

These are documented by the tests as current behaviour, or reported without an assertion. None of them fails the suites.

**Addressed since the first test pass**

- **Polling fallback after a restore.** The client now follows a lower server cursor (D-K-01, `live-cursor.test.ts`).
- **Paper recovery of unapproved prices.** An unverified or re-priced dish is never recorded from paper (D-S8-19, `pricing.test.ts`).
- **Refund after checkout.** It is reported as a refund, not as a payment exception or unpaid (D-S8-04).
- **Retention.** A daily task now applies the retention settings (D-S8-02, `hardening.test.ts`).
- **Browser suites and scenario 13.** `npm run e2e` and `npm run shots` exist (D-DT-04).

**Still open**

- **Weighing note visible to guests.** The guest's portion quote includes the staff weighing note (`quote.note`). This may be intentional (brief 44A).
- **Exception close from Dining.** A manager's exception close from a table still in Dining answers `invalid_transition`: the table must be moved to Checking out first. This is a product question (`billing.test.ts`).
- **Over-long active-time chunk.** The brief says reject it. The server follows D-S6-08: 120 s to 24 h is capped at 120 s, and longer than that, longer than the session, or 0 is rejected. The test follows D-S6-08.
- **Opt-out attribution.** Attribution uses the session's *current* opt-out flag, so opting back in under the same session id would attribute earlier rounds after the fact. The browser client always starts a new session (D-C3-01).
- **CSV consistency.** The annual `engagement_events.csv` includes `visit_id`; the dashboard raw-events CSV omits it (D-S6-12).
- **PDF size.** A 20-page PDF for a year with no orders is about 7.4 MB, because font subsets are embedded repeatedly. The full synthetic 2025 is 520 pages and 14.4 MB.
- **`divRoundHalfUp(-4, 10)` returns `-0`.** It serialises as `0`.
- **Conditional skips.** `insights.test.ts` "the current week is compared…" skips from 23:58 to 00:01 Bangkok time; it skipped in the latest run, which crossed that window. The two PDF tests in `reports.test.ts` skip if no Edge or Chrome can be launched; they ran.
- **Visual audit notes.** Some notes need a person's decision. The first run flagged Your order's slip subtitle at 320 px with a Thai line height of 1.30 (`slip__sub`). The list from the latest run is in `test/visual/out/report.json`.
- **Not covered by any suite:**
  - a lost submit response in the browser
  - the on-screen keyboard over notes
  - screen readers and reduced motion
  - contrast on the running app
  - the catalog editor UI and CSV import
  - real phones and real networks
  - an https proxy
  - a full restore
