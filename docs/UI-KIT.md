# UI kit reference

Written by the two kit builders (C0a primitives + guest kit, C0b staff + data kit). The source of truth is client/src/ui/index.ts and the gallery at /ui-kit (dev).

## C0b-staff-data-kit

The staff and data kit is built, and `/ui-kit` loads `GalleryAdmin` inside C0a's page. `npm run typecheck` passes for the whole project, and the Vite server on 8622 is stopped (only closed TIME_WAIT sockets remain). The board, tables and insights screens now match `admin-board.png`, `admin-board-tablet.png`, `admin-tables.png` and `admin-stats.png` closely at 1440 and 820 wide. My DOM audit came back clean in Thai at 1440 and 390, with one exception: the "ไม่มีข้อมูล" chart label, which is single-line SVG text the audit misreads. The audit checks page overflow, text under 12px, Thai letter-spacing, Thai line-height below 1.55 and targets under 44px.

## Exported components (`client/src/ui/admin/index.ts`)
Every component also takes `className`. `forwardRef` is noted where it applies.
- `AdminRail({ mode?: 'full'|'compact', homeHref?, nav, footer? })` – forwardRef, charcoal `<aside>`
- `RailNav({ items: RailItem[], mode?: 'full'|'compact'|'bar', fixed?, onNavigate?(item, e) })` – forwardRef. `RailItem = { id, label, href, icon, count?, countLabel?, current? }`
- `RailFooter({ alertsOn, onAlertsChange?, onTestAlert?, onLock?, lockHref?, lang, onLangChange, dateLabel?, timeZone? })` – forwardRef
- `WorkspaceHeader({ title, tabs?: SubTabItem[], tabsLabel?, onTabNavigate?, demo?, extra?, connection?, ordering?, identity?, compact? })` – forwardRef
- `SubTabs({ items, label, onNavigate? })`
- `DemoStamp({ label? })`
- `OrderingControl({ paused, pausedDetail?, onPause?, onResume?, busy? })` – forwardRef
- `StaffChip({ name, role, initials?, onOpen?, menuLabel? })`
- `PageHeader({ title, back?: { label, href, onNavigate? }, description?, actions?, demo? })` – forwardRef
- `SectionHeader({ title, titleId?, description?, actions?, display?, level? })`
- `Ticket({ table, reference, round, time, timeKind?, waitMinutes, lateAfterMinutes?, stage, flags?, allergy?, note?, lines: TicketLineData[], lineStatus?, meter?, isNew?, primary?: TicketAction, secondary?, onMore?, moreLabel?, conflict?: { by, at, onReview? }, label? })` – forwardRef
- `TicketLine(TicketLineData & { showStatus? })`. `TicketLineData = { id, quantity, name, nameLang?, secondary?, secondaryLang?, noThaiName?, chips?: { label, quantity?, lang? }[], example?, weight?: { text, confirmedAt? }, alcohol?, note?, noteLang?, status, statusAt?, actor?, reason? }`
- `TicketFlag({ kind: 'oldest'|'late'|'just'|'ready'|'station', label?, minutes? })`
- `AllergyBand({ text, lang? })`
- `GuestNote({ text, lang?, label? })`
- `ProgressMeter({ lines: { status, quantity }[] })`
- `BoardColumn({ stage, count, title?, hint?, help?, empty?, current?, children })` – forwardRef
- `BoardGrid({ layout?: 'columns'|'single' })`
- `BoardStatusSwitch({ counts, value, onChange })`
- `BOARD_STAGES` – constant listing the five board stages
- `BoardToolbar({ stationCounts, station, onStation, tables, table, onTable, sorts, sort, onSort, showExceptions, onShowExceptions, query, onQuery })`
- `TableStrip({ tables: FloorTable[], selectedId?, onSelect?, openHref?, onOpen?, title? })` – forwardRef. Its legend counts are computed from the same tiles, so they always reconcile.
- `FloorTile(FloorTable & { selected?, onSelect? })` – forwardRef
- `TableLegend({ counts })`
- `AttnBadge({ kind: 'new'|'ready'|'call'|'quote'|'bill', detail? })`
- `attentionKinds(dto.attention)`, `ATTN_PRIORITY`, `STATE_SWATCH` – helpers and constants
- `TableTile({ label, state, attention?: { kind, detail? }[], seated?, facts?, action?: { label?, onClick?, disabled?, busy?, describedBy? }, selected?, ariaLabel? })` – forwardRef to the action button, so focus can return to it
- `TablesSummaryBar({ counts, filter, onFilter, attentionCount, attentionOnly, onAttentionOnly, query, onQuery })` – the "All" count is the sum of the four states
- `TableDrawerHeader({ label, state, meta?, onClose, titleId? })`
- `TableBox({ label })`
- `TableStatePill({ state })`
- `DrawerSection({ title, aside?, children })`
- `GuestAccessPanel({ pin, revealed, onReveal, onRotate?, onRevoke?, devices, lockedUntil?, rotating? })`
- `CheckoutBlockers({ items, title?, id? })`
- `RoundList({ rounds: RoundData[], quotes?: QuoteWellProps[] })`
- `QuoteWell({ name, nameLang?, detail, status })`
- `LineStatusPill({ status, time?, label? })`
- `HistoryList({ items: { id, time, event, detail? }[] })`
- `FilterChips({ options: ChipOption[], value, onChange, label })`
- `SelectButton({ label, value, options, onChange, icon?, disabled? })` – a native `<select>` styled as the toolbar button
- `CheckButton({ label, checked, onChange, count? })`
- `StaffSearch({ label, placeholder?, value, onChange, onSubmit?, id? })` – forwardRef
- `StatCard({ label, value?, parts?, unit?, live?, comparison?, note?, definition?, coverage?: { ratio, text }, state?: 'ready'|'loading'|'error', onRetry? })` – forwardRef
- `StatGrid(div props)`
- `HeroMetric({ label, labelId?, value, unit, comparison?: { direction, delta?, text, sub? }, selected?: { title, tag?, items } })`
- `ChartPanel({ labelledBy?, solo?, tone?: 'dark'|'light' })`
- `MetricSwitch({ options, value, onChange, onExplain?, label? })`
- `DefinitionButton({ label, children })` – uses the native popover
- `ComparisonLine({ comparison })`
- `WeekBarChart({ title, buckets: ChartBucket[], unit, listLabel?, selectedKey?, onSelect?, onRetry?, priorLabel?, priorSpoken?, view?, onViewChange?, height?, legend?, labelEvery?, format?, actions?, currentLabel? })` – SVG. `ChartBucket = { key, label, sublabel?, spoken, state: 'complete'|'partial'|'future'|'missing', value, prior?, detail? }`
- `ChartLegend({ priorLabel? })`
- `MiniBars({ data: { key, label, value, spoken? }[], title, unit, highlightKey?, labelEvery?, height? })`
- `RankingTable({ label, changeHeader?, footerText?, footerAction?, refreshing?, empty?, children })`
- `RankingRow({ rank, image?, name, nameLang?, english?, category?, servings, shareText?, bar?, orders, visits, change: RankChange, context: RankContext, variants?, imageLoading? })`
- `Delta({ change })`
- `DataTable<T>({ columns: DataColumn<T>[], rows, rowKey, caption, showCaption?, sort?, onSort?, selectedKey?, rowActions?, actionsLabel?, empty?, footer?, maxHeight?, id? })`. `DataColumn = { key, header, cell, numeric?, code?, sortable?, width?, headerText?, wrap? }`
- `KeyValue({ items: { term, value, strong?, muted?, termLang?, valueLang? }[], numeric?: 'ui'|'display'|false })`
- `DateRangeNav({ period, onPeriod?, periods?, label, range, timeZone?, onPrev?, onNext?, prevDisabled?, nextDisabled?, onCurrent?, isCurrent?, date?, onPickDate?, minDate?, maxDate?, layout?: 'stats'|'ranking', children? })`
- `PeriodSwitch({ value, onChange, periods? })`
- `JobStatusRow({ title, meta?, status: JobStatus, label?, revision?, size?, error?, attempts?, fixture?, downloadHref?, onDownload?, onRetry?, retrying?, as? })`
- `JobList(ul props)`
- `AuditEntry({ time, date?, at?, actor, actorType?, action, target?, reason?, changes?: { field, before, after }[], as? })`
- `AuditList(ol props)`

