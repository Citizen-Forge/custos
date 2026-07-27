#!/usr/bin/env bash
#
# scripts/poll-and-redeploy.sh -- Unraid-side zero-touch redeploy daemon
# for the custos project.
#
# Polls ghcr.io for the `:main` digest of `IMAGE` every `POLL_INTERVAL`
# seconds (default 30). When the remote digest differs from the digest
# currently running on `GATEWAY_CONTAINER`, triggers:
#
#   cd "$COMPOSE_DIR" && \
#     docker compose pull gateway && \
#     docker compose up -d --no-deps gateway
#
# Compose-flavoured. `docker-compose.override.yml` (in `COMPOSE_DIR`) is
# auto-stacked by `docker compose`, so its `192.168.250.225` static IP
# on `br0` stays load-bearing across every redeploy. `--no-deps gateway`
# keeps qdrant and the bind-mounted `./data`, `./workspace`, and
# `./data/claude-home` volumes untouched across every redeploy.
#
# Persistence: on first run the script auto-installs its own
# `/boot/config/go` marker block, so on every subsequent Unraid boot
# it restarts automatically. `/mnt/user/appdata/costos-runner` is
# Unraid's array-backed mount and survives reboots; `/boot/config` is
# flash-backed and survives array moves and reboots.
#
# Usage:
#   bash scripts/poll-and-redeploy.sh            # foreground (debug)
#   nohup bash scripts/poll-and-redeploy.sh &    # backgrounded
#
# Tunables (env):
#   POLL_INTERVAL      Default 30. Seconds between digest polls.
#   COMPOSE_DIR        Default /mnt/dockermain/appdata/custos
#   IMAGE              Default ghcr.io/citizen-forge/custos
#   TAG                Default main (the rolling channel)
#   GATEWAY_CONTAINER  Default custos-gateway-1
#   STATE_DIR          Default /mnt/dockermain/appdata/custos
#                       (deliberately the same path as COMPOSE_DIR so
#                       the daemon shares lifecycle and mount surface
#                       with the project it redeploys -- the user-share
#                       tier at /mnt/user/appdata has demonstrated
#                       write-availability flakiness via /mnt/cache vs
#                       /mnt/diskN unioning; the custos dockermain
#                       mount is contiguous and root-writable)
#   LOG                Default ${STATE_DIR}/logs/poll.log
#   PIDFILE            Default ${STATE_DIR}/poll.pid
#   LOCKFILE           Default ${STATE_DIR}/poll.lock
#

set -uo pipefail   # NB: no -e; the loop must survive transient errors (ghcr.io blips, keychain hangs)

# ---- Config -----------------------------------------------------------

POLL_INTERVAL="${POLL_INTERVAL:-30}"
COMPOSE_DIR="${COMPOSE_DIR:-/mnt/dockermain/appdata/custos}"
IMAGE="${IMAGE:-ghcr.io/citizen-forge/custos}"
TAG="${TAG:-main}"
GATEWAY_CONTAINER="${GATEWAY_CONTAINER:-custos-gateway-1}"
STATE_DIR="${STATE_DIR:-/mnt/dockermain/appdata/custos}"
LOG="${LOG:-${STATE_DIR}/logs/poll.log}"
PIDFILE="${PIDFILE:-${STATE_DIR}/poll.pid}"
LOCKFILE="${LOCKFILE:-${STATE_DIR}/poll.lock}"
PERSIST_MARKER="# Custos zero-touch redeploy auto-start"

mkdir -p "$STATE_DIR" "$(dirname "$LOG")"

# ---- Single-instance guard --------------------------------------------

# Open FD 9 on the lockfile for the script's lifetime. flock -n 9 is
# the atomic non-blocking lock acquisition; subsequent invocations of
# this script see FD 9 closed (the previous instance died) and the
# lock free, so they can acquire it. Two simultaneous invocations on
# the same host see the second fail flock and exit cleanly.
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "[$(date -u +%FT%TZ)] another poll-and-redeploy is already running; exiting" >&2
  exit 0
fi

echo "$$" > "$PIDFILE"

# ---- Cleanup ---------------------------------------------------------

cleanup() {
  rm -f "$PIDFILE"
}
trap cleanup EXIT
trap 'exit 0' TERM INT

# ---- Logging ---------------------------------------------------------

log() {
  local ts
  ts="$(date -u +%FT%TZ)"
  printf '[%s] %s\n' "$ts" "$*" | tee -a "$LOG" >&2
}

# ---- /boot/config/go persistence -------------------------------------

install_persist_hook() {
  if grep -qF "$PERSIST_MARKER" /boot/config/go 2>/dev/null; then
    return 0
  fi
  log "installing /boot/config/go persistence hook"
  cat >> /boot/config/go <<EOF

$PERSIST_MARKER
# Restart poll-and-redeploy on every Unraid boot. pgrep guard prevents
# double-start when the daemon is already alive from a prior boot.
# nohup + </dev/null + disown detaches fully so /boot/config/go can
# finish before the daemon stays alive in the background.
if ! pgrep -f "$STATE_DIR/poll-and-redeploy\.sh" >/dev/null && \\
   [ -x "$STATE_DIR/poll-and-redeploy.sh" ]; then
  cd "$STATE_DIR"
  nohup bash "$STATE_DIR/poll-and-redeploy.sh" \\
    >>"$LOG" 2>&1 </dev/null &
  disown \$! 2>/dev/null || true
fi
EOF
}

