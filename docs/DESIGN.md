# Rabbit Grill ordering: design system

This is the definitive visual and interaction system for the guest menu and the staff admin. The React ui kit (`client/src/ui`, `client/src/styles/base.css`, `client/src/styles/components.css`) implements this document. Screens are compared against the reference mocks in `design-lab/final/`.

- **Tokens:** `client/src/styles/tokens.css`. Components read role tokens only, never a raw hex.
- **Reference mocks:** `design-lab/final/guest-menu.html`, `guest-track.html`, `admin-board.html`, `admin-tables.html`, `admin-stats.html`. They share `final.css`, the component stylesheet to port into `components.css`, and `sprite.js`, the icon set.
- **Brief sections this must not contradict:** 05, 08–11, 17, 19, 33–37, 42 and 44.
- **The owner's one instruction:** "Make it elegant."

---

## 0. Setup

### 0.1 Font imports

The imports below were checked against `node_modules/@fontsource-variable/*`. Keep this order in `client/src/main.tsx`: fonts, then tokens, then base, then components.

```ts
import '@fontsource-variable/oswald';                              // "Oswald Variable", wght 200–700, normal only
import '@fontsource-variable/noto-sans-thai';                      // "Noto Sans Thai Variable", wght 100–900 (thai + latin + latin-ext subsets, includes ฿ U+0E3F)
import '@fontsource-variable/cormorant-garamond';                  // "Cormorant Garamond Variable", wght 300–700, normal
import '@fontsource-variable/cormorant-garamond/wght-italic.css';  // same family, italic 300–700
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
```

None of the three packages ships an `italic.css`. The only italic file is `cormorant-garamond/wght-italic.css`. Oswald and Noto Sans Thai have no italic at all, so never set `font-style: italic` on them, or the browser will synthesise a fake slant. `noto-sans-thai/standard.css` adds the width axis, which this system does not use.

Neither Oswald nor Cormorant has Thai glyphs, and neither has `฿`. Every stack that can meet Thai therefore names `"Noto Sans Thai Variable"` straight after the primary face and before any fallback (§4.1).

### 0.2 Page contract

- `<html lang="th">` by default. Switching language changes `lang` in place; it never remounts the app.
- Any Latin text that uses tracking or caps carries `lang="en"`, because the tracking tokens are zero under `:lang(th)`.
- Guest pages set `color-scheme: light`. There is no automatic dark mode in V1, because the brief asks for a paper-led guest surface. Charcoal appears only where `data-surface="dark"` is set.
- `data-motion="reduce"` on `<html>` forces reduced motion from a staff setting, in addition to the OS media query.

---

## 1. The direction and the synthesis

### 1.1 Scores

| Direction | Operations judge | Brand and craft judge | Total |
| --- | --- | --- | --- |
| **Menu Card** | 79 | 82 (winner) | **161** |
| The Pass | 84 (winner) | 75 | 159 |
| Quiet Luxury | 66 | 78 | 144 |

**The base is Menu Card**, and the working name for the final system is **"The Menu Card, set for service"**. Three reasons:

- It has the highest combined score.
- It is the only direction both judges called elegant *and* recognisably Rabbit Grill: matted plates, the KHAO YAI lockup, framed square toggles, Oswald prices and the Cormorant italic.
- Its signature, the leader line, is original, honest and cheap to build.

**The Pass's operational anatomy is grafted in whole**, because it won the service judgement. That covers the staff docket, the allergy band, the unsent-order warnings, the sheet footer and the search-and-segment row.

**Quiet Luxury contributes its best interaction ideas**: the bone-thumb segmented control, the required-to-selected pill, the gliding ember mark, split doneness chips, the lateness threshold, and the "Almost done is optional" hint.

### 1.2 Grafts

| Idea | From | Where it lives now |
| --- | --- | --- |
| Print grammar: matted 4:3 plates, masthead double rule, "No. 01" kicker, Thai title with a Cormorant italic English title | Menu Card | Masthead, section head, DishRow, sheet |
| Leader line, label ··· value only | Menu Card | DishRow price, sheet price, Timeline times, running bill, portion quote |
| Framed `โต๊ะ 07` table tag (24px numeral) and framed ไทย/EN box | Menu Card | Masthead |
| Service as a labelled slot in the bottom dock, in thumb reach, never "active" | Menu Card | ServiceKey (beside BottomNav) |
| Board toolbar: station filter, table, oldest-first sort, rejected/cancelled toggle, search | Menu Card | admin Orders |
| Alerts on · Test | Menu Card | Admin rail foot |
| Track: live chip with last update, "every device at table 07 sees the same status", provisional running subtotal, collapsed past round | Menu Card | guest Track |
| "Pause…" opens a confirmation, so ordering is never closed with one tap | Menu Card | Workspace header |
| Word badges on table tiles (NEW / READY / CALL / QUOTE) | Menu Card, enlarged to 13px | TableTile |
| Cormorant italic admin page titles | Menu Card | Workspace header |
| `หมดชั่วคราว` wording, `ไม่ได้บันทึก` for skipped steps, ink `ตอนนี้` tag | Menu Card | DishRow, Timeline |
| Unsent warning: `ยังไม่ได้ส่งเข้าครัว` on the cart bar, plus the Track nudge `มี N รายการที่ยังไม่ได้ส่ง · ส่งเป็นรอบที่ N+1` | The Pass | CartBar, Track |
| Search and Food/Drinks on one row; fixed `ทุกหมวด` button at the left of the category row | The Pass | Guest menu toolbar |
| Price on the first line, action on its own foot row, English italic at full column width | The Pass | DishRow |
| Staff docket: framed table number (32px), ref, wait with clock (24px), full-bleed oxblood allergy band quoting the guest, one progress segment per dish, served lines crossed off with time and person, counted actions | The Pass | Ticket |
| Reject and other exceptions behind `⋯` | The Pass | Ticket |
| Sticky sheet footer with stepper and `เพิ่มในรายการ · ฿590`; selected option = tinted fill + forest edge | The Pass | Sheet |
| Guest allergy notice in alert tint with a triangle and a Call staff button | The Pass | AllergyNotice |
| Call staff / Request bill pair at the top of Track | The Pass + Quiet Luxury | Track |
| Visible dashed `ตัวอย่าง` / `Example` tag on any placeholder configuration | The Pass | Tag (example), sheet, tickets, cart |
| Ink chips for verified variants (500 ml, Iced), `Alcohol · staff to confirm`, `no Thai name on file` | The Pass | Ticket |
| Flat copper rail over the Ready column, "at the pass" (no lamp, no glow) | The Pass | Board column |
| Table status stated in words (Free / 48m / Bill / Off) | The Pass | TableTile |
| Bone-thumb segmented control on a paper-2 track | Quiet Luxury | SegmentedControl |
| One ember mark that glides between tabs and snaps under reduced motion | Quiet Luxury | CategoryRow, BottomNav |
| Required pill `จำเป็น` that becomes `✓ เลือกแล้ว` | Quiet Luxury | ChoiceGroup |
| Modifier chips split by quantity (`มีเดียมแรร์ × 1`, `มีเดียม × 1`) | Quiet Luxury | Ticket |
| Owner-set "Longer than usual" threshold (oxblood + words) | Quiet Luxury | Ticket wait |
| "Almost done is optional. Tickets can go straight from Preparing to Ready." | Quiet Luxury | Board column |
| Lock screen at the rail foot | Quiet Luxury | Admin rail |
| Past round with overlapping thumbnails and `+N` | Quiet Luxury | Track |
| Per-dish six-segment trail, made taller (4px) and always paired with words | Quiet Luxury | Track dish lines |
| Right-aligned Cormorant English section title; `clamp()` thumbnail width | Quiet Luxury | Section head, DishRow |
| `font-variant-numeric: tabular-nums lining-nums` after every font shorthand used for numbers | Quiet Luxury | `--num-features` |

### 1.3 Every judged weakness, and what fixes it

| # | Weakness (direction) | Resolution in this system |
| --- | --- | --- |
| 1 | Staff buttons 40px (Pass) | All staff actions, toolbar controls and rail rows are 48px (`--control-h-staff`). Icon buttons are 48×48. The smallest staff hit area is 44px. |
| 2 | No station filter, search or sort (Pass, Quiet Luxury) | The board toolbar has station, table, sort, rejected/cancelled and search controls (§10.21). |
| 3 | Icon-only 12px table alerts (Pass, Quiet Luxury) | Word badges in 13px Oswald caps: NEW, READY, CALL, QUOTE, BILL. The tile's aria-label repeats them. |
| 4 | Lamp glow reads as a smudge (Pass) | There are no glows, blurs or gradients behind text. The ember mark is a flat 2–3px bar. |
| 5 | Hanging lamp drawing wastes 60px (Pass) | Removed. There is no illustrative mark. |
| 6 | Sold-out price struck through, reads as a discount (Pass) | The price stays unstruck in `--text-2`. The action slot shows plain oxblood `⊘ หมดชั่วคราว` text, and the plate turns greyscale. |
| 7 | Service button top-right, out of thumb reach (Pass) | A labelled `บริการ` key sits in the bottom dock. On desktop it is a labelled header button. |
| 8 | Language switch visually 30px (Pass, Quiet Luxury) | A framed box with 44×44 segments. |
| 9 | Serrations and notches clutter the dense board (Pass) | The staff board has no ticket metaphors. Guests see only a perforated rule on the round card and on the order slip. |
| 10 | Too many metaphors (Pass) | Four devices in total: leader, perforation, ember mark, copper rail. |
| 11 | Bordered sold-out box looks like a button (Pass) | It is text only (see 6). |
| 12 | Heavy grey `01` with tracked BEEF SELECTION (Pass) | `No. 01` kicker on a hairline, then the Thai title, with the italic English title right-aligned. |
| 13 | Track repeats `กำลังปรุง` three times (Pass) | The word appears in the state headline and the current step only. Counts move into the step sub-line. |
| 14 | Pink advisory tint drifts off-palette (Pass) | `--alert-tint #EEE4DC`, which is 7% oxblood on bone. |
| 15 | Fragile conic masks and drop-shadow filters (Pass) | Neither is used. The only filter is greyscale on a sold-out plate. |
| 16 | Legend wraps; 15 "Free" labels are noisy (Pass) | The legend is one row above the strip. "Free" is set in regular weight `--text-2`. |
| 17 | Staff labels 10–11.5px (Menu Card, Quiet Luxury) | Staff floor: 12px for Latin caps labels only, 13px for any sentence. The mocks have zero staff text below 12px. |
| 18 | Pale outlined allergy block, below the fold (Menu Card, Quiet Luxury) | A full-bleed oxblood band directly under the ticket header, above every dish line. The Accept order is oldest-first, so any allergy ticket that arrived first stays first. |
| 19 | `Reject…` next to Accept (Menu Card) | Reject, cancel and correct live behind `⋯` (details panel, reason required). |
| 20 | Cart bar never says the order is unsent (Menu Card) | The cart bar sub-line reads `ยังไม่ได้ส่งเข้าครัว`, and Track shows a nudge card. |
| 21 | Neutral allergen panel (Menu Card, Quiet Luxury) | Alert-tint notice with a triangle, a bold question, an honest sentence and a Call staff button. |
| 22 | Selected choice only a filled dot (Menu Card) | Selected row = `--selected` fill, 2px forest edge (border plus inset), weight 600, and a filled radio. |
| 23 | Placeholder marked only in HTML comments (Menu Card, Quiet Luxury) | Visible dashed `ตัวอย่าง` / `Example` tag wherever placeholder configuration renders. |
| 24 | Leader dots on staff tickets (Menu Card) | No leaders anywhere on staff screens. |
| 25 | Steppers, language and station chips just under 44px (Menu Card, Quiet Luxury) | Guest ≥ 44px, staff ≥ 48px. Audit result is in §14. |
| 26 | Call staff and Bill only at the bottom of Track (Menu Card) | A full-width pair at the top of Track. |
| 27 | Heavy top stack with an ink-filled Food segment (Menu Card) | Search and segment share one row, and the segment uses a bone thumb. The first dish row starts at y ≈ 280 at 390×844. |
| 28 | Leaders on radio rows and inside the Add button (Menu Card) | Leaders are used only where a label points to a value (§9). |
| 29 | Ragged price column when Thai names wrap (Menu Card) | The lead row aligns to the *first* baseline (`align-items: first baseline`, with the name button set to `inline-flex`). Prices hold one column at the top of each row. |
| 30 | Heavy column of filled green Add buttons (Menu Card) | Add is a secondary (outline) button. In-order is a tinted stepper with a `✓ ในรายการ` line. The only solid green on the Menu screen is the order slip. |
| 31 | Forest Dining tiles look like buttons; oxblood checkout hatching reads as an alarm (Menu Card) | Dining = ink fill. Checking out = bone with a 2px forest outline, a receipt icon and the word "Bill". |
| 32 | Busy toolbar; three stacked numerals on the ticket header (Menu Card) | One 48px toolbar row with a single control style. The header is table box + ref + wait; the sent time is plain text. |
| 33 | Prime Rib hero fills the first viewport (Quiet Luxury) | By-weight items are normal rows with a `⚖ ราคาตามน้ำหนัก` kicker. There is no promotional hero. |
| 34 | Unlabelled bell icon (Quiet Luxury) | The service key is labelled `บริการ`. |
| 35 | Inverted emphasis, outline Add against a filled stepper (Quiet Luxury) | Neither is solid (see 30). The stepper is tinted and labelled. |
| 36 | Thin Cormorant prices (Quiet Luxury) | Prices are Oswald 500 with tabular lining numerals. Cormorant is used for identity and English names only. |
| 37 | Trail too thin to read (Quiet Luxury) | 4px segments, `aria-hidden`. The status word and time carry the meaning. |
| 38 | Staff board weak at arm's length (Quiet Luxury) | Table numeral 32px, wait 24px, ref 15px. |
| 39 | One-tap ordering pause switch (Quiet Luxury) | `Pause…` opens a confirmation dialog. |
| 40 | `⋯` 32px, chips 36px (Quiet Luxury) | 48px. |
| 41 | Pills, big radii and glass blur drift off-brand (Quiet Luxury) | Radii are 2–10px, sheet 16px. No `backdrop-filter`. Framed square toggles, Oswald caps. |
| 42 | Shopping-bag icon (Quiet Luxury) | Order-pad icon. |
| 43 | Signature too quiet to register (Quiet Luxury) | The leader line is the signature. The ember mark is the single warm accent (§9). |
| 44 | Checking-out tile oxblood; Dining forest (Menu Card synthesis note) | See 31. |

