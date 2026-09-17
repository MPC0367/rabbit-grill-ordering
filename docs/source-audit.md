# Rabbit Grill Khao Yai: catalog source audit

The audit checks every entry in `data-src/catalog.json` against the restaurant's own printed menus.

| | |
| --- | --- |
| Audited | 2026-09-17 |
| Menu files retrieved | 2026-08-29, from the Google Drive links in the restaurant's Instagram linktree (see `doc/RESEARCH.md`) |
| Reference site | https://mpc0367.github.io/rabbit-grill/menu.html, our own earlier build. It renders `data/menu.json`. |
| Output | `data-src/catalog.json` (95 items, 19 categories, 2 groups) |
| Reviewer / owner approval | **Not yet reviewed by the restaurant.** No entry is owner-verified. |

## 1. Sources

Only the restaurant's own menu images count as evidence. Paths are relative to `C:\Users\marky\NOVA\rabbit-grill\`.

| File | What it contains |
| --- | --- |
| `doc/pages/food-01.jpg` | Cover: wordmark, apron photo, the English line about fire cooking. No items. |
| `doc/pages/food-02.jpg` | APPERTIZER: Corn Rib, Nashville Hot Chicken, Fried Sweet Potato |
| `doc/pages/food-03.jpg` | SALAD: Grilled Caesar Salad, Green Beans and Peas Salad |
| `doc/pages/food-04.jpg` | APPERTIZER: Beef Tartare Bone Marrow, Calamari Served with Tartar Sauce |
| `doc/pages/food-05.jpg` | SALAD: Green Salad with Balsamic Dressing, Tomato Salad, Burrata Cheese and Tomato Salad |
| `doc/pages/food-06.jpg` | MAIN: Grilled Baby Chicken, Grilled Pork, Grilled Pork Ribs |
| `doc/pages/food-07.jpg` | MAIN: Fish and Chips, Grilled River Prawns |
| `doc/pages/food-08.jpg` | MAIN: Grilled Squid, Grilled Fish |
| `doc/pages/food-09.jpg` | PRIME RIB, "490 THB / 100 g" (full page, no section label, no Thai) |
| `doc/pages/food-10.jpg` | "Beef Selection": Australain [sic] Striploin, Wagyu Tenderloin MB 6-7 with Red Wine Jus |
| `doc/pages/food-11.jpg` | Grilled Tongue, Beef tongue stew, Grilled Lamb Rack |
| `doc/pages/food-12.jpg` | SIDEDISH: seven sides, English only |
| `doc/pages/food-13.jpg` | RICE: three rice dishes |
| `doc/pages/food-14.jpg` | DESSERT: Creme Brulee Lamon [sic], Tiramisu, English only |
| `doc/pages/bev-01.jpg` | JUICE (4), COFFEE (13, Hot/Iced), SPECIAL BLEND (+30 THB), HOT TEA (1) |
| `doc/pages/bev-02.jpg` | MILKY (5, HOT/ICED), SODA (3), FRESH JUICE (4) |
| `doc/pages/bev-03.jpg` | SPECIAL MATCHA (12, HOT/ICED) and the line "WE SOURCE OUR MATCHA STRAIGHT FROM JAPAN." |
| `doc/pages/bev-04.jpg` | DRAFT BEER (3, 250/500 ml) with "PROMOTION  3 FREE 1", BOTTLED BEER (3), WHISKEY (1), SOFT DRINK (7) |
| `doc/menu-avocado.jpg` | Separate card "NEW SEASONAL / AVOCADO": 4 dishes, English only, no dates |

The food pages are pages 1–14 of `doc/menu-food.pdf`, and the beverage pages are pages 1–4 of `doc/menu-beverage.pdf`. Each PDF page is one embedded JPEG, so the page images are the full content of the PDFs.

### How the check was done

- Every page image was read in full.
- Every dish label was then cropped and enlarged 2–3×, so the handwritten Thai could be read one character at a time.
- The beverage tables were cropped and read column by column.
- Every dish photo in `img/` was compared with the photo printed beside the dish on the menu page. All 39 dish photos match their dish. The atmosphere shots (`hero-plate`, `apron-portrait`, `plate-ribs`, `fire-steak`, `fire-hearth`, `prep-raw`) are not linked to any item.
- `source_text` in the catalog keeps the printed wording and its misprints. Where Thai wraps onto two lines on the page, the line break is shown as " / ".

## 2. Counts

