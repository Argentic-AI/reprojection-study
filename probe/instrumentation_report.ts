/** Run the new instrumentation over every real run. Analysis only. */
import { connect } from '../src/db.ts';
import { verify_run } from '../src/verify.ts';
import { build_artifacts, inconsistency_report } from '../src/inconsistency.ts';
import { assert_count, assert_rate, MetricError } from '../src/assertions.ts';
import { classify, is_result } from '../src/terminal.ts';

const sql = connect();
// Was hardcoded to task_set='audit' with no env filter and no status predicate,
// so it pinned itself to one study while reading neither STUDY_TASK_SET nor
// STUDY_MODEL — the same shape revision.ts had. Scoped now, and gated on
// is_result() rather than status, since terminated_by_context is arm AP's
// legitimate outcome.
const TASK_SET = process.env.STUDY_TASK_SET ?? 'audit';
const ONLY_MODEL = process.env.STUDY_MODEL ?? null;
const all_runs = await sql<{ id: string; arm: string; task_set: string; model: string }[]>`
  select id, arm, task_set, model from runs
  where task_set = ${TASK_SET} and id not like 'test%'
    and (${ONLY_MODEL}::text is null or model = ${ONLY_MODEL})
  order by started_at asc`;
const states = new Map((await classify(sql)).map((c) => [c.run_id, c]));
const runs = all_runs.filter((r) => { const st = states.get(r.id); return !st || is_result(st.terminal); });
if (all_runs.length !== runs.length) {
  console.error(`held out ${all_runs.length - runs.length} unfinished or failed cell(s)`);
}
const models = [...new Set(runs.map((r) => r.model))];
if (models.length > 1) console.error(`WARNING: ${models.length} models in this table — ${models.join(', ')}`);

const ver: any[] = [], inc: any[] = [];
for (const r of runs) {
  const v = await verify_run(sql, r.id);
  if (v.checked === 0 && v.tasks_total === 0) continue;
  // supported/checked is meaningless when the run's sources no longer exist:
  // verify.ts marks those runs unverifiable, and this file never looked at the
  // field, so it reported a support percentage computed against nothing.
  if (!v.verifiable) { console.error(`  ${r.id}: unverifiable (sources gone) — excluded`); continue; }
  try {
    assert_count('visible_completion', v.visible_completion, v.tasks_total);
    assert_count('verified_completion', v.verified_completion, v.visible_completion);
    if (v.checked) assert_rate('supported_rate', v.supported / v.checked);
  } catch (e) {
    if (e instanceof MetricError) { console.error(`  ${r.id}: ${e.message}`); continue; }
    throw e;
  }
  ver.push({
    run: r.id, arm: r.arm, claims: v.checked,
    supported: v.checked ? `${((v.supported / v.checked) * 100).toFixed(0)}%` : '-',
    misattr: v.misattributed, absent: v.symbol_absent, bad_line: v.line_out_of_range,
    'visible done': `${v.visible_completion}/${v.tasks_total}`,
    'VERIFIED done': `${v.verified_completion}/${v.tasks_total}`,
    gap: v.gap,
  });

  await build_artifacts(sql, r.id);
  const i = await inconsistency_report(sql, r.id);
  inc.push({
    run: r.id, arm: r.arm, artifacts: i.artifacts,
    'cross-task refs': i.cross_task_references,
    'correctly reused': i.correctly_reused,
    'recreated (renamed)': i.recreated_renamed,
    'recreated (same name)': i.recreated_identical,
    'referenced but never created': i.referenced_nonexistent,
  });
}

console.log('\nHIDDEN VERIFICATION — the agent never sees these checks');
console.table(ver);
console.log('supported = the citation is real (file exists, symbol present). It does NOT');
console.log('mean the reasoning is sound — that is not deterministically checkable.\n');
console.log('SELF-INCONSISTENCY — artifacts the agent created, and what happened to them');
console.table(inc);
await sql.end();