**Wiring notes for the screen agents:**
- **Primitives:** the kit reuses C0a's `Icon`, `Button`, `IconButton`, `LinkButton`, `Badge`, `Pill`, `StatusPill`, `Tag`, `Flag`, `SegmentedControl`, `Skeleton`, `EmptyState` and `ConnectionIndicator` rather than duplicating them.
- **Connection slot:** `WorkspaceHeader` doesn't render the connection pill itself; pass C0a's `<ConnectionIndicator variant="staff" />` in `connection`.
- **Table drawer:** use C0a's `Drawer` with `lead={<TableBox/>}` and `status={<TableStatePill/>}`.
- **Sticky header:** `WorkspaceHeader`'s sticky element is now an outer `.wshead-cq`, with `.wshead` inside it. When the workspace gets narrow, the demo stamp, sync time and other long texts hide based on the header's own width, not the viewport.

## CSS and i18n
- **`client/src/styles/admin-kit.css`**, in ten sections:
  1. Thai safety: Oswald caps labels switch to Noto with no tracking, and Thai lines keep line-height 1.55.
  2. Rail modes by class: compact tablet rail and phone bottom bar.
  3. Header, page header and section header, including the header size queries.
  4. Toolbar controls.
  5. Board: single-column layout, empty column, the new-ticket outline that appears once.
  6. Floor strip and table pieces.
  7. Insights: definition popover, the SVG chart, MiniBars, and narrow layouts for the chart panel and ranking (container queries).
  8. Data table frame: sticky header, sort buttons, selected row.
  9. Report jobs and audit entries.
  10. Gallery frames.
  - Only tokens are used; no raw colours.
