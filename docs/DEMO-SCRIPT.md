# Showing it to the restaurant

A rehearsed path through the system that does not hit a dead end. Roughly ten
minutes. Everything here was checked against the seeded demo restaurant.

You need two screens: a laptop for the staff side, and a phone for the guest
side. Both must reach the same server (same Wi-Fi for a laptop install, or the
same https link for a Codespaces one).

## Before they arrive

1. Start the system. The terminal prints the open tables and their PINs:

   ```
   ======== DEVELOPMENT ONLY - tables open right now (fixture PINs) ========
       table 01  PIN 7352
       ...
   ```

   Leave that window open. It is the only place the PINs are all visible at once.

2. On the laptop, sign in at `/admin` as `demo-owner` / `rabbit-owner-demo`.
3. On the phone, open the table card for the table you picked and join it, so
   you know the link works before anyone is watching. Then leave the page open.
4. Pick **table 02, 05, 08 or 11** if you want to seat a party from scratch, or
   **table 01, 03, 04, 06, 07 or 09** if you want one that is already dining.

## The path

**1. Start at the table, not the admin.** Scan the QR card with the phone.
Show the join screen naming the table, type the PIN, and you are on the menu.
That is the whole guest onboarding: no app, no account, no typing a table
number.

**2. Order something.** Appetizers → **Corn Rib** (฿150) is the safest dish in
the catalog: one tap, no options to explain. Add **French Fries** (฿90) so the
order has two lines. Send it.

**3. Switch to the laptop.** The order is already on the **Orders** board — it
arrives by itself, no refresh. Walk the columns: new → accepted → preparing →
almost done → ready. Press *Accept* and watch the phone update at the same
time. That simultaneity is the thing worth showing; do it slowly.

**4. Show the allergy band.** On the phone, add **Grilled Caesar Salad** with a
note about an allergy. On the board it appears as a full-width red band
quoting the guest's own words, untranslated. Say that the system never edits
or translates what a guest typed about an allergy.

**5. Show the prime rib flow.** This is the signature of the whole build, and
it looks like a bug if you are not expecting it. On the phone, open **Prime
Rib** (ไพร์มริบ). There is **no Add button** — only *Ask staff to weigh*. Tap
it. On the laptop, go to **Orders → Requests**: the cut is waiting to be weighed. Enter
a weight, and the quote goes back to the phone at ฿490 per 100 g for the guest
to accept. Only their acceptance creates the order.

   Say why: a weighed cut has no price until it is on the scale, so the system
   refuses to pretend it does.

**6. Show the floor.** **Tables** — who is free, who is eating, who is paying.
Open table 07's drawer: the join PIN under **Guest access** (press **Show PIN**), every round, the bill,
and what still blocks checkout.

**7. Show the numbers.** **Insights → Order Stats**. Point at today's bar being
marked partial and the days ahead not drawn as zero. Then **Menu Stats**: least
ordered dishes carry how many days they were actually available, so a dish that
was sold out all week is not called unpopular.

**8. Close with the QR cards.** **Tables → Manage tables & QR**. One card per
table, printable. This is what the restaurant physically puts on the tables.

## What not to tap

| Avoid | Why |
| --- | --- |
| **Drinks → Coffee, Special Matcha, Milky, Draft Beer** | 33 items, none with a price. The restaurant's printed menus do not show prices for these, so nothing can be added. All four categories look dead. |
| **Soft Drinks → Ice** | The one item in an otherwise working list that cannot be ordered. |
| **Beef Selection → Grilled Lamb Rack** | No price on the printed menu. It sits directly under the beef dishes you will be reaching for. |
| **Table 10** | It is checking out. A phone joins fine and then cannot order anything. |
| **Table 12** | Disabled on purpose — useful if you want to show a table taken out of service, confusing if you do not. |

If the client taps one of these anyway, the honest answer is the good answer:
*"the menu is exactly what your printed menus say, and your printed menus do
not price the coffee. Give me the prices and they go live the same day."*
That is the point of the review queue in **Menu → Review**.

## Safe dishes

Any of these can be ordered without surprises:

| Category | Pick |
| --- | --- |
| Appetizers | Corn Rib ฿150, Nashville Hot Chicken ฿240, Fried Sweet Potato ฿180 |
| Beef Selection | Australian Striploin ฿590, Grilled Tongue ฿590, Wagyu Tenderloin ฿1,990 |
| From the Grill | Grilled Pork ฿390, Grilled Baby Chicken ฿590, Fish and Chips ฿490 |
| Side Dishes | French Fries ฿90, Mashed Potato ฿120, Sauteed Mushrooms ฿120 |
| Salads | Grilled Caesar Salad ฿260, Tomato Salad ฿100 |
| Rice | American Fried Rice ฿350 |
| Soft Drinks | Pepsi Original ฿30, Sprite ฿30 (not Ice) |
| Fresh Juice | Orange Juice ฿100, Coconut Water ฿100 |
| Dessert | Tiramisu ฿180, Crème Brûlée Lemon ฿160 |

## Say this once, early

Every price, dish and figure on screen is a draft taken from their own printed
menus, and no one from the restaurant has approved any of it yet. The app says
so itself — there is a **Demo data** banner on every screen, and in live mode
it refuses to sell an unapproved item at all. Saying it first makes the banner
look like rigour. Letting them find it makes it look like an excuse.

What they need to supply before real service is in
[OWNER-CHECKLIST.md](OWNER-CHECKLIST.md): prices for the drinks, allergens,
and sign-off on the 95 items.

## If something goes wrong

| | |
| --- | --- |
| Phone cannot open the address | It is on a different network, or Windows is blocking Node on private networks. Check the `same Wi-Fi` line the terminal printed. |
| QR card opens nothing | The cards encode the address printed as `QR cards` at startup. If the laptop changed network since you printed them, reprint. |
| Sign-in screen keeps returning (Codespaces) | You are in the VS Code preview panel. Open the Forwarded Address in a real browser tab. |
| Orders board not updating | It falls back to polling by itself within a few seconds. Reload only if it is still stale after that. |
| You need a clean restaurant | `npm run db:reset` then start again — new PINs, no history. Takes about 20 seconds, and the terminal prints the new PINs. |
