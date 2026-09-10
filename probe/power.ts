/**
 * The seed study read through intervals rather than point estimates.
 *
 * HEADLINE IS GROUNDED-FINDING RATE, not turns and not task count. Turn count
 * is a cost metric: "finished in 39 turns" is equally consistent with efficiency
 * and with giving up, and the two are only separable by asking whether the work
 * was right. Cost columns are printed, but never as the result.
 */
import { connect } from '../src/db.ts';
import { verify_run } from '../src/verify.ts';
import { artifact_report } from '../src/artifacts.ts';
import { bootstrap, bootstrap_diff, pass_hat_k, equivalence, fmt, MIN_N } from '../src/stats.ts';
import { target_module, has_gold } from '../src/oracle.ts';
import { classify, is_result } from '../src/terminal.ts';

/** Largest difference in grounded rate that would still be "no real difference". */
const DELTA = Number(process.env.EQUIV_DELTA ?? 0.05);
const BASELINE = process.env.BASELINE_ARM ?? 'A';

const sql = connect();
// Anchored regex, not a LIKE on the id. A substring filter silently matched
// four pre-study runs whose ids merely contain the same letters, which would
// have pooled pre-study data into the study's intervals.
const ONLY = process.env.STUDY_TASK_SET ?? null;
const ONLY_MODEL = process.env.STUDY_MODEL ?? null;
const runs = await sql<{ id: string; arm: string; model: string; task_set: string; corpus_version: string; ceiling: string }[]>`
  select id, arm, model, task_set, coalesce(notes->>'corpus_version', 'unrecorded') corpus_version,
         coalesce(notes->>'ceiling_tokens', 'unrecorded') ceiling
  from runs where id ~ '^[A-Z]+_[a-z][0-9]+$'
    and (${ONLY}::text is null or task_set = ${ONLY})
    and (${ONLY_MODEL}::text is null or model = ${ONLY_MODEL})
  order by arm, id`;
if (ONLY) console.log(`filtered to task set "${ONLY}"`);
if (ONLY_MODEL) console.log(`filtered to model "${ONLY_MODEL}"`);
if (ONLY || ONLY_MODEL) console.log('');

if (runs.length === 0) {
  console.log('No seed-study runs yet. Start them with ./go.sh seeds');
  await sql.end();
  process.exit(0);
}

// Exclude cells that never produced an agent outcome. A cell killed by a
// truncated response, an empty completion or a refusing endpoint is not a
// datum about context strategy, and averaging it in silently scores an
// infrastructure failure as agent behaviour. On the historical journal that was
// 9 of 29 cells. Published harnesses have the same conflation and none report
// the rate (arXiv 2605.12131), so it is reported here rather than assumed away.
const states = new Map((await classify(sql)).map((c) => [c.run_id, c]));
// A cell still in flight is not a datum. Admitting one scores a partial
// trajectory as a finished cell: it lands in n, its grounded rate is computed
// over however many turns happened to have run, and a stale `running` row with
// zero model calls reports as 0.000 rather than as the dead row it is. Held out
// and named, not silently dropped — the reader needs to know the study is
// incomplete, which is different from knowing a cell failed.
const in_flight = runs.filter((r) => states.get(r.id)?.terminal === 'running');
const excluded = runs.filter((r) => {
  const st = states.get(r.id);
  return st && !is_result(st.terminal) && st.terminal !== 'running';
});
if (excluded.length) {
  console.log(`EXCLUDED ${excluded.length} cell(s) with no agent outcome:`);
  for (const e of excluded) console.log(`  ${e.id.padEnd(12)} ${states.get(e.id)!.terminal} — ${states.get(e.id)!.note}`);
  console.log('  These are cells to re-run, not results.\n');
}
if (in_flight.length) {
  console.log(`HELD OUT ${in_flight.length} cell(s) still in flight — not results yet:`);
  for (const c of in_flight) console.log(`  ${c.id}`);
  console.log('');
}
// Independent of terminal classification: a cell with zero model calls is dead,
// not zero-scoring. classify() catches the ones it knows about, but a run that
// reaches status='done' with no model call — which has happened, twice — walks
// straight past it and lands in the statistics as 0.000 grounded. A second,
// dumber check that cannot be fooled by a status field.
const call_counts = new Map((await sql<{ run_id: string; n: number }[]>`
  select run_id, count(*)::int n from steps
  where kind = 'model_call' group by run_id`).map((r) => [r.run_id, r.n]));
