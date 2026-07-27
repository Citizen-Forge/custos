#!/usr/bin/env bash
#
# scripts/register-self-hosted-runner.sh -- bootstrap / re-bootstrap a
# self-hosted GitHub Actions runner for the custos project on Unraid.
#
# Usage:
#   export RUNNER_TOKEN="ABC123..."   # see token-source notes below
#   bash scripts/register-self-hosted-runner.sh
#
# Behavior:
#   * Idempotent. Re-running with a fresh token replaces the in-tree
#     registration (`config.sh --replace`). Existing `_diag/` logs and
#     the buildx cache at /tmp/custos-build-cache are preserved.
#   * Persists across Unraid reboots. /etc is RAM-backed and wipes on
#     every boot, so the script writes a marker block into
#     /boot/config/go that re-installs and re-starts the svc after each
#     Unraid restart.
#   * Self-hosted runners running as root are blocked by default in
#     actions/runner since v2.264.0. RUNNER_ALLOW_RUNASROOT=1 opts back
#     in. Unraid runs as root by default, so without this opt the svc
#     refuses to launch.
#
# Token source (any of):
#   * Locally from a machine whose `gh` is authed with admin on
#     github.com/Citizen-Forge/custos -- the repo owner (Tall-Paul):
#         gh api -X POST repos/Citizen-Forge/custos/actions/runners/registration-token -q '.token'
#   * github.com -> Citizen-Forge/custos -> Settings -> Actions ->
#     Runners -> New self-hosted runner -> Linux x64. The bash block
#     GitHub shows for the ./config.sh --token step embeds the token.
#   Token lifetime is ~1h; mint close to bootstrap, not hours earlier.
#
# Tunables (env):
#   RUNNER_TOKEN    Required. Short-lived registration token.
#   RUNNER_VERSION  Default 2.336.0 (latest stable as of writing). The
#                   runner's own ./run.sh handles in-place upgrades once
#                   installed, so this pin only matters for first install.
#   RUNNER_NAME     Default Unraid-Custos. The friendly label GitHub shows.
#

set -euo pipefail

: "${RUNNER_TOKEN:?Error: RUNNER_TOKEN env var is required. Mint one with: gh api -X POST repos/Citizen-Forge/custos/actions/runners/registration-token (Tall-Paul on this machine) OR via github.com -> Settings -> Actions -> Runners -> New self-hosted runner}"

RUNNER_VERSION="${RUNNER_VERSION:-2.336.0}"
RUNNER_NAME="${RUNNER_NAME:-Unraid-Custos}"
RUNNER_DIR="/mnt/user/appdata/custos-runner"
REPO_URL="https://github.com/Citizen-Forge/custos"

# Self-hosted runners running as root are blocked by default since
# actions/runner v2.264.0; opt back in explicitly so config.sh + svc.sh
# validate against the host's actual root uid.
export RUNNER_ALLOW_RUNASROOT=1

mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"

