# Working on this repository

Rabbit Grill Khao Yai table-QR ordering platform: one Node 24 process (Hono +
`node:sqlite`) serving a React client with two interfaces — guest menu at
`/menu` and `/q/<table token>`, staff platform at `/admin`.

Read before changing anything: `docs/ARCHITECTURE.md` (conventions and file
ownership), `docs/API.md` (every endpoint and the internal module contracts),
`docs/DECISIONS.md` (why things are the way they are), `docs/DESIGN.md` (the
visual system), `docs/TESTING.md`, `docs/OPERATIONS.md`. The product brief is
the acceptance standard and `docs/FEATURE-MATRIX.md` maps it to the code.

## Commands

```bash
npm run dev          # seeds the demo restaurant, then API + web on http://localhost:8344
npm test             # unit + integration (real server, temp database)
npm run e2e          # browser journeys          | run these three from PowerShell
npm run shots        # visual set + page audit   | (see "Environment" below)
npm run typecheck && npm run build
npm run db:reset     # wipe the development database; the next start reseeds
```

Demo staff: `demo-owner`, `demo-manager`, `demo-cashier`, `demo-floor`,
`demo-kitchen`, each with password `rabbit-<role>-demo`. Open-table PINs print
in the seed log. Demo accounts stop working once `operating_mode` is `live`.

## Environment (Windows, this machine)

- **A browser cannot start from the sandboxed Bash tool.** Anything using
  puppeteer — `npm run e2e`, `npm run shots`, `scripts/qa-shoot.ts`,
  `scripts/pdf-pages.ts`, and any annual-PDF job — must run from the PowerShell
  tool. A server started from Bash fails PDF jobs with `browser_unavailable`.
- **Seed before starting** when a database is empty; `scripts/dev.ts` already
  does this before the watched API starts, so a file save cannot interrupt it.
- **Never type a password into the in-app browser pane.** Use the demo
  credentials through `scripts/qa-shoot.ts` (it signs in through the API), or
  let the user sign in themselves.
- The Read tool cannot render PDFs here. Use `npm run pdf:pages` to turn report
  pages into PNGs and look at those.

## Code rules

- Node strips types, it does not compile them: `import type` for types,
  `.ts`/`.tsx` extensions on relative imports, no enums or other
  non-erasable syntax. `npm run typecheck` must stay clean.
- Money is integer satang and only `shared/money.ts` computes it. Times are
  stored UTC; reporting uses the Asia/Bangkok business date stamped at write
  time (`shared/time.ts`).
- Mutations run inside `tx()`, re-read state inside the transaction, check the
  row `version`, and write `audit()` + `emit()` in the same transaction.
  Client-supplied idempotency keys plus UNIQUE constraints prevent duplicates.
- New records carry `is_fixture` while the restaurant is in demo mode, so real
  reports can exclude demo data.
- User-facing strings go through `useI18n()` with keys in the owning
  `client/src/i18n/*.ts` file, both `th` and `en`. Thai copy is natural
  restaurant Thai: no calques, no `ถูก` + verb passives, no officialese, brand
  names in Latin script.
- Components come from `client/src/ui` (see `/ui-kit` in development). No
  literal colours: use the tokens.

## Honesty rules this product is built on

- Never invent restaurant facts: hours, allergens, portion sizes, doneness
  options, ratings, promotions. Everything in the catalog traces to the
  restaurant's own printed menus (`docs/source-audit.md`), and no item is
  owner-verified yet — live mode refuses to sell unverified items.
- Do not present local checks as production verification. Nothing here has run
  on a real host, phone network or payment provider.
- Keep the guest's words intact: notes and allergy text are stored and shown as
  typed, never translated or edited.
