# See it working, from GitHub, without paying for hosting

GitHub Pages cannot run this app: it serves files, and the ordering system needs
a program that stays running (it holds the database, pushes live updates to the
kitchen board and runs the nightly jobs).

**GitHub Codespaces can.** It starts a small computer in GitHub's cloud, runs
the real app there, and gives you an https link you can open on any phone.
It is free within the monthly allowance below, and needs no card and no domain.

Use it to show the restaurant how the system works. It is **not** where real
service should run (see [DEPLOY.md](DEPLOY.md) for that): a codespace sleeps
when nobody uses it, and its data disappears when you delete it.

## Start it

Either press the **Open in GitHub Codespaces** button at the top of the
repository page, or do it by hand:

1. Open **https://github.com/MPC0367/rabbit-grill-ordering**.
2. Press the green **Code** button → **Codespaces** tab → **Create codespace on main**.
3. Wait. The first start takes about three to five minutes: GitHub builds the
   machine, installs the packages, creates the demo restaurant (12 tables, the
   menu, 20 months of fixture history) and starts the app. You will see the
   progress in a terminal at the bottom of the screen.
4. When it finishes, a browser preview opens. In the terminal's **PORTS** tab
   you will see port **8344** labelled "Rabbit Grill (guest menu + staff)".

> **Do not sign in to the staff side in that preview panel.** The preview is an
> embedded frame, and the staff session cookie is deliberately not sent inside
> one, so the sign-in screen will just keep coming back. Copy the address from
> the **Forwarded Address** column in the PORTS tab and open it in a normal
> browser tab instead. The guest menu works either way; only staff sign-in
> needs the real tab.

## Make the link openable on a phone

By default the link only works for you, signed in to GitHub.

1. In the **PORTS** tab, right-click port **8344** → **Port Visibility** → **Public**.
2. Copy the address in the **Forwarded Address** column. It looks like
   `https://<your-codespace-name>-8344.app.github.dev`.
3. Anyone with that link can now open it, including a phone on mobile data.
   Turn it back to Private when the demo is over.

> **Public means public.** That link opens the staff platform as well as the
> guest menu, and the demo passwords are printed on this repository's front
> page, which anyone can read. While the port is Public, treat the link like a
> password: send it to the people in the meeting, not to a group chat, and set
> the port back to Private as soon as you are finished. There is nothing real
> behind it — it is demo data on a throwaway machine — but someone with the
> link can sit in your Orders board while you present.

## What to open

| Who | Where | How to get in |
| --- | --- | --- |
| Staff | `<your link>/admin` | `demo-owner` with password `rabbit-owner-demo` (also `demo-manager`, `demo-cashier`, `demo-floor`, `demo-kitchen`, each `rabbit-<role>-demo`) |
| A guest at a table | **Admin → Tables → Manage tables & QR**, print or show a card, scan it | Nothing to type: scanning the card joins that table |
| Anyone, browse only | `<your link>/menu` | Nothing: public visitors can read the menu but not order |

A rehearsed path through the system, with the dishes and tables that are safe
to demo, is in [DEMO-SCRIPT.md](DEMO-SCRIPT.md).

Scanning a table card with a real phone is the part worth showing: the phone
joins that table, orders, and the kitchen board on your screen updates live.

Every price, dish and figure is the demo seed: the banner says **Demo data**,
and no item has been approved by the restaurant yet.

## What it costs

A personal GitHub Free account includes **120 core-hours and 15 GB of storage
per month** for Codespaces; GitHub Pro includes 180 core-hours and 20 GB
([GitHub billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces)).
This container is a 2-core machine, so one hour of use costs two core-hours:
roughly **60 hours of demo time a month** on a free account. Without a card on
file, Codespaces simply stops when the allowance runs out; it never charges you
by surprise.

To protect the allowance:

- **Stop it when you finish**: github.com/codespaces → `...` next to the
  codespace → **Stop codespace**. It also stops itself after 30 minutes idle.
- **Delete it** when the demo is over. Deleting removes its database as well.

## Starting and stopping the app inside the codespace

The app starts by itself. If you stop it, or want it back after a restart:

```bash
npm run dev
```

To wipe the demo data and start the restaurant fresh (no history):

```bash
npm run db:reset && npm run dev
```

## Known limits of this way of running it

- **It sleeps.** After 30 minutes without use the machine stops and the link
  stops answering until you start it again.
- **It is not for real service.** Guest orders would be lost when the codespace
  is deleted, and the link is tied to your GitHub account's allowance.
- **The annual PDF** needs Chromium, which this container installs. If a report
  job ever fails with `browser_unavailable`, Chromium did not install; the rest
  of the system is unaffected.
- **Not yet exercised on a real deploy.** The configuration in this folder has
  been written and checked by reading; the first codespace you create is the
  first real run.

When the restaurant wants to take real orders, follow [DEPLOY.md](DEPLOY.md)
instead: a small always-on server with a permanent disk, an https domain and
their own staff accounts.
