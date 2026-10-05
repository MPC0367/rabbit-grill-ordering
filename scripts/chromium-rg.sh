#!/bin/sh
# Launch Chromium with the flags a container needs. Used only inside the
# Docker image; nothing on a laptop or in development calls this.
#
# scripts/browser.ts (puppeteer-core) launches whatever BROWSER_PATH points at
# and passes no sandbox or /dev/shm flags of its own. That is right on a
# laptop, where Edge or Chrome can use its own sandbox, and wrong inside a
# container, where the kernel usually will not allow it. So the image points
# BROWSER_PATH here, and scripts/docker-entrypoint.sh decides the contents of
# RG_CHROMIUM_FLAGS once at start. No application code changes.
#
# `exec` keeps this script out of the process tree. That matters: puppeteer
# talks to Chromium over stdio pipes (--remote-debugging-pipe on fd 3 and 4),
# which exec hands straight on, and it is what makes Chromium exit when the
# Node process dies instead of lingering as an orphan.
#
# RG_CHROMIUM_FLAGS is deliberately unquoted below: it is a list of separate
# flags, not one argument. It is written by the entrypoint at start and never
# by anything a guest or a request can reach.
FLAGS=${RG_CHROMIUM_FLAGS:-}

# Chromium REFUSES to start as root unless it is given --no-sandbox ("Running
# as root without --no-sandbox is not supported"), and its sandbox could not
# protect a root process anyway. The server never runs as root -- the entry
# point drops to uid 10001 before Node starts, and its probe decides the flags
# for that process. But a human shell on the server does: Render's Shell tab
# and `fly ssh console` both land you as root. Without this, an operator who
# runs `npm run jobs -- report --year 2026` by hand to check the annual PDF
# would always be told `browser_unavailable` on an image where reports
# actually work -- a working server that looks broken, which is worse than a
# broken one. So root gets --no-sandbox added here, and nowhere else.
if [ "$(id -u)" = "0" ]; then
  case " $FLAGS " in
    *" --no-sandbox "*) ;;
    *) FLAGS="$FLAGS --no-sandbox" ;;
  esac
fi

# shellcheck disable=SC2086
exec /usr/bin/chromium $FLAGS "$@"
