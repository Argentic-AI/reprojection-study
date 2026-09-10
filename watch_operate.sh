#!/usr/bin/env bash
# Notify when the operate study finishes, and keep it alive meanwhile.
# Reports progress rather than only completions, because "0/36 complete" hid
# three cells sitting at 43-57 turns and read as nothing running.
set -uo pipefail
cd "$(dirname "$0")"
q() { podman exec -i ctx-pg psql -U ctx -d ctx -t -A -c "$1" 2>/dev/null | tr -d '[:space:]'; }
while :; do
  done_n=$(q "select count(*) from runs where task_set='operate' and status='done'"); done_n=${done_n:-0}
  turns=$(q "select count(*) from steps s join runs r on r.id=s.run_id where r.task_set='operate' and s.kind='model_call'"); turns=${turns:-0}
  files=$(q "select count(*) from created_artifacts a join runs r on r.id=a.run_id where r.task_set='operate' and a.kind='file'"); files=${files:-0}
  printf '[%s] operate %s/36 done, %s turns, %s files\n' "$(date -Is)" "$done_n" "$turns" "$files"
  [ "$done_n" -ge 36 ] && { echo "OPERATE COMPLETE"; STUDY_TASK_SET=operate ./go.sh power || true; break; }
  sleep 300
done
