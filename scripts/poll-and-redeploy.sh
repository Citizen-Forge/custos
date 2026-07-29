#!/usr/bin/env bash
#
# scripts/poll-and-redeploy.sh -- Unraid-side zero-touch redeploy daemon
# for the custos project.
#
# Two build modes:
#
#   BUILD_MODE=registry (default) — polls ghcr.io for the `:main` digest
#   of `IMAGE` every `POLL_INTERVAL` seconds. When the remote digest
#   differs from the digest currently running on `GATEWAY_CONTAINER`,
#   triggers:
#
#     cd "$COMPOSE_DIR" && \
#       docker compose pull gateway && \
#       docker compose up -d --no-deps gateway
#
#   BUILD_MODE=local — polls a local git clone at `LOCAL_REPO` for new
#   commits on `TAG` (default main). When HEAD has moved, triggers:
#
#     cd "$LOCAL_REPO"
#     git pull
#     git pull
#     docker build -t custos-gateway:local .
# Compose references custos-gateway:local directly, so no tag step needed.
#     docker compose up -d --no-deps gateway
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
#   BUILD_MODE=local bash scripts/poll-and-redeploy.sh        # foreground
#   BUILD_MODE=local nohup bash scripts/poll-and-redeploy.sh & # background
#
# Tunables (env):
#   BUILD_MODE          Default registry | local
#   LOCAL_REPO          Default /mnt/user/custos-projects/custos
#   COMPOSE_DIR         Default /mnt/dockermain/appdata/custos
#   IMAGE               Default ghcr.io/citizen-forge/custos
#   TAG                 Default main (the branch/tag/channel)
#   GATEWAY_CONTAINER   Default custos-gateway-1
#   STATE_DIR           Default /mnt/dockermain/appdata/custos
#   LOG                 Default ${STATE_DIR}/logs/poll.log
#   PIDFILE             Default ${STATE_DIR}/poll.pid
#   LOCKFILE            Default ${STATE_DIR}/poll.lock
#

set -uo pipefail   # NB: no -e; the loop must survive transient errors

# ---- Config -----------------------------------------------------------

POLL_INTERVAL="${POLL_INTERVAL:-30}"
BUILD_MODE="${BUILD_MODE:-registry}"
LOCAL_REPO="${LOCAL_REPO:-/mnt/user/custos-projects/custos}"
COMPOSE_DIR="${COMPOSE_DIR:-/mnt/dockermain/appdata/custos}"
IMAGE="${IMAGE:-ghcr.io/citizen-forge/custos}"
TAG="${TAG:-main}"
GATEWAY_CONTAINER="${GATEWAY_CONTAINER:-custos-gateway-1}"
STATE_DIR="${STATE_DIR:-/mnt/dockermain/appdata/custos}"
LOG="${LOG:-${STATE_DIR}/logs/poll.log}"
PIDFILE="${PIDFILE:-${STATE_DIR}/poll.pid}"
LOCKFILE="${LOCKFILE:-${STATE_DIR}/poll.lock}"
PERSIST_MARKER="# Custos zero-touch redeploy auto-start"

# Local-mode state: last-deployed commit hash
LAST_DEPLOYED_FILE="${STATE_DIR}/.last-deployed-commit"

mkdir -p "$STATE_DIR" "$(dirname "$LOG")"

# ---- Single-instance guard --------------------------------------------

exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "[$(date -u +%FT%TZ)] another poll-and-redeploy is already running; exiting" >&2
  exit 0
fi

echo "$$" > "$PIDFILE"

# ---- Cleanup ----------------------------------------------------------

cleanup() {
  rm -f "$PIDFILE"
}
trap cleanup EXIT
trap 'exit 0' TERM INT

# ---- Logging ----------------------------------------------------------

log() {
  local ts
  ts="$(date -u +%FT%TZ)"
  printf '[%s] %s\n' "$ts" "$*" | tee -a "$LOG" >&2
}

# ---- /boot/config/go persistence --------------------------------------

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
if ! pgrep -f "$STATE_DIR/poll-and-redeploy\\.sh" >/dev/null && \
   [ -x "$STATE_DIR/poll-and-redeploy.sh" ]; then
  cd "$STATE_DIR"
  nohup bash "$STATE_DIR/poll-and-redeploy.sh" \
    >>"$LOG" 2>&1 </dev/null &
  disown \$! 2>/dev/null || true
