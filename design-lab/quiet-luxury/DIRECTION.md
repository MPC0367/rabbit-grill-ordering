# Rabbit Grill ordering: Quiet Luxury

Art direction C of 3. Mocks in this folder: `guest-menu.html`, `guest-track.html`, `item-sheet.html`, `admin-board.html`. Each one has a PNG with the same name, plus the extra QA PNGs listed at the end.

## 1. The idea

The page should work like a well-run dining room: the food gets most of the attention, and the service stays quiet.

- **Paper everywhere, ink for reading, and one green for doing.** Anything you can act on is forest green. Everything else is paper, ink and taupe.
- **Photography carries the heat.** The interface never adds it: no flames, smoke, grain, glow or mascots. The only warm colour in the UI is the ember mark (section 13).
- **Set type like a printed menu.** Thai names are the primary line. The English name sits under it in Cormorant italic, like a line on a printed menu. Prices use Cormorant lining figures, with a small Noto `฿` in front.
- **Restraint rule.** A guest screen shows at most **four colours at once**: paper/bone, ink, forest and the single ember mark. Taupe counts as a tint of ink. Oxblood appears only on staff screens, and only for safety or lateness. Guests never see it as decoration.

## 2. Colour roles

| Role token | Brand hex | Used for |
| --- | --- | --- |
| `--canvas` | paper `#F3ECDD` | Guest and admin page background; note field; tags on cards |
| `--surface` | bone `#F8F4EA` | Cards, feature card, sheet, tickets, bottom nav, tables strip |
| `--sunken` | paper-2 `#E9E0CB` | Segmented/language tracks, sold-out chip, modifier chips, column trays (at 55%) |
| `--text` | ink `#17150F` | All primary text, done timeline nodes, dining tiles, admin rail |
| `--text-2` | taupe `#6B5E4B` | English sub-names, meta, inactive tabs, upcoming steps |
| `--text-soft` | `#5D574A` (from base.css) | Longer explanatory copy on tinted panels |
| `--act` | forest `#1E4230` | Add, stepper, cart bar, primary CTA, ticket actions, checked radio, badge, "checking out" tile outline |
| `--act-hover` | forest-2 `#2C5A40` | Hover/pressed state of `--act` fills |
| `--on-act` | bone `#F8F4EA` | Text and icons on `--act` |
| `--now` | ember `#CB6234` | **The ember mark only**: current category/nav/step marker, current node dot, "cooking" half-fill, NEW dot, focus ring. Never used for text. |
| `--alert` | oxblood `#6E1621` | Staff only: allergy label and bar, "longer than usual" wait. Always paired with an icon and a word. |
| `--alert-wash` | `#EEE4DC` (8% oxblood on bone) | Background of the allergy block |
| `--rule` | ink @ 11% | Hairlines between rows and sections (decorative) |
| `--rule-strong` | ink @ 20% | Timeline rail (upcoming), free-table outline, chip outline |
| `--rule-ctl` | `#858176` (ink 50% on paper) | Boundaries of inputs, steppers and service buttons (needs 3:1) |
| `--d-text` / `--d-text-2` | bone / `#B9B2A2` | Admin charcoal rail and dark analytics |
| `--ember-ink` | `#A8441E` | Reserved. If an accent word on paper is ever needed, use this (5.09:1), never `--now`. |
| `--steel` | `#8E8B82` | Decorative only: upcoming timeline dot, disabled stepper glyph. Never used for text on light surfaces. |

### Measured contrast (WCAG 2.x relative luminance, computed, not estimated)

Text pairs (4.5:1 needed for body text):

