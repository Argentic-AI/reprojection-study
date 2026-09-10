/** Run the artifact-integrity metric over every real run already journalled. */
import { connect } from '../src/db.ts';
import { artifact_report } from '../src/artifacts.ts';
import { verify_run } from '../src/verify.ts';
import { classify, is_result } from '../src/terminal.ts';

const sql = connect();
// The only completeness gate was "has at least one decision row", which a
// failed or in-flight cell can satisfy. Scoped and status-gated now.
const TASK_SET = process.env.STUDY_TASK_SET ?? null;
const ONLY_MODEL = process.env.STUDY_MODEL ?? null;
const all_runs = await sql<{ id: string; arm: string; task_set: string }[]>`
  select id, arm, task_set from runs
  where id not like 'test\_%' escape '\\'
    and exists (select 1 from decisions d where d.run_id = runs.id)
    and (${TASK_SET}::text is null or task_set = ${TASK_SET})
    and (${ONLY_MODEL}::text is null or model = ${ONLY_MODEL})
  order by started_at asc`;
const states = new Map((await classify(sql)).map((c) => [c.run_id, c]));
const runs = all_runs.filter((r) => { const st = states.get(r.id); return !st || is_result(st.terminal); });
if (all_runs.length !== runs.length) {
  console.error(`held out ${all_runs.length - runs.length} unfinished or failed cell(s)`);
}

const rows: any[] = [];
for (const r of runs) {
  const a = await artifact_report(sql, r.id);
  // rainwater read a document set that no longer exists; any symbol it appears
  // to share with this repo is coincidence, not reuse.
  const { verifiable } = await verify_run(sql, r.id, false);
  if (!verifiable) continue;
  if (a.claims === 0 && a.subtasks === 0) continue;
  rows.push({
    run: r.id, arm: r.arm, set: r.task_set,
    claims: a.claims,
    grounded: a.claims ? `${((a.grounded / a.claims) * 100).toFixed(0)}%` : '-',
    misattr: a.misattributed,
    halluc: a.claims ? `${((a.hallucinated / a.claims) * 100).toFixed(0)}%` : '-',
    'carried fwd': a.carried_forward,
    'carried ok': a.carried_forward ? `${((a.carried_and_grounded / a.carried_forward) * 100).toFixed(0)}%` : 'n/a',
    subtasks: a.subtasks,
    'dup subtasks': a.subtasks ? `${a.duplicate_subtasks} (${((a.duplicate_subtasks / a.subtasks) * 100).toFixed(0)}%)` : '-',
  });
}
console.table(rows);
console.log('\ngrounded   = symbol really is in the file it was attributed to');
console.log('misattr    = exists in the codebase, but not in that file');
console.log('halluc     = does not exist anywhere in the corpus');
console.log('carried fwd= symbol claimed in one task and claimed again in a LATER task');
console.log('carried ok = of those, how many were still grounded the second time');
await sql.end();
