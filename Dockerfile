# Rabbit Grill Khao Yai, table QR ordering: the production container.
#
# ONE process, ONE SQLite file, ONE disk. The process owns the only database
# connection, the live-event hub and the job timers, so this image must never
# be run as two instances against the same disk. render.yaml and fly.toml both
# pin the instance count to one; keep it that way.
#
# Two stages. The first builds the browser app with Vite and is thrown away;
# the second is what ships. The server itself is TypeScript executed directly
# by Node 24's type stripping, so the .ts sources travel into the runtime
# image. They are not compiled, and there is no build output for them.
#
# Local development is untouched: `npm run dev` and `npm start` on a laptop
# never read this file.

# Pinned on purpose. A floating "node:24" would change Node under the
# restaurant on some unrelated Tuesday. Debian trixie is the suite whose
# chromium package the runtime stage installs; both stages share the base so
# the build and the runtime agree on libc and OpenSSL.
ARG NODE_IMAGE=node:24.20.0-trixie-slim


# ===================================================================== build
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# Dependencies first, in their own layer: a source-only change then reuses the
# cached install instead of downloading 300 packages again.
#
# --include=dev is not decoration. Vite, which builds the pages, is a dev
# dependency, and npm leaves dev dependencies out whenever NODE_ENV is
# production. This stage does not set NODE_ENV, but a base image or a future
# npm default could, and the failure would be a confusing "vite: not found"
# halfway through a deploy. None of these packages reaches the runtime image.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# .dockerignore keeps var/ (the database), node_modules/, dist/, test/ and
# design-lab/ out of the context, so this copies the source and little else.
COPY . .

# `npm run build` is two steps: vite build writes dist/, then
# scripts/precompress.ts writes the .br and .gz siblings the server hands to
# phones on restaurant Wi-Fi instead of compressing each bundle per guest.
RUN npm run build


# =================================================================== runtime
FROM ${NODE_IMAGE} AS runtime

