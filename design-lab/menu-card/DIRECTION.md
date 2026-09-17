# THE MENU CARD — design direction

The restaurant's printed menu is the model for the whole app. Guests read a cream card with hairline rules and dish names set in type. Staff read the same card as a kitchen docket. The type carries the design. Photographs are set on the page like plates, with a thin bone mat and a hairline frame. Colour is kept for meaning: forest for actions and things that are done, oxblood for sold-out items, allergies and badges, and ember only to mark "now". The pages don't use flames, smoke, grain, mascots, full-screen intros or long reveals.

User brief: *"Make it elegant."* In this direction, elegance comes from restraint and good typesetting. It does not come from effects.

Mocks (static HTML; fonts come from `../../node_modules/@fontsource-variable/*`):

| File | Viewport | Screenshot(s) |
| --- | --- | --- |
| `guest-menu.html` | 390 × 844 | `guest-menu.png` (full page), `guest-menu-fold.png` (first screen) |
| `guest-track.html` | 390 × 844 | `guest-track.png` (full page) |
| `item-sheet.html` | 390 × 844 | `item-sheet.png` (sheet top), `item-sheet-end.png` (sheet body scrolled) |
| `admin-board.html` | 1440 × 900 | `admin-board.png` |

QA hooks: `#full` moves the fixed dock below the content so a full-page capture doesn't place it mid-page. `#end` scrolls the item sheet to its bottom.

---

## 1. The signature detail: the leader line

On a printed menu, a dotted **leader** joins each dish name to its price. This design uses that one device everywhere a label points to a value:

| Where | Label ··· value |
| --- | --- |
| Menu row | ไพร์มริบ ··· ฿490 / 100 กรัม |
| Choice option | มีเดียม ··· รวมในราคา |
| Add button | เพิ่ม ··· ฿590 (bone dots on forest) |
| Track timeline | รับออเดอร์แล้ว ··· 19:42 |
| Per-dish progress | × 1 ··· กำลังปรุง / เสิร์ฟแล้ว 19:49 |
| Running bill | ค่าอาหารที่ส่งแล้ว · 2 รอบ ··· ฿3,610 |
| Staff ticket | Sent 19:46 ··· Oldest waiting |

**The rule: a leader appears only when it has a value to lead to.** Future tracking steps have no time, so they get no leader. The dots don't pretend a value exists. The same idea runs vertically on the timeline: finished segments are a solid forest line and steps not yet reached are a dotted steel line. Each step also has a text label and a marker of its own shape, so the dots are never the only signal.

Why it doesn't hurt usability:
- The leader is `aria-hidden` and purely decorative. Screen readers get the name and value.
- It guides the eye from a long Thai name to its price on the same line, which is its job in print too.
- It follows the last line of a wrapped name (`align-items: last baseline`) and has an 18 px minimum. The name wraps before the leader disappears. This was checked with the longest Thai names in the catalogue (ปลาหมึกชุบเกลือขนมปังทอดเสิร์ฟพร้อมซอสทาร์ทาร์, สลัดบุรัตต้ากับมะเขือเทศอบและกัวคาโมเล) at 390 px.
- Implementation: a flex item with a `radial-gradient` dot (0.75 px radius, 5 px pitch) in `--leader` (steel). It needs no font or glyph support.

```css
.lead{display:flex;align-items:last baseline;gap:6px}
.lead .dots{flex:1 1 18px;min-width:18px;height:2px;
  background:radial-gradient(circle at 1px 1px,var(--leader) .75px,transparent 1.05px) 0 0/5px 2px repeat-x}
```

---

## 2. Colour roles

Brand hexes come from `rabbit-grill/css/base.css`. Roles are mapped onto them.

