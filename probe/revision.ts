/**
 * The novel measurement: did superseded decisions actually reach the artifacts?
 *
 * HEADLINE IS THE RUN-LEVEL RATE, not the event-level one. Revision events
 * cluster inside runs — three scripted contradictions per run, scored against
 * whatever that run happened to build — so an event-level test treats
 * correlated observations as independent and reports a p smaller than the data
 * supports. The run is the unit of randomisation, so the run is the unit of
 * analysis. Event counts are printed because they are informative; they are
 * not the result.
 *
 * This file previously hardcoded task_set='site' and read no filters at all,
 * so STUDY_TASK_SET silently did nothing and runs from two different models
 * were tabulated together. Both are fixed here, and pooling is now refused
 * rather than noted, matching probe/power.ts.
 */
import { connect } from '../src/db.ts';
import { score_revisions } from '../src/propagation.ts';
import { classify, is_result } from '../src/terminal.ts';

const sql = connect();
const TASK_SET = process.env.STUDY_TASK_SET ?? 'site';
const ONLY_MODEL = process.env.STUDY_MODEL ?? null;

const runs = await sql<
  { id: string; arm: string; model: string; corpus: string; ceiling: string; calls: number }[]
>`
  select r.id, r.arm, r.model,
         coalesce(r.notes->>'corpus_version', 'unrecorded') corpus,
         coalesce(r.notes->>'ceiling_tokens', 'unrecorded') ceiling,
         (select count(*)::int from steps s
          where s.run_id = r.id and s.kind = 'model_call') calls
  from runs r
  where r.task_set = ${TASK_SET}
    and r.id ~ '^[A-Z]+_[a-z][0-9]+$'
    and (${ONLY_MODEL}::text is null or r.model = ${ONLY_MODEL})
  order by r.arm, r.id`;

if (!runs.length) {
  console.log(`no "${TASK_SET}" runs${ONLY_MODEL ? ` on ${ONLY_MODEL}` : ''} yet`);
  await sql.end();
  process.exit(0);
}

// Two independent gates, because neither catches the other's case.
//
// 1. Zero model calls: the cell never ran. Not a zero, an absence — averaging it
//    in scores an infrastructure failure as perfect non-propagation.
// 2. Terminal state: a cell that failed or is still in flight is not a datum.
//    Scored by status this would be wrong — 'terminated_by_context' IS arm AP's
//    legitimate result — so the gate is is_result(), matching power.ts, not a
//    blanket status='done'.
const states = new Map((await classify(sql)).map((c) => [c.run_id, c]));
const dead = runs.filter((r) => !r.calls);
const bad = runs.filter((r) => {
  const st = states.get(r.id);
  // is_result() is already false for 'running', so in-flight cells fall out here
  // too — no separate hold-out needed, unlike power.ts where the two are reported
  // differently.
  return r.calls && st && !is_result(st.terminal);
});
const live = runs.filter((r) => r.calls && !bad.includes(r));
if (dead.length) {
  console.log(`EXCLUDED ${dead.length} cell(s) with zero model calls: ${dead.map((d) => d.id).join(', ')}`);
}
if (bad.length) {
  console.log(`EXCLUDED ${bad.length} cell(s) not a finished result: `
    + bad.map((b) => `${b.id}(${states.get(b.id)!.terminal})`).join(', '));
}
if (dead.length || bad.length) console.log('');
if (!live.length) { console.log('no admissible cells'); await sql.end(); process.exit(0); }

const models = [...new Set(live.map((r) => r.model))];
const corpora = [...new Set(live.map((r) => r.corpus))];
const ceilings = [...new Set(live.map((r) => r.ceiling))];
if (models.length > 1 || corpora.length > 1 || ceilings.length > 1) {
  console.log('REFUSING TO POOL — these runs did not see the same thing.\n');
  if (models.length > 1) console.log(`  models:   ${models.join(', ')}`);
  if (corpora.length > 1) console.log(`  corpora:  ${corpora.join(', ')}`);
  if (ceilings.length > 1) console.log(`  ceilings: ${ceilings.join(', ')}`);
  console.log('\nFilter with STUDY_MODEL, or re-run the odd cells.');
  await sql.end();
  process.exit(1);
}
console.log(`task set ${TASK_SET}  model ${models[0]}  corpus ${corpora[0]}  n=${live.length} runs\n`);