| Measure | Count |
| --- | --- |
| Imported item records | **95** (39 food, 56 drinks) in 8 food and 11 drink categories |
| …of which were absent from `data/menu.json` | **18** (13 coffee, 1 hot tea, 4 in the bev-01 JUICE list) |
| Pricing models | 60 fixed, 34 variant, 1 measured-weight |
| Owner-verified live entries | **0**. Nothing has been approved by the restaurant yet. |
| Orderable in the demo | **82** (13 held back: 1 ambiguous price, 4 seasonal, 3 draft beers under the promotion, 4 in the duplicate JUICE list, 1 "Ice") |
| Missing Thai names | **55**: every drink except Longan Juice (น้ำลำไย) |
| Thai names that are our site's translation, not printed | **14**: Prime Rib, 7 sides, 2 desserts, 4 avocado dishes |
| Thai names printed by the restaurant | 26 |
| Missing descriptions | **95** (every item; the menus print no dish descriptions) |
| Missing photos | **56** (every drink). All 39 dishes have a verified matching photo. |
| Ambiguous prices | **1** (Grilled Lamb Rack). Also 1 unspecified variant: Long Black, Iced. |
| Pending portion rules | **1** measured-weight item (Prime Rib: no minimum, presets, doneness or sides printed). Printed but unverified: Wagyu "300 g"; draft beer "250 ml / 500 ml" (3 items); Regency "350 ml". |
| Disabled seasonal items | **4** (Seasonal — Avocado, category unpublished) |
| Alcohol items | **7** (3 draft, 3 bottled, 1 whiskey). All are staff-confirmed; the 3 draft beers are also held back by the promotion rule. |
| Unpublished categories | 2 (`seasonal-avocado`, `juice`), holding 8 items |
| Duplicate-name pairs | 3 (Matcha Latte, Orange Juice, Coconut Water) |
| Misprints corrected for display | 3 item names plus the "APPERTIZER" category label |
| Possible misprints kept as printed | 7 |

## 3. Category map

| # | Catalog category | Printed label (page) | Thai label | Published | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | `beef-selection`: Food › Beef Selection | "Beef Selection" (food-10); Prime Rib page food-09 has no label | เนื้อ *(site)* | yes | Brief 44E order |
| 2 | `from-the-grill`: Food › From the Grill | MAIN (food-06/07/08) | จานหลักจากเตา *(site)* | yes | Site name kept per 44E |
| 3 | `appetizers`: Food › Appetizers | APPERTIZER (food-02/04) | ของเรียกน้ำย่อย *(site)* | yes | Misprint corrected |
| 4 | `salads`: Food › Salads | SALAD (food-03/05) | สลัด *(site)* | yes |  |
| 5 | `seasonal-avocado`: Food › Seasonal — Avocado | NEW SEASONAL / AVOCADO (menu-avocado) | เมนูตามฤดูกาล · อะโวคาโด *(site)* | **no** | Seasonal; owner must confirm |
| 6 | `rice`: Food › Rice | RICE (food-13) | ข้าว *(site)* | yes |  |
| 7 | `side-dishes`: Food › Side Dishes | SIDEDISH (food-12) | เครื่องเคียง *(site)* | yes | No Thai dish names printed |
| 8 | `dessert`: Food › Dessert | DESSERT (food-14) | ของหวาน *(site)* | yes | No Thai dish names printed |
| 9 | `special-matcha`: Drinks › Special Matcha | SPECIAL MATCHA (bev-03) | มัทฉะพิเศษ *(site)* | yes |  |
| 10 | `coffee`: Drinks › Coffee | COFFEE (bev-01) | — | yes | New; +30 THB Special Blend not configured |
| 11 | `hot-tea`: Drinks › Hot Tea | HOT TEA (bev-01) | — | yes | New |
| 12 | `milky`: Drinks › Milky | MILKY (bev-02) | นม *(site)* | yes | HOT column is all dashes |
| 13 | `soda`: Drinks › Soda | SODA (bev-02) | โซดา *(site)* | yes |  |
| 14 | `fresh-juice`: Drinks › Fresh Juice | FRESH JUICE (bev-02) | น้ำผลไม้สด *(site)* | yes |  |
| 15 | `juice`: Drinks › Juice | JUICE (bev-01) | — | **no** | New; overlaps FRESH JUICE |
| 16 | `draft-beer`: Drinks › Draft Beer | DRAFT BEER (bev-04) | เบียร์สด *(site)* | yes | Alcohol; promotion recorded only |
| 17 | `bottled-beer`: Drinks › Bottled Beer | BOTTLED BEER (bev-04) | เบียร์ขวด *(site)* | yes | Alcohol; site had merged it with whiskey |
| 18 | `whiskey`: Drinks › Whiskey | WHISKEY (bev-04) | — | yes | Alcohol |
| 19 | `soft-drinks`: Drinks › Soft Drinks | SOFT DRINK (bev-04) | — | yes | Site Thai label clashed with group name |

The restaurant prints no Thai category labels anywhere. Every Thai category name above comes from our reference site.

## 4. Every item

Key to the table:

- *(site)*: the Thai name is our reference site's translation, not printed by the restaurant.
- "—" in a price: that option is not offered (a printed dash, or a blank cell).
- Orderable: whether the item can be ordered in the demo.
- Flags: every item also carries `missing_description`, which is left out of the table to keep it short.
- The full flag wording is in `catalog.json`.

### Food (อาหาร)

#### Beef Selection, 6 items