| Role token | Value | Use |
| --- | --- | --- |
| `--canvas` | paper `#F3ECDD` | Guest page, admin workspace |
| `--surface` | bone `#F8F4EA` | Plate mats, cards, sheet, tickets, bottom nav, inputs |
| `--well` | paper-2 `#E9E0CB` | Board columns, allergen info panel |
| `--text` | ink `#17150F` | Primary text, pressed segments, active indicators, masthead rule |
| `--text-2` | `#5D574A` | Secondary text, inactive tabs, meta |
| `--label` | taupe `#6B5E4B` | English italic names, section numerals, kickers, radio rings |
| `--action` | forest `#1E4230` | Add, Accept, Mark ready, cart bar, steppers |
| `--action-2` | forest-2 `#2C5A40` | Hover / pressed on action |
| `--done` | forest `#1E4230` | Completed timeline steps, "Served", Live dot |
| `--now` | ember `#CB6234` | The current-step dot, the active rail bar. Graphics only on paper |
| `--alert` | oxblood `#6E1621` | Sold out, allergy block, count badges, Checking-out tile |
| `--alert-tint` | `#EEE4DC` (oxblood 7 % on bone) | Allergy block fill |
| `--heat-text` / `--heat-tint` | ember-ink `#A8441E` / `#F3E2D4` | "Oldest waiting" flag only |
| `--done-tint` | `#E7E6DB` (forest 8 % on bone) | "Ready 2 min" flag |
| `--rule` / `--rule-soft` | ink 14 % / 8 % | Decorative hairlines between rows. Never a control's only boundary |
| `--rule-ink` | ink | Masthead double rule, table tag, segmented control, docket table box |
| `--edge` | `#857D6E` | Boundary of any control with a light fill (search, language toggle, filters) |
| `--leader` | steel `#8E8B82` | Leader dots, upcoming-step markers. Never used for text |
| `--focus` | ember `#CB6234` | 2 px focus ring, 2 px offset |
| `--scrim` | ink 56 % | Behind the sheet |
| Rail (admin) | ink / ink-3 / `#B9B2A2` / `#8F8878` | Charcoal navigation rail |

### Measured contrast (WCAG 2.x, computed from the hexes)

Text pairs (AA needs 4.5, or 3.0 for large text):

| Foreground | Background | Ratio | Where |
| --- | --- | --- | --- |
| ink | paper | **15.52** | Body, dish names |
| ink | bone | **16.62** | Sheet, tickets, nav |
| ink | paper-2 | **13.90** | Board columns |
| ink | alert-tint | **14.57** | Allergy note text |
| ink | heat-tint | **14.46** | — |
| ink | done-tint | **14.55** | — |
| text-2 `#5D574A` | paper | **6.10** | Secondary text, guest note |
| text-2 | bone | **6.53** | Nav labels, meta |
| text-2 | paper-2 | **5.46** | Column hints, allergen copy |
| text-2 | alert-tint | **5.73** | "Guest's words, unedited" |
| text-2 | weigh-note bg `#E6E2D3` | **5.53** | By-weight explanation |
| taupe | paper | **5.36** | Section numerals, English italic |
| taupe | bone | **5.75** | Sheet kicker, English on sheet |
| taupe | paper-2 | **4.80** | (allowed, not currently used) |
| forest | paper | **9.51** | "ในรายการ", Open Tables link |
| forest | bone | **10.19** | Outline buttons, stepper, "Served" |
| forest | paper-2 | **8.52** | — |
| forest | done-tint | **8.92** | "Ready 2 min" flag |
| bone | forest | **10.19** | Add / Accept / cart bar / dining tile number |
| bone | forest-2 | **7.23** | Hover state |
| `#CFD6CC` | forest | **7.53** | Dining tile duration |
| oxblood | paper | **9.92** | "หมดชั่วคราว" |
| oxblood | bone | **10.62** | — |
| oxblood | alert-tint | **9.32** | ALLERGY label |
| oxblood | stripe `#EADED6` | **8.84** | "Checkout" tile (worst case over hatching) |
| bone | oxblood | **10.62** | Count badges |
| ember-ink | paper | **5.09** | — |
| ember-ink | bone | **5.45** | — |
| ember-ink | heat-tint | **4.74** | "Oldest waiting" |
| bone | ink | **16.62** | Pressed segments, "ตอนนี้" tag, "Just in" |
| bone | ink-3 | **13.14** | Active rail item |
| `#B9B2A2` | ink | **8.65** | Rail labels |
| `#B9B2A2` | ink-3 | **6.84** | — |
| `#8F8878` | ink | **5.18** | Rail footnote |
| ember | ink | **4.64** | "KHAO YAI · STAFF", ember badges (ink text on ember is also 4.64) |
| ember | ink-2 | **4.22** | **Fails for small text.** Large text or graphics only |
| steel | paper / bone | **2.90 / 3.10** | **Never text.** Leader dots only |

Non-text pairs (WCAG 1.4.11 needs 3.0):