| Foreground | Background | Ratio | Where |
| --- | --- | --- | --- |
| ink `#17150F` | paper `#F3ECDD` | **15.52** | body, headings |
| ink | bone `#F8F4EA` | **16.62** | cards, sheet, tickets |
| ink | paper-2 `#E9E0CB` | **13.90** | modifier chips, active segment context |
| ink | selected row `#EDEBE1` | **15.27** | checked choice row (5% forest on bone) |
| ink | alert-wash `#EEE4DC` | **14.57** | allergy quote |
| ink | column tray `#EEE5D3` | **14.59** | admin column counts |
| taupe `#6B5E4B` | paper | **5.36** | meta on canvas, inactive category tabs |
| taupe | bone | **5.75** | English names, meta on cards, inactive nav |
| taupe | paper-2 | **4.80** | inactive segment and language labels |
| taupe | column tray | **5.04** | admin secondary text |
| taupe | free-tile hatch `#EEEAE0` | **5.25** | available table number |
| `#5D574A` | paper | **6.10** | allergen explanation in sheet |
| `#5D574A` | alert-wash | **5.73** | allergy sub-line |
| forest `#1E4230` | bone | **10.19** | Add and outline-button text |
| forest | paper | **9.51** | "อยู่ในรายการแล้ว" (in your order) label |
| forest | hover wash `#EBE9DF` | **9.19** | outline button hover |
| bone | forest | **10.19** | cart bar, stepper, CTA, badge |
| bone | forest-2 | **7.23** | primary hover |
| bone | cart "view" pill `#385746` | **7.30** | 12% bone on forest |
| oxblood `#6E1621` | bone | **10.62** | long-wait time |
| oxblood | alert-wash | **9.32** | ALLERGY label |
| bone | ink | **16.62** | admin rail, dining tiles, NEW tag, active chip |
| `#B9B2A2` | ink | **8.65** | rail inactive labels, tile minutes |
| bone | ink-3 `#2E2921` | **13.14** | active rail item |
| bone | ink-2 `#221E16` | **15.11** | dark analytics text |
| `#B9B2A2` | ink-2 | **7.87** | dark analytics secondary |
| `#B9B2A2` | ink-3 | **6.84** | secondary text on dark stat cards |

Non-text pairs (3:1 needed; each one also has a text label or shape, so colour is never the only signal):

| Foreground | Background | Ratio | Where |
| --- | --- | --- | --- |
| ember `#CB6234` | paper | **3.35** | ember mark, focus ring on canvas |
| ember | bone | **3.58** | current node dot, cooking half-fill, mark on cards |
| ember | ink | **4.64** | NEW dot, today bar |
| ember | ink-2 | **4.22** | today bar on dark analytics (graphic only; 4.22 is below 4.5, so ember is never text here) |
| ember | ink-3 | **3.67** | mark on active rail item |
| `#858176` | paper / bone | **3.31 / 3.54** | input, stepper and service-button boundaries |
| steel `#8E8B82` | ink-2 | **4.87** | prior-period bars on dark analytics |
| steel | bone | **3.10** | upcoming step dot (the label next to it says what it is) |
| steel | paper | **2.90** | **fails**, so steel is never used on paper for anything that carries meaning |

## 3. Type

Three faces, each with one job. Every stack lists `"Noto Sans Thai Variable"` before the generic fallback, because Oswald and Cormorant have no Thai glyphs.

```css
--serif: "Cormorant Garamond Variable", "Noto Sans Thai Variable", Georgia, serif;   /* wordmark, English sub-names, prices */
--disp:  "Oswald Variable", "Noto Sans Thai Variable", "Arial Narrow", sans-serif;   /* tiny tracked Latin labels, table numbers, references */
--sans:  "Noto Sans Thai Variable", "Helvetica Neue", Arial, sans-serif;            /* all Thai, all UI, all body (Noto Sans Thai ships a Latin subset) */
```

**Numerals.** The `font` shorthand resets `font-variant-numeric`, and Cormorant falls back to old-style figures, so "1,180" renders like "I,I80". Declare `font-variant-numeric: lining-nums tabular-nums` (plus `font-feature-settings: "lnum","tnum"`) *after* every `font:` shorthand that sets a price.

### Thai (primary)

Letter-spacing is 0 for all Thai text, and Thai text is never uppercased. A `:lang(th)` reset runs after every tracked style.

