/** What the widened verification scope changes, per run. */
import { connect } from '../src/db.ts';
import { verify_run } from '../src/verify.ts';
import { scope_summary } from '../src/ground.ts';

const sql = connect();
const runs = await sql<{ id: string; arm: string; task_set: string }[]>`
  select id, arm, task_set from runs order by started_at asc`;

const hdr = ['run', 'set', 'arm', 'done', 'ver', 'vac', 'ok', 'misatt', 'absent', 'nofile', 'range', 'unparse', 'ws'];
console.log(hdr.map((h, i) => h.padEnd(i === 0 ? 15 : 8)).join(''));

const totals: Record<string, { done: number; ver: number; vac: number }> = {};
const unverifiable: string[] = [];
for (const r of runs) {
  const v = await verify_run(sql, r.id, false);
  if (v.visible_completion === 0 && v.checked === 0) continue;
  if (!v.verifiable) { unverifiable.push(`${r.id} (${r.task_set})`); continue; }
  const s = scope_summary(r.id);
  const t = (totals[r.task_set] ??= { done: 0, ver: 0, vac: 0 });
  t.done += v.visible_completion; t.ver += v.verified_completion; t.vac += v.vacuous_completion;
  console.log([
    r.id, r.task_set, r.arm, v.visible_completion, v.verified_completion, v.vacuous_completion,
    v.supported, v.misattributed, v.symbol_absent, v.file_missing, v.line_out_of_range,
    v.unparseable, s.workspace_files,
  ].map((c, i) => String(c).padEnd(i === 0 ? 15 : 8)).join(''));
}

console.log('\nby task set          done   verified   vacuous');
for (const [set, t] of Object.entries(totals)) {
  console.log(`${set.padEnd(20)} ${String(t.done).padStart(4)} ${String(t.ver).padStart(10)} ${String(t.vac).padStart(9)}`);
}
if (unverifiable.length) {
  console.log(`\nunverifiable (sources no longer exist): ${unverifiable.length} runs`);
  console.log('  ' + unverifiable.join('\n  '));
}
await sql.end();
