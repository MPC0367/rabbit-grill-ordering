# Client contract

Read with ARCHITECTURE.md (conventions) and DESIGN.md (visual system).
Each client stream owns the files listed here; other streams import them by
these exact paths and props. Default exports for pages and panels.

## Shared foundation (already written)

- `lib/router.ts` - `useRoute`, `navigate`, `back`, `Link`, `matchPath`, `setQuery`
- `lib/api.ts` - `api.get/post/patch/del`, `ApiError` (`code`, `status`, `details`, `ambiguous`), `qs()`
- `lib/live.tsx` - `LiveProvider`, `useLive`, `useLiveEvent`, `useResource`
- `lib/i18n.tsx` - `useI18n()` → `{ t, lang, setLang, pick, both, has }`
- `lib/config.tsx` - `useConfig()` → public config
- `lib/format.ts` - `money`, `clock`, `dateLabel`, `dateTime`, `elapsed`, `durationMs`, `num`, `pct`, `grams`, `weekdayShort`, `monthLabel`
- `lib/store.ts` - `createStore`, `useStore`, `storage`, `useNow`, `useMedia`
- `lib/tracker.ts` (C3) - engagement instrumentation; read the file for its exports
- `shared/*` - DTOs, schemas, statuses, money (`priceGroupPicks`, `allocateGroupPicks`, `measuredAmount`, `formatMoney`), ids (`newIdempotencyKey`)

## UI kit (C0) - `client/src/ui/`

Every component is a named export from `client/src/ui/index.ts`. The kit
defines the full vocabulary in DESIGN.md: buttons, icons, segmented control,
chips, search, sheet/dialog/drawer, stepper, fields, badges and status pills,
banners, toasts and live region, empty states, skeletons, connection indicator,
tabs, stat cards, data table, WeekBarChart, Timeline, Price, LangToggle,
DishImage, Wordmark and PageHeader. Read `client/src/ui/index.ts` and the
gallery at `/ui-kit` (development only) before building screens.

## Guest interface

| Path | Owner | Contract |
| --- | --- | --- |
| `guest/GuestApp.tsx` | C1a | default export; providers + routes: `/`→`/menu`, `/menu` MenuPage, `/q/:token` JoinPage, `/menu/cart` CartPage, `/menu/orders` TrackPage, `/menu/bill` BillPage; `mode==='ended'` → VisitEndedPage; wraps joined mode in `<LiveProvider url="/api/guest/events" onEnded={markEnded}>` |
| `guest/shell/session.tsx` | C1a | `GuestSessionProvider`; `useGuestSession(): { mode: 'loading'\|'public'\|'joined'\|'ended'; session: GuestSessionDTO \| null; endedReason: string \| null; refresh(): Promise<void>; setSession(s: GuestSessionDTO): void; markEnded(reason?: string): void }` |
| `guest/shell/catalog.tsx` | C1a | `CatalogProvider`; `useCatalog(): { catalog?: CatalogDTO; item(id): MenuItemDTO \| undefined; category(id): MenuCategoryDTO \| undefined; refresh(): Promise<void>; error: ApiError \| null }` (refreshes on `menu.` events) |
| `guest/shell/overlays.tsx` | C1a | `OverlayProvider`; `useOverlays(): { openItem(itemId: string, opts?: { lineUid?: string; source?: number }): void; openService(): void; openPortion(itemId: string): void; close(): void }` - renders the sheets below, one at a time, integrated with browser Back |
| `guest/shell/*` (header, bottom nav, banners) | C1a | internal |
| `guest/menu/MenuPage.tsx` | C1a | default export, no props |
| `guest/cart/store.ts` | C1b | `useCart(): { lines: CartLine[]; count: number; subtotalMinor: number; issues: QuoteIssue[]; quote: QuoteDTO \| null; add(input: NewCartLine): void; update(uid: string, patch: Partial<NewCartLine>): void; remove(uid: string): void; removeSubmitted(uids: string[]): void; requote(): Promise<void> }`; `useCartCount(): number`; `bindCart(visitId: string \| null, guestId: string \| null): void` (called by GuestApp when the session changes; clears drafts of ended visits) |
| `guest/cart/ItemSheet.tsx` | C1b | default export `{ itemId: string; lineUid?: string; onClose(): void }` |
| `guest/cart/CartPage.tsx` | C1b | default export, no props (includes review + submit flow) |
| `guest/cart/submit.ts` | C1b | submission state machine (idempotency key persisted until resolved; ambiguous → attempt lookup first) |
| `guest/visit/JoinPage.tsx` | C2 | default export `{ token: string }` |
| `guest/visit/TrackPage.tsx` | C2 | default export, no props; reads `?placed=<reference>` to highlight a new round |
| `guest/visit/BillPage.tsx` | C2 | default export, no props |
| `guest/visit/ServiceSheet.tsx` | C2 | default export `{ onClose(): void }` |
| `guest/visit/PortionRequestSheet.tsx` | C2 | default export `{ itemId: string; onClose(): void }` |
| `guest/visit/VisitEndedPage.tsx` | C2 | default export, no props |
| `guest/visit/NoAccessPanel.tsx` | C2 | default export `{ reason: 'public' \| 'revoked' \| 'required'; compact?: boolean }` - shown when a public visitor tries to order, track or view a bill |