| Token | px / line-height / weight | Use |
| --- | --- | --- |
| th-display | 28 / 1.35 / 600 | Screen title (ติดตามอาหาร) |
| th-state | 26 / 1.35 / 600 | Current round state |
| th-h2 | 24 / 1.40 / 600 | Category heading, sheet title (24 / 1.45) |
| th-feature | 22 / 1.45 / 600 | Feature-card dish name |
| th-dish | 17 / 1.50 / 500 | Menu row dish name (18 for text-led rows) |
| th-step | 17 / 1.45 / 600 current · 16 / 500 done · 15 / 400 upcoming | Timeline |
| th-body | 15 / 1.65 / 400 | Default body; 16 / 1.65 in inputs, which also avoids iOS zoom |
| th-support | 14 / 1.65–1.70 / 400 | Explanations, round meta |
| th-small | 13 / 1.50–1.60 / 500 | Nav labels, tags, meta; this is the floor for guest text |
| th-admin-line | 14.5 / 1.45 / 500 | Dish name on tickets |

### Latin

| Token | Face / px / lh / weight / tracking | Use |
| --- | --- | --- |
| wordmark | Cormorant 14 / 1 / 600 / +0.22em, caps | Header (12.5 / +0.16em under 360px) |
| sub-name | Cormorant *italic* 16 / 1.3 / 500 / 0 | English name under Thai (17 for category, 18–19 for feature and sheet) |
| price-row | Cormorant 21 / 1 / 600, lining tabular | Row price; `฿` in Noto 15/500 |
| price-hero | Cormorant 28–30 / 1 / 600 | Sheet price, per-weight rate |
| price-cta | Cormorant 21–22 / 1 / 600 | Cart bar and sheet CTA totals |
| label | Oswald 10.5–12 / 1 / 500 / +0.12–0.16em, caps | "TABLE", column names, references (RG-4K7P), section numerals |
| table-no | Oswald 26 / 0.9 / 600 / +0.01em | Ticket table number |
| lang | Oswald 12 / 1 / 500 / +0.10em | TH / EN |
| admin-ui | Noto 13–15 / 1.25–1.55 / 500–600 | Staff UI text |

## 4. Spacing

A 4px base, used mostly in these steps: **4 · 6 · 8 · 10 · 12 · 14 · 16 · 20 · 22 · 24 · 28 · 34**.

- Guest side gutter is **20px**, and 16px under 360px. No layout ever scrolls horizontally.
- A menu row has 20px vertical padding and a 16px column gap. The thumbnail is `clamp(96px, 31vw, 124px)` wide at 4:3.
- Category sections have 30px above the heading and 12px between the heading and its rule.
- Sheet sections are separated by 26px, then a rule, then 22px.
- Admin page padding is 22px. Column gap is 12px, ticket padding 13px, and gap between tickets 8px.
- Touch targets are **44px minimum** everywhere, and primary actions are 48–58px. Where a control looks smaller (language pill 30px, ticket ⋯ 32px), a transparent `::after` extends the hit area to 44px.

## 5. Radii

`--r-xs 6` place card, modifier chips · `--r-s 10` thumbnails, tiles, ticket buttons · `--r-m 12–14` inputs, segmented control, choice group, tickets (12) · `--r-l 16–18` feature card, round card, cart bar, CTA · `--r-sheet 24` sheet top corners · `--r-pill` Add, stepper, tags, language, chips.

Corners are soft but restrained. Nothing larger than 24px, and no fully rounded cards.

## 6. Rules and borders

- Borders are drawn with `box-shadow: inset 0 0 0 1px`, so they never change layout.
- Hairlines (`--rule`, ink 11%) separate content only; they never define a control.
- Control boundaries use `--rule-ctl` (3.31:1 or better). Focused inputs get a 1.5px ink edge.
- Timeline rail is 1.5px: solid ink through completed steps, ink 20% for upcoming ones.

## 7. Elevation