| Key | TH | EN | Price (THB) | Image | Orderable | Flags | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `prime-rib` | ไพร์มริบ *(site)* | Prime Rib | 490 per 100 g (weighed) | `primerib-full` | yes | measured_weight, thai_is_site_translation | food-09.jpg |
| `australian-striploin` | เนื้อสันนอกออสเตรเลีย | Australian Striploin | 590 | `striploin` | yes | typo_corrected | food-10.jpg |
| `wagyu-tenderloin` | เนื้อสันในวากิวย่างซอสไวน์แดง | Wagyu Tenderloin MB 6–7 with Red Wine Jus | 1990 (300 g) | `wagyu-tenderloin` | yes | — | food-10.jpg |
| `grilled-tongue` | ลิ้นวัวย่าง | Grilled Tongue | 590 | `grilled-tongue` | yes | — | food-11.jpg |
| `beef-tongue-stew` | สตูว์ลิ้นวัว | Beef Tongue Stew | 490 | `tongue-stew` | yes | — | food-11.jpg |
| `grilled-lamb-rack` | ซี่โครงแกะย่าง | Grilled Lamb Rack | Price A 890 / Price B 1590 | `lamb-rack` | **no** | ambiguous_price | food-11.jpg |

#### From the Grill, 7 items

| Key | TH | EN | Price (THB) | Image | Orderable | Flags | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `grilled-baby-chicken` | ไก่ย่างตัวเล็กคลุกเครื่องเทศ | Grilled Baby Chicken | 590 | `baby-chicken` | yes | — | food-06.jpg |
| `grilled-pork` | หมูย่าง | Grilled Pork | 390 | `grilled-pork` | yes | — | food-06.jpg |
| `grilled-pork-ribs` | ซี่โครงหมูย่าง | Grilled Pork Ribs | 590 | `pork-ribs` | yes | — | food-06.jpg |
| `fish-and-chips` | ฟิชแอนดชิปส์ | Fish and Chips | 490 | `fish-chips` | yes | possible_typo | food-07.jpg |
| `grilled-river-prawns` | กุ้งแม่น้ำย่าง | Grilled River Prawns | 990 | `river-prawns` | yes | — | food-07.jpg |
| `grilled-squid` | ปลาหมึกย่าง | Grilled Squid | 390 | `grilled-squid` | yes | — | food-08.jpg |
| `grilled-fish` | ปลาย่าง | Grilled Fish | 490 | `grilled-fish` | yes | — | food-08.jpg |

#### Appetizers, 5 items

| Key | TH | EN | Price (THB) | Image | Orderable | Flags | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `corn-rib` | คอร์นริบ | Corn Rib | 150 | `corn-rib` | yes | — | food-02.jpg |
| `nashville-hot-chicken` | ไก่ทอดซอสเผ็ดแนชวิลล์ | Nashville Hot Chicken | 240 | `nashville-chicken` | yes | — | food-02.jpg |
| `fried-sweet-potato` | มันหวานทอด | Fried Sweet Potato | 180 | `sweet-potato` | yes | — | food-02.jpg |
| `beef-tartare-bone-marrow` | บีฟทาร์ทาร์เสิร์ฟพร้อมโบนแมโรว์ | Beef Tartare Bone Marrow | 490 | `bone-marrow` | yes | — | food-04.jpg |
| `calamari-tartar-sauce` | หมึกชุบเกล็ดขนมปังทอดเสิร์ฟพร้อมซอสทาร์ทาร์ | Calamari Served with Tartar Sauce | 390 | `calamari` | yes | — | food-04.jpg |

#### Salads, 5 items

| Key | TH | EN | Price (THB) | Image | Orderable | Flags | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `grilled-caesar-salad` | กริลลซีซาร์สลัด | Grilled Caesar Salad | 260 | `caesar` | yes | possible_typo | food-03.jpg |
| `green-beans-peas-salad` | สลัดถั่วหวานกับซอสบัลซามิก | Green Beans and Peas Salad | 280 | `greenbean-peas` | yes | — | food-03.jpg |
| `green-salad-balsamic` | สลัดรวมกับซอสบัลซามิก | Green Salad with Balsamic Dressing | 260 | `green-salad` | yes | — | food-05.jpg |
| `tomato-salad` | สลัดมะเขือเทศ | Tomato Salad | 100 | `tomato-salad` | yes | — | food-05.jpg |
| `burrata-tomato-salad` | ชีสบุเรต้าสลัดมะเขือเทศ | Burrata Cheese and Tomato Salad | 490 | `burrata-tomato` | yes | — | food-05.jpg |

#### Seasonal — Avocado (unpublished), 4 items

| Key | TH | EN | Price (THB) | Image | Orderable | Flags | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `crispy-fried-avocado` | อะโวคาโดทอดกรอบ *(site)* | Crispy Fried Avocado | 250 | `fried-avocado` | **no** | seasonal_unconfirmed, thai_is_site_translation | menu-avocado.jpg |
| `grilled-corn-avocado-salad` | สลัดข้าวโพดย่างกับอะโวคาโด *(site)* | Grilled Corn & Avocado Salad | 280 | `corn-avocado-salad` | **no** | seasonal_unconfirmed, thai_is_site_translation | menu-avocado.jpg |
| `crispy-corn-fritters-guacamole` | ข้าวโพดทอดกรอบกับกัวคาโมเล *(site)* | Crispy Corn Fritters with Guacamole | 220 | `corn-fritters` | **no** | seasonal_unconfirmed, thai_is_site_translation | menu-avocado.jpg |
| `burrata-salad-roasted-tomatoes-guacamole` | สลัดบุรัตต้ากับมะเขือเทศอบและกัวคาโมเล *(site)* | Burrata Salad with Roasted Tomatoes & Guacamole | 590 | `burrata-guacamole` | **no** | seasonal_unconfirmed, possible_typo, thai_is_site_translation | menu-avocado.jpg |