## Staff interface

| Path | Owner | Contract |
| --- | --- | --- |
| `admin/AdminApp.tsx` | C4a | default export; auth gate, `<LiveProvider url="/api/staff/events">`, layout, routing table below |
| `admin/shell/session.tsx` | C4a | `StaffSessionProvider`; `useStaff(): { me: StaffMeDTO; can(p: Permission): boolean; logout(): Promise<void>; refresh(): Promise<void> }` |
| `admin/shell/AdminLayout.tsx` | C4a | five destinations (Orders, Tables, Menu, Insights, More) filtered by permission, workspace header (connection, ordering state + pause control, identity, sound toggle slot, demo badge) |
| `admin/shell/LoginPage.tsx`, `admin/shell/OverviewPage.tsx` | C4a | default exports |
| `admin/shell/sound.ts` | C4a | `useAlertSound(): { enabled: boolean; setEnabled(v: boolean): void; test(): void; play(kind: 'order' \| 'request'): void }` |
| `admin/orders/OrdersPage.tsx` | C4b | default export `{ tab: 'board' \| 'requests' }` |
| `admin/orders/AssistOrderPanel.tsx` | C4b | default export `{ visitId: string; mode?: 'assist' \| 'recover'; onClose(): void; onDone?(reference: string): void }` |
| `admin/tables/TablesPage.tsx` | C5 | default export `{ tableId?: string }` (drawer open when set) |
| `admin/tables/QrPrintPage.tsx` | C5 | default export, reads `?ids=` |
| `admin/billing/BillPanel.tsx` | C5 | default export `{ visitId: string }` |
| `admin/billing/PaymentsPage.tsx` | C5 | default export |
| `admin/menu/MenuPage.tsx` | C6 | default export `{ tab: 'availability' \| 'catalog' \| 'review' \| 'import'; itemId?: string }` |
| `admin/insights/InsightsPage.tsx` | C7a | default export `{ tab: 'orders' \| 'menu' \| 'engagement' }` |
| `admin/more/MorePage.tsx`, `ReportsPage.tsx`, `TeamPage.tsx`, `SettingsPage.tsx`, `AuditPage.tsx` | C7b | default exports |

Admin routes (C4a wires them; page files may still be placeholders while others build):

```
/admin/login                LoginPage
/admin                      OverviewPage
/admin/orders               OrdersPage tab=board
/admin/orders/requests      OrdersPage tab=requests        (alias /admin/service)
/admin/tables               TablesPage
/admin/tables/print         QrPrintPage
/admin/tables/:id           TablesPage tableId
/admin/menu                 MenuPage tab=availability
/admin/menu/catalog         MenuPage tab=catalog
/admin/menu/items/:id       MenuPage tab=catalog itemId
/admin/menu/review          MenuPage tab=review
/admin/menu/import          MenuPage tab=import
/admin/insights             → /admin/stats/orders
/admin/stats/orders|menu|engagement   InsightsPage tab
/admin/more                 MorePage
/admin/payments             PaymentsPage
/admin/reports              ReportsPage
/admin/team                 TeamPage
/admin/settings             SettingsPage
/admin/audit                AuditPage
```

## i18n ownership

`i18n/guest.ts` C1a · `i18n/cart.ts` C1b · `i18n/visit.ts` C2 · `i18n/admin.ts` C4a ·
`i18n/orders.ts` C4b · `i18n/tables.ts` C5 · `i18n/catalog.ts` C6 ·
`i18n/insights.ts` C7a · `i18n/more.ts` C7b. Key prefixes are listed in `i18n/index.ts`.
The entry bundle registers only `common` and `errors`; `i18n/guest-bundle.ts`
(GuestApp) and `i18n/admin-bundle.ts` (AdminApp) register the rest, so guest
code must use only common, errors, guest, cart and visit keys.
`node scripts/i18n-check.ts` checks every `t('…')` key in both languages.
Thai copy rules (from the marketing site's native-speaker audit): natural
restaurant Thai, no calques (`คือที่ทางของ`), no `ถูก` + verb passives, no
officialese (`จึงขอให้`), keep brand names in Latin script (Facebook, LINE), no
English em dashes or semicolons inside Thai, and every call to action names its
action. Use `คุณ` sparingly.
