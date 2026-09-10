#!/usr/bin/env bash
# Drive seed studies to completion unattended, ONE request in flight at a time.
#
# This ran arms in parallel on the assumption that the provider caps cost rather
# than concurrency. It does not: queuing is per-user-per-model-per-pack, so four
# arms against one model is one queue four deep, and a retry enqueues another
# request rather than replacing the slow one. The resulting backlog was deep
# enough that our own probes waited behind it and were misread as provider
# outages, five times.
#
#   ./study.sh site           one study
#   ./study.sh site build     in order
set -uo pipefail
cd "$(dirname "$0")"

SETS=${@:-site}
SEEDS=${STUDY_SEEDS:-9}
REP=${STUDY_REP:-1}
# must mirror TAGS in seeds.ts
# Mirrors TAGS in seeds.ts. Duplicated because bash cannot read it; a mismatch
# is caught immediately by "no tag for X", not silently.
tag_for() { case "$1:$REP" in
  site:1) echo w;; site:2) echo x;; site:3) echo y;;
  build:1) echo s;; build:2) echo t;; build:3) echo u;;
  audit:1) echo a;; audit:2) echo b;; audit:3) echo c;;
  operate:1) echo p;; operate:2) echo q;; operate:3) echo r;;
  *) echo "";; esac; }
MAX_BACKOFF=${MAX_BACKOFF:-900}

done_cells() {
  podman exec -i ctx-pg psql -U ctx -d ctx -t -A -c \
    "select count(*) from runs where id ~ '^[A-Z]+_${TAG}[0-9]+\$' and status='done' and task_set='$1'" 2>/dev/null \
    | tr -d '[:space:]'
}

for SET in $SETS; do
  case "$SET" in
    site|build|audit|operate) ARMS="A B BR O" ;;
    *)                        ARMS="A B" ;;
  esac
  TAG=$(tag_for "$SET"); [ -z "$TAG" ] && { echo "no tag for $SET rep $REP"; exit 2; }
  n_arms=$(echo "$ARMS" | wc -w)
  TARGET=$(( n_arms * SEEDS ))
  backoff=60
  echo "=== '$SET': $n_arms arms x $SEEDS seeds = $TARGET cells, one at a time ==="

  while :; do
    d=$(done_cells "$SET"); d=${d:-0}
    printf '[%s] %s: %s/%s\n' "$(date -Is)" "$SET" "$d" "$TARGET"
    [ "$d" -ge "$TARGET" ] && { echo "'$SET' complete"; break; }

    before=$d
    # ONE arm at a time, in one process. Concurrency on this provider is
    # per-user-per-model-per-pack, so parallel arms do not multiply throughput —
    # they make one queue four deep, and every timeout-and-retry enqueues
    # another request behind it. Running four arms with a 900s timeout and 12
    # retries produced a backlog deep enough that probes sat behind our own
    # traffic and read as provider outages. Sequential is faster in wall-clock
    # here, not slower.
    STUDY_TASK_SET="$SET" STUDY_SEEDS="$SEEDS" STUDY_ARMS="$(echo $ARMS | tr ' ' ',')" \
      STUDY_REP="$REP" MAX_TURNS="${MAX_TURNS:-60}" ./go.sh seeds

    d=$(done_cells "$SET"); d=${d:-0}
    if [ "$d" -gt "$before" ]; then
      backoff=60
    else
      echo "no progress across all arms; sleeping ${backoff}s"
      sleep "$backoff"
      backoff=$(( backoff * 2 )); [ "$backoff" -gt "$MAX_BACKOFF" ] && backoff=$MAX_BACKOFF
    fi
  done
  STUDY_TASK_SET="$SET" ./go.sh power || true
done