// In-flight cells are exempt: a run that started seconds ago legitimately has
// zero model calls and is not dead. Without this the check reports a healthy
// run as a corpse, which is the same class of misleading diagnostic it exists
// to catch.
const never_ran = runs.filter(
  (r) => !(call_counts.get(r.id) ?? 0) && !in_flight.includes(r));
if (never_ran.length) {
  console.log(`EXCLUDED ${never_ran.length} cell(s) with zero model calls — dead, not zero-scoring:`);
  for (const c of never_ran) console.log(`  ${c.id.padEnd(12)} status is not evidence a run happened`);
  console.log('');
}
const admissible = new Set(
  runs.filter((r) => !excluded.includes(r) && !in_flight.includes(r) && !never_ran.includes(r))
      .map((r) => r.id));

// Two things make runs incomparable no matter how many seeds there are: a
// different model, and a different corpus manifest. The manifest matters
// because the read tool's description embeds the corpus listing, so a manifest
// change moves the stable prefix — the same silent break that went unnoticed
// until adding one file shifted the fingerprint. Both are refusals, not notes.
// The ceiling is a fourth. Two runs of the same arm on the same task set are
// not the same treatment if one truncates and the other never can: at 256k
// against peaks near 30k, A/AP/D are one arm; at a binding ceiling they are
// three. Without this key the compaction study pools straight into the
// non-binding study it was built to escape, and arm A reports as one interval
// over runs that did and did not truncate.
const models = [...new Set(runs.map((r) => r.model))];
const corpora = [...new Set(runs.map((r) => r.corpus_version))];
const sets = [...new Set(runs.map((r) => r.task_set))];
const ceilings = [...new Set(runs.map((r) => r.ceiling))];
if (models.length > 1 || corpora.length > 1 || sets.length > 1 || ceilings.length > 1) {
  console.log('REFUSING TO POOL — these runs did not see the same thing.\n');
  if (models.length > 1) console.log(`  models:  ${models.join(', ')}`);
  if (corpora.length > 1) console.log(`  corpora: ${corpora.join(', ')} (different stable prefixes)`);
  if (sets.length > 1) console.log(`  task sets: ${sets.join(', ')} (different work entirely)`);
  if (ceilings.length > 1) console.log(`  ceilings: ${ceilings.join(', ')} (binding and non-binding are different treatments)`);
  console.log('\n  breakdown:');
  for (const m of models) for (const c of corpora) {
    const ids = runs.filter((r) => r.model === m && r.corpus_version === c).map((r) => r.id);
    if (ids.length) console.log(`    ${m} / ${c}: ${ids.length} runs (${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ', ...' : ''})`);
  }
  console.log('\nFilter to one group with STUDY_TASK_SET, or re-run the odd cells.');
  await sql.end();
  process.exit(1);
}
console.log(`model ${models[0]}  corpus ${corpora[0]}  task set ${sets[0]}\n`);

type Cell = { grounded: number; verified: number; turns: number; tokens: number; stall: number; peak: number; bound: boolean };
const by_arm = new Map<string, Cell[]>();
/** module -> arm -> [verified?] across seeds, for pass@1 and pass^k. */
const per_module = new Map<string, Map<string, boolean[]>>();