- **`client/src/i18n/common.ts`**: I added about 200 kit strings to both th and en, under `common.staff.*`, `common.ticket.*`, `common.board.*`, `common.floor.*`, `common.attn.*`, `common.tile.*`, `common.access.*`, `common.chart.*`, `common.period.*`, `common.rank.*`, `common.job.*` and `common.audit.*`.
- **`client/src/ui/admin/GalleryAdmin.tsx`**: shows every component at 1440 and 820 wide using the admin mock data: tables 01–16, the RG-4M2Q allergy ticket, and a week chart with Wednesday at zero, today partial and the upcoming days. It also shows month (30 bars) and year (12 bars) views with a failed load, the table view, a light variant, rankings with real `/media/dish/` photos, job rows in all four states, audit entries and the phone bottom bar. It uses the app's language, and the language box in any rail switches the whole kit.

## What I checked
- **Screenshots:** English and Thai at 1440, plus 390, using `scripts/shot.ts` and a per-section capture script (a full-page capture is cut off at 16,384px). I also opened the real `/ui-kit` page. Everything is in `var/scratch/kit/`.
- **Scratch files:** I also left these in `var/scratch/kit/`: `admin-gallery.html` and `entry.tsx` (a page that renders only the staff kit) and the capture helpers `sections.ts`, `measure.ts` and `crop.mjs`.
- **Fixes made along the way:**
  - My `.round` class collided with the guest "round card" CSS, so I renamed it to `.rround`.
  - The attention badges ("READY 1") were wrapping onto two lines.
  - The workspace header overlapped itself when narrow.
  - Month-view axis labels collided with each other.
  - Some Thai text had tracking or a line-height below 1.55.
  - "1 devices joined" now reads "1 device joined".
- **Not checked:** the chart bar-height transition on a period change isn't visible in still screenshots. The bars are keyed by position so the heights should animate, but I haven't seen it run.

## C0a-styles-guest-kit

The React UI kit (primitives plus the guest kit), `base.css` and `components.css` are done. `npm run typecheck` passes for the whole project. I checked it on /ui-kit at 390, 320 and 1440 wide in Thai and English, and stopped my dev server on 8621 afterwards.

The guest pieces render almost exactly like the reference mocks: the menu, item sheet, service sheet, all-categories sheet and track page, including the 320px language box that shows only "EN". A scripted browser run of 39 behaviour checks all passed.

