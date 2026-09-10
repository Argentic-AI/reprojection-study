/**
 * The two replications side by side.
 *
 * Same task set, same harness, same arms, different model. power.ts refuses to
 * pool them, so this is the generalisation check: does the ordering of arms
 * survive a change of model, or was replication 1 a fact about GLM-4.7-Flash?
 *
 * THREE THINGS THIS GOT WRONG, all found by an audit rather than by use.
 *
 * 1. The tag-to-model map was hardcoded as a LABEL, never checked against the
 *    data. Run a different model under tag x and the header cheerfully claimed
 *    it was GLM-5.3. The model is now read from the rows and the label is
 *    derived, so it cannot lie.
 * 2. It copied power.ts's exclusion predicate but not power.ts's separate
 *    in-flight hold-out, so status='running' cells fell through into the
 *    bootstrap. A barely-started cell contributes grounded=0 and inflates n —
 *    at one point rep2 held four running cells against four done ones, so its
 *    row would have been computed over roughly twice its real n.
 * 3. No corpus or ceiling check, so a manifest or ceiling change inside one tag
 *    passed silently.
 */
import { connect } from '../src/db.ts';
import { verify_run } from '../src/verify.ts';
import { artifact_report } from '../src/artifacts.ts';
import { classify, is_result } from '../src/terminal.ts';
import { bootstrap, fmt } from '../src/stats.ts';

const sql = connect();
const states = new Map((await classify(sql)).map((c) => [c.run_id, c]));
const TAGS = (process.env.REP_TAGS ?? 'w,x').split(',');

for (const tag of TAGS) {
  const runs = await sql<
    { id: string; arm: string; model: string; corpus: string; ceiling: string; calls: number }[]
  >`
    select r.id, r.arm, r.model,
           coalesce(r.notes->>'corpus_version', 'unrecorded') corpus,
           coalesce(r.notes->>'ceiling_tokens', 'unrecorded') ceiling,
           (select count(*)::int from steps s
            where s.run_id = r.id and s.kind = 'model_call') calls
    from runs r where r.id ~ ${'^[A-Z]+_' + tag + '[0-9]+$'} order by r.arm, r.id`;
  if (!runs.length) { console.log(`\ntag ${tag}: no cells yet`); continue; }

  const dead = runs.filter((r) => !r.calls);
  const unfinished = runs.filter((r) => {
    const st = states.get(r.id);
    return r.calls && st && !is_result(st.terminal);
  });
  const live = runs.filter((r) => r.calls && !unfinished.includes(r));

  // Derived, not asserted. Whatever the cells actually ran on is what gets printed.
  const models = [...new Set(live.map((r) => r.model))];
  const corpora = [...new Set(live.map((r) => r.corpus))];
  const ceilings = [...new Set(live.map((r) => r.ceiling))];

  console.log(`\ntag ${tag} — ${live.length} admissible cells`
    + (dead.length ? `, ${dead.length} dead (no model call)` : '')
    + (unfinished.length ? `, ${unfinished.length} unfinished` : ''));
  if (unfinished.length) {
    console.log(`  held out: ${unfinished.map((u) => `${u.id}(${states.get(u.id)!.terminal})`).join(', ')}`);
  }
  if (!live.length) continue;
  if (models.length > 1 || corpora.length > 1 || ceilings.length > 1) {
    console.log('  REFUSING — this tag is not one replication:');
    if (models.length > 1) console.log(`    models:   ${models.join(', ')}`);
    if (corpora.length > 1) console.log(`    corpora:  ${corpora.join(', ')}`);
    if (ceilings.length > 1) console.log(`    ceilings: ${ceilings.join(', ')}`);
    continue;
  }
  console.log(`  model ${models[0]}  corpus ${corpora[0]}  ceiling ${ceilings[0]}`);
  console.log('  arm   n  grounded [95% CI]            files/run  decisions/run  verified/run');

  const by: Record<string, { g: number[]; f: number[]; d: number[]; v: number[] }> = {};
  for (const r of live) {
    const a = await artifact_report(sql, r.id);
    const v = await verify_run(sql, r.id, false);
    const [x] = await sql<{ files: number; decs: number }[]>`
      select (select count(*) from created_artifacts c where c.run_id=${r.id} and c.kind='file')::int files,
             (select count(*) from decisions d where d.run_id=${r.id})::int decs`;
    const b = (by[r.arm] ??= { g: [], f: [], d: [], v: [] });
    b.g.push(a.claims ? a.grounded / a.claims : 0);
    b.f.push(x?.files ?? 0); b.d.push(x?.decs ?? 0); b.v.push(v.verified_completion);
  }
  for (const arm of Object.keys(by).sort()) {
    const b = by[arm]!;
    const mean = (xs: number[]) => xs.reduce((p, c) => p + c, 0) / (xs.length || 1);
    console.log(`  ${arm.padEnd(4)} ${String(b.g.length).padStart(2)}  ${fmt(bootstrap(b.g, 11)).padEnd(27)} `
      + `${mean(b.f).toFixed(1).padStart(9)}  ${mean(b.d).toFixed(0).padStart(13)}  ${mean(b.v).toFixed(2).padStart(12)}`);
  }
}
await sql.end();
