/**
 * How much of a cell's shell time went into dependency plumbing rather than the
 * product, and whether the existing repetition guard would have noticed.
 *
 * WHY. M_v1 spent an entire 300-turn horizon and 303 shell calls inside
 * node_modules, trying to make a release-candidate Prisma 8 and a better-auth
 * adapter initialise. It wrote zero application files. It was not idle and it
 * was not stalled - the provider answered every turn. It was busy on the wrong
 * thing, and nothing in the harness said so.
 *
 * The guard that exists fires when the same command SHAPE appears 4 times in a
 * window of 8 (run.ts, the `repeats >= 4` nudge). Measured across four relay
 * cells it is not merely silent on this failure, it is anti-correlated with it:
 *
 *   run     files   plumbing%   longest run   guard
 *   M_v1        0         74%            42   silent
 *   MV_v1       6         52%            17   silent
 *   M_k1       12         34%            27   silent
 *   AM_v1       7         15%             9   WOULD FIRE
 *
 * It stays quiet on the cell that produced nothing and trips on the cell with
 * the least plumbing. A stuttering loop and a sustained march through the
 * dependency tree are different failures, and only the first is instrumented.
 *
 * n=4. This is a signal worth measuring, not an established result. It is a
 * probe rather than a harness change on purpose: changing the run loop while
 * cells are in flight would unpool them.
 */
import { connect } from '../src/db.ts';

/** Commands whose subject is the dependency tree rather than the product. */
const PLUMBING = /node_modules|\.pnpm|pnpm (add|install|why|why)|prisma\.js|package\.json|npm (ls|install)/;
/** The narrower set used for "consecutive": editing or spelunking installed code. */
const DEEP = /node_modules|\.pnpm|prisma\.js/;

const shape = (c: string) => c.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

const sql = connect();
const SET = process.env.STUDY_TASK_SET ?? 'relay';

const runs = await sql<{ id: string; arm: string; files: number }[]>`
  select r.id, r.arm,
         (select count(*) from created_artifacts c
           where c.run_id = r.id and c.kind = 'file')::int as files
  from runs r
  where r.task_set = ${SET} and r.status = 'done'
  order by r.arm, r.id`;

console.log(`shell time spent on dependency plumbing — task set ${SET}\n`);
console.log('  run     arm   files  shell  plumbing  longest  guard');

for (const r of runs) {
  const rows = await sql<{ cmd: string | null }[]>`
    select payload->'args'->>'cmd' as cmd
    from steps where run_id = ${r.id} and kind = 'tool_call'
      and payload->>'name' = 'shell'
    order by turn`;
  const cmds = rows.map((x) => String(x.cmd ?? ''));
  if (cmds.length === 0) continue;

  const plumbing = cmds.filter((c) => PLUMBING.test(c)).length;
  let run = 0, longest = 0;
  for (const c of cmds) { if (DEEP.test(c)) { run++; longest = Math.max(longest, run); } else run = 0; }

  // The existing guard, reproduced exactly: same shape 4x within a window of 8.
  let max_rep = 0;
  for (let i = 0; i < cmds.length; i++) {
    const w = cmds.slice(Math.max(0, i - 7), i + 1).map(shape);
    for (const s of w) max_rep = Math.max(max_rep, w.filter((x) => x === s).length);
  }

  const pct = Math.round((100 * plumbing) / cmds.length);
  console.log(
    `  ${r.id.padEnd(7)} ${r.arm.padEnd(4)} ${String(r.files).padStart(5)}`
    + `  ${String(cmds.length).padStart(5)}  ${String(pct).padStart(7)}%`
    + `  ${String(longest).padStart(7)}  ${max_rep >= 4 ? 'fires' : 'silent'}`,
  );
}

console.log('\nA cell can spend its whole horizon busy and produce nothing. "Working" is');
console.log('not the same as "working on the product", and only the first is measured.');

await sql.end();
