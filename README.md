# Rabbit Grill Khao Yai: table QR ordering

A guest scans the card on their table, joins with the 4-digit code their server gives them, and orders from their own phone — Thai first, English on one tap, no app and no account. The kitchen sees the dish the moment it is sent. The guest watches it move from sent to served. The cashier checks the table out when nothing is left open.

One application, two interfaces, one SQLite database:

- **Guest menu** (`/menu`, `/q/<table token>`). Join a table, browse Food and Drinks, customise a dish, send the order, follow each dish live, ask for staff or the bill, and see the visit end at checkout.
- **Staff platform** (`/admin`). Orders board and requests, live tables with QR cards and checkout, menu and availability, insights (Order Stats, Menu Stats, Engagement), payments, annual PDF reports, team, settings and audit — each role sees only its own part: owner, manager, cashier, floor, kitchen.

### See it running, free, in about three minutes

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/MPC0367/rabbit-grill-ordering?quickstart=1)

No install and no card: **[docs/TRY-IT-ON-GITHUB.md](docs/TRY-IT-ON-GITHUB.md)** starts the real application in GitHub Codespaces and gives you an https link a phone can open and scan. For a restaurant that wants to take real orders, **[docs/DEPLOY.md](docs/DEPLOY.md)** is the step-by-step hosting guide.

> **Status: local build, not a production deployment.** Everything here has been run on one Windows laptop, with browsers on the same machine. No real phone, restaurant network, https proxy or hosting has been tested yet. The menu is an unverified draft of the restaurant's printed menus: no owner has approved a price, translation or allergen, so live ordering needs the owner steps in [docs/OWNER-CHECKLIST.md](docs/OWNER-CHECKLIST.md) first. Every screen below is demo data, and the application says so on screen.

Stack: Node 24 (TypeScript runs natively, no build step for the server), Hono, `node:sqlite`, React 19 and Vite 8. The product brief is the acceptance standard; [docs/FEATURE-MATRIX.md](docs/FEATURE-MATRIX.md) maps every brief section to its state.

---

## At the table

On the guest's phone. Prime rib is never added like a normal dish: the guest asks staff to weigh it, and only their confirmation of the quoted weight and price creates the order.

<table>
<tr>
<td width="25%"><img src="docs/screens/join.webp" alt="Join screen showing table 07 and four empty boxes for the code"><b>Joining</b><br>The QR names the table; the 4-digit code comes from the server and changes with every party.</td>
<td width="25%"><img src="docs/screens/menu.webp" alt="Menu with Thai dish names, dotted lines to the prices and photographs"><b>The menu</b><br>Dotted leader lines run from each dish to its price, the way the printed menu reads.</td>
<td width="25%"><img src="docs/screens/item-sheet.webp" alt="Dish detail sheet with options, quantity and a note field"><b>A dish</b><br>Choices, quantity, a note, and a line saying a note is confirmed by staff rather than guaranteed.</td>
<td width="25%"><img src="docs/screens/cart.webp" alt="Draft order list with quantities and a total"><b>Your order</b><br>Still a draft. The bar says, in Thai, that it has not been sent to the kitchen yet.</td>
</tr>
<tr>
<td width="25%"><img src="docs/screens/cart-review.webp" alt="Review screen listing the table, the dishes and the total before sending"><b>Before sending</b><br>Table, dishes, notes and total, with "received" and "accepted by staff" kept apart.</td>
<td width="25%"><img src="docs/screens/track.webp" alt="Tracking timeline with completed steps and their times"><b>Tracking</b><br>Each step carries the time it actually happened. A skipped step says so instead of inventing one.</td>
<td width="25%"><img src="docs/screens/bill.webp" alt="Table bill with lines, charges and total"><b>The bill</b><br>One bill for the table. Dishes not yet accepted are listed apart from the amount due.</td>
<td width="25%"><img src="docs/screens/service.webp" alt="Service sheet with call staff and request the bill"><b>Asking for help</b><br>Call staff, ask for the bill, ask about allergies. Repeated taps never queue twice.</td>
</tr>
</table>

## Behind the pass

Kitchen, floor and cashier. Built for a Friday night: big numbers, one clear action per ticket, and anything that needs attention stated in words as well as colour.

**The orders board** — new, accepted, preparing, almost done, ready. An allergy note is quoted on a full-width band in the guest's own words, and every button carries an exact count.

![Kitchen board with columns from New to Ready and a red allergy band on one ticket](docs/screens/orders-board.webp)

