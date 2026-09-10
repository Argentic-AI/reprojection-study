/**
 * The seed study: every arm, N seeds, resumable.
 *
 * Run ids are DETERMINISTIC (`<arm>_s<seed>`) rather than timestamped. The
 * study runs for many hours on a throttled endpoint and will be interrupted;
 * a deterministic id makes "has this cell been run" a lookup instead of a
 * guess, and makes resuming a specific cell trivial.
 *
 * The model and provider are pinned into every run row by run_one, so a study
 * that spans a provider change is detectable after the fact rather than
 * silently pooled.
 */

import { connect, type Arm } from './db.ts';
import { CALIBRATED_CEILING, TASK_SET_TAGS, TASK_SET_ARMS, TASK_SETS } from './taskset.ts';
import { run_one } from './run.ts';
import { has_gold } from './oracle.ts';
import { prefix_for } from './prompt.ts';
import { surface_for } from './tools.ts';
import { fingerprint } from './canonical.ts';

const SEEDS = Number(process.env.STUDY_SEEDS ?? 9);
const TASK_SET = process.env.STUDY_TASK_SET ?? 'build';
// Arms come from the task set that declares them. seeds.ts knows how to
// iterate arms and seeds and nothing else about the product.
const ARMS = (process.env.STUDY_ARMS?.split(',') as Arm[]) ?? (TASK_SET_ARMS[TASK_SET] as Arm[]) ?? [];
if (!ARMS.length) {
  console.error(`no arms declared for task set "${TASK_SET}". Add it to TASK_SET_ARMS in taskset.ts.`);
  console.error(`Declared sets: ${Object.keys(TASK_SET_ARMS).join(', ')}`);
  process.exit(2);
}

// Every registry that is keyed by task set must agree with TASK_SETS, checked
// here rather than discovered when a study silently runs the wrong thing. Three
// separate hand-maintained copies had already drifted from it.
for (const set of Object.keys(TASK_SETS)) {
  if (!TASK_SET_ARMS[set]) { console.error(`task set "${set}" exists but declares no arms.`); process.exit(2); }
  if (!TASK_SET_TAGS[set]) { console.error(`task set "${set}" exists but has no run-id tag.`); process.exit(2); }
}

/**
 * Task set encoded in the run id, so studies cannot be pooled or collide.
 *
 * Declared explicitly, not derived. Deriving it from the first letter gave
 * build and site the same tag, and the site pilot silently skipped every cell
 * because build's A_s1 already existed.
 *
 * Run ids now encode the task set AND the replication.
 *
 * They previously encoded only the task set, so a second replication of the
 * same study — a different model, say — reused the same ids and seeds.ts
 * skipped every cell as already done. The supervisor reported "36/36 complete"
 * having run nothing: the same silent-success shape this project keeps
 * producing in new places.
 *
 * One letter per (set, replication) keeps ids matching ^[A-Z]+_[a-z][0-9]+$ so
 * existing queries still work. The model is recorded per run and power.ts
 * refuses to pool across models regardless.
 */
const TAGS = TASK_SET_TAGS;
const REP = Number(process.env.STUDY_REP ?? 1);
const TAG = TAGS[TASK_SET]?.[REP - 1];
if (!TAG) {
  console.error(`no run-id tag for "${TASK_SET}" replication ${REP}. Add one to TAGS in seeds.ts.`);
  process.exit(2);
}
const ALL_TAGS = Object.values(TAGS).flat();
if (new Set(ALL_TAGS).size !== ALL_TAGS.length) {
  console.error('TAGS collide; two studies would share run ids.');
  process.exit(2);
}

const sql = connect();

// Arm O's gold table is only defined for the build task set. Fail loudly here
// rather than producing an "upper bound" over a task set it cannot bound.
// has_gold(), not a hand-written list: this guard exists to stop arm O running
// where oracle.ts has no dependency table, so it must ask oracle.ts.
if (ARMS.includes('O' as Arm) && !has_gold(TASK_SET)) {
  console.error(`arm O needs a declared dependency table; "${TASK_SET}" has none. Add one to DEPS in oracle.ts or drop O.`);
  process.exit(2);
}

console.error(`study: ${ARMS.join(",")} x ${SEEDS} seeds on "${TASK_SET}" = ${ARMS.length * SEEDS} runs`);
for (const arm of ARMS) {
  console.error(`  ${arm.padEnd(3)} prefix ${await fingerprint(prefix_for(surface_for(arm)))}`);
}

const max_turns = Number(process.env.MAX_TURNS ?? 60);
const max_ms = Number(process.env.MAX_MS ?? 45 * 60_000);
// Calibrated per task set. An explicit CEILING_TOKENS still wins, which is how
// an unconstrained pilot is run: set it absurdly high so truncation cannot fire.
const calibrated = CALIBRATED_CEILING[TASK_SET];
const ceiling = process.env.CEILING_TOKENS
  ? Number(process.env.CEILING_TOKENS)
  : calibrated ?? null;
if (ceiling === null) {
  console.error(`task set "${TASK_SET}" has no calibrated ceiling. Run an unconstrained pilot first:`);
  console.error(`  STUDY_TASK_SET=${TASK_SET} CEILING_TOKENS=100000000 STUDY_ARMS=A STUDY_SEEDS=5 ./go.sh seeds`);
  console.error('  then ./go.sh calibrate to read the percentile, and record it in CALIBRATED_CEILING.');
  process.exit(2);
}
console.error(`replication ${REP}, ids like ${ARMS[0]}_${TAG}1`);
console.error(`ceiling ${ceiling}${process.env.CEILING_TOKENS ? ' (override)' : ' (calibrated, p25 of unconstrained control)'}`);

let done = 0, skipped = 0, failed = 0;
for (let seed = 1; seed <= SEEDS; seed++) {
  for (const arm of ARMS) {
    const run_id = `${arm}_${TAG}${seed}`;
    const [existing] = await sql<{ status: string }[]>`select status from runs where id = ${run_id}`;
    // Only 'done' is terminal. A cell that FAILED almost always failed for a
    // transient reason — this endpoint returns "Cannot connect to API" under
    // load and has taken 486 seconds with 11 retries for a single turn. Treating
    // failure as terminal stranded 14 of 36 build cells permanently, and the
    // supervisor would then have looped forever making no progress, because
    // every remaining cell was one it refused to touch.
    if (existing && existing.status === 'done') {
      skipped++;
      continue;
    }
    const resume = Boolean(existing);
    console.error(`\n### ${run_id}${resume ? ` (resuming from ${existing!.status})` : ''}`);
    try {
      await run_one(sql, {
        arm, run_id, seed, resume,
        task_set: TASK_SET as any,
        max_turns, max_ms, ceiling_tokens: ceiling,
      });
      const [after] = await sql<{ status: string }[]>`select status from runs where id = ${run_id}`;
      if (after?.status === 'done') done++; else failed++;
    } catch (e: any) {
      failed++;
      console.error(`  ${run_id} failed: ${String(e?.message).slice(0, 200)}`);
    }
  }
}

console.error(`\nstudy: ${done} completed, ${skipped} already done, ${failed} failed`);
console.error('re-run the same command to continue; finished cells are skipped.');
await sql.end();