# Annual PDF reports are HTML printed by a headless Chromium-family browser
# (server/domain/pdf/render.ts -> scripts/browser.ts, puppeteer-core). With no
# browser on the server, every report job fails with browser_unavailable while
# the rest of the app keeps working, so the browser is installed here.
#
#   chromium          the browser. About 320 MB installed: the bulk of this
#                     image. Debian patches it with the suite's security
#                     updates, which a downloaded build would not get.
#   chromium-sandbox  its setuid sandbox helper, so Chromium can keep its own
#                     sandbox on hosts that permit it. scripts/docker-entrypoint.sh
#                     probes once at start and falls back to --no-sandbox.
#   dumb-init         pid 1: forwards SIGTERM to Node (which closes the
#                     database) and reaps any Chromium orphan.
#   fonts-*           The PDF embeds its own Noto Sans Thai, Oswald and
#                     Cormorant Garamond as base64 data URIs
#                     (server/domain/pdf/fonts.ts), so no system font is needed
#                     for the report text. These are the fallback that keeps
#                     Chromium from drawing tofu boxes for anything outside the
#                     embedded subsets, Thai included.
#   util-linux        already in the base image; named so that setpriv, which
#                     the entrypoint uses to drop root, cannot go missing.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      chromium-sandbox \
      dumb-init \
      fonts-liberation \
      fonts-thai-tlwg \
      util-linux \
 && rm -rf /var/lib/apt/lists/*

# The account the server runs as. It owns no application file: /app stays
# root-owned and read-only to it, so a compromised request handler cannot
# rewrite the code it is running from. Only the data directory is writable.
RUN groupadd --system --gid 10001 rabbit \
 && useradd --system --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin rabbit

# setpriv (from util-linux, part of the base image) is how the entrypoint drops
# root. Asserted at build time so a rebuilt image can never ship without it.
RUN test -x /usr/bin/setpriv

WORKDIR /app
ENV NODE_ENV=production

# Runtime dependencies only: hono, @hono/node-server, puppeteer-core, qrcode,
# react, react-dom, zod and the three @fontsource-variable packages the PDF
# reads its .woff2 files from. --ignore-scripts because none of them has an
# install script, and nothing should be compiled inside the restaurant's image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force

# What the server actually reads while running:
#   server/    the app, including db/migrations/*.sql, applied at every start
#   shared/    code shared with the browser app
#   scripts/   start.ts (the entry), browser.ts (finds the PDF browser),
#              env.ts, and admin-create.ts, which is how the first owner
#              account is created from a shell on the server
#   public/    media/manifest.json, re-read by server/domain/catalog.ts
#   data-src/  the draft catalog; read only while seeding, never in production
#   docs/      OPERATIONS.md and the rest, so whoever opens a shell on the
#              server can read the procedures without leaving it
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
COPY public ./public
COPY data-src ./data-src
COPY docs ./docs
COPY tsconfig.json README.md ./

# The built browser app, with its .br/.gz siblings. The server serves /media/*
# from here too, so the dish photographs ride along.
COPY --from=build /app/dist ./dist

# Chromium is launched through this wrapper, so the entrypoint can add the
# flags a container needs without changing scripts/browser.ts. `install` sets
# the executable bit, which a checkout made on Windows will not carry.
RUN install -m 0755 /app/scripts/chromium-rg.sh /usr/local/bin/chromium-rg \
 && chmod 0755 /app/scripts/docker-entrypoint.sh

# The data. BOTH of these must sit on the platform's persistent disk, mounted
# at /var/data by render.yaml and fly.toml. Losing them loses every order,
# bill, payment and report; the entrypoint warns at start if /var/data turns
# out to be inside the container after all.
ENV DATABASE_PATH=/var/data/rabbit-grill.db \
    REPORTS_DIR=/var/data/reports

# 0.0.0.0 is what both platforms' routers need (Fly Proxy only reaches IPv4
# listeners, so :: is not an improvement there). PORT here is only a default
# for a plain `docker run -p 8344:8344`: Render injects its own PORT, and
# fly.toml sets this one next to internal_port.
ENV HOST=0.0.0.0 \
    PORT=8344

# The PDF browser. scripts/browser.ts finds it through BROWSER_PATH and passes
# no sandbox flags of its own, so these are the only place the flags are set.
# The entrypoint overwrites RG_CHROMIUM_FLAGS for the server process after one
# sandbox probe; the wrapper itself adds --no-sandbox when it is run as root,
# because Chromium refuses to start as root without it and an operator's shell
# session on the server is root. See scripts/chromium-rg.sh.
ENV BROWSER_PATH=/usr/local/bin/chromium-rg \
    RG_CHROMIUM_FLAGS="--disable-dev-shm-usage --disable-gpu"

# /app is read-only to the app user, so anything wanting a home, a cache or a
# fontconfig directory is pointed at /tmp instead of failing quietly.
ENV HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    XDG_CONFIG_HOME=/tmp/.config \
    NPM_CONFIG_CACHE=/tmp/.npm

# A shell ON the server, which the whole of docs/DEPLOY.md depends on: it is
# how the first owner account is created and how backups are taken. Render's
# requirements for a Docker image are explicit -- "Make sure your Dockerfile
# creates a `~/.ssh` directory for the running user with the correct
# permissions (chmod 0700)", the image must not run its own SSH server (it
# does not), and distroless images are refused (this is Debian, with bash)
# -- https://render.com/docs/ssh
#
# The image declares no USER, so the running user is root and a shell session
# lands there. Both candidate homes are prepared: /tmp because ENV HOME says
# so above, /root because that is what root's passwd entry says, and the two
# can disagree depending on how the platform starts the session. Render also
# requires that the persistent disk is NOT mounted at the running user's home,
# which is why the disk is at /var/data and not under either of these.
RUN mkdir -p /tmp/.ssh /root/.ssh \
 && chmod 0700 /tmp/.ssh /root/.ssh

# Present so a `docker run` with no volume still starts. A mounted disk hides
# this and the entrypoint recreates it on the disk instead.
RUN mkdir -p /var/data/reports \
 && chown -R 10001:10001 /var/data

EXPOSE 8344

# For `docker run` and for any platform that reads it. Render uses
# healthCheckPath in render.yaml and Fly uses [[http_service.checks]] in
# fly.toml instead: neither platform reads this instruction, so it is here for
# local runs and for honesty, not as the deployed health check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD ["node","-e","fetch('http://127.0.0.1:'+(process.env.PORT||8344)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# The entrypoint prepares the disk, drops root, settles the Chromium sandbox
# and then execs this command under dumb-init. CMD is exactly what `npm start`
# runs, without npm sitting in the process tree swallowing signals. Overriding
# the command (Render's "Docker Command", `docker run <image> ...`) still works:
# the entrypoint runs whatever it is given.
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "scripts/start.ts"]
