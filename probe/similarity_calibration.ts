/**
 * Thresholds are backend-specific. TF-IDF cosine on short domain text sits
 * near 0 for unrelated pairs; embedding cosine sits high for ANY same-domain
 * text. Reusing one threshold for both would silently reclassify most pairs.
 *
 * Prints the pairwise distribution for both backends over real journalled
 * decisions, plus a handful of known-duplicate probes, so the threshold is
 * chosen from data rather than transplanted.
 */
import { connect } from '../src/db.ts';
import { similar_pairs } from '../src/similarity.ts';

const sql = connect();
const rows = await sql<{ text: string; task_id: string }[]>`
  select text, task_id from decisions
  where run_id in (select id from runs where id not like 'test_%')
  order by seq asc limit 40`;
await sql.end();

const texts = rows.map((r) => r.text);
console.log(`decisions sampled: ${texts.length}`);
if (texts.length < 4) { console.log('not enough decisions journalled yet'); process.exit(0); }

// Known-duplicate and known-unrelated probes, to anchor the scale.
const probes = [
  ['The tank will hold 10000 litres.', 'Storage capacity is set at 10,000 L.'],
  ['The tank will hold 10000 litres.', 'Labour is charged at 95 dollars per hour.'],
];

for (const backend of ['embeddings', 'lexical'] as const) {
  if (backend === 'lexical') { process.env.EMBEDDINGS_BASE_URL = ''; }
  const mod = await import(`../src/similarity.ts?b=${backend}`);
  const r = await mod.similar_pairs(texts, -1); // -1 => keep every pair
  const scores = r.pairs.map((p: any) => p.score).sort((a: number, b: number) => a - b);
  if (!scores.length) { console.log(`\n${backend}: no pairs`); continue; }
  const q = (f: number) => scores[Math.min(scores.length - 1, Math.floor(f * scores.length))]!.toFixed(3);
  console.log(`\n${r.backend.toUpperCase()}  n_pairs=${scores.length}`);
  console.log(`  min=${q(0)}  p25=${q(0.25)}  p50=${q(0.5)}  p75=${q(0.75)}  p90=${q(0.90)}  p95=${q(0.95)}  p99=${q(0.99)}  max=${scores.at(-1)!.toFixed(3)}`);
  for (const [a, b] of probes) {
    const pr = await mod.similar_pairs([a!, b!], -1);
    console.log(`  probe ${pr.pairs[0]?.score.toFixed(3) ?? 'n/a'}  ${JSON.stringify(a!.slice(0, 34))} vs ${JSON.stringify(b!.slice(0, 34))}`);
  }
}
