/** Cross-task artifact reuse, all verifiable runs. The metric F4 is judged on. */
import { connect } from '../src/db.ts';
import { build_artifacts, inconsistency_report } from '../src/inconsistency.ts';
import { verify_run } from '../src/verify.ts';

const sql = connect();
const runs = await sql<{ id: string; arm: string; task_set: string }[]>`
  select id, arm, task_set from runs order by started_at asc`;

console.log('run             set    arm  artifacts  cross-refs  reused  recreated  phantom');
for (const r of runs) {
  const { verifiable } = await verify_run(sql, r.id, false);
  if (!verifiable) continue;
  await build_artifacts(sql, r.id);
  const i = await inconsistency_report(sql, r.id);
  if (i.artifacts === 0) continue;
  console.log([
    r.id.padEnd(15), r.task_set.padEnd(6), r.arm.padEnd(4),
    String(i.artifacts).padStart(9), String(i.cross_task_references).padStart(12),
    String(i.correctly_reused).padStart(7),
    String(i.recreated_renamed + i.recreated_identical).padStart(10),
    String(i.referenced_nonexistent).padStart(8),
  ].join(''));
}
await sql.end();