<table>
<tr>
<td width="50%"><img src="docs/screens/tables.webp" alt="Grid of tables showing available, dining and checking out"><b>The floor</b><br>Which tables are free, which are eating, which are paying, and what needs attention.</td>
<td width="50%"><img src="docs/screens/tables-drawer.webp" alt="Table drawer showing the guest PIN, rounds and checkout blockers"><b>One table</b><br>The joining code, every round, the bill, and exactly what still blocks checkout. QR cards print from here, one per table.</td>
</tr>
<tr>
<td width="50%"><img src="docs/screens/requests.webp" alt="Queue of guest requests and prime rib portions waiting to be weighed"><b>Requests</b><br>Guests calling for staff, and the cuts waiting to be weighed and quoted.</td>
<td width="50%"><img src="docs/screens/overview.webp" alt="Overview with cards for rounds to accept, dishes ready and open requests"><b>What needs doing now</b><br>Rounds to accept, dishes ready to run, requests open, bills asked for.</td>
</tr>
<tr>
<td width="50%"><img src="docs/screens/menu-availability.webp" alt="List of dishes with sold-out switches"><b>Sold out tonight</b><br>One tap takes a dish off every phone. It stays off until somebody puts it back.</td>
<td width="50%"><img src="docs/screens/review-queue.webp" alt="Review queue counting unverified items, missing Thai names and ambiguous prices"><b>What the owner must confirm</b><br>Every record came from the restaurant's printed menus. None is approved yet, and the queue says so plainly.</td>
</tr>
<tr>
<td width="50%"><img src="docs/screens/item-editor.webp" alt="Item editor with names, price, photo and source evidence"><b>Editing a dish</b><br>Thai and English, price with its history, the photo, and the printed source it came from.</td>
<td width="50%"><img src="docs/screens/payments.webp" alt="Payments for the day with exceptions listed"><b>Payments</b><br>What was taken today, by whom, and anything that does not reconcile.</td>
</tr>
</table>

## What the owner sees

Every figure says what it counts. Devices are called devices, not people. A dish that was sold out all week is marked as such instead of being called unpopular, and a day with no data looks different from a day with none sold.

<table>
<tr>
<td width="33%"><img src="docs/screens/order-stats.webp" alt="Weekly bar chart of order rounds with today marked partial and upcoming days hatched"><b>Orders by day</b><br>Seven bars, Monday to Sunday. Today is marked partial, days still to come are not drawn as zero, and the comparison refuses to invent growth from nothing.</td>
<td width="33%"><img src="docs/screens/menu-stats.webp" alt="Ranked dishes with servings, share and availability context"><b>What sells</b><br>Most and least ordered, with how many days each dish was actually available beside it.</td>
<td width="33%"><img src="docs/screens/engagement.webp" alt="Engagement page with coverage, active time and the ordering funnel"><b>How guests browse</b><br>Active time only counts a screen someone is actually using, and the page states what it cannot know.</td>
</tr>
</table>

Twelve months of service also print as one PDF archive — 520 pages, Thai and English, generated by the application itself (`npm run report:annual`).

---

The rest of this page is for whoever runs the code.

## Requirements

- Node.js **24 or newer** (`node --version`)
- npm (comes with Node)
- For annual PDF reports, end-to-end tests and screenshots: an installed **Microsoft Edge, Google Chrome or Chromium**. It is found automatically in the standard install paths. Otherwise set `BROWSER_PATH`.
- About 200 MB of free disk for a development database with the synthetic year

## Quick start (development)

```powershell
cd rabbit-grill/ordering
npm ci                  # exact versions from package-lock.json
npm run dev             # seeds an empty database, then starts API + web
```

Open **http://localhost:8344**. Guests start at `/menu` and staff at `/admin`.

On the first start, `npm run dev` seeds `var/rabbit-grill.db`. This takes about 10–20 s and happens before any server starts. The seed contains:

