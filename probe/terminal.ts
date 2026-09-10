import { connect } from '../src/db.ts';
import { classify, is_result } from '../src/terminal.ts';
const sql = connect();
const rows = await classify(sql, process.env.STUDY_TASK_SET);
console.log('run            set    arm  terminal            turns  note');
const tally: Record<string, number> = {};
for (const c of rows) {
  tally[c.terminal] = (tally[c.terminal] ?? 0) + 1;
  console.log(`${c.run_id.padEnd(14)} ${c.task_set.padEnd(6)} ${c.arm.padEnd(4)} ${c.terminal.padEnd(19)} ${String(c.turns).padStart(5)}  ${c.note}`);
}
console.log('\nterminal states:');
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(20)} ${String(v).padStart(3)} ${is_result(k as any) ? '(admissible)' : k === 'running' ? '' : '(re-run, not a result)'}`);
}
const admissible = rows.filter((c) => is_result(c.terminal)).length;
const infra = rows.filter((c) => c.terminal.startsWith('infra') || c.terminal === 'harness_bug').length;
console.log(`\n${admissible} admissible, ${infra} lost to infrastructure or harness.`);
if (infra) console.log('Those were previously counted as agent behaviour.');
await sql.end();
