/**
 * The published grounded-output headline counts a symbol as `grounded` whenever
 * the surrounding text named no file at all - src/artifacts.ts:46,
 * `body === null ? 'grounded'`. The comment there is honest about it ("no
 * location was claimed, so there is nothing to be wrong about"), but the README
 * reports the resulting number as evidence about attribution. Under that
 * predicate an arm can raise its score by citing fewer files, which is the
 * opposite of the behaviour the study claims to measure.
 *
 * This probe recomputes the same arm comparison under the stricter predicate -
 * grounded AND a file was named AND the symbol was found in it - and runs the
 * same exact permutation test, so both numbers can be read side by side and the
 * share of the effect that is free pass is stated rather than inferred.
 *
 * It imports src/artifacts.ts and does not modify it: M_r1 is in flight and
 * AM_r1 starts from the same orchestrator loop, so the two halves of that
 * paired comparison must run byte-identical runner code.
 */
import { connect } from '../src/db.ts';
import { extract_claims, type SymbolClaim } from '../src/artifacts.ts';
import { classify, is_result } from '../src/terminal.ts';

const MAX_EXACT = 2_000_000;
const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;

function n_choose_k(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/** Two-sided permutation on the difference of means. Exact when the split
 *  count is tractable, seeded Monte Carlo otherwise - and it reports which. */
function permutation(a: number[], b: number[]): { diff: number; p: number; splits: number; exact: boolean } {
  const pooled = [...a, ...b];
  const n = pooled.length;
  const k = a.length;
  const total = pooled.reduce((s, v) => s + v, 0);
  const obs = mean(b) - mean(a);
  const at_least = Math.abs(obs) - 1e-9;
  let splits = 0;
  let extreme = 0;

  if (n_choose_k(n, k) <= MAX_EXACT) {
    const walk = (start: number, depth: number, sum: number) => {
      if (depth === k) {
        splits++;
        if (Math.abs((total - sum) / (n - k) - sum / k) >= at_least) extreme++;
        return;
      }
      for (let i = start; i <= n - (k - depth); i++) walk(i + 1, depth + 1, sum + pooled[i]!);
    };
    walk(0, 0, 0);
    return { diff: obs, p: extreme / splits, splits, exact: true };
  }

  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const shuf = [...pooled];
  for (let it = 0; it < 200_000; it++) {
    for (let i = shuf.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = shuf[i]!;
      shuf[i] = shuf[j]!;
      shuf[j] = t;
    }
    const sum = shuf.slice(0, k).reduce((s, v) => s + v, 0);
    splits++;
    if (Math.abs((total - sum) / (n - k) - sum / k) >= at_least) extreme++;
  }
  return { diff: obs, p: extreme / splits, splits, exact: false };
}

async function claims_for(sql: any, run_id: string): Promise<SymbolClaim[]> {
  const decisions = await sql`
    select d.text, d.task_id,
           coalesce((select min(turn) from steps s where s.run_id = d.run_id
                     and s.kind = 'tool_call' and s.payload->>'name' = 'decide'
                     and s.payload->'args'->>'text' = d.text), 0) as turn
    from decisions d where d.run_id = ${run_id} order by d.seq asc`;
  const results = await sql`
    select result, id from tasks where run_id = ${run_id} and result is not null`;
  const out: SymbolClaim[] = [];
  for (const d of decisions) out.push(...extract_claims(d.text, d.task_id, d.turn, run_id));
  for (const r of results) out.push(...extract_claims(JSON.stringify(r.result), r.id, 9999, run_id));
  return out;
}

const sql = connect();
const runs = await sql<{ id: string; arm: string; model: string; task_set: string }[]>`
  select id, arm, model, task_set from runs
  where id ~ '^[A-Z]+_[a-z][0-9]+$' order by task_set, model, arm, id`;

const states = new Map((await classify(sql)).map((c: any) => [c.run_id, c]));
const usable = runs.filter((r) => {
  const st = states.get(r.id);
  return st && is_result(st.terminal) && st.terminal !== 'running';
});
const dropped = runs.length - usable.length;

console.log('grounded output: as published vs attributed only');
console.log(`  ${usable.length} usable cells; ${dropped} held out as non-results (same rule as power.ts)`);
console.log('');

const cells = new Map<string, typeof usable>();
for (const r of usable) {
  const key = `${r.task_set} ${r.model}`;
  let bucket = cells.get(key);
  if (!bucket) {
    bucket = [];
    cells.set(key, bucket);
  }
  bucket.push(r);
}

for (const [key, rows] of [...cells].sort()) {
  const [task_set, model] = key.split(' ');
  const arms = new Set(rows.map((r) => r.arm));
  if (!arms.has('A') || !arms.has('B')) continue;

  const per: Record<string, { all: number[]; attr: number[]; cited: number[]; hall: number[]; hall_rate: number[] }> = {};
  for (const r of rows) {
    if (r.arm !== 'A' && r.arm !== 'B') continue;
    const cl = await claims_for(sql, r.id);
    const g = cl.filter((c) => c.verdict === 'grounded');
    let bucket = per[r.arm];
    if (!bucket) {
      bucket = { all: [], attr: [], cited: [], hall: [], hall_rate: [] };
      per[r.arm] = bucket;
    }
    bucket.all.push(g.length);
    bucket.attr.push(g.filter((c) => c.file !== null).length);
    bucket.cited.push(cl.length ? cl.filter((c) => c.file !== null).length / cl.length : 0);
    // Hallucinated: called as foo() and exported by nothing in this run. The
    // study reports grounded output and never this, so an arm could buy its
    // extra grounded claims with extra fabricated ones and the headline would
    // not show it. Reported as a rate as well as a count, because B makes more
    // claims overall and a raw count would just track volume.
    bucket.hall.push(cl.filter((c) => c.verdict === 'hallucinated').length);
    bucket.hall_rate.push(cl.length ? cl.filter((c) => c.verdict === 'hallucinated').length / cl.length : 0);
  }
  const A = per['A'];
  const B = per['B'];
  if (!A || !B || A.all.length < 2 || B.all.length < 2) continue;

  const pub = permutation(A.all, B.all);
  const att = permutation(A.attr, B.attr);
  const free = pub.diff === 0 ? 0 : 1 - att.diff / pub.diff;
  const how = (r: { exact: boolean; splits: number }) =>
    `${r.splits.toLocaleString()} ${r.exact ? 'exact splits' : 'sampled'}`;

  console.log(`${task_set} / ${model}   n(A)=${A.all.length} n(B)=${B.all.length}`);
  console.log(
    `  as published      A ${mean(A.all).toFixed(1).padStart(7)}  B ${mean(B.all).toFixed(1).padStart(7)}` +
      `  diff ${pub.diff >= 0 ? '+' : ''}${pub.diff.toFixed(1)}  p=${pub.p.toFixed(4)}  (${how(pub)})`,
  );
  console.log(
    `  attributed only   A ${mean(A.attr).toFixed(1).padStart(7)}  B ${mean(B.attr).toFixed(1).padStart(7)}` +
      `  diff ${att.diff >= 0 ? '+' : ''}${att.diff.toFixed(1)}  p=${att.p.toFixed(4)}  (${how(att)})`,
  );
  console.log(`  free pass         ${(free * 100).toFixed(0)}% of the published effect came from claims naming no file`);
  console.log(`  citation rate     A ${(mean(A.cited) * 100).toFixed(0)}%  B ${(mean(B.cited) * 100).toFixed(0)}%`);
  const hp = permutation(A.hall, B.hall);
  const hr = permutation(A.hall_rate, B.hall_rate);
  console.log(`  hallucinated      A ${mean(A.hall).toFixed(1)}  B ${mean(B.hall).toFixed(1)}`
    + `  diff ${hp.diff >= 0 ? '+' : ''}${hp.diff.toFixed(1)}  p=${hp.p.toFixed(4)}`);
  console.log(`  hallucinated rate A ${(mean(A.hall_rate) * 100).toFixed(1)}%  B ${(mean(B.hall_rate) * 100).toFixed(1)}%`
    + `  diff ${hr.diff >= 0 ? '+' : ''}${(hr.diff * 100).toFixed(1)}pp  p=${hr.p.toFixed(4)}`);
  console.log('');
}

await sql.end();
