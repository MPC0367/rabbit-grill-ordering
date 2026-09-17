# Feature matrix

Every requirement in the product brief (*Rabbit Grill Khao Yai Menu Ordering Platform*, sections 01–45), with its state (brief 43: "Maintain a final feature matrix with Implemented, Verified, Needs owner content, and Deferred states"). It also serves as the implementation checklist that brief 32 asks for. Decisions are in [DECISIONS.md](DECISIONS.md), and test details are in [TESTING.md](TESTING.md).

## States

| State | Meaning |
| --- | --- |
| **Verified** | Built, and checked by the evidence listed, in the runs recorded in [TESTING.md](TESTING.md#latest-result). |
| **Implemented** | Built and reachable, but no automated test or recorded check covers it beyond reading the code. |
| **Needs owner content** | Built, but real use depends on data or a decision only the restaurant can give ([OWNER-CHECKLIST.md](OWNER-CHECKLIST.md)). Often combined with one of the states above. |
| **Deferred** | Not built in V1, by the brief's scope or by a recorded decision. Where one exists, the boundary is named. |

## Evidence keys

| Key | Where | What it is |
| --- | --- | --- |
| `IT file › test` | `test/integration/*.test.ts` | A real server process, HTTP clients and a temporary database (`npm test`) |
| `UT file` | `test/unit/*.test.ts` | Pure-module tests (`npm test`) |
| `E2E x` | `test/e2e/journeys.ts` journey *x* | Real browser sessions (installed Edge) against one seeded instance (`npm run e2e`) |
| `VIS set/name` | `test/visual/out/<set>/` | Captured screens, audited in the page and reviewed by a person (`npm run shots`) |
| `REVIEW` | brief walk-through of 2026-09-17 | Manual screenshots of every brief-34 guest state. Not versioned (kept in `var/scratch/review-brief-guest/shots`). |
| `DOC` | a file in this repository | Documentation or configuration |

**Local only.** All verification ran on one Windows laptop, with Edge as the browser, on `localhost` and the laptop's LAN address. No real phone, restaurant network, https proxy or hosted server has been tested. Nothing here is a production check (brief 31).

---

## Part 0: scope, sources, design, contract (01–06)

| § | Requirement | State | Evidence and notes |
| --- | --- | --- | --- |
| 01 | One connected product: an order sent on a phone is visible to staff on another device, and staff changes reach the right guests | Verified | `IT journey.test.ts › scenario 1`; `E2E a`, `E2E b` (separate browser sessions, one database) |
| 01 | Deliver the application, source, schema and migrations, seed data, setup instructions, env template and verification results | Verified | `server/db/migrations/`, `server/db/seed/`, [README.md](../README.md), [OPERATIONS.md](OPERATIONS.md), `.env.example`, [TESTING.md](TESTING.md) |
| 01 | Never present simulated results as production | Implemented | Demo banner and "Demo data" tags in demo mode (D-09, D-10); these docs state that verification is local only |
| 02 | Thai default, English switch | Verified | `E2E g`; `VIS guest/*-th-*`, `*-en-*` |
| 02 | THB display; Asia/Bangkok reporting with UTC storage | Verified | `UT money-time.test.ts` (Bangkok business dates, UTC ranges) |
| 02 | Dine-in, one unique QR per table, pay after dining with staff-confirmed payments, no guest account | Verified | `IT access.test.ts`, `IT billing.test.ts`; `E2E a`, `E2E f` |
| 02 | Branding, table names, categories, hours, services, tax and payment methods configurable, treated as proposals | Implemented · Needs owner content | **More → Settings** (`shared/settings.ts`, every default marked proposed); **Menu → Catalog**; **Tables → Manage** |
| 02 | The reference menu imported as a reviewable draft; owner verification required before live ordering | Implemented · Needs owner content | D-09; 95 records, **0 owner-verified** ([source-audit.md](source-audit.md)); live mode orders only verified items (`IT roles.test.ts › …a manager price change waits for owner review`) |
| 03 | V1 scope: see sections 07–44 below | n/a | |
| 03 | POS, external KDS, automated payment reconciliation, split bills, tips, room charges, loyalty, ingredient inventory, multi-branch | **Deferred** | Out of V1 by the brief. Payment exceptions are a recorded-payment comparison only (brief 26). |
| 03 | Location type modelled for later room or zone ordering; only tables exposed | Implemented | `dining_tables.location_type` (`table` / `room` / `zone`) and `zone`; the UI exposes tables only |
| 03 | Online payment as an isolated optional adapter; no misleading pay button | **Deferred** (boundary only) | `server/domain/payments.ts` adapter contract; `getPaymentAdapter()` returns null; no routes; no guest pay button ([TESTING.md › scenario 16](TESTING.md)) |
| 04 | Import every named reference entry, drinks included, into a draft review workflow | Implemented | `data-src/catalog.json`: 95 items, 19 categories, 2 groups; [source-audit.md](source-audit.md) |
| 04 | Provenance per record: source URL and text, retrieval date, asset mapping, translation status, price and portion verification, reviewer, approval date | Implemented | Catalog records and `EvidencePanel` in the item editor (D-S1.2, D-S1.3) |
| 04 | Ambiguous records flagged, not "fixed": lamb rack, prime rib by weight, duplicate Matcha Latte, seasonal avocado, beer promotion, drink variants, misprints | Implemented · Needs owner content | Flags in `catalog.json`; **Menu → Review** counters; 21 owner questions ([OWNER-CHECKLIST.md §13](OWNER-CHECKLIST.md#13-the-21-open-questions-from-the-source-audit)) |
| 04 | Unverified or historical entries unavailable for live ordering; no invented allergens, sizes, doneness or popularity | Implemented | D-09, D-S1.4; `desc_*` empty everywhere; `IT roles.test.ts` (price change → review) |
| 04 | Use matched dish photos only where reuse is authorised; atmosphere shots not used as dish photos | Implemented · Needs owner content | 39 dish photos matched by eye (source audit §1); written reuse permission outstanding |
| 04 | Do not clone the marketing site's navigation, hero or footer into ordering | Implemented | `VIS guest/menu-*` |
| 05 | Reference palette as tokens; Cormorant, Oswald and Noto Sans Thai self-hosted | Implemented | `client/src/styles/tokens.css`; [DESIGN.md](DESIGN.md); fonts from `@fontsource-variable` |
| 05 | Readable text, Thai line height, no Thai letter-spacing | Verified (one note) | In-page audit on all 172 captures (Thai line height ≥ 1.5, no Thai tracking, text ≥ 13 px guest / 12 px staff). One open note: the order slip subtitle has a line height of 1.30 at 320 px. |
| 05 | Contrast validated for real text and background pairs | Implemented | Checked on the reference mocks (DESIGN §14). No automated contrast check on the running app. |
| 05 | Status shown by text or icon, not colour alone; focus rings; ~44 px targets | Verified (with notes) | Touch-target audit in `VIS` (hit areas sampled); focus checks in `E2E g`, `E2E shell`. Notes for the client stream: dish-name buttons 27 px tall (photo and Add are full targets), month chart bars 26 px wide, definition buttons 32 px, item-editor language toggle 38 px, 390 px board filter 42 px. |
| 05 | Keyboard, screen reader, reduced motion, browser back, language switch on key flows | Implemented (partly verified) | Back and focus: `E2E shell`; language: `E2E g`; `prefers-reduced-motion` in the CSS. No screen-reader test was run. |
| 05 | No intro, scroll hijacking, autoplay, custom cursor or blocking language animation | Implemented | `VIS` |
| 06 | Guest routes `/menu`, `/q/:token`, `/menu/cart`, `/menu/orders`, `/menu/bill` | Verified | `E2E a`–`g` |
| 06 | Staff routes `/admin/login`, `/admin`, orders, tables, service, menu, payments, stats (orders, menu, engagement), reports, team, settings, audit | Verified | `VIS staff/*`, `VIS stats/*`; `/admin/service` redirects to Orders → Requests |
| 06 | Shared types, schemas, permissions, state machines and money before the UIs | Implemented | `shared/` ([ARCHITECTURE.md](ARCHITECTURE.md)) |

## Part A: guest experience (07–16)

| § | Requirement | State | Evidence and notes |
| --- | --- | --- | --- |
| 07 | High-entropy opaque QR token; never trust a typed table number | Verified | `IT access.test.ts` (QR, tampered ids, scenario 5); 256-bit tokens (D-04) |
| 07 | Permanent table and temporary visit are separate; one active visit per table | Verified | `IT access.test.ts › scenario 6`; `IT billing.test.ts › complete checkout…` |
| 07 | Staff open a visit with a fresh PIN; scan → table label → PIN; scoped guest credential | Verified | `IT access.test.ts`; `E2E a` (the PIN read from the seat dialog is typed on the phone) |
| 07 | The permanent QR alone reveals no PIN or bill and cannot order | Verified | `IT access.test.ts › copied permanent QR…`; `E2E a` (the QR URL carries no PIN) |
| 07 | Closing revokes access; the printed QR is reused for the next visit | Verified | `IT billing.test.ts`; `E2E f` (old cookie refused, rescan shows nothing of the previous party) |
| 07 | Rate-limited PIN and join attempts; PIN rotation; lockout | Verified | `IT access.test.ts` (limits, lockout, rotation); `IT hardening.test.ts › join-PIN lockouts escalate…`, `…a busy seating wave behind one address can join…` (D-S8-07, D-S8-10) |
| 07 | State the remaining limitation of a shared QR plus PIN | Verified | D-04 |
| 07 | "Welcome to Rabbit Grill · Table 07"; table label always visible | Verified | `E2E a` (toast and masthead tag); `VIS guest/*` |
| 07 | No guest table switching; "Ask staff to help" recovery | Implemented | No table picker exists; join page help link (`VIS guest/join-*`) |
| 07 | Distinct messages: malformed link, disabled QR, no open visit, invalid PIN, revoked, paused, closed | Verified | Server codes: `IT access.test.ts`. Screens: `VIS states/bad-link-*`, `states/no-visit-*`, `guest/join-wrong-pin-*`, `states/visit-ended-*`; `REVIEW` p02, p03, p06, p07, p09, p10, m10, m11, b03 |
| 07 | Public visitors browse only | Verified | `IT access.test.ts › no valid authorization…`; `VIS guest/browse-only-*` |
| 08 | Three primary destinations (Menu, Your order, Track); bill and staff in a service area | Verified | `E2E a`, `E2E d`; `VIS guest/*`, `guest/service-*` |
| 08 | Sticky header with identity, table and language; bottom nav with badge; order summary bar; no overlap | Verified | `VIS guest/menu-*-320`, `-390`; the 320 px no-overflow check in `E2E shell` |
| 08 | Larger screens: category sidebar, persistent order panel | Verified | `VIS guest/*-1440` |
| 08 | A language switch keeps selections, draft, visit, open sheet, group and scroll position | Verified | `E2E g` (brief 31 scenario 13) |
| 08 | Missing translation falls back visibly | Implemented | English-only drink names are marked "no Thai name yet" (`item.enOnlyName`) |
| 08 | Guest notes stay exactly as typed | Verified | `E2E g` (note unchanged across the switch); `E2E a` (note on the line) |
| 09 | Groups Food and Drinks (Dessert in Food); categories beneath | Verified | `VIS guest/menu-*`; `E2E g` (group kept) |
| 09 | Per-group scroll memory; category jump with offset; scroll spy; every category reachable (All categories sheet) | Implemented | `VIS guest/categories-*`; `E2E g` checks that the scroll position is kept. No automated check of the scroll spy. |
| 09 | Hide empty categories; explain filtered empty results | Implemented | D-S1.4; `REVIEW` p04 (no results), e01 (empty group) |
| 09 | Search Thai, English and aliases; whitespace and case normalised; results show their category; clear and no-results actions | Verified | `UT guest-menu-search.test.ts`; `E2E a`, `E2E c` search by name |
| 09 | Item card: full name, verified price or price-pending, verified description, availability, action | Verified | `VIS guest/menu-*`; D-S1.4 |
| 09 | Real matched images with alt text, lazy loading, text-led fallback | Implemented · Needs owner content | 39 dish photos; 56 drinks text-led; permission pending |
| 09 | Sold-out display follows the owner setting; never orderable | Verified | `IT pricing.test.ts › scenario 7`; setting `menu.sold_out_display` |
| 10 | Bottom sheet on phones, dialog on desktop, with image, description, price, choices, quantity, notes, allergens and a sticky total | Verified | `VIS guest/item-sheet-*`; `E2E a` (total ฿110 with the paid choice) |
| 10 | Required and optional single or multi choice, min and max, included options and extra charges, variant prices and availability, option availability, item quantity limits | Verified | `IT pricing.test.ts › scenario 8`; `UT money-time.test.ts`; `E2E a` (unavailable hot variant) |
| 10 | Choices only where configured or verified (no invented spice, doneness…) | Implemented · Needs owner content | Only the sourced bean choice is attached (D-S8-02) |
| 10 | Required-choice error beside the control; edits kept | Implemented | `VIS guest/item-sheet-required-*`; `REVIEW` g04 |
| 10 | Escape, browser back, focus trap and restore | Verified | `E2E shell` (Back closes the sheet, focus returns); `E2E g` (focus stays in the sheet) |
| 10 | Quick add for simple dishes; sheet first for dishes with required choices | Verified | `E2E a` (one-tap add confirms in place) |
| 10 | Note length limit with a counter; no promise of accommodation | Implemented | `menu.note_max_length` (140); sheet copy |
| 11 | Allergens as verified data: contains, cross-contact, unknown; unknown is never "free" | Implemented · Needs owner content | `item_allergens` with `allergen_status`; guests see entries only when verified (D-S1.4). **All 95 items are unknown.** |
| 11 | "Please speak with staff about allergies" action; allergy notes prominent for staff | Implemented | `allergy_help` service (D-16); allergy band on tickets (DESIGN §10; fixture table 03) |
| 11 | Allergen filter | Deferred | Not built. The brief makes it optional ("if an allergen filter exists"). |
| 12 | Separate draft per device per visit; no shared editable cart | Verified | `E2E e`; D-05 |
| 12 | Draft survives refresh; namespaced; restored only after revalidation | Implemented | D-C1b-01; the e2e journeys reuse a phone's saved storage across sessions |
| 12 | Merge only identical lines; edit, quantity, remove | Implemented | `REVIEW` g10, g11 |
| 12 | Line prices, choices, totals and configured charges shown | Verified | `VIS guest/cart-*`; `IT pricing.test.ts › charges policy…` |
| 12 | Integer minor units; one documented rounding and charges policy; no assumed tax | Verified | `UT money-time.test.ts`; D-07 |
| 12 | Server validates availability, prices, choices, operating state, visit and quantities; never trusts client totals | Verified | `IT pricing.test.ts`, `IT orders.test.ts` |
| 12 | A changed price or unavailable item shows the affected line and requires review; the rest is kept | Verified | `IT pricing.test.ts › scenario 7`; `REVIEW` g12–g14, b02 |
| 12 | All-or-nothing order creation | Verified | `IT pricing.test.ts`, `IT orders.test.ts` |
| 13 | Review before sending: table, items, choices, notes, total, "Place order" | Verified | `E2E a`, `E2E g`; `VIS guest/cart-review-*` |
| 13 | Client idempotency key, UNIQUE in the database; replay returns the original; a changed payload is rejected | Verified | `IT orders.test.ts › scenario 3`; D-06 |
| 13 | Pending key persisted across refresh; after a timeout, look up the attempt before offering a new send | Implemented | D-C1b-02; `REVIEW` g16, g18, g19. No automated browser test of a lost response. |
| 13 | States: sending, received with reference, checking, rejected with a fix | Implemented | `REVIEW` g16–g19; `E2E a` (lands on Track with the reference) |
| 13 | Clear only the submitted lines after durable confirmation | Verified | `E2E a` (draft emptied after send); `E2E e` (phone A keeps its own draft) |
| 14 | Shared table rounds for joined guests; "ordered on this device"; not a split bill | Verified | `E2E e`; `IT journey.test.ts › scenario 2` |
| 14 | No previous visit's data exposed | Verified | `IT access.test.ts › scenario 6`; `E2E f` |
| 14 | Line-level state machine, with Almost done optional and never inferred; rejected and cancelled with a reason | Verified | `IT journey.test.ts` (both tests); `IT roles.test.ts › …require a reason`; `E2E b` |
| 14 | Aggregate state derived from lines; partial progress shown | Verified | `IT journey.test.ts` (`partially_served`); `REVIEW` g23, g24 |
| 14 | No direct guest edits; "Request change" | Implemented | `order_change` service (D-16) |
| 14 | Repeat ordering is a new round, re-reviewed against the current menu | Verified | `IT journey.test.ts`; `E2E c` (portion round), `E2E g` |
| 14 | No fabricated wait times | Implemented | The estimated wait is shown only when staff set one (D-C4a-03) |
| 15 | Configurable service actions; only supported ones enabled | Implemented · Needs owner content | `settings.services` (water and utensils off, D-16) |
| 15 | Sent, Acknowledged and Completed states; duplicate taps deduplicated; cooldown; separate staff queue | Verified | `IT service.test.ts`; `E2E d` (two requests only, acknowledged live) |
| 15 | In-person fallback when the device is offline | Verified | `E2E offline` (explicit offline state); ServiceSheet offline copy |
| 15 | Optional, short feedback; no duplicates; never published | Verified | `IT service.test.ts` (feedback); D-21 |
| 16 | One combined bill; request bill; pending versus confirmed amounts | Verified | `E2E d`, `E2E e`; `IT billing.test.ts` |
| 16 | Billing state blocks ordering; immutable revision; staff-recorded payment; Paid; Complete checkout frees the table; payment alone does not | Verified | `IT billing.test.ts`; `IT concurrency.test.ts`; `E2E f` |
| 16 | Reopening needs authorisation and invalidates the payable revision | Verified | `IT billing.test.ts` (reopen); `IT roles.test.ts` |
| 16 | Never paid by a guest tap, screenshot, redirect or QR | Verified | `IT concurrency.test.ts › a guest has no way to mark the bill paid` |
| 16 | Not an official tax document | Implemented · Needs owner content | Bill copy; receipt process is the owner's (checklist §7) |
| 16 | Split bills, tips, room charges | **Deferred** | Out of V1 |

## Part B: staff operations (17–26)

| § | Requirement | State | Evidence and notes |
| --- | --- | --- | --- |
| 17 | Separate authenticated interface; sidebar on desktop, compact on tablet, phone fallback | Verified | `VIS staff/*-1440`, `VIS narrow/*-1024`, `-768`, `-390` |
| 17 | Connection status, ordering state, staff identity, alert counts | Verified | `.conn` indicator (`E2E realtime`); pause banner (`E2E h`); `VIS staff/*` |
| 17 | Overview: what needs action, active tables, oldest waiting, open requests, blockers | Implemented | `VIS staff/overview-*`, `VIS narrow/overview-*` |
| 17 | Working filters and tabs; loading, empty, error and permission-denied states | Implemented | D-C4a-02; `E2E shell` (History tab and Back) |
| 18 | Server-enforced permissions; five proposed roles; configurable | Verified | `IT roles.test.ts` (all 8 tests); `shared/permissions.ts`; **Settings → Role permissions** |
| 18 | Who may cancel, correct, pause, rotate QR and override closure is defined | Verified | `IT roles.test.ts › cancelling needs…`; `IT billing.test.ts` (manager exception) |
| 18 | Secure sessions and logout; individual attribution | Verified | `IT roles.test.ts › signed-out browsers…`; audit rows carry the actor |
| 18 | Authenticated first-admin setup | Verified (manual run) | `npm run admin:create` on an empty database, then the new owner signs in ([TESTING.md](TESTING.md#latest-result)); [OPERATIONS.md › First admin](OPERATIONS.md#first-admin) |
| 18 | No hard-coded production passwords; no privileged secrets in the browser | Verified | Demo accounts exist only when seeded. `npm start` never seeds unless `SEED_DEMO=1` (D-DT-03). Live mode refuses demo accounts (`IT hardening.test.ts › demo staff accounts cannot sign in to a live restaurant…`, D-S8-11). No source maps served (`SERVE_SOURCEMAPS`, D-S8-09). |
| 18 | Kitchen sees no payment references or unrestricted reports | Verified | `IT roles.test.ts › kitchen and floor cannot…`, `…kitchen's staff event stream hides payment…` |
| 19 | Columns New → Served, with rejected and cancelled behind a filter; filtered lists on narrow screens | Verified | `VIS staff/orders-board-*`, `VIS narrow/orders-board-*`; D-C4b-01 |
| 19 | Ticket: reference, table, round, time, age, quantities, choices, notes and allergy flag, next actions | Verified | `E2E b`; `VIS staff/orders-board-*` |
| 19 | Filters (table, status, age, station); oldest first | Implemented | D-24, D-C4b-01; `UT board-model.test.ts` |
| 19 | New submissions distinguished from updates | Verified | `E2E b` (`is-new` emphasis) |
| 19 | Per-line and bulk actions; accept and reject with guest-visible reasons | Verified | `IT concurrency.test.ts › bulk transition…`; `IT roles.test.ts › …require a reason`; `E2E b` |
| 19 | Finish order resolves lines only; never closes the table or pays the bill | Verified | `IT billing.test.ts › finish order changes fulfilment only…` |
| 19 | Opt-in sound, a test control, visual alerts, no replay on reconnect | Implemented (partly verified) | D-C4a-01; `E2E b` (silent while sound is off). Replay suppression is not tested automatically. |
| 19 | Version checks; a stale card refreshes and explains | Verified | `IT concurrency.test.ts › two staff moving the same line…` |
| 19 | No drag-only controls; no auto-accept | Implemented | Button actions only |
| 20 | Table grid with state, visit, orders, bill and assistance | Verified | `VIS staff/tables-*`; `E2E a`, `E2E f` (tile states) |
| 20 | Create and edit labels without changing history; enable or disable | Implemented | **Tables → Manage**; D-20 (order label snapshots) |
| 20 | Per-table QR generate, preview, print, download; batch print; labelled cards | Verified | `VIS staff/qr-print-en-1440`; `E2E a` (qr-cards URL) |
| 20 | Open visit, show and rotate PIN, revoke guests; view orders, requests and bill | Verified | `IT access.test.ts`; `E2E a`, `E2E f` |
| 20 | Complete checkout in one authoritative operation | Verified | `IT billing.test.ts`; `E2E f` |
| 20 | Rotate a compromised QR, with reprint indicated | Verified | `IT access.test.ts › QR rotation…`; D-18 |
| 20 | Lifecycle Open → Billing → Closed; back to Open needs authorisation and a reason | Verified | `IT billing.test.ts`; `IT concurrency.test.ts › reopen racing finalize…` |
| 20 | Closure blocked by unresolved fulfilment or an unpaid bill, except by a manager exception | Verified | `IT billing.test.ts › checkout refuses with the exact remaining blockers…`, manager exception |
| 20 | Visit transfer to an empty table (manager) | Verified | `IT concurrency.test.ts`, `IT realtime.test.ts` (transfer); D-20 |
| 20 | QR card: identity, label, instructions, quiet zone, in-person fallback, never the PIN | Verified | `VIS staff/qr-print-en-1440`; `E2E a` |
| 21 | Full CRUD, archive, order and availability for groups, categories, items, variants, choices, images and translations | Implemented | **Menu → Catalog**, item editor (D-S1.1). Price edits and publishing are tested through the API (`IT roles.test.ts`, `IT pricing.test.ts`). The editor UI has no automated test. |
| 21 | Item editor fields: names, category, status, verified price and history, image and alt, choices, notes, allergens, station, sold out, schedule, evidence | Implemented | `VIS staff/item-editor-en-1440`; D-S1.1–S1.3 |
| 21 | Reusable choice groups show affected items; impossible required groups cannot publish | Implemented | D-S1.1 (audited with affected ids); publish blockers |
| 21 | Service-friendly sold-out toggle; explicit re-enable | Verified | `VIS staff/menu-availability-*`; `IT pricing.test.ts` (sold out) |
| 21 | Guest preview in both languages; unpublished-changes indicator; publish blockers | Implemented | `GuestPreview.tsx`, `PublishPanel.tsx`; D-S1.1 |
| 21 | CSV import (template, preview, row errors, duplicates, review before publish) and export with stable ids | Implemented | **Menu → Import**; D-S1.5. No automated test. |
| 22 | Service queue by age with table, type, note, time, status and staff; acknowledge, complete, cancel; conflicts | Verified | `IT service.test.ts`; `E2E d`; `VIS staff/requests-*` |
| 22 | Staff-assisted ordering on the same validation path, recorded as staff-assisted | Verified | `IT orders.test.ts`, `IT concurrency.test.ts` (assist); D-C4b-02 |
| 22 | Explicit offline state; no invisible local-only orders | Verified | `E2E offline`; D-C1b-02 (nothing is queued for automatic sending) |
| 22 | Manual paper-order recovery without duplicate preparation, flagged in the audit | Verified | `IT service.test.ts` (paper recovery); D-25 |
| 23 | Fulfilment, bill, payment and visit states kept separate | Verified | `IT billing.test.ts` |
| 23 | Billing screen: orders, chargeable and excluded lines, adjustments, breakdown, revision, total, status | Verified | `E2E f`; `VIS staff/tables-drawer-*` |
| 23 | Full-bill payment with method, time, staff, amount and reference; cash tendered and change | Verified | `E2E f` (change shown); `IT billing.test.ts` |
| 23 | Duplicate settlement impossible (constraint plus idempotent endpoint) | Verified | `IT concurrency.test.ts › cashiers confirming the same revision…` (scenario 10) |
| 23 | Corrections and refunds need permission, a reason and linked records | Verified | `IT billing.test.ts` (reversal, refunds, adjustments); `IT roles.test.ts` |
| 24 | Online payment adapter with callback verification | **Deferred** | Boundary only (see 03). Provider tests would be required when a provider is added. |
| 25 | Restaurant-wide pause with a guest message; tracking and service keep working; server rechecks | Verified | `IT orders.test.ts › restaurant pause racing submissions`; `E2E h` (live banner, send disabled, server refuses, resume) |
| 25 | Scheduled hours | Implemented · Needs owner content | Stored, not enforced until verified (D-17) |
| 25 | Table pause; category or station pause | Verified | `IT orders.test.ts › table pause`; `IT pricing.test.ts` (paused category) |
| 25 | Backlog count and oldest wait; honest estimated wait; transactional intake limit | Verified | `IT orders.test.ts › the intake limit pauses…`; D-C4a-03 |
| 25 | Settings: branding, languages, tables, services, hours, charges, payment methods, cancellation permissions, PIN policy, notifications, retention; future-only changes marked | Implemented · Needs owner content | `VIS staff/settings-*`; `FUTURE_ONLY_SETTINGS` |
| 25 | Data retention applied | Verified · Needs owner content | `IT hardening.test.ts › the retention task removes old notes, comments, raw events and audit rows, keeps totals…`; daily task plus `npm run jobs -- retention` (D-S8-02); periods to confirm |
| 26 | Business date and range filters; Bangkok boundaries; explicit cutoff | Verified | `IT insights.test.ts`; `UT money-time.test.ts` |
| 26 | KPIs: QR adoption, guest order time, average order and table value, operational errors, payment exceptions, staff response | Verified | `IT engagement.test.ts › QR adoption…`, `IT insights.test.ts`; metric dictionary in DECISIONS.md |
| 26 | Item quantities, hourly volumes, cancellations with reasons, open bills, request counts; precise total labels | Verified | `IT insights.test.ts`; D-S6-10 |
| 26 | Honest empty states and sample sizes; fixtures excluded | Verified | `IT insights.test.ts` (fixture filtering) |
| 26 | CSV export respecting permissions, filters, timezone and formula injection | Verified | `IT insights.test.ts`, `IT roles.test.ts` (export.csv); D-S6-12 |

## Part C: engineering and delivery (27–32)

| § | Requirement | State | Evidence and notes |
| --- | --- | --- | --- |
| 27 | Coherent framework, typed validation, relational database with transactions, pinned dependencies | Verified | `package.json` (exact versions); `npm run typecheck` |
| 27 | Data model: branch, tables and QR, visits and memberships, staff, catalog and provenance, orders and snapshots, requests, bills and revisions, payments, audit and outbox, analytics, aggregates, reports | Implemented | `server/db/migrations/*.sql` |
| 27 | Order snapshots; menu edits never change history; archive instead of delete | Verified | `IT insights.test.ts` (archived and renamed items); `IT pricing.test.ts` |
| 27 | Constraints: one active visit, scoped idempotency, one settlement; transactions around critical changes | Verified | `IT concurrency.test.ts` (15 tests) |
| 28 | Guest and staff operations as specified; every mutation authenticated, validated and atomic; guest scope | Verified | `IT access.test.ts`; `IT roles.test.ts` |
| 28 | Versions and event ids; clients ignore duplicates; reconnect refetches | Verified | `IT realtime.test.ts`; `UT live-cursor.test.ts`; `E2E realtime` (the round is shown once) |
| 28 | Commit before broadcast; outbox or polling recovers missed events | Verified | `IT realtime.test.ts › scenario 12`; `E2E realtime` |
| 28 | Measured update latency | Implemented (not measured) | `E2E b` waits up to 12 s per step and `E2E realtime` prints its catch-up time. No latency target is claimed. |
| 29 | Server-side authorisation for visits, roles, reports and streams | Verified | `IT access.test.ts`, `IT roles.test.ts` |
| 29 | Validation, note limits, escaping, safe SQL; CSRF; rate limits | Verified | `IT access.test.ts` (CSRF, limits); zod schemas; parameterised SQL |
| 29 | No secrets in logs | Verified | `IT access.test.ts › secrets in logs` |
| 29 | Upload restrictions | Implemented | Menu photos come from `npm run assets` and are chosen in the item editor. No automated test. |
| 29 | Secrets in env; secret-free example | Verified | `.env.example` |
| 29 | Guest identifier minimisation; configurable retention | Verified | Pseudonymous analytics sessions (D-C3-01); retention task (see 25) |
| 29 | Request size limits, compression, static caching; no source maps served | Verified | `IT hardening.test.ts › oversized request bodies are refused…`; D-S8-09 |
| 29 | Revoked or signed-out staff and guests lose access immediately, also mid-request | Verified | `IT hardening.test.ts › a staff live stream ends…`, `…a guest revoked while an order is still uploading…` (D-S8-08) |
| 29 | Backup and restore instructions before live operation | Verified | [OPERATIONS.md › Backup and restore](OPERATIONS.md#backup-and-restore); `npm run jobs -- backup` run on a seeded database (see [TESTING.md](TESTING.md)) |
| 29 | LAN testing explained; explicit reachable QR base URL; development server bound deliberately; network conditions documented | Verified | `npm run dev` picks the LAN address (D-DT-02); `E2E a` (QR URL not localhost); `E2E files` (only the app is served to the LAN, API on 127.0.0.1) (D-DT-01); [OPERATIONS.md](OPERATIONS.md#multi-device-qr-testing-on-a-lan) |
| 29 | No indiscriminate service-worker caching; offline blocks submission and keeps drafts; no delayed auto-send | Verified | No service worker exists; `E2E offline` |
| 30 | State matrix (17 conditions) | Verified | [TESTING.md › Brief 30](TESTING.md). Backend unreachable on the guest side: `E2E offline`. Payment callback: n/a (deferred). |
| 31 | Integration tests for authorisation, money, transitions and idempotency | Verified | `npm test` |
| 31 | End-to-end tests for critical guest and staff journeys | Verified | `npm run e2e` (scenarios 1, 2, 12, 13, plus checkout, weighed cut, requests, pause, offline) |
| 31 | Scenarios 1–15 | Verified | [TESTING.md › Brief 31](TESTING.md). 1, 2, 12 and 13 also run in the browser. |
| 31 | Scenario 16: online payment callbacks | **Deferred** | Online payments are not enabled |
| 31 | Visual inspection at narrow phone, larger phone, tablet and desktop; long Thai names, keyboard notes, no-image cards, large choice groups, sold out, empty states, long orders; focus, back, reduced motion, touch targets | Verified (partly) | `npm run shots` (320 / 390 / 768 / 1024 / 1440, both languages, audited). Reduced motion and on-screen-keyboard overlap are not captured. |
| 31 | Complete local demonstration with two clients and a persistent database; report passed, failed and not run | Verified | `E2E a`–`f`; [TESTING.md](TESTING.md) |
| 32 | Implementation checklist and decision log in the repository | Verified | This file; [DECISIONS.md](DECISIONS.md) |

## Part D: navigation, tracking, tables, insights, archive (33–43)

| § | Requirement | State | Evidence and notes |
| --- | --- | --- | --- |
| 33 | Guest: Menu, Your order, Track; table and language always visible; service area on every main screen; bill shortcut on Track | Verified | `VIS guest/*`; `E2E d` (Track links to the bill) |
| 33 | Food and Drinks control with categories beneath; All categories sheet | Verified | `VIS guest/categories-*` |
| 33 | Admin: Orders (with Requests), Tables, Menu, Insights, More; filtered by permission; role landing | Verified | `VIS staff/*`, `VIS staff/landing-*-th-1024`; D-C4a-02 |
| 33 | Drawer for contextual work; no nested dialogs | Implemented | Table drawer; D-C4b-01 (confirmations replace the panel body) |
| 33 | Simplicity targets: menu immediately, one-tap add, one tap to Track or draft, one-action line advance, sold-out toggle from a list, one Complete checkout, useful default stats view, no hover-only paths | Verified | `E2E a`, `E2E b`, `E2E f`, `E2E h` (stats default week); `VIS staff/menu-availability-*` |
| 34 | Menu row: photo (about 96–120 px, 4:3), full name, description, price, availability, Add | Verified | `VIS guest/menu-*-320`, `-390` |
| 34 | Review queue identifies missing images and descriptions | Verified | `VIS staff/review-queue-en-1440`; D-S1.3 counters |
| 34 | Image failure falls back to a text card | Implemented | DishRow text-led variant |
| 34 | Your order: image, name, choices, note mark, quantity, total, edit and remove; charges; Send order (not Checkout) | Verified | `VIS guest/cart-*` |
| 34 | Rounds grouped by reference; "Your draft" versus "Table orders" | Verified | `E2E e`; `VIS guest/track-*` |
| 34 | Designed states: first scan, no access, empty group, no results, first item, required missing, editing, sold out after adding, pending, ambiguous, success, partly served, all served, bill preparation, confirmed checkout, visit ended | Verified | `REVIEW` (p08/g06, p02/p03, e01, p04, g02, g04, g10/g11, g12–g14, g16, g18/g19, g17, g23, g24, g36, g40, g42/g43/g45); `VIS states/*`, `VIS guest/join-*`, `menu-first-item-*` |
| 35 | Parcel-style timeline: current, done with real times, upcoming muted; per-dish progress; honest summaries | Verified | `E2E b`; `IT journey.test.ts`; `VIS guest/track-full-*` |
| 35 | "Currently preparing" for drinks and desserts | Verified | `IT journey.test.ts`; `IT portions.test.ts › one shared cut plus separately prepared drinks…`; editable per category and dish (`prep_kind`, D-S8-18) |
| 35 | A skipped Almost done is not invented; rejected and cancelled shown per dish with their bill effect | Verified | `IT journey.test.ts › Preparing -> Ready directly…` |
| 35 | Animate once per confirmed change; no replay on reconnect; stale-status message when disconnected | Implemented (partly verified) | `VIS guest/track-offline-*`; animation rules are in the CSS and not tested |
| 35 | Staff: next action on the card, detail panel, batch counts, corrections with reason, Finish order semantics | Verified | `E2E b`; `IT concurrency.test.ts`; `IT billing.test.ts` |
| 36 | Live grid with Available, Dining, Checking out and Disabled, badges, filters and reconciling counts | Verified | `IT billing.test.ts › Available, Dining and Checking out counts reconcile…`; `VIS staff/tables-*` |
| 36 | Tile and drawer contents; covers optional with an unknown state | Verified | `VIS staff/tables-drawer-*`; `IT insights.test.ts` (missing covers) |
| 36 | Complete checkout transaction (9 steps), idempotent, exact blockers, lost-response recovery | Verified | `IT billing.test.ts` (14 tests); `IT concurrency.test.ts` (checkout races); `E2E f` |
| 36 | Connected guests see a calm end; drafts cleared; disconnected guests told on their next request; the next party uses the same QR | Verified | `E2E f` (ended screen live, drafts cleared, old cookie refused, rescan clean); `VIS states/visit-ended-*` |
| 36 | Automatic Available; "Needs clearing" only as an explicit option | Verified · **Deferred** (option) | `E2E f`; `needs_clearing` is refused until built (D-S7-07) |
| 37 | Order Stats: period and comparison, headline, seven-day bars, drill-down | Verified | `IT insights.test.ts`; `E2E h`; `VIS stats/order-stats-*` |
| 37 | Distinct metrics (submitted and accepted rounds, visits, devices, recorded diners with coverage, items) | Verified | `IT insights.test.ts` tests 1–2 |
| 37 | Chart rules: Mon–Sun Bangkok, today partial, future unavailable, zero versus missing, y from zero, bar inspection, week navigation, month and year views, comparisons without infinite growth, distinct totals recomputed, table equivalent and export | Verified | `IT insights.test.ts` tests 3–8; `VIS stats/order-stats-month-*`, `-year-*` |
| 37 | Supporting cards with definitions; day drill-down with references and permissions | Verified | `IT insights.test.ts`; D-C7a-01 |
| 38 | Menu Stats: week, month, year and custom; navigation; category; most and least | Verified | `IT insights.test.ts` tests 9–12; `VIS stats/menu-stats-*` |
| 38 | Net accepted quantity by default; separate submitted demand; stable ids; variants under the parent; ties; New; archived kept; Top 5/10 and search | Verified | `IT insights.test.ts` |
| 38 | Least ordered includes eligible zero-order items; excludes drafts; availability context; "never ordered" versus "insufficient availability"; units per available day | Verified | `IT insights.test.ts` |
| 38 | Item detail: trend, variants, impressions, dwell, add rate, attribution | Verified | `IT insights.test.ts › the item detail shows…` |
| 38 | Descriptive findings only; placement changes recorded; no automatic reshuffle | Implemented | D-S1.1 (reorder audited); copy |
| 39 | Real instrumentation; sessions separate from visits; pseudonymous ids | Verified | `IT engagement.test.ts`; D-C3-01 |
| 39 | Active time: visible plus 30 s idle threshold, pauses, monotonic clock, server timestamps; heartbeat batches; dedupe; caps | Verified | `IT engagement.test.ts` tests 1–5; D-C3-02, D-C3-03 |
| 39 | One tab counts per browser (tab leader) | Implemented | BroadcastChannel plus a localStorage lease (D-C3-02). No automated test. |
| 39 | Event contract (menu_view … visit_checkout_complete); server-sourced order and checkout events | Verified | `IT engagement.test.ts` |
| 39 | Scroll and exposure rules; documented funnel (quick add, devices, missing telemetry, staff-assisted) | Verified | `IT engagement.test.ts › funnel attribution…` |
| 39 | Metrics with denominators and coverage; no "abandonment" before timeout | Verified | `IT engagement.test.ts`; `VIS stats/engagement-*` |
| 39 | No notes, PINs or secrets in analytics; notice and opt-out; ordering works with analytics off | Verified | `IT engagement.test.ts` (opt-out, disabled, down); `IT realtime.test.ts` (payloads) |
| 40 | Annual reset is a change of reporting year, never a deletion; visits spanning years; attribution rules | Verified | `IT reports.test.ts › the New Year rollover…`; D-11 |
| 40 | Cross-year weeks complete; year view clipped; Bangkok midnight boundary tests | Verified | `IT insights.test.ts › the year view is clipped…`; `UT money-time.test.ts` |
| 40 | Durable facts and rebuildable aggregates; freshness; rollover without the scheduler | Verified | D-S6-11; `npm run jobs -- rollover`, `aggregates` |
| 40 | Versioned snapshots; revised reports never replace the original silently | Verified | `IT reports.test.ts › a revised report…`, `…a late cancellation…` |
| 40 | Raw events retained for a configured period, with aggregates kept and disclosed | Verified | `IT hardening.test.ts` (retention keeps totals); purge date shown on Engagement and in reports (D-S8-02) |
| 41 | Reports → Annual archive: choose a year, coverage and status, generate and download; provisional year to date; final report through a durable job | Verified | `E2E h` (provisional PDF generated and downloaded); `IT reports.test.ts`; D-S7-01, D-S7-02 |
| 41 | Scheduler-less equivalent command | Verified | `npm run jobs -- report --year`, `rollover --run` |
| 41 | PDF identity, charts, embedded Thai fonts, dates, page numbers, repeated headers, landscape appendices | Verified (structure) · layout reviewed as HTML | `IT reports.test.ts › the annual PDF…` checks fonts, Thai text and structure. The layout was reviewed from the print-rendered HTML of a full 2025 report (520 pages). The PDF pages were not rasterised ([TESTING.md](TESTING.md#latest-result)). |
| 41 | Nine content sections; complete appendices; companion CSV exports; no secrets or notes | Verified | `IT reports.test.ts › the annual data export…`; D-S7-06 |
| 41 | Job states with retry; consistent snapshot; permission rechecked on download; no predictable URLs | Verified | `IT reports.test.ts`; D-S7-01, D-S7-03 |
| 41 | Approved logo | Needs owner content | Typographic wordmark until a logo is supplied (D-S7-05) |
| 41 | Tests: small and full-year data, long Thai names, zero-order items, missing covers and telemetry, late corrections, cross-year visits; generation does not block ordering | Verified | `IT reports.test.ts` (8 tests) |
| 42 | Motion system with short eased transitions and reduced-motion alternatives | Implemented | CSS tokens and `prefers-reduced-motion` rules (DESIGN.md). No automated test. |
| 42 | Brief new-order outline, no flashing; table reset transition; chart transitions without invented values | Implemented (partly verified) | `E2E b` (`is-new` emphasis) |
| 42 | Reserved image sizes; lazy offscreen images; no big animation library; responsive controls | Implemented | No animation dependency in `package.json` |
| 42 | Visible focus; accessible chart values; polite announcements | Implemented | Chart table equivalent (brief 37). No screen-reader run. |
| 43 | Additional acceptance criteria (15 bullets) | Verified (one partly) | [TESTING.md › Brief 43](TESTING.md). Visual QA of the guest menu, tracker, table grid, weekly chart, rankings and report: `npm run shots`, with the report pages reviewed separately. |

## Part E: grill-specific rules (44)

| § | Requirement | State | Evidence and notes |
| --- | --- | --- | --- |
| 44A | `pricing_type` fixed, variant or measured_weight; integer grams and satang; separate rate, basis, grams and amount | Verified | `UT money-time.test.ts` (`measuredAmount`); `IT pricing.test.ts` |
| 44A | Staff quote flow (8 steps), idempotent requests, expiry, confirmation creates one line, in-person confirmation, revisions | Verified | `IT portions.test.ts` (17 tests); `E2E c` (request, staff quote 420 g → ฿2,058, guest confirm, board) |
| 44A | Fixed-price dishes can be ordered while a request is pending; Track shows "Awaiting portion confirmation"; checkout rule explicit | Verified | `IT portions.test.ts`; `E2E c`; D-22 |
| 44A | Tests: duplicate, double confirm, changed revision, expired, two staff edits, closure while pending, lost response | Verified | `IT portions.test.ts` |
| 44A | Minimum, presets and fixed-weight variants only with owner confirmation | Needs owner content | Owner question 2 |
| 44B | Doneness only on approved items; included versus paid sides; no invented sauces; sharing notes only with content | Implemented · Needs owner content | Validated in `IT journey.test.ts` and `IT pricing.test.ts` with test fixtures. No real item has doneness or sides yet (questions 2–4). |
| 44C | Lamb rack held for review; matcha hot and iced as variants (a dash means unavailable); duplicates separate; draft-beer volumes as variants | Implemented · Needs owner content | `catalog.json` flags; `E2E a` (hot matcha unavailable); questions 1, 5, 8, 9 |
| 44C | Alcohol: owner-controlled availability, staff-confirmation flag, core menu works when disabled | Implemented · Needs owner content | `settings.alcohol`; 7 alcohol items; legal rules not modelled (question 13) |
| 44D | Seasonal avocado unpublished until confirmed; dates, override and history; seasonal expiry in a draft triggers review | Verified · Needs owner content | `IT portions.test.ts › …goes out of season or sells out while in a draft…`; question 11 |
| 44D | Beer promotion kept as a source note; promotional pricing disabled | **Deferred** (promotions) · Needs owner content | D-09; question 12 |
| 44E | Reference category names and order; Drinks row and All categories sheet; staff-configurable order; search across groups | Verified | `VIS guest/menu-*`, `guest/categories-*` |
| 44E | Text-led cards for unphotographed items; audit counts (imported, verified, missing photos and descriptions, ambiguous prices, pending portions, disabled seasonal) | Verified | `VIS staff/review-queue-en-1440`; [source-audit.md §2](source-audit.md) |
| 44F | Servings and total grams for weighed cuts; separate weight view | Verified | `IT insights.test.ts › measured-weight cuts count servings…` |
| 44F | Quote funnel stages separate; unapproved requests never count | Verified | `IT portions.test.ts`; `IT insights.test.ts` |
| 44F | Realistic checks: shared cut plus drinks, two doneness levels, included versus upgraded sides, seasonal expiry, quote racing checkout, in-person confirmation | Verified | `IT portions.test.ts`, `IT concurrency.test.ts` |

## Part F: delivery (45)

| Deliverable | State | Where |
| --- | --- | --- |
| Working guest and staff interfaces | Verified (local) | `npm run e2e`, `npm run shots` |
| Persistent schema, migrations, fixtures, owner menu import template | Verified | `server/db/`; **Menu → Import** (header-only template, D-S1.5) |
| Verified reference asset and catalog audit; review queue for ambiguous records | Verified · Needs owner content | [source-audit.md](source-audit.md); **Menu → Review** |
| Measured-weight portion flow; grill and drink variants | Verified | `IT portions.test.ts`; `E2E c` |
| Three-tab guest and five-group staff navigation tested on phone and tablet sizes | Verified (emulated sizes) | `VIS guest/*`, `VIS narrow/*`. Real devices not tested. |
| Secure table QR and current-visit joining | Verified | `IT access.test.ts`; `E2E a`, `E2E e` |
| Cross-device order and service workflows | Verified (one computer, several browsers) | `E2E a`–`f` |
| Parcel tracking, live tables, automatic reset | Verified | `E2E b`, `E2E f` |
| Fulfilment, bill finalisation, payment records, operational reports | Verified | `IT billing.test.ts`; `E2E f`; `IT insights.test.ts` |
| Order Stats, Menu Stats, engagement | Verified | `IT insights.test.ts`, `IT engagement.test.ts`; `VIS stats/*` |
| Annual rollover, archive, full-year PDF, companion exports | Verified | `IT reports.test.ts`; `E2E h` |
| Configuration and first-admin setup instructions | Verified | [README.md](../README.md), [OPERATIONS.md](OPERATIONS.md#first-admin), `.env.example` |
| Local startup and multi-device QR testing instructions | Verified (instructions exercised locally) | [OPERATIONS.md](OPERATIONS.md#multi-device-qr-testing-on-a-lan) |
| Backup, restore and deployment notes | Implemented (backup command run locally; restore and deployment not exercised) | [OPERATIONS.md](OPERATIONS.md#backup-and-restore) |
| Test results and unresolved limitations | Verified | [TESTING.md](TESTING.md) |
| Owner-content checklist | Verified | [OWNER-CHECKLIST.md](OWNER-CHECKLIST.md) |
| "Not complete if…" guards: separate mock datasets, simulated success, trusted table input, lost statuses after refresh, guest self-payment, previous party access | Verified | One database (`E2E`); `IT access.test.ts`; `IT concurrency.test.ts`; `E2E f` |

## Open items at a glance

**Needs owner content** (see [OWNER-CHECKLIST.md](OWNER-CHECKLIST.md)):

- menu verification (0 of 95 verified)
- 55 Thai drink names, and 14 Thai translations to approve
- 95 descriptions
- allergens for all items
- photo permission for 39 dish photos; 56 drinks have no photo
- charges and VAT
- payment methods
- hours
- real tables and QR base address
- services
- alcohol rules
- lamb rack, prime rib, wagyu, sides, Long Black, Special Blend and Ice
- duplicate lists, seasonal avocado, beer promotion
- logo
- retention periods (the daily task applies whatever is set)

**Deferred:**

- online payments and callbacks
- POS, KDS and bank reconciliation
- split bills, tips and room charges
- loyalty, inventory and multiple branches
- promotional pricing
- allergen filter
- "Needs clearing" table state

**Implemented but not covered by an automated check:**

- catalog editor UI and CSV import
- tab-leader engagement coordination
- sound replay suppression
- motion and reduced motion
- screen-reader behaviour
- contrast on the running app
- a lost-response submission in the browser
- on-screen keyboard overlap
