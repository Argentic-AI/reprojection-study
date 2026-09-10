/**
 * Turn count is a cost metric. Grounded-finding rate is the result.
 * Printed side by side so the two can never again be read as one number.
 */
import { connect } from '../src/db.ts';
import { verify_run } from '../src/verify.ts';
import { artifact_report } from '../src/artifacts.ts';

const sql = connect();
const runs = await sql<{ id: string; arm: string; task_set: string }[]>`
  select id, arm, task_set from runs order by started_at asc`;

console.log('run             set    arm  turns   done   ver   claims  grounded  carried');
for (const r of runs) {
  const v = await verify_run(sql, r.id, false);
  if (!v.verifiable) continue;
  const a = await artifact_report(sql, r.id);
  const rows = await sql<{ turns: number }[]>`
    select coalesce(max(turn), 0)::int as turns from steps where run_id = ${r.id}`;
  const turns = rows[0]?.turns ?? 0;
  const g = a.claims ? `${Math.round(100 * a.grounded / a.claims)}%` : '-';
  console.log([
    r.id.padEnd(15), r.task_set.padEnd(6), r.arm.padEnd(4),
    String(turns).padStart(5), String(v.visible_completion).padStart(6),
    String(v.verified_completion).padStart(6), String(a.claims).padStart(8),
    g.padStart(9), String(a.carried_forward).padStart(9),
  ].join(''));
}
await sql.end();
