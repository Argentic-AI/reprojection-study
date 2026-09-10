#!/usr/bin/env bash
# The orchestrate study: M vs AM, N seeds, sequential, directives delivered.
#
# WHY A SEPARATE DRIVER FROM ladder.sh. orchestrate has no sandbox, so there is
# no per-run Postgres, no network and no workspace to seed — the agent decides,
# delegates and records, and there is no filesystem it could re-read a forgotten
# ruling from. That is the whole point of the set: on relay, AM only failed the
# reversal because the member cap happened to exist nowhere in the codebase.
#
# It is also why this can afford seeds. A relay cell took about 45 minutes,
# almost all of it npm; an orchestrate cell is turns and nothing else, so n=9 per
# arm is reachable where every autonomous result so far has been n=1.
#
# Runs are SEQUENTIAL. The provider queues per user per model, so parallel cells
# form one deep queue — a run competing with another sits at zero turns and
# distorts both.
set -uo pipefail
cd "$(dirname "$0")"
NODE="$HOME/.local/share/mise/installs/node/22.23.2/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"

# MAX_MS is 300 min. The 150 min value was set from a 52-turn sample and was
# still far too small: re-measured over a full 81-turn cell, turns 1-42 ran at
# 0.483 min/turn but turns 42-81 at 0.769, because a delivered directive sets off
# a burst of re-examination work. At the post-directive rate turn 200 (the
# reversal) lands at 141.8 min against the old 150 min budget - 8 minutes of
# margin, about 11 turns - and turn 240 (the last directive) at 172.6 min, i.e.
# UNREACHABLE IN EVERY CELL. Four more directives land after turn 81, so the pace
# degrades further, not less.
#
# A generous cap costs nothing when a cell finishes early; it is a ceiling, not a
# target. What it prevents is 18 cells each racing their clock to the one event
# the set exists to measure.
SEEDS="${SEEDS:-9}"
TAG="${TAG:-d}"
TARGET="${TARGET:-300}"
ARMS="${ARMS:-M AM}"
mkdir -p out
LOG="out/orchestrate.log"
say() { printf '[orch] %s\n' "$1" | tee -a "$LOG"; }

db_up() { podman exec ctx-pg psql -U ctx -d ctx -tAc 'select 1' >/dev/null 2>&1; }
require_db() {
  db_up && return 0
  say "!! journal unreachable; trying to restart ctx-pg"
  podman start ctx-pg >/dev/null 2>&1; sleep 8
  db_up || { say "!! ctx-pg will not come up. STOPPING rather than running blind."; exit 1; }
}
require_db

say "seeds 1..$SEEDS | arms $ARMS | tag $TAG | target $TARGET turns"
say "no sandbox: the state under test is what was ruled and what was ruled out,"
say "and there is no artifact to recover it from."

for seed in $(seq 1 "$SEEDS"); do
  for arm in $ARMS; do
    RUN="${arm}_${TAG}${seed}"
    require_db
    st=$(podman exec ctx-pg psql -U ctx -d ctx -tAc "select status from runs where id='${RUN}'" 2>/dev/null | tr -d ' ')
    if [ "$st" = "done" ]; then say "$RUN already done, skipping"; continue; fi

    say "=== $RUN | arm $arm | seed $seed ==="
    rm -f "out/watch_${RUN}.log"
    ./watch_directives.sh "$RUN" 20 >/dev/null 2>&1 &
    WATCH_PID=$!
    # A cell that cannot receive directives is not a result: verify the watcher
    # is alive before spending 300 turns. AM_v2 ran a full cell with zero
    # directives and only the post-hoc guard noticed.
    up=0
    for _ in $(seq 1 15); do [ -s "out/watch_${RUN}.log" ] && { up=1; break; }; sleep 1; done
    if [ "$up" = 0 ]; then
      say "!! watcher for $RUN never started; refusing to run a blind cell"
      kill "$WATCH_PID" 2>/dev/null; exit 1
    fi

    RUN_ID="$RUN" STUDY_TASK_SET=orchestrate SEED="$seed" \
      MAX_TURNS="$TARGET" MAX_MS="${MAX_MS:-18000000}" PACE_MS="${PACE_MS:-900}" \
      TASK_TURN_CAP="${TASK_TURN_CAP:-$(( TARGET / 7 ))}" \
      MODEL_MAX_ATTEMPTS=20 LLM_MODEL="${LLM_MODEL:-hf:zai-org/GLM-5.3-Flash}" \
      MAX_OUTPUT_TOKENS="${MAX_OUTPUT_TOKENS:-32768}" \
      NODE_OPTIONS=--dns-result-order=ipv4first \
      "$NODE" --env-file=.env src/run.ts "$arm" > "out/${RUN}.log" 2>&1
    kill "$WATCH_PID" 2>/dev/null

    turns=$(podman exec ctx-pg psql -U ctx -d ctx -tAc \
      "select count(*) from steps where run_id='${RUN}' and kind='model_call'" 2>/dev/null | tr -d ' ')
    # Count DELIVERED directives, not queued ones. `directives` rows are inserted
    # with delivered_at null and stamped later at a turn boundary, so a plain
    # count(*) can report six while the agent was handed none of them.
    dirs=$(podman exec ctx-pg psql -U ctx -d ctx -tAc \
      "select count(*) from directives where run_id='${RUN}' and delivered_at is not null" 2>/dev/null | tr -d ' ')
    rev=$(podman exec ctx-pg psql -U ctx -d ctx -tAc \
      "select count(*) from directives where run_id='${RUN}' and delivered_at is not null and text like '%settle_reversal%'" 2>/dev/null | tr -d ' ')
    say "$RUN finished: turns=${turns:-0} delivered=${dirs:-0} reversal=${rev:-0}"
    if grep -q "OUTPUT TRUNCATED" "out/${RUN}.log" 2>/dev/null; then
      say "!! $RUN hit the output cap before emitting a tool call."
      say "!! reasoning trace outgrew MAX_OUTPUT_TOKENS; raise it. STOPPING."
      exit 1
    fi
    if [ "${turns:-0}" -lt 10 ]; then
      say "!! $RUN recorded ${turns:-0} turns — the run did not happen. Stopping."
      exit 1
    fi
    # The reversal IS the measurement. A cell that never received it is not a
    # weaker replicate, it is not a replicate: the pilot ended at turn 59 having
    # been handed one of six directives and was stamped 'done' with nothing in
    # the pipeline saying so.
    if [ "${rev:-0}" -lt 1 ]; then
      say "!! $RUN never received settle_reversal — the cell cannot test the thing"
      say "!! the set exists to test. turns=${turns:-0} delivered=${dirs:-0}. STOPPING."
      exit 1
    fi
    # DELIVERY IS NOT AN ANSWER. The gate above only proves the reversal was
    # handed over. A cell that ran out of clock at turn 202 has the reversal
    # delivered and no turns left to act on it, and would pass silently as a
    # scored replicate. Require the whole schedule: all 6 directives delivered
    # means the run got past turn 240 and had room to respond to each.
    if [ "${dirs:-0}" -lt 6 ]; then
      say "!! $RUN delivered ${dirs:-0}/6 directives in ${turns:-0} turns —"
      say "!! it ran out of budget before the schedule finished. Not a replicate."
      say "!! Raise MAX_MS or lower TARGET rather than pooling this cell. STOPPING."
      exit 1
    fi
  done
done

say "orchestrate study complete"
say "report with: STUDY_TASK_SET=orchestrate ./go.sh ladder"