- the draft catalog (95 items from the restaurant's printed menus)
- 12 demo tables, six of them "dining right now". Their PINs are printed in the console.
- demo staff accounts, listed below
- a synthetic, fixture-flagged history from 2025-01-01 to yesterday, so the Insights screens have data

| Demo account (development only) | Password |
| --- | --- |
| `demo-owner` | `rabbit-owner-demo` |
| `demo-manager` | `rabbit-manager-demo` |
| `demo-cashier` | `rabbit-cashier-demo` |
| `demo-floor` | `rabbit-floor-demo` |
| `demo-kitchen` | `rabbit-kitchen-demo` |

These passwords are public. Never use a seeded database for a real restaurant (see [Going live](#going-live)).

Useful variations:

```powershell
$env:PORT=8400; $env:API_PORT=8401; npm run dev    # other ports (bash: PORT=8400 API_PORT=8401 npm run dev)
$env:SEED_HISTORY='0'; npm run dev                 # demo data without the synthetic year (faster, smaller)
$env:SEED_DEMO='0'; npm run dev                    # no demo data at all: create an owner first (below)
npm run db:reset                                   # delete the development database; the next start re-seeds
```

`npm run dev` starts two processes:

- **web**: Vite on `PORT` (default 8344). It is reachable from the network for phone testing, serves only the browser app, and forwards each phone's address to the API.
- **api**: Node on `127.0.0.1:API_PORT` (default `PORT + 1`). It restarts when `server/` or `shared/` changes, and it never seeds, so a save during the first start cannot corrupt the database.

## Try it on phones (same Wi-Fi)

A phone cannot open `localhost` on your laptop. `npm run dev` prints the LAN address it uses, for example:

```
[dev] this computer   http://localhost:8344
[dev] same Wi-Fi      http://192.168.1.141:8344   (Wi-Fi)
[dev] QR cards        http://192.168.1.141:8344   (PUBLIC_BASE_URL not set: first LAN address above)
```

1. Connect the phones to the same Wi-Fi as the laptop. Guest or "isolated" networks block this.
2. When Windows asks, allow Node.js on **private** networks. Otherwise allow inbound TCP on `PORT`.
3. Sign in on the laptop as `demo-manager`. Seat a free table in **Tables** and note the PIN.
4. In **Tables → Manage tables & QR**, print or open that table's card and scan it with a phone. Enter the PIN. A second phone can join the same table with the same PIN.

If the printed address is wrong (VPN, several adapters), set `PUBLIC_BASE_URL=http://<address>:<PORT>` and reprint the cards. [docs/OPERATIONS.md](docs/OPERATIONS.md#multi-device-qr-testing-on-a-lan) has the full procedure and troubleshooting.

## Going live

**Showing it to someone first, without hosting it: [docs/TRY-IT-ON-GITHUB.md](docs/TRY-IT-ON-GITHUB.md).** GitHub Codespaces runs this exact repository in the cloud and gives you an https link a phone can scan, inside the free monthly allowance.

**Putting it on a cloud server with https: [docs/DEPLOY.md](docs/DEPLOY.md).** A
step-by-step guide for a non-developer — costs, Render (`render.yaml`), the domain, the
owner account, QR cards, backups and a go-live checklist. Fly.io (`fly.toml`) is covered
there too.

A condensed checklist for running it yourself. The details are in [docs/OPERATIONS.md](docs/OPERATIONS.md).

```powershell
npm ci
npm run build                                          # client -> dist/
$env:NODE_ENV='production'
npm run admin:create -- --username owner --name "Owner"  # asks for a password (10+ characters)
npm start                                              # app + API on HOST:PORT; never seeds demo data
```

- Set `PUBLIC_BASE_URL` to the address guests will really use: the https domain, or the restaurant LAN address. Then print the QR cards.
- Serve over https behind a reverse proxy, with `TRUST_PROXY_HOPS=1`. On a closed restaurant LAN over plain http, cookies stay non-Secure. The server warns about mismatches when it starts.
- In **More → Settings**, switch the operating mode to *live* only after the owner has verified the menu ([docs/OWNER-CHECKLIST.md](docs/OWNER-CHECKLIST.md)).
- Set up a backup before the first service: `npm run jobs -- backup --out <file>.db --with-reports`.
- Start the server from a context that can launch Edge or Chrome, so annual PDFs can be printed.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development: seed an empty database, then the watched API and the Vite web server |
| `npm run build` | Build the browser app into `dist/`, then precompress the bundles (`.br` / `.gz`) |
| `npm start` | Production entry: one process serving `dist/` and the API. No demo seeding unless `SEED_DEMO=1` |
| `npm run seed` | Migrate and seed an empty development database without starting a server |
| `npm run db:reset` | Delete the development database (refused with `NODE_ENV=production`) |
| `npm run admin:create -- --username <u> [--name "…"] [--role owner]` | Create the first owner, or reset a password, from the server's shell |
| `npm run jobs -- <command>` | Operator jobs: `backup`, `restore` (prints the procedure), `report --year`, `run`, `rollover`, `aggregates`, `expire-quotes` |
| `npm test` | Unit and integration tests (real server processes, temporary databases) |
| `npm run e2e` | Browser journeys against a seeded throwaway instance ([docs/TESTING.md](docs/TESTING.md)) |
| `npm run shots` | Visual QA screenshots plus a contact sheet in `test/visual/out/` |
| `npm run typecheck` | TypeScript check of server, client, scripts and tests |
| `npm run i18n:check` | Every translation key exists in Thai and English |
| `npm run assets` | Rebuild the processed menu photographs in `public/media/` |
| `npm run pdf:pages -- <file.pdf> [--pages 1-3,last]` | Render pages of a generated PDF to PNG, to look at the printed report itself |

Run `npm run e2e` and `npm run shots` from a normal desktop terminal (PowerShell on Windows). They start the installed browser.

## Configuration

Copy `.env.example` to `.env`. A variable set in the shell always wins over `.env`. The main settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `8344` / `0.0.0.0` | Where the app listens (the web port in development) |
| `API_PORT` | `PORT + 1` | Development only: the API behind Vite, always on 127.0.0.1 |
| `PUBLIC_BASE_URL` | dev: LAN address; start: `http://localhost:PORT` | The address printed in table QR codes |
| `DATABASE_PATH` / `REPORTS_DIR` | `var/rabbit-grill.db` / `var/reports` | The data to back up |
| `NODE_ENV` | unset | `production` for real installs (refuses seeding and resets) |
| `COOKIE_SECURE` | unset: follows the `PUBLIC_BASE_URL` scheme (https = Secure) | Secure cookies. Leave it unset: forcing it on over plain http stops everyone signing in |
| `TRUST_PROXY_HOPS` | `0` | The number of reverse proxies in front of the app (`npm run dev` uses 1 for its own Vite proxy) |
| `SEED_DEMO` / `SEED_HISTORY` | off; `npm run dev` and `npm run seed` set them | Development fixtures (no other entry point seeds) |
| `BROWSER_PATH` | auto | The Edge/Chrome/Chromium used for PDFs and tests |

The restaurant's own settings (charges, payment methods, hours, services, PIN policy, alcohol, retention, roles) are edited in **More → Settings**, not in `.env`. Every default there is a proposal until the owner confirms it.

## Tests and verification

The latest results, what they prove and what is not covered are in [docs/TESTING.md](docs/TESTING.md). In short:

- `npm test`: unit tests plus integration tests over real HTTP, covering authorization, money, state machines, idempotency, races, realtime catch-up, checkout, reports and insights.
- `npm run e2e`: two or more real browser sessions against one instance. It covers brief 31 scenarios 1, 2, 12 and 13, the weighed-cut flow, checkout reset, the offline guest, pause and resume, and the annual PDF.
- `npm run shots`: guest screens at 320, 390, 768 and 1440 px, and staff screens at 390, 768, 1024 and 1440 px, in both languages. Each screen is audited for overflow, Thai line height, text size and touch targets.

All of these are local checks on one computer. They are not a production, real-phone or restaurant-network check.

## Documentation

| File | Contents |
| --- | --- |
| [docs/TRY-IT-ON-GITHUB.md](docs/TRY-IT-ON-GITHUB.md) | Running the real application in GitHub Codespaces for a demo: the https link, making it openable on a phone, what it costs, what it cannot be used for |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Deploying to a cloud server with https, written for a non-developer: cost, Render blueprint, domain and DNS, owner account, QR cards, daily running, backups, updates, Fly.io, go-live checklist |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | First admin, LAN QR testing, backup and restore, deployment preparation, environment variables, PDF browser context |
| [docs/OWNER-CHECKLIST.md](docs/OWNER-CHECKLIST.md) | What the restaurant must verify or supply before live ordering (menu, translations, prices, allergens, photos, charges, tables, services, payments, hours, alcohol, 21 open questions) |
| [docs/FEATURE-MATRIX.md](docs/FEATURE-MATRIX.md) | Every brief requirement: Implemented, Verified (with evidence), Needs owner content, or Deferred |
| [docs/TESTING.md](docs/TESTING.md) | Test suites, latest results, scenario coverage, known gaps |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack, layout and conventions |
| [docs/API.md](docs/API.md) | HTTP API and realtime events |
| [docs/CLIENT.md](docs/CLIENT.md) | Client structure and shared hooks |
| [docs/DESIGN.md](docs/DESIGN.md) · [docs/UI-KIT.md](docs/UI-KIT.md) | Design system and component kit (reference mocks in `design-lab/final/`) |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Decision log |
| [docs/source-audit.md](docs/source-audit.md) | Catalog audit against the restaurant's printed menus |

## Not in V1

These are deliberately not built:

- online payment (the adapter boundary exists; no provider is connected)
- POS, external KDS or bank reconciliation
- split bills, tips and room charges
- loyalty, inventory and multiple branches
- promotional pricing (the draft-beer offer is recorded but not active)
- the "Needs clearing" table state

[docs/FEATURE-MATRIX.md](docs/FEATURE-MATRIX.md) lists every deferred item.