## Decisions for you
- **Note length counting.** The server counts a note by code points (`[...note].length` in `server/domain/pricing.ts`), not by what a reader sees as characters. So `TextArea` counts the same way by default, so Thai notes near the limit don't get rejected by the server. Grapheme counting is available as `measure="grapheme"`. Either way, a note cut at the limit never splits a Thai vowel or tone mark from its letter.
- **`PageHead` instead of `PageHeader`.** The staff kit already exports a `PageHeader`, so the guest page heading is named `PageHead` to avoid a clash in the barrel.
- **Staff gallery language.** `ui/admin/GalleryAdmin.tsx` (not my file) wraps itself in its own language provider that starts in English, which set the whole page to English under my Thai specimens. The gallery works around it (stores the language first, remounts that section when it changes, wraps it in an error guard). The staff agent could drop their nested provider instead.
- **Staff gallery error.** One run logged `ReferenceError: t is not defined` in their `OrdersScreen` in Thai; my error guard caught it and the page still rendered.

## Exported components (`client/src/ui/index.ts`, which ends with `export * from './admin/index.ts'`)

**Primitives**
- `Icon` { name: IconName; size?: 'xs'|'sm'|'md'|'lg'|number; title?; bold? }. Also exports `ICON_NAMES` (all 46 icons from `sprite.js`) and the `IconName` union.
- `Button` { variant?: primary|secondary|outline|ghost|quiet|danger|danger-solid; size?: md|lg|staff; block?; icon?; iconEnd?; iconBold?; count?; priceMinor?; loading?; confirmed?; confirmedLabel?; opensDialog? } plus normal button attributes.
- `LinkButton` { href; external? } plus the same look props.
- `IconButton` { label (required); icon; iconSize?; variant?: plain|framed|round; size?: md|staff|sm; badge?; badgeLabel?; opensDialog? }
- `TextLink` { href; icon?; external? }
- `SegmentedControl<T>` { options: {value, label, count?, lang?, ariaLabel?, disabled?}[]; value; onChange; label; tone?: paper|box; size?: md|staff; block? }
- `Tabs<T>` { items: {value, label, href?, count?, badge?, badgeTone?, icon?, lang?}[]; value; onChange?; label; variant?: underline|ember; bar?; idBase? }. All items having `href` switches it to routed links.
- `TabPanel` { idBase; value; active; keepMounted? }
- `Badge` { count; tone?: ink|alert|ember; ring?; label?; max? }
- `Pill` { tone?: ok|neutral|alert|heat|line|ink; icon?; iconNow?; live?; size?: md|sm }
- `StatusPill` { kind: line|order|service|table|job; status; prep?; label?; detail?; size?; live? }. Also exports `useStatusWording(subject)`.
- `Tag` { tone?: ink|line|example|ok|alert|heat|neutral; icon? }
- `Flag` { kind: oldest|late|just|ready|station|alcohol|example; children? }
- `Chip` { qty?; tone?: ink|line }
- `Price` { minor: number|null; size?: sm|md|total|xl|lg; unit?; stackUnit?; sign?; pending?; plain?; as? }
- `Leader` { label; value?; as?; definition?; labelAs?; valueAs?; labelId?; labelClassName?; valueClassName?; strong? }
- `Wordmark` { variant?: guest|staff; href?; label?; sub? }
- `TableTag` { label: string|null }
- `LangToggle` { className? }
- `Stepper` { value; onChange; min?; max?; label; variant?: tint|plain; size?: md|lg; onRemove?; disabled?; decrementLabel?; incrementLabel?; removeLabel? }
- `TextField` { label; optional?; help?; error?; density?: guest|staff; hideLabel?; prefix?; suffix? } plus input attributes.
- `TextArea` { label; value; onChange(value); limit?; measure?: codepoint|grapheme; showCount?; optional?; help?; error?; density?; hideLabel? }
- `Select` { label; options?; placeholder?; optional?; help?; error?; density?; hideLabel? }
- `Checkbox` { label; description? } plus input attributes.
- `Switch` { checked; onChange(next); label; showState?; onLabel?; offLabel?; density? }
- `RadioCard` { label; description?; aside?; type?: radio|checkbox; card? } plus input attributes.
- `RequiredPill` { met }
- `ChoiceGroup` { legend; example?; required?; satisfied?; rule?; error?; legendRef? }
- `SearchField` { value; onChange(committed); label?; size?: md|staff; onClear?; clearLabel?; status?; statusHidden?; placeholder? }