fi
EOF
}

install_persist_hook

# ---- Registry-mode helpers -------------------------------------------
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
  tmp_digest="$(sha256sum "$body" | awk '{print $1}')"
  rm -f "$body"
  local expected="${header_digest#sha256:}"
  if [ "$tmp_digest" != "$expected" ]; then
    log "WARN: digest header/body mismatch (header=${header_digest} body=sha256:${tmp_digest})"
    return 1
  fi
  printf '%s' "$expected"
}

running_digest() {
  timeout 5 docker inspect --format '{{.Image}}' "$GATEWAY_CONTAINER" 2>/dev/null \
    | sed 's|^sha256:||' || true
}

# ---- Local-mode helpers -----------------------------------------------

# Check if the local git clone has new commits on the target branch.
# Emits the current HEAD commit hash if we should redeploy, or empty
# if nothing changed.
check_git_head() {
  local repo="$1"
  local branch="$2"

  if [ ! -d "$repo/.git" ]; then
    log "ERROR: not a git repo: $repo"
    return 1
  fi

  # Fetch without merging — we just want to compare hashes.
  git -C "$repo" fetch origin "$branch" 2>/dev/null || {
    log "WARN: git fetch failed for $repo"
    return 1
  }

  local local_head remote_head
  local_head="$(git -C "$repo" rev-parse HEAD 2>/dev/null)" || return 1
  remote_head="$(git -C "$repo" rev-parse "origin/$branch" 2>/dev/null)" || return 1

  if [ "$local_head" != "$remote_head" ]; then
    # Remote is ahead — emit the new HEAD so the caller can compare
    # against last-deployed.
    printf '%s' "$remote_head"
  else
    # No new commits — emit the current HEAD so last-deployed stays in sync.
    printf '%s' "$local_head"
  fi
}

build_local() {
  local repo="$1"

  log "pulling latest from $repo..."
  git -C "$repo" pull --ff-only origin "$TAG" >>"$LOG" 2>&1 || {
    log "ERROR: git pull failed"
    return 1
  }

  local head
  head="$(git -C "$repo" rev-parse HEAD 2>/dev/null)" || return 1
  log "HEAD is now $head"

  log "building docker image (custos-gateway:local)..."
  local commit_sha
  commit_sha=$(git -C "$repo" rev-parse --short HEAD 2>/dev/null || true)
  if ! docker build --no-cache-filter=runtime --build-arg "COMMIT_SHA=$commit_sha" -t custos-gateway:local "$repo" >>"$LOG" 2>&1; then
    log "ERROR: docker build failed"
    return 1
  fi

  # Compose references custos-gateway:local directly, no tag step needed.

  printf '%s' "$head"
}

# Spin up a transient container from a freshly-built image and probe
# GET /health. Only returns 0 (success) when we get HTTP 200 and the
# response contains the expected commit hash. Takes the image tag and
# the expected short commit hash. The container runs on an ephemeral
# mapped port so we never conflict with the production gateway.
health_check_image() {
  local image_tag="$1"
  local expected_commit="$2"
  local health_port="$3"
  local container_name="${4:-custos-gateway-healthcheck}"

  # Clean up any leftover from a previous interrupted run.
  docker rm -f "$container_name" >/dev/null 2>&1 || true

  log "health-check: starting ${image_tag} on port ${health_port}..."
  if ! docker run -d --rm \
    --name "$container_name" \
    -p "127.0.0.1:${health_port}:8787" \
    "$image_tag" >/dev/null 2>&1; then
    log "ERROR: health-check: failed to start container from ${image_tag}"
    return 1
  fi

  # Wait up to 15 seconds for the container to respond.
  local waited=0
  local ok=1
  while [ "$waited" -lt 15 ]; do
    local resp
    resp="$(curl -fsS --max-time 3 "http://127.0.0.1:${health_port}/health" 2>/dev/null)" && {
      local commit_hash
      commit_hash="$(printf '%s' "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('commit') or '')" 2>/dev/null)"
      if [ -z "$expected_commit" ]; then
        # No commit to compare — just verify the container responds.
        ok=0
        break
      elif [ "$commit_hash" = "$expected_commit" ]; then
        ok=0
        break
      fi
      log "health-check: commit mismatch (got=${commit_hash} expected=${expected_commit}), waiting..."
    }
    sleep 1
    waited=$((waited + 1))
  done

  # Clean up the transient container.
  docker rm -f "$container_name" >/dev/null 2>&1 || true

  if [ "$ok" -eq 0 ]; then
    log "health-check: PASS (commit=${expected_commit})"
    return 0
  fi
  log "ERROR: health-check: FAIL after ${waited}s - container did not respond with expected commit"
  return 1
}