#### Rice, 3 items

| Key | TH | EN | Price (THB) | Image | Orderable | Flags | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `basil-beef-rice` | ข้าวกะเพราคลุกเนื้อย่าง | Rice with Stir-Fried Basil and Grilled Beef | 390 | `basil-beef-rice` | yes | — | food-13.jpg |
| `american-fried-rice` | ข้าวผัดอเมริกัน | American Fried Rice | 350 | `american-fried-rice` | yes | — | food-13.jpg |
| `beef-fried-rice` | ข้าวผัดมันเนื้อย่าง | Beef Fried Rice with Grilled Beef | 390 | `beef-fried-rice` | yes | — | food-13.jpg |

#### Side Dishes, 7 items

| Key | TH | EN | Price (THB) | Image | Orderable | Flags | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mashed-potato` | มันบด *(site)* | Mashed Potato | 120 | `mashed-potato` | yes | thai_is_site_translation | food-12.jpg |
| `sauteed-potato` | มันฝรั่งผัด *(site)* | Sauteed Potato | 100 | `sauteed-potato` | yes | thai_is_site_translation | food-12.jpg |
| `french-fries` | เฟรนช์ฟรายส์ *(site)* | French Fries | 90 | `french-fries` | yes | thai_is_site_translation | food-12.jpg |
| `sauteed-green-beans-bacon` | ถั่วแขกผัดเบคอน *(site)* | Sauteed Green Beans Bacon | 120 | `greenbeans-bacon` | yes | thai_is_site_translation | food-12.jpg |
| `garlic-confit` | กระเทียมคอนฟี *(site)* | Garlic Confit | 100 | `garlic-confit` | yes | thai_is_site_translation | food-12.jpg |
| `sauteed-mini-broccoli` | บรอกโคลีเล็กผัด *(site)* | Sauteed Mini Broccoli | 120 | `mini-broccoli` | yes | thai_is_site_translation | food-12.jpg |
| `sauteed-mushrooms` | เห็ดผัด *(site)* | Sauteed Mushrooms | 120 | `mushrooms` | yes | thai_is_site_translation | food-12.jpg |

#### Dessert, 2 items

| Key | TH | EN | Price (THB) | Image | Orderable | Flags | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `creme-brulee-lemon` | เครมบรูเล่เลมอน *(site)* | Crème Brûlée Lemon | 160 | `creme-brulee` | yes | typo_corrected, thai_is_site_translation | food-14.jpg |
| `tiramisu` | ทีรามิสุ *(site)* | Tiramisu | 180 | `tiramisu` | yes | thai_is_site_translation | food-14.jpg |

### Drinks (เครื่องดื่ม)

#### Special Matcha, 12 items

| Key | TH | EN | Price (THB) | Image | Orderable | Flags | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `clear-matcha` | — | Clear Matcha | Hot — / Iced 130 | — | yes | missing_thai_name, missing_image | bev-03.jpg |
| `coconut-matcha` | — | Coconut Matcha | Hot — / Iced 150 | — | yes | missing_thai_name, missing_image | bev-03.jpg |
| `coconut-matcha-cold-foam` | — | Coconut Matcha Cold Foam | Hot — / Iced 165 | — | yes | missing_thai_name, missing_image | bev-03.jpg |
| `matcha-latte-special` | — | Matcha Latte | Hot 120 / Iced 150 | — | yes | duplicate_name, missing_thai_name, missing_image | bev-03.jpg |
| `strawberry-matcha-latte` | — | Strawberry Matcha Latte | Hot — / Iced 165 | — | yes | missing_thai_name, missing_image | bev-03.jpg |
| `earl-grey-matcha-latte` | — | Earl Grey Matcha Latte | Hot — / Iced 165 | — | yes | missing_thai_name, missing_image | bev-03.jpg |
| `red-bean-matcha-latte` | — | Red Bean Matcha Latte | Hot — / Iced 160 | — | yes | missing_thai_name, missing_image | bev-03.jpg |
| `biscoff-matcha-latte` | — | Biscoff Matcha Latte | Hot — / Iced 160 | — | yes | missing_thai_name, missing_image | bev-03.jpg |
| `nutella-matcha-latte` | — | Nutella Matcha Latte | Hot — / Iced 160 | — | yes | missing_thai_name, missing_image | bev-03.jpg |
| `longan-matcha` | — | Longan Matcha | Hot — / Iced 150 | — | yes | missing_thai_name, missing_image | bev-03.jpg |
| `orange-matcha` | — | Orange Matcha | Hot — / Iced 150 | — | yes | missing_thai_name, missing_image | bev-03.jpg |
| `dirty-matcha` | — | Dirty Matcha | Hot — / Iced 130 | — | yes | missing_thai_name, missing_image | bev-03.jpg |

#### Coffee, 13 items

| Key | TH | EN | Price (THB) | Image | Orderable | Flags | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `short-black` | — | Short Black | Hot 80 / Iced — | — | yes | missing_thai_name, missing_image | bev-01.jpg |
| `long-black` | — | Long Black | Hot 80 / Iced — | — | yes | typo_corrected, unspecified_variant, missing_thai_name, missing_image | bev-01.jpg |
| `long-black-coconut` | — | Long Black Coconut | Hot — / Iced 120 | — | yes | missing_thai_name, missing_image | bev-01.jpg |
| `long-black-longan` | — | Long Black Longan | Hot — / Iced 120 | — | yes | missing_thai_name, missing_image | bev-01.jpg |
| `piccolo-latte` | — | Piccolo Latte | Hot 80 / Iced — | — | yes | missing_thai_name, missing_image | bev-01.jpg |
| `latte` | — | Latte | Hot 80 / Iced 80 | — | yes | missing_thai_name, missing_image | bev-01.jpg |
| `cappuccino` | — | Cappuccino | Hot 80 / Iced 80 | — | yes | missing_thai_name, missing_image | bev-01.jpg |
| `mocha` | — | Mocha | Hot — / Iced 80 | — | yes | missing_thai_name, missing_image | bev-01.jpg |
| `ice-coffee` | — | Ice Coffee | Hot — / Iced 80 | — | yes | possible_typo, missing_thai_name, missing_image | bev-01.jpg |
| `dirty-coffee` | — | Dirty Coffee | Hot — / Iced 120 | — | yes | missing_thai_name, missing_image | bev-01.jpg |
| `caramel-latte` | — | Caramel Latte | Hot — / Iced 120 | — | yes | missing_thai_name, missing_image | bev-01.jpg |
| `biscoff-latte` | — | Biscoff Latte | Hot — / Iced 120 | — | yes | missing_thai_name, missing_image | bev-01.jpg |
| `black-orange` | — | Black Orange | Hot — / Iced 120 | — | yes | missing_thai_name, missing_image | bev-01.jpg |

#### Hot Tea, 1 item

| Key | TH | EN | Price (THB) | Image | Orderable | Flags | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `rosemary-tea` | — | Rosemary Tea | 140 | — | yes | missing_thai_name, missing_image | bev-01.jpg |

#### Milky, 5 items

| Key | TH | EN | Price (THB) | Image | Orderable | Flags | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `caramel-fresh-milk` | — | Caramel Fresh Milk | Hot — / Iced 100 | — | yes | missing_thai_name, missing_image | bev-02.jpg |
| `chocolate` | — | Chocolate | Hot — / Iced 100 | — | yes | missing_thai_name, missing_image | bev-02.jpg |
| `strawberry-cocao` | — | Strawberry Cocao | Hot — / Iced 130 | — | yes | possible_typo, missing_thai_name, missing_image | bev-02.jpg |
| `matcha-latte-milky` | — | Matcha Latte | Hot — / Iced 100 | — | yes | duplicate_name, missing_thai_name, missing_image | bev-02.jpg |
| `thai-tea` | — | Thai Tea | Hot — / Iced 100 | — | yes | missing_thai_name, missing_image | bev-02.jpg |

#### Soda, 3 items

| Key | TH | EN | Price (THB) | Image | Orderable | Flags | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `strawberry-soda` | — | Strawberry Soda | 100 | — | yes | missing_thai_name, missing_image | bev-02.jpg |
| `blueberry-soda` | — | Blueberry Soda | 100 | — | yes | missing_thai_name, missing_image | bev-02.jpg |
| `apple-soda` | — | Apple Soda | 100 | — | yes | missing_thai_name, missing_image | bev-02.jpg |

#### Fresh Juice, 4 items

| Key | TH | EN | Price (THB) | Image | Orderable | Flags | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `cold-pressed-watermelon` | — | Cold Pressed Watermelon | 100 | — | yes | missing_thai_name, missing_image | bev-02.jpg |
| `orange-juice-fresh` | — | Orange Juice | 100 | — | yes | duplicate_name, missing_thai_name, missing_image | bev-02.jpg |
| `coconut-water-fresh` | — | Coconut Water | 100 | — | yes | duplicate_name, missing_thai_name, missing_image | bev-02.jpg |
| `longan-juice` | น้ำลำไย | Longan Juice | 80 | — | yes | missing_image | bev-02.jpg |

#### Juice (unpublished), 4 items

| Key | TH | EN | Price (THB) | Image | Orderable | Flags | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `orange-juice-juice` | — | Orange Juice | 100 | — | **no** | duplicate_name, needs_owner_explanation, missing_thai_name, missing_image | bev-01.jpg |
| `coconut-water-juice` | — | Coconut Water | 100 | — | **no** | duplicate_name, needs_owner_explanation, missing_thai_name, missing_image | bev-01.jpg |
| `watermelon-juice` | — | Watermelon Juice | 100 | — | **no** | needs_owner_explanation, missing_thai_name, missing_image | bev-01.jpg |
| `mangosteen-juice` | — | Mangosteen Juice | 200 | — | **no** | needs_owner_explanation, missing_thai_name, missing_image | bev-01.jpg |

#### Draft Beer, 3 items

| Key | TH | EN | Price (THB) | Image | Orderable | Flags | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `hoegaarden-white` | — | Hoegaarden White | 250 ml 180 / 500 ml 295 | — | **no** | promotion_not_active, missing_thai_name, missing_image, alcohol_requires_staff | bev-04.jpg |
| `hoegaarden-rosee` | — | Hoegaarden Rosee | 250 ml 180 / 500 ml 295 | — | **no** | promotion_not_active, possible_typo, missing_thai_name, missing_image, alcohol_requires_staff | bev-04.jpg |
| `stellar` | — | Stellar | 250 ml 180 / 500 ml 295 | — | **no** | promotion_not_active, possible_typo, missing_thai_name, missing_image, alcohol_requires_staff | bev-04.jpg |

#### Bottled Beer, 3 items

| Key | TH | EN | Price (THB) | Image | Orderable | Flags | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `beer-budweiser` | — | Beer Budweiser | 120 | — | yes | missing_thai_name, missing_image, alcohol_requires_staff | bev-04.jpg |
| `beer-singha` | — | Beer Singha | 120 | — | yes | missing_thai_name, missing_image, alcohol_requires_staff | bev-04.jpg |
| `beer-chang-classic` | — | Beer Chang Classic | 110 | — | yes | missing_thai_name, missing_image, alcohol_requires_staff | bev-04.jpg |

#### Whiskey, 1 item

| Key | TH | EN | Price (THB) | Image | Orderable | Flags | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `regency` | — | Regency | 550 (350 ml) | — | yes | volume_in_wrong_field, missing_thai_name, missing_image, alcohol_requires_staff | bev-04.jpg |

#### Soft Drinks, 7 items

| Key | TH | EN | Price (THB) | Image | Orderable | Flags | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mont-fleur` | — | Mont Fleur | 30 | — | yes | missing_thai_name, missing_image | bev-04.jpg |
| `soda-singha` | — | Soda Singha | 30 | — | yes | missing_thai_name, missing_image | bev-04.jpg |
| `singha-lemon-soda` | — | Singha Lemon Soda | 30 | — | yes | missing_thai_name, missing_image | bev-04.jpg |
| `pepsi-original` | — | Pepsi Original | 30 | — | yes | missing_thai_name, missing_image | bev-04.jpg |
| `pepsi-zero` | — | Pepsi Zero | 30 | — | yes | missing_thai_name, missing_image | bev-04.jpg |
| `sprite` | — | Sprite | 30 | — | yes | missing_thai_name, missing_image | bev-04.jpg |
| `ice` | — | Ice | 30 | — | **no** | needs_owner_explanation, missing_thai_name, missing_image | bev-04.jpg |

