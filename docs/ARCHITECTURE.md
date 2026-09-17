# Architecture and build contract

Rabbit Grill Khao Yai ordering platform: one Node 24 process, one SQLite
database, one React client with two interfaces (guest menu and staff admin).
This file is the contract every contributor (human or agent) works to.

## Stack (pinned in package.json)

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | Node 24, native TypeScript type stripping | no build step for the server; `node server/main.ts` |
| HTTP | Hono 4 + @hono/node-server | small, typed routing, SSE helper |
| Database | `node:sqlite` (DatabaseSync), WAL | real transactions, UNIQUE/partial indexes, zero native deps |
| Validation | zod 4 (`shared/schemas.ts`) | one schema for server parsing and client forms |
| Client | React 19 + Vite 8 | two lazy-loaded interfaces in one SPA |
| Realtime | Server-Sent Events + polling fallback | events are an outbox table; commit before broadcast |
| PDF / e2e / screenshots | puppeteer-core driving the installed Edge/Chrome | perfect Thai shaping, no browser download |
| QR | `qrcode` | SVG QR cards |
| Fonts | @fontsource-variable Oswald, Cormorant Garamond, Noto Sans Thai | self-hosted, work on a LAN with no internet |

TypeScript rules that matter at runtime (Node strips types, it does not compile):
- `import type { X }` for type-only imports (verbatimModuleSyntax). A plain
  `import { SomeType }` of a type crashes Node at startup.
- Relative imports include the `.ts`/`.tsx` extension.
- No `enum`, `namespace`, parameter properties or other non-erasable syntax.
- `npm run typecheck` must pass (TypeScript 7).

## Layout

```
shared/        contracts used by both sides - never import server or client code here
  status.ts      state machines (lines, orders, visits, tables, bills, services, portions, jobs)
  money.ts       THE money module (integer satang, rounding, charges, measured weight)
  time.ts        Asia/Bangkok business dates, week/month/year ranges, interval splitting
  permissions.ts role matrix + can()
  schemas.ts     zod request bodies
  dto.ts         response shapes
  errors.ts      API error codes
  settings.ts    restaurant settings + proposed defaults
  ids.ts         ids, order references, secrets, PINs, idempotency keys
server/
  main.ts  app.ts  config.ts
  db/index.ts    one/many/run/insert/updateVersioned, tx(), afterCommit(), migrate()
  db/migrations/ 001_init.sql (append new numbered files; never edit applied ones)
  db/seed.ts     development fixtures (draft catalog, tables, demo staff, fixture history)
  lib/           auth (staff+guest), csrf, ratelimit, events (outbox+SSE), audit, settings, http, errors
  domain/        business logic, synchronous, called inside tx()
    pricing.ts     priceCart() - the only way a cart becomes money
    guards.ts      orderingBlock()/assertCanOrder() - pauses, billing, hours, intake
  routes/        HTTP adapters: parse -> authorize -> tx(domain) -> DTO
  jobs/          runner.ts (in-process jobs), cli.ts (npm run jobs -- <command>)
client/
  index.html, src/main.tsx, src/App.tsx
  src/lib/       router, api, live (SSE + useResource), i18n, config, format, store
  src/i18n/      one dictionary file per area (see index.ts for key namespaces)
  src/ui/        design-system components (docs/DESIGN.md)
  src/styles/    tokens.css (design tokens), base.css, components.css
  src/guest/     guest interface
  src/admin/     staff interface
public/media/    processed photographs (npm run assets)
data-src/        catalog.json - audited seed catalog from the restaurant's own menu
scripts/         npm entry points (dev.ts, vite-dev.ts, start.ts, seed.ts), admin-create, db-reset,
                 assets, i18n-check, browser.ts (shared headless launcher), qa-shoot.ts / shot.ts
test/            unit/ and integration/ (node:test, `npm test`), e2e/ (browser journeys,
                 `npm run e2e`), visual/ (screenshots + in-page audit, `npm run shots`)
docs/            this file, API.md, CLIENT.md, DESIGN.md, UI-KIT.md, DECISIONS.md, TESTING.md,
                 FEATURE-MATRIX.md (the implementation checklist, brief 32/43), OPERATIONS.md,
                 OWNER-CHECKLIST.md, source-audit.md
```

Runtime processes: `npm start` is one Node process (API + built client from
`dist/`). `npm run dev` seeds first, then runs the API under `node --watch` on
127.0.0.1:API_PORT and Vite on HOST:PORT with a file-serving allow-list
(D-DT-01, D-DT-03). Setup and operations: docs/OPERATIONS.md.

## Server conventions

- A route handler: `const input = await body(c, Schema)` → `requireStaff('perm')`
  middleware or `assertCan(c, 'perm')` → `tx(() => domainFn(...))` → return a DTO.
- Domain functions are synchronous and assume they run inside `tx()`.
  Re-read state inside the transaction; never trust what the client last saw.
- Concurrency: every mutable row has `version`. Mutations take the version the
  client saw; `updateVersioned()` returning false → `staleVersion(currentDTO)`.