| Graphic | Background | Ratio |
| --- | --- | --- |
| `--edge` control boundary | paper / bone / paper-2 | 3.46 / 3.71 / 3.10 |
| ink segmented / table tag border | paper | 15.52 |
| ember current-step dot | bone | 3.58 (inside a 15.5:1 ink ring) |
| ember focus ring | paper | 3.35 |
| steel upcoming marker | bone | 3.10 |
| taupe dashed "Available" tile | paper | 5.36 |
| forest done marker | bone | 10.19 |
| `--rule` hairlines | paper | 1.33 (decorative dividers only, never a control edge) |
| disabled stepper "−" | bone | 1.91 (disabled, exempt) |

---

## 3. Typography

Three families, each with one job:
- **Cormorant Garamond** is the identity voice: the wordmark, English dish names in italic, the admin page title.
- **Oswald** is the printed-label voice: section numerals, Latin caps labels, prices, table numbers, times, references.
- **Noto Sans Thai** sets everything people read or tap, in both Thai and Latin UI text.

Every stack that could render Thai puts `"Noto Sans Thai Variable"` before the generic fallback:

```css
--f-serif:"Cormorant Garamond Variable","Noto Sans Thai Variable",Georgia,serif;
--f-label:"Oswald Variable","Noto Sans Thai Variable","Arial Narrow",sans-serif;
--f-ui:"Noto Sans Thai Variable","Helvetica Neue",Arial,sans-serif;
```

**Tracking rule.** Letter-spacing is applied only to elements marked `lang="en"` (`.cap:lang(en)`). Thai never gets tracking or `text-transform`.

### Latin

| Style | Family | Size / line-height | Weight | Tracking |
| --- | --- | --- | --- | --- |
| Wordmark | Cormorant | 18 / 1 (rail 17.5) | 600 | .16em, caps |
| Wordmark sub "KHAO YAI" | Oswald | 10 / 1 | 500 | .36em, caps (logo lockup) |
| Admin page title | Cormorant *italic* | 32 / 1 | 600 | .005em |
| English dish (sheet) | Cormorant *italic* | 22 / 1.2 | 500 | 0 |
| English section / page | Cormorant *italic* | 19–20 / 1.2 | 500 | 0 |
| English dish (row) | Cormorant *italic* | 16.5 / 1.25 | 500 | 0 |
| Label caps | Oswald | 12 / 1.2 (column heads 13.5) | 500 | .14–.18em |
| Micro caps (inside framed units: TABLE, MIN) | Oswald | 10–10.5 / 1 | 500 | .18–.2em; always redundant with the numeral beside it |
| Price, row | Oswald | 18 / 1 | 500 | .01em, tabular |
| Price, sheet / Add / cart | Oswald | 24 / 21 / 19 | 500 | .01em |
| Table number / wait minutes | Oswald | 21–24 / 1 | 500 | .02em |
| Times, references | Oswald | 13–16 | 500 | .03–.1em |
| Admin body | Noto Sans | 14 / 1.5 | 400 | 0 |
| Admin English sub-name | Noto Sans | 12.5–13 / 1.4 | 400 | 0 |

`฿` falls back to Noto Sans Thai at 0.8 em, since Oswald has no U+0E3F.

### Thai

| Style | Size / line-height | Weight | Tracking |
| --- | --- | --- | --- |
| Page title (Track) | 26 / 1.4 (single line) | 600 | 0 |
| Sheet dish title | 25 / 1.5 | 600 | 0 |
| Section title | 23 / 1.45 (single line) | 600 | 0 |
| Status headline | 22 / 1.4 | 600 | 0 |
| Dish name, menu row | 17 / 1.6 | 600 | 0 |
| Block heading (sheet) | 17 / 1.5 | 600 | 0 |
| Body / controls | 15–15.5 / 1.6 | 400–600 | 0 |
| Secondary | 13.5–14 / 1.6 | 400 | 0 |
| Meta (minimum) | 13 / 1.55 | 400 | 0 |
| Bottom-nav label | 13 / 1.3 (never wraps) | 400 / 600 active | 0 |
| Admin Thai dish | 14.5 / 1.55 | 600 | 0 |

Any Thai text that can wrap gets line-height ≥ 1.55. Line-heights of 1.4–1.45 are only for single-line headings.

---

## 4. Space, radii, rules, elevation