// TWO different questions, and conflating them overstates the result.
//   any_change  - at least one dependent artifact was updated (includes 'partial')
//   complete    - verdict 'propagated': every dependent updated, no orphans left
// The first is "did the revision reach the code at all", the second is "did it
// reach all of it". Reporting the first under the second's name is the mistake
// this column split exists to prevent.
type Cell = { propagated: number; closure: number; delivered: number; any_change: boolean; complete: boolean };
const by_arm = new Map<string, Cell[]>();
const verdicts = new Map<string, Map<string, number>>();

console.log('run       arm  revision      verdict        propagated  orphans');
for (const r of live) {
  // CONDITION ON DELIVERY. A revision the run never received cannot have been
  // propagated, and counting it as a failure is scoring an agent for a message
  // it was never sent. Arm A has not_delivered on 21 of 27 events because its
  // runs end before the later triggers fire; including those made its zero look
  // categorical when much of it was absence of the stimulus.
  let prop = 0, closure = 0, complete = 0, delivered = 0;
  for (const s of await score_revisions(sql, r.id)) {
    console.log(`${r.id.padEnd(9)} ${r.arm.padEnd(4)} ${s.revision.padEnd(13)} ${s.verdict.padEnd(14)} `
      + `${String(s.propagated)}/${s.closure_present}`.padStart(10) + `  ${s.orphans.slice(0, 3).join(',') || '-'}`);
    if (!s.delivered) continue;
    delivered++;
    prop += s.propagated;
    closure += s.closure_present;
    if (s.verdict === 'propagated') complete++;
    const v = verdicts.get(r.arm) ?? verdicts.set(r.arm, new Map()).get(r.arm)!;
    v.set(s.verdict, (v.get(s.verdict) ?? 0) + 1);
  }
  (by_arm.get(r.arm) ?? by_arm.set(r.arm, []).get(r.arm)!)
    .push({ propagated: prop, closure, delivered, any_change: prop > 0, complete: complete > 0 });
}

const arms = [...by_arm.keys()].sort();
console.log('\nVERDICT DISTRIBUTION — event level, informative but NOT the result.\n');
for (const arm of arms) {
  // An arm can appear in by_arm with no verdicts at all — every one of its
  // revisions undelivered. That is a legitimate state, not a missing key.
  const v = verdicts.get(arm) ?? new Map<string, number>();
  const total = [...v.values()].reduce((a, b) => a + b, 0);
  if (!total) { console.log(`  ${arm.padEnd(3)} n=  0  (no revision was ever delivered)`); continue; }
  const parts = [...v.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`);
  console.log(`  ${arm.padEnd(3)} n=${String(total).padStart(3)}  ${parts.join('  ')}`);
}

console.log('\nRUN-LEVEL PROPAGATION — the result. Unit of analysis is the run.\n');
console.log('arm   runs   delivered   mean rate   >=1 artifact changed   >=1 revision COMPLETE');
for (const arm of arms) {
  const cells = by_arm.get(arm)!;
  const rates = cells.filter((c) => c.closure).map((c) => c.propagated / c.closure);
  const mean = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
  const any = cells.filter((c) => c.any_change).length;
  const done = cells.filter((c) => c.complete).length;
  const dv = cells.reduce((a, c) => a + c.delivered, 0);
  // Denominator is runs that ACTUALLY RECEIVED at least one revision.
  const elig = cells.filter((c) => c.delivered > 0).length;
  console.log(`${arm.padEnd(4)} ${String(cells.length).padStart(5)}   ${String(dv).padStart(9)}   `
    + `${mean.toFixed(3).padStart(9)}   ` + `${any}/${elig}`.padStart(20) + `   ${done}/${elig}`.padStart(22));
}

console.log('\nverbal_only is the failure the literature cannot currently see:');
console.log('the decision records the change and no artifact reflects it.');
await sql.end();