- Idempotency: client-generated keys + UNIQUE constraints. On replay return
  the original result (HTTP 200, `replayed: true`). Same key with a different
  payload → `idempotency_mismatch`.
- Every state change: `audit(actor, 'area.action', entity, {reason, before, after})`
  and `emit('topic', {audience, visit_id, entity, payload})` inside the same tx.
  Topics: `order.created order.updated line.updated service.updated portion.updated
  bill.updated payment.recorded visit.opened visit.updated visit.closed
  table.updated menu.updated ordering.updated report.updated settings.updated`.
  Guest-visible changes use `audience: 'all'` (menu/ordering) or `'guest'`/`'all'`
  with `visit_id`. Staff-only: `audience: 'staff'`. Payloads carry ids, versions
  and short summaries only - never PINs, tokens, notes or payment references.
- Money only through `shared/money.ts`. Never floats. Never trust client totals.
- Time: store `nowIso()`; stamp `business_date = businessDate(now, cutoffHour())`.
- `is_fixture = fixtureFlag()` on every new visit/order/line/payment/request/session
  so real reports can exclude demo data.
- Errors: `throw new AppError('code', 'English message', details)`; codes are in
  `shared/errors.ts` (add new codes there AND to `client/src/i18n/errors.ts`).
- Logging: never log tokens, PINs, passwords, notes or payment references.

## Client conventions

- Routing: `useRoute()`, `navigate()`, `Link`, `matchPath()` from `lib/router.ts`.
- Data: `useResource<T>(path, { topics })` refetches on matching live events
  and after every reconnect. Mutations: `api.post/patch` then `refresh()`.
- Live: guest interface wraps in `<LiveProvider url="/api/guest/events">`, admin in
  `<LiveProvider url="/api/staff/events">`. Show `useLive().state` in the header.
- Text: `useI18n()` → `t(key)`, `pick(bilingual)`. No hard-coded user-facing
  strings. Put `lang={picked.lang}` on elements showing fallback-language data.
- Components come from `src/ui` (docs/DESIGN.md). No inline colour values:
  use tokens. Every interactive element ≥ 44×44 px, visible focus, no
  hover-only information, status never by colour alone.
- Money display: `money(minor)`; time: `clock(iso)` (Bangkok).
- Local persistence only through `storage` in `lib/store.ts` (try/catch safe).

## File ownership during the parallel build

Each workstream owns its files. Do not edit files owned by another stream;
if you need something from one, use its documented export or leave a note in
your final report. Shared files you may APPEND to (never rewrite others' parts):
`shared/errors.ts` (+ matching `client/src/i18n/errors.ts`), `docs/DECISIONS.md`.

| Stream | Owns |
| --- | --- |
| S1 catalog | server/domain/catalog.ts, server/domain/importer.ts, server/routes/catalog.ts |
| S2 tables & visits | server/domain/tables.ts, server/domain/visits.ts, server/domain/qr.ts, server/routes/tables.ts |
| S3 orders | server/domain/orders.ts, server/domain/fulfillment.ts, server/routes/orders.ts |
| S4 service & portions | server/domain/service.ts, server/domain/portions.ts, server/routes/service.ts |
| S5 billing | server/domain/billing.ts, server/domain/payments.ts, server/domain/checkout.ts, server/routes/billing.ts |
| S6 insights | server/domain/analytics.ts, server/domain/stats.ts, server/domain/kpi.ts, server/domain/aggregates.ts, server/routes/insights.ts (server/lib/csv.ts is foundation: use it) |
| S7 reports & admin | server/domain/reports.ts, server/domain/pdf/*, server/domain/export/*, server/domain/team.ts, server/domain/settings-admin.ts, server/domain/audit-view.ts, server/routes/admin.ts, server/jobs/* |
| S8 seed | server/db/seed.ts, server/db/seed/* |
| C0 UI kit | client/src/ui/*, client/src/styles/base.css, client/src/styles/components.css |
| C1a guest shell & menu | client/src/guest/GuestApp.tsx, client/src/guest/shell/*, client/src/guest/menu/*, client/src/i18n/guest.ts |
| C1b item sheet, cart & submit | client/src/guest/cart/*, client/src/i18n/cart.ts |
| C2 guest visit | client/src/guest/visit/*, client/src/i18n/visit.ts |
| C3 tracker | client/src/lib/tracker.ts |
| C4a admin shell | client/src/admin/AdminApp.tsx, client/src/admin/shell/*, client/src/i18n/admin.ts |
| C4b orders board | client/src/admin/orders/*, client/src/i18n/orders.ts |
| C5 tables & billing | client/src/admin/tables/*, client/src/admin/billing/*, client/src/i18n/tables.ts |
| C6 admin menu | client/src/admin/menu/*, client/src/i18n/catalog.ts |
| C7a insights | client/src/admin/insights/*, client/src/i18n/insights.ts |
| C7b more | client/src/admin/more/*, client/src/i18n/more.ts |

Cross-stream exports that others rely on are listed in docs/API.md under
"Internal module contracts" (server) and docs/CLIENT.md (client).
