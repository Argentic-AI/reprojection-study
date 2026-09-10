/**
 * Does grounded-finding rate reward doing less work?
 *
 * The rate is grounded/claims. If an arm that writes fewer files also makes
 * fewer claims, it can score a higher RATE while producing less. That would
 * make the headline metric partly a measure of reticence rather than accuracy,
 * and it would flatter exactly the arm the study is trying to beat.
 *
 * Raised by the peer chat: "A scores 1.000 corpus-grounded while producing 3.0
 * files." This checks it directly, per arm and per run.
 */
import { connect } from '../src/db.ts';
import { artifact_report } from '../src/artifacts.ts';
import { list_workspace } from '../src/workspace.ts';

const sql = connect();
const TASK_SET = process.env.STUDY_TASK_SET ?? 'site';
const ONLY_MODEL = process.env.STUDY_MODEL ?? null;

const runs = await sql<{ id: string; arm: string }[]>`
  select r.id, r.arm from runs r
  where r.task_set = ${TASK_SET}
    and r.id ~ '^[A-Z]+_[a-z][0-9]+$'
    and r.status = 'done'
    and (${ONLY_MODEL}::text is null or r.model = ${ONLY_MODEL})
    and (select count(*) from steps s where s.run_id = r.id and s.kind = 'model_call') > 0
  order by r.arm, r.id`;

type Row = { id: string; arm: string; files: number; claims: number; grounded: number; rate: number };
const rows: Row[] = [];
for (const r of runs) {
  const a = await artifact_report(sql, r.id);
  rows.push({
    id: r.id, arm: r.arm,
    files: list_workspace(r.id).length,
    claims: a.claims, grounded: a.grounded,
    rate: a.claims ? a.grounded / a.claims : 0,
  });
}

const arms = [...new Set(rows.map((r) => r.arm))].sort();
console.log(`task set ${TASK_SET}${ONLY_MODEL ? `  model ${ONLY_MODEL}` : ''}  n=${rows.length} runs\n`);
console.log('arm   runs   files/run   claims/run   grounded/run   RATE     grounded per FILE');
for (const arm of arms) {
  const rs = rows.filter((r) => r.arm === arm);
  const mean = (f: (r: Row) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
  const files = mean((r) => r.files), claims = mean((r) => r.claims), g = mean((r) => r.grounded);
  console.log(
    `${arm.padEnd(4)} ${String(rs.length).padStart(5)}   ${files.toFixed(2).padStart(9)}   `
    + `${claims.toFixed(2).padStart(10)}   ${g.toFixed(2).padStart(12)}   `
    + `${mean((r) => r.rate).toFixed(3).padStart(6)}   ${(files ? g / files : 0).toFixed(3).padStart(17)}`);
}

// Pearson r between files written and grounded RATE, pooled across arms. A
// strong negative r is the smoking gun: the more you build, the worse you score.
const n = rows.length;
const mx = rows.reduce((a, r) => a + r.files, 0) / n;
const my = rows.reduce((a, r) => a + r.rate, 0) / n;
let sxy = 0, sxx = 0, syy = 0;
for (const r of rows) {
  const dx = r.files - mx, dy = r.rate - my;
  sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
}
const r_pearson = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
console.log(`\nPearson r(files written, grounded rate) across all ${n} runs = ${r_pearson.toFixed(3)}`);
console.log(r_pearson < -0.3
  ? '  NEGATIVE — the rate penalises building. It is partly a measure of reticence.'
  : r_pearson > 0.3
    ? '  POSITIVE — arms that build more also ground better. The rate is not a reticence proxy.'
    : '  NEAR ZERO — no evidence the rate rewards doing less.');

console.log('\nGROUNDED FINDINGS PER FILE is the volume-adjusted view: it asks how much');
console.log('correct work an arm produced, not what fraction of its claims survived.');
await sql.end();

if (process.env.PER_RUN === '1') {
  console.log('\n--rows--');
  for (const r of rows) console.log(`${r.arm}\t${r.id}\t${r.files}\t${r.claims}\t${r.grounded}\t${r.rate.toFixed(4)}`);
}