## 5. Discrepancies between `data/menu.json` (and the reference site) and the scans

Every printed price in `data/menu.json` matches the scans: all 39 dishes and all 38 drinks it lists. The problems are omissions, lost structure, and a few names.

### Missing from `data/menu.json`

1. **The whole COFFEE section (bev-01) is missing.** It has 13 drinks with Hot and Iced prices:
   - Short Black 80/–
   - Long Black 80/(blank)
   - Long Black Coconut –/120
   - Long Black Longan –/120
   - Piccolo Latte 80/–
   - Latte 80/80
   - Cappuccino 80/80
   - Mocha –/80
   - Ice Coffee –/80
   - Dirty Coffee –/120
   - Caramel Latte –/120
   - Biscoff Latte –/120
   - Black Orange –/120

   The bean note is also missing: "bean : Laos Bolaven single-origin (Medium - Dark roasted)".
2. **SPECIAL BLEND is missing (bev-01).** The page prints "Balanced Blend - Bluetamp (+30 THB)", its origins (Brazil, Columbia [sic], Ethiopia) and a Thai tasting note. It reads as a +30 THB bean upgrade. The catalog records it only in the `coffee` category's `source_note` and does not offer it as a choice, because the menu does not say which coffees it applies to.
3. **HOT TEA is missing (bev-01).** It lists Rosemary Tea at 140.
4. **A second juice list is missing (bev-01 "JUICE").** It prints:
   - Orange Juice 100
   - Coconut Water 100
   - Watermelon Juice 100
   - Mangosteen Juice 200

   Orange Juice and Coconut Water repeat the FRESH JUICE list on bev-02 at the same price. Watermelon Juice may be the same drink as "Cold Pressed Watermelon". Mangosteen Juice appears nowhere else. The catalog imports all four as a separate `juice` category, left unpublished.