**Overlays and feedback**
- `Sheet` { open; onClose; title?; kicker?; label?; labelledBy?; describedBy?; footer?; footerAlign?: fill|end; variant?: sheet|dialog|drawer; wide?; closeLabel?; hideClose?; dismissible?; history?; initialFocus?; inline?; head?; role?; bodyClassName? }
- `Dialog` { open; onClose; title; children?; confirmLabel; cancelLabel?; onConfirm(reason?) → void|Promise; tone?: default|danger; reason?: {label, required?, placeholder?, limit?, help?, initial?}; error?; busy?; wide?; density? }
- `Drawer` { open; onClose; title?; subtitle?; lead?; status?; label?; footer?; inline?: boolean|'auto'; closeLabel? }
- `Banner` { variant: demo|offline|paused|billing|info|warning; title?; action?; icon?; staff? }
- `ToastProvider` { children }, `useToast()` → { show(opts|string), dismiss(id?) }
- `Toast` { message; tone?: ok|info|error; action? } (in-page version for previews)
- `LiveRegion` { assertive?; visible? }, `useAnnounce()` → (message, {assertive?}), `announce(message, politeness)`
- `EmptyState` { icon?; title; children?; action?; headingLevel?; compact? }
- `Skeleton` { shape?: text|block|plate|circle; width?; height?; lines? }, `SkeletonDishRow` { label? }
- `ConnectionIndicator` { variant?: staff|guest|track; state?; lastSyncAt?; stale?; offlineAction? }. It reads `useLive()`.

**Guest kit**
- `DishImage` { image; variant?: plate|wide|thumb|round; decorative?; fallback?: none|blank; onFallback?; framed?; plateClassName?; loading?; sizes? }. Also exports `dishImageUrl(name, size)` and `dishSrcSet(image)`.
- `DishRow` { item: DishRowItem (a subset of MenuItemDTO); qtyInDraft?; hasChoices?; kicker?; meta?; onOpen?; onAdd?; onChangeQty?; onRemove?; onRequestWeigh?; confirmed?; busy?; headingLevel?; priority? }
- `MenuSection` { id; numeral; title; titleLang?; secondary?; secondaryLang?; hint?; children }
- `CategoryRow` { categories: {id, numeral, label, lang?, href?}[]; currentId; onSelect(id); onOpenAll(); label?; allLabel? }
- `CategorySidebar` { categories; currentId; onSelect; label? }
- `AllCategoriesSheet` { open; onClose; groups: {key, label, lang?, categories: {id, numeral, title, titleLang?, secondary?, secondaryLang?, count}[]}[]; currentId; onSelect(id, groupKey); title?; inline? }
- Section helpers: `useActiveSection(ids, offset)` → current section id; `scrollToSection(id, offset)`.
- `Dock` { children; inline? }
- `CartBar` / `OrderSlip` { count; totalMinor; href?; onClick?; state?: idle|sending|review; actionLabel? }
- `BottomNav` { items: NavItem[]; current; label?; onNavigate?; onService?; serviceLabel? }
- `ServiceKey` { onClick; label?; variant?: dock|header }
- `GuestNav` { items; current; label?; onNavigate? }, `useGuestNavItems({draftCount, menuHref?, orderHref?, trackHref?})`
- `Timeline` { steps: {key, label, state: done|current|upcoming|skipped, at?, sub?}[]; label; animate? }
- `RoundCard` { title; meta?; reference; referenceLabel?; stateTitle; stateMessage?; footnote?; highlight?; dishes?; children? }
- `DishLines` { title; summary?; collapseAfter?; defaultOpen?; children }
- `DishStatusLine` { name; nameLang?; quantity; image?; status: LineStatus; prep?; statusLabel?; at?; trail?; skipped?; reason?; notCharged? }
- `PastRound` { title; meta?; thumbs?; extra?; children? }
- `PortionQuote` { state: requested|quoted|confirmed|expired|revised; name; secondary?; grams?; rateMinor?; basisGrams?; amountMinor?; expiresAt?; previous?; onConfirm?; onChange?; onRequestAgain?; busy? }
- `GuestHeader` { tableLabel?; homeHref?; nav?; actions?; langControl? }
- `PageHead` { kicker?; title; titleLang?; secondary?; secondaryLang?; row?; support? }
- `Card` { as?; padded? }
- `ListRow` { icon?; title; sub?; trailing?; onClick?; href?; disabled?; opensDialog?; lang? }
- `ServiceMenu` { items: (ListRowProps & {key})[]; offline?; fallback? }
- `AllergyNotice` { allergens: AllergenInfoDTO; onCallStaff?; callStaffLabel? }
- `OrderLine` { name; nameLang?; image?; quantity; totalMinor; options?; note?; issue?; actions?; size?: md|lg }
- `UnsentCard` { count; nextRound; href }
- `RunningTotal` { label; totalMinor; note?; action?; size?: total|xl }