---

## 2. Principles

1. **Elegant means typeset, not decorated.** Hierarchy comes from type, rules and space. Photography carries the heat. Nothing glows, pulses, blurs or burns.
2. **Paper-led.** Guests read on paper (`--canvas`) and bone (`--surface`). Charcoal appears only on the admin rail and the analytics chart panel.
3. **Fast.**
   - A guest sees dishes on the first screen.
   - A simple dish is one tap from the draft.
   - Track and the draft are one tap away.
   - Staff advance a ticket with one counted action.
4. **One solid action per view.** A forest fill means "this is the next step here":
   - Menu: the order slip.
   - Sheet: the add button.
   - Your order: Send order.
   - Staff ticket: the next action.
   - Everything else is secondary or outline.
5. **Colour never works alone.** Every state has a word, and usually an icon or a shape as well.
6. **Honest by construction.**
   - Placeholder configuration is tagged.
   - Unknown allergen data is stated as unknown.
   - Future chart days are never zero.
   - By-weight prices always carry "per 100 g".
   - Fixtures are labelled "Demo data".
7. **Thai first.** Thai is the primary line, set in Noto Sans Thai with zero tracking and line-height ≥ 1.55. English is the secondary line in Cormorant italic.

---

## 3. Colour

### 3.1 Brand primitives (reference site `css/base.css`)

| Token | Hex | | Token | Hex |
| --- | --- | --- | --- | --- |
| `--paper` | #F3ECDD | | `--forest` | #1E4230 |
| `--paper-2` | #E9E0CB | | `--forest-2` | #2C5A40 |
| `--bone` | #F8F4EA | | `--oxblood` | #6E1621 |
| `--ink` | #17150F | | `--taupe` | #6B5E4B |
| `--ink-2` | #221E16 | | `--ember` | #CB6234 |
| `--ink-3` | #2E2921 | | `--ember-ink` | #A8441E |
| | | | `--steel` | #8E8B82 |

### 3.2 Derived primitives

| Token | Hex | Why it exists |
| --- | --- | --- |
| `--ink-soft` | #5D574A | Secondary text (reference `--fg-soft`) |
| `--ink-edge` | #7A7264 | Boundary of a light control (≥ 3:1 on every light fill) |
| `--ink-numeral` | #857D6F | Decorative numerals of 24px and up |
| `--paper-hover` | #EFE8D8 | Hover and press wash |
| `--paper-well` | #EDE5D2 | Board column tray |
| `--forest-tint` | #E3EAE2 | Selected row, in-order stepper, ok pill |
| `--oxblood-tint` | #EEE4DC | Allergy notice, alert pill, cancelled line (7% oxblood on bone) |
| `--ember-tint` | #F3E2D4 | "Oldest waiting" flag, quote badge |
| `--sage` | #D5DDD4 | Secondary text on forest |
| `--blush` | #EAD3D3 | Secondary text on oxblood |
| `--ash` / `--ash-2` | #B9B2A2 / #8F8878 | Secondary and tertiary text on charcoal |
| `--smoke` | #37342E | Hover on charcoal |
| `--sage-light` / `--rose-light` / `--ember-light` | #9FC4AA / #E59C90 / #E08A5E | ok, alert and ember **text** on charcoal |
| `--forest-night` / `--oxblood-night` / `--ember-night` | #223127 / #3A1B1C / #3A2419 | Tints on charcoal |

### 3.3 Semantic roles (light, the default)