for (const r of runs) {
  if (!admissible.has(r.id)) continue;
  const v = await verify_run(sql, r.id, false);
  const a = await artifact_report(sql, r.id);
  const [agg] = await sql<{ turns: number; tokens: number; peak: number }[]>`
    select coalesce(max(turn), 0)::int turns, coalesce(sum(tokens_in), 0)::int tokens,
           coalesce(max(tokens_in), 0)::int peak
    from steps where run_id = ${r.id}`;
  const [cfg] = await sql<{ ceiling: number }[]>`
    select coalesce((notes->>'ceiling_tokens')::int, 0) ceiling from runs where id = ${r.id}`;
  // Longest run of consecutive turns whose only tool calls were passive
  // (read/recall). A stall is not failure by itself, but an arm that stalls
  // more is an arm that has lost track of what it already has, which is the
  // thing under test rather than noise.
  const calls = await sql<{ turn: number; name: string }[]>`
    select turn, payload->>'name' as name from steps
    where run_id = ${r.id} and kind = 'tool_call' order by turn, seq`;
  const turns_seen = [...new Set(calls.map((c) => c.turn))].sort((x, y) => x - y);
  let stall = 0, cur = 0;
  for (const t of turns_seen) {
    const passive = calls.filter((c) => c.turn === t).every((c) => c.name === 'read' || c.name === 'recall');
    cur = passive ? cur + 1 : 0;
    if (cur > stall) stall = cur;
  }

  (by_arm.get(r.arm) ?? by_arm.set(r.arm, []).get(r.arm)!).push({
    grounded: a.claims ? a.grounded / a.claims : 0,
    verified: v.verified_completion,
    turns: agg?.turns ?? 0,
    tokens: agg?.tokens ?? 0,
    stall,
    peak: agg?.peak ?? 0,
    // Did this run actually reach the ceiling? The treatment arms defined by
    // ceiling behaviour are only distinguishable from control when it does.
    bound: (cfg?.ceiling ?? 0) > 0 && (agg?.peak ?? 0) > (cfg?.ceiling ?? 0),
  });

  const tasks = await sql<{ spec: any; status: string; id: string }[]>`
    select spec, status, id from tasks where run_id = ${r.id}`;
  // r.task_set, not the default. This called target_module() with no task set,
  // so it silently classified every site/operate/ship run against BUILD's module
  // names and matched almost nothing — the per-module table printed empty and
  // read as "no module was attempted" rather than "the wrong names were used".
  // has_gold guards the call because target_module now throws on a set with no
  // registered table, which is right for arm O and wrong for a reporting loop.
  for (const t of tasks) {
    if (!has_gold(r.task_set)) break;
    const m = target_module(t.spec ?? { title: '', detail: '', acceptance: '' }, r.task_set);
    if (!m) continue;
    const byarm = per_module.get(m) ?? per_module.set(m, new Map()).get(m)!;
    (byarm.get(r.arm) ?? byarm.set(r.arm, []).get(r.arm)!).push(t.status === 'done');
  }
}

// Reported before anything else, because every other number is conditional on
// it. An arm defined by ceiling behaviour measures nothing at a 0% binding
// rate, and three of this study's arms are defined that way. The research found
// this figure is essentially absent from published agent evaluations, which is
// how a ceiling that never binds goes unnoticed for months.
{
  const all = [...by_arm.values()].flat();
  const bound = all.filter((c) => c.bound).length;
  const rate = all.length ? bound / all.length : 0;
  const peaks = all.map((c) => c.peak).sort((a, b) => a - b);
  console.log('CEILING BINDING RATE — pre-registered target 60-70%.\n');
  console.log(`  ${bound}/${all.length} runs reached the ceiling = ${(rate * 100).toFixed(0)}%`);
  console.log(`  trajectory peaks: min ${peaks[0] ?? 0}, median ${peaks[Math.floor(peaks.length / 2)] ?? 0}, max ${peaks[peaks.length - 1] ?? 0}`);
  // Only a problem if an arm in THIS study depends on the ceiling. A' is "A
  // without truncation" and D is "A with compaction"; both collapse into A when
  // it never binds. Every other arm is ceiling-independent, so a low binding
  // rate is expected and harmless. Firing the warning regardless would be a
  // warning that cries wolf, which is how real ones get ignored.
  const ceiling_arms = [...by_arm.keys()].filter((a) => a === 'AP' || a === 'D');
  if (rate < 0.6 && ceiling_arms.length) {
    console.log(`  BELOW TARGET, and ${ceiling_arms.join('/')} depend on the ceiling:`);
    console.log('  they are not separable from the control in this regime, so any');
    console.log('  comparison between them is uninformative.');
  } else if (rate < 0.6) {
    console.log('  Below the 60-70% target, but no arm here depends on the ceiling');
    console.log('  (A/B/BR/O are all ceiling-independent), so this does not affect the result.');
  }
  console.log('');
}