### Structure lost in `data/menu.json`

5. **MILKY lost its columns.** bev-02 prints MILKY under HOT and ICED columns, and every HOT cell is a dash. `menu.json` flattened each drink to one price, so it no longer shows that these drinks are iced only. The catalog uses Hot and Iced options, with Hot marked unavailable.
6. **SPECIAL MATCHA dashes were stored as zero.** `menu.json` stores a printed dash as `"a": 0`, which a system could read as free. The catalog stores a dash as `price_baht: null` with `available: false`.
7. **Two printed sections were merged.** BOTTLED BEER and WHISKEY are separate headings on bev-04. `menu.json` and the reference site merged them into "Bottled Beer & Spirits" (เบียร์ขวดและสุรา). The catalog restores both sections.
8. **Regency's volume is in the wrong field.** `menu.json` puts "350 มล." in Regency's Thai-name field, and the reference site renders it as a Thai name. The scan prints "( 350 ml. )" under the 550 price. The catalog moves it to `portion_note` and flags the record `volume_in_wrong_field`.
9. **The promotion was paraphrased.** The scan prints "PROMOTION  3 FREE 1". `menu.json` and the site render it as "Promotion — buy 3 get 1 free" and "โปรโมชั่น 3 แถม 1", which is our reading of it. The catalog keeps the printed words in a source note only, and no discount is active.
10. **Items were reordered.** Within categories, `menu.json` reorders items, mostly by price. For example, SPECIAL MATCHA is printed as Clear, Coconut, Coconut Cold Foam, Matcha Latte… and MILKY as Caramel Fresh Milk, Chocolate, Strawberry Cocao, Matcha Latte, Thai Tea. The catalog uses the printed order. `menu.json`'s `star` markers were our editorial picks and were not imported, since the menus make no popularity or signature claims.
11. **Category notes were our own prose.** Notes such as "The counter cuts…" and "Pork, bird, fish — everything the fire touches." were written for the site and were not imported. The beef note now only restates the printed per-weight price. The seasonal note is a neutral availability prompt.

