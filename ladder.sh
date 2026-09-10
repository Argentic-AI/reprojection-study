#!/usr/bin/env bash
# The ceiling ladder: 32k / 64k / 128k / 256k, both arms, whole curve reported.
#
# WHY THIS EXISTS INSTEAD OF A CHOSEN CEILING. The relay ceiling was 256,000, at
# which AM never truncates and is therefore arm AP wearing the control's label.
# I observed that it did not fire, and then set it to 64,000 — a value at which
# M's measured peak (63,171) sits just below the line and AM's crosses early.
# That is a researcher degree of freedom exercised AFTER seeing the data, and no
# justification from the inside repairs it. Pre-registering a number from AM's
# growth curve "blind" to M's peak does not repair it either: M's peak is already
# known and cannot be unknown.
#
# The ladder is not a repair, it is a better instrument. It converts a chosen
# constant into a measured function and asks the interesting question directly:
# at what ceiling does the treatment start to matter, and does the effect scale
# with pressure? A single point can be gamed. A monotone curve cannot. And a
# non-monotone curve teaches something a point estimate would have hidden.
#
# ceiling_tokens is a pooling key, so each rung is its own cell and power.ts will
# refuse to pool them — which is the point.
#
# Runs are SEQUENTIAL. Provider queueing is per-user-per-model-per-pack, so
# parallel arms form one deep queue and retries enqueue rather than replace.
set -uo pipefail
cd "$(dirname "$0")"
NODE="$HOME/.local/share/mise/installs/node/22.23.2/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"

TARGET="${TARGET:-300}"
# Replication tag. g used the flawed R1 that stated the member cap R5 asks the
# agent to recall. k fixed that but kept the cap at 5, and both arms recovered 5
# after AM had truncated three times — which is not evidence of recall, because 5
# is the number a model would guess for "the original small cap". v sets the cap
# to 13: arbitrary, not a framework default, unreachable by inference. Earlier
# tags stay in the journal as evidence of what each instrument could not tell
# apart.
TAG="${TAG:-v}"
# 64000 FIRST so rung 1 matches M_g1, which is already running at that ceiling
# and is reused rather than clobbered. Order does not affect the curve.
RUNGS="${RUNGS:-64000 32000 128000 256000}"
ARMS="${ARMS:-M AM}"
mkdir -p out
LOG="out/ladder.log"

say() { printf '[ladder] %s\n' "$1" | tee -a "$LOG"; }

# THE JOURNAL MUST BE REACHABLE OR NOTHING BELOW MEANS ANYTHING.
#
# The host suspended overnight, Postgres stopped, and this script marched through
# five cells against a dead database — launching runs, reading empty statuses,
# reporting "finished:" with no turn count and "0/0 due directives", and printing
# "ladder complete". Every check it makes reads the journal, so with the journal
# gone every check returned empty and empty read as fine. Silence is not success.
db_up() { podman exec ctx-pg psql -U ctx -d ctx -tAc 'select 1' >/dev/null 2>&1; }
require_db() {
  db_up && return 0
  say "!! journal unreachable (ctx-pg down). Trying to restart it."
  podman start ctx-pg >/dev/null 2>&1; sleep 8
  db_up && { say "journal back"; return 0; }
  say "!! ctx-pg will not come up. STOPPING rather than running blind."
  exit 1
}
require_db

# DISK IS A PRECONDITION, NOT A DETAIL.
#
# Each cell installs its own node_modules — about 2GB — and eight cells filled a
# 728G volume to 100%. Postgres then failed with "could not write init file: No
# space left on device", the journal became unreachable, and cells recorded zero
# turns. The turn guard caught it, but only after a run had been launched into a
# machine that could not record it.
#
# node_modules and .next are reproducible and are NOT evidence, so a finished
# cell gives them back. Source, .env and the Prisma schema stay.
MIN_FREE_GB="${MIN_FREE_GB:-8}"
free_gb() { df -BG --output=avail "$PWD" 2>/dev/null | tail -1 | tr -dc '0-9'; }
require_disk() {
  local f; f=$(free_gb)
  if [ "${f:-0}" -lt "$MIN_FREE_GB" ]; then
    say "!! only ${f}G free, need ${MIN_FREE_GB}G. Reclaiming build artifacts."
    find workspace -maxdepth 3 -type d \( -name node_modules -o -name .next -o -name .pnpm-store \) \
      -prune -exec rm -rf {} + 2>/dev/null
    f=$(free_gb)
    say "after reclaim: ${f}G free"
  fi
  [ "${f:-0}" -ge "$MIN_FREE_GB" ] || { say "!! still ${f}G free. STOPPING rather than launching into a full disk."; exit 1; }
}
require_disk

say "rungs: $RUNGS | arms: $ARMS | target: $TARGET turns"
say "NOTE: arm M never truncates, so its rungs test that ceiling-independence"
say "holds rather than assuming it. If M's numbers move across rungs, something"
say "other than truncation is ceiling-sensitive and the whole ladder is suspect."

