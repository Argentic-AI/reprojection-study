#!/usr/bin/env bash
# Resume a run repeatedly until it reaches a turn target or runs out of work.
#
# The free tier terminates a run every ~25 turns. Checkpoint/resume makes each
# failure cost nothing, but only if something actually retries — otherwise a
# long run can never finish. This is that something.
set -uo pipefail
cd "$(dirname "$0")"
NODE="$HOME/.local/share/mise/installs/node/22.23.2/bin/node"
export NODE_OPTIONS=--dns-result-order=ipv4first

RUN="${1:?usage: ./drive.sh <run_id> [target_turns] [max_attempts]}"
TARGET="${2:-80}"
MAX_ATTEMPTS="${3:-12}"

q() { podman exec -i ctx-pg psql -U ctx -d ctx -t -A -c "$1" | tr -d ' '; }

# ONE CELL AT A TIME. The provider queues per user, not per process.
#
# synthetic.new serialises requests per user-model-pack, so a second cell does
# not run alongside the first — it queues behind it, and it blocks every other
# run in that queue, including work that has nothing to do with this study.
# Resuming while a cell is live is the easiest way to cause that, and this
# script is the one command that does it, so the guard belongs here rather than
# in a comment somebody has to remember.
#
# Requires BOTH a 'running' row and a live process. A row alone is not evidence:
# crashed cells and test fixtures leave them behind, and a guard that trips on
# stale rows blocks real work and gets switched off. model<>'test' excludes the
# fixtures outright.
#
# The check is a subcommand, not a query built here. This script's own comment
# below records why: a table rename once made a guard's SQL invalid, the empty
# result coerced to zero, and the guard stayed permanently unreachable while
# looking healthy. Coercing does not fix that — it turns a failure into the
# number meaning "nothing to worry about", so the guard FAILS OPEN. The first
# version of this check did exactly that, confirmed by pointing it at a
# misspelled column and watching it permit the run.
#
# src/journal.ts answers with an exit code, which cannot be mistaken for data:
# 0 clear, 2 another cell is live, 1 could not tell. Anything but 0 refuses.
"$NODE" --env-file=.env src/journal.ts live-cells "$RUN"
case $? in
  0) ;;
  2) echo "[drive $RUN] REFUSING TO START: another cell is live, and the provider queues per user."
     echo "[drive $RUN] resuming now would queue behind it and stall everything else on synthetic.new."
     echo "[drive $RUN] wait for it to finish, or stop it, then run this again."
     exit 1 ;;
  *) echo "[drive $RUN] REFUSING TO START: could not read the journal to check for live cells."
     echo "[drive $RUN] a guard that cannot answer its question must not answer 'clear'."
     exit 1 ;;
esac

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  turns=$(q "select count(*) from steps where run_id='$RUN' and kind='model_call'")
  # Open tasks, PLUS abandoned ones run.ts is willing to revive. A run killed
  # mid-task leaves it 'abandoned', not 'open'; counting only 'open' here made
  # this driver exit before run.ts could run its own revival logic, so a crashed
  # run could never be resumed. Two guards that disagree are worse than either.
  open=$(q "select count(*) from tasks t where t.run_id='$RUN' and (t.status='open' or (t.status='abandoned' and (select count(*) from steps s where s.run_id=t.run_id and s.task_id=t.id and s.kind='model_call') < ${TASK_TURN_CAP:-20}))")
  # A pending directive IS work. Without this the driver stops at
  # "work exhausted" while a human is waiting on an answer, which is precisely
  # the failure an agent that owns a goal must not have.
  said=$(q "select count(*) from directives where run_id='$RUN' and delivered_at is null")
  echo "[drive $RUN] attempt $attempt: turns=$turns/$TARGET open_tasks=$open pending_directives=$said"

  # A failed query yields "", and [ "" -eq 0 ] EXITS 2, which `if` reads as false.
  # That is how the pending-directive guard stayed permanently unreachable after
  # a table rename: the bug was not only the wrong name, it was that a broken
  # query was indistinguishable from a real answer. Coerce, then compare.
  turns=${turns:-0}; open=${open:-0}; said=${said:-0}
  if [ "$turns" -ge "$TARGET" ]; then echo "[drive $RUN] reached target"; break; fi
  if [ "$open" -eq 0 ] && [ "$said" -eq 0 ]; then echo "[drive $RUN] no open tasks and no pending directives"; break; fi

  MAX_TURNS="$TARGET" MAX_MS=3600000 PACE_MS=1200 TASK_TURN_CAP="${TASK_TURN_CAP:-20}" MODEL_MAX_ATTEMPTS=20 \
    "$NODE" --env-file=.env src/compare.ts resume "$RUN" >> "out/drive_$RUN.log" 2>&1
  after=$(q "select count(*) from steps where run_id='$RUN' and kind='model_call'")
  echo "[drive $RUN]   -> $after turns"
  # No progress means resuming again will not help; stop rather than spin.
  if [ "$after" -le "$turns" ]; then echo "[drive $RUN] no progress, stopping"; break; fi
done
echo "[drive $RUN] done: $(q "select count(*) from steps where run_id='$RUN' and kind='model_call'") turns"