### Thai names

12. **Calamari.** The scan prints "หมึกชุบเกล็ดขนมปังทอดเสิร์ฟ / พร้อมซอสทาร์ทาร์". `menu.json` has "**ปลา**หมึกชุบเกล**ือ**ขนมปังทอดเสิร์ฟพร้อมซอสทาร์ทาร์": it adds ปลา, and turns เกล็ด (crumbs) into เกลือ (salt). The catalog uses the printed text.
13. **Burrata Cheese and Tomato Salad.** The scan prints "ชีสบุ**เร**ต้าสลัดมะเขือเทศ", while `menu.json` has "ชีสบุ**รัต**ต้าสลัดมะเขือเทศ". The catalog uses the printed text. The avocado Burrata Salad, whose Thai is our own translation, still spells it "บุรัตต้า", so it is flagged `possible_typo` until one spelling is chosen.
14. **Grilled Caesar Salad.** The scan shows "กริลลซีซาร์สลัด", with no ์ over the second ล. The font does draw ์ elsewhere on the same page (ซาร์). `menu.json` has "กริลล์ซีซาร์สลัด". The catalog keeps the printed spelling and flags `possible_typo`.
15. **Fish and Chips.** The scan shows "ฟิชแอนดชิปส์", with no ์ over ด; `menu.json` has "ฟิชแอนด์ชิปส์". The catalog keeps the printed spelling and flags `possible_typo`.
16. **14 dishes have no printed Thai name.** They are Prime Rib, the 7 sides, the 2 desserts and the 4 avocado dishes. `menu.json` gives them Thai names without marking those names as translations. The catalog marks them `reference_site_translation`.
17. **Thai category labels are not printed.** No category has a printed Thai label, and "เครื่องดื่ม" for Soft Drinks duplicates the Drinks group name, so the catalog leaves that label empty.
18. **Drinks have no Thai names.** Apart from "Longan Juice (น้ำลำไย)", no drink carries a Thai name on the scans, and `menu.json` has none either.

### English names

19. **`doc/RESEARCH.md` misquotes the striploin misprint.** It records the misprint as "Australalain Striploin", but the scan reads "**Australain** Striploin". The display correction to "Australian Striploin" stands.
20. **"Hoegaarden Rosée" was changed from the print.** `menu.json` added the accent, but the scan prints "Hoegaarden Rosee". The catalog keeps the printed spelling and flags `possible_typo`.
21. **The Long Black name has a stray "80".** The scan prints "Long Black  80" with a blank Iced cell. The catalog displays "Long Black", flags `typo_corrected`, and marks Iced as `unspecified_variant` (unavailable).
22. **Capitalisation was normalised for display.** The scan prints "Beef tongue stew", "Sauteed Green beans Bacon" and "Sauteed Mini broccoli", and `menu.json` title-cases them. The catalog title-cases `name_en` and keeps the printed case in `source_text`. "MB 6-7" is shown as "MB 6–7".
23. **Kept as printed and flagged `possible_typo`:** "Stellar", "Strawberry Cocao" and "Ice Coffee". `menu.json` also keeps these as printed.

### Unused imagery

