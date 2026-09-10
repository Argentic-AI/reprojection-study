/**
 * Duplicate-path rate by arm: does an arm lose track of where it put things?
 *
 * WHY THIS IS ITS OWN METRIC. It was visible only as noise inside the grounded
 * count. A run that writes `coerce.ts` and later writes `src/coerce.ts` has not
 * hallucinated anything and has not misattributed anything - both files exist,
 * both are grounded - so the artifact metrics score it as healthy. What it has
 * lost is the layout of its own output, which is exactly the failure the
 * durable-state arms are supposed to prevent and exactly what an accumulating
 * transcript would be expected to drop first.
 *
 * WHAT COUNTS, AND WHY THE OBVIOUS DEFINITION IS WRONG. The first version of
 * this counted any basename living at two or more paths. That metric is
 * dominated by framework convention and says nothing about any arm:
 *
 *   relay: SKILL.md x27   - a vendored .agents/skills/<name>/SKILL.md tree
 *   operate: page.tsx x2  - Next.js App Router puts one in every route dir
 *   .gitkeep x4           - repeated by definition
 *
 * It scored arms M and AM at 24-30 "duplicates" per run for having a normal
 * Next.js layout, and scored A and B identically at 9/9 runs in operate. An
 * instrument that reports the framework rather than the agent is the
 * step_zero.ts mistake again.
 *
 * What is actually diagnostic is the shape originally observed: the same
 * basename at the run ROOT and again under a subdirectory - BR_s1/types.ts
 * beside BR_s1/src/types.ts, BR_w7/faq.ts beside BR_w7/src/faq.ts. No framework
 * asks for that. It means the run wrote a module, lost track of where it put
 * it, and wrote it again somewhere else.
 *
 * Content is compared, because the two cases differ: byte-identical twins are
 * wasted work, divergent twins are two live versions of one module and the run
 * has no way to know which is current.
 *
 * THE DENOMINATOR IS GUARDED, because it has been wrong here before.
 *   - Only directories that are actually runs in the database. workspace/ holds
 *     FETCHTEST, SBTEST and SAFETY_TEST, which any `workspace/*` glob counts as
 *     three runs.
 *   - Harness-written probe artifacts are removed by name: A_p1/probe-write.*
 *     and B_p3/zz-probe* were written by probe/write_reachable.ts, not by a
 *     model, and they sit inside two measured workspaces.
 *   - Reproducible trees (node_modules, .next, dist, generated, .pnpm-store)
 *     are skipped: a duplicate inside a dependency is not the agent's doing.
 *
 * POOLING. Reported per (task_set, model) cell. Pooling arms across cells would
 * mix task sets and models, which is the aggregate error CLAUDE.md names.
 *
 *   ./go.sh duplicate-paths
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { connect } from '../src/db.ts';

const SKIP = new Set(['node_modules', '.next', 'dist', 'generated', '.pnpm-store', '.git', '.turbo']);
/** Written by the harness, inside runs that are otherwise real. */
const PROBE_ARTIFACT = /^(probe-write\.|zz-probe)/;

function files_under(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e)) continue;
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (!PROBE_ARTIFACT.test(e)) out.push(p.slice(root.length + 1));
    }
  };
  walk(root);
  return out;
}

const sql = connect();
const runs = await sql<{ id: string; arm: string; task_set: string; model: string }[]>`
  select id, arm, coalesce(task_set,'-') task_set, model from runs
  where status = 'done' and id not like 'test\_%' escape '\\'
  order by task_set, model, arm, id`;

type Row = { run: string; arm: string; cell: string; files: number; names: number; dup_names: number; divergent: number; worst: string };
const rows: Row[] = [];
for (const r of runs) {
  const files = files_under(join('workspace', r.id));
  if (!files.length) continue;
  const by_name = new Map<string, string[]>();
  for (const f of files) {
    const b = basename(f);
    (by_name.get(b) ?? by_name.set(b, []).get(b)!).push(f);
  }
  // Root-and-nested only: one copy directly in the run directory, another
  // deeper. Convention repeats (page.tsx per route, SKILL.md per skill) never
  // take this shape because they never sit at the root.
  const dups = [...by_name.entries()].filter(([, ps]) =>
    ps.some((x) => !x.includes('/')) && ps.some((x) => x.includes('/')));
  const worst = dups.sort((a, b) => b[1].length - a[1].length)[0];
  let divergent = 0;
  for (const [, ps] of dups) {
    const bodies = new Set(ps.map((x) => { try { return readFileSync(join('workspace', r.id, x), 'utf8'); } catch { return ''; } }));
    if (bodies.size > 1) divergent++;
  }
  rows.push({
    run: r.id, arm: r.arm, cell: `${r.task_set}/${r.model.split('/').pop()}`,
    files: files.length, names: by_name.size, dup_names: dups.length, divergent,
    worst: worst ? `${worst[0]} x${worst[1].length}` : '',
  });
}

const cells = [...new Set(rows.map((r) => r.cell))].sort();
console.log('DUPLICATE-PATH RATE BY ARM');
console.log('same basename at the run root AND under a subdirectory');
console.log('(framework repeats like page.tsx per route are excluded by that shape)\n');
for (const cell of cells) {
  const inc = rows.filter((r) => r.cell === cell);
  const arms = [...new Set(inc.map((r) => r.arm))].sort();
  if (inc.length < 2) continue;
  console.log(`--- ${cell} ---`);
  console.log('arm   runs  runs w/ dup   dup names/run   divergent   files/run   worst case');
  for (const arm of arms) {
    const a = inc.filter((r) => r.arm === arm);
    const affected = a.filter((r) => r.dup_names > 0);
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const worst = a.slice().sort((x, y) => y.dup_names - x.dup_names)[0]!;
    console.log(
      `${arm.padEnd(5)} ${String(a.length).padStart(4)}  ${String(affected.length).padStart(6)}/${String(a.length).padEnd(4)}`
      + `  ${mean(a.map((r) => r.dup_names)).toFixed(2).padStart(12)}`
      + `  ${String(a.reduce((n, r) => n + r.divergent, 0)).padStart(9)}`
      + `  ${mean(a.map((r) => r.files)).toFixed(1).padStart(9)}`
      + `   ${worst.dup_names ? `${worst.run} ${worst.worst}` : '-'}`);
  }
  console.log('');
}
console.log('runs with any duplicate, listed:');
for (const r of rows.filter((x) => x.dup_names > 0).sort((a, b) => b.dup_names - a.dup_names)) {
  console.log(`  ${r.run.padEnd(8)} ${r.arm.padEnd(3)} ${r.cell.padEnd(28)} ${String(r.dup_names).padStart(3)} dup  ${String(r.divergent).padStart(3)} divergent  worst ${r.worst}`);
}
await sql.end();
