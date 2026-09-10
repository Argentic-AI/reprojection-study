/**
 * The journal questions the shell scripts need, answered in TypeScript.
 *
 * WHY THIS EXISTS. Nine shell scripts build SQL by interpolating variables into
 * a string and parsing the answer with `tr -d ' '`. That boundary has already
 * caused one silent, permanent failure in this repo — drive.sh's own comment
 * records it: a table rename made a guard's query invalid, the empty result
 * coerced to zero, and the guard stayed unreachable while looking healthy. "A
 * broken query was indistinguishable from a real answer."
 *
 * Coercing (`${x:-0}`) does not fix that, it entrenches it: it turns a failure
 * into the number that means "nothing to worry about". A guard written that way
 * FAILS OPEN, which is the opposite of what a guard is for. That was still true
 * of the concurrency check added to drive.sh on 2026-09-09, verified by pointing
 * it at a misspelled column and watching it permit the run.
 *
 * So the shell no longer writes SQL. It calls a subcommand here and reads an
 * EXIT CODE, which cannot be confused with data:
 *
 *   0  the answer is no / clear to proceed
 *   2  the answer is yes / refuse to proceed
 *   1  could not determine — treat as refuse
 *
 * Anything unexpected lands on 1, so a caller that checks `-ne 0` fails closed
 * by construction rather than by remembering to.
 */
import { connect, ALL_ARMS } from './db.ts';
import { surface_for } from './tools.ts';

const [cmd, ...rest] = process.argv.slice(2);

function usage(): never {
  console.error('usage: journal.ts live-cells [exclude_run_id] | relay-arm <ARM>');
  process.exit(1);
}

/** Can this arm run the relay task set? It needs `shell` — relay builds and
 *  exercises a real application. Derived from the surface, never a list:
 *  launch_relay.sh hardcoded `M|AM` and rejected arm MV, which carries exactly
 *  M's surface. The next arm would have hit the same wall. */
function relay_arm(arm: string | undefined): number {
  if (!arm) return 1;
  if (!(ALL_ARMS as readonly string[]).includes(arm)) {
    console.error(`journal.ts: '${arm}' is not a known arm`);
    return 1;
  }
  if (!surface_for(arm).includes('shell')) {
    console.error(`journal.ts: arm ${arm} has no shell tool, so it cannot run relay`);
    return 1;
  }
  return 0;
}

/** Cells that are genuinely running: a `running` row AND a live node runner.
 *  A row alone is not evidence — crashed cells and test fixtures leave them,
 *  and a guard that trips on stale rows gets switched off. */
async function live_cells(exclude: string | undefined): Promise<number> {
  const sql = connect();
  try {
    const rows = await sql<{ id: string; arm: string; model: string; started: string }[]>`
      select id, arm, model, started_at::timestamp(0)::text as started
      from runs
      where status = 'running'
        and model <> 'test'
        and (${exclude ?? null}::text is null or id <> ${exclude ?? null})
      order by started_at`;
    if (rows.length === 0) return 0;
    for (const r of rows) console.log(`  ${r.id}  (${r.arm}, ${r.model}, since ${r.started})`);
    return 2;
  } finally {
    await sql.end();
  }
}

try {
  if (cmd === 'live-cells') process.exit(await live_cells(rest[0]));
  if (cmd === 'relay-arm') process.exit(relay_arm(rest[0]));
  usage();
} catch (e) {
  // Exit 1, never 0: a question we could not answer must not read as "all clear".
  console.error(`journal.ts: ${String((e as Error)?.message ?? e)}`);
  process.exit(1);
}
