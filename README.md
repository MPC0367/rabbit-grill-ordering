# Rabbit Grill Khao Yai: table QR ordering

One application with two interfaces over one SQLite database:

- **Guest menu** (`/menu`, `/q/<table token>`). A guest scans the table QR, joins the current visit with the PIN staff give at seating, browses Food and Drinks, sends orders, follows each dish live, asks for staff or the bill, and sees the visit end at checkout. Thai by default, English on one tap. No account or app.
- **Staff platform** (`/admin`). Orders board and requests, live tables with checkout, menu and availability, insights (Order Stats, Menu Stats, Engagement), payments, annual PDF reports, team, settings and audit. Access depends on the role: owner, manager, cashier, floor or kitchen.

Stack: Node 24 (TypeScript runs natively), Hono, `node:sqlite`, React 19 and Vite 8. The product brief is the acceptance standard. [docs/FEATURE-MATRIX.md](docs/FEATURE-MATRIX.md) maps every brief section to its state.

> **Status: local build, not a production deployment.** Everything below has been run on one Windows laptop, with browsers on the same machine. No real phone, restaurant network, https proxy or hosting has been tested yet. The menu is an unverified draft of the restaurant's printed menus: no owner has approved a price, translation or allergen, so live ordering needs the owner steps in [docs/OWNER-CHECKLIST.md](docs/OWNER-CHECKLIST.md) first.

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

A condensed checklist. The details are in [docs/OPERATIONS.md](docs/OPERATIONS.md).

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