install_persist_hook

# ---- Digest helpers --------------------------------------------------

# Pull the canonical Docker-Content-Digest response header from a GET
# against /v2/<name>/manifests/<tag>. Match the body bytes against the
# digest to defend against a tampering MITM returning a stale body
# with a fresh header.
remote_digest() {
  local headers status body tmp_digest
  body="$(mktemp)"
  headers="$(curl -fsSL \
    -D - \
    -o "$body" \
    -w '%{http_code}' \
    --max-time 10 \
    -H "Accept: application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.manifest.v1+json" \
    "${IMAGE}/manifests/${TAG}" 2>/dev/null)" || {
      rm -f "$body"
      return 1
    }
  status="${headers##*$'\n'}"
  if [ "$status" != "200" ]; then
    rm -f "$body"
    return 1
  fi
  local header_digest
  header_digest="$(printf '%s' "$headers" | tr -d '\r' \
    | awk -F': ' 'tolower($1)=="docker-content-digest" {print $2}')"
  if [ -z "$header_digest" ]; then
    rm -f "$body"
    return 1
  fi
  # Compute body digest independently and assert equality.
  tmp_digest="$(sha256sum "$body" | awk '{print $1}')"
  rm -f "$body"
  local expected="${header_digest#sha256:}"
  if [ "$tmp_digest" != "$expected" ]; then
    log "WARN: digest header/body mismatch (header=${header_digest} body=sha256:${tmp_digest})"
    return 1
  fi
  printf '%s' "$expected"
}

# Pull the local image digest for the running gateway container.
# docker inspect returns "sha256:<digest>"; strip the prefix to match
# what remote_digest emits.
#
# Single-platform caveat: this returns the IMAGE CONFIG digest of the
# locally-cached image, which equals the manifest digest for single-
# platform images (the workflow builds only linux/amd64 today). If the
# workflow ever switches to a multi-platform manifest list, .Image
# would be the per-platform config digest while remote_digest returns
# the manifest list digest, and the daemon would redeploy every poll.
# Mitigate then by switching to RepoDigests[0] (sub: see that field
# is empty for locally-built images, so `.Image` is the safer default
# until the workflow pushes platform lists).
running_digest() {
  # `|| true` at the pipe tail swallows pipefail-induced 124 (timeout
  # fired) or non-zero from sed on empty input. The function always
  # returns 0 with whatever output it managed (often empty when the
  # container is down or the docker daemon is hung); the caller
  # checks [ -z "$RUNNING" ] to decide whether to skip.
  timeout 5 docker inspect --format '{{.Image}}' "$GATEWAY_CONTAINER" 2>/dev/null \
    | sed 's|^sha256:||' || true
}

# ---- Main loop --------------------------------------------------------

log "started (pid=$$, interval=${POLL_INTERVAL}s, target=${IMAGE}:${TAG}, compose=${COMPOSE_DIR}, state=${STATE_DIR})"

while true; do
  # Sleep is interruptible so TERM/INT can land promptly.
  sleep "$POLL_INTERVAL" &
  wait $!

  if ! REMOTE="$(remote_digest 2>/dev/null)"; then
    log "WARN: ghcr.io ${IMAGE}:${TAG} unreachable; will retry"
    continue
  fi

  # running_digest always returns 0 with potentially-empty output;
  # empty here means the gateway container isn't running yet.
  RUNNING="$(running_digest)"

  if [ -z "$RUNNING" ]; then
    log "WARN: gateway container ${GATEWAY_CONTAINER} not running; skipping redeploy"
    continue
  fi

  if [ "$REMOTE" = "$RUNNING" ]; then
    continue
  fi

  log "DIFF detected: running=sha256:${RUNNING} remote=sha256:${REMOTE}"
  log "redeploying ${GATEWAY_CONTAINER}..."

  if ! (
    cd "$COMPOSE_DIR" && \
      docker compose pull gateway && \
      docker compose up -d --no-deps gateway
  ) >>"$LOG" 2>&1; then
    log "ERROR: redeploy failed; will retry on next poll"
    continue
  fi

  NEW="$(running_digest)"
  if [ -n "$NEW" ] && [ "$NEW" = "$REMOTE" ]; then
    log "redeploy OK: sha256:${RUNNING} -> sha256:${NEW}"
  elif [ -z "$NEW" ]; then
    log "WARN: redeploy returned but container ${GATEWAY_CONTAINER} not running; manual review needed"
  else
    log "WARN: redeploy returned but digest didn't match (running=sha256:${NEW} expected=sha256:${REMOTE})"
  fi
done
