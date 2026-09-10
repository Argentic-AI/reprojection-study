#!/usr/bin/env bash
# Start or resume an autonomous Relay run.
#
# PRODUCT LAYER. This script knows what Relay needs — a Postgres, a Node image
# with pnpm, a scaffolded project — and the engine knows none of it. Everything
# it does goes through knobs the mechanism already exposes: SANDBOX_IMAGE,
# SANDBOX_NETWORK, RUN_ID, STUDY_TASK_SET, RESUME.
#
# WHY THE WORKSPACE IS SEEDED. The first replication was handed an empty
# container and a paragraph naming a stack. It found no compiler toolchain and
# reasonably built a hand-rolled node:http server. Instructing a stack in prose
# is compensation for an empty workspace, so the run starts from a blank
# `shadcn init` Next.js project — and nothing more, because a scaffold that has
# already made the product's decisions is an answer key, not a starting point.
#
# START AND RESUME ARE DIFFERENT, and conflating them killed three runs:
#   - a stale workspace from a dead attempt counted as "already seeded", so a
#     fresh run started on its wreckage and the agent re-scaffolded over it;
#   - resuming recreated the Postgres container, destroying the schema the agent
#     had already pushed into it, and rotated the password in .env with it;
#   - resuming without RESUME=1 made run_one INSERT the run row, which died on
#     runs_pkey before the first turn.
# The journal decides which mode this is: a run with no steps has never started.
set -uo pipefail
cd "$(dirname "$0")"

RUN="${1:-M_g1}"
TARGET="${2:-150}"

# The arm is read off the run id rather than hardcoded. This script said
# `src/run.ts M` outright, so it could not launch the control it exists to be
# compared against — AM_g1 would have silently run as M and produced two
# re-projecting runs labelled as a comparison.
ARM="${RUN%%_*}"
NODE="$HOME/.local/share/mise/installs/node/22.23.2/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"

# WHICH ARMS MAY RUN RELAY IS DERIVED, NOT LISTED.
#
# This was `case "$ARM" in M|AM)`, which rejected arm MV — an arm carrying
# EXACTLY M's tool surface, added specifically to be compared against M on this
# task set. A hand-written whitelist in bash cannot know that. journal.ts answers
# from surface_for: relay needs `shell`, so any arm that has it qualifies.
if ! "$NODE" --env-file=.env src/journal.ts relay-arm "$ARM"; then
  echo "[launch $RUN] arm '$ARM' cannot run relay (see above)"; exit 2
fi

NET="ctxnet-${RUN}"
DB="db-${RUN}"
IMAGE="${SANDBOX_IMAGE:-localhost/ctx-sandbox:node22}"
WS="workspace/${RUN}"
mkdir -p out

q() { podman exec ctx-pg psql -U ctx -d ctx -tAc "$1" 2>/dev/null | tr -d ' '; }

STEPS=$(q "select count(*) from steps where run_id='${RUN}'"); STEPS=${STEPS:-0}
if [ "$STEPS" -eq 0 ]; then MODE=start; else MODE=resume; fi
echo "[launch $RUN] mode=$MODE ($STEPS journalled steps)"

podman network create "$NET" >/dev/null 2>&1 || true

# The database is the agent's, and on resume it holds schema the agent pushed.
# Only ever recreated for a genuinely new run.
DBPW=""
if podman container exists "$DB" 2>/dev/null && [ "$MODE" = resume ]; then
  podman start "$DB" >/dev/null 2>&1 || true
  echo "[launch $RUN] reusing existing postgres, schema preserved"
  KEEP_ENV=1
else
  if [ "$MODE" = resume ]; then
    echo "[launch $RUN] WARNING: resuming but the postgres container is gone."
    echo "[launch $RUN] creating an empty one; the agent must re-push its schema."
  fi
  DBPW="relay-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  podman rm -f "$DB" >/dev/null 2>&1 || true
  podman run -d --name "$DB" --network "$NET" \
    -e POSTGRES_PASSWORD="$DBPW" -e POSTGRES_USER=relay -e POSTGRES_DB=relay \
    docker.io/library/postgres:17-alpine >/dev/null
  KEEP_ENV=0
fi

ready=0
for i in $(seq 1 60); do
  if podman exec "$DB" pg_isready -U relay -d relay >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "[launch $RUN] postgres never became ready"; exit 1; }
echo "[launch $RUN] postgres ready"