# 1. Acquire tarball (only if not extracted).
#
#    Order of resolution:
#      a. /tmp/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz -- present
#         when an external copy was scp'd over (matters when the host's
#         egress to release-assets.githubusercontent.com is blocked).
#      b. The github.com releases page directly, with -L follow-redirect.
#         The signed JWT in the redirect target is valid for ~1h; if the
#         token has aged out, retry the bootstrap.
#
#    Verification level: HTTPS between the runner host and
#    github.com/release-assets. actions/runner does NOT publish
#    `.sha256` files alongside tarballs on the releases page, so the
#    checksum step earlier versions of this script used was always
#    going to 404 -- removed in this revision.
TARBALL="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
LOCAL_TARBALL="/tmp/${TARBALL}"
if [ ! -e ./run.sh ]; then
  if [ -f "$LOCAL_TARBALL" ]; then
    echo "==> Using pre-staged tarball at $LOCAL_TARBALL"
    cp "$LOCAL_TARBALL" "$TARBALL"
  else
    echo "==> Downloading actions/runner v${RUNNER_VERSION}"
    echo "    (If this 404s, scp the tarball from the repo owner's laptop:"
    echo "     scp actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz root@Tower:/tmp/)"
    if ! curl -fsSL -o "$TARBALL" \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${TARBALL}"; then
      echo "Error: could not fetch ${TARBALL} and no pre-staged copy at ${LOCAL_TARBALL}."
      echo "       Manually place the tarball at ${LOCAL_TARBALL} and re-run, OR confirm egress to"
      echo "       https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/ is reachable."
      exit 1
    fi
  fi
  tar xzf "$TARBALL"
  # Defensive: ensure the always-present top-level scripts are
  # executable after extract, regardless of upstream mode bits.
  chmod +x ./run.sh ./config.sh ./env.sh
  # chmod the v2.300+ canonical supervisor if present. It moved
  # out of ./svc.sh into ./bin/runsvc.sh somewhere around that
  # release; old versions still ship ./svc.sh at the top level,
  # also chmod that defensively so this branch runs on both shapes.
  [ -f ./bin/runsvc.sh ] && chmod +x ./bin/runsvc.sh
  [ -f ./svc.sh ] && chmod +x ./svc.sh
  rm -f "$TARBALL"
fi

# 2. (Re-)configure. --unattended + --replace means re-running this
#    script with a fresh token safely updates the runner's registration
#    record on GitHub rather than creating a duplicate offline runner.
echo "==> Configuring runner '${RUNNER_NAME}' against ${REPO_URL}"
./config.sh --unattended \
  --replace \
  --url "$REPO_URL" \
  --token "$RUNNER_TOKEN" \
  --name "$RUNNER_NAME" \
  --labels "custos,x64,linux,self-hosted" \
  --runnergroup "Default"

# 3 + 4. Install + Start, dispatching by what the tarball shipped.
#
#    The actions/runner "service" abstraction changed across releases:
#      * <= v2.299: top-level ./svc.sh writes sysvinit-style rc files
#        into /etc; on hosts with persistent /etc + systemd this works.
#      * >= v2.300: top-level ./svc.sh is gone. The supervisor script
#        moved to ./bin/runsvc.sh, which itself just runs
#        `node ./bin/RunnerService.js` in foreground and assumes the
#        caller (systemd / launchd / etc.) will supervise it.
#    Unraid 6.x has neither systemd nor a persistent /etc. Both shapes
#    above are unreliable on Unraid. The canonical Unraid path is:
#    detached nohup ./run.sh backgrounded under /boot/config/go
#    persistence (step 5). The script below tries the vendor-supplied
#    supervisors like ./svc.sh and ./bin/runsvc.sh only as a portability
#    concession for non-Unraid hosts; the Unraid path is the
#    always-applied detached nohup fallback at the end.
mkdir -p "$RUNNER_DIR/logs"

# Already-running guard: covers both run.sh (legacy / Unraid canonical)
# AND RunnerService.js (v2.300+ on hosts with a real supervisor).
if pgrep -f "$RUNNER_DIR/run.sh" >/dev/null; then
  RUNNING_PIDS=$(pgrep -f "$RUNNER_DIR/run.sh" | tr '\n' ' ')
  echo "==> Runner already running (run.sh detached, pids: $RUNNING_PIDS)"
elif pgrep -f "RunnerService.js" >/dev/null; then
  RUNNING_PIDS=$(pgrep -f "RunnerService.js" | tr '\n' ' ')
  echo "==> Runner service already running (RunnerService.js, pids: $RUNNING_PIDS)"
else
  # Legacy path: ./svc.sh present means pre-v2.300 tarball.
  if [ -x ./svc.sh ]; then
    echo "==> Legacy ./svc.sh detected; attempting install + start"
    ./svc.sh install "${RUNNER_NAME}" 2>/dev/null || \
      echo "Warning: ./svc.sh install failed (Unraid /etc transient?); will fall through."
    ./svc.sh start 2>&1 || \
      echo "Warning: ./svc.sh start failed; will fall through to detached start."
  fi
