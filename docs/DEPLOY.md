# Putting Rabbit Grill ordering online

**Who this is for.** The person who owns the project and has to get it running on the
internet, using a browser and copy-paste. You do not need to write code. Every command in
this guide is typed or pasted somewhere, and the guide says exactly where.

**What you will end up with.** One small always-on server on the internet, with an address
like `https://order.rabbitgrillkhaoyai.com`. Guests scan the card on their table and the
menu opens on their phone. Staff open `/admin` on a phone or tablet. All of it is one
server and one database file on a disk that survives restarts.

**Jargon, once.** A few words you will meet:

| Word | What it means here |
| --- | --- |
| **Host** (or hosting platform) | The company that runs the server for you. We use **Render**. |
| **Repo** | Your code on GitHub: `MPC0367/rabbit-grill-ordering`. |
| **Deploy** | The host pulls the code from GitHub, builds it, and starts it. |
| **Blueprint** | A file in the repo (`render.yaml`) that tells Render how to set everything up, so you do not fill in twenty fields by hand. |
| **Persistent disk** | A piece of storage that stays when the server restarts. Your orders live here. |
| **Environment variable** | A named setting handed to the app when it starts, for example `PUBLIC_BASE_URL`. |
| **DNS** | The phone book of the internet. You add one line to it to point your domain at the server. |

