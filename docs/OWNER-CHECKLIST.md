# Owner-content checklist

What Rabbit Grill Khao Yai has to confirm or supply before guests order for real (brief 02, 04, 45). The software works without these answers: it runs in **demo** mode, labels demo data and keeps unverified items unorderable in **live** mode. Only the restaurant can make its content true.

Every value in **More → Settings** is a *proposed default* until the owner saves it (`shared/settings.ts`). The menu counts below come from [source-audit.md](source-audit.md), the audit of `data-src/catalog.json` against the restaurant's printed menus (retrieved 2026-08-29, audited 2026-09-17). **Nothing has been approved by the restaurant yet.**

How to use this list: work top to bottom with the owner. Tick a box when the answer is **entered in the app**, not just when it has been given. Items marked **blocks live** stop real ordering until they are done.

## 0. Before you start

- [ ] **Owner account.** Create it with `npm run admin:create` on an empty database. Add one account per staff member in **More → Team** (see [OPERATIONS.md](OPERATIONS.md#first-admin)). **Blocks live.**
- [ ] **No demo accounts.** No `demo-*` account is active. Deactivate them in **More → Team**, or let **Settings → Operating mode** do it: switching to live is refused while one is active, and the screen then offers "Deactivate demo accounts and switch", which retires them, signs them out and switches in one step. It is refused if you are signed in as a demo account yourself, so create your own owner first. **Blocks live.**
- [ ] **Operating mode.** Stay in *demo* while you work through this list, then switch to *live* in **More → Settings → Operating mode** as the last step. In live mode only owner-verified items can be ordered.

## 1. Restaurant identity

- [ ] **Name** (Thai and English, full and short). Proposed: "Rabbit Grill เขาใหญ่" / "Rabbit Grill Khao Yai". Enter in **Settings → Restaurant**.
- [ ] **Location and contact.** They are taken from third-party listings and our reference site, and are not verified (brief 02). The ordering app shows neither, but the owner should confirm them before anything is published.
- [ ] **Logo.** No approved logo file exists. The app and the annual PDF use a typographic wordmark (D-S7-05). Supply a logo file and the rights to use it, or approve the wordmark.

## 2. Verified menu

In **Menu → Review**, the review queue shows these counters live. Only an **owner** can verify.

| Measure (source audit) | Count | What the owner does |
| --- | --- | --- |
| Imported item records | 95 (39 food, 56 drinks), 19 categories | Confirm the list is current. Archive dishes that are no longer served. |
| Owner-verified live entries | **0** | Verify each item you will sell: name, price, options, photo and description. **Blocks live** (per item). |
| Orderable in demo mode | 82 | Demo only. Live mode ignores this. |
| Unpublished categories | 2 (`seasonal-avocado`, `juice`), holding 8 items | Publish only after questions 10 and 11 below. |
| Disabled seasonal items | 4 (Seasonal — Avocado) | Confirm whether they are served, and from and until when (question 11). |
| Duplicate-name pairs | 3 (Matcha Latte, Orange Juice, Coconut Water) | Questions 9 and 10. |
| Misprints corrected for display | 3 names plus the "APPERTIZER" label | Approve the corrections (source audit §5). |
| Possible misprints kept as printed | 7 | Questions 17 and 18. |

- [ ] **Category order and names** for Food (Beef Selection, From the Grill, Appetizers, Salads, Seasonal, Rice, Side Dishes, Dessert) and Drinks (11 categories). Reorder in **Menu → Catalog**.
- [ ] **Sold-out display**: show sold-out dishes greyed out (proposed) or hide them. **Settings → Menu display**.
- [ ] **Note length** for guest notes. Proposed: 140 characters.

## 3. Translations

- [ ] **Thai names for the 55 drinks** that have none. Only Longan Juice (น้ำลำไย) is printed in Thai. Drinks show their English name, marked as untranslated, until you supply names (question 16).
- [ ] **14 Thai dish names are our reference site's translation, not printed by you**: Prime Rib, the 7 sides, the 2 desserts and the 4 avocado dishes. Approve them or replace them (question 15).
- [ ] **Thai spellings kept as printed** (question 17), and **English spellings kept as printed** (question 18).
- [ ] **Thai category labels.** None are printed. Every Thai category label is our translation, and five categories have none (question 19).
- [ ] **Search words (optional).** A dish can carry other spellings and nicknames guests may type (up to 12 each in Thai and English) in the item editor. Printed names never change, and guests search an alias only after an owner review — so they are safe to collect from staff and approve later.
- [ ] **Guest messages you want to change**, for example the pause message. These are in **Settings → Ordering**, in both languages.

## 4. Prices and portions

- [ ] **Every price you sell at.** The printed prices are imported as they are, and none is owner-approved. A price change needs a reason and returns the item to review. **Blocks live** (per item).
- [ ] **Ambiguous prices: 1.** Grilled Lamb Rack is 890 / 1,590 with no labels (question 1). It cannot be ordered until you answer.
- [ ] **Unspecified variant: 1.** Long Black, iced (question 5).
- [ ] **Measured-weight cut: 1.** Prime Rib at 490 THB per 100 g is ordered through the staff weigh-and-quote flow, and has no minimum, presets, doneness or sides (question 2).
  - [ ] Quote validity. Proposed: 10 minutes. **Settings → Weighed cuts**.
  - [ ] Whether guests may state a preferred weight. Proposed: yes.
- [ ] **Printed but unverified portions**: Wagyu "300 g" (question 3), draft beer "250 ml / 500 ml" (3 items), Regency "350 ml".
- [ ] **Included sides and doneness.** None are configured, because the menus print none (questions 2–4). Add them per item only as you confirm them.
- [ ] **Special Blend (+30 THB).** It is attached to the 12 espresso drinks as a demo assumption, and each of them is flagged (question 6).

## 5. Descriptions and allergens

- [ ] **Descriptions: 95 missing** (every item; the menus print none). Guests see a description only after the owner verifies it. Leave any blank that you do not want to describe (question 20).
- [ ] **Allergens: unknown for every item.** Guests see "please ask staff about allergies" until you verify, per item, what it contains and any confirmed cross-contact. Unknown never means allergen-free (brief 11, question 20).
- [ ] **Staff process for allergy notes.** Allergy notes are shown prominently on kitchen tickets. Decide who reads and confirms them.

## 6. Photography permissions

- [ ] **Permission to use the 39 dish photos** that come from the restaurant's own menu and reference site (`img/`). Each was matched by eye to its printed dish (source audit §1), but reuse has not been authorised in writing (brief 04).
- [ ] **Credit or restrictions** (photographer, social media use).
- [ ] **Drink photos: 56 missing.** Drinks use text-only cards. Supply photos if wanted (question 21).
- [ ] **Atmosphere shots** (hero plate, fire hearth, venue) are not used in ordering. Confirm before they are used anywhere.

## 7. Charges and tax

- [ ] **Service charge and VAT policy.** None is configured (`charges: []`, `charges_confirmed: false`), so bills are the sum of the dishes. Enter the real rules (rate, inclusive or exclusive, order) in **Settings → Charges**. **Blocks live.**
- [ ] Changes apply to visits seated afterwards. A charge set is frozen onto each visit at seating.
- [ ] **Official receipts.** The app's bill is not a tax invoice (brief 16). Confirm how receipts are issued (POS or paper).

## 8. Tables and QR cards

- [ ] **Table names and count.** The demo has 12 tables labelled 01–12. That is not your floor plan. Create your real tables (and zones, if wanted) in **Tables → Manage tables & QR**.
- [ ] **QR base address** (`PUBLIC_BASE_URL`): the LAN address or https domain guests will use. Print cards only after it is final (see [OPERATIONS.md](OPERATIONS.md)). The print page warns when the address would only work on the computer running the app, so cards are never printed with a link no phone can open.
- [ ] **Card placement** and a process for replacing a card when its QR is rotated.
- [ ] **Join PIN policy.** Proposed: PIN required, 4 digits (4–8 allowed), and 5 wrong tries lock the visit for 5 minutes. A second lockout lasts 15 minutes, and a third holds until staff rotate the PIN. Changing the length affects the next visits seated; a party already seated keeps the code it was given, and the join screen asks for exactly that many digits. **Settings → Joining a table**.
- [ ] **After checkout** the table becomes Available at once (brief 36). A "Needs clearing" step is not built. Say if you need it.

## 9. Service policies

- [ ] **Guest service buttons.** Proposed on: Call staff, Request the bill, Ask to change an order, Ask about allergies. Proposed off: Water, Utensils, until you confirm you offer them (D-16). **Settings → Guest services**.
- [ ] **Repeat-request cooldown.** Proposed: 45 seconds. The server holds a repeat of the same request type for this long (a reloaded phone cannot get around it), asking for the bill is never held back, and 0 switches the wait off.
- [ ] **Feedback after the meal.** A guest may still send the short rating for **30 minutes** after checkout, from the page already open on their phone. Nothing else is possible after checkout. The ratings are in **More → Reports**, and comments are removed by the retention rule below.
- [ ] **Opening hours.** Stored as 11:00–21:00, closed Wednesday, taken from third-party listings and **not enforced** (`hours_verified: false`, D-17). Confirm them, then decide whether ordering should close outside hours. **Settings → Ordering**.
- [ ] **Business day cutoff.** Proposed: 00:00. Change it in **Settings → Business day** if service runs past midnight.
- [ ] **Estimated wait.** None is shown unless staff set one when pausing. Confirm that you want it optional.
- [ ] **Intake limit** (automatic pause after N unaccepted rounds). Proposed: none.
- [ ] **Who may cancel, correct, reopen bills and pause ordering.** The proposed role matrix is in `shared/permissions.ts`. Adjust it in **Settings → Role permissions**.
- [ ] **Kitchen sound alerts.** Off by default. Each device turns them on.
- [ ] **Paper fallback.** Agree the manual procedure for a system outage, and who enters paper orders afterwards (managers).

## 10. Payment methods

- [ ] **Which methods you accept.** Proposed: Cash on (with tendered and change). Bank transfer / PromptPay off. Card (your own terminal) off. **Settings → Payment methods**. **Blocks live.**
- [ ] **PromptPay or transfer QR image**, if you enable it. Staff still confirm every payment by hand. A guest's "I have paid" is never a payment (brief 16).
- [ ] **Refund and correction process.** A recorded refund is a staff record, not a money transfer.
- [ ] **Online payment** is deferred in V1: no provider, and no guest pay button.

## 11. Alcohol

- [ ] **Alcohol items: 7** (3 draft, 3 bottled, 1 whiskey). All are marked "staff confirm before serving". Confirm what staff must check before serving an order placed from a table (question 13).
- [ ] **Licensing and serving hours.** No legal rules are modelled. Confirm what applies at your premises.
- [ ] **Alcohol on or off.** You can switch the whole category off; food and other drinks keep working. **Settings → Alcohol**.
- [ ] **Draft beer promotion "3 FREE 1".** It is recorded only, and the 3 draft beers cannot be ordered until you answer question 12. Promotional pricing is not built in V1.

## 12. Analytics, privacy and retention

- [ ] **Analytics notice and opt-out.** Engagement measurement is on by default, guests see a short notice, and each browser can opt out. Confirm the wording, or switch analytics off (**Settings → Menu analytics**). No legal compliance claim is made.
- [ ] **Retention periods** (**Settings → Data retention**). Proposed: guest notes 400 days, feedback 730, raw analytics 400, audit 2,555. A daily task applies them: note and comment text is removed, raw events are deleted after their daily totals are kept (per-dish daily counts stay), and old audit entries are deleted. Orders, bills and payments are never deleted. The screen shows when the task last ran and how far raw events have been removed. Confirm the periods before live use.
- [ ] **Backups.** Where they are kept, and who can read them. They contain staff password hashes and guest notes.

## 13. The 21 open questions from the source audit

Each answer unblocks the records named. Full context: [source-audit.md §6](source-audit.md#6-questions-for-the-owner).

**Prices and portions**

- [ ] **1. Grilled Lamb Rack.** What separates 890 from 1,590 (bones, weight or sharing size)? Please give Thai and English option names.
- [ ] **2. Prime Rib (490 THB / 100 g).** Please answer:
  - Is there a minimum weight or usual cut size?
  - May guests ask for a weight?
  - Which doneness choices do you offer?
  - Are the sauces and garlic in the photo included?
  - How long should a quote stay valid?
- [ ] **3. Wagyu Tenderloin.** Is "300 g" a fixed portion? Raw or cooked weight? Which doneness choices apply?
- [ ] **4. Sides.** Do any mains include a side (the ribs and fish-and-chips photos show fries)? Is it a choice, or fixed?
- [ ] **5. Long Black.** Is it served iced, and at what price?
- [ ] **6. Special Blend (Bluetamp, +30 THB).** Which coffees can take it? Hot and iced?
- [ ] **7. Ice (30).** Is it a glass, a bucket or a per-person charge?
- [ ] **8. MILKY and SPECIAL MATCHA.** Are the hot versions really unavailable? Are SODA and FRESH JUICE iced only?

**Duplicates and conflicting lists**

- [ ] **9. Matcha Latte** appears twice (Special Matcha 120/150, Milky 100). Two recipes, two sizes, or one stale price?
- [ ] **10. JUICE or FRESH JUICE.** Which list is current? Is Watermelon Juice the same as Cold Pressed Watermelon? Is Mangosteen Juice (200) available now, and is it seasonal?

**Availability, promotions and alcohol**

- [ ] **11. Seasonal — Avocado.** Is it served now? From when until when?
- [ ] **12. Draft beer "PROMOTION 3 FREE 1".** Is it running? If so, please confirm:
  - which beers and sizes it covers, and whether sizes can be mixed
  - the start and end dates
  - which drink comes free
  - whether it counts per bill or per round
  - whether it combines with other offers
- [ ] **13. Alcohol at the table.** What must staff check before serving?
- [ ] **14. Regency** is printed under "WHISKEY". Is that the label you want?

**Names and spelling**

- [ ] **15. Thai names for the 14 English-only dishes.** Approve ours, or supply your own.
- [ ] **16. Thai names for the 55 drinks.** Should they be shown? If so, which names?
- [ ] **17. Thai spellings.** Keep or correct: "กริลลซีซาร์สลัด", "ฟิชแอนดชิปส์", and "บุเรต้า" versus "บุรัตต้า".
- [ ] **18. English spellings.** Keep or correct: "Stellar", "Hoegaarden Rosee", "Strawberry Cocao", "Ice Coffee".
- [ ] **19. Thai category labels.** Approve ours, or supply labels (Coffee, Hot Tea, Juice, Whiskey and Soft Drinks have none).

**Content not on the menu**

- [ ] **20. Descriptions and allergens** for every dish you want described.
- [ ] **21. Drink photos.** There are none. Drinks use text-only cards.

## 14. Go-live sign-off

- [ ] Sections 0–12 are done, or consciously deferred (write down which).
- [ ] A full test service was run in demo mode on the real network, with real phones: seat, join, order, kitchen, serve, bill, pay, checkout ([OPERATIONS.md](OPERATIONS.md#multi-device-qr-testing-on-a-lan)).
- [ ] Backups are scheduled, and one restore has been tested.
- [ ] Operating mode is switched to **live**, and the first real visit has been checked end to end.

Signed off by: ____________________  Date: ____________
