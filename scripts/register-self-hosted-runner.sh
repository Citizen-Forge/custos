#!/usr/bin/env bash
#
# scripts/register-self-hosted-runner.sh -- bootstrap / re-bootstrap a
# self-hosted GitHub Actions runner for the custos project on Unraid.
#
# Usage:
#   export RUNNER_TOKEN="ABC123..."   # mint via the Register Runner workflow
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
# Tunables (env):
#   RUNNER_TOKEN    Required. Short-lived registration token.
#   RUNNER_VERSION  Default 2.321.0. Pin newer if you need newer features.
#   RUNNER_NAME     Default Unraid-Custos. The friendly label GitHub shows.
#

set -euo pipefail

: "${RUNNER_TOKEN:?Error: RUNNER_TOKEN env var is required. Mint one via the Register Runner workflow: https://github.com/Citizen-Forge/custos/actions/workflows/register-runner.yml}"

RUNNER_VERSION="${RUNNER_VERSION:-2.321.0}"
RUNNER_NAME="${RUNNER_NAME:-Unraid-Custos}"
RUNNER_DIR="/mnt/user/appdata/custos-runner"
REPO_URL="https://github.com/Citizen-Forge/custos"

# Self-hosted runners running as root are blocked by default since
# actions/runner v2.264.0; opt back in explicitly so config.sh + svc.sh
# validate against the host's actual root uid.
export RUNNER_ALLOW_RUNASROOT=1

mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"

# 1. Acquire tarball (only if not extracted). --skip-validation of the
#    sha256 happens here, not in workflow .yml -- actions/runner publishes
#    an adjacent .sha256 file alongside every tarball, and we trust the
#    GitHub artifact for that pair.
TARBALL="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
if [ ! -x ./run.sh ]; then
  echo "==> Downloading actions/runner v${RUNNER_VERSION}"
  curl -fsSL -o "$TARBALL" \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${TARBALL}"
  curl -fsSL -o "${TARBALL}.sha256" \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${TARBALL}.sha256"
  if ! grep -F "${TARBALL}" "${TARBALL}.sha256" | sha256sum -c - >/dev/null; then
    echo "Checksum verification failed -- refusing to extract." >&2
    rm -f "$TARBALL" "${TARBALL}.sha256"
    exit 1
  fi
  tar xzf "$TARBALL"
  rm -f "$TARBALL" "${TARBALL}.sha256"
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

# 3. Service install. /etc/rc.d/rc.<name> init script is the canonical
#    Unraid-on-6.x path; Unraid 7.x's systemd shim forwards this when it
#    can. Errors here are non-fatal -- the next step falls back.
echo "==> Install service via svc.sh"
./svc.sh install "${RUNNER_NAME}" 2>&1 || \
  echo "Warning: svc.sh install failed; falling through to detached start."

# 4. Start. Try svc.sh start first -- if it fails (typical on Unraid 7
#    where systemd isn't fully wired), start detached under nohup.
#    pgrep guard prevents accumulating duplicate detached runners across
#    reboots if svc.sh keeps failing for the same /etc-transient reason.
mkdir -p "$RUNNER_DIR/logs"
if ./svc.sh status 2>/dev/null | grep -qiE 'active|running|started'; then
  echo "==> Service already running"
elif ./svc.sh start; then
  echo "==> Started via svc.sh"
else
  if pgrep -f "$RUNNER_DIR/run.sh" >/dev/null; then
    echo "==> Detached runner already running (pid: $(pgrep -f "$RUNNER_DIR/run.sh" | tr '\n' ' ')); skip nohup"
  else
    echo "==> svc.sh start failed (likely Unraid 7 /etc transient); starting detached"
    nohup ./run.sh >"$RUNNER_DIR/logs/runner.log" 2>&1 &
    echo "    PID=$!, logs at $RUNNER_DIR/logs/runner.log"
  fi
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
  ./svc.sh install "${RUNNER_NAME}" 2>/dev/null || true
  if ! ./svc.sh status 2>/dev/null | grep -qiE 'active|running|started'; then
    if ./svc.sh start 2>/dev/null; then :; else
      # pgrep guard: don't accumulate two runners from consecutive
      # boots if svc.sh keeps failing for the same /etc-transient
      # reason. The first forked runner stays connected; subsequent
      # boots just confirm it's still running.
      if ! pgrep -f "$RUNNER_DIR/run.sh" >/dev/null; then
        nohup ./run.sh >"$RUNNER_DIR/logs/runner.log" 2>&1 &
      fi
    fi
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