fi

# Final safety net: regardless of what svc.sh did, ensure the runner
# is alive. The detached nohup under /boot/config/go is the canonical
# Unraid 6.x path and survives both the absent-svc.sh case AND any
# svc.sh-failed-on-ephemeral-/etc case.
sleep 2
if ! pgrep -f "$RUNNER_DIR/run.sh" >/dev/null && \
   ! pgrep -f "RunnerService.js" >/dev/null; then
  echo "==> Starting runner detached (no ./run.sh or RunnerService.js alive)"
  nohup ./run.sh >"$RUNNER_DIR/logs/runner.log" 2>&1 </dev/null &
  # disown removes the job from the shell's job table so SIGHUP from
  # the ssh session exiting can't propagate to the runner. Safe under
  # non-interactive shells too (errors silently when no job to act on).
  disown $! 2>/dev/null || true
  echo "    PID=$!  logs at $RUNNER_DIR/logs/runner.log"
fi

# 5. Unraid-specific persistence. /boot/config/go runs at the very end of
#    Unraid's boot sequence; the rsync target hosts /boot on the flash
#    drive, so this block survives array moves and reboots. It re-runs
#    svc.sh install + start every boot (idempotent -- svc.sh refuses
#    to overwrite existing svc without --force). If svc.sh start fails
#    again post-boot, fall through to detached nohup.
PERSIST_MARKER="# Custos self-hosted GitHub Runner auto-start"
if ! grep -qF "$PERSIST_MARKER" /boot/config/go 2>/dev/null; then
  echo "==> Wiring /boot/config/go persistence hook"
  cat >> /boot/config/go <<EOF

$PERSIST_MARKER
[ -x "$RUNNER_DIR/run.sh" ] && {
  export RUNNER_ALLOW_RUNASROOT=1
  cd "$RUNNER_DIR"
  # mkdir logs on every boot in case Unraid array reset wiped
  # /mnt/user/appdata; the nohup redirect below writes into this dir
  # and would silently fail otherwise.
  mkdir -p "$RUNNER_DIR/logs"
  # Legacy ./svc.sh path: works on hosts with persistent /etc +
  # systemd/sysvinit. Best-effort on Unraid where /etc is RAM-backed.
  [ -x ./svc.sh ] && {
    ./svc.sh install "${RUNNER_NAME}" 2>/dev/null || true
    ./svc.sh start 2>/dev/null || true
  }
  # Canonical Unraid path: pgrep guard, then detached nohup if neither
  # the wrapper nor RunnerService.js is alive. The guard prevents
  # accumulating a second runner across consecutive Unraid boots where
  # svc.sh keeps failing for the same /etc reason.
  sleep 2
  if ! pgrep -f "$RUNNER_DIR/run.sh" >/dev/null && \
     ! pgrep -f "RunnerService.js" >/dev/null; then
    nohup ./run.sh >"$RUNNER_DIR/logs/runner.log" 2>&1 </dev/null &
    disown $! 2>/dev/null || true
  fi
}
EOF
else
  echo "==> /boot/config/go persistence hook already present"
fi

sleep 3
echo
echo "==> Verify on github.com: Settings -> Actions -> Runners reveals"
echo "    '${RUNNER_NAME}' with status Idle."
echo
echo "==> Confirm locally with last lines of the runner diagnostic log"
LATEST_DIAG=$(ls -t "$RUNNER_DIR"/_diag/Runner_*.log 2>/dev/null | head -1 || true)
if [ -n "${LATEST_DIAG:-}" ]; then
  echo "    $LATEST_DIAG:"
  tail -10 "$LATEST_DIAG"
fi
echo
echo "==> Done. Pushing any commit to main now builds on this host."