> ### Honest status
>
> **Nothing in this guide has been run on Render or Fly.io.** The platform behaviour
> described here comes from each platform's own current documentation, and every such
> claim is linked. Where something can only be proved by deploying, the guide says so in
> the step and again in [§12](#12-what-is-documented-and-what-you-must-confirm-yourself).
>
> What **has** been checked, on one Windows laptop (see [§12](#12-what-is-documented-and-what-you-must-confirm-yourself) for the commands and results):
> the production build, the production server started against an **empty** database (all
> migrations ran, the guest and staff pages answered, no warnings), the health check, the
> owner-account command, the backup command, an annual PDF report, and a trace of every
> file the running server opens against what the deployment image ships. Every platform
> setting in `render.yaml` and `fly.toml` was checked field by field against the current
> published specification of each platform.
>
> The app itself is also **not ready for real guests yet**, whatever the hosting looks
> like. No item on the menu has been approved by the restaurant. [§6](#6-make-the-menu-real-before-guests-use-it) is the blocker list.

## Contents

1. [What you are about to create, and what it costs](#1-what-you-are-about-to-create-and-what-it-costs)
2. [What you need first](#2-what-you-need-first)
3. [Deploy on Render, step by step](#3-deploy-on-render-step-by-step)
4. [Point your domain at it](#4-point-your-domain-at-it)
5. [Create the real owner account](#5-create-the-real-owner-account)
6. [Make the menu real before guests use it](#6-make-the-menu-real-before-guests-use-it)
7. [Print and place the table QR cards](#7-print-and-place-the-table-qr-cards)
8. [Daily running](#8-daily-running)
9. [Backups](#9-backups)
10. [Updating the app later](#10-updating-the-app-later)
11. [Fly.io instead](#11-flyio-instead)
12. [What is documented and what you must confirm yourself](#12-what-is-documented-and-what-you-must-confirm-yourself)
13. [Go-live checklist](#13-go-live-checklist)

---

## 1. What you are about to create, and what it costs

You are renting two things: **one small computer that never switches off**, and **a disk
attached to it**. The computer runs the app. The disk holds the database — every order,
every bill, every payment record, every staff account — and the annual PDF reports.

### The monthly bill

Prices below are Render's published figures at the time of writing. **Check them on
[Render's pricing page](https://render.com/pricing) before you sign up**, because they
change.

| What | What you choose | Price |
| --- | --- | --- |
| The server | Render **Starter** instance (`0.5c-512mb`: half a CPU, 512 MB memory) — [compute plans](https://render.com/docs/compute-plans) | **$7.00** / month |
| The disk | **5 GB** persistent disk, at $0.25 per GB per month — [disks](https://render.com/docs/disks) | **$1.25** / month |
| Your Render workspace | **Hobby** (the free one) | $0 |
| https certificate | Render creates and renews it for you — [web services](https://render.com/docs/web-services) | $0 |
| Traffic out to guest phones | Hobby includes 5 GB a month; above that $0.15 per GB — [outbound bandwidth](https://render.com/docs/outbound-bandwidth) | $0, usually |
| **Total** | | **about $8.25 / month** |

**Why 5 GB and not 2.** Render accepts a disk size of **1 GB or a multiple of 5** and
nothing in between — the blueprint reference says the value "must be either `1` or a
multiple of `5`" ([blueprint spec](https://render.com/docs/blueprint-spec)). So the real
choice is 1 GB or 5 GB. The database, the annual PDF reports **and** the backup file you
write beside them ([§9](#9-backups)) all live on this one disk, and a disk that fills up
stops the restaurant taking orders. 1 GB is too tight for that; 5 GB costs 75 cents a
month more. A disk can be **grown** later but never shrunk, so the cheap mistake is the
one you make in this direction.

**In baht**, at roughly ฿34 to the dollar, that is **about ฿280 a month**, or ฿3,370 a
year. Check today's rate; this is only to give you the shape of the number.

**About the traffic allowance.** A guest's phone downloads roughly 1–2 MB the first time
it opens the menu (the menu photographs are the bulk of it), and much less after that
because the phone keeps a copy. 5 GB a month therefore covers a few thousand
first-time phones. A very busy month could go over; the overage is $0.15 per GB, so
even 10 GB over is $1.50. This is not a cost to worry about, but do look at your first
invoice.

**The domain.** Two cases:

- The restaurant already owns `rabbitgrillkhaoyai.com` → using `order.rabbitgrillkhaoyai.com`
  costs **nothing extra**.
- You need to buy a domain → a `.com` is usually **$12–15 a year** (about ฿400–500),
  paid to a domain registrar, not to Render.
- You want to start without any domain → Render gives you a free address like
  `rabbit-grill-ordering.onrender.com`. It works, https included. See [§4](#4-point-your-domain-at-it).

**One afternoon a year costs a little more.** The annual PDF report needs more memory
than the Starter instance has while it runs. The cheap way to handle that is to move the
service up to `1c-2g` ($25 a month) for the hour it takes, then move it back. Render
bills compute **prorated by the second**, so an hour on the bigger plan is a few cents,
and there is no fee for the change itself ([how Render handles traffic spikes](https://render.com/articles/how-render-handles-traffic-spikes)).
[§12](#12-what-is-documented-and-what-you-must-confirm-yourself) explains why this is
expected rather than certain.

### Why not the free plan

Render's free plan cannot do this job, and it is important to understand why before you
are tempted. From [Render's own free-tier documentation](https://render.com/docs/free):

- Free web services **cannot have a persistent disk**.
- Without one, "any changes to your web service's filesystem (uploaded images, local
  SQLite databases, etc.) are _lost_ every time the service redeploys, restarts, or spins
  down."
- A free service **spins down after 15 minutes without traffic** and takes about a minute
  to wake up.

In plain terms: on the free plan, **every order, bill and payment record would be deleted
without warning**, probably in the middle of your first quiet afternoon, and a guest
scanning a card would stare at a blank screen for a minute. The $7 is not optional.

### What happens if you stop paying

Render's [Terms of Service](https://render.com/terms) reserve the right to suspend access
while an invoice is unpaid, and state that data on Render's servers "may be deleted,
altered, moved or transferred at any time". Practically:

1. The card fails, Render emails you and retries.
2. If it keeps failing, the service is suspended — guests scanning a card get an error,
   and staff cannot open `/admin`.
3. Paying the invoice restores the service.
4. If the account is closed or abandoned long enough, **the disk and everything on it can
   be deleted**.

That is the whole argument for [§9, Backups](#9-backups): a copy of the business records
that lives somewhere other than Render.

### One more thing to know about the shape of this

This app is **one process with one database file**. It cannot be split across two servers,
and it cannot run "serverless". Render's documentation says the same thing from the other
side: "You can't scale a service to multiple instances if it has a disk attached"
([disks](https://render.com/docs/disks)). That is fine — one small server is plenty for
one restaurant — but it means two things you will notice:

- **Each deploy has a gap of a few seconds to a minute.** "Adding a disk to a service
  prevents zero-downtime deploys" ([disks](https://render.com/docs/disks)): Render stops
  the old copy before starting the new one, precisely so that two copies never write to
  the same database. Deploy outside service hours.
- **If the restaurant's internet drops, the app is unreachable from inside the
  restaurant**, because the server is not in the restaurant. [§8](#8-daily-running) covers
  what staff do then.

---

## 2. What you need first

Collect these three things before you start. The whole of [§3](#3-deploy-on-render-step-by-step)
takes about twenty minutes once you have them.

### 1. A GitHub account with the code in it

You have this: **`MPC0367`**, repo **`rabbit-grill-ordering`**, branch **`main`**.

1. Open <https://github.com/MPC0367/rabbit-grill-ordering> in your browser.
2. **You should see** the file list, including `README.md`, `docs/`, `server/` and
   `render.yaml`.
3. Check that **all five** deployment files are there. Click into `scripts/` for the last
   two. A missing one does not give you a helpful message — it fails the build halfway
   through with a complaint about a file path:

   | File | What it does | If it is missing |
   | --- | --- | --- |
   | `render.yaml` | Tells Render how to set everything up | Render's Blueprint step has nothing to read |
   | `Dockerfile` | The recipe Render builds: the app, its dependencies, and the Chromium browser the annual report needs | The build cannot start |
   | `.dockerignore` | Keeps your laptop's database and `.env` out of the image | A development database, with demo accounts whose passwords are published, could be baked into the server |
   | `scripts/docker-entrypoint.sh` | Prepares the disk and drops administrator rights at every start | The server starts as the administrator account, and the disk warning in [§3](#3-deploy-on-render-step-by-step) step 12 never appears |
   | `scripts/chromium-rg.sh` | How the report's browser is launched | **The build fails**, with an error naming this file |

If any of them is not there, the deployment files have not been pushed yet. Push them all,
in one commit, before going further. (`fly.toml` only matters if you choose Fly.io
instead — [§11](#11-flyio-instead).)

### 2. A payment card for Render

Any Visa or Mastercard. Render charges it monthly. You will enter it on Render's own
site, in their own form. **Nobody should ever ask you to type a card number or a password
into a chat window, including me.**

### 3. A domain, or the decision to start without one

Pick one of these now; it decides [§4](#4-point-your-domain-at-it).

| Your situation | What to use | Cost |
| --- | --- | --- |
| The restaurant owns `rabbitgrillkhaoyai.com` | **`order.rabbitgrillkhaoyai.com`** — a *subdomain*: a name in front of the domain you already own. You add one DNS line, and the main website is untouched. | Free |
| The restaurant does not own a domain, and wants one | Buy `rabbitgrillkhaoyai.com` (or similar) from a registrar, then use `order.` in front of it | $12–15 / year |
| You want to test first and decide later | Render's free address, `rabbit-grill-ordering.onrender.com` | Free |

**Recommendation:** start on Render's free address, get everything working, and add the
real domain afterwards. The only cost of doing it in that order is that you print the
table QR cards once, at the end — which you were going to do anyway, because the cards
contain the address.

A subdomain is the right choice over the bare domain. `rabbitgrillkhaoyai.com` should
stay pointed at the restaurant's website; `order.rabbitgrillkhaoyai.com` is the ordering
system. They are independent.

---

## 3. Deploy on Render, step by step

You will do this once. Allow twenty minutes, plus five to ten minutes of waiting while
Render builds.

### Sign in

1. Go to <https://render.com> and choose **Get Started** (or **Sign In** if you already
   have an account).
2. Choose **GitHub** as the way to sign in, and approve the permission screen GitHub
   shows you.
   **You should see** the Render Dashboard, mostly empty, with a **New** button near the
   top right.
3. Render may ask you to create a **workspace**. Name it anything — `O2` or
   `Rabbit Grill` — and choose the **Hobby** plan.
   **You should see** the dashboard with your workspace name in the corner.

### Create everything from the blueprint

4. Click **New**, then **Blueprint**.
   ([Render's documentation](https://render.com/docs/infrastructure-as-code) calls this
   "New > Blueprint".)
   **You should see** a list of your GitHub repositories.
5. If `rabbit-grill-ordering` is not in the list, click the link to configure GitHub
   access and grant Render access to that repository, then come back.
6. Click **Connect** next to **`rabbit-grill-ordering`**.
   **You should see** a form with a blueprint name, a branch, and — once Render has read
   `render.yaml` — a list of the resources it is about to create.
7. Leave the **branch** as **`main`**.
8. Leave the blueprint name as it is.

### Fill in the one value only you know

9. Render asks you for the values that `render.yaml` deliberately leaves blank (they are
   marked `sync: false` in the file, which means "ask the human"). There is one:

   | Setting | What to type now |
   | --- | --- |
   | **`PUBLIC_BASE_URL`** | You do not know the real answer yet — Render has not told you the address. Leave it blank if Render lets you; if it insists on a value, type `https://rabbit-grill-ordering.onrender.com`. **Either way you correct it in step 16.** A wrong value here costs nothing: it only affects QR codes, which you have not printed. |

   Everything else is already in `render.yaml` and you should **not** change it. For
   reference, this is what those settings are and why they matter:

   | Setting | Value | Why |
   | --- | --- | --- |
   | `NODE_ENV` | `production` | Switches the app to real-install mode. It then **refuses** to create demo data, and refuses to delete the database. |
   | `HOST` | `0.0.0.0` | Render requires every web service to "bind to a port on host `0.0.0.0`" ([web services](https://render.com/docs/web-services)). |
   | `PORT` | *not set on purpose* | Render supplies it — "The default value of `PORT` is `10000` for all Render web services" ([web services](https://render.com/docs/web-services)) — and the app listens on whatever it is given. |
   | `DATABASE_PATH` | `/var/data/rabbit-grill.db` | The database, **on the persistent disk**. If this ever points somewhere else, you lose everything on each deploy. |
   | `REPORTS_DIR` | `/var/data/reports` | The annual PDFs, also on the disk. |
   | `TRUST_PROXY_HOPS` | `1` | Render's load balancer sits in front of the app. This tells the app to read each guest's real address from the forwarded header, so that one person guessing table PINs gets locked out instead of the whole restaurant. **If you later turn Cloudflare's proxy on for your domain this must become `2`** — see [§4](#4-point-your-domain-at-it). |
   | `PUBLIC_BASE_URL` | you, in step 16 | The address printed inside every table QR code. Setting it to an `https://` address also makes the sign-in cookies **Secure** automatically. |
   | the **disk** | name `data`, mount path `/var/data`, size **5 GB** | Only files under the mount path survive a deploy ([disks](https://render.com/docs/disks)). Render only accepts 1 GB or a multiple of 5 ([blueprint spec](https://render.com/docs/blueprint-spec)); [§1](#1-what-you-are-about-to-create-and-what-it-costs) explains why 5. You can grow a disk later but **never shrink it**. |
   | **health check** | `/api/health` | Render polls this every few seconds; "your endpoint can respond with any `2xx` or `3xx` status code" to count as healthy ([health checks](https://render.com/docs/health-checks)). The app answers it only once the database is open and migrated, so a deploy that cannot open its database is never put in front of guests. |
   | **region** | `singapore` | The closest Render region to Khao Yai. Render offers Oregon, Ohio, Virginia, Frankfurt and Singapore, and **a region cannot be changed later** ([regions](https://render.com/docs/regions)) — if `render.yaml` says anything else, fix it before you deploy. |
   | **instances** | 1 | Not negotiable: one process owns the database. Render enforces it anyway: "You can't scale a service to multiple instances if it has a disk attached" ([disks](https://render.com/docs/disks)). |

   **Where is the "Build Command"?** There isn't one, and that is correct. `render.yaml`
   says `runtime: docker`, so Render builds the repo's **`Dockerfile`** instead of running
   a build command and a start command of its own. The service page will show you a
   **Dockerfile path** (`./Dockerfile`) where another kind of service would show Build
   Command and Start Command fields. **Do not go looking for those fields, and do not add
   them** — typing a build command into a Docker service is how you end up with a service
   that builds one thing and runs another.

   The build steps live inside the Dockerfile, which does the equivalent of
   `npm ci --include=dev` and `npm run build` in a throwaway first stage, then installs
   **only** the production dependencies for the image that actually runs. `--include=dev`
   matters there: the tool that builds the guest and staff pages (Vite) is a development
   dependency, and npm leaves development dependencies out whenever `NODE_ENV` is
   `production`. The Dockerfile already handles this; you do not have to.

   Two more things the Dockerfile settles, which you would otherwise have to arrange by
   hand: it installs the **Chromium browser** the annual PDF report needs, and it pins
   **Node 24** exactly, so a future change to Render's default Node version cannot move
   under the restaurant.

10. Click **Deploy Blueprint**.
    **You should see** a page for your new service, with a log scrolling past.

### Watch it build

11. Wait. The first build downloads a Node image, installs the dependencies, builds the
    guest and staff pages, and installs the Chromium browser the annual report needs.
    Expect **ten to twenty minutes** the first time. Later deploys are much faster,
    because Render reuses the layers that did not change.
    **You should see**, in the log, lines ending with something like
    `✓ built in …` and then `[precompress] 45 files, …`, then some `[entrypoint]` lines,
    and finally:

    ```
    [entrypoint] dropping root: the server runs as uid 10001
    [entrypoint] PDF browser: …
    [entrypoint] starting: node scripts/start.ts
    [db] applied 001_init.sql, 003_tables.sql, … 011_round2.sql
    [server] Rabbit Grill ordering API on http://localhost:10000
    [server] QR base URL: …
    ```

    The `[db] applied …` line is the database being created from nothing, and you should
    see it **once only**, on this first deploy. Seeing it again on a later deploy, with
    the same list of files, would mean the deploy started with an empty database — see
    the next step.

12. **Read the log for two specific things before you go on.**

    - **This must NOT be there:**

      ```
      [entrypoint] WARNING: /var/data is NOT on a separate disk.
      ```

      If it is, the persistent disk was not attached, and **every order, bill and report
      will be deleted on the next deploy**. Stop. Open the service's **Disks** settings
      and check that a disk named `data` is mounted at `/var/data`. Do not create accounts
      or enter a menu until this line is gone.

    - **These are expected, for now:** one or two lines beginning `[server] WARNING:`,
      saying that QR cards would point at an address no phone can open and that cookies
      are not marked Secure. Both are the same cause — `PUBLIC_BASE_URL` is not set yet —
      and step 16 fixes both. **After step 17 there should be no `[server] WARNING:` lines
      at all**; that is the check that the address really took effect.

    A note on the port, so it does not alarm you: the line above may say `10000` (Render's
    default) or some other number. Either is fine — the app listens on whatever port
    Render hands it, and guests never see that number. What matters is the status in the
    next step.

13. **You should see** the service status change to **Live** (green) near the top of the
    page. If it never does, the health check is failing; Render "cancels the deploy" if
    instances do not become healthy "within 15 minutes"
    ([health checks](https://render.com/docs/health-checks)), so you have that long to
    read the log.

### Check that it really worked

14. At the top of the service page, Render shows the address it gave you, something like
    `https://rabbit-grill-ordering.onrender.com`. Copy it.
15. Check three things in your browser:

    | Open this | You should see |
    | --- | --- |
    | `<your address>/api/health` | `{"ok":true,"time":"…"}` — plain text, nothing else. This is the health check Render itself uses. |
    | `<your address>/menu` | The guest menu page, with **no dishes on it**. That is correct and expected: a production database starts empty. [§6](#6-make-the-menu-real-before-guests-use-it) explains how the menu gets in. |
    | `<your address>/admin` | The staff sign-in page. Do **not** try to sign in yet — there is no account. [§5](#5-create-the-real-owner-account) creates it. |

    If `/api/health` answers but `/menu` is blank white, the browser app did not build.
    Open the **Logs** tab and look for a line mentioning `dist/index.html is missing`.

16. Now set the real address. On the service page, open **Environment**, find
    `PUBLIC_BASE_URL`, and set it to the address from step 14 — **with `https://`, and no
    trailing slash**:

    ```
    https://rabbit-grill-ordering.onrender.com
    ```

17. Click **Save, rebuild, and deploy** (the exact button wording may differ; any save of
    an environment variable triggers a redeploy).
    **You should see** a new deploy start, and about a minute later the log line
    `[server] QR base URL: https://rabbit-grill-ordering.onrender.com`, with the
    "cards point at an address phones cannot open" warning **gone**.

That is the deployment. If you are adding a domain, do [§4](#4-point-your-domain-at-it)
next and you will set `PUBLIC_BASE_URL` once more. If you are not, skip to
[§5](#5-create-the-real-owner-account).

---

## 4. Point your domain at it

Skip this section if you are staying on the `onrender.com` address for now. You can come
back to it at any time; the only thing you have to redo afterwards is printing the QR
cards.

### Tell Render about the domain

1. On your service page in Render, open **Settings**, then find **Custom Domains**.
2. Click **Add Custom Domain**.
3. Type the full name you want, for example `order.rabbitgrillkhaoyai.com`, and save.
   **You should see** the domain listed as **unverified**, together with the DNS record
   Render wants you to create.

### Add one line to your DNS

4. Sign in wherever the restaurant's domain is managed — the registrar (GoDaddy,
   Namecheap, Cloudflare, Google Domains…) or whoever runs the restaurant's website. Find
   the page called **DNS**, **DNS records** or **Zone editor**.
5. Add **one** record. For a subdomain, Render's
   [custom domains documentation](https://render.com/docs/custom-domains) says to use a
   `CNAME`:

   | Field | Value |
   | --- | --- |
   | Type | `CNAME` |
   | Name / Host | `order` (just the word — your DNS provider adds the rest) |
   | Value / Target / Points to | `rabbit-grill-ordering.onrender.com` (your own Render address, **without** `https://`) |
   | TTL | leave the default, or `300` |

   If you insist on the bare domain `rabbitgrillkhaoyai.com` instead, it needs an
   `ANAME`/`ALIAS` record rather than a `CNAME`, which not every provider offers — and
   Render's docs also say to **remove any `AAAA` records** from the domain while you do
   this. A subdomain avoids all of that. See
   [configuring DNS providers](https://render.com/docs/configure-other-dns).

   > #### If your DNS is at Cloudflare, read this before saving
   >
   > Cloudflare puts a little **cloud icon** next to each record, and a new record
   > defaults to **orange** — "Proxied", meaning Cloudflare sits in front of your server
   > and answers for it. That default will bite you twice here.
   >
   > 1. **Set Proxy status to "DNS only" (grey cloud) now.** Render's own Cloudflare
   >    instructions say to "Set **Proxy status** to **DNS only**. This ensures that
   >    requests go to Render instead of Cloudflare, so that we can verify the domain and
   >    issue a certificate" ([Cloudflare DNS](https://render.com/docs/configure-cloudflare-dns)).
   >    With the orange cloud on, step 7 below will not verify.
   > 2. **Grey cloud is also the setting to leave it on.** Render says you *may* switch
   >    the record to **Proxied** after the certificate is issued and valid, and that if
   >    you do, Cloudflare's SSL/TLS encryption mode must be set to **Full**. But there
   >    is a second consequence Render does not mention, and it is this app's problem, not
   >    Cloudflare's: proxying adds **another proxy** between the guest's phone and the
   >    app, and the app is told how many there are by `TRUST_PROXY_HOPS`. With the orange
   >    cloud on and `TRUST_PROXY_HOPS` still `1`, **every guest in the restaurant looks
   >    like the same visitor**, and one person mistyping a table PIN uses up the join and
   >    sign-in allowance for the whole room. If you genuinely want Cloudflare in front,
   >    change `TRUST_PROXY_HOPS` to `2` in **Environment** at the same time, and never
   >    set it higher than the number of proxies that are really there.
   >
   > The simple answer for a restaurant: **grey cloud, `TRUST_PROXY_HOPS` stays `1`.**
   > The same applies to any other service you might put in front of the address.

6. Save the record.
7. Go back to Render and click **Verify** on the domain.
   **You should see** the domain change to **verified**, and shortly after, a note that
   the TLS certificate has been issued. Render "automatically creates and renews TLS
   certificates for all custom domains"
   ([custom domains](https://render.com/docs/custom-domains)).

**How long does it take?** Usually a few minutes. It can take a few hours if your DNS
provider uses long TTLs, and up to a day in the worst case. There is nothing to do but
wait and press **Verify** again. Until it verifies, the `onrender.com` address keeps
working.

8. Open `https://order.rabbitgrillkhaoyai.com/api/health` in your browser.
   **You should see** `{"ok":true,…}`, with a padlock in the address bar.

### Set the final address, then redeploy

9. In Render, open **Environment** and change `PUBLIC_BASE_URL` to the final address:

   ```
   https://order.rabbitgrillkhaoyai.com
   ```

10. Save. Render redeploys.
    **You should see** in the log: `[server] QR base URL: https://order.rabbitgrillkhaoyai.com`

### Why the QR cards must be reprinted now

Each table's card is a QR code containing a **web address**: your `PUBLIC_BASE_URL`, plus
that table's own secret token. The address is baked into the printed square. It is not
looked up anywhere at scan time.

So a card printed while `PUBLIC_BASE_URL` was `https://rabbit-grill-ordering.onrender.com`
sends the guest's phone to `rabbit-grill-ordering.onrender.com` forever, no matter what
you change later.

Two consequences:

- **Print the cards after this step, not before.** [§7](#7-print-and-place-the-table-qr-cards).
- **If you change the address again later, every card must be reprinted again.** This is
  the single best reason to decide the domain before go-live and then leave it alone.

(The old `onrender.com` address keeps working alongside the custom domain, so cards
printed earlier are not instantly dead. But you now have cards pointing at two different
addresses, which is exactly the kind of thing that bites you in six months when someone
turns the old one off. Reprint.)

---

## 5. Create the real owner account

The database is empty: there is no way to sign in yet, and that is deliberate. A real
install never creates accounts by itself, and the demo accounts in this project have
published passwords, so they are never created in production mode.

You create the first owner by running one command **on the server**, through Render's own
browser shell. Being able to open that shell is what proves you are allowed to do it.

> **The password rule, and it has no exceptions.** You type the password **into Render's
> shell window, on Render's own website**. You do not type it into this chat, into a
> message to me, into a file in the repo, or into a note. Nothing in this guide ever asks
> you to reveal it. If any instruction anywhere asks you to paste a password into a
> conversation, that instruction is wrong.

1. Decide the password first, before you open the shell. **10 characters minimum.** Use a
   password manager, or three unrelated words plus a number. It must not contain the
   username or the display name.
2. On your service page in Render, open the **Shell** tab.
   Render's [shell documentation](https://render.com/docs/ssh) shows the dashboard shell
   as unavailable on free instances and available on paid ones — which yours is — and
   says it connects to your running service instance.
   **You should see** a black terminal panel with a prompt.
3. First, confirm the shell is really looking at your live disk. Paste **both lines**
   below, pressing Enter after each. They only **print** information and change nothing:

   ```
   cd /app
   npm run jobs -- restore
   ```

   The `cd /app` is not optional and is not decoration: `/app` is where the application
   lives inside the image, and `npm run …` only works from there. Render does not document
   which directory a shell session starts in, so put this line in front of **every**
   command in this guide that you paste into the Shell. If `cd /app` itself fails, stop
   and ask — nothing else in this section will work either.

   **You should see** a short "Restoring a backup replaces the live database" procedure,
   in which the paths read **`/var/data/rabbit-grill.db`** and **`/var/data/reports`**.
   If instead you see paths containing `var/rabbit-grill.db` with no `/var/data` in front,
   stop: the environment variables did not reach the shell, and the next command would
   write to the wrong place. Go back to [§3](#3-deploy-on-render-step-by-step) step 9 and
   check `DATABASE_PATH`.
4. Now create the owner. Replace the username and display name with the real ones:

   ```
   npm run admin:create -- --username owner --name "Khun Owner"
   ```

   **You should see** a prompt:

   ```
   Password for owner (min 10 characters):
   ```

5. Type the password. **Nothing appears as you type** — no dots, no stars. That is
   correct; it is not echoed on purpose. Press Enter.
   **You should see**:

   ```
   Created owner (owner).
   ```

   If you see `Password must be 10-256 characters`, nothing was created. Run the command
   again.
6. Close the shell.

   > **One tidying note about the Shell.** A shell session on the server runs as the
   > administrator account (`root`), while the app itself deliberately runs as a limited
   > account. That is the right way round — it is what lets you create the first owner at
   > all — but it means a file that a shell command creates can end up owned by the wrong
   > account. The app fixes this for the database automatically, every time it starts. So
   > if anything looks odd right after you have used the Shell, use **Manual Deploy →
   > Restart service** on the service page: it costs a few seconds of downtime and puts
   > file ownership back in order. You do not need to do this routinely.

7. Open `<your address>/admin` and sign in with that username and password.
   **You should see** the staff home screen. You are an **owner**, so you can see
   everything: Orders, Tables, Menu, Insights, Reports, Team, Settings, Audit.

### If you ever forget the password

Run the **same command again** with the same username. It sets a new password, reactivates
the account, clears any lockout, and signs that account out everywhere. There is no
"forgot password" email in this app; shell access is the recovery route.

### Create an account for each member of staff

Do this in the app, not in the shell.

8. Go to **More → Team**, and click to add a person.
9. Create **one account per person**, not one per role. Every cancellation, correction,
   price change and payment is recorded against a named account; shared logins destroy
   that.
10. Give each person the **narrowest role that lets them do their job**:

    | Role | What it is for | Where they land after signing in |
    | --- | --- | --- |
    | **owner** | You. Settings, Team, menu verification, financial reports. | `/admin` |
    | **manager** | Runs service. Can cancel started dishes, correct orders, pause ordering, enter paper orders, edit the menu, see insights. | `/admin/orders` |
    | **cashier** | Bills, payments, completing checkout. | `/admin/tables` |
    | **floor** | Seating tables, PINs, taking orders for guests, serving, calling for the bill. | `/admin/tables` |
    | **kitchen** | The orders board and marking dishes sold out. Sees no money. | `/admin/orders` |

11. **You should see** each person listed in Team with their role.

### Retire the demo accounts

If this database has only ever been a production database, there are no demo accounts and
you can skip this. Check anyway — it takes ten seconds.

12. In **More → Team**, look for accounts named `demo-owner`, `demo-manager`,
    `demo-cashier`, `demo-floor`, `demo-kitchen`. They are marked as demo data.
13. If any are there and active, **deactivate them**.

There is also a one-step version, and it is the one to use when you go live. In
**More → Settings → Operating mode**, switching the mode to **live** is **refused** while
any demo account is still active, and the screen then offers **"Deactivate demo accounts
and switch"** — it retires them, signs them out, records it in the audit log and switches
to live, all in one go.

Two conditions: you must not be signed in **as** a demo account yourself, and there must
be a real owner left behind. Creating your own owner in step 4 satisfies both. Leave the
mode on **demo** for now — [§6](#6-make-the-menu-real-before-guests-use-it) and
[§13](#13-go-live-checklist) say when to flip it.

---

## 6. Make the menu real before guests use it

**The app is deployed. The menu is not true yet.** This is the part no amount of hosting
fixes, and it is the real gate on go-live.

### Your new server has an empty menu

Expect this and do not be alarmed by it. A production database is **deliberately empty**:
the 95 draft items read from the restaurant's printed menus are development fixtures, and
a production install refuses to create fixture data of any kind. So on your new server
there are no items, no categories and no tables until you put them there.

You have two ways in, both inside the app, under **Menu**:

| Route | How | When to use it |
| --- | --- | --- |
| **Type it** | **Menu → Catalog**, adding categories and items by hand | The honest option if the real menu differs much from the printed one, or if the restaurant is going to rewrite it anyway |
| **Import a spreadsheet** | **Menu → Import**. The tab has a **template CSV** to download, fill in and upload. You get a **preview** of every row before anything is applied, and an import never publishes an item or overwrites a published one. | Faster for 95 items, and it is how you move the existing draft catalog across |

**To bring the 95 draft items over**, someone runs the project on a laptop once
(`npm run dev` seeds them), signs in there, goes to **Menu → Import** and downloads the
**menu export CSV**, then uploads that same file to **Menu → Import** on the server and
applies it. That is one laptop step — ask for it if you are not doing it yourself. The
imported items still arrive **unverified**, which is the point of everything below.

### The blockers

The full list is **[docs/OWNER-CHECKLIST.md](OWNER-CHECKLIST.md)** — work through it with
the restaurant owner, top to bottom, ticking each box only when the answer is **entered in
the app**, not merely given in conversation.

These are the blockers. Until they are done, the system stays in **demo** mode, because
in **live** mode only owner-verified items can be ordered at all. The counts are from the
audit of the restaurant's printed menus, and describe the draft catalog once it is in:

| Blocker | Where it stands | Where you fix it |
| --- | --- | --- |
| **No item is owner-verified.** 95 items were imported from the restaurant's printed menus; **0** have been verified by an owner. In live mode an unverified item cannot be ordered. | 0 of 95 | **Menu → Review** (owner only) |
| **Drinks have no Thai names.** 55 of the 56 drinks have no printed Thai name. They show their English name, marked as untranslated. | 55 missing | **Menu → Catalog**, item by item |
| **Allergens are unknown for every item.** Guests see "please ask staff about allergies" until an owner records, per item, what it contains. Unknown never means allergen-free. | 95 unknown | **Menu → Review** |
| **Charges are not confirmed.** No service charge and no VAT rule is configured, so a bill is currently just the sum of the dishes. Whatever the restaurant actually charges must be entered. | not configured | **Settings → Charges** |
| **Hours are not verified.** 11:00–21:00, closed Wednesday, is taken from third-party listings and is **not enforced**. | unverified | **Settings → Ordering** |
| **Payment methods are not confirmed.** Cash is proposed on; transfer/PromptPay and card are proposed off. | proposed only | **Settings → Payment methods** |
| **Prices are not approved.** Printed prices were imported as-is. One item (Grilled Lamb Rack, 890 / 1,590) cannot be ordered until the owner says what distinguishes them. | none approved | **Menu → Review** |

The checklist also carries **21 open questions** for the restaurant (portion sizes,
doneness choices, what is included with the ribs, the draft-beer promotion, photo
permissions). Each answer unblocks specific items. Do not guess them on the restaurant's
behalf: a wrong allergen or a wrong price is a real-world problem, not a software bug.

---

## 7. Print and place the table QR cards

Do this **after** `PUBLIC_BASE_URL` is final ([§4](#4-point-your-domain-at-it)) and after
you have created your real tables.

1. Sign in at `<your address>/admin` as owner or manager.
2. Go to **Tables**, then **Manage tables & QR**.
3. Create your **real tables**. The demo's twelve tables numbered 01–12 are not the
   restaurant's floor plan. Add one entry per table, with the name or number staff
   actually use. Zones are optional.
   **You should see** your tables listed, each with a **Print card** action.
4. Choose the tables you want, then open the print page.
   **You should see** a page headed **Print QR cards**, offering **A4 · 4 per sheet**
   (cut along the dashed lines) or **A6 · 1 per page**, with a print preview.

   **If instead you see "These cards cannot be printed yet"**, the app is telling you the
   QR links point at an address only the server itself can open. That means
   `PUBLIC_BASE_URL` is still wrong. Go back to [§3](#3-deploy-on-render-step-by-step)
   step 16 or [§4](#4-point-your-domain-at-it) step 9. The app blocks this on purpose, so
   that nobody ever prints a hundred cards that lead nowhere.

   **Test one before you print a hundred.** With the print preview on screen, scan one
   card with your own phone. The table's menu should open and ask for a code. That is the
   whole chain — card → address → table → PIN — proved in ten seconds.

   **There is no "copy link" button, and that is on purpose.** Each table's ordering page
   is a secret address, and the full link lives **only inside the QR square**. The small
   text under the code is a six-character tag for staff to match a card to a table, not
   something you can type into a browser. So there is no list of per-table links to paste
   anywhere, and nothing to leak in an email: scanning is the way in. (The printed cards
   *are* the per-table ordering pages. Keep the PDF; it is the only copy of them in a
   readable form.)

5. Print. **One card per table.** Each card is unique: it carries that table's own
   permanent token.
6. **What is on the card:** the restaurant name, the table number (Thai and English),
   the QR square, "สแกนเพื่อสั่งอาหาร / Scan to order", "ขอรหัสโต๊ะจากพนักงานเพื่อเริ่มสั่ง /
   Ask staff for the table code", and a line saying guests are welcome to order in person
   instead.
7. **What is deliberately NOT on the card: the PIN.** The join PIN changes with every
   party that sits down. Guests get it from staff at seating. A card never shows it, which
   is why a photographed card is a nuisance rather than a breach.
8. **Place the cards** where a seated guest can scan without standing up: a small stand or
   holder in the middle of the table, or inside the front of the menu folder. Do not laminate
   until you are sure the address is final — you will want to reprint at least once.
9. Keep two or three **spare blank card stands** and the PDF, so a damaged card can be
   replaced in a minute.

### If a card is photographed, shared or stolen

A card's QR is a long-lived secret for that table. Someone who has it can open the menu
for that table — but they still need the **current PIN from staff** to join a visit, order
anything or see a bill. So this is not an emergency. Still, if a card ends up on social
media or a table's card goes missing:

10. Go to **Tables → Manage tables & QR**, find that table, and choose **Rotate QR…**.
11. Read the warning and confirm **Rotate QR**.
    **You should see** a message that the table has a new QR, and a banner offering
    **Print new card**.
12. **The old printed card stops working immediately.** Print the replacement and physically
    remove the old one from the table before the next party sits down. The app keeps
    reminding you which tables are waiting for a replacement card.

---

## 8. Daily running

### Who opens what

Everyone uses a browser. There is no app to install.

| Person | Device | Address | What they do there |
| --- | --- | --- | --- |
| **Kitchen** | A tablet or small screen on the kitchen wall, plugged in, screen set never to sleep | `/admin` → signs in as the kitchen account, lands on **Orders** | Accept rounds, move dishes through Preparing → Almost done → Ready, mark items sold out |
| **Floor staff** | Their own phone | `/admin` → lands on **Tables** | Seat parties, read out the PIN, take orders for guests who prefer to speak to someone, mark dishes served, answer call-staff requests |
| **Cashier** | A tablet or laptop at the till | `/admin` → lands on **Tables** | Start checkout, finalise the bill, record the payment, complete checkout |
| **Manager** | Phone or tablet | `/admin` → lands on **Orders** | Everything above, plus cancelling started dishes, corrections, pausing ordering, entering paper orders |
| **Owner** | Laptop | `/admin` | Menu verification, Settings, Team, Insights, Reports |
| **Guests** | Their own phone | Scan the table card | Browse, order, follow each dish, call staff, ask for the bill |

Staff sessions last about 14 hours, so a device signed in at opening stays signed in all
day. Sign out on shared devices at close.

### Seating a party: the PIN

1. Staff open **Tables** and seat the party on their table.
2. **You should see** a PIN on screen — four digits by default.
3. Staff say it to the guests ("the table code is 4-8-1-2"). Guests scan the card, the
   menu opens, and the phone asks for that code.
4. **Several phones at one table use the same PIN.** Each phone has its own cart, but they
   all see the same table's orders and the same bill.
5. The PIN belongs to **this party on this table**. At checkout it stops working. The next
   party gets a new one.

If a guest keeps getting the PIN wrong, the visit locks: five minutes after five wrong
tries, then fifteen, and a third lockout holds until staff act. Staff fix it by rotating
the PIN in the table drawer, which also clears the lockout.

### Pausing ordering

When the kitchen is underwater, or you have run out of something central, a manager or
owner can pause.

1. From the **Orders** board, pause ordering (optionally with an estimated wait).
2. **What guests see:** they can still browse, follow the food already ordered, and call
   staff — but no new rounds can be sent. Orders already sent carry on normally.
3. Resume from the header when the kitchen is ready.

You can also pause a single **category** (for example Drinks) rather than everything.

### When the internet drops

Be clear-eyed about this: the server is in Singapore, not in the restaurant. **If the
restaurant's internet goes down, staff devices cannot reach the app.** Guest phones on
mobile data may still reach it, but the staff side will be stuck.

The restaurant does not stop. The app catches up afterwards.

1. **Take orders on paper**, as the restaurant did before any of this existed. Note the
   table and the dishes.
2. Staff screens that were already open show an out-of-date warning rather than pretending
   everything is fine.
3. When the internet returns, reload the staff pages.
4. For each paper order, a **manager** opens the **Orders** board (or the table's drawer)
   and uses **Enter paper order**.
5. **You should see** the round recorded on the table's bill, marked as a paper order,
   **without** sending a second ticket to the kitchen — the food was already cooked.
6. Bills, payments and the day's figures then include that food, so the reports stay true.

Agree in advance **who** enters paper orders, and when (as it happens, or at the end of
service). It is a manager-only action by design.

---

## 9. Backups

The database on that disk is the business: every order, bill, payment, staff account and
report. Treat the backup routine as seriously as locking the till.

You have three layers. Use all three.

### Layer 1: Render's automatic disk snapshots (nothing to do)

Render "automatically creates daily snapshots" of a persistent disk and keeps them "for at
least seven days", and you can restore the disk to any available snapshot
([disks](https://render.com/docs/disks)).

This protects you from the disk failing or from a bad deploy. It does **not** protect you
from the Render account being suspended, closed or deleted — those snapshots live on
Render too. Hence layers 2 and 3.

### Layer 2: a proper backup file, taken by hand

This is the real backup: a single file you can restore from.

1. Open your service's **Shell** tab in Render.
2. Paste these two lines, changing the date to today:

   ```
   cd /app
   npm run jobs -- backup --out /var/data/backups/rg-2026-10-05.db --with-reports
   ```

3. **You should see** a line like:

   ```
   database backup written: /var/data/backups/rg-2026-10-05.db (4231168 bytes)
   ```

   plus a line about the report files, if there are any.

Notes that matter:

- It is safe to run **while the restaurant is serving**. The command makes a consistent,
  compacted copy using SQLite's own mechanism. (Checked here on an empty production
  database: written in well under a second. [docs/OPERATIONS.md](OPERATIONS.md#taking-a-backup)
  reports the same for a 140 MB test database.)
- `--with-reports` also copies the generated PDFs, into a folder beside the backup file
  with `.reports` on the end.
- The folder in `--out` is created for you if it does not exist.
- The command **refuses to overwrite** an existing file. Always put the date in the name.
- **Never** just copy the `.db` file with a file manager while the server is running. Recent
  changes sit in a companion `-wal` file and a plain copy can be broken in a way you only
  discover when you need it.

**How often?** Once a day, after closing, is the right answer for a restaurant. Losing one
evening is survivable; losing a month is not.

> #### Delete old backups, or the disk fills and the restaurant stops
>
> This is the one way a backup habit can turn into an outage, so it is worth being blunt
> about. Those backup files land on **the same 5 GB disk as the live database**. Nothing
> deletes them for you. A daily backup, each roughly the size of the database and each
> carrying a copy of the annual PDFs with `--with-reports`, will eventually fill the disk —
> and when the disk is full the server cannot write an order, a bill or a payment. The
> restaurant stops taking orders, and the cause is not obvious from the screen.
>
> So, as part of the same habit: **keep about a week of backups on the server and no more.**
> In the Shell, `cd /app` and then:
>
> ```
> ls -lh /var/data/backups          # what is there, and how big
> du -sh /var/data                  # how much of the 5 GB is used
> rm -rf /var/data/backups/rg-2026-09-28.db /var/data/backups/rg-2026-09-28.db.reports
> ```
>
> Check `du -sh /var/data` once a month. If it is past about 3.5 GB, delete older backups
> first; if it is genuinely the database and the reports that have grown, raise the disk
> size in Render's **Disks** settings (it can be grown at any time, never shrunk).
>
> The backups you actually rely on are the ones in layer 3, **off** Render. The copies on
> the disk are only there long enough to be downloaded.

**A limitation you should know about.** This app does not schedule its own backups, and on
Render a scheduled job cannot reach another service's disk — Render's documentation is
explicit that "you can't access a service's disk from any other service"
([disks](https://render.com/docs/disks)). So on Render, layer 2 is a **manual habit**:
someone opens the shell and runs the command. Put it on the closing checklist next to
cashing up. (If that proves unrealistic, the fix is a small code change so the app backs
itself up on a timer — worth asking for.)

### Layer 3: a copy that is not on Render

Two ways, one easy and one for a developer.

**The easy one — the annual data export.** As owner, go to **More → Reports** and generate
the **data export** for the current year. It produces a ZIP of CSV files — orders, order
lines, visits, bills, payments, daily and monthly figures, service requests, corrections —
which you download through the browser and keep in Google Drive or on a USB stick.

This is not a restorable database: you cannot turn it back into a running system. It is
the **business record**, readable in Excel forever, and it means the restaurant's money
data is not held only by Render. Do it monthly.

**The thorough one — copying the backup file off the server.** Render's
[disks documentation](https://render.com/docs/disks) describes transferring files off a
disk with `scp` or Magic Wormhole. Both need the Render CLI and an SSH key set up on your
computer — a one-time job of maybe thirty minutes, but genuinely a developer task. Ask for
it to be set up for you, once, and then it is two commands whenever you want a copy.

### Restoring

Restoring is deliberately manual, because it throws away everything newer than the backup.

1. Open the **Shell** and run `cd /app`, then `npm run jobs -- restore`. It **prints the
   procedure with your real paths** and changes nothing.
2. Follow it, or hand it to whoever is helping you.

The full explanation — what a restore means mid-service, which phones have to rejoin, how
to re-enter food already cooked, and which reports have to be regenerated — is in
**[docs/OPERATIONS.md § Backup and restore](OPERATIONS.md#backup-and-restore)**. Read that
section **before** you need it, not during.

One line worth memorising now: **everything after the backup is gone.** Phones rejoin with
a new PIN from staff, and food already served is re-entered with **Enter paper order**.

**Test a restore once**, into a throwaway Render service or on a laptop, before you rely on
the backups. An untested backup is a hope, not a backup.

---

## 10. Updating the app later

Render watches your GitHub branch. Pushing to `main` is the deploy button.
([Deploying on Render](https://render.com/docs/deploys): "Whenever you push or merge a
change to that branch, by default Render automatically rebuilds and redeploys your
service.")

**Always in this order:**

1. **Take a backup first** ([§9](#9-backups) layer 2). Every time. A migration that goes
   wrong is exactly when you want last night's file.
2. Pick a time **outside service hours**. Because the service has a disk, Render stops the
   old copy before starting the new one, so there is a short gap — a few seconds if all
   goes well, a few minutes if the build fails and you have to react.
3. Push the change to `main` (or have whoever wrote it push).
4. In Render, watch the service's **Logs**.
   **You should see** the build run, then `[server] Rabbit Grill ordering API on …`, then
   the status go back to **Live**.
5. **Check these four things** before you walk away:

   | Check | You should see |
   | --- | --- |
   | `<your address>/api/health` | `{"ok":true,…}` |
   | `<your address>/menu` | The menu loads, with its items |
   | Sign in at `/admin` | Your owner account still works |
   | Open **Tables** | Your real tables, and any party currently seated |

6. If the new version is broken, Render's **Deploys** page lists every previous deploy and
   can roll back to one ([deploys](https://render.com/docs/deploys)). A rollback changes
   the code, **not** the database — if a migration changed the database shape, rolling the
   code back may not be enough, which is why step 1 exists.

**Database migrations run themselves** when the server starts. You do not run anything by
hand. Nothing you have entered — menu, tables, staff, settings, history — is touched by a
deploy, because it all lives on the disk under `/var/data`.

**Changing a setting is not a code change.** Prices, charges, hours, roles, payment
methods, retention periods: all of those are edited in **More → Settings** inside the app
and take effect immediately. You never deploy to change the menu.

---

## 11. Fly.io instead

Render is the recommended path. Fly.io is a reasonable alternative, and the repo carries
**`fly.toml`** for it. Use it if you specifically want a machine physically closer to
Thailand (Fly has a Singapore region too, plus more Asian cities) or if you already have a
Fly account.

It is a **command-line** platform: you install the `flyctl` tool and type commands, rather
than clicking through a dashboard. If that sentence puts you off, use Render.

What is different, from [Fly's own documentation](https://docs.fly.io/about/pricing):

| | Render | Fly.io |
| --- | --- | --- |
| How you set it up | Browser: **New → Blueprint** | Terminal: `fly launch`, which reads `fly.toml` |
| Monthly cost of the small size | $7.00 (0.5 CPU / 512 MB) | $3.69 (shared-cpu-1x, 512 MB) or $6.70 (1 GB) |
| Storage | $0.25 per GB per month, and the size must be 1 GB or a multiple of 5 | $0.15 per GB per month in whole GB, plus $0.08 per GB for snapshots (first 10 GB free) |
| Traffic out to Asia | Included allowance, then $0.15/GB | $0.04 per GB |
| A shell on the server | **Shell** tab in the browser | `fly ssh console` |
| Free tier | Free plan exists but **cannot keep data** | No free tier after the trial |

Two things to get right on Fly, both of which `fly.toml` is there to handle:

- **One machine, always on.** Fly machines can stop themselves when idle and run several
  copies. Neither is acceptable here: one process owns the database. `fly.toml` must keep
  auto-stop off and the machine count at one.
- **One volume, and Fly warns about that.** A Fly volume attaches to exactly one machine
  and survives deploys, and Fly takes daily snapshots with 1–60 days of retention. But
  Fly's [volumes documentation](https://docs.fly.io/volumes/overview) explicitly advises
  provisioning **at least two volumes per app**, because a single volume means a single
  drive, and a drive failure means total data loss. This app can only use one. So on Fly,
  [§9](#9-backups) layer 3 — a copy that is not on the platform — matters **more**, not
  less.

Everything else in this guide applies unchanged: the owner account, the menu work, the QR
cards, the daily routine, the backups. Only sections 3 and 4 are Render-specific, and
their Fly equivalents are `fly launch` / `fly volumes create` / `fly certs add`. The
commands, in order, are in the comment at the top of **`fly.toml`**; read that file before
you start, because it is also where the reasons live.

Three Fly-specific traps, since the guide is otherwise written for Render:

- **Create the volume before the first deploy**, in the same region
  (`fly volumes create rabbit_grill_data --region sin --size 5`). A machine that deploys
  without its volume has nowhere persistent to put the database.
- **Use an interactive shell for the owner account.** Run plain `fly ssh console`, then
  `cd /app`, then `npm run admin:create -- --username owner --name 'Owner'`. Do **not**
  use `fly ssh console --command "…admin-create…"`: `--command` runs without an
  interactive terminal, so the password prompt has nothing to read from and the command
  simply hangs with no explanation.
- **Do the disk check first, exactly as on Render.** Inside the shell, `cd /app` and
  `npm run jobs -- restore`; the paths it prints must say `/var/data`
  ([§5](#5-create-the-real-owner-account) step 3). Fly's documentation does not spell out
  which environment the SSH session inherits, so prove it rather than assume it.

---

## 12. What is documented and what you must confirm yourself

Plain accounting, so you know which sentences in this guide are load-bearing.

### Verified on this laptop

Run on Windows 11, Node v24.20.0, with Microsoft Edge installed:

| What was run | Result |
| --- | --- |
| `npm run build` | Succeeded. Client built; `[precompress] 45 files, 2159 KB -> brotli 483 KB, gzip 560 KB`. |
| `npm ci --dry-run` with `NODE_ENV=production` | **Dropped 31 packages, including `vite`, `typescript`, `sharp` and `@vitejs/plugin-react`.** This is why the build stage inside the `Dockerfile` says `npm ci --include=dev`, and why the image that actually runs installs the production packages separately. Nothing the server reads at run time is among those 31: the only files that import them are the development scripts (`scripts/assets.ts`, `scripts/vite-dev.ts`, `scripts/pdf-pages.ts`), none of which runs in production. |
| Every file the running server reads, traced against what the image ships | Database migrations (`server/db/migrations/*.sql`), the dish-photo manifest (`public/media/manifest.json`), the three report fonts (loaded out of `node_modules` by `server/domain/pdf/fonts.ts`), the QR-code library and the built client in `dist/` — all present, all from production dependencies. |
| A production server started against an **empty** database directory | `[db] applied 001_init.sql … 011_round2.sql` — all seven migrations ran on their own — then `/menu` and `/admin` both answered `200`, and the guest menu API answered with an empty menu rather than an error. **With `PUBLIC_BASE_URL` set to an `https://` address and `TRUST_PROXY_HOPS=1`, there were no warnings at all**, which is the state [§3](#3-deploy-on-render-step-by-step) step 12 tells you to expect after step 17. |
| `npm run admin:create -- --username owner --name "Khun Owner"` against an **empty** database with `NODE_ENV=production` | `Created owner (owner).` The owner-creation route in [§5](#5-create-the-real-owner-account) works on a fresh production database. |
| `npm start` with `NODE_ENV=production` and the database and reports pointed at a directory outside the project | Started, served, and printed the expected warnings. |
| `GET /api/health` | `200 {"ok":true,"time":"…"}` — the health check Render polls. |
| `GET /menu`, `GET /admin` | `200 text/html` both. |
| `npm run jobs -- backup --out … --with-reports` **while the server was running** | `database backup written: … (733184 bytes)`, in well under a second. |
| `npm run jobs -- report --year 2026` | `ready: …rpt_….pdf (6021567 bytes, 20 pages, 5275 ms)`. The annual PDF route works **when a Chromium-family browser is present**. |
| `npm run jobs -- restore` | Printed the procedure with the configured absolute paths — which is why [§5](#5-create-the-real-owner-account) step 3 uses it to prove the shell sees the right disk. |

### Taken from the platforms' documentation, and linked where stated

**Re-read against Render's live documentation while this guide was reviewed:** free
services cannot have a persistent disk and lose "uploaded images, local SQLite databases,
etc." on every redeploy, restart or spin-down, and spin down after 15 minutes idle
(~1 minute to wake); a disk's `sizeGB` "must be either `1` or a multiple of `5`" and can
be increased but not decreased; you can't scale a service with a disk past one instance;
a disk prevents zero-downtime deploys; Render snapshots a disk "once every 24 hours" and
keeps snapshots "for at least seven days"; "you can't access a service's disk from any
other service"; disks are $0.25 per GB per month; blueprint fields `runtime: docker`,
`dockerfilePath`, `dockerContext`, `plan: 0.5c-512mb`, `numInstances`, `healthCheckPath`,
`autoDeployTrigger: commit`, `region: singapore` and `envVars … sync: false` are all valid
and `sync: false` is prompted for at creation; web services must bind `0.0.0.0` and
`PORT` defaults to 10000; health checks accept any 2xx or 3xx and Render cancels a deploy
if instances are not healthy within 15 minutes; the dashboard shell is unavailable on free
instances and a Docker image must create `~/.ssh` (`chmod 0700`), must not run its own SSH
server, and must not be "distroless"; a Cloudflare record must be **DNS only** for
verification and needs encryption mode **Full** if later proxied; Render "doesn't impose a
fixed timeout for WebSocket connections". For Fly: every key used in `fly.toml` is in the
current [configuration reference](https://docs.fly.io/reference/configuration), including
`snapshot_retention` (1–60 days), `auto_stop_machines = "off"`, and `strategy = "rolling"`
— with `canary` and `bluegreen` **not** available to an app with volumes.

**Not re-verified against the live page:** the **instance prices** ($7 for
`0.5c-512mb`, $25 for `1c-2g`), the Hobby outbound allowance, and the Fly figures in
[§11](#11-flyio-instead). Treat every number in [§1](#1-what-you-are-about-to-create-and-what-it-costs)
as "roughly right, last checked at the time of writing" and read
[render.com/pricing](https://render.com/pricing) before you commit. The shape of the bill
— about one restaurant meal a month — is what matters, not the cents.

### Not exercised by anyone — confirm these on your first deploy

1. **There is no Docker on the machine this guide was written on.** The `Dockerfile`, the
   `.dockerignore` and the two shell scripts beside them were checked by **reading** them
   — file by file, against every path the server opens at run time — and by running the
   production build and the production server directly on Windows. They were never built
   or run as a container. Specifically unproven: that the image builds at all; that
   Debian's Chromium and this version of the PDF library get along; that the entry point's
   root-dropping and disk-preparation steps behave on Render's kernel as they do when
   their logic is traced by hand. The first deploy is the first real test, and the log
   lines quoted in [§3](#3-deploy-on-render-step-by-step) step 11 and step 12 are how you
   read it.
2. **The annual PDF report needs a Chromium browser on the server, and the image installs
   one.** The `Dockerfile` installs Debian's `chromium` package and points the app at it,
   so unlike a plain Node deployment there is nothing for you to arrange. What has **not**
   been proved is whether Chromium can actually start inside Render's container: it needs
   either its own sandbox (which some hosts forbid) or permission to run without one. The
   image handles both — it tests Chromium once at every start and says in the log which
   way it went:

   ```
   [entrypoint] PDF browser: Chromium started with its sandbox; keeping it on
   [entrypoint] PDF browser: this host forbids Chromium's sandbox, so Chromium runs with --no-sandbox. Annual PDFs will work.
   [entrypoint] WARNING: Chromium would not start at all (…). Annual PDF reports will fail with
   ```

   The first two are fine. **Only the third is a problem**, and even then **nothing else
   breaks**: ordering, bills, payments and the Insights screens all keep working; only the
   annual PDF fails, and it can be retried once the cause is fixed.

   **Confirm it on day one, from inside the app, not from the Shell:** sign in as owner,
   go to **More → Reports**, and generate the annual report for last year. A finished PDF
   means it works. Use the app rather than the Shell for this because the app runs the job
   in the server process the log line above describes, which is the thing you actually care
   about. (If you do want to run it from the Shell, `cd /app` first and use
   `npm run jobs -- report --year 2026`. The command works there too — the image gives a
   shell session the extra flag Chromium needs when run by an administrator — but it
   competes with the live server for the instance's memory, so do it out of hours.)
3. **Memory while a report runs.** 512 MB is comfortable for ordering but tight for Node
   plus a headless browser, and Render's shell shares the instance's memory. If the report
   dies, move the service to `1c-2g`, run it, and move back — billed by the second.
4. **Live updates (the orders board refreshing by itself).** The app uses Server-Sent
   Events: one long-lived HTTP response per open screen, with the headers that ask proxies
   not to buffer or transform it (`Cache-Control: no-store, no-transform`,
   `X-Accel-Buffering: no`) and a heartbeat every 15 seconds so that nothing in between
   decides the connection has gone idle. What is known: Render "doesn't impose a fixed
   timeout for WebSocket connections" ([WebSockets](https://render.com/docs/websocket)).
   What is **not** known: that page is about WebSockets, not Server-Sent Events, and
   Render's documentation says nothing either way about buffering an ordinary streaming
   HTTP response. **This combination has not been run on Render.**

   Confirm it in a minute: open the Orders board on one device and send an order from a
   phone. If it appears instantly, streaming works. If it takes up to five seconds,
   streaming is being buffered and the app has fallen back to polling every five seconds —
   which it does by itself, with the connection indicator saying so. **Either way the
   restaurant works correctly**, and nothing is lost; the fallback is just less brisk.
   This is the one item on this list that needs no action if it goes the wrong way.
5. **Node's version is pinned in the image, so Render does not choose it.** Because this
   is a Docker deployment, the `Dockerfile` names an exact Node release
   (`node:24.20.0-trixie-slim`) and Render's own Node-version setting plays no part. That
   is deliberate: `package.json` asks for "Node 24 or newer" with no upper bound, and a
   deployment that resolved that range itself could move the restaurant to Node 25 on an
   unrelated Tuesday. The thing to confirm is only that the pinned version is the one that
   runs — the build log will show the image being pulled by name. **Do not** set a
   `NODE_VERSION` environment variable; on a Docker service it would do nothing and would
   mislead the next person.
6. **Whether the Shell opens at all, and whether it sees the live disk.** Two separate
   unknowns, and the whole of [§5](#5-create-the-real-owner-account) and
   [§9](#9-backups) rest on them.
   - *Opening it:* Render requires a Docker image to create a `~/.ssh` directory with
     `chmod 0700`, not to run its own SSH server, and not to be a "distroless" image
     ([SSH](https://render.com/docs/ssh)). The `Dockerfile` satisfies all three — it
     creates that directory for the administrator account in both of the places the home
     directory could be — but this has not been tested against Render's shell.
   - *Seeing the disk:* Render's documentation says a shell session connects to your
     running service instance, which is why [§5](#5-create-the-real-owner-account) step 3
     prints the paths before anything is created. If that check shows the wrong paths, or
     if the Shell will not open, **stop and ask** rather than improvising: there is no
     other way to create the first owner account, and guessing at this step is how a
     database ends up somewhere that the next deploy deletes.
7. **Nothing in this guide has been checked on a real phone on restaurant Wi-Fi**, as
   [docs/OPERATIONS.md](OPERATIONS.md) also states. Scan a real card with a real phone
   before go-live.

### Troubleshooting the first deploy

| What you see | Likely cause | What to do |
| --- | --- | --- |
| **"Deploy Blueprint" is refused** with a complaint about the disk size | A disk `sizeGB` that is neither `1` nor a multiple of `5` — Render accepts nothing else ([blueprint spec](https://render.com/docs/blueprint-spec)) | `render.yaml` says `sizeGB: 5`, which is valid. If someone has edited it, put it back to `5` |
| Build fails with **`vite: not found`** (or `sh: 1: vite: not found`) | Someone added a **Build Command** to the service, or edited the `Dockerfile`'s first stage. The tool that builds the pages is a development dependency, and `npm` leaves development dependencies out whenever `NODE_ENV` is `production`. **Verified here:** with `NODE_ENV=production`, `npm ci` drops 31 packages including `vite`, `typescript` and `sharp`. | This service is a **Docker** service: it has no Build Command, and the `Dockerfile` already says `npm ci --include=dev` in its build stage. Remove any Build Command that has been added, and do not add one. See [§3](#3-deploy-on-render-step-by-step) step 9, "Where is the Build Command?" |
| Build fails some other way | A missing deployment file, or the Chromium install step | Read the last 20 lines of the log; they usually name the file or the package |
| Status never reaches **Live** | The health check is failing | Open `/api/health` directly. Render cancels a deploy if instances do not pass within 15 minutes ([health checks](https://render.com/docs/health-checks)) |
| The log says **`/var/data is NOT on a separate disk`** | The persistent disk is not attached or not mounted at `/var/data` | **Stop and fix this before entering anything.** Service page → **Disks**: there must be a disk named `data` mounted at `/var/data`. [§3](#3-deploy-on-render-step-by-step) step 12 |
| `[db] applied 001_init.sql …` appears on a **second** deploy | The deploy started with an empty database — almost always the same cause as the row above | Same fix. Then restore the most recent backup ([§9](#9-backups)) |
| `/api/health` works, `/menu` is blank | The browser app was not built | Look for `dist/index.html is missing` in the log |
| Staff sign in, then bounce back to the login page | Cookies. `PUBLIC_BASE_URL` must be the `https://` address | Fix `PUBLIC_BASE_URL`, save, redeploy |
| The QR print page says cards cannot be printed | `PUBLIC_BASE_URL` points somewhere no phone can reach | [§3](#3-deploy-on-render-step-by-step) step 16 |
| QR codes open the wrong address | They were printed before the domain was final | Reprint ([§7](#7-print-and-place-the-table-qr-cards)) |
| "Too many attempts" when a guest joins | Wrong PINs — or `TRUST_PROXY_HOPS` does not match the number of proxies, so the whole restaurant shares one allowance | Rotate the visit PIN to clear a lockout. Then check `TRUST_PROXY_HOPS`: **`1`** with Render alone, **`2`** if Cloudflare's orange cloud is on ([§4](#4-point-your-domain-at-it)) |
| The domain will not verify in Render | A Cloudflare record left on **Proxied** (orange cloud) | Set it to **DNS only** ([§4](#4-point-your-domain-at-it)) |
| The Shell tab will not open | The image or the plan does not allow it | [§12](#12-what-is-documented-and-what-you-must-confirm-yourself) point 6. Do not improvise another way to create the owner account — ask |
| `npm: command not found`, or `Cannot find module` in the Shell | You did not `cd /app` first | Every Shell command in this guide starts with `cd /app` ([§5](#5-create-the-real-owner-account) step 3) |
| Report job says `browser_unavailable` | Chromium could not start — **not** that it is missing; the image installs it | Point 2 above. Check the `[entrypoint] PDF browser:` line in the startup log, which says which of the three cases it is |
| Orders appear after a few seconds, not instantly | Live stream buffered; app fell back to polling | Point 4 above. Not an outage |
| The server stops writing orders; the disk looks full | Old backup files piling up on the same disk | [§9](#9-backups), "Delete old backups" |
| Everything was fine, now the service is suspended | Unpaid invoice | Pay it; the service resumes ([§1](#1-what-you-are-about-to-create-and-what-it-costs)) |

---

## 13. Go-live checklist

One page. Tick in order; the last box is the switch.

**The server**

- [ ] Render account created, **Hobby** workspace, card on file
- [ ] Blueprint deployed from `MPC0367/rabbit-grill-ordering`, branch `main`, status **Live**
- [ ] Region is **Singapore**; instance count is **1**
- [ ] A **persistent disk** is attached, mounted at `/var/data`, **5 GB**
- [ ] The startup log does **not** contain `WARNING: /var/data is NOT on a separate disk`
- [ ] `DATABASE_PATH` is `/var/data/rabbit-grill.db` and `REPORTS_DIR` is `/var/data/reports` — **both under the disk**
- [ ] `NODE_ENV` is `production`, and `TRUST_PROXY_HOPS` matches the number of proxies: **`1`** for Render alone, **`2`** if Cloudflare's orange cloud is on
- [ ] `<address>/api/health` returns `{"ok":true,…}`
- [ ] No **Build Command** or **Start Command** has been added to the service (it is a Docker service and must not have either)

**The address**

- [ ] The final address is decided and will not change
- [ ] (If using a domain) the `CNAME` is added, Render shows the domain **verified**, and the padlock appears in the browser
- [ ] (If the DNS is at Cloudflare) the record is **DNS only** — grey cloud, not orange
- [ ] `PUBLIC_BASE_URL` is set to that exact `https://` address, and the service has been redeployed since
- [ ] The startup log no longer warns that cards point at an unreachable address

**The people**

- [ ] The real **owner** account was created in Render's Shell, with a password typed only there
- [ ] You can sign in at `/admin` as that owner
- [ ] One account per member of staff exists in **More → Team**, each with the narrowest role
- [ ] **No `demo-*` account is active**

**The menu** (all of [docs/OWNER-CHECKLIST.md](OWNER-CHECKLIST.md); these are the blockers)

- [ ] The menu is **in the system** at all — typed in **Menu → Catalog**, or imported in **Menu → Import** (a production database starts empty)
- [ ] Every item you will sell is **owner-verified**: name, price, options, photo, description
- [ ] Thai names supplied for the drinks you will sell
- [ ] **Allergens** recorded for every item you will sell
- [ ] **Charges** entered: service charge and VAT exactly as the restaurant charges them
- [ ] **Payment methods** confirmed in Settings
- [ ] **Opening hours** verified, and you have decided whether ordering closes outside them
- [ ] **Retention periods** confirmed in **Settings → Data retention**
- [ ] The ambiguous items are resolved or archived (Grilled Lamb Rack 890/1,590; Prime Rib per-100 g rules; the 3 draft beers)

**The tables**

- [ ] The real tables exist in **Tables → Manage tables & QR** — not the demo's 01–12
- [ ] QR cards printed **after** the address was final, one per table
- [ ] Cards placed on the tables, and spares kept
- [ ] **A real phone has scanned a real card**, entered a PIN from staff, and sent an order that arrived on the Orders board

**Safety**

- [ ] One backup taken with `cd /app` then `npm run jobs -- backup … --with-reports`, and the output line seen
- [ ] A daily backup is on the closing checklist, with a named person
- [ ] That same person knows to **delete backups older than a week** from `/var/data/backups`, and to check `du -sh /var/data` monthly
- [ ] One **restore** has been tested somewhere that is not the live system
- [ ] One **data export** ZIP downloaded and stored off Render
- [ ] An annual PDF has generated successfully on the server from **More → Reports**, **or** you have read the `[entrypoint] PDF browser:` line in the log, accepted that it does not work yet, and know it breaks nothing else
- [ ] Staff have been shown the paper-order routine and **Enter paper order**
- [ ] Staff know how to **pause ordering** and how to **rotate a table's PIN**

**Go live**

- [ ] Open **More → Settings → Operating mode** and switch to **live**. If it refuses because a demo account is still active, use **"Deactivate demo accounts and switch"** — it retires them, signs them out, records it and switches, in one step.
- [ ] **You should see** the mode shown as **live**, and demo data labelled as such wherever it still appears.
- [ ] Order one real dish at one real table, and take it all the way to a completed checkout, before the first guest does.