| Token | Value | Use |
| --- | --- | --- |
| e-0 | hairline only | Rows, sections |
| e-1 | `0 1px 0 ink/3%, 0 1px 3px ink/7%` + inset hairline | Cards, tickets, place card, active segment |
| e-cta | `0 12–14px 26–30px -14px forest/70–80%` | Cart bar, sheet CTA: a green-tinted shadow, so the one action floats |
| e-sheet | `0 -18px 48px -18px ink/45%` + scrim ink/50% | Bottom sheet |

The header and bottom nav are glass: paper or bone at 92–96% with a 16px backdrop blur, separated from content by a hairline rather than a shadow.

## 8. Iconography

- Inline SVG on a 24-unit grid, **1.5 stroke**, round caps and joins, `currentColor`. Sizes are 20px (UI) and 16px (inline with text).
- Glyphs have a plain hospitality vocabulary: a service bell for Call staff, a folded receipt for Bill, a balance scale for by-weight pricing, a speech bubble with a check for asking staff to confirm, a shield for allergens, and a clock for waits.
- State icons pair with words: check-circle means served, a half-filled circle (ember half) means cooking, a slashed circle means sold out, and a triangle means allergy.
- Service icons never appear without a text label, except the bell inside the table place card, which has a full `aria-label`.

## 9. Motion (brief 42)

| Token | Value | Applies to |
| --- | --- | --- |
| `--t-press` | 120ms `cubic-bezier(.2,.7,.3,1)` | Press scale (0.96–0.98) on Add, CTA, service buttons, place card |
| `--t-fast` | 160ms, same curve | Colour/background changes, radio fill, hover states |
| `--t-base` | 200ms, same curve | Segmented thumb slide, **ember mark glide between tabs** (180–200ms), scrim fade, chevrons |
| `--t-step` | 220ms, same curve | New current timeline step: the ember halo settles from 11px to 5px **once**, only after a committed staff event (class `is-fresh`, never on reconnect) |
| `--t-sheet` | 240ms `cubic-bezier(.32,.72,0,1)` | Sheet rises with transform only |
| initial render | 160ms opacity + 4px rise, first visible content only | No per-row scroll reveals |
| add to order | Button fills forest and becomes a stepper; badge number changes | No flying food, no bounce |
| new staff ticket | 1.5px ember outline plus a "NEW" tag until the ticket is acknowledged | No flashing, no jump scroll |
| table reset | 180ms tile crossfade | The state changes immediately; the animation never delays it |
| chart switch | 220ms bar height transition from real value to real value | Axis stays fixed; no rolling counters |

**Reduced motion:** every transition drops to 0.01ms, keyframes are removed, and the sheet fades in (160ms) instead of rising. Product images only zoom on press (1.03, 600ms), and never under reduced motion.

## 10. Component vocabulary

**Buttons.**

- *Primary* (forest fill, bone text, 44–58px): cart bar, sheet CTA, ticket next action, and the in-order stepper. This is the only filled green in the menu list, so a filled control always means "this is in your order".
- *Line* (1px forest edge, forest text on bone): Add, "ขอให้พนักงานยืนยันน้ำหนัก" (ask staff to confirm the weight), Almost done. Fills forest on hover.
- *Quiet* (bone, `--rule-ctl` edge, ink text): service buttons (Call staff, Request bill), allergen "เรียกพนักงาน" (call staff).
- *Round close* (bone 94% over the photo, 44px).

**Add → stepper.** A pill labelled "+ เพิ่ม" turns into a filled pill `− 1 +` (44px segments) with a "✓ อยู่ในรายการแล้ว" (already in your order) line under the name. Items with required choices open the sheet instead.

**Sold out.** The photo goes greyscale at 45% opacity, the name and price turn taupe, and the add control is replaced by a non-interactive `⊘ หมดชั่วคราว` (temporarily sold out) chip. It is never orderable.

**Text-led row.** Same anatomy as a photo row with the photo column removed; the name is set at 18px. There is no placeholder art and no broken-image icon.

**By-weight feature card.** A 3:2 photo, then the kicker "⚖ ราคาตามน้ำหนัก" (priced by weight), the name, and the rate set as `490 ฿ / 100 กรัม`. The number comes first so a rate never reads like a fixed price (`฿590`). One line explains that staff weigh the cut and send the price for the guest to confirm, and a line button requests that confirmation. There are no preset portions and no Add button.