- **Spacing:** 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 56. The guest side gutter is 16. A row has 16 px vertical padding. Photo-to-text gap is 14. Blocks inside the sheet are 22 apart.
- **Touch targets:** at least 44 × 44 everywhere, including staff toolbar controls. Primary actions are 48–54 tall. Radio rows are 52.
- **Radii:** `--r-hair` 2 px (plates, table tag, language toggle) · 3 px (tags, flags) · `--r-ctl` 6 px (buttons, inputs, tickets) · `--r-card` 8 px (round cards, board columns) · `--r-sheet` 16 px (sheet top). Only status pills and the live dot are fully round.
- **Rules:**
  - The **masthead double rule** is a 1 px ink line, a 3 px gap, then a 1 px ink-28 % line. It is the printed menu's head rule, drawn with two box-shadows.
  - Hairlines separate rows. A 1 px ink rule separates the sheet price line. Dashed rules separate a ticket's header from its lines and divide the per-dish list.
  - The leader dots are the only dotted rule.
- **Elevation:** the design is flat and uses rules, not shadows. Three exceptions:
  - The sheet: `0 -10px 30px ink/22%`.
  - The floating cart bar: `0 6px 18px ink/18%`.
  - The ticket lift: `0 1px 0 ink/5%`.
  - A newly arrived ticket gets a 2 px ink outline, not a glow.

## 5. Iconography

- Icons are inline SVG on a 24 grid, with `stroke-width: 1.5` and round caps and joins. `currentColor` only, never filled, except status markers.
- Display sizes: 20 by default, 23 in the bottom nav, 13–17 inside chips and tickets.
- Every essential icon has a visible text label next to it. Icon-only buttons (close, stepper ±) carry `aria-label`.
- The vocabulary is drawn for this app:

| Icon | Means |
| --- | --- |
| Open book | Menu |
| Order pad | Your order |
| Dot-and-line timeline | Track |
| Bell in a ring | Service / call staff |
| Torn receipt | Bill / Orders rail |
| Balance scale | By-weight portion |
| Pan with steam ticks | Cooking. Deliberately not a flame |
| Check | Done / served |
| Half-filled disc | Almost done |
| Cloche | Ready |
| Slashed circle | Sold out |
| Triangle | Allergy |
| Clock | Wait time |

## 6. Motion (from brief §42)

| Token | Value | Use |
| --- | --- | --- |
| `--t-fast` | 160 ms | Button colour, chevron, category underline |
| `--t-base` | 200 ms | Initial menu fade, at most 4 px rise, first screen only |
| `--t-step` / `--t-sheet` | 220 ms | Tracking step emphasis (once, on a committed event); sheet rise 16 px + fade |
| Table tile change | 180 ms | Background/badge crossfade. State is authoritative immediately |
| Chart period | 220 ms | Bar height transform from the zero baseline. No rolling counters |
| `--ease` | `cubic-bezier(.2,.7,.3,1)` | Everything that enters |
| `--ease-io` | `cubic-bezier(.4,0,.2,1)` | Things that move while visible (indicator slide) |

- **Add to order:** the button label briefly changes to "เพิ่มแล้ว ✓" for 1.2 s, and the nav badge increments. Nothing flies across the screen.
- **New staff order:** a 2 px ink outline that lasts until acknowledged or 30 s have passed. No pulsing.
- **Reduced motion:** every transition and animation drops to 1 ms. The sheet appears in place, and state changes are immediate. Nothing is ever gated on an animation or on an IntersectionObserver.

---

## 7. Component vocabulary

- **Masthead (guest).** A three-column grid with the table tag left, the wordmark centred and the ไทย/EN toggle right. The double rule sits under it, it is sticky, and it is 60 px tall. The table tag is framed like a table-tent card ("โต๊ะ **07**").
- **Buttons.**
  - *Solid*: forest fill with bone text, 44–54 px. Used for the one next action.
  - *Line*: 1 px forest or ink border on bone. Used for secondary actions and for by-weight "ขอยืนยันน้ำหนัก".
  - *Quiet*: an underlined text button for deliberate or destructive entries ("Reject…").
  - There is never more than one solid button per card.
- **Stepper.** Replaces Add once a dish is in the draft: forest outline, 44 px halves, Oswald count, and a "✓ ในรายการ" note beside it.
- **Segmented control.** Food / Drinks, and ไทย / EN. The container has an ink outline, and the pressed segment is filled ink with bone text and weight 600. Pressed state is carried by fill **and** weight, and exposed with `aria-pressed`.
- **Category row.** Plain text tabs with a small Oswald numeral (01, 02 …). The active tab gets ink text, weight 600 and a 2 px ink underline. The row fades at the right edge. A fixed **ทุกหมวด** button, divided off by a rule, opens the full category sheet.
- **Chips (admin filters).** A joined group with `--edge` borders. The pressed chip is filled ink.
- **Bottom nav.** Three destinations (เมนู · รายการของฉัน · ติดตาม), then a rule, then **บริการ**.
  - บริการ is a sheet trigger, not a destination. Its bell sits in a ring and it never shows an active state.
  - The active destination gets ink text, weight 600 and a 3 px ink bar on the top edge.
  - Nav labels never wrap.