# ---- Main loop --------------------------------------------------------

log "started (pid=$$, mode=${BUILD_MODE}, interval=${POLL_INTERVAL}s)"

if [ "$BUILD_MODE" = "local" ]; then
  log "local repo=${LOCAL_REPO}, target=${IMAGE}:${TAG}, compose=${COMPOSE_DIR}, state=${STATE_DIR}"

  # Initialize last-deployed state from the current local HEAD (before any build).
  if [ ! -f "$LAST_DEPLOYED_FILE" ]; then
    local init_head
    init_head="$(git -C "$LOCAL_REPO" rev-parse HEAD 2>/dev/null)" || true
    printf '%s' "${init_head:-none}" > "$LAST_DEPLOYED_FILE"
    log "initialized last-deployed commit: ${init_head:-none}"
  fi
else
  log "target=${IMAGE}:${TAG}, compose=${COMPOSE_DIR}, state=${STATE_DIR}"
fi

while true; do
  # Sleep is interruptible so TERM/INT can land promptly.
  sleep "$POLL_INTERVAL" &
  wait $!

  if [ "$BUILD_MODE" = "local" ]; then
    # ---- Local build mode: poll git, build, redeploy ------------------
    NEW_HEAD="$(check_git_head "$LOCAL_REPO" "$TAG")" || {
      log "WARN: git check failed for ${LOCAL_REPO}; will retry"
      continue
    }

    if [ -z "$NEW_HEAD" ]; then
      log "WARN: could not determine HEAD for ${LOCAL_REPO}; will retry"
      continue
    fi

    LAST_DEPLOYED="$(cat "$LAST_DEPLOYED_FILE" 2>/dev/null || echo "none")"

    if [ "$NEW_HEAD" = "$LAST_DEPLOYED" ]; then
      # No new commits — nothing to do.
      continue
    fi

    log "DIFF detected: deployed=${LAST_DEPLOYED} remote=${NEW_HEAD}"
    log "redeploying ${GATEWAY_CONTAINER}..."

    DEPLOYED_HEAD="$(build_local "$LOCAL_REPO")" || {
      log "ERROR: local build failed; will retry on next poll"
      continue
    }

    # Health-check the new image before cutting traffic.
    SHORT_HEAD="$(printf '%s' "$DEPLOYED_HEAD" | cut -c1-7)"
    HEALTH_PORT=8788
    if ! health_check_image "custos-gateway:local" "$SHORT_HEAD" "$HEALTH_PORT"; then
      log "ERROR: health-check failed for ${DEPLOYED_HEAD}; old container kept running"
      continue
    fi

    if ! (
      cd "$COMPOSE_DIR" && \
        docker compose up -d --no-deps gateway
    ) >>"$LOG" 2>&1; then
      log "ERROR: docker compose up failed; will retry on next poll"
      continue
    fi

    # Record the deployed commit.
    printf '%s' "$DEPLOYED_HEAD" > "$LAST_DEPLOYED_FILE"
    log "redeploy OK: ${LAST_DEPLOYED} -> ${DEPLOYED_HEAD}"
  else
    # ---- Registry mode: poll ghcr.io, pull, redeploy ------------------
    if ! REMOTE="$(remote_digest 2>/dev/null)"; then
      log "WARN: ghcr.io ${IMAGE}:${TAG} unreachable; will retry"
      continue
    fi

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
        docker compose pull gateway
    ) >>"$LOG" 2>&1; then
      log "ERROR: docker compose pull failed; will retry on next poll"
      continue
    fi

    # Health-check the newly pulled image before cutting traffic.
    HEALTH_PORT=8788
    if ! health_check_image "${IMAGE}:${TAG}" "" "$HEALTH_PORT"; then
      log "ERROR: health-check failed for ${IMAGE}:${TAG}; old container kept running"
      continue
    fi

    if ! (
      cd "$COMPOSE_DIR" && \
        docker compose up -d --no-deps gateway
    ) >>"$LOG" 2>&1; then
      log "ERROR: docker compose up failed; will retry on next poll"
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
  fi
done