**Helpers:** `cx`, `mergeRefs`, `useConfirmFlash`, `prefersReducedMotion`, `graphemes`, `textLength`, `clampText`, `normalizeSearch`, `clockSeconds`, `useGlideMark`, `rovingKeyDown`, `scrollIntoViewInline`, `useEscape`, `useHistoryDismiss`, `useScrollLock`, `useFocusReturn`.

`Gallery.tsx` (default export) and `GalleryGuest.tsx` provide the styleguide: TH/EN toggle, a phone-frame toggle (a real 390px iframe), and `?open=` to open a modal on load for screenshots. The staff gallery is loaded only if its file exists, behind loading and error guards.

## CSS
- **`styles/base.css`:** modern reset; page background and text from tokens; Thai-safe body type; a guard so Oswald and Noto never get a fake italic; selection colour (changed from final.css's ember background, whose bone text fails contrast at 3.58); focus ring; `.visually-hidden`; `.skip`; scroll lock; `.app-loading`; charcoal scope; reduced motion (OS setting and the staff setting); print basics.
- **`styles/components.css`:** all of final.css with class names unchanged, grouped under DESIGN §10.1–10.30 headings, then the admin layout, Thai safety rules and motion sections. The rule-driven fixes:
  - `rgba()` colours replaced with `color-mix()` over tokens.
  - The button spinner now takes the label colour; it was invisible on outline buttons.
  - Hover bands apply only on devices that can hover.
  - Sheets become centred dialogs from 720px, with separate dialog, drawer and in-page variants.
  - Mock inline styles turned into classes.
  - Thai inside staff labels gets a 1.55 line height and a 13px floor, with no letter-spacing or caps.
  - New styles for tabs, fields, select, checkbox, switch, skeleton, the toast region, the reconnecting chip, the billing/info/warning banners and order lines.
- **`ui/Gallery.css`:** styles for the dev-only gallery, loaded only with the gallery chunk.
- **`i18n/common.ts`:** new `common.*` and `conn.*` keys appended to both `th` and `en`.

## What I verified
- **Screenshots:** full-page shots at 390 and 1440 plus per-section and modal shots, saved in `var/scratch/kit/c0a/` and compared against the design-lab PNGs.
- **Page audit** (390, 320, 1440; Thai and English):
  - No horizontal overflow.
  - No Thai text with letter-spacing, and no Thai line height below 1.55.
  - No guest-kit text under 13px and no guest-kit control under 44px. Everything still flagged is in the staff kit's own components.
- **Behaviour (39/39 passed):**
  - **Sheets and dialogs:** Escape, backdrop, close button and browser Back all close them. Focus returns to the trigger, and scroll lock and the history entry are cleaned up.
  - **Reason dialog:** an empty reason shows an error; confirming shows a spinner.
  - **Keyboard:** arrow keys move and select in segmented controls, and End works in tabs.
  - **Ember mark:** glides to a newly selected category.
  - **Add:** shows busy, then "เพิ่มแล้ว ✓" for 1.2s, then a toast with undo.
  - **Stepper:** going from 1 removes the line, and undo brings it back.
  - **Search:** typed text is applied and Escape clears it. A separate check confirmed Thai IME input only filters after the composition is committed.
  - **Timeline:** a new current step animates once.
  - **Drawer:** closes on Escape.
  - **Language switch:** keeps the draft state.
- **Trial production build:** built to a scratch folder (since deleted); the gallery CSS is split into its own chunk.