- **Cart bar.** A 54 px forest bar with inset margins, floating 8 px above the nav. "**2 รายการ** · ฿1,180" sits on the left and a bone "ดูรายการ ›" key on the right. The whole bar is the link. It only appears when the draft has items.
- **Menu row.** Plate (116 × 87 at 4:3, 3 px bone mat, hairline frame) + name ··· price + English italic + action at the bottom right. The row has these variants:
  - *In draft*: the stepper replaces Add.
  - *Sold out*: the plate is greyscale at 62 %, name and price turn text-2, and the action slot says "⊘ หมดชั่วคราว" in oxblood. There is no button.
  - *By weight*: the value reads "฿490 / 100 กรัม". A forest-ruled explanation follows ("staff will tell you the weight and price to confirm first"), then a line button **ขอยืนยันน้ำหนัก**. No preset portions are shown.
  - *Text-led*: no plate. The row becomes a full-width printed-menu line. It is also the fallback when an image fails, so no broken-image icon ever shows.
- **Sheet.**
  - The top is a grabber and a header row with the category kicker on the left and a 44 px close button on the right.
  - The body scrolls with `overscroll-behavior: contain`. It holds the framed 16:9 photo, the Thai title, the English italic name, and a ruled price leader.
  - Choice groups are a `fieldset`. The legend and a "ต้องเลือก" outline tag sit on one line, followed by the rule text ("เลือก 1 อย่าง"). Options are 52 px radio rows, each with a leader to "รวมในราคา" or a price delta.
  - Quantity is ruled above and below. The note field has a counter (`11 / 140`) and the line "requests are confirmed by staff, not guaranteed".
  - The allergen panel has a well background, an ⓘ ring, the unverified-data sentence and a **เรียกพนักงาน** button.
  - The footer is sticky with **＋ เพิ่ม ··· ฿590**.
- **Ticket (staff docket).**
  - *Header*: a framed table box (TABLE / **07**), then Round + reference, then a divider rule and the wait time as a big numeral over MIN.
  - *Sub-line*: sent time, then a leader, then a flag: *Oldest waiting* (ember-ink on heat-tint), *Just in* (ink), or *Ready n min* (forest on done-tint).
  - *Lines*: Oswald quantity with the Thai name (primary) and the English name under it.
    - Modifiers sit under a 2 px ink left rule as "**Doneness** Medium rare" (placeholder, see §9).
    - A by-weight line shows the scale icon with "420 g · ฿2,058 · guest confirmed 19:49".
    - Each line can show its own status (◒ Preparing, ✓ Served 19:49 · Ploy).
    - Station tag reads BAR.
  - *Allergy block*: a full-width oxblood frame with a 4 px left edge, the ⚠ ALLERGY label, and the guest's words quoted exactly with "unedited · confirm with the table". It sits **above** the lines, so no one has to open the ticket to see it.
  - *Guest note (non-allergy)*: a taupe left rule on paper.
  - *Actions*: one solid next action showing the count it will affect ("Mark ready · 2"). A secondary action (Almost done) goes on a stacked line button. Reject is a quiet button. No drag-only controls.
- **Board column.** A well-coloured column with a header: a status glyph in a ring (the glyphs match the guest timeline), Oswald caps name, count, and an optional hint. The New column gets a 2 px ink underline and a filled glyph.
- **Timeline step (guest).** A 24 px marker column and a leader row.
  - *done*: a forest disc with a bone check, a solid forest connector, and label ··· time.
  - *now*: an ink ring with an ember dot, a dotted connector, label ··· **ตอนนี้** tag, and a sub-line with the start time and honest partial counts ("1 เสิร์ฟแล้ว · 2 กำลังปรุง").
  - *todo*: a 12 px steel ring, a text-2 label, no leader, no time.
  - A skipped Almost done shows "ไม่ได้บันทึก" and no time.
