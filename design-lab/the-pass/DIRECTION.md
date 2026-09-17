# THE PASS — design direction for Rabbit Grill table ordering

> An open kitchen's pass has three things: a charcoal line above, paper tickets
> on a rail, and copper heat lamps over the food that is ready *now*.
> This direction takes those three things and nothing else. The result is
> tactile and confident, and it still reads on paper first.

Mocks in this folder (static HTML, fonts from `../../node_modules/@fontsource-variable/*`,
photos from `../../../img/`):

| File | Screen | Screenshot(s) |
| --- | --- | --- |
| `guest-menu.html` | Phone menu, Table 07, Thai active | `guest-menu.png` (full), `guest-menu-fold.png` (390×844) |
| `guest-track.html` | Phone Track, round RG-4K7P | `guest-track.png` (full), `guest-track-fold.png` |
| `item-sheet.html` | Phone item sheet over the dimmed menu | `item-sheet.png` (open state), `item-sheet-full.png` (whole sheet) |
| `admin-board.html` | Desktop 1440×900 Orders board | `admin-board.png` |

Add `?full` to a guest URL to park the fixed dock at the end of the page for full-page captures.

---

## 1. The idea in one paragraph

**Paper is the plate. Charcoal is the line. Forest is the hand that acts. Ember is the heat lamp.**
Guest pages are paper (#F3ECDD) from top to bottom. The only dark surface is a 58 px charcoal
"line" header carrying the wordmark, the table stub, language and service. Anything the guest
has *sent* becomes a **docket**, a paper ticket with a torn, serrated bottom edge. Tracking reads
like that ticket moving down the pass. Every action is forest green with bone text. Ember
(#CB6234) never marks an action, a price, a promotion or an error. It is light, and it falls
only on what is happening now.

## 2. The signature detail: the heat lamp

One rule, used everywhere: **ember appears only as lamp light over whatever is current.**
It is always additive. Text, an icon, a shape or `aria-current` already carries the state, so
removing every lamp would lose nothing a user needs.

| Where | What the lamp is |
| --- | --- |
| Active category (menu) | 2 px ember line at the top of the tab, with a soft elliptical glow falling onto the label |
| Active bottom tab | The same lamp hanging over the tab |
| Track · "Now" block | A small drawn **copper-lamp glyph** hangs from the ticket's tear line, with a soft conic beam over "ตอนนี้ / กำลังปรุง" |
| Track · current step | Ink marker with an ember ring and a warm halo. Done steps are forest checks and future steps are hollow steel rings. |
| Per-dish status | "Cooking" dot = ink core + ember ring (the same marker, smaller) |
| Admin · Ready column | The **real pass**: the lamp glyph hangs over the Ready rail, the rail itself is copper-toned and the glow spills onto the waiting tickets. Food under the lamp is food waiting to be run. |
| Admin · active nav | 2 px ember edge + glow from the left (on a vertical rail the lamp hangs from the side) |
| Insights · weekly chart | Today's bar gets the lamp line and a "Live · partial" label (§9) |

Why it is memorable: the restaurant's own photos of its pass show exactly these copper lamps
over the counter (`img/venue-pass.jpg`). It is their room, not a generic accent colour.
Why it doesn't hurt usability: it is never the only signal, it never animates on its own
(it fades in once, 220 ms, when a committed staff event makes something current), and it
never sits behind small ember text (see the contrast note on "ตอนนี้" below).

## 3. Colour roles

| Role | Token | Hex | Used for |
| --- | --- | --- | --- |
| Canvas | `--canvas` | paper #F3ECDD | Guest page and admin workspace background |
| Surface | `--surface` | bone #F8F4EA | Dockets, sheet, inputs, bottom tabs, free table tiles |
| Sunken | `--sunken` | paper-2 #E9E0CB | Segmented track, weight note, floor strip, modifier/note wells |
| Text | `--text` | ink #17150F | All primary text |
| Text 2 | `--text-2` | #5D574A (reference `--fg-soft`) | English names, meta, inactive tabs |
| Text 3 | `--text-3` | taupe #6B5E4B | Future timeline steps, caps labels, numerals in kickers |
| Section numeral | `--numeral` | #857D6F (deepened steel) | 40 px decorative "01 / 02" (aria-hidden) |
| Control outline | `--control-line` | #7A7264 (deepened steel) | Input borders, radio rings, free-tile dashes: anything that must be *seen* as a control |
| Rule | `--rule` / `--rule-2` | ink @ 14% / 26% | Hairlines, perforations |
| Line (dark) | `--line`, `--line-2`, `--line-3` | ink / ink-2 / ink-3 | Guest header, admin rail, Dining tiles, language track |
| On line | `--on-line` / `--on-line-2` | bone / #B9B2A2 | Text on charcoal |
| Action | `--action` / `--action-2` | forest #1E4230 / forest-2 #2C5A40 (hover) | Add, Send, Accept, Mark ready, selected option, order slip |
| OK | `--ok` / `--ok-tint` | forest / #E3EAE2 | Done checks, served pills, in-draft steppers, Live pill |
| Alert | `--alert` / `--alert-tint` | oxblood #6E1621 / #F4E3E0 | Allergy band (staff), allergy advisory (guest), request badges. Always with a triangle or bell icon and words. |
| Lamp | `--lamp` | ember #CB6234 | Lamp lines, rings, glyph bulb, glows. **Graphic only on paper.** |
| Lamp text | `--lamp-text` | ember #CB6234 | Text only on ink #17150F (4.64). Not used as text in these mocks. |
| Ember ink | — | #A8441E | Reserved for small accent text on *flat* paper/bone only (5.09 / 5.45). Never on lit surfaces. |
| Steel | `--steel` | #8E8B82 | Ticket rail rod, dotted future rail, hollow future markers. Never text on paper. |
| Checking out | — | forest tile + receipt glyph | Table state (see §8, table tile) |

### Measured contrast (WCAG 2.x relative luminance, computed, not eyeballed)

Text pairs, which need 4.5:1 (or 3:1 for large text only where noted):

| Foreground | Background | Ratio | Where |
| --- | --- | --- | --- |
| ink #17150F | paper #F3ECDD | **15.52** | page text |
| ink | bone #F8F4EA | **16.62** | dockets, sheet |
| ink | paper-2 #E9E0CB | **13.90** | segmented track, notes, floor strip numbers |
| ink | ok-tint #E3EAE2 | **14.89** | selected option label |
| ink | alert-tint #F4E3E0 | **14.70** | guest allergy advisory |
| ink | lamp-lit bone (worst case, ember @26% ≈ #ECCCB8) | **12.08** | "ตอนนี้ / กำลังปรุง" under the beam |
| ink | lamp-lit paper (≈ #E9C8B1) | **11.6** | active category |
| #5D574A text-2 | paper / bone / paper-2 | **6.10 / 6.53 / 5.46** | meta, English names |
| #5D574A | ok-tint | **5.85** | — |
| #5D574A | lit bone (halo edge ≈ #E7CEB9) | **4.76** | "ขั้นตอนปัจจุบัน…" sits at the halo's faint edge |
| taupe #6B5E4B | paper / bone / paper-2 | **5.36 / 5.75 / 4.80** | future steps, caps labels |
| forest #1E4230 | paper / bone / paper-2 | **9.51 / 10.19 / 8.52** | "View all", Live, served text |
| forest | ok-tint | **9.13** | served pill |
| bone #F8F4EA | forest | **10.19** | primary buttons, order slip, checkout tile |
| bone | forest-2 #2C5A40 | **7.23** | button hover |
| #D5DDD4 | forest | **8.06** | slip sub-line "ยังไม่ได้ส่งเข้าครัว", tile caption |
| bone | ink | **16.62** | header, badges, Dining tiles, required chip, modifier chips |
| bone | ink-3 #2E2921 | **13.14** | active language segment |
| bone | lamp-lit ink-3 (≈ #4F2F21) | **10.86** | active admin nav label |
| #B9B2A2 | ink / ink-2 / ink-3 | **8.65 / 7.87 / 6.84** | inactive nav, inactive language, rail captions |
| bone | oxblood #6E1621 | **10.62** | staff allergy band, Requests badge |
| #EAD3D3 | oxblood | **8.20** | "As written by the guest" |
| oxblood | alert-tint | **9.40** | — |
| ember-ink #A8441E | paper / bone | **5.09 / 5.45** | allowed on flat surfaces only |
| ember-ink | lamp-lit bone | **3.82–3.96 ✗** | **rejected**: the "ตอนนี้" label was ember-ink in draft 1 and was moved to ink |
| ember #CB6234 | ink / ink-2 | **4.64 / 4.22** | ember text only on ink; on ink-2, large text only |
| #857D6F numeral | paper | **3.46** | 40 px decorative numerals (large, aria-hidden) |

Non-text pairs, which need 3:1 for UI components and state graphics:

| Graphic | Background | Ratio |
| --- | --- | --- |
| control-line #7A7264 | bone / paper / paper-2 | **4.33 / 4.04 / 3.62** |
| ember lamp line/ring | paper / bone | **3.35 / 3.58** |
| ember icon (active nav) | ink-3 | **3.67** |
| steel future marker | bone | **3.10** |
| steel rod | paper | 2.90, decorative only (the column title carries the meaning) |
| forest done marker | bone | **10.19** |

## 4. Typography

Three families, three jobs, loaded from local fontsource files:

- **Noto Sans Thai Variable**: everything you read or tap, in Thai *and* Latin UI.
- **Oswald Variable**: numbers and short Latin labels (prices, refs, times, table numbers, column heads).
- **Cormorant Garamond Variable (italic 600)**: the English dish name and the wordmark. It is the marginalia voice of the printed menu.

Every stack that might meet Thai ends in `"Noto Sans Thai Variable"` before the generic fallback.
`:lang(th) { letter-spacing: 0 }` is global, and caps/tracking styles switch themselves off under `:lang(th)`.

### Thai (guest)

| Style | Size / line-height / weight | Tracking |
| --- | --- | --- |
| Now status ("กำลังปรุง") | 28 / 1.4 / 700 | 0 |
| Page title | 26 / 1.35 / 700 | 0 |
| Section title ("เนื้อ") | 25 / 1.35 / 700 | 0 |
| Sheet title | 25 / 1.45 / 700 | 0 |
| Dish name | 17 / 1.5 / 600 (wraps, never truncates; 45-character names tested at 390 px) | 0 |
| Timeline step | 16 / 1.6 / 600 (current 17 / 700, future 500 in taupe) | 0 |
| Body, notes, options | 15–16 / 1.6 / 400–600 | 0 |
| Meta, helper, advisory | 14 / 1.55–1.6 / 400–600 | 0 |
| Tab label | 14 / 1.5 / 500 (active 700) | 0 |
| Chrome labels (header buttons, stub) | 13–13.5 / 1.2 / 600: the only sub-14 Thai, and never information-bearing prose | 0 |

### Thai (staff tickets, dense)

| Style | Size / lh / wt |
| --- | --- |
| Dish name on ticket | 15 / 1.45 / 600 (stacked tone marks checked for clipping) |
| Allergy note (guest's words) | 16 / 1.4 / 700, bone on oxblood |
| Note | 14 / 1.45 / 400 |

### Latin

| Style | Face | Size / lh / wt | Tracking |
| --- | --- | --- | --- |
| Wordmark | Cormorant caps | 13 (guest) · 17 (admin) / 1.02 / 600 | +0.20em |
| English dish name | Cormorant italic | 18 / 1.25 / 600 (sheet 21 / 1.2) | +0.005em |
| Price | Oswald | 20 / 1 / 500 (sheet 26, slip 19) | +0.01em |
| Order ref (RG-4K7P) | Oswald | 24 / 1.1 / 500 (ticket 12.5) | +0.06em |
| Times | Oswald | 17–22 / 1.15–1.6 / 500, tabular | +0.02em |
| Table number | Oswald | 30 (ticket) · 18 (tile) · 19 (stub) / 0.95–1 / 500–600 | +0.01–0.02em |
| Column heading | Oswald caps | 15 / 1 / 600 | +0.14em |
| Caps label | Oswald caps | 12 / 1.3 / 500 | +0.16em |
| Admin page title | Oswald caps | 26 / 1 / 600 | +0.04em |
| Admin UI text | Noto (Latin) | 15 / 1.45; secondary 12.5–13.5 | 0 |

All numerals are `font-variant-numeric: tabular-nums`. Oswald is never used for a Thai string,
and giant condensed caps are never used for dish names.

## 5. Space, shape, rules, elevation

- **Spacing:** 4 px base: 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48. Phone gutter 16, desktop gutter 20. Dish rows 16 vertical, dockets 16 inset.
- **Touch:** every interactive element ≥ 44 × 44 (header segments are 34 px visible with a pseudo-element hit area to 44). Primary sheet action is 52.
- **Radii:** ticket 3 · photo/chip 6 · button/input 8 · order slip 12 · sheet 18 (top only). Pills (fully rounded) are only for status pills and badges.
- **Rules:** hairline ink @14%; strong ink @26%; section head 1 px solid ink (the printed-menu rule); perforation 1.5 px dashed ink @26% with two punched side notches; control outline #7A7264.
- **Docket edge:** a 5–6 px serrated tear on the bottom edge (CSS conic-gradient mask, 12 px pitch), with a drop-shadow on the wrapper so the teeth cast a shadow.
- **Elevation:** e1 hairline lift (rows) · docket = `drop-shadow(0 1 1 / 10%) + drop-shadow(0 6 10 / 7%)` · order slip `0 10 24 -10 / 55%` · sheet e3 `0 -10 40 -8 / 35%` + 58% ink scrim. Nothing else floats.

## 6. Iconography

Inline SVG sprite (`<symbol>`), 24-unit grid, **1.6 px stroke** (2.2 inside small filled markers),
round caps and joins, `currentColor`. Default 20 px, with 16 px and 24 px sizes. Icons always sit beside
a word, except the ⋯ "Details and exceptions" button, which carries an aria-label and is never the
only route to a normal action. Set: search, list, service bell, plus, minus, check, clock, scale,
slash (sold out), info, chevrons, close, alert triangle, open book (Menu), docket (Your order),
timeline (Track), receipt (bill), hand (ask staff), orders rail, tables grid, cutlery (Menu admin),
bars (Insights), dots (More), pause, note, wine glass, arrow.
The **lamp glyph** is a separate filled drawing (ink shade + ember bulb line). It is the only
illustrative mark in the system and appears only at a "now" location.

## 7. Motion tokens (brief 42)

| Token | Value | Use |
| --- | --- | --- |
| `--t-press` | 120 ms, `cubic-bezier(.2,.7,.3,1)` | Button press scale 0.97 |
| `--t-ctl` | 180 ms, same | Segmented/category indicator (160–200), language cross-fade, stepper count |
| `--t-sheet` | 220 ms, `cubic-bezier(.16,.84,.28,1)` | Sheet rise 24 px + scrim fade (180–240) |
| `--t-step` | 220 ms | Current-step emphasis: lamp fades in once and the marker ring scales 0.8→1, **only on a committed staff event**. Reconnects set state without replaying. |
| new staff ticket | 200 ms | Forest inset ring fades in, then stays static. No pulse, no scroll jump. |
| table tile | 180 ms | Background/label cross-fade. The state is authoritative before the animation starts. |
| chart period | 220 ms | Bar height transform from the zero baseline. No rolling counters. |
| initial render | 160 ms | Opacity + ≤4 px rise on first visible content only |

`prefers-reduced-motion: reduce` makes every duration ~0. Lamps then appear instantly and the sheet
appears without travel. Lamp glows never loop, flicker or breathe. There are no flames, smoke or grain.

## 8. Component vocabulary

- **Line header (guest):** 58 px ink. Stacked serif wordmark · hairline · **table stub** (bone ticket with punched side notches, "โต๊ะ 07") · language segmented control (ไทย / EN, pressed = bone) · **บริการ** service button (bell + word) that opens the Bill / Call staff sheet. Sticky, with safe-area padding.
- **Buttons:** Primary = forest / bone, 44 (52 in the sheet's sticky footer), radius 8, 15 px 600. Outline = bone with ink @26% border (text-labelled, so the border is decorative). Quiet = text + chevron. Press scale 0.97, hover forest-2. No glowing buttons.
- **Add control:** primary "+ เพิ่ม". Once in the draft it becomes a **stepper** (ok-tint fill, forest glyphs, Oswald count). A by-weight item never shows Add. It shows the weight note (scale icon) and an outline **"ขอให้พนักงานยืนยันปริมาณ"** button that starts the brief 44A quote flow.
- **Sold out:** grayscale photo at 55%, struck price with a screen-reader "ราคาเดิม" prefix, and a bordered "⊘ หมดแล้ว" label in place of any button.
- **Text-led card:** no image box and no broken-image icon. A 2 px rule on the left keeps the row rhythm.
- **Segmented control (Food / Drinks):** paper-2 track, ink pressed segment with bone text, `aria-pressed`.
- **Category row:** a fixed **ทุกหมวด** button (opens the All categories sheet) + a horizontally scrollable row that fades at the right edge. The active tab gets the lamp. The row is sticky under the header.
- **Chips / pills:** status pills are 30 px fully rounded (served = ok-tint/forest with a check; cooking = paper-2/ink with the lamp dot). Required chip = ink/bone "จำเป็น · เลือก 1". The **example** tag is dashed control-line and marks placeholder configuration.
- **Order slip (cart bar):** floating forest bar, 62 px, radius 12. "2 รายการ · ฿1,180" + "ยังไม่ได้ส่งเข้าครัว" (not sent yet) | perforation with punched notches | "ดูรายการ ›". It sits above the tabs and never covers them.
- **Bottom tabs:** bone bar with an ink @26% top rule, three equal tabs (เมนู · รายการของฉัน · ติดตาม), 24 px icons + 14 px labels. The **badge** (ink / bone Oswald, bone keyline) sits on Your order. The active tab gets the lamp and a 700 label.
- **Sheet:** full-bleed photo (214 px, 4:3-safe crop), bone grabber, 44 px bone close button, content scroller, sticky footer (stepper + "เพิ่ม · ฿590"). Uses `role=dialog` + `aria-modal`, and the page underneath is `inert`. Option rows are 52 px with a radio ring in control-line. Selected = ok-tint fill + forest ring + inset forest border. Every option shows its price effect ("รวมในราคา" / "+฿x").
- **Note field:** paper textarea with a control-line border, a 120 limit, a live counter ("14 / 120") and the helper "เป็นคำขอ พนักงานจะยืนยันอีกครั้ง".
- **Allergy advisory (guest):** alert-tint well, 3 px oxblood edge, triangle, bold question line, honest sentence ("ร้านยังไม่ได้ยืนยันข้อมูลสารก่อภูมิแพ้…"), outline **เรียกพนักงาน**.
- **Docket (ticket):** bone, radius 3 on top, serrated bottom. Guest version: round label, Oswald ref, "ส่งเมื่อ" time, meta line (table · dish count · last update), then a tear line with punched notches, then the Now block, timeline and dish list. The collapsed version is a stub with the served pill + "ดูรายการ ⌄".
- **Timeline step:** 28 px marker column + label + time column. Done = forest disc + bone check + actual time. Current = ink disc + ember ring + halo, "เริ่ม 19:45", and `aria-current="step"`. Future = hollow steel ring, taupe label, **no time**. The rail is solid forest between done steps and dotted steel after the current step. An unrecorded optional step shows the text "ไม่ได้บันทึก" instead of a time.
- **Per-dish list:** 52 px thumbnail, name ×qty, and a status line with its own time ("✓ เสิร์ฟแล้ว 19:50" / "● กำลังปรุง"). The summary pills above it read "เสิร์ฟแล้ว 1 · กำลังปรุง 2".
- **Staff ticket:** table number (Oswald 30) + NEW tag, ref · round, a clock with elapsed minutes, and "sent / ready hh:mm". The **allergy band** runs full-bleed in oxblood with bone text, the ALLERGY caps label, the guest's words untranslated at 16/700 and "As written by the guest". Lines show Oswald qty + Thai name + English; modifiers are ink chips (verified variants only: 500 ml, Iced); notes sit in a paper-2 well with a note icon. The **dish progress meter** has one segment per dish (forest = served, ink + ember underline = cooking) plus words. Weight lines read "⚖ 420 g · confirmed 19:40". The alcohol flag reads "Alcohol · staff to confirm". Actions: one primary next step with the exact count ("Mark 2 ready") + outline "Almost done" (optional milestone) or ⋯ for exceptions. New tickets get an inset forest ring.
- **Board column:** Oswald caps heading + count badge + hint, a **steel rod** (the ticket rail), and a stack that scrolls on its own. The Ready column gets the copper rod, the lamp glyph and the glow.
- **Admin rail:** 196 px ink with the serif wordmark and five destinations (Orders · Tables · Menu · Insights · More). Items are 48 px. The active one gets ink-3 + the lamp edge. Badges are bone on ink. Language control and local-time zone sit at the foot.
- **Workspace header:** Oswald page title · underline subtabs (Board / Requests with an oxblood count) · "● Live · synced 19:56:08" · "✓ Ordering open [Pause]" · staff avatar + name + role/sign-in time.
- **Table tile (strip):** 54 px. **Available** = bone with a dashed control-line border and "Free". **Dining** = ink with the seated time. **Checking out** = forest with receipt + "Bill". **Disabled** (Tables page) = paper-2 with a lock + "Disabled". Attention badges sit at the corner: oxblood bell = service request, forest docket = unacknowledged order, lamp dot = food at the pass. The strip's legend repeats each state as glyph + count + word (Available 9 · Dining 5 · Checking out 1), and every tile has a full aria-label. The full Tables page uses 150 px tiles that spell the state out and add rounds, unresolved items and the primary action.
- **Stat card (Insights):** ink-2 card, 14 px label, Oswald 40 value, comparison as an arrow glyph + signed number + words ("▲ 12 vs last week", "No prior baseline"), and a "?" definition popover. Never colour-only.
- **Bar chart:** see §9.

## 9. Dark analytics surface (Insights only)

Insights is the one place staff get a full charcoal surface, because it is read at a glance and
the kitchen photos behind it are dark.

- Page `ink`, cards `ink-2`, dividers `line-rule`. Text bone (16.62 / 15.11), secondary #B9B2A2 (8.65 / 7.87).
- **Weekly bars (Mon–Sun, Asia/Bangkok):** completed days = bone bars on a y-axis that starts at 0, with integer ticks in #B9B2A2 and gridlines at bone @14%.
  **Today** = bone bar + a 2 px **ember lamp line on its top edge** + the label "Live · partial" in bone with an ember dot. Ember is used as text only on `ink` (4.64), never on `ink-2`.
  **Future days** = dotted steel outline (5.36 on ink) + "—" + "Upcoming". **Real zero** = 2 px baseline tick + "0". **Missing data** = dashed outline + "No data". It never looks like zero.
- The selected bar gets a bone 2 px outline + a value flag. The day drill-down loads beneath without leaving the page. A table equivalent sits behind a "Table" toggle.
- Comparison is shown with words and signed numbers. Growth from zero shows "No prior baseline".

## 10. Layout contracts

- **Phone guest (390):** sticky line header (58) + sticky category row (48). Search and group control scroll away above it. The fixed dock is the order slip (62, only when the draft has items) + tabs (62 + safe area). `main` pads 168 px at the bottom so the last dish clears the dock. Rows are one column: a 112×84 photo (4:3) + a 232 px text column.
- **Desktop staff (1440×900):** rail 196 · workspace header 62 · floor strip 74 · five equal columns (≈231 px) with independently scrolling stacks. Nothing depends on drag, and every transition is a button on the card.

## 11. Honesty notes

- No descriptions, allergens, doneness, portion sizes, hours, ratings or promotions are invented. Dish names, English names, prices and the "300 g" wagyu unit come from `data/menu.json`.
- `item-sheet.html` contains **one DESIGN PLACEHOLDER** (marked in an HTML comment and with a visible "ตัวอย่าง" tag): a required choice group titled ระดับความสุก with three options. It only illustrates the component. Rabbit Grill has not confirmed any doneness options.
- The text-led card (สตูว์ลิ้นวัว) demonstrates the missing/failed-photo state; that dish does have a real photo in `img/`.
- Order refs, times, table occupancy, the staff identity "Kitchen 1", the guest note "ขอจานแบ่ง 2 ใบ" and the allergy note "แพ้ถั่วลิสง" are **mock operational data**, not restaurant facts.
- Drinks without a Thai name on file (Orange Juice, Matcha Latte, Hoegaarden) show the English original, as brief 08 requires. The staff ticket says "No Thai name on file" so the catalog gap is visible.
- Prime Rib appears only as a staff-confirmed quote (420 g, confirmed by the guest) and never as a fixed price.
