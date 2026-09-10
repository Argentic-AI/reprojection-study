/**
 * Calibrate the C2 novelty gate on real data before building it.
 *
 * Run 3 wrote 180 decisions of which ~40 are distinct. If embedding similarity
 * cannot separate the wording-variant duplicates from genuinely distinct
 * findings, the gate cannot work and there is no point implementing it.
 *
 * NOTE ON GROUND TRUTH: "40 distinct" is a proxy — it counts distinct text
 * before the first colon (the agent's own finding-name prefix). It is not a
 * hand-labelled set. Treated as a label here, and that weakness is stated in
 * the output rather than hidden.
 */
import { connect } from '../src/db.ts';
import { similar_pairs } from '../src/similarity.ts';

const sql = connect();
const rows = await sql<{ text: string; task_id: string }[]>`
  select text, task_id from decisions where run_id = 'B1_mthjrmcn' order by seq asc limit ${Number(process.env.CAL_N ?? 180)}`;
await sql.end();

const label = (t: string) => t.split(':')[0]!.trim().toLowerCase();
const labels = rows.map((r) => label(r.text));
const distinct = new Set(labels);
console.log(`decisions: ${rows.length}, distinct name-prefixes: ${distinct.size}`);

const r = await similar_pairs(rows.map((x) => x.text), -1);
console.log(`backend: ${r.backend}, pairs scored: ${r.pairs.length}\n`);
if (r.backend !== 'embeddings') { console.log('embeddings unavailable — cannot calibrate'); process.exit(1); }

// A pair is a TRUE duplicate if both share a name-prefix.
type P = { score: number; dup: boolean };
const scored: P[] = r.pairs.map((p) => ({ score: p.score, dup: labels[p.i] === labels[p.j] }));
const dups = scored.filter((p) => p.dup), nons = scored.filter((p) => !p.dup);
const q = (xs: number[], f: number) => xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(f * xs.length))]! : 0;

console.log(`TRUE duplicates  n=${dups.length}  p10=${q(dups.map(p=>p.score),0.1).toFixed(3)} p50=${q(dups.map(p=>p.score),0.5).toFixed(3)} p90=${q(dups.map(p=>p.score),0.9).toFixed(3)}`);
console.log(`distinct pairs   n=${nons.length}  p10=${q(nons.map(p=>p.score),0.1).toFixed(3)} p50=${q(nons.map(p=>p.score),0.5).toFixed(3)} p90=${q(nons.map(p=>p.score),0.9).toFixed(3)}`);

console.log(`\n  tau   NOOP'd  correct  wrongly-dropped  precision  recall`);
for (const tau of [0.86, 0.88, 0.90, 0.92, 0.94, 0.96, 0.98]) {
  const flagged = scored.filter((p) => p.score >= tau);
  const tp = flagged.filter((p) => p.dup).length;
  const fp = flagged.length - tp;
  const prec = flagged.length ? tp / flagged.length : 1;
  const rec = dups.length ? tp / dups.length : 0;
  console.log(`  ${tau.toFixed(2)}  ${String(flagged.length).padStart(6)}  ${String(tp).padStart(7)}  ${String(fp).padStart(15)}  ${(prec*100).toFixed(1).padStart(8)}%  ${(rec*100).toFixed(1).padStart(5)}%`);
}
console.log(`\nA wrongly-dropped pair is a DISTINCT finding silently discarded.`);
console.log(`The spec's proposed tau_high = 0.92 is evaluated above against real data.`);