**Chips and tags.** Tags are 30px pills on the canvas (tally, live). Admin filter chips are 36px, and ink fill means pressed. Modifier chips are 22px, 6px radius, on the sunken surface.

**Segmented control.** A paper-2 track with a bone thumb (e-1) that slides in 200ms; the active label is ink 600 and inactive labels are taupe. Used for Food/Drinks (48px), TH/EN (30px visual, 44px hit) and admin Board/Requests.

**Category row.** Text tabs, not pills, with a right-edge fade. The **ember mark** sits under the current tab, and a fixed "≡ ทุกหมวด" (All categories) button opens the full list, so no category is reachable only by swiping.

**Header.** Wordmark, then the **place card** (a small bone tent card reading `โต๊ะ 07`, joined to a service-bell segment), then TH/EN. The place card is the always-visible table label *and* the door to table service. Under 360px the language control collapses to the single option you can switch to.

**Bottom nav.** Three destinations: เมนู (Menu) · รายการของฉัน (Your order) · ติดตาม (Track). Icon over a 13px label; the active item is ink 600 with the ember mark underneath. The badge is an 18px forest pill with a bone ring.

**Cart bar.** Forest, 58px, radius 18, floating 12px above the nav: `2 รายการ · ฿1,180`, then a "ดูรายการ →" (view order) pill.

**Sheet.** Top corners radius 24. It sits 64px from the top so the dimmed menu stays visible behind it. Photo at 16:10 with a grab handle and a 44px close button, then title, English name and price. Choice groups sit in a hairline box of 54px rows, with a status pill that reads "จำเป็น" (required) and turns into "✓ เลือกแล้ว" (selected) once chosen. Below that: the 48px stepper, a note field with a live `17 / 140` counter and a staff-confirmation help line, the allergen panel, and a sticky footer with the full-width CTA `เพิ่ม · ฿590` (Add · ฿590).

**Timeline step.** A 28px node column, then the title, then the time on the right.

- *Done:* a 22px ink disc with a bone check and the actual time.
- *Current:* a 26px ring with a 10px ember dot, a 5px ember halo, a 17/600 title, the start time ("เริ่ม 19:46", started 19:46), and one line of explanation.
- *Upcoming:* a 12px steel ring and a taupe 15/400 title, with no time.

**Per-dish row.** A 56px thumbnail, the name with its quantity, and a status in icon plus text. Under it, a six-segment **trail** records the milestones: ink for done, ember for now, empty for not yet, and dotted for *not recorded*. A skipped Almost done is never given an invented time.

**Past round.** Collapsed into one line (✓ เสิร์ฟครบแล้ว, all served), the reference and time, and overlapping 34px thumbnails with a "+3" count.

**Ticket (admin).** From top to bottom:

- The TABLE label with the table number in Oswald 26, and the wait time on the right (the time turns oxblood, with the words "Longer than usual", once it passes the owner-set threshold).
- The round, reference and time, with a ⋯ button that opens details and exceptions.
- Lines with Oswald quantities, the Thai name first and the English name under it, then modifier chips, the guest note and per-line status.
- An **allergy block**: an oxblood 3px bar, a triangle icon, the "ALLERGY NOTE" label, the guest's exact words, and "Confirm with the table before cooking".
- An optional "1 of 3 served" bar, then the one-tap next action with its line count ("Accept · 4 items", "Ready · 2").

New tickets get the 1.5px ember outline and a NEW tag.

**Table tile.** 52px tall with the table number in Oswald. The three states differ by fill, pattern and text, not colour alone:

- *Available:* a hatched outline, like an empty table.
- *Dining:* an ink fill with the seated duration.
- *Checking out:* bone with a 2px forest outline and the word "Bill".

Attention flags are 20px bone discs with an ink ring and a glyph (✓ food ready, bell request, ! new order); they sit on top of the state and never replace it. The legend counts (Available 9 · Dining 5 · Checking out 1) reconcile to the 15 tiles.