console.log('GROUNDED-FINDING RATE — the result. 95% percentile bootstrap over seeds.\n');
console.log('arm   n   grounded rate [95% CI]           verified/run     turns    tokens/run   max stall');
const arms = [...by_arm.keys()].sort();
for (const arm of arms) {
  const cells = by_arm.get(arm)!;
  const g = bootstrap(cells.map((c) => c.grounded), 11);
  const v = bootstrap(cells.map((c) => c.verified), 12);
  const t = bootstrap(cells.map((c) => c.turns), 13);
  const k = bootstrap(cells.map((c) => c.tokens), 14);
  const stall = Math.max(...cells.map((c) => c.stall));
  console.log(`${arm.padEnd(5)} ${String(cells.length).padStart(2)}  ${fmt(g).padEnd(28)}  ${v.point.toFixed(2).padStart(6)}      ${t.point.toFixed(1).padStart(6)}  ${Math.round(k.point).toString().padStart(10)}  ${String(stall).padStart(9)}`);
}

console.log(`\nDIFFERENCE vs arm ${BASELINE}, grounded rate. Equivalence bound +/-${DELTA}.\n`);
const base = by_arm.get(BASELINE)?.map((c) => c.grounded);
if (!base) {
  console.log(`  baseline arm ${BASELINE} has no runs`);
} else {
  for (const arm of arms) {
    if (arm === BASELINE) continue;
    const d = bootstrap_diff(by_arm.get(arm)!.map((c) => c.grounded), base, 21);
    const e = equivalence(d, DELTA);
      console.log(`  ${arm.padEnd(4)} ${fmt(d).padEnd(28)} ${e.verdict.toUpperCase().padEnd(13)} ${e.note}`);
  }
}

console.log('\nPER-MODULE pass@1 and pass^k across seeds.\n');
const K = Number(process.env.PASS_K ?? 3);
const modules = [...per_module.keys()].sort();
console.log(`module          ${arms.map((a) => a.padEnd(13)).join('')}`);
for (const m of modules) {
  const row = arms.map((arm) => {
    const xs = per_module.get(m)!.get(arm) ?? [];
    if (xs.length === 0) return '-'.padEnd(13);
    const c = xs.filter(Boolean).length;
    const pk = pass_hat_k(c, xs.length, K);
    return `${(c / xs.length).toFixed(2)}/${pk === null ? 'n/a' : pk.toFixed(2)}`.padEnd(13);
  });
  console.log(`${m.padEnd(15)} ${row.join('')}`);
}
console.log(`\n(pass@1 / pass^${K}. pass^${K} is n/a where fewer than ${K} seeds attempted the module.)`);

const n = Math.min(...arms.map((a) => by_arm.get(a)!.length));
if (n < MIN_N) {
  console.log(`\nNOT YET READABLE: smallest arm has ${n} runs, below the ${MIN_N} needed for any verdict.`);
  console.log('Every interval above is a resampling artifact. Wait for the study to finish.');
} else if (n < 9) {
  console.log(`\nNOTE: ${n} seeds in the smallest arm. Intervals are wide; read verdicts, not points.`);
}

await sql.end();
