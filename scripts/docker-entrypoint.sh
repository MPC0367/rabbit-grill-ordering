#!/bin/sh
# Container entry point. Used only inside the Docker image: `npm run dev` and
# `npm start` on a laptop never touch this file.
#
# Four things, in order, then it gets out of the way:
#
#   1. Make the persistent disk usable. Render and Fly attach the disk owned by
#      root, and the server must not run as root, so the directories are
#      created and handed to the app user while this script still has root.
#   2. Drop root for good, with setpriv, which execs rather than forks: the
#      process id, the signals and the stdio all carry straight through.
#   3. Settle the Chromium sandbox, so annual PDF reports work (or say plainly
#      in the log that they will not). scripts/browser.ts passes no sandbox
#      flags of its own, so this is the only place that can decide.
#   4. exec dumb-init, which becomes pid 1: it forwards SIGTERM to Node, where
#      server/main.ts stops the job timers and closes the SQLite database, and
#      it reaps any Chromium child left behind by a failed report.
#
# Everything it decides is printed, because on a hosted platform the log is the
# only window the owner has.
set -eu

APP_UID=10001
APP_GID=10001
WRAPPER=/usr/local/bin/chromium-rg
# Flags every container needs, sandbox or not:
#   --disable-dev-shm-usage  /dev/shm is 64 MB in most containers; Chromium
#                            would run out of it printing a year of orders
#   --disable-gpu            there is no GPU, and probing for one is slow
BASE_FLAGS="--disable-dev-shm-usage --disable-gpu"

log() { echo "[entrypoint] $*"; }

# ---------------------------------------------------------------- 1 + 2: disk, then root
if [ "$(id -u)" = "0" ]; then
  db_dir=$(dirname "${DATABASE_PATH:-/var/data/rabbit-grill.db}")
  reports_dir=${REPORTS_DIR:-/var/data/reports}

  for d in "$db_dir" "$reports_dir"; do
    mkdir -p "$d"
    # Only the directory's own owner is checked, and only then is the tree
    # handed over: a reports directory with hundreds of PDFs should not be
    # walked on every restart.
    if [ "$(stat -c '%u' "$d")" != "$APP_UID" ]; then
      log "handing $d to the app user (was uid $(stat -c '%u' "$d"))"
      chown -R "$APP_UID:$APP_GID" "$d"
    fi
  done

  # The database and its two SQLite sidecars, every time and whatever the
  # directory says. Creating the first owner account from a shell on the
  # server runs as root, and if that left a root-owned -wal or -shm behind the
  # server would come back up unable to write to its own database.
  for f in "${DATABASE_PATH:-/var/data/rabbit-grill.db}" \
           "${DATABASE_PATH:-/var/data/rabbit-grill.db}-wal" \
           "${DATABASE_PATH:-/var/data/rabbit-grill.db}-shm"; do
    if [ -e "$f" ]; then chown "$APP_UID:$APP_GID" "$f"; fi
  done

  # A disk that was never attached looks exactly like one that was, until the
  # next deploy throws it away with every order, bill and report in it. Same
  # filesystem as / means no separate disk is mounted there.
  if [ "$(stat -c '%d' "$db_dir")" = "$(stat -c '%d' /)" ] && [ "${RG_ALLOW_EPHEMERAL_DATA:-0}" != "1" ]; then
    log "WARNING: ----------------------------------------------------------------"
    log "WARNING: $db_dir is NOT on a separate disk. It is inside the container,"
    log "WARNING: so every order, bill, payment and report will be DELETED on the"
    log "WARNING: next deploy or restart. Attach the persistent disk and mount it"
    log "WARNING: there (render.yaml 'disk', fly.toml '[mounts]'), then redeploy."
    log "WARNING: Set RG_ALLOW_EPHEMERAL_DATA=1 to silence this on purpose."
    log "WARNING: ----------------------------------------------------------------"
  fi

  log "dropping root: the server runs as uid $APP_UID"
  exec /usr/bin/setpriv --reuid="$APP_UID" --regid="$APP_GID" --clear-groups "$0" "$@"
fi

# ---------------------------------------------------------------- 3: the PDF browser
# Chromium's own sandbox needs either its setuid helper (installed, but the
# platform may forbid setuid) or unprivileged user namespaces (the platform may
# not allow them either). Where neither works, Chromium exits at once and every
# report job fails with browser_unavailable. One probe decides which it is.
#
#   RG_CHROMIUM_SANDBOX=auto  (default) probe; fall back to --no-sandbox
#                       on            keep the sandbox whatever the probe says
#                       off           go straight to --no-sandbox, no probe
#
# --no-sandbox is a real reduction in defence, and acceptable here for reasons
# worth stating: the container itself is the boundary, the process is not root,
# and the page Chromium prints is created by this server with every network
# request aborted except inline data: URIs (server/domain/pdf/render.ts), so
# the renderer never loads anything from the internet.
if [ "${BROWSER_PATH:-$WRAPPER}" != "$WRAPPER" ]; then
  log "PDF browser: BROWSER_PATH is set to ${BROWSER_PATH}, so its flags are left alone"
else
  probe() {
    d=$(mktemp -d)
    # The screenshot is the proof: Chromium can exit 0 having rendered nothing.
    if RG_CHROMIUM_FLAGS="$1" timeout 25 "$WRAPPER" \
        --headless --no-first-run --no-default-browser-check --disable-extensions \
        --user-data-dir="$d" --screenshot="$d/probe.png" about:blank \
        >"$d/probe.log" 2>&1
    then rc=0; else rc=$?; fi
    if [ ! -s "$d/probe.png" ]; then rc=99; fi
    if [ "$rc" != "0" ]; then probe_log=$(tail -n 2 "$d/probe.log" 2>/dev/null | tr '\n' ' '); fi
    rm -rf "$d"
    [ "$rc" = "0" ]
  }

  case "${RG_CHROMIUM_SANDBOX:-auto}" in
    off)
      flags="$BASE_FLAGS --no-sandbox"
      log "PDF browser: sandbox off (RG_CHROMIUM_SANDBOX=off)"
      ;;
    on)
      flags="$BASE_FLAGS"
      log "PDF browser: sandbox required (RG_CHROMIUM_SANDBOX=on); reports fail if this host forbids it"
      ;;
    *)
      if probe "$BASE_FLAGS"; then
        flags="$BASE_FLAGS"
        log "PDF browser: Chromium started with its sandbox; keeping it on"
      elif probe "$BASE_FLAGS --no-sandbox"; then
        flags="$BASE_FLAGS --no-sandbox"
        log "PDF browser: this host forbids Chromium's sandbox, so Chromium runs with --no-sandbox. Annual PDFs will work."
      else
        flags="$BASE_FLAGS --no-sandbox"
        log "WARNING: Chromium would not start at all (${probe_log:-no output}). Annual PDF reports will fail with"
        log "WARNING: browser_unavailable. Ordering, checkout and every other screen are unaffected."
      fi
      ;;
  esac
  export RG_CHROMIUM_FLAGS="$flags"
  export BROWSER_PATH="$WRAPPER"
fi

# ---------------------------------------------------------------- 4: hand over
log "starting: $*"
exec /usr/bin/dumb-init -- "$@"