i=0
for ceiling in $RUNGS; do
  i=$((i + 1))
  for arm in $ARMS; do
    RUN="${arm}_${TAG}${i}"
    status=$(podman exec ctx-pg psql -U ctx -d ctx -tAc \
      "select status from runs where id='${RUN}'" 2>/dev/null | tr -d ' ')
    if [ "$status" = "done" ]; then
      say "$RUN already done, skipping"
      continue
    fi
    require_db
    require_disk
    say "=== $RUN | arm $arm | ceiling $ceiling ==="
    CEILING_TOKENS="$ceiling" ./launch_relay.sh "$RUN" "$TARGET" >>"out/${RUN}.log" 2>&1 &
    LAUNCH_PID=$!
    # The directive schedule is turn-indexed, so each run needs its own watcher.
    # The watcher now waits for the run row itself, but starting it first also
    # means it is already polling when the row appears.
    rm -f "out/watch_${RUN}.log"
    ./watch_directives.sh "$RUN" 20 >/dev/null 2>&1 &
    WATCH_PID=$!

    # VERIFY THE WATCHER ACTUALLY STARTED.
    #
    # AM_v2 ran 300 turns and truncated 16 times having received zero of its six
    # directives, because its watcher never started and nothing said so. The
    # cause was mine: I renamed watch_relay.sh to watch_directives.sh with sed
    # INSIDE ladder.sh while ladder.sh was running, and bash reads a script by
    # byte offset, so the running shell carried on from shifted offsets. That is
    # a rule written in this repo's own CLAUDE.md.
    #
    # The deeper fault is that a missing watcher was silent. It is now checked:
    # the watcher writes its first line immediately, so no log after 15s means it
    # is not running, and a cell without directives is not a result.
    watcher_up=0
    for _ in $(seq 1 15); do
      [ -s "out/watch_${RUN}.log" ] && { watcher_up=1; break; }
      sleep 1
    done
    if [ "$watcher_up" = 0 ]; then
      say "!! watcher for $RUN never started — refusing to run a cell that cannot receive directives"
      kill "$LAUNCH_PID" 2>/dev/null; kill "$WATCH_PID" 2>/dev/null
      exit 1
    fi
    say "$RUN watcher confirmed"
    wait "$LAUNCH_PID"
    kill "$WATCH_PID" 2>/dev/null
    final=$(podman exec ctx-pg psql -U ctx -d ctx -tAc \
      "select status || ' turns=' || (select count(*) from steps where run_id='${RUN}' and kind='model_call')
       from runs where id='${RUN}'" 2>/dev/null | tr -d ' ')
    say "$RUN finished: ${final:-NOTHING RECORDED}"
    turns_done=$(podman exec ctx-pg psql -U ctx -d ctx -tAc \
      "select count(*) from steps where run_id='${RUN}' and kind='model_call'" 2>/dev/null | tr -d ' ')
    if [ "${turns_done:-0}" -lt 10 ]; then
      say "!! $RUN recorded ${turns_done:-0} turns — the run did not happen. Stopping."
      exit 1
    fi

    # A CELL THAT RECEIVED NO DIRECTIVES IS NOT A RESULT.
    #
    # AM_g1 ran 300 turns, completed normally, and received zero of the six
    # directives, because its watcher started before the run row existed and read
    # "no such run" as "run finished". Nothing anywhere said so: the run looked
    # healthy, the turn count was full, and the comparison it existed for was
    # silently void. The whole point of the directives is that they are the
    # treatment, so a cell without them measures nothing.
    # DELIVERED, not queued. Rows are inserted with delivered_at null and stamped
    # when the runner actually hands them over, so a plain count(*) answers "did
    # the watcher insert them" when the question is "did the agent receive them" —
    # and would wave through the very failure this gate exists to catch.
    got=$(podman exec ctx-pg psql -U ctx -d ctx -tAc \
      "select count(*) from directives where run_id='${RUN}' and delivered_at is not null" 2>/dev/null | tr -d ' ')
    want=$("$NODE" -e '
      const { RELAY_REVISIONS } = await import("./src/propagation.ts");
      const turns = Number(process.argv[1]);
      console.log(RELAY_REVISIONS.filter((r) => turns >= (r.at_turn ?? Infinity)).length);
    ' "$(podman exec ctx-pg psql -U ctx -d ctx -tAc "select count(*) from steps where run_id='${RUN}' and kind='model_call'" 2>/dev/null | tr -d ' ')" 2>/dev/null || echo 0)
    if [ "${got:-0}" -lt "${want:-0}" ]; then
      say "!! $RUN is VOID: received ${got:-0} directives, ${want:-0} were due at its turn count"
      say "!! marking it failed so it is re-run rather than analysed"
      podman exec ctx-pg psql -U ctx -d ctx -tAc \
        "update runs set status='failed', notes = notes || '{\"void_reason\":\"directives not delivered\"}'::jsonb where id='${RUN}'" >/dev/null 2>&1
    else
      say "$RUN received ${got:-0}/${want:-0} due directives"
    fi
    # Reproducible, not evidence. Reclaimed as soon as the cell is terminal.
    rm -rf "workspace/${RUN}/relay/node_modules" "workspace/${RUN}/relay/.next" 2>/dev/null
    say "$RUN artifacts reclaimed, $(free_gb)G free"
  done
done

say "ladder complete"
say "report with: STUDY_TASK_SET=relay ./go.sh power   (per-ceiling, never pooled)"