- **Round card.** Round n, sent time, item count and table on the left. The reference sits on the right in Oswald under "เลขอ้างอิง". Earlier rounds collapse to a `details` element: "รอบที่ 1 RG-3H2M · ส่งเมื่อ 19:08 · 3 รายการ · ✓ เสิร์ฟครบทุกจาน 19:31". Rounds are never merged.
- **Badge.** An oxblood pill with bone Oswald numerals, 19 px high, with a 2 px surface ring when it overlaps an icon. Rail counts are bone on ink, or ember on ink for attention.
- **Table tile.** The state is always carried by shape and text, never by colour alone:

  | State | Look |
  | --- | --- |
  | *Available* | Dashed taupe outline with only the number |
  | *Dining* | Forest fill with the bone number and seated minutes |
  | *Checking out* | Oxblood outline with hatching and the word "Checkout" |
  | *Disabled* (not in mock) | Paper-2 fill, number struck through, the word "Off" |

  Attention badges sit on the second row as text ("NEW", "READY", "CALL"). The strip legend repeats each swatch with its word and a count (Available **9** · Dining **5** · Checking out **1** · Disabled **0**), and those counts reconcile with the 15 tiles.
- **Stat card (Insights; not mocked).** A bone card with a label in Oswald caps ("ORDER ROUNDS · THIS WEEK"), the value in Oswald 40 px tabular, and a comparison line in Noto 13.5 ("▲ 4 vs last week · same elapsed time"). A ⓘ opens the definition. Cards show "Live" only when they are fed by the realtime pipeline, and "No prior baseline" when the prior value is zero.
- **Weekly bar chart (Insights; not mocked).**
  - Seven bars, Monday to Sunday, in Asia/Bangkok time, with the y-axis starting at 0 and integer ticks. Bars are solid ink on paper, or bone on the dark surface.
  - *Today* gets a 2 px ember outline and a "Live · partial" label.
  - *Future days* are drawn as a dotted outline only, using the leader pattern, with the label "ยังไม่ถึง / not yet". They are never drawn as zero.
  - *Real zero* is a 2 px baseline tick with "0".
  - *Missing data* is a hatched slot with the text "No data".
  - Selecting a bar raises it with an ink outline and updates the list below. Keyboard focus lands on each bar. A table equivalent sits under the chart.

## 8. Dark analytics surface (admin Insights only)

Order Stats may use a charcoal surface for the chart panel only. Operational pages stay on paper.

- Panel background: ink `#17150F`. Inner cards: ink-2. Dividers: ink-3.
- Text: bone (16.62 on ink, 15.11 on ink-2). Secondary text: `#B9B2A2` (8.65 / 7.87). Tertiary: `#8F8878` (5.18 on ink only).
- Ember is allowed for small text on **ink only** (4.64). On ink-2 (4.22) it may only be used for graphics or text ≥ 24 px.
- Completed bars: bone. Today: ember outline. Future days: steel dotted (5.36 on ink). Status still uses the same words as on paper.

## 9. Honesty notes carried into the mocks

- All names and prices come from `data/menu.json`. Wagyu "300 กรัม" and Prime Rib "฿490 / 100 กรัม" are the menu's own units.
- These are **not shown**: descriptions (none are approved), allergens (shown as unverified and routed to staff), hours, ratings, portion presets, and serving counts.
- Grilled Lamb Rack is **not shown** because its two prices have no reliable labels.
- **DESIGN PLACEHOLDER:** the "ระดับความสุก / Doneness" group in `item-sheet.html` and the Doneness modifiers on two tickets in `admin-board.html` are marked in HTML comments. They only illustrate how an owner-configured group looks. They are not a claim that the restaurant offers these choices.
- The Grilled Squid row is shown text-led to demonstrate that state. The photo asset does exist.
- Drinks without a Thai name in the data (Thai Tea, Singha Lemon Soda) fall back to their original English name, and staff see "no Thai name on file".
- The running bill is labelled as a subtotal of submitted food, with the final amount confirmed by staff, because service charge and VAT are unknown.
- Mock operational data (Table 07 rounds RG-3H2M / RG-4K7P, the 15 tables, staff "Nok" / "Ploy", 17 Sep 2026 service) is illustrative and internally consistent:
  - Table 07 round 2 is Wagyu + River Prawns + Mashed Potato. The mashed potato was served at 19:49, and the same round is shown on both the guest Track page and the staff board.
  - Round totals add up: ฿510 + ฿3,100 = ฿3,610.
  - 17 Sep 2026 is a Thursday. The restaurant is closed on Wednesdays.