| Role | Value | Used for |
| --- | --- | --- |
| `--canvas` | paper | Page background |
| `--surface` | bone | Cards, sheet, tickets, bottom nav, inputs, plate mats |
| `--sunken` | paper-2 | Segmented track, note wells, disabled tiles |
| `--well` | paper-well | Board columns |
| `--hover` | paper-hover | Hover and pressed rows |
| `--text` | ink | Primary text |
| `--text-2` | ink-soft | Meta, inactive tabs, helper text |
| `--text-3` | taupe | Kickers, English italic names, future timeline steps |
| `--numeral` | ink-numeral | Rank numerals (decorative, ≥ 24px) |
| `--rule` / `--rule-soft` / `--rule-strong` | ink 14% / 8% / 26% | Hairlines (never a control's only boundary); perforation; outline-button border |
| `--rule-ink` | ink | Masthead double rule, framed tags, first-row rule under a section title |
| `--edge` | ink-edge | Inputs, radios, framed icon buttons, dashed Available tiles |
| `--leader` | steel | Leader dots, future timeline rings. **Never text.** |
| `--action` / `--action-hover` / `--on-action` / `--on-action-2` | forest / forest-2 / bone / sage | Primary actions and the order slip |
| `--action-text` | forest | Secondary (outline) button label and border |
| `--selected` / `--selected-edge` | forest-tint / forest | Chosen option row, in-order stepper |
| `--ok` / `--ok-tint` | forest / forest-tint | Done, served, live |
| `--alert` / `--alert-tint` / `--on-alert` / `--on-alert-2` | oxblood / oxblood-tint / bone / blush | Allergy, sold out, late, rejected, cancelled. Always with an icon and words. |
| `--heat-text` / `--heat-tint` | ember-ink / ember-tint | "Oldest waiting", pending portion quote |
| `--now` | ember | **The ember mark.** On light surfaces it is a graphic, never text. |
| `--now-text` | ember-ink | Warm "now" words on flat paper or bone (rare) |
| `--inverse` / `--on-inverse` / `--on-inverse-2` | ink / bone / ash | `ตอนนี้` tag, NEW flag, verified variant chips, count badges, pressed language box |
| `--focus` | ember | Focus ring |
| `--scrim` | ink 56% | Behind sheets and dialogs |
| `--image-bg` / `--image-mat` | ink-2 / bone | Reserved photo box / plate mat |
| `--tone-{neutral,ok,alert,heat,ink}-{bg,fg}` | as above | StatusPill, Badge, Flag |
| `--table-{available,dining,checkout,disabled}-*` | §10.25 | TableTile |
| `--chart-*`, `--rail-pass` | §10.28, §10.24 | Charts, Ready column rail |

### 3.4 Charcoal scope, `[data-surface="dark"]`

It is used on the admin rail, the Order Stats chart panel, and any compact charcoal band. Roles remap, so components need no dark-specific code.

| Role | Dark value |
| --- | --- |
| `--canvas` / `--surface` / `--sunken` / `--well` / `--hover` | ink / ink-2 / ink-3 / ink-2 / smoke |
| `--text` / `--text-2` / `--text-3` | bone / ash / ash-2 (**`--text-3` never on `--sunken`**, 4.10) |
| `--rule` / `--rule-soft` / `--rule-strong` / `--rule-ink` | bone 14% / 8% / 28% / bone |
| `--edge` | ash-2 |
| `--action*` | unchanged (forest with bone text) |
| `--action-text` | sage-light |
| `--selected` / `--selected-edge` | forest-night / sage-light |
| `--ok` / `--ok-tint` | sage-light / forest-night |
| `--alert` / `--alert-tint` | rose-light / oxblood-night |
| `--heat-text` / `--heat-tint` | ember-light / ember-night |
| `--now` / `--now-text` | ember / ember-light |
| `--inverse` / `--on-inverse` | bone / ink |
| `--chart-bar` / `--chart-future` / `--chart-prior` / `--chart-missing` / `--chart-axis` | bone / steel / ash-2 / ash-2 / ash |

Composite tokens (`--border-*`, `--rule-double`, `--plate-frame`, `--focus-ring`) are declared again inside the scope, because a custom property resolves where it is declared.

`@media print` maps every surface to white and every rule to black (QR cards, printable bill).

### 3.5 Contrast: every text pair in use (WCAG 2.x, computed)

AA needs 4.5:1 for body text, or 3:1 for text of at least 24px (or 18.66px bold).

| Foreground | Background | Ratio | Used for |
| --- | --- | --- | --- |
| ink | paper | **15.52** | Page text |
| ink | bone | **16.62** | Cards, sheet, tickets |
| ink | paper-2 | **13.90** | Segmented track, note well |
| ink | paper-well | **14.55** | Board column text |
| ink | paper-hover | **14.95** | Hovered rows |
| ink | forest-tint | **14.89** | Selected option label, stepper count |
| ink | oxblood-tint | **14.57** | Allergy notice title, cancelled line |
| ink | ember-tint | **14.46** | — |
| ink | ember | **4.64** | READY badge, rail count badge |
| ink-soft | paper / bone / paper-2 | **6.10 / 6.53 / 5.46** | Meta, helper, inactive tabs |
| ink-soft | paper-well / paper-hover | **5.72 / 5.88** | Column hints, hovered meta |
| ink-soft | forest-tint / oxblood-tint | **5.85 / 5.73** | Sub-lines on tinted rows |
| taupe | paper / bone / paper-2 | **5.36 / 5.75 / 4.80** | Kickers, English italic, future steps |
| taupe | paper-well / forest-tint | **5.03 / 5.15** | — |
| forest | paper / bone / paper-2 | **9.51 / 10.19 / 8.52** | Secondary buttons, `✓ ในรายการ`, served text |
| forest | forest-tint / paper-well / paper-hover | **9.13 / 8.92 / 9.17** | Ok pills, hover |
| forest-2 | paper | **6.75** | — |
| bone | forest | **10.19** | Primary buttons, order slip, BILL badge |
| bone | forest-2 | **7.23** | Primary hover |
| sage | forest | **8.06** | Order-slip sub-line `ยังไม่ได้ส่งเข้าครัว` |
| oxblood | paper / bone | **9.92 / 10.62** | `หมดชั่วคราว`, late wait, danger button |
| oxblood | oxblood-tint / paper-well | **9.32 / 9.30** | Alert pills, cancelled status |
| bone | oxblood | **10.62** | Allergy band, CALL badge, alert badge |
| blush | oxblood | **8.20** | "As written by the guest" |
| ember-ink | paper / bone | **5.09 / 5.45** | `--now-text` on flat surfaces |
| ember-ink | ember-tint / paper-well / paper-2 | **4.74 / 4.77 / 4.55** | "Oldest waiting", QUOTE badge |
| bone | ink / ink-2 / ink-3 | **16.62 / 15.11 / 13.14** | Dark text, Dining tiles, `ตอนนี้`, NEW |
| bone | taupe | **5.75** | — |
| ash | ink / ink-2 / ink-3 | **8.65 / 7.87 / 6.84** | Rail labels, tile minutes, chart axis |
| ash | smoke | **5.88** | Hovered rail label |
| bone | smoke | **11.29** | Hovered rail label (active) |
| ash-2 | ink / ink-2 | **5.18 / 4.71** | Tertiary dark text. **Fails on ink-3 (4.10), so never used there.** |
| ember-light | ink / ink-2 / ink-3 | **6.92 / 6.30 / 5.47** | KHAO YAI · STAFF, "Today · Live · partial" |
| ember-light | ember-night | **5.51** | Dark heat pill |
| sage-light | ink / ink-2 / ink-3 | **9.52 / 8.65 / 7.52** | "▲ 6" comparison, dark ok text |
| sage-light | forest-night | **7.13** | Dark ok pill |
| rose-light | ink / ink-2 / ink-3 | **8.25 / 7.50 / 6.52** | Dark alert text |
| rose-light | oxblood-night | **7.01** | Dark alert pill |
| ember | ink | **4.64** | Allowed as text on ink only (use ember-light elsewhere) |
| ember | ink-2 | 4.22 ✗ | **Never text**, graphic only |
| steel | paper / bone | 2.90 / 3.10 ✗ | **Never text** (leader dots only) |
| taupe | ink | 2.89 ✗ | **Never** (taupe is a light-surface token) |

### 3.6 Contrast: non-text pairs (WCAG 1.4.11, 3:1)

| Graphic | Against | Ratio |
| --- | --- | --- |
| `--edge` #7A7264 | paper / bone / paper-2 / forest-tint / paper-hover | 4.04 / 4.33 / 3.62 / 3.88 / 3.89 |
| ash-2 edge (dark) | ink / ink-2 | 5.18 / 4.71 |
| ember mark and focus ring | paper / bone / ink / ink-2 / ink-3 | 3.35 / 3.58 / 4.64 / 4.22 / 3.67 |
| forest selected edge, secondary border | bone / paper | 10.19 / 9.51 |
| ink framed tag, pressed box | paper | 15.52 |
| steel future chart outline | ink-2 | 4.87 |
| ash-2 prior-week tick | ink-2 | 4.71 |
| taupe prior-week tick (light chart) | paper | 5.36 |
| steel future timeline ring | bone | 3.10 (paired with the step label) |
| steel leader dots | paper | 2.90, **decorative only** (`aria-hidden`) |
| `--rule` hairline | paper | 1.3, **decorative only**, never a control edge |

---

## 4. Typography

### 4.1 Families and stacks

| Token | Stack | Job |
| --- | --- | --- |
| `--font-ui` | `"Noto Sans Thai Variable", "Noto Sans Thai", "Leelawadee UI", Thonburi, "Helvetica Neue", Arial, sans-serif` | Everything people read or tap, in Thai **and** Latin UI |
| `--font-display` | `"Oswald Variable", "Noto Sans Thai Variable", "Noto Sans Thai", "Arial Narrow", sans-serif` | Prices, numbers, codes, table numbers, short Latin caps labels |
| `--font-serif` | `"Cormorant Garamond Variable", "Noto Sans Thai Variable", "Noto Sans Thai", Georgia, "Times New Roman", serif` | Wordmark, English dish and section names (italic), admin page titles (italic) |
| `--font-num` | `= --font-display` | Numerals |

### 4.2 Rules

- **Thai:** `letter-spacing: 0`, never `text-transform`, and line-height ≥ **1.55**, headings included (`--lh-thai-min`). The default for Thai-capable text is 1.6. Thai never wraps inside a line-height below 1.55.
- **Tracking:** only on elements with `lang="en"`. `tokens.css` sets every `--track-*` to 0 under `:lang(th)`.
- **Numerals:** after any `font:` shorthand that renders numbers, declare `font-feature-settings: var(--num-features)` (tabular + lining). The shorthand resets `font-variant-numeric`.
- **The baht sign:** `฿` renders from Noto Sans Thai. Wrap it in `.baht` (0.8em, 600) before an Oswald number: `<span class="baht">฿</span>590`. It is a currency sign, not Thai text, so the Thai line-height rule does not apply to it.
- **Cormorant is identity only.** Prices are never Cormorant, and Thai never is either.
- **Oswald is never used for a dish name**, in any language. There are no giant condensed caps for dishes or data values.
- **Minimums:**
  - Guest: 13px.
  - Staff: 12px, for Latin caps labels only (TABLE, column heads, table-head cells); every sentence is 13px or more.
  - Inputs: 16px.
  - The only exemption is the KHAO YAI logotype (12px, `aria-hidden`, inside a labelled link).

### 4.3 Named styles (tokens)

Use a style as `font: var(--type-…)`.

**Thai (guest and staff)**

| Token | Size / line-height / weight | Where |
| --- | --- | --- |
| `--type-page-th` | 26 / 1.55 / 600 | Page title (ติดตามอาหาร) |
| `--type-state-th` | 26 / 1.55 / 600 | Round state headline (กำลังปรุง) |
| `--type-section-th` | 24 / 1.55 / 600 | Menu section title (เนื้อ) |
| `--type-sheet-th` | 24 / 1.55 / 600 | Sheet dish title |
| `--type-title-th` | 18 / 1.6 / 600 | Card titles (รอบที่ 2), sheet headers |
| `--type-dish-th` | 17 / 1.6 / 600 | Dish name in a row. It wraps and is never truncated. |
| `--type-step-th` | 16 / 1.6 / 600 | Timeline step (current step 17 / 700; future steps 500 in `--text-3`) |
| `--type-body-th` | 16 / 1.6 / 400 | Body, inputs, option labels |
| `--type-control-th` | 15 / 1.55 / 600 | Buttons, tabs, list-row titles |
| `--type-support-th` | 14 / 1.6 / 400 | Explanations, notices |
| `--type-meta-th` | 13 / 1.6 / 400 | Meta, helper, units |
| `--type-nav-th` | 13 / 1.55 / 500 | Bottom-nav labels (never wrap) |
| `--type-ticket-th` | 15 / 1.55 / 600 | Dish name on a staff ticket |
| `--type-allergy-th` | 16 / 1.55 / 700 | Guest allergy words on the ticket band |

**Latin**

| Token | Face / size / line-height / weight | Where |
| --- | --- | --- |
| `--type-wordmark` | Cormorant 16 / 1 / 600, caps, +0.18em | Guest masthead (rail 17) |
| `--type-lockup` | Oswald 12 / 1 / 500, caps, +0.34em | KHAO YAI under the wordmark |
| `--type-en-dish` | Cormorant *italic* 17 / 1.25 / 500 | English dish name in a row (15 in rankings, 16 in lists) |
| `--type-en-sheet` | Cormorant *italic* 22 / 1.2 / 500 | English name in the sheet |
| `--type-en-section` | Cormorant *italic* 20 / 1.2 / 500 | English section title, page subtitle |
| `--type-admin-title` | Cormorant *italic* 32 / 1 / 600 | Orders, Tables, Insights (Menu Stats heading 28) |
| `--type-cap` | Oswald 12 / 1.3 / 500, caps, +0.14em | Staff labels, table-head cells |
| `--type-cap-lg` | Oswald 14 / 1.2 / 600, caps, +0.14em | Board column heads, drawer section heads |
| `--type-kicker` | Oswald 13 / 1.2 / 500, caps, +0.14em | `No. 01` |
| `--type-price` | Oswald 20 / 1 / 500 | Row price (cart and bill 20–24) |
| `--type-price-lg` | Oswald 26 / 1 / 500 | Sheet price |
| `--type-num-sm` | Oswald 16 / 1 / 500 | References, times in lists |
| `--type-num-md` | Oswald 24 / 1 / 500 | Guest round reference, staff wait minutes |
| `--type-num-lg` | Oswald 32 / 1 / 500 | Ticket table numeral, stat values (40) |
| `--type-num-xl` | Oswald 48 / 1 / 500 | Headline metric (72 in the chart panel) |
| `--type-ui` | Noto 15 / 1.45 / 400 | Admin body |
| `--type-ui-strong` | Noto 15 / 1.45 / 600 | Admin emphasis |
| `--type-ui-sm` | Noto 13 / 1.45 / 400 | Admin secondary |

---

## 5. Space, shape, rules, elevation, focus

- **Spacing** uses a 4px base: `--space-1…16` = 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64.
  - Gutter: 16 on phones (12 below 360px), 24 on tablets, 32 on desktop.
  - DishRow padding 20. Plate-to-text gap 12, plus the 4px mat.
  - Sheet blocks are 24 apart. Menu sections are 40 apart (48 on tablet and up).
  - Admin page padding is 20. Board gap is 10. Ticket padding is 10.
- **Hit areas:** `--tap` 44 (guest minimum), `--tap-staff` 48. Control heights: 44 (guest), 52 (sheet footer, Send order, Track pair), 48 (staff). Option rows are 52. A control that looks smaller extends its hit area with an absolutely positioned `::after`; segmented buttons use this.
- **Radii:**

  | Token | Size | Used for |
  | --- | --- | --- |
  | `--radius-hair` | 2 | Plates, table tag, language box, table tiles |
  | `--radius-sm` | 4 | Tags, flags, tickets, chips |
  | `--radius-ctl` | 6 | Buttons, inputs, steppers, segmented control |
  | `--radius-card` | 8 | Cards, board columns, stat cards |
  | `--radius-slip` | 10 | Order slip |
  | `--radius-sheet` | 16 | Sheet top corners, dialogs |
  | `--radius-pill` | full | **Status pills and count badges only** |

- **Rules:**
  - **Masthead double rule** (`--rule-double`): 1px ink, then a 3px canvas gap, then 1px ink at 26%, drawn as three box-shadows.
  - **Section head:** a hairline after the `No. 01` kicker, and a **1px ink rule** above the first dish of the section (the printed-menu rule).
  - **Rows:** hairline (`--rule`).
  - **Perforation** (`--border-perf`): 1px dashed ink at 26%, with two punched 13px notches on guest round cards, and a vertical version on the order slip. It is never used on staff screens.
  - **Leader:** see §9.
- **Elevation.** The system is flat and structured by rules. There are five shadows:
  - `--shadow-lift`: 1px, on pressed segments.
  - `--shadow-card`: guest cards and tickets.
  - `--shadow-float`: the order slip.
  - `--shadow-sheet`: sheets.
  - `--shadow-drawer`: the table drawer.
  - (Toasts use `--shadow-toast`.)
  - A new ticket gets a 2px ink outline, never a glow.
- **Focus:**
  - `outline: 2px solid var(--focus); outline-offset: 2px` on every focusable element. `--focus-ring` provides a box-shadow equivalent for elements that clip overflow.
  - A stretched row link draws its ring on the `::after` overlay (inset −2px).
  - Dialogs do not ring themselves; focus moves to the first control inside.
  - The ember ring measures 3.35 on paper, 3.58 on bone and 4.64 on ink.

---

## 6. Iconography

- Inline SVG `<symbol>` sprite on a 24-unit grid (`sprite.js` in the mocks; `ui/Icon.tsx` in the build).
- `fill: none; stroke: currentColor; stroke-width: 1.5` (2 for plus, minus and check inside controls), round caps and joins.
- Sizes are `--icon-xs` 14, `--icon-sm` 16, `--icon-md` 20 (default) and `--icon-lg` 24 (bottom nav, close).
- **Every essential icon sits beside a word.** Icon-only buttons (close, stepper ±, ticket `⋯`, previous/next, stat definition) carry an `aria-label`. `⋯` is never the only route to a normal action.
- Decorative icons get `aria-hidden="true"`.

| id | Meaning | | id | Meaning |
| --- | --- | --- | --- | --- |
| `i-book` | Menu | | `i-orders` | Orders (admin) |
| `i-pad` | Your order (not a shopping bag) | | `i-tables` | Tables |
| `i-track` | Track | | `i-cutlery` | Menu (admin) |
| `i-bell` | Service / call staff | | `i-bars` | Insights |
| `i-receipt` | Bill, checking out | | `i-more` | More, ticket details |
| `i-hand` | In-person fallback | | `i-search` | Search |
| `i-list` | All categories | | `i-scale` | Priced by weight |
| `i-plus` / `i-minus` | Add / remove | | `i-check` / `i-check-c` | Done, served / all served |
| `i-pan` | Preparing (never a flame) | | `i-half` | In progress (half-filled disc) |
| `i-cloche` | Ready | | `i-slash` | Sold out, rejected, cancelled |
| `i-alert` | Allergy, blocked | | `i-clock` | Wait time |
| `i-note` | Guest note | | `i-glass` | Alcohol flag |
| `i-info` | Definition, honest note | | `i-sound` | Alert sound |
| `i-lock` | Lock screen, disabled table | | `i-key` | Show PIN |
| `i-refresh` | Rotate PIN, retry | | `i-seat` | Seat guests |
| `i-qr` | QR codes | | `i-download` | Export |
| `i-calendar` | Date picker | | `i-table-view` | Chart as table |
| `i-wifi-off` | Offline | | `i-sort` / `i-filter` | Sort / filter |
| `i-chev-l/r/d` | Navigation, disclosure | | `i-arrow-r` | Forward link |
| `i-pause` | Pause ordering | | `i-x` | Close |
| `i-user` | Staff identity fallback | | | |

---

## 7. Motion (brief §42)

| Token | Value | Use |
| --- | --- | --- |
| `--ease-out` | `cubic-bezier(.2,.7,.3,1)` | Things arriving |
| `--ease-in-out` | `cubic-bezier(.4,0,.2,1)` | Things moving while visible (ember mark, segmented thumb) |
| `--ease-sheet` | `cubic-bezier(.32,.72,0,1)` | Sheet and drawer |
| `--dur-press` | 120ms | Press scale to `--press-scale` (0.97) |
| `--dur-fast` | 160ms | Colour, hover, radio fill, initial render |
| `--dur-base` | 200ms | Ember-mark glide, segmented thumb, language cross-fade |
| `--dur-step` | 220ms | Tracking step emphasis, new-ticket outline |
| `--dur-sheet` | 240ms | Sheet rise (`--sheet-travel` 24px) plus scrim fade |
| `--dur-tile` | 180ms | Table tile state crossfade |
| `--dur-chart` | 220ms | Bar height between real values |
| `--dur-toast` | 200ms | Toast fade |
| `--dur-confirm` | 1200ms | How long `เพิ่มแล้ว ✓` stays on a button (a hold, not an animation) |
| `--rise` | 4px | Maximum travel on first render |

| Interaction | Treatment | Guardrail |
| --- | --- | --- |
| Initial menu render | First visible content fades in over 160ms and rises ≤ 4px | Never per row on scroll; never gates access |
| Category change | Ember mark glides 200ms | Native scrolling; the IntersectionObserver only *updates* the current tab and never reveals content |
| Add to order | Button label shows `เพิ่มแล้ว ✓` for 1.2s, badge count changes, polite toast | Only after the draft mutation succeeds; nothing flies across the screen |
| Sheet | 240ms rise plus scrim | Back or Escape closes it; focus returns to the trigger; the footer stays above the keyboard (`dvh`) |
| Tracking update | The new current node's ring scales 0.8 → 1 once (220ms) | Only on a committed staff event. Reconnect or catch-up sets state without animating. |
| New staff ticket | 2px ink outline appears (220ms) and stays until accepted | No pulse, no flashing, no forced scroll |
| Table reset | 180ms tile crossfade | The state is authoritative before the animation |
| Chart period | Bars transition height in 220ms | Axis fixed; no rolling counters or invented in-between values |
| Ranking refresh | 160ms crossfade on explicit refresh or filter | Rows never move under a finger |
| Language switch | 160ms opacity on text only | State, sheet and scroll are preserved |

**Reduced motion** (`prefers-reduced-motion: reduce` or `[data-motion="reduce"]`):

- Every `--dur-*` becomes 1ms, and `--rise`, `--sheet-travel` and the press scale become neutral.
- Keyframes run once in 1ms.
- The ember mark snaps into place, and sheets appear where they end up.

---

## 8. Layout

### 8.1 Guest

**Phone** (< 720px, designed at 390 and checked at 320). From top to bottom:

1. **Masthead**, sticky, 60px plus the 5px double rule:
   - Grid `1fr auto 1fr`.
   - Framed table tag on the left, wordmark in the centre, language box on the right.
   - Safe-area top padding.
2. **Tool row**, which scrolls away: search `1fr` beside the Food/Drinks segmented control.
3. **Category row**, sticky at `header + 5px`, 52px high:
   - Fixed `ทุกหมวด` button on the left.
   - Horizontally scrolling tabs with a 36px fade on the right edge.
   - One ember mark.
4. **Menu list:**
   - One column.
   - DishRow = plate `--thumb-w` (`clamp(96px, 28vw, 112px)`, 109 at 390) plus the 4px mat, then the text column.
   - `scroll-margin-top` = header + category row + 8.
5. **Dock**, fixed:
   - Order slip (60px, only when the draft has items) 8px above the nav bar.
   - Nav bar: three destinations plus the 88px service key, with the safe-area inset.
   - `main` reserves `--dock-clearance`, so the last row clears the dock.

On Track and Your order there is no category row. On Track the order slip is replaced by the nudge card.

**Tablet** (720–1079):

- Same chrome.
- The dish list becomes two columns (gap 32, plate 128). The first two rows sit under the ink rule.
- The order slip is capped at 560px and centred.

**Desktop** (≥ 1080). Three columns, `--guest-side-w 232 | 1fr | --guest-cart-w 340`, gap 40, max width 1440:

- **Masthead:** wordmark and table tag on the left, three destination tabs in the centre (ember underline on the current one), a labelled `บริการ` button and the language box on the right.
- **Left:** sticky Food/Drinks segmented control and a category sidebar (numeral + Thai name; the current one has a 3px ember bar).
- **Centre:** search, then one printed-menu column with plate 156. Leaders run long here, as on a real menu.
- **Right:** a sticky "รายการของฉัน · ร่างในเครื่องนี้" panel with the lines, the subtotal, `ยังไม่ได้ส่งเข้าครัว`, and **Send order**.
- There is no bottom dock.

The sheet becomes a centred dialog (`--sheet-max-w` 560) on tablet and desktop.

### 8.2 Admin

**Desktop** (≥ 1200):

- **Charcoal rail** (`--rail-w` 208, `data-surface="dark"`, sticky full height):
  - Wordmark with an ember-light "KHAO YAI · STAFF".
  - Five destinations at 48px each: **Orders, Tables, Menu, Insights, More**.
  - Foot: alerts toggle and Test, Lock screen, language box, date and time zone.
- **Workspace header** (68px, sticky):
  - Cormorant italic page title.
  - Underline subtabs.
  - "Demo data" tag when fixtures are loaded.
  - On the right: connection pill, guest-ordering state with `Pause…`, and staff identity.
- **Content:** 20px padding. The board uses five columns (`minmax(216px, 1fr)`), which fit from 1280px wide. The table grid is `auto-fill minmax(164px, 1fr)` with a 480px drawer beside it.

**Tablet** (768–1199):

- The rail compacts to 84px: a 22px icon over a 12px label. The labels stay visible.
- The board shows **one status column at a time**, chosen with a segmented control (New · Accepted · Preparing · Almost done · Ready, each with a count), and a two-column ticket grid. It never scrolls sideways.
- The table drawer overlays from the right at 480px with a scrim.

**Phone** (< 768):

- The rail becomes a bottom bar with the **same five groups** (icon + 12px label, badges).
- The header shrinks to title + connection dot + identity menu.
- Orders becomes a filtered list: a status segmented control and a full-width ticket stack.
- Tables becomes a two-column tile grid; the drawer becomes a full-height sheet.
- Insights stacks the headline, the chart (horizontal scroll disabled; bars shrink to 7 × 28px) and the table view.
- Every action on a phone is still one tap from its card.

### 8.3 Stacking

| Token | Value |
| --- | --- |
| `--z-sticky` | 20 (header, category row one lower) |
| `--z-dock` | 30 |
| `--z-drawer` | 40 |
| `--z-sheet` | 50 |
| `--z-toast` | 60 |
| `--z-skip` | 70 |

Native `<dialog>.showModal()` uses the top layer, so these values matter only for non-modal pieces.

---

## 9. Signature detail: the leader line, and one ember mark

**The leader.** On the restaurant's printed menu, a dotted leader joins a dish to its price. Here the leader joins **a label to its value**, and appears nowhere else:

| Where | Label ··· value |
| --- | --- |
| DishRow | `เนื้อสันนอกออสเตรเลีย ··· ฿590` · `ไพร์มริบ ··· ฿490 ต่อ 100 กรัม` |
| Sheet | `ราคา ··· ฿590` |
| Timeline | `ร้านยืนยันออเดอร์แล้ว ··· 19:43` · `กำลังปรุง ··· [ตอนนี้]` |
| Per-dish status | `กำลังปรุง ··· เริ่ม 19:46` · `เสิร์ฟแล้ว ··· 19:49` |
| Portion quote | `พนักงานชั่งแล้ว ··· 420 กรัม` · `ยอดของจานนี้ ··· ฿2,058` |
| Running bill, cart panel | `ค่าอาหารที่ส่งแล้ว · 2 รอบ ··· ฿3,630` |

Rules:

- **No value, no leader.** Future steps have no time, so they get no dots. There are no leaders on radio rows, buttons or any staff screen.
- The row is `display:flex; align-items:first baseline; gap:5px`. The name is a flex item, and its button is `inline-flex`, so the *first* line is its baseline. The dots are `flex: 1 1 12px; min-width: 12px`, and the value does not wrap. Long Thai names wrap, while the price stays on line one.
- The dots are a `radial-gradient` of 0.8px circles in `--leader` at a 5px pitch, 2px tall, raised 3px. They need no glyph or font support, carry `aria-hidden="true"`, and screen readers hear the label and value only.

**The ember mark.** Ember (`--now`) is the one warm accent in the interface. It marks **what is current**, and only as a flat bar or dot:

- A 2px bar under the current category tab: **one element that glides** 200ms (`transform` + `width`) and snaps under reduced motion.
- A 3px bar on the top edge of the current bottom-nav destination, gliding the same way.
- A 3px bar on the current rail item and on the current desktop sidebar category.
- A short underline (28 × 2) under the Track state headline.
- The dot inside the current timeline node, and the half-disc icon on cooking lines.
- The 3px **copper rail** over the Ready column ("at the pass"), which is food under the lamp, drawn flat.
- Today's bar in charts (a 3px top edge and a 1.5px outline) with the `Live · partial` label.
- The focus ring and the selected table tile outline.

Why it helps and never hurts: every place it marks also changes weight, shape or words (600 text, `aria-current`, `ตอนนี้`, "Live · partial"). Removing every ember mark would lose no information.

---

## 10. Components

Each entry gives anatomy, sizes, states, tokens and accessibility. Class names refer to `design-lab/final/final.css`. Names in **bold** are the React exports expected from `client/src/ui/index.ts`.

### 10.1 **Button**

- **Anatomy:** `[icon?] label [· count | · ฿price]`, inline-flex, gap 8.
- **Variants:**
  - `primary`: forest fill, bone text. Hover forest-2.
  - `secondary`: bone fill, 1.5px forest border, forest label. Hover `--selected`. Used for Add, `ขอให้พนักงานชั่ง` and confirm-portion alternatives.
  - `outline`: bone fill, `--edge` border, ink label. Hover `--hover`. Used for service pairs, Almost done, filters and Details.
  - `ghost`: no border. Hover `--hover`. Used for toasts, Assist order and Open Tables.
  - `danger`: bone fill, oxblood border and label. Used for "Revoke access…". `danger-solid` is used only inside the confirmation dialog.
- **Sizes:** `md` 44 (guest default), `lg` 52 (sheet footer, Send order, Track pair, quote actions), `staff` 48. Padding is 16 (lg 20, ticket 10).
- **States:**
  - hover, pressed (scale 0.97, 120ms), focus ring.
  - `disabled` / `aria-disabled`: `--sunken` fill, `--text-2`, not-allowed cursor. `aria-disabled` keeps the button focusable so its reason can be read (Complete checkout).
  - `loading`: the label turns transparent and a spinner shows. `aria-busy="true"`, the width is kept, a double submit is ignored.
  - `confirmed`: the label shows `เพิ่มแล้ว ✓` for 1.2s.
- **Counts and prices:** Oswald inside the label (`Accept · 5`, `เพิ่มในรายการ · ฿590`). Price uses `.btn__price`.
- **Tokens:** `--action*`, `--edge`, `--radius-ctl`, `--type-control-th`, `--control-h*`.
- **Accessibility:**
  - The accessible name includes the dish name ("เพิ่ม ซี่โครงหมูย่าง").
  - Actions that open dialogs get `aria-haspopup="dialog"`.
  - Destructive or exception actions always open a confirmation that asks for a reason, and are never placed beside the primary action.

### 10.2 **IconButton**

- 44×44 (staff 48×48), `--radius-ctl`.
- **Variants:** plain; `framed` (bone + `--edge`), used for ticket `⋯` and previous/next; `round` (bone + card shadow), used for close over a photo.
- An `aria-label` is required.
- A visual size below 44 (for example the 32px stat definition "i") must extend its hit area to 44 with `::after`.

### 10.3 **SegmentedControl**

- **Anatomy:** a group (`role="group"` with `aria-label`) of `<button aria-pressed>`.
- **`tone="paper"`** (Food/Drinks, admin Week/Month/Year, board status on tablet):
  - `--sunken` track, 3px padding.
  - The pressed segment has a bone fill, a 1px `--edge` border, lift shadow, ink 600 text.
  - Unpressed segments are `--text-2` 500.
  - Segments are 38px visible with a 44px hit area (staff 42/48).
  - The thumb transitions background over 200ms.
- **`tone="box"`** (language, reference-site framed square):
  - 1px ink border, `--radius-hair`, 44×44 segments.
  - The pressed segment is `--inverse` fill with `--on-inverse` text.
  - `ไทย` uses Noto 15/600; `EN` uses Oswald 13 caps, tracked, `lang="en"`.
  - Below 360px it collapses to one button naming the *other* language.
- Pressed state is carried by fill, weight **and** `aria-pressed`. Language switching preserves all state (§0.2).

### 10.4 **CategoryRow** and **AllCategoriesSheet**

- **Row:**
  - Sticky, 52px, canvas background, hairline below.
  - `ทุกหมวด` button (list icon + label, right hairline) fixed on the left.
  - A `nav` with a horizontal scroller (no visible scrollbar, 36px right fade).
  - Tabs: Oswald 13 numeral in `--text-3` + Thai 15 in `--text-2` 500. The current tab is ink 600 with `aria-current="true"`.
  - One `.mark` element glides under the current label.
  - Numerals are display positions of the *published* categories (Seasonal hidden → Rice becomes 05) and are `aria-hidden`.
- **Behaviour:**
  - Selecting a tab scrolls to the section, allowing for the sticky offset.
  - The current tab updates as sections enter view, and scrolls itself into view.
  - Each group keeps its own scroll position.
- **Sheet** (dialog, title `ทุกหมวด`):
  - A group label (Thai 15/600 + hairline), then 60px rows: numeral 14, Thai title 16/600, English italic 16, item count.
  - The current row has a 3px ember bar at the gutter edge and `aria-current`.
  - Food and Drinks both appear. Selecting a row switches group if needed, scrolls and closes the sheet.
  - Unpublished categories (Seasonal until confirmed) and categories with no published items are hidden.

### 10.5 **SearchField**

- 44px (staff 48): bone fill, `--edge` border, `--radius-ctl`, 20px search icon at 12px, 16px text, `--text-2` placeholder (`ค้นหาเมนู`).
- There is a visually hidden label that states the scope ("ค้นหาเมนู ไทย หรือ English").
- A 44px clear button appears when there is a value.
- **Results** replace the list with one flat list of DishRows. Each row carries a category meta line ("เนื้อ · Beef Selection"), and a `role="status"` count reads "พบ 3 รายการ".
- **Empty result:** EmptyState "ไม่พบเมนูที่ตรงกับ ‘…’" with Clear search. It never implies ingredient search.
- **Normalisation:** trim and collapse whitespace, case-fold Latin, and never alter Thai.

### 10.6 **DishRow**

- **Anatomy:**
  ```
  [plate 4:3, mat 3px + hairline]  [kicker?]
                                   name ········· ฿price [unit?]
                                   English italic (full width)
                                   unit / note?
                                   [state?]              [action]
  ```
  - Grid `calc(--thumb-w + 8px) 1fr`, gap 12, padding 20 top and bottom.
  - Hairline between rows. The first row of a section has a 1px ink rule.
- **Whole-row target:** the name is a `button.dish__open` whose `::after` covers the row, so tapping the photo, name or blank space opens the sheet. Controls in the foot sit above it (`z-index: 1`). Hover shows a soft `--hover` band.
- **Variants:**
  - **photo:** as above. The image has explicit width and height, `loading="lazy"` below the fold, and `alt=""` (the name is adjacent).
  - **text-led** (no approved photo, or the image failed): a single column; the English italic moves into the foot, left of the action. Never a broken-image icon or a stand-in photo.
  - **in draft, simple dish:** the foot shows `✓ ในรายการ` (forest, 13/600) and an inline **Stepper**.
  - **in draft, dish with choices:** `✓ ในรายการ 1` and a secondary `+ เพิ่ม`, which opens the sheet for another configuration.
  - **sold out:**
    - Greyscale plate at 62% opacity. Name and price turn `--text-2` (never struck).
    - The action slot shows `⊘ หมดชั่วคราว` as plain oxblood 14/600 text.
    - The row does not open the sheet, and screen readers hear "หมดชั่วคราว".
    - Whether sold-out dishes show at all follows the owner setting.
  - **by weight** (`pricing_type = measured_weight`):
    - Kicker `⚖ ราคาตามน้ำหนัก` in `--text-3`.
    - The value reads `฿490` with `ต่อ 100 กรัม` (meta) stacked under it, right-aligned (`.lead__val--unit`). It is never bare, and the price column stays aligned.
    - Note: `พนักงานจะชั่งและแจ้งยอดให้ยืนยันก่อนเริ่มย่าง`.
    - Action: secondary `⚖ ขอให้พนักงานชั่ง`, which opens the PortionRequest sheet.
    - There is never an Add button or a preset portion.
  - **price pending, not orderable:** the value reads `รอยืนยันราคา` in `--text-2`, with no action.
  - **verified unit** (Wagyu `300 กรัม`): a meta line under the English name.
- **Tokens:** `--thumb-w`, `--row-pad`, `--row-gap`, `--plate-frame`, `--type-dish-th`, `--type-en-dish`, `--type-price`.
- **Accessibility:** `<article aria-labelledby=name>`. The Add button's name includes the dish. Badges are sparse and evidence-based, and never compete with the action.

### 10.7 **Sheet** and **Dialog** (native `<dialog>`)

- **Sheet** (phone): `dialog.sheet` opened with `showModal()`.
  - Bottom-anchored, full width, max height `100dvh − 48px`, `--radius-sheet` top corners, `--shadow-sheet`, `::backdrop` = `--scrim`.
  - Parts: grabber (40×4) → head (kicker or title + 44px close) → scrolling body (`overscroll-behavior: contain`) → sticky footer with a top hairline and safe-area padding.
  - It rises 24px over 240ms.
- **Dialog** (tablet and desktop, and confirmations on every size): centred, `--dialog-max-w` 480 (item details 560), the same parts without the grabber.
- **Behaviour:**
  - Escape and browser Back close it (push a history entry on open).
  - Focus moves to the first control. The rest of the page is `inert`, and focus returns to the trigger on close.
  - The dialog itself never shows a focus ring.
  - Only one sheet is open at a time, and sheets never nest. A confirmation *replaces* a sheet's footer area instead of stacking a second dialog on top.
- **Item sheet content, in order:**
  1. Wide plate (16:9).
  2. Thai title (`--type-sheet-th`).
  3. English italic (`--type-en-sheet`).
  4. Price leader with an ink rule above.
  5. Choice groups.
  6. Note field.
  7. AllergyNotice.
  8. Footer: Stepper (plain, lg) + primary `เพิ่มในรายการ · ฿total`.
- **Choice group** (`fieldset` / `legend`):
  - Head: legend (18/600) + optional `ตัวอย่าง` tag, with a **required pill** on the right. The pill is ink `จำเป็น` and becomes ok-tint + forest `✓ เลือกแล้ว` once the group is satisfied.
  - A rule line such as `จำเป็น · เลือก 1 อย่าง` or `เลือกได้สูงสุด 2`.
  - Option rows: 52px, bone, `--rule-strong` border, a 22px radio ring in `--edge`, label 16, price effect on the right (`รวมในราคา` or `+฿40`, no leader).
  - Selected row: `--selected` fill + forest border + 1px inset forest + label 600.
  - Unavailable option: `--text-2` + `หมด`, disabled.
  - A missing required choice shows an inline oxblood error with an icon, focus moves to the legend, and the footer button says `เลือกระดับความสุกก่อน`.

### 10.8 **Stepper**

- **Default** (in-order): `--selected` fill, 1.5px forest border, two 44×44 buttons (forest ±, 2px stroke) around an Oswald 18 `output`.
- **Plain** (sheet footer): bone fill + `--edge` border, 52px.
- At the minimum, `−` becomes "remove": on a DishRow, going from 1 to 0 removes the line and shows an undo toast. In the sheet, `−` is disabled at 1.
- At the maximum, `+` is disabled and a polite status announces the limit.
- **Accessibility:** `role="group"` labelled with the dish; buttons "ลด 1" / "เพิ่ม 1"; `output aria-live="polite"`.

### 10.9 **TextArea** with counter

- Label row: 17/600 label + `ไม่บังคับ` meta.
- Box: bone, `--edge`, `--radius-ctl`, min height 96, 16px text, 30px bottom padding for the counter.
- Counter: Oswald 13 `14 / 120`, bottom-right, `aria-live="polite"` announced at 100 / 110 / 120.
- Helper: `เป็นคำขอถึงร้าน พนักงานจะยืนยันอีกครั้ง`.
- The limit is 120 characters and is enforced. Notes are stored exactly as typed.
- The error state uses an oxblood border and a message below.

### 10.10 **Badge**, **StatusPill**, **Tag**, **Flag**

- **Badge** (counts):
  - 20px pill, Oswald 13/600.
  - Default is `--inverse`; `alert` is oxblood/bone (Requests); `ember` is ember/ink (rail "new").
  - `ring` adds a 2px surface ring when it overlaps an icon.
  - Its accessible text sits beside it ("2 รายการ").
- **StatusPill** (state):
  - 30px (26 in drawers), icon 16 + word, 13/600.
  - Tones: `ok` (served, all served, live), `neutral` (preparing, sent, accepted), `alert` (rejected, cancelled), `heat` (awaiting guest, partly cancelled), `line` (open or not requested).
  - `live` adds a leading 8px dot.
- **Tag** (small labels, 22px, `--radius-sm`):
  - `ink` (verified variant: `500 ml`, `Iced`).
  - `line`.
  - **`example`**: dashed `--edge`, `--text-2`, reading `ตัวอย่าง` / `Example`. **Mandatory** on any placeholder configuration shown in UI, seed data or mocks.
  - `ok`, `alert`, `heat`, `neutral`.
- **Flag** (staff ticket, 24px):
  - `oldest` (heat, clock, "Oldest waiting").
  - `late` (alert, triangle, "Longer than usual · over 20 min"; the threshold is an owner setting).
  - `just` (ink, "Just in").
  - `ready` (ok, cloche, "Waiting to be served").
  - `station` (outline caps, BAR / KITCHEN).
- **Never colour-only.** Every pill and flag has a word, and most have an icon.

### 10.11 **CartBar** (the order slip)

- Fixed in the dock, 60px, 8px above the nav, side margins of gutter − 4, `--radius-slip`, forest fill, `--shadow-float`. Capped at 560px from tablet up.
- **Anatomy:**
  - Left: `2 รายการ · ฿1,180` (16/600, Oswald 20 price) over the sub-line **`ยังไม่ได้ส่งเข้าครัว`** (13, sage).
  - A vertical perforation (dashed bone 45%) with two punched 11px notches.
  - Right: `ดูรายการ ›`.
- The whole slip is one link, labelled "2 รายการ ฿1,180 ยังไม่ได้ส่งเข้าครัว ดูรายการ". It appears only when the draft has lines, and changes count with a 160ms fade.
- **States:**
  - `sending`: sub-line `กำลังส่ง…`.
  - `review needed` (price or availability changed): the sub-line becomes `มีรายการต้องตรวจสอบ` with an alert icon, still on forest.
- It never covers the nav, and `main` reserves `--dock-clearance`.

### 10.12 **BottomNav** (3 destinations + badge) and **ServiceKey**

- **Bar:**
  - Bone, 1px `--rule-strong` top rule, safe-area bottom padding.
  - Grid `repeat(3,1fr)` + an 88px ServiceKey column.
  - Destinations: **เมนู** (book), **รายการของฉัน** (pad + count badge), **ติดตาม** (track).
  - Each item is 64px: a 24px icon over a 13px label that never wraps.
  - The current item is ink 600 with `aria-current="page"`; the others are `--text-2`.
  - One ember mark (3 × 32px) glides along the top edge.
- **ServiceKey:**
  - Sits in the same bar with a left hairline, but is **not a destination**: a `<button aria-haspopup="dialog">` outside the `nav` list, never shown as current.
  - A 30px ring (`--edge`) around a bell, over the label **บริการ** (13/600).
  - It opens the ServiceMenu.
  - On desktop it becomes a labelled outline button in the masthead.
- The table tag in the masthead is a label (`aria-label="โต๊ะ 07"`), not a second service route.

### 10.13 **ServiceMenu** (sheet)

- Title `บริการที่โต๊ะ 07`. Rows are 60px: a 40px ringed icon, title (16/600) with a meta sub-line, and a trailing chevron or status pill.
- Only services the restaurant has enabled appear. V1 defaults: **เรียกพนักงาน**, **ขอเช็กบิล**, **ดูบิลของโต๊ะ**. Water and utensils appear only if the owner enables them.
- **Request states:**
  - `ส่งแล้ว 19:52 · รอพนักงานรับทราบ` (neutral pill **ส่งแล้ว**). The row is disabled for that type until the request is acknowledged or completed.
  - `พนักงานรับทราบแล้ว` (ok pill).
  - `เสร็จแล้ว` returns the row to normal.
- **Bill row:** the sub-line reads `ค่าอาหารที่ส่งแล้ว ฿3,630 · ยังไม่ใช่ยอดสุดท้าย`.
- **Fallback:** a sunken note with a hand icon, `ถ้าส่งคำขอไม่ได้ โบกมือเรียกพนักงานที่อยู่ใกล้ได้เลย`. It becomes the only content when the device is offline.

### 10.14 **Timeline** (parcel tracking)

- **Round card:**
  - Head: `รอบที่ 2` (18/600) and meta `ส่งเมื่อ 19:42 · 4 รายการ · โต๊ะ 07` on the left; `เลขอ้างอิง` over the Oswald 24 ref on the right.
  - Perforation.
  - **State block:** `กำลังปรุง` (26/600) with a 28×2 ember underline, and a one-line honest explanation. The block is a polite live region.
- **Steps** (`<ol>`): a 28px node column + a label ··· value leader. Connectors are 2px.
  - **done:** forest disc with a bone check, solid forest connector, label 16/600 ··· actual time (Oswald 17).
  - **current:** bone disc with a 2px ink ring and a 10px ember dot. Label 17/700 ··· `ตอนนี้` ink tag. Sub-line: `เริ่ม 19:46 · เสิร์ฟแล้ว 1 จาน · กำลังปรุง 2 จาน`. The connector below is dotted `--leader`. `aria-current="step"`.
  - **upcoming:** 12px steel ring, label 16/500 in `--text-3`, **no leader and no time**, dotted connector.
  - **not recorded** (an optional Almost done that was skipped): a dashed `--edge` ring, label in `--text-2`, value `ไม่ได้บันทึก`, and the connector stays solid.
  - **cancelled or rejected:** never on the forward rail. It appears on the dish line (below).
- **Foot note** (sunken, info icon): `สถานะเปลี่ยนเมื่อครัวบันทึกจริงเท่านั้น ระบบไม่เดาเวลา`.
- **Dishes** (`<details open>`):
  - Summary: `รายจาน · เสิร์ฟแล้ว 1 · กำลังปรุง 2 · ยกเลิก 1`.
  - Each line: a 64px plate, `name × qty`, and a status leader (`◐ กำลังปรุง ··· เริ่ม 19:46`, `✓ เสิร์ฟแล้ว ··· 19:49`).
  - A 4px six-segment trail (`aria-hidden`): ink for done, ember for now, empty for future, dotted for not recorded.
  - A skipped step is spelled out: `ขั้นใกล้เสร็จ: ไม่ได้บันทึก`.
  - **Cancelled line:** alert-tint row, greyscale plate, `⊘ ร้านยกเลิก ··· 19:45`, and `เหตุผล: … · ไม่คิดในบิล`.
  - Rounds with more than 6 lines show the summary and the first 3 lines, then "ดูทั้งหมด".
- **Past round:** `<details class="card past">` with the summary `✓ เสิร์ฟครบทุกจาน 19:31`, the meta line `รอบที่ 1 · RG-3H2M · ส่งเมื่อ 19:08 · 3 รายการ`, overlapping 36px thumbnails with `+N`, and a chevron.
- **Stale connection:** the offline Banner above the page ("สถานะด้านล่างอาจไม่ใช่ล่าสุด" + เรียกพนักงาน), and the live pill becomes a heat pill `ข้อมูลเมื่อ 19:52 · ยังไม่อัปเดต`. Nothing animates while disconnected.
- **Track page order:**
  1. Page head (kicker, title + italic "Track", live pill, shared-status line).
  2. Call staff / Request bill pair.
  3. Portion quotes awaiting the guest.
  4. Current round.
  5. Past rounds.
  6. Draft nudge.
  7. Running subtotal (`ค่าอาหารที่ส่งแล้ว · 2 รอบ ··· ฿3,630`) + `ไม่รวมรายการที่ร้านยกเลิกและไพร์มริบที่รอยืนยัน ยอดสุดท้ายพนักงานจะยืนยันในบิล` + `ดูบิลของโต๊ะ ›`.

### 10.15 **PortionQuote** (brief 44A)

- A card with a 3px forest left edge.
- Kicker `⚖ รอคุณยืนยันปริมาณ`, then dish Thai + English italic.
- Leaders: `พนักงานชั่งแล้ว ··· 420 กรัม`, `ราคาต่อ 100 กรัม ··· ฿490`, **`ยอดของจานนี้ ··· ฿2,058`** (Oswald 22).
- Honest line: `ยังไม่เริ่มย่างจนกว่าคุณจะยืนยัน · ใบเสนอนี้ใช้ได้ถึง 20:05`.
- Actions: primary `ยืนยันปริมาณนี้` (lg) and outline `ขอเปลี่ยน`.
- **States:**
  - `requested` (`รอพนักงานชั่ง`, no amount).
  - `quoted`.
  - `confirmed` (it becomes an order line).
  - `expired` (`ใบเสนอหมดอายุ · ขอให้ชั่งใหม่`).
  - `revised` (`ปริมาณเปลี่ยนจากเดิม` with the old values struck in the history only).
- A quote is not in the subtotal until it is confirmed.

### 10.16 **Ticket** (staff order card)

- Bone, `--radius-sm`, hairline, card shadow. **New** tickets get a 2px ink outline.
- **Head:**
  - Framed table box: 54×56, 1.5px ink, `TABLE` in 12px caps over an Oswald 32 numeral.
  - Row 1: ref (Oswald 15, tracked) and wait (clock 16 + Oswald 24 minutes + 13px "min").
  - Row 2: `Round 1 · sent 19:48` (13px).
- **Flags row:** Oldest waiting, Longer than usual (the wait also turns oxblood), Just in, Waiting to be served, station.
- **Allergy band:**
  - Full-bleed oxblood directly under the head and above every line.
  - `⚠ ALLERGY` (Oswald 13 caps), the guest's words in quotes, **untranslated**, 16/700 with `lang` set to the original, and `As written by the guest · confirm with the table` (13, blush).
  - `role="note"`, and it is announced first in the ticket's label.
- **Lines** (hairline separated, grid `28px 1fr`):
  - Oswald 18 quantity `2×`, Thai name 15/600, English 13 `--text-2`.
  - Modifier chips, ink, **split by quantity**: `มีเดียมแรร์ × 1`, `มีเดียม × 1`. Placeholder configuration adds the `Example` tag.
  - Verified variant chips (`500 ml`, `Iced`).
  - Weight line `⚖ 380 g · ฿1,862 · guest confirmed 19:33`.
  - Alcohol flag `🍷 Alcohol · staff to confirm` (oxblood).
  - `no Thai name on file` in the English line when the catalogue has no Thai name.
  - Per-line status: `◐ Preparing · 19:46`, `✓ Served 19:49 · Ploy` (the line is struck through in `--text-2`), `⊘ Cancelled 19:45 · out of stock` (struck, oxblood status).
- **Guest note:** a sunken well with a note icon, `GUEST NOTE` in 12px caps, and the words verbatim.
- **Progress meter:** one 14×6 segment per active dish (served = forest, cooking = ink with an ember underline, ready = ember, waiting = rule) plus words: `1 served · 2 preparing`. Cancelled lines are excluded.
- **Actions** (48px):
  - One primary with the exact count (`Accept · 5`, `Start preparing · 2`, `Mark ready · 2`, `Mark served · 1`).
  - A framed `⋯` (details: per-line selection, reject or cancel with a reason, correction, Finish order).
  - An optional outline `Almost done` on its own row.
  - A bulk action names the number of lines it will change before it runs.
- **Conflict:** when a stale version is detected, the card shows an inline banner, "Updated by Ploy 19:51 · review", the actions are disabled until refresh, and nothing is overwritten.
- **Accessibility:** `<article aria-label="Table 03, round 1, new, allergy note">`. Actions are ordinary buttons, and nothing depends on dragging.

### 10.17 **Column board**

- Five columns: **New · Accepted · Preparing · Almost done · Ready**. Served, Rejected and Cancelled are in History and behind the toolbar toggle.
- Column: `--well` tray, `--radius-card`, 6px padding, independent scroll on desktop.
- **Head** (52px):
  - Glyph ring (26px): plus, check, pan, half, cloche.
  - Oswald 14 caps name + count + optional hint.
  - **New:** filled glyph and a 2px ink rule.
  - **Almost done:** hint "optional", and the help text "Almost done is optional. Tickets can go straight from Preparing to Ready." in the empty space.
  - **Ready:** hint "at the pass", and a **3px flat copper rail** (`--rail-pass`) across the top of the column. No lamp, no glow.
- **Sort:** oldest first by default.
- **Tablet and phone:** one column at a time (§8.2).

### 10.18 **TableTile**

- **Compact** (the Orders floor strip, 48px high, `auto-fit minmax(60px,1fr)`): Oswald 22 number + 13px state word. The attention badge hangs over the top edge.
- **Large** (Tables grid, min 164 × 176): Oswald 40 number, top-right badges, state line (14/600), facts (13px: seated time, rounds, unresolved items), and a full-width 44px primary action.

| State | Look | Words | Primary action |
| --- | --- | --- | --- |
| **Available** | Bone, 1.5px **dashed** `--edge` | "Free" / "Available · No open visit" | Seat guests |
| **Dining** | **Ink** fill, bone number, ash facts | Seated time ("48m", "Seated 48 min") | Details |
| **Checking out** | Bone with a **2px forest** outline and a receipt icon | "Bill" / "Checking out · Bill ฿2,480 · paid 19:49" | **Complete checkout** (primary) |
| **Disabled** | `--sunken`, struck number, lock | "Off" / "Disabled · No seating or ordering" | Enable… (manager) |

- **Attention badges** (13px Oswald caps words, overlaid; they never replace the state):
  - **NEW**: ink; bone on a Dining tile.
  - **READY**: ember/ink.
  - **CALL**: oxblood/bone, with a time on the large tile.
  - **QUOTE**: heat.
  - **BILL**: forest, meaning a bill was requested.
- **Legend:** repeats each swatch with a word and a count (Available 9 · Dining 5 · Checking out 1 · Disabled 1). The counts must reconcile with the tiles.
- **Selected tile** (drawer open): 3px ember outline, offset 3.
- **Accessibility:** a full `aria-label` ("Table 09, dining 29 minutes, guest called staff"). The state change crossfades in 180ms after the data is already authoritative.

### 10.19 **Drawer** (table details)

- A non-modal side panel, 480px, sticky under the header, bone, `--shadow-drawer`. On tablet it overlays with a scrim; on phone it is a full sheet. Escape closes it and focus returns to the tile.
- **Head:** framed table box 64, `Table 07` (20/600) + state pill, meta (`Seated 19:04 · 48 min · 4 diners recorded by Nok` or `Diners not recorded [Add]`), close.
- **Sections** (Oswald 14 caps heads, hairline between):
  1. **Guest access:** PIN masked as 4 sunken cells, devices joined, Show PIN, Rotate PIN, **Revoke access…** (danger, with confirmation).
  2. **Rounds:** per round, a head (`Round 2 · RG-4K7P`, sent time), then line rows (qty, Thai name, StatusPill). Finished rounds collapse to one ok pill. Portion quotes appear in a heat well. Assist order is a ghost button.
  3. **Bill:** accepted food, cancelled (not charged), unconfirmed quote (not included), configured charges ("Not configured" until the owner sets them), and a status pill.
  4. **History:** time (Oswald 14) + **event** + actor, newest first, with a link to the full audit.
- **Foot, when checkout is blocked:**
  - An alert-tint **blockers** list that names exactly what remains ("2 dishes in round 2 are not served", "1 portion quote is waiting for the guest", "No finalised bill or confirmed payment").
  - Then `Start bill…` (outline) and **Complete checkout** (`aria-disabled`, focusable, describes the blockers).
- **Foot, when checkout is allowed:** Complete checkout is primary and opens a one-step confirmation. It is idempotent, and a lost response recovers the completed result.

### 10.20 **StatCard**

- Bone card, `--radius-card`, hairline.
- **Head:** label 14/600 + a 32px "i" definition button (44 hit) that opens a popover with the metric definition.
- **Value:** Oswald 40, with small units in 14px Noto (`2m 10s`). A `Live` pill appears **only** when the value comes from the live pipeline.
- **Comparison:** an arrow glyph + a signed number + words (`▼ 1 vs last Thursday at 19:52`). When the prior value is 0 it reads "No prior baseline" and never shows a percentage.
- **Coverage bar** (4px, ok) with words, for metrics that depend on staff input ("Covers entered for 49 of 58 visits. Missing covers are not estimated.").
- **Loading:** a skeleton of the value only. **Error:** "Couldn't load · Retry".

### 10.21 **WeekBarChart**

- **Panel:** `data-surface="dark"` (ink), `--radius-card`, grid `300px 1fr`.
- **Headline column:**
  - Caps label (`ORDER ROUNDS · THIS WEEK SO FAR`).
  - Oswald 72 value.
  - Unit sentence with the exact coverage ("submitted order rounds, Mon 14 to Thu 17 at 19:52").
  - Comparison (`▲ 6` in sage-light + "vs 88 at the same point last week" + "Mon–Thu to 19:52 · +7%").
  - Selected-day card (ink-2) listing submitted, accepted, rejected · cancelled and ordering visits.
- **Plot:**
  - Seven bars, Monday to Sunday, Asia/Bangkok, 300px high.
  - The y-axis starts at **0** with integer ticks (Oswald 13, ash) and gridlines at bone 10%.
  - Bars have a max width of 64 and a 2px top radius. Value labels sit above the bars (Oswald 16, bone).

| Day state | Drawing | Label |
| --- | --- | --- |
| Completed | Bone bar | Weekday + date |
| **Today** | Bone bar, 3px ember top edge, 1.5px ember outline | **Today** (ember-light) + `● Live · partial` |
| **Future** | Full-height dashed steel outline with a faint hatch, value `—` | "Upcoming". **Never zero.** |
| **Real zero** | 3px bone baseline tick, value `0` | Weekday + date |
| **Missing / failed** | Dashed ash-2 outline, value "No data" | "No data" + Retry |
| Selected | Hover-wash plinth behind the bar, underlined weekday | `aria-pressed="true"` |
| Same point last week | 2px ash-2 tick, wider than the bar | In the legend |

- Bars are **buttons** (`aria-label` spells out the date, value, comparison and partial or future state). Arrow keys move the selection, and Enter updates the drill-down below without navigating away.
- The **legend** row explains all six marks.
- **Show as table** swaps in a DataTable with the same numbers. CSV export matches the current metric and filter.
- The **metric selector** above the panel offers Order rounds (default) · Accepted rounds · Ordering visits · Ordering devices · Recorded diners · Items ordered, plus "What each metric counts". Distinct metrics are recomputed for the period, never summed from daily values.
- **Period bar:** previous / range (`This week` + `Mon 14 – Sun 20 Sep 2026 · Asia/Bangkok`) / next, `This week`, `Pick a date`, and Week/Month/Year. Month and Year views aggregate by day or month with explicit labels. Weeks that cross a year boundary show both years.
- **Light variant** (PDF and print): ink bars on white with the same marks.

### 10.22 **RankingRow**

- **Grid:** rank 48 | plate 76 | dish (Thai 16/600 + English italic 15 + category 13) | servings (Oswald 24 + share % + 4px share bar) | orders | visits | change | context.
- **Rank:** Oswald 28. Rank 1 is ink; the rest use `--numeral`, which is decorative (the rank is also in the row label).
- **Change** is words, not colour alone:
  - `▲ 4` (ok), `▼ 3` (alert), `= 0 no change`.
  - **New** tag for items new in the period.
  - "No prior baseline" when there is no prior value.
- **Context column** (13px):
  - `✓ Available every open day`.
  - `⊘ Sold out 2 of 3 open days · Low count is not proof of low demand`.
  - `⚖ Priced by weight · Ranked by servings · 4.6 kg confirmed in total`.
  - `Never ordered despite availability`, or `Too little availability to rank`.
- **Header row:** 12px caps.
- **Footer:** `Showing 6 of 34 published food items · 2 never ordered despite being available · 1 with too little availability to rank` + **Full ranking**.
- **Controls:** Week/Month/Year/Custom, previous/next + exact range, Category, Most/Least ordered, search.
- Variant and modifier rows expand under the parent (`<details>`). Rows never reorder while a pointer is down. Refresh crossfades.

### 10.23 **DataTable**

- Bone, `--radius-card`, 1px rule ring.
- **Header:** 12px Oswald caps in `--text-2` with a strong rule below. It stays sticky inside scroll containers and repeats on print.
- **Rows:** 48px, hairline separated, 15px text, tabular numbers. Numeric columns are right-aligned. Codes use Oswald 15, tracked. Status cells use StatusPill.
- **Footer:** row count, "Show all 39 rounds", pagination.
- Sortable headers are buttons with `aria-sort`.
- A selected row gets `--hover` and a 3px ember left bar.
- An empty table shows an EmptyState inside the frame.
- Uses `<table>`, never grid divs, except RankingRow, which uses `role="table"` and `role="row"`.

### 10.24 **Toast** and **LiveRegion**

- **Toast:**
  - Ink, bone text, `--radius-ctl`, 48px, `--shadow-toast`.
  - It sits centred above the dock (`--dock-clearance`) and fades over 200ms.
  - Contents: an ok icon (sage-light), the message (15/600) and an optional ghost action (`เลิกทำ`).
  - It lasts 4s, pauses while hovered or focused, and shows one at a time.
- **LiveRegion:** one polite and one assertive region at the app root.
  - **Polite:** draft changes ("เพิ่ม ซี่โครงหมูย่าง แล้ว"), tracking state changes (only the changed step), search counts.
  - **Assertive:** submission failures and connection loss.
  - Analytics refreshes and the full order list are never announced.

### 10.25 **EmptyState**

- Centred.
- A 56px ringed icon (`--edge`), title 18/600, one sentence 14 `--text-2` (max 34ch), and one action.
- **Copy for each state:**
  - Empty group: `ยังไม่มีเมนูในหมวดนี้`.
  - No search result.
  - Empty draft: `ยังไม่มีรายการ · เลือกจากเมนูได้เลย`.
  - Nothing sent yet: `ยังไม่ได้ส่งออเดอร์ · รายการที่ส่งแล้วจะแสดงที่นี่`.
  - Empty board column.
  - No tables match the filter.
  - No data for the period.

### 10.26 **Banner** (demo data / offline / paused)

- Full width, under the header, padding 10 × gutter, 14px text, an icon, a bold lead, and an optional right-aligned 40–44px action.
- **Variants:**
  - `demo`: sunken with a dashed `--edge` rule. "Demo data. These figures come from seed fixtures…". It appears on every admin page while fixtures are loaded, and a compact `DEMO DATA` tag also sits in the workspace header.
  - `offline`: alert-tint with an oxblood rule and the wifi-off icon. Guest copy: `ขาดการเชื่อมต่อ · สถานะด้านล่างอาจไม่ใช่ล่าสุด [เรียกพนักงาน]`. Staff copy: "Offline · changes will not save until reconnected".
  - `paused`: ink band, bone text. Guest copy: `ร้านหยุดรับออเดอร์ชั่วคราว · เรียกพนักงานได้`. Staff copy: "Guest ordering paused by Nok 19:40 [Resume…]".
  - `billing`: sunken. Guest copy: `กำลังสรุปบิล · สั่งเพิ่มได้โดยเรียกพนักงาน`.
- Banners never overlap sticky chrome. They push content down.

### 10.27 **ConnectionIndicator**

- **Staff:** a pill in the workspace header.
  - `Live · synced 19:52:04` (ok tint, dot).
  - `Reconnecting… · last sync 19:51` (heat tint).
  - `Offline · last sync 19:48` (alert tint, diamond dot).
  - The shape changes with the state, not only the colour.
- **Guest:**
  - Nothing is shown while live, except the Track pill `ข้อมูลสด · อัปเดตล่าสุด 19:52`.
  - Reconnecting shows a small heat chip under the masthead, `กำลังเชื่อมต่อใหม่…`.
  - Offline shows the Banner.
  - Catching up after a reconnect never replays animations or alert sounds.

### 10.28 **QR card print layout** (`/admin/tables/print`)

- **A6 portrait card** (105 × 148 mm), eight to an A4 sheet with crop marks. White paper; `@media print` tokens apply.
- **Anatomy, top to bottom:**
  - 12 mm top margin.
  - Wordmark (Cormorant 600 caps, 14 pt) with the KHAO YAI lockup (Oswald 7 pt, tracked).
  - The masthead double rule.
  - `โต๊ะ` (Noto 12 pt) + table number (Oswald 500, 64 pt).
  - The QR code, 60 × 60 mm, error correction M, a 4-module quiet zone, pure black on white, inside a 0.3 mm ink frame with 3 mm padding.
  - Instructions: `สแกนเพื่อดูเมนูและสั่งอาหาร` (Noto 11 pt / 1.6) and "Scan to view the menu and order" (Cormorant italic 11 pt).
  - `ขอรหัสเข้าร่วมจากพนักงาน · Ask staff for the table PIN` (Noto 8.5 pt).
  - Footer hairline, then the short table token id (Oswald 7 pt, `--text-2`) for staff matching.
- **Rules:**
  - Never print the PIN, a session token or a URL that includes a secret. The QR encodes only `/q/:opaqueTableToken`.
  - Rotating a token marks older printed cards as "replaced" in admin, and the print view shows a "Reprint needed" banner.

### 10.29 **PDF report page style** (annual archive, brief 41)

- **Page:** A4 portrait for narrative pages, A4 landscape for appendices. Margins 18 mm top and bottom, 16 mm left and right. White page, with paper-2 used only for table header fills.
- **Fonts:** embed Noto Sans Thai (400/600), Oswald (500) and Cormorant Garamond (600 + italic 500) from the same fontsource files. Thai follows the same rules: no tracking, line-height ≥ 1.55.
- **Running head:** wordmark on the left; report title + year + status (`PROVISIONAL` / `FINAL` / `REVISED v2`, Oswald 8 pt caps, ember-ink on white 5.98:1) on the right; a 0.5 pt ink rule.
- **Running foot:** "Rabbit Grill Khao Yai · 1 Jan – 31 Dec 2026 · Asia/Bangkok · generated 2027-01-01 00:12 · snapshot v3" on the left, and "Page 4 of 38" on the right, in Noto 7.5 pt.
- **Cover:**
  - Wordmark, a 40 mm forest rule.
  - Year in Oswald 72 pt.
  - "Annual report" in Cormorant italic 28 pt.
  - A key-value block: exact range, time zone, generated-at, snapshot version, status, data cutoff.
- **Section heads:** `No. 03` Oswald kicker + Noto 18 pt title + hairline.
- **Charts:** the light variant of §10.21 (ink bars, ember today/partial mark, dashed future), with value labels, and y-axes at zero.
- **Tables:** header row repeated on every page, 9 pt text, 5 mm row height, tabular numbers, zebra striping with paper-2 at 40% (print-safe), right-aligned numbers, no Thai clipping (row height grows).
- **Status is always in words.** A metric dictionary page and a missing-data page close the report.

### 10.30 Supporting pieces

- **Masthead** (guest): §8.1.
  - The table tag is a 44px framed box: `โต๊ะ` (13, `--text-2`) + Oswald 24 number.
  - The wordmark link is 44px high and `aria-label`led, with its spans `aria-hidden`.
- **Section head:** the `No. 01` kicker (Oswald 13, tracked, `--text-3`, hairline to the right, `aria-hidden`), then `h2` in Thai with the English italic `p` right-aligned on the same baseline.
- **AllergyNotice:**
  - Alert tint, 3px oxblood left edge, `--radius-card`, triangle icon.
  - Title `แพ้อาหารหรือมีข้อจำกัดด้านอาหาร?` (16/600).
  - Honest body (14, `--text-2`), with wording driven by the verification state:
    - **unknown:** `ร้านยังไม่ได้ยืนยันข้อมูลสารก่อภูมิแพ้ของจานนี้…`
    - **verified contains:** lists the allergens as tags, with the reviewer and date.
    - **cross-contact:** a separate line.
  - An outline `เรียกพนักงาน` button. Unknown never reads as "free from".
- **Admin rail**, **Workspace header**, **Floor strip** and **Toolbar**: §8.2 and §10.18.
  - The toolbar is one row of 48px controls: station `FilterChips` (joined; pressed = ink), `SelectButton`s (`Table All`, `Sort Oldest first`), a `CheckButton` (`Show rejected · cancelled`), and search pushed to the right.
- **Pause control:** `Guest ordering ✓ Open | Pause…`, joined inside one `--edge` frame. `Pause…` opens a dialog with a reason and a preset duration. The paused state turns the frame ink with `Paused · Resume…`.
- **Avatar:** 40px forest circle with Oswald initials, then name (14/600) and role (13).
- **Skeleton:** `--sunken` blocks at the real dimensions (plates keep 4:3). A 1.2s opacity shimmer between 0.6 and 1, which is off under reduced motion.

---

## 11. Status vocabulary

The state machine is in `shared/status.ts`. Wording is keyed to the stable internal state, never to display text.

| Internal line state | Guest TH | Guest EN | Staff EN | Icon | Tone |
| --- | --- | --- | --- | --- | --- |
| submitted | ได้รับออเดอร์แล้ว | Order received | New | plus | ink (NEW) |
| accepted | ร้านยืนยันออเดอร์แล้ว | Order confirmed | Accepted | check | neutral |
| preparing (food) | กำลังปรุง | Currently cooking | Preparing | half (ember) | neutral |
| preparing (drink, dessert) | กำลังเตรียม | Currently preparing | Preparing | half | neutral |
| almost_done | ใกล้เสร็จ | Almost done | Almost done | half | neutral |
| ready | พร้อมเสิร์ฟ | Ready to serve | Ready · at the pass | cloche | ok / ember rail |
| served | เสิร์ฟแล้ว | Served | Served | check | ok |
| rejected | ร้านปฏิเสธ | Declined by the restaurant | Rejected | slash | alert |
| cancelled | ร้านยกเลิก | Cancelled by the restaurant | Cancelled | slash | alert |
| (optional step skipped) | ไม่ได้บันทึก | Not recorded | — | dashed ring | neutral |
| order: partially_served | เสิร์ฟแล้ว N · กำลังปรุง M | N served · M cooking | N served · M preparing | — | — |

| Table state | Staff EN | Guest-facing |
| --- | --- | --- |
| available | Available / Free | — |
| dining | Dining | — |
| checking_out | Checking out / Bill | `กำลังสรุปบิล` banner |
| disabled | Disabled / Off | QR shows `โต๊ะนี้ยังไม่เปิดให้สั่งอาหาร` |

---

## 12. Content and honesty rules (design side)

- **Names, prices and units** come only from the catalogue (`data-src/catalog.json`, which was imported from the restaurant's own menu). The English original is shown when a Thai name is missing (`lang="en"`), and staff see `no Thai name on file`.
- **Never invented:** descriptions, allergens, dietary labels, doneness options, portion sizes, serving counts, hours, ratings, awards, testimonials, promotions or popularity badges.
- **Placeholder configuration** (for example a doneness group used to demonstrate the component) must render the `ตัวอย่าง` / `Example` tag, and must be absent from live catalogues.
- **Specific catalogue records:**
  - Grilled Lamb Rack (two unlabelled prices) is not orderable until reviewed.
  - Seasonal Avocado stays unpublished until confirmed.
  - The beer promotion is never displayed as an active offer.
  - Alcohol lines carry the staff-confirmation flag.
- **Fixtures:** mock times, tables, staff names ("Nok", "Ploy", "Kitchen 1"), references, guest notes and all Insights numbers are fixtures, and the admin UI labels them "Demo data" while seeded.

---

## 13. Do not

- Do not use glows, blurs, `backdrop-filter`, grain, smoke, flames, flicker, pulsing or breathing effects, or any animation that runs without a committed event.
- Do not use hanging-lamp drawings, mascots, serrated or masked ticket edges, conic-gradient masks, or drop-shadow filters on lists.
- Do not put a full-screen hero, a promotional feature card or a greeting before the dishes. Do not default guests to the most expensive item.
- Do not use more than one solid forest action per view, or solid green Add buttons down a list.
- Do not strike through a price to mean sold out. Do not use a bordered box as a non-interactive label.
- Do not use ember as text on paper, bone or ink-2 (use `--now-text` / ember-light), or steel as text anywhere on light surfaces.
- Do not rely on colour alone for any state, or on hover, swipe, drag or a tiny unlabelled icon for any essential path.
- Do not use leader dots on radio rows, buttons or staff screens, or where no value exists.
- Do not add letter-spacing or `text-transform` to Thai, set Thai line-height below 1.55, or set Thai in Oswald or Cormorant on purpose.
- Do not set prices in Cormorant, or dish names in condensed caps.
- Do not use fully rounded pills for anything except status pills and count badges. Do not use radii above 10px except the 16px sheet.
- Do not put Reject, Cancel or Revoke next to a primary action without a confirmation and a reason.
- Do not use a one-tap switch that pauses guest ordering.
- Do not use staff text below 12px, guest text below 13px, input text below 16px, or touch targets below 44px (48px for staff actions).
- Do not show estimated countdowns, invented timestamps for skipped steps, or zero for future days or failed loads.
- Do not show a shopping bag, cart-wheel or retail iconography. It is "your order", not a shop.
- Do not use raw hex values in components, and do not redefine brand primitives outside `tokens.css`.

---

## 14. Reference mocks and QA

| File | Viewport | Shows |
| --- | --- | --- |
| `design-lab/final/guest-menu.html` | 390×844; also 820 (tablet) and 1440 (desktop) | Masthead, tool row, category row, section heads, every DishRow variant (by weight, unit, in-draft with choices, in-draft stepper, sold out, text-led), order slip, bottom nav + service key; desktop sidebar and order panel |
| `guest-menu.html#sheet` | 390×844 | Item sheet with a placeholder choice group (`ตัวอย่าง`), required → selected pill, note counter, allergy notice, sticky footer |
| `guest-menu.html#service` · `#categories` · `#toast` | 390×844 | ServiceMenu with a sent request · AllCategoriesSheet · Toast |
| `guest-track.html` (`?full`, `#offline`) | 390×844 | Live pill, service pair, portion quote, round card, timeline (done / current / upcoming), per-dish lines (cooking, served with not-recorded step, cancelled), past round, draft nudge, running subtotal; offline banner |
| `admin-board.html` | 1440×900 | Charcoal rail, workspace header (demo tag, live pill, Pause…), floor strip (all four states, word badges), toolbar, five columns, tickets (allergy band, split modifiers + Example tag, verified variants, alcohol flag, served and cancelled lines, meter, late threshold, weight line), copper Ready rail |
| `admin-tables.html` | 1440×900 | State filter chips that reconcile (16 = 9 + 5 + 1 + 1), large tiles in all four states with badges and primary actions, table drawer (guest access, rounds, quote, bill, history, blocked checkout) |
| `admin-stats.html` (`--full`) | 1440 | Demo banner, period bar, metric selector, dark headline + WeekBarChart (completed, selected, zero, today partial, upcoming, prior-week ticks, legend including no data), stat cards with coverage, day drill-down DataTable, Menu Stats controls and RankingRows (sold-out context, by-weight servings, no change) |

**Captured PNGs in `design-lab/final/`:**

- guest-menu: `guest-menu.png` (390 fold), `guest-menu-full.png`, `guest-menu-320.png`, `guest-menu-tablet.png` (820), `guest-menu-desktop.png` (1440), `guest-menu-sheet.png`, `guest-menu-service.png`, `guest-menu-categories.png`, `guest-menu-toast.png`
- guest-track: `guest-track.png`, `guest-track-full.png`, `guest-track-offline.png`
- admin: `admin-board.png`, `admin-board-tablet.png` (1024, one status at a time with the compact rail), `admin-tables.png`, `admin-stats.png` (full page)

**Capture commands.** Run these from PowerShell in `ordering/`:

```
node scripts/shot.ts design-lab/final/guest-menu.html out.png --w 390 --h 844
node scripts/shot.ts "file:///C:/Users/marky/NOVA/rabbit-grill/ordering/design-lab/final/guest-menu.html#sheet" out.png --w 390 --h 844
node scripts/shot.ts "file:///C:/Users/marky/NOVA/rabbit-grill/ordering/design-lab/final/guest-track.html?full" out.png --w 390 --h 844 --full
node scripts/shot.ts design-lab/final/admin-board.html out.png --w 1440 --h 900
node scripts/shot.ts design-lab/final/admin-stats.html out.png --w 1440 --h 900 --full
```

**Audit of the final mocks** (the DOM audit used by the judges, extended with a Thai line-height check):

- No horizontal overflow at 390 or 1440.
- Guest minimum text is 13px. Staff minimum is 12px, on caps labels only.
- Zero Thai text with letter-spacing, and zero Thai text with line-height below 1.55. The lone `฿` glyph is exempt.
- Zero text pairs below 4.5:1. The only flags were the chart value labels, a measurement artefact: they sit above the bars on ink, at 15.11.
- Every control is ≥ 44px or extends its hit area to 44px. Ticket, toolbar and drawer actions are 48px.

**Port note for the ui kit.** `final.css` is written against these tokens with BEM-ish class names. Port each section into `components.css` (or component-scoped CSS), keeping the token references unchanged. The mocks' inline `style=""` attributes are layout shortcuts only; turn them into component props or classes.
