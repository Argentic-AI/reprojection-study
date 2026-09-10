/**
 * Ceiling calibration from an unconstrained pilot.
 *
 * Protocol, from the instrument-validity research: run the control with no
 * ceiling, take the distribution of trajectory peaks, and set the ceiling at
 * the 10th-25th percentile of that distribution. The ceiling is then derived
 * from the control's OWN behaviour rather than chosen after seeing which arm it
 * favours, which is what makes it defensible rather than post-hoc.
 *
 * Every run recorded here is already an unconstrained observation: truncation
 * has never once fired, so no trajectory was ever clipped by the ceiling. The
 * pilot has effectively already been run; it just was not read this way.
 *
 * The target is a BINDING RATE of 60-70%: the fraction of runs in which the
 * ceiling is actually reached. The research found that number is essentially
 * never reported in published agent evaluations, which is precisely why this
 * failure survives. Ours is currently 0%.
 */
import { connect } from '../src/db.ts';
import { classify, is_result } from '../src/terminal.ts';

const sql = connect();
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

// MODEL IS PART OF THE KEY, not an optional filter. A peak distribution pooled
// across models is not a distribution of anything: the ceiling derived from it
// is set by whichever model happens to have more cells banked. This file had no
// model, status, corpus or ceiling predicate at all, so `operate`/arm A returned
// nine GLM-5.3 cells plus one GLM-4.7 cell sitting above the median — inside the
// half that sets p25, which is the number the compaction study pre-registers.
//
// Unfinished cells are excluded too, and the direction matters: a truncated or
// in-flight trajectory contributes a peak-so-far, which drags the percentiles
// DOWN and sets the ceiling too low — binding harder than pre-registered, in
// the direction nobody would notice.
const all_rows = await sql<
  { task_set: string; model: string; arm: string; run_id: string; peak: number }[]
>`
  select r.task_set, r.model, r.arm, r.id run_id, max(s.tokens_in)::int peak
  from runs r join steps s on s.run_id = r.id and s.kind = 'model_call'
  group by r.task_set, r.model, r.arm, r.id`;

const states = new Map((await classify(sql)).map((c) => [c.run_id, c]));
const unfinished = all_rows.filter((r) => {
  const st = states.get(r.run_id);
  return st && !is_result(st.terminal);
});
const rows = all_rows.filter((r) => !unfinished.includes(r));
if (unfinished.length) {
  console.log(`EXCLUDED ${unfinished.length} unfinished cell(s) — a peak-so-far is not a peak:`);
  console.log(`  ${unfinished.map((u) => `${u.run_id}(${states.get(u.run_id)!.terminal})`).join(', ')}\n`);
}

const CURRENT = 32000;
const keys = [...new Set(rows.map((r) => `${r.task_set}\u0000${r.model}`))].sort();

console.log('Unconstrained trajectory peaks (tokens_in), by task set.');
console.log('The control arm is what the ceiling must stress, so A is what calibrates it.\n');
console.log('set        model                     arm   runs   min     p10     p25     p50     max   bind@32k');
for (const key of keys) {
  const [set, model] = key.split('\u0000') as [string, string];
  const here = rows.filter((r) => r.task_set === set && r.model === model);
  for (const arm of [...new Set(here.map((r) => r.arm))].sort()) {
    const xs = here.filter((r) => r.arm === arm).map((r) => r.peak);
    const bind = xs.filter((x) => x > CURRENT).length / xs.length;
    console.log(`${set.padEnd(10)} ${model.slice(0, 24).padEnd(25)} ${arm.padEnd(4)} ${String(xs.length).padStart(5)} ${String(Math.min(...xs)).padStart(7)} ${String(pct(xs, 10)).padStart(7)} ${String(pct(xs, 25)).padStart(7)} ${String(pct(xs, 50)).padStart(7)} ${String(Math.max(...xs)).padStart(7)} ${(bind * 100).toFixed(0).padStart(8)}%`);
  }
}

console.log('\nCalibrated ceiling per task set, from the CONTROL arm (A) only:\n');
for (const key of keys) {
  const [set, model] = key.split('\u0000') as [string, string];
  const label = `${set} / ${model.slice(0, 24)}`;
  const xs = rows.filter((r) => r.task_set === set && r.model === model && r.arm === 'A').map((r) => r.peak);
  if (xs.length < 3) { console.log(`  ${label} — only ${xs.length} control runs, too few to calibrate`); continue; }
  const p10 = pct(xs, 10), p25 = pct(xs, 25);
  const bind_at = (c: number) => xs.filter((x) => x > c).length / xs.length;
  console.log(`  ${label}  n=${xs.length}  ceiling range ${p10}..${p25}`);
  console.log(`  ${' '.repeat(10)} at p10=${p10}: ${(bind_at(p10) * 100).toFixed(0)}% of control runs bind`);
  console.log(`  ${' '.repeat(10)} at p25=${p25}: ${(bind_at(p25) * 100).toFixed(0)}% of control runs bind`);
  console.log(`  ${' '.repeat(10)} at current 32000: ${(bind_at(CURRENT) * 100).toFixed(0)}% bind  <- target is 60-70%`);
}
await sql.end();