**Stat card (Insights).** On the dark analytics surface: ink-3 cards on ink-2, a 12px Oswald caps label in `#B9B2A2`, the value in Cormorant 44/600 lining bone, the comparison in Noto 13 `#B9B2A2` with an arrow glyph and a sign (never colour alone), and a "?" definition button. Cards say "Live" only when the value comes from the measured live pipeline.

**Bar chart (Order Stats).** Seven bars (Mon–Sun) on ink-2:

- Completed days are bone bars (15.11:1).
- The prior-period comparison is a steel ghost bar behind each one (4.87:1).
- **Today** is an ember bar with an ember mark under the day label and the word "Live · partial".
- Future days show a dashed baseline stub labelled "—", never zero.
- A real zero is a 1px bone baseline tick with "0".
- The y-axis starts at 0 with integer ticks in `#B9B2A2`.
- Selecting a day raises its label to bone 600 and shows its values beneath the chart. A table of the same data sits under a "Show as table" disclosure.

## 11. Dark admin analytics surface

Only Insights goes dark: an `ink-2` page with `ink-3` cards, bone text (15.11 / 13.14), `#B9B2A2` secondary text (7.87 / 6.84), and hairlines of bone at 10%. Forest stays the action colour (bone on forest-2 is 7.23 for buttons on dark). Ember keeps exactly one meaning: *today / now*. Orders, Tables and Menu stay on paper, because the kitchen reads them under bright light.

## 12. Honesty built into the mocks

- All names and prices come from `data/menu.json`. Wagyu shows its own "300 กรัม" (300 g). Seasonal Avocado stays unpublished in the category row until the owner confirms it, and Lamb Rack (two unlabelled prices) is left out.
- `item-sheet.html` and `admin-board.html` carry `DESIGN PLACEHOLDER` comments on the doneness group. Rabbit Grill has not confirmed any doneness options.
- There are no descriptions, badges, "signature" tags, ratings, hours or allergen claims. The allergen panel says no confirmed data exists and routes the guest to staff.
- The guest note on the allergy ticket is shown verbatim in Thai, not translated.
- The staff name ("Ploy K."), the references and the times are fixture data.

## 13. The signature: the ember mark

**What it is.** A single 18×2px ember bar, taken from the restaurant's own favicon, where an ember bar sits under the R. It appears **only under whatever is happening now or is current**:

- the current category tab while browsing,
- the active bottom-nav destination,
- the current state of a round ("กำลังปรุง", currently cooking) and the ember dot of the current timeline node,
- the ember half of a cooking dish's status icon and trail,
- the NEW dot on a fresh ticket, and the active item in the staff rail,
- *today's* bar in Order Stats,
- the keyboard focus ring.

**Why it's memorable.** On a paper-and-ink page with one green, a warm spark always marks the present moment. It repeats the brand's heat without a single flame, and it stays small enough to disappear into the typography.

**Why it doesn't hurt usability.** It never carries meaning alone: every place it marks also changes weight (600), colour (ink over taupe), shape (ring or halo) or text ("Live · partial", "NEW"). It is a non-text graphic at 3.35–4.64:1. In the build it is **one element that glides** between tabs (180–200ms transform) rather than one per tab, so it also works as a quiet motion cue, and it snaps into place under reduced motion.

## Files

- `guest-menu.html`: `guest-menu.png` (first viewport), `guest-menu-scrolled.png` (sticky header and category row), `guest-menu-full.png` (full length; the fixed dock appears mid-page because of how the capture works), `guest-menu-stress.png` (longest real Thai names and the seasonal tab at 390px), `guest-menu-320.png` (the same at 320px)
- `guest-track.html`: `guest-track.png`, `guest-track-dishes.png` (per-dish and past round), `guest-track-full.png`
- `item-sheet.html`: `item-sheet.png`, `item-sheet-end.png` (opened as `item-sheet.html#end`)
- `admin-board.html`: `admin-board.png` (1440×900)
