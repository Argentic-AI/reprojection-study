#!/usr/bin/env bash
# Deliver the founder's directives to a running Relay run, on its own clock.
#
# WHY TURNS AND NOT TASKS. The existing interjection mechanism fires on
# `after_tasks_done`. M_f1 closed zero tasks in 150 turns, so every one of its
# triggers would have been dead. Worse, tasks-closed is the outcome under
# measurement: gating delivery on it means an arm that was doing better would
# receive more directives, and the schedule itself would encode which arm
# deserved them. Turns are the one clock both arms share and neither earns.
#
# Both arms get byte-identical text at the same point in their OWN timeline, so
# a slow arm is not punished by receiving directives bunched together.
#
# Idempotent: a directive already in `directives` for this run is never re-sent,
# so this can be killed and restarted without duplicating anything.
set -uo pipefail
cd "$(dirname "$0")"

RUN="${1:?usage: ./watch_relay.sh <run_id> [poll_seconds]}"
POLL="${2:-30}"
NODE="$HOME/.local/share/mise/installs/node/22.23.2/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
mkdir -p out
LOG="out/watch_${RUN}.log"

q() { podman exec ctx-pg psql -U ctx -d ctx -tAc "$1" 2>/dev/null | tr -d ' '; }

say() { printf '[watch %s] %s\n' "$RUN" "$1" | tee -a "$LOG"; }

say "watching; polling every ${POLL}s"

# WAIT FOR THE RUN TO EXIST BEFORE WATCHING IT.
#
# The terminal check below treats an empty status as "gone". The launcher needs
# about a minute to create a Postgres container, seed the workspace and insert
# the run row, so a watcher started alongside it saw no row, read that as
# finished, and exited immediately. AM_g1 completed 300 turns having received
# ZERO of the six directives, and nothing said so — the run looked normal and the
# comparison it was run for was silently void.
#
# "Not started yet" and "finished" are different states and the guard could not
# tell them apart, which is the same defect shape as the workspace seeding check
# and the drive.sh count coercion.
appeared=0
for i in $(seq 1 60); do
  if [ -n "$(q "select 1 from runs where id='${RUN}'")" ]; then appeared=1; break; fi
  sleep 5
done
if [ "$appeared" = 0 ]; then
  say "run never appeared after 300s; refusing to watch a run that does not exist"
  exit 1
fi
SET=$(q "select task_set from runs where id='${RUN}'")
say "run exists; task set ${SET}; delivering on its own turn clock"

while true; do
  status=$(q "select status from runs where id='${RUN}'")
  turns=$(q "select count(*) from steps where run_id='${RUN}' and kind='model_call'")
  turns=${turns:-0}

  # The schedule and its text live in ONE place — propagation.ts — so the
  # directive the agent receives and the directive the scorer looks for cannot
  # drift apart. That drift is exactly how a probe ends up reporting on
  # revisions that were never sent.
  # Task set read from the run itself, so one watcher serves every product.
  pending=$("$NODE" --env-file=.env -e '
    const { REVISIONS_BY_SET } = await import("./src/propagation.ts");
    const [turn, set] = [Number(process.argv[1]), process.argv[2]];
    const due = (REVISIONS_BY_SET[set] ?? []).filter((r) => turn >= (r.at_turn ?? Infinity));
    for (const r of due) console.log(JSON.stringify({ id: r.id, text: r.text }));
  ' "$turns" "$SET" 2>/dev/null)

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    id=$(printf '%s' "$line" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')
    text=$(printf '%s' "$line" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).text))')
    # Already sent? Match on the directive's own text, which is what lands in the
    # durable block, so this survives a restart of this watcher.
    seen=$(q "select count(*) from directives where run_id='${RUN}' and text like '%${id}%'")
    if [ "${seen:-0}" -eq 0 ]; then
      # The id is carried in the delivered text so delivery is auditable later
      # without matching prose, which is brittle.
      ./go.sh say "$RUN" "[$id] $text" directive >>"$LOG" 2>&1 \
        && say "delivered $id at turn $turns" \
        || say "FAILED to deliver $id at turn $turns"
    fi
  done <<< "$pending"

  case "$status" in
    done|failed|abandoned) say "run status=$status; stopping"; break ;;
    '') say "run row vanished mid-watch; stopping"; break ;;
  esac
  sleep "$POLL"
done
