#!/usr/bin/env bash
# Serve a run's Relay build on the LAN, supervised, for as long as the machine is up.
#
# PRODUCTION, NOT DEV, and the reason is not purity.
#
# This used `next dev` so a human could watch the product appear as the agent
# wrote it. That was wrong in a way that took a while to surface: the workspace
# is a volume shared between this container and the host, and `next dev` writes
# a lock into .next/dev/ naming its own PID. The host then refuses to start
# anything — "Another next dev server is already running, PID 88" — pointing at
# a process id that only exists inside a container, in a directory the host can
# see but cannot inspect. A dev server also hides build errors behind hot reload,
# which is the opposite of what this is for.
#
# So: build once, serve the build, and leave no lock behind. Re-running picks up
# whatever the agent has written since.
#
# Bound to 0.0.0.0 so a phone on the same wifi can reach it. That is a LAN
# exposure of an app holding test data — deliberate, and different in kind from
# the public cloudflared tunnel, which this script never starts.
set -uo pipefail
cd "$(dirname "$0")"

RUN="${1:?usage: ./serve_relay.sh <run_id> [port]}"
PORT="${2:-3100}"
NAME="serve-${RUN}"
IMAGE="${SANDBOX_IMAGE:-localhost/ctx-sandbox:node22}"
WS="$PWD/workspace/${RUN}"
LOG="out/serve_${RUN}.log"
mkdir -p out

[ -d "$WS/relay" ] || { echo "[serve $RUN] no workspace at $WS/relay"; exit 1; }

LAN_IP=$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[\d.]+' | head -1)

# A dev lock from an earlier version of this script, or from a host-side `next
# dev`, blocks startup with a PID that means nothing in this namespace.
rm -rf "$WS/relay/.next/dev" 2>/dev/null

echo "[serve $RUN] building..." | tee -a "$LOG"
podman rm -f "$NAME" >/dev/null 2>&1
podman run --rm --network "ctxnet-${RUN}" -v "$WS:/app:z" -w /app/relay "$IMAGE" \
  sh -c 'pnpm install --prefer-offline 2>&1 | tail -2; pnpm run build 2>&1 | tail -25' >>"$LOG" 2>&1
BUILD_EXIT=$?
if [ "$BUILD_EXIT" -ne 0 ]; then
  echo "[serve $RUN] BUILD FAILED (exit $BUILD_EXIT). Nothing to serve — see $LOG" | tee -a "$LOG"
  exit 1
fi
echo "[serve $RUN] build ok" | tee -a "$LOG"
echo "[serve $RUN] http://${LAN_IP:-0.0.0.0}:${PORT}" | tee -a "$LOG"

while true; do
  podman rm -f "$NAME" >/dev/null 2>&1
  # --network joins the run's own network so the app reaches its Postgres by
  # container name, exactly as it does inside the agent's sandbox.
  # Better Auth checks Origin against its configured base URL, so a browser on
  # the LAN gets "Invalid origin" even though the page loads. Passed as env
  # rather than edited into the workspace .env: the served URL is a property of
  # how this is being shown, not of the product the run built, and rewriting the
  # agent's own files would corrupt the artifact under review.
  podman run --rm --name "$NAME" \
    --network "ctxnet-${RUN}" \
    -e BETTER_AUTH_URL="http://${LAN_IP}:${PORT}" \
    -e NEXT_PUBLIC_APP_URL="http://${LAN_IP}:${PORT}" \
    -e BETTER_AUTH_TRUSTED_ORIGINS="http://${LAN_IP}:${PORT},http://localhost:${PORT}" \
    -p "0.0.0.0:${PORT}:3000" \
    -v "$WS:/app:z" -w /app/relay \
    "$IMAGE" \
    sh -c 'exec pnpm run start' \
    >>"$LOG" 2>&1
  echo "[serve $RUN] exited, restarting in 5s" >>"$LOG"
  sleep 5
done