if [ "$MODE" = start ]; then
  echo "[launch $RUN] seeding a clean workspace from template/relay"
  rm -rf "$WS/relay"; mkdir -p "$WS"; cp -r template/relay "$WS/relay"
fi

# Fail loudly rather than starting an agent on a workspace that is not the
# template. Silent partial state produced two dead runs.
for f in components.json components/ui/button.tsx app/page.tsx package.json; do
  [ -e "$WS/relay/$f" ] || { echo "[launch $RUN] workspace check FAILED: missing $f"; exit 1; }
done
echo "[launch $RUN] workspace verified"

# ONLY the database URL, and never rewritten while the database it points at is
# still alive — the password is generated per container, so rewriting it on
# resume would hand the agent credentials for a database that no longer exists.
# Everything else (auth secret, ports, public URLs) is the agent's to add.
if [ "$KEEP_ENV" = 0 ]; then
  printf 'DATABASE_URL="postgresql://relay:%s@%s:5432/relay?schema=public"\n' "$DBPW" "$DB" > "$WS/relay/.env"
  chmod 600 "$WS/relay/.env"
  echo "[launch $RUN] wrote .env for a fresh database"
else
  echo "[launch $RUN] left .env alone"
fi

export SANDBOX_IMAGE="$IMAGE"
export SANDBOX_NETWORK="$NET"
export SANDBOX_TIMEOUT_MS="${SANDBOX_TIMEOUT_MS:-600000}"
export RUN_ID="$RUN"
export STUDY_TASK_SET=relay
export MAX_TURNS="$TARGET"
export MAX_MS="${MAX_MS:-3600000}"
# Left unset so run.ts takes CALIBRATED_CEILING for the task set. Hardcoding
# 256000 here overrode the calibration silently, which is how the ceiling stayed
# non-binding after it was measured.
[ -n "${CEILING_TOKENS:-}" ] && export CEILING_TOKENS
export MODEL_MAX_ATTEMPTS="${MODEL_MAX_ATTEMPTS:-20}"
export PACE_MS="${PACE_MS:-1200}"
export NODE_OPTIONS=--dns-result-order=ipv4first

# Pinned, not inherited. model.ts defaults to glm-4.7-flash, and a run row
# records whichever model was live when it started — so a study that spans an
# .env edit silently pools two models inside one cell. power.ts refuses to pool
# across models after the fact; this stops it happening in the first place.
export LLM_MODEL="${LLM_MODEL:-hf:zai-org/GLM-5.3-Flash}"

# The per-task cap is a SHARE of the budget, not the whole of it.
#
# Both extremes have now been run and both fail:
#   45 flat  - the root was abandoned mid-setup with 0 closed, because standing a
#              product up from a blank scaffold costs turns before any subtask
#              can exist. A budget artefact reported as a result.
#   $TARGET  - M_g1. The root ran all 300 turns and was abandoned at the cap, and
#              the five pre-spawned milestones never received a single model
#              call. They sat `open` behind a root that could never yield. The
#              forcing function was defeated by this setting.
#
# A task yields on complete() or on the cap, and the agent has never once called
# complete. So the cap IS the scheduler: it has to be small enough that the queue
# actually cycles through the milestones, and large enough that setup fits in the
# first slot. One share per task, with the root getting the same share as the
# rest.
TASKS_PLANNED=$("$NODE" -e '
  const { TASK_SET_MILESTONES } = await import("./src/taskset.ts");
  console.log((TASK_SET_MILESTONES["relay"] ?? []).length + 1);
' 2>/dev/null || echo 6)
export TASK_TURN_CAP="${TASK_TURN_CAP:-$(( TARGET / TASKS_PLANNED ))}"
[ "$MODE" = resume ] && export RESUME=1

echo "[launch $RUN] arm=$ARM image=$IMAGE network=$NET target=$TARGET cap=$TASK_TURN_CAP"
"$NODE" --env-file=.env src/run.ts "$ARM" 2>&1 | tee -a "out/launch_${RUN}.log"

# The first process stops at the turn budget or on a provider hiccup; drive.sh
# is what makes a long run survive that.
echo "[launch $RUN] handing off to drive.sh"
TASK_TURN_CAP="$TASK_TURN_CAP" SANDBOX_IMAGE="$IMAGE" SANDBOX_NETWORK="$NET" \
  ./drive.sh "$RUN" "$TARGET" 20
