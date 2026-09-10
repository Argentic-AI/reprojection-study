#!/usr/bin/env bash
# Convenience entrypoint. Pins Node 22 and forces IPv4 (the endpoint's IPv6
# addresses time out intermittently, which otherwise shows up as spurious
# network retries in the metrics).
set -euo pipefail
cd "$(dirname "$0")"

NODE="$HOME/.local/share/mise/installs/node/22.23.2/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
export NODE_OPTIONS=--dns-result-order=ipv4first

usage() {
  cat <<'USAGE'
usage: ./go.sh <command>

  db          start the Postgres container and apply the schema
  check       typecheck, then run the assemble() determinism harness
  probe       step zero: three-call prompt-cache test
  pilot       ONE Arm B run, 40 turns — check promotion before committing to N
  run [N]     both arms, N repetitions (default 1), then print the comparison
  report      re-analyse whatever is already in the journal, no API calls
  resumable   list runs that stopped early and can be continued
  resume <id> continue a stopped run from the journal
  drive <id>  resume repeatedly until the run reaches its turn target
  corpus      regenerate the pinned corpus manifest (changes the stable prefix)
  seeds       seed study on the build set (A,B,BR,O), resumable
  seeds-audit seed study on the audit set (A,AP,D) — the ceiling-dependent arms
  power       read the seed study through bootstrapped intervals
  calibrate   derive the context ceiling from unconstrained trajectory peaks
  conform     provider conformance: can this endpoint run a study at all
  writable    can the model reach the write tool (site study needs it)
  health      run-level anomaly check: does each cell look like a run that worked
  terminal    how each cell ended: agent outcome vs infrastructure loss
  revision    did superseded decisions reach the artifacts, or only the transcript
  stall       consecutive read-only turns per arm (scope with STUDY_TASK_SET/MODEL)
  denom       is grounded RATE rewarding arms that do less? rate vs absolute vs per-file
  traj        WHEN each arm produces, and whether the turn cap reorders the arms
  matrix      the whole study as one table: every task set x model cell, every arm
  accum       THE accumulation thesis: does productivity fall with accumulated context
  say <id> "<msg>"   send the agent a directive; lands in durable state, re-read every wake
  status <id>        what the agent has done, what it owes you, what it reported
  compare     both replications side by side (model generalisation check)
  study       drive BOTH studies to completion, unattended, with backoff
  heartbeat   1-token liveness probe on an interval (run in background)
  throttle    correlate heartbeat latency with run progress
USAGE
}

case "${1:-}" in
  db)
    podman start ctx-pg 2>/dev/null || podman run -d --name ctx-pg \
      -e POSTGRES_USER=ctx -e POSTGRES_PASSWORD=ctx -e POSTGRES_DB=ctx \
      -p 5433:5432 docker.io/library/postgres:17-alpine
    sleep 3
    podman exec -i ctx-pg psql -U ctx -d ctx -v ON_ERROR_STOP=1 -q < sql/001_schema.sql
    echo "schema applied"
    ;;
  check)
    npx tsc --noEmit && echo "typecheck clean"
    # armsig LAST and never optional: it pins the rendered bytes of every arm.
    # Code shared across experiments is only safe because a change that shifts
    # an arm's prefix fails here instead of silently unpooling banked runs.
    for t in assemble constraints resume bounded reversal stall propagation regression armsig; do
      echo; echo "--- $t.test.ts ---"
      "$NODE" --env-file=.env "src/$t.test.ts" || exit 1
    done
    ;;
  probe)   "$NODE" --env-file=.env probe/step_zero.ts "${2:-glm-4.7-flash}" ;;
  pilot)   MAX_TURNS=${MAX_TURNS:-40} MAX_MS=${MAX_MS:-1800000} "$NODE" --env-file=.env src/run.ts B ;;
  run)     "$NODE" --env-file=.env src/compare.ts run "${2:-1}" ;;
  report)  "$NODE" --env-file=.env src/compare.ts report "${2:-}" ;;
  resumable) "$NODE" --env-file=.env src/compare.ts resumable ;;
  heartbeat) "$NODE" --env-file=.env probe/heartbeat.ts ;;
  throttle)  "$NODE" --env-file=.env src/throttle_report.ts ;;
  resume)  "$NODE" --env-file=.env src/compare.ts resume "${2:?usage: ./go.sh resume <run_id>}" ;;
  corpus)  "$NODE" probe/corpus_manifest.ts ;;
  seeds)   "$NODE" --env-file=.env src/seeds.ts ;;
  seeds-audit) STUDY_TASK_SET=audit "$NODE" --env-file=.env src/seeds.ts ;;
  power)   "$NODE" --env-file=.env probe/power.ts ;;
  calibrate) "$NODE" --env-file=.env probe/calibrate.ts ;;
  conform) "$NODE" --env-file=.env probe/conformance.ts ;;
  writable) "$NODE" --env-file=.env probe/write_reachable.ts ;;
  health)  "$NODE" --env-file=.env probe/health.ts ;;
  terminal) "$NODE" --env-file=.env probe/terminal.ts ;;
  revision) "$NODE" --env-file=.env probe/revision.ts ;;
  stall)   "$NODE" --env-file=.env probe/stall.ts ;;
  denom)   "$NODE" --env-file=.env probe/denominator.ts ;;
  traj)    "$NODE" --env-file=.env probe/trajectory.ts ;;
  matrix)  "$NODE" --env-file=.env probe/matrix.ts ;;
  accum)   "$NODE" --env-file=.env probe/accumulation.ts ;;
  ladder)  "$NODE" --env-file=.env probe/ladder.ts ;;
  # Calibrates the reversal instrument: how often a memoryless arm names each
  # candidate value with no history. Refuses to run while a cell is live.
  guessability) "$NODE" --env-file=.env probe/guessability.ts ;;
  # The read side for supersession. Every metric it reports had zero readers
  # until it existed, which is the same wired-at-one-end defect the rerun fixes.
  supersession) "$NODE" --env-file=.env probe/supersession.ts ;;
  # Same basename at the run root AND under a subdirectory. Counting ANY repeated
  # basename instead measures Next.js, not the agent.
  duplicate-paths) "$NODE" --env-file=.env probe/duplicate_paths.ts ;;
  # Halt a long cell that has stopped measuring, rather than discover it at hour 11.
  midflight) "$NODE" --env-file=.env probe/midflight.ts ;;
  say)     "$NODE" --env-file=.env src/operator.ts say "${2:?run_id}" "${3:?message}" "${4:-directive}" ;;
  status)  "$NODE" --env-file=.env src/operator.ts status "${2:?run_id}" ;;
  moon)    "$NODE" --env-file=.env src/operator.ts status "${2:?run_id}" ;;
  compare)  "$NODE" --env-file=.env probe/compare_reps.ts ;;
  study)   shift; ./study.sh "$@" ;;
  drive)   ./drive.sh "${2:?usage: ./go.sh drive <run_id> [target]}" "${3:-80}" ;;
  *) usage; exit 1 ;;
esac
