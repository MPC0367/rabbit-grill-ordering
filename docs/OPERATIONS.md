# Operations

How to set up, run, test on phones, back up and prepare a deployment of the ordering platform. [README.md](../README.md) has the quick start; this file has the details.

**Deploying to a cloud server with https: [DEPLOY.md](DEPLOY.md).** It walks a non-developer through Render (`render.yaml`) or Fly.io (`fly.toml`) click by click, with costs, the domain, the owner account, the QR cards and a go-live checklist. This file stays the reference for *what* each setting, job and procedure does; DEPLOY.md is the *how*, on a host.

**What has been verified.** Everything here was run on one Windows 11 laptop with Node 24, Microsoft Edge, and browsers on that laptop or reaching its LAN address. The following have **not** been tested:

- a real phone on a restaurant network
- an https reverse proxy
- a hosted server, or a Linux service
- restoring a backup onto a different machine

Treat those sections as preparation notes, not checked procedures.

## Contents

1. [What runs and what to keep](#what-runs-and-what-to-keep)
2. [Environment variables](#environment-variables)
3. [First admin](#first-admin)
4. [Local startup](#local-startup)
5. [Multi-device QR testing on a LAN](#multi-device-qr-testing-on-a-lan)
6. [Backup and restore](#backup-and-restore)
7. [Deployment preparation](#deployment-preparation)
8. [Annual PDFs: the browser context](#annual-pdfs-the-browser-context)
9. [Background jobs](#background-jobs)

## What runs and what to keep

- **One Node process** (`npm start`) serves the built browser app (`dist/`) and the API on `HOST:PORT`. It needs a persistent disk, so it cannot run serverless.
- **One SQLite database** (`DATABASE_PATH`, default `var/rabbit-grill.db`) in WAL mode. Next to it are `-wal` and `-shm` files. It holds everything: menu, tables, visits, orders, bills, payments, staff, settings, analytics and audit.
- **Report files** (`REPORTS_DIR`, default `var/reports/<year>/<job>`) hold the generated annual PDFs and data-export ZIPs. The database lists them, but the files live on disk.
- **Menu photographs** are in `public/media/`, which is part of the source tree and is copied into `dist/` by the build.

Back up the database and `REPORTS_DIR` together (see [Backup and restore](#backup-and-restore)).

## Environment variables

Put these in `.env` (copy from `.env.example`) or in the service environment. A variable set in the real environment always wins over `.env`. Restaurant policy lives in **More → Settings**, not here.

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | unset | `production` on a real install. Seeding (`SEED_DEMO`, `npm run seed`) and `npm run db:reset` are then refused. |
| `PORT` | `8344` | Production: the app and API port. Development: the browser (Vite) port. |
| `HOST` | `0.0.0.0` | Bind address. `0.0.0.0` accepts connections from the LAN. Use `127.0.0.1` when a reverse proxy on the same machine is the only client. |
| `API_PORT` | `PORT + 1` | Development only. The API behind Vite listens on `127.0.0.1:API_PORT`. |
| `PUBLIC_BASE_URL` | `npm run dev`: `http://<first LAN address>:PORT`. Otherwise `http://localhost:PORT`. | The origin printed in every table QR code. The server warns at start when it is a localhost address. Reprint all cards after changing it. |
| `TRUST_PROXY_HOPS` | `0` | The number of reverse proxies in front of the app. The client address for rate limits is then read from `X-Forwarded-For` (the Nth address from the right). Never set it higher than the real number, or clients could choose their own address. The server warns once if `X-Forwarded-For` arrives while this is `0`. `npm run dev` ignores the setting and runs its API with `1`, because Vite is exactly one proxy and forwards each phone's address (D-DT-06). |
| `COOKIE_SECURE` | unset: follows the scheme of `PUBLIC_BASE_URL` (`https://` = Secure) | Leave it unset. Browsers drop Secure cookies over plain http, which stops staff signing in and guests joining, so forcing `1` on a plain-http LAN locks everyone out; `0` switches Secure off behind https. The server warns at start about a mismatch (D-S8-09). |
| `DATABASE_PATH` | `var/rabbit-grill.db` | Keep it on a local disk, not a network share, because SQLite locking needs a local file system. |
| `REPORTS_DIR` | `var/reports` | Annual PDFs and data exports. |
| `SEED_DEMO` | off | Seeds an **empty** database with the draft catalog, demo tables and demo staff accounts, whose passwords are public. Nothing seeds unless it is set: `npm run dev` and `npm run seed` set it themselves, and no other entry point does, not even a bare `node server/main.ts` (D-S8-30). |
| `SEED_HISTORY` | on whenever seeding | Adds a synthetic fixture year from 2025-01-01 to yesterday (about 140 MB). |
| `BROWSER_PATH` | auto-detected | Edge, Chrome or Chromium for PDFs (see [Annual PDFs](#annual-pdfs-the-browser-context)). |
| `STAFF_SESSION_HOURS` | `14` | Staff sign-in lifetime. |
| `GUEST_SESSION_HOURS` | `12` | Guest session lifetime. A session also ends when its visit closes. |
| `LOG_REQUESTS` | `0` | `1` logs one line per API request: method, route pattern, status and time. Query strings and bodies are never logged. |
| `SERVE_CLIENT` | `1` | `0` stops the API from serving `dist/`. `npm run dev` sets this itself. |
| `SERVE_SOURCEMAPS` | `0` | `1` serves `dist/assets/*.map`. Leave it off in production. |
| `RETENTION_JOB` | on (off under `NODE_ENV=test`) | The daily data-retention task ([Background jobs](#background-jobs)). |
| `RG_ADMIN_PASSWORD` | unset | Read only by `npm run admin:create`, for unattended installs. Set it in the shell for that one command. Never store it in `.env`. |
| `PAYMENT_PROVIDER`, `PAYMENT_PROVIDER_SECRET` | empty | Reserved. Online payment is deferred in V1, and setting these enables nothing. |

## First admin

A real install starts from an **empty** database and never seeds demo data.

```powershell
$env:NODE_ENV = 'production'
npm run admin:create -- --username owner --name "Khun Owner"
# Password for owner (min 10 characters):   <- typed, not echoed
```

- The command migrates the database if needed, then creates an active **owner**. Shell access to the server is the authentication for this step.
- Other roles: `--role manager|cashier|floor|kitchen`. Most staff are easier to add in the app.
- **Password recovery.** Run the same command for an existing username. It sets the new password, reactivates the account, clears the lockout and signs out that account's sessions. The change is audited as `staff.password_reset_cli`.
- **Unattended installs.** Pass the password in `RG_ADMIN_PASSWORD` in the environment of that one command, from your deployment tool's secret store. Do not write it to disk.
- The password must be 10–256 characters. Passwords set later in the app also may not contain the username or display name.

Then sign in at `/admin/login` and:

1. **More → Team.** Create one account per person, so every action is attributed to someone. Give each the narrowest role that fits. The role matrix is in `shared/permissions.ts`, and owners can adjust it in Settings. There is always at least one active owner.
2. **More → Settings.** Work through [OWNER-CHECKLIST.md](OWNER-CHECKLIST.md): restaurant name, charges, payment methods, hours, services, join PIN policy, alcohol, analytics notice and retention.
3. **Operating mode.** Leave it on *demo* while testing. Switch to *live* only when the menu is verified: live mode orders only items the owner has verified.

**If a database was ever seeded** (for example, a trial run that became the real one), it contains `demo-owner`, `demo-manager` and the other demo accounts with public passwords.

- **Recommended:** start again from an empty database.
- **Otherwise:** deactivate every `demo-*` account in **More → Team** before anyone relies on the system. The server refuses to switch the operating mode to *live* while an active demo account exists (`demo_accounts_active`, D-S8-11). **More → Settings → Operating mode** then offers "Deactivate demo accounts and switch", which retires them, signs them out, audits it and switches in one transaction (D-S8-27). It is refused while the acting owner is itself a demo account, or if no real owner would remain, so create the real owner first.
- In live mode, a demo account can neither sign in nor use an existing session. The Team page marks these accounts as demo data.
- Demo history is flagged as fixture data and is excluded from real reports, but it stays in the database.

## Local startup

### Development

```powershell
npm ci
npm run dev
```

1. If `var/rabbit-grill.db` has no menu yet, the seed runs to completion first. It takes about 10–20 s and prints the demo accounts and the PINs of the open demo tables. Skip it with `SEED_DEMO=0`, or skip only the synthetic year with `SEED_HISTORY=0`.
2. The API starts on `127.0.0.1:API_PORT` under `node --watch`. Saves in `server/` or `shared/` restart it, and it never seeds.
3. Vite starts on `HOST:PORT`, proxies `/api` and `/files` to the API, and serves only `client/`, `shared/`, `public/` and `node_modules/` (`scripts/vite-dev.ts`). The database, report files and server source are never served, even to the LAN.
4. The proxy adds `X-Forwarded-For` and the API runs with `TRUST_PROXY_HOPS=1`, so join and sign-in limits count each phone separately instead of treating the whole Wi-Fi as one client (D-DT-06). A phone that sends the header itself cannot escape its own budget: the proxy appends the real address last.

**If the first seed was interrupted** (closed window, crash), the database holds a catalog without its history or live tables. It is marked as unfinished: `npm run dev` and `npm run seed` refuse it and say so, and the server warns at start (D-S8-29). Run `npm run db:reset` and start again.

### Production build on this computer

```powershell
npm run build
npm run seed          # optional: demo data for a local trial (development database only)
npm start
```

`npm run build` is two steps: `vite build`, then `scripts/precompress.ts`, which writes a `.br` and `.gz` beside every bundle above 1 KB in `dist/assets`. The server sends those when the browser accepts them, so phones on restaurant Wi-Fi get maximum-ratio Brotli and the one process does not compress the same bundle again for every guest. Skipping the second step costs nothing but speed: the server then gzips on the fly (D-DT-07).

`npm start` is `scripts/start.ts` → `server/main.ts`. It never seeds by itself, and it warns when `NODE_ENV` is not `production` or `dist/` has not been built. Open `http://localhost:8344`.

## Multi-device QR testing on a LAN

A phone cannot open `http://localhost:8344`, because `localhost` on the phone is the phone itself. QR codes must carry an address the phone can reach.

### Network conditions

- The phones and the computer are on the **same network and subnet**, for example the restaurant Wi-Fi.
- The Wi-Fi does **not isolate clients**. Guest networks and some mesh "guest mode" settings block phone-to-laptop traffic.
- The computer's firewall allows inbound TCP on `PORT`:
  - Windows asks the first time Node listens. Choose **Private networks**.
  - If you missed the prompt, an administrator can add a rule. For example, in an elevated PowerShell: `New-NetFirewallRule -DisplayName "Rabbit Grill 8344" -Direction Inbound -Protocol TCP -LocalPort 8344 -Profile Private -Action Allow`.
  - The Wi-Fi network profile must be *Private*, not *Public*.
- VPN clients can hide the LAN or add adapters. Disconnect them for the test.
- The computer's address should not change during a test. For longer trials, reserve it in the router (a DHCP reservation), because printed cards stop working when the address changes.

### Procedure

1. Start the app:
   - `npm run dev`. It picks the first LAN address and prints it, for example `QR cards http://192.168.1.141:8344`. Check that this is the Wi-Fi address (`ipconfig` / `ip addr`).
   - Or the production build: set `PUBLIC_BASE_URL=http://192.168.1.141:8344`, then `npm start`.
   - If the address is wrong, set `PUBLIC_BASE_URL` explicitly and restart.
2. On a phone, open `http://<address>:<PORT>/menu`. If the menu loads, the network path works.
3. On the laptop or a staff tablet, sign in (demo: `demo-manager` / `rabbit-manager-demo`). Seat a free table in **Tables**, and keep the PIN dialog open.
4. **Tables → Manage tables & QR.** Print the table's card, or show it on screen. The card holds only the table's permanent opaque token, never the PIN.
5. Phone A scans the card, enters the PIN, adds dishes and sends an order. It appears on the staff **Orders** board without a reload.
6. Phone B scans the same card and enters the same PIN. Its draft is empty (drafts are per device), it sees the same table rounds, and it gets the same bill.
7. Staff advance the round (Accept → Start preparing → Almost done → Ready → Served). Both phones update live.
8. Finish with **Start checkout → Finalise bill → Record payment → Complete checkout**. Both phones show the visit has ended, and the table is Available again.

`npm run e2e` automates steps 3–8 with browser sessions on one computer (see [TESTING.md](TESTING.md)). It checks that the QR card URL is not a localhost address. It does not replace a real-phone check.

### Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| The phone cannot open the address at all | Firewall, client isolation, a different network or VPN | Check the conditions above. Try `http://<address>:<PORT>/api/health` in the phone browser. |
| The QR opens `localhost` or an old address | `PUBLIC_BASE_URL` was unset or changed | Set it, restart, reprint the cards |
| Staff sign in, then land back on the login page | Secure cookies over plain http (`COOKIE_SECURE=1` without https) | Remove `COOKIE_SECURE` or serve https. The server prints a warning at start. |
| "Too many attempts" when joining | Too many **failed** joins from one address (10 a minute), or a PIN lockout. After 5 wrong PINs a visit locks for 5 minutes, then 15 minutes, and the third lockout holds until staff rotate the PIN (D-S8-07). | Wait, or rotate the visit PIN in the table drawer (this also clears the lockout). The table tile shows a locked PIN. |
| A joined phone sees "visit ended" | Staff completed checkout, rotated the QR token or revoked guests | Ask staff for the current PIN and scan again |
| Orders appear only after a few seconds | The live stream is blocked (some proxies), so the app falls back to polling every 5 s | Expected on such networks. See the proxy notes below. |

**Development server on a network.** `npm run dev` exposes Vite on `PORT` so phones can reach it. It serves only the browser app, and the API listens on `127.0.0.1` only. Even so, a development server is not hardened. Use it on a trusted network for testing, and use `npm run build` + `npm start` for anything guests rely on.

## Backup and restore

### Taking a backup

```powershell
npm run jobs -- backup --out D:\rg-backups\rabbit-grill-2026-09-17.db --with-reports
```

- The command writes a consistent, compacted copy with SQLite `VACUUM INTO` **while the server keeps running**. The fixture-sized database (about 140 MB) copied in under a second on the test laptop.
- `--with-reports` also copies `REPORTS_DIR` to `<file>.db.reports/`. Without it, copy `REPORTS_DIR` yourself.
- The command refuses to overwrite an existing file, so use a dated name.
- **Do not copy the live `.db` file with Explorer or `cp`** while the server runs. Recent changes sit in the `-wal` file, and a plain copy can be inconsistent.

Before live operation:

1. **Schedule it.** Examples:
   - Windows Task Scheduler, daily after closing: `cmd /c cd /d C:\rabbit-grill\ordering && npm run jobs -- backup --out D:\rg-backups\rg-%DATE:~-4%%DATE:~3,2%%DATE:~0,2%.db --with-reports`. Check how `%DATE%` is formatted on that machine.
   - systemd timer or cron: `cd /srv/rabbit-grill/ordering && npm run jobs -- backup --out /var/backups/rg/rg-$(date +%F).db --with-reports`
2. **Keep copies off the machine.** Use a USB drive rotated weekly, or a cloud folder. The database contains staff password hashes, guest notes and payment records, so store backups as privately as the server.
3. **Prune old copies** on a schedule you choose. The backup command never deletes anything.
4. **Test a restore** on another machine or folder before you rely on the backups.

### Restoring

`npm run jobs -- restore` prints this procedure with your real paths. Restoring is deliberately manual:

1. **Stop the server**, and make sure no `npm run jobs` command is running.
2. Move the current files aside, in case you need them: `rabbit-grill.db` → `rabbit-grill.db.before-restore`, plus its `-wal` and `-shm` files if present.
3. Copy the backup file to `DATABASE_PATH`.
4. If the backup was made with `--with-reports`, copy `<backup>.reports` back to `REPORTS_DIR`.
5. **Start the server.** Newer migrations are applied automatically. Report jobs that were generating when the backup was taken are queued again.
6. Sign in. Check **Reports → Annual archive**, the latest orders and the table grid before you reopen service.

What a restore means during service:

- **Everything after the backup is gone**: orders, payments, visits and guest sessions.
  - Phones that joined after the backup must rejoin with a PIN from staff.
  - Re-enter orders already cooked or served with **Enter paper order** on the Orders board (managers). They are recorded without sending a second cooking ticket.
- **Reload open staff and guest pages anyway.** Pages follow the restored database by themselves: when the server's event cursor is lower than the page's, the page takes the server's cursor and refetches (D-K-01, unit-tested). A reload is still the quickest way to be sure every screen shows the restored state.
- Annual reports generated after the backup are no longer listed. Generate them again.

## Deployment preparation

These notes prepare a deployment. **None of these steps has been exercised on a real host.**

For a hosted install, the step-by-step version of this section is [DEPLOY.md](DEPLOY.md) (Render or Fly.io, written for a non-developer). Read on for the underlying requirements and for installs you run yourself.

### Target

The app is one long-running Node 24 process with a local disk. There are two sensible targets:

- **A small always-on computer in the restaurant** (mini-PC or NUC). Guests reach it over the restaurant Wi-Fi, and it keeps working when the internet is down.
- **A small VPS.** Guests reach it over the internet with https. Every phone then needs mobile data or Wi-Fi internet.

Serverless platforms and multiple instances do not fit. The single process holds the only database connection, the live-event hub and the job timers.

### Install and upgrade

```bash
git clone <repo> rabbit-grill-ordering && cd rabbit-grill-ordering   # or copy the folder; never copy var/ from a dev machine
npm ci
npm run build
cp .env.example .env    # edit: NODE_ENV=production, PUBLIC_BASE_URL, HOST, TRUST_PROXY_HOPS, paths
npm run admin:create -- --username owner --name "Owner"
npm start
```

To upgrade:

1. Take a backup.
2. Update the code.
3. Run `npm ci && npm run build`.
4. Restart.

Migrations in `server/db/migrations/` run on start. Applied migrations are never edited.

### Keep it running

- **Windows.** Use a Task Scheduler task "At log on" or "At startup" that runs `npm start` in the app folder. Use a real user account (see [Annual PDFs](#annual-pdfs-the-browser-context)), and set the task to restart on failure.
- **Linux.** Use a systemd service, running as an ordinary user, not root:

  ```ini
  [Service]
  WorkingDirectory=/srv/rabbit-grill/ordering
  Environment=NODE_ENV=production
  ExecStart=/usr/bin/node scripts/start.ts
  Restart=on-failure
  User=rabbitgrill
  ```

- Health check: `GET /api/health` → `{"ok":true,...}`.
- Logs go to stdout and stderr (`[server]`, `[jobs]`, `[seed]`, `[start]`). They never contain tokens, PINs, passwords or guest notes.

### https and a reverse proxy

- **Put a reverse proxy in front** for anything beyond a closed LAN, for example Caddy, nginx or a tunnel. Then set:
  - `PUBLIC_BASE_URL=https://order.example.com` (cookies become Secure automatically)
  - `TRUST_PROXY_HOPS=1`
  - `HOST=127.0.0.1` when the proxy runs on the same machine
- **Live updates use Server-Sent Events** on `/api/guest/events` and `/api/staff/events`. The app sends `Cache-Control: no-transform` and `X-Accel-Buffering: no`. The proxy must not buffer these responses and must allow long-lived connections (idle timeout above 60 s). If streaming fails, clients fall back to polling every 5 s.
- Minimal Caddy example (untested here):

  ```
  order.example.com {
      reverse_proxy 127.0.0.1:8344 {
          flush_interval -1
      }
  }
  ```

- The QR base URL must be final before the cards are printed. Rotating a table's QR (**Tables → Manage tables & QR → Rotate QR**) makes its old card stop working at once.

### Before the first real service

- `NODE_ENV=production`, with no demo accounts active (see [First admin](#first-admin)).
- The owner checklist is done, and the operating mode is **live** ([OWNER-CHECKLIST.md](OWNER-CHECKLIST.md)).
- `PUBLIC_BASE_URL` is final, and the cards are printed and scanned from a real phone.
- Backups are scheduled, and one restore has been tested.
- An annual PDF generates on this machine: `npm run jobs -- report --year <year>`.
- The system clock is correct (NTP). Times are stored in UTC and reported in Asia/Bangkok.
- Staff know the offline procedure: paper orders, then **Enter paper order** on the Orders board once the system is back.
- **Retention periods are confirmed** (**Settings → Data retention**). A daily task removes, past each horizon:
  - guest note text
  - feedback comments
  - raw analytics events (only once their daily aggregates exist)
  - audit entries

  Orders, visits, bills and payments are never touched. **Settings → Data retention** shows when the task last ran and how far raw events have been removed. Preview a run with `npm run jobs -- retention --dry-run` (D-S8-02).

## Annual PDFs: the browser context

Annual PDF reports are HTML printed by an installed Chromium-family browser (`scripts/browser.ts`, puppeteer-core). The browser runs headless with a throwaway profile and exits with the server.

- **Start the server from a context that can launch a desktop browser.** A normal logged-in PowerShell or Terminal session works, as does a service running under a real user account that has a profile.
  - Some sandboxed shells cannot start a browser: restricted automation sandboxes, containers without the browser installed, or accounts without a profile folder. There, the report job fails with `browser_unavailable` while the rest of the app keeps working.
  - The integration tests skip their two PDF checks in that case and say so.
- **Browser location.** Edge and Chrome are found in their standard Windows paths, and `/usr/bin/chromium`, `chromium-browser`, `google-chrome` and `microsoft-edge` on Linux. Anywhere else, set `BROWSER_PATH`.
- **Linux:** run the service as an ordinary user. Chromium refuses to start as root without `--no-sandbox`, which this app does not pass. The report fonts (Noto Sans Thai, Oswald, Cormorant Garamond) are embedded in the PDF, so no system Thai fonts are needed.
- **Check it** from the same account the service uses: `npm run jobs -- report --year 2026` prints the file path, or the reason it failed. In the app, the owner uses **More → Reports → Generate**. Jobs show Queued → Generating → Ready or Failed, and a failed job can be retried.
- **Timing.** A full synthetic year took about half a minute on the test laptop. Ordering keeps working while a report generates.
- **Look at the pages.** `npm run pdf:pages -- <file.pdf> --pages 1-3,last` renders pages of a finished PDF to PNG with pdf.js in the same headless browser (`var/pdf-pages/<name>/`). Use it to check a real file after a font, layout or printer change; `--text` also writes each page's text, which keeps Thai ([TESTING.md](TESTING.md#pdf-pages-npm-run-pdfpages)).

## Background jobs

The server runs these itself (`server/jobs/runner.ts`). Each has a command for operators:

| Task | In the server | Command |
| --- | --- | --- |
| Report jobs (PDF, data export) | polled every 2 s, one job at a time | `npm run jobs -- run`, or `report --year YYYY [--kind annual_csv]` |
| Year rollover (final reports for completed years; nothing is reset) | at start and every 10 min | `npm run jobs -- rollover [--run]` |
| Daily item aggregates (last three business days) | every 5 min | `npm run jobs -- aggregates [--from D --to D]` |
| Expire weighed-cut quotes | every 60 s | `npm run jobs -- expire-quotes` |
| Seasonal availability log (dishes opening or closing with their season) | at start and every 10 min | none |
| Data retention (notes, feedback comments, raw events, audit; event outbox and ended staff sessions) | checked hourly, runs once per business day; `RETENTION_JOB=0` turns it off | `npm run jobs -- retention [--dry-run]` |
| Database backup | not scheduled; see above | `npm run jobs -- backup --out <file> [--with-reports]` |

Run `npm run jobs` with no command to list the commands.