24. **bev-01 has two unused photos.** It shows bottled juices and a latte with latte art. Neither is in `img/`, and neither shows a specific catalog item, so every drink has `image: null`.

## 6. Questions for the owner

Each answer unblocks the records named.

### Prices and portions

1. **Grilled Lamb Rack** (`grilled-lamb-rack`): what separates **890** from **1,590**: bones, weight, or a sharing size? Please give the Thai and English option names. The dish cannot be ordered until then.
2. **Prime Rib** (`prime-rib`), priced at 490 THB per 100 g:
   - Is there a minimum weight or a usual cut size?
   - May guests ask for a weight?
   - Which doneness choices do you offer?
   - Are the two sauces and the garlic in the menu photo included?
   - How long should a staff quote stay valid?
3. **Wagyu Tenderloin**: is "300 g" a fixed portion, and is it raw or cooked weight? Which doneness choices apply?
4. **Sides**: do any mains include a side? The ribs and fish-and-chips photos show fries. Is the included side a choice, or fixed?
5. **Long Black**: is it served iced, and at what price? The printed name reads "Long Black  80" and the Iced cell is blank.
6. **Special Blend (Bluetamp, +30 THB)**: which coffees can take it, and does it apply to both hot and iced?
7. **Ice (30)**: is this a glass, a bucket, or a per-person charge? It cannot be ordered until then.
8. **MILKY and SPECIAL MATCHA**: are the hot versions really unavailable, as the dashes show? Only Matcha Latte has a hot price. Are the SODA and FRESH JUICE drinks served iced only?

### Duplicates and conflicting lists

9. **Matcha Latte** appears twice: under SPECIAL MATCHA (hot 120 / iced 150) and under MILKY (iced 100). Are these two recipes, two sizes, or one stale price?
10. **JUICE (bev-01) or FRESH JUICE (bev-02)**: which list is current?
    - Is "Watermelon Juice" the same drink as "Cold Pressed Watermelon"?
    - Is Mangosteen Juice (200) available now, and is it seasonal?

### Availability, promotions and alcohol

11. **Seasonal — Avocado**: is it served now, and from when until when? The category stays unpublished until you confirm.
12. **Draft beer "PROMOTION 3 FREE 1"**: is it running? Please confirm:
    - which beers and sizes it covers, and whether sizes can be mixed
    - the start and end dates
    - which drink comes free
    - whether it counts per bill or per round
    - whether it combines with other offers

    The three draft beers cannot be ordered until then.
13. **Alcohol at the table**: what must staff check before serving an order placed from a table?
14. **Regency** is printed under "WHISKEY". Is that the label you want? (Regency is commonly sold as a brandy.)

### Names and spelling

15. **Thai names for the 14 dishes that are printed in English only**: please approve our translations or supply your own. They are Prime Rib, Mashed Potato, Sauteed Potato, French Fries, Sauteed Green Beans Bacon, Garlic Confit, Sauteed Mini Broccoli, Sauteed Mushrooms, Crème Brûlée Lemon, Tiramisu and the four avocado dishes.
16. **Thai names for the 55 drinks**: would you like them shown? If so, please supply the names.
17. **Thai spellings as printed**: should these stay, or be corrected?
    - "กริลลซีซาร์สลัด" (usually กริลล์…)
    - "ฟิชแอนดชิปส์" (usually …แอนด์…)
    - "บุเรต้า" versus "บุรัตต้า": choose one spelling for burrata.
18. **English spellings as printed**: should these stay, or be corrected?
    - "Stellar"
    - "Hoegaarden Rosee"
    - "Strawberry Cocao"
    - "Ice Coffee"
19. **Thai category labels**: none are printed, so every Thai category label is our translation. Coffee, Hot Tea, Juice, Whiskey and Soft Drinks have none at all. Please approve or supply labels.

### Content not on the menu

20. **Descriptions and allergens**: the menus print none, so allergen information is unknown for every item. Please supply verified descriptions and allergen information for any dish you want described.
21. **Drink photos**: there are none. Drinks currently use text-only cards.

## 7. Rules applied in the catalog

- A dash (or a blank cell) means the option is not offered: `available: false`, `price_baht: null`. It never means free.
- **Measured-weight items are never given a fixed price.** Prime Rib is ordered through the staff weigh-and-quote flow (brief §44A).
- **Unlabelled prices get neutral labels.** "Price A" and "Price B" say nothing about size.
- **Printed text is never silently corrected.** Only the three misprints recorded in `doc/RESEARCH.md` are corrected for display (Australian Striploin, Crème Brûlée Lemon, Appetizers), plus the stray "80" in Long Black. Each correction is flagged `typo_corrected`, and the original stays in `source_text`.
- **Duplicate names stay separate records.** Matcha Latte, Orange Juice and Coconut Water are never merged with their namesakes.
- **Nothing that is not printed is claimed.** The catalog makes no claims about allergens, dietary labels, doneness, sizes, origin, popularity or availability. `desc_th` and `desc_en` are empty everywhere.
- **Alt text describes only what the photo shows.** It makes no ingredient or quality claims beyond what is visible.
