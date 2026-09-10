/**
 * Throttle report: correlates heartbeat latency with run progress.
 *
 * The heartbeat carries no meaningful prefill, so if its latency inflates the
 * cause is the provider's queue, not our growing prompts. Run calls DO carry
 * growing prompts, so comparing the two separates "the provider slowed down"
 * from "we asked for more work".
 */
import { connect } from './db.ts';

const sql = connect();
const pct = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const v = xs.slice().sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(q * v.length))]!;
};

const hb = await sql<{ ts: string; latency_ms: number; status: number; note: string | null }[]>`
  select ts::text, latency_ms, status, note from heartbeats order by ts asc`;

if (!hb.length) { console.log('no heartbeats recorded'); await sql.end(); process.exit(0); }

const t_start = Date.parse(hb[0]!.ts);
const ok = hb.filter((h) => h.status === 200);
const bad = hb.filter((h) => h.status !== 200);

console.log('='.repeat(72));
console.log('HEARTBEAT  (1-token request: pure queue latency, no prefill)');
console.log('='.repeat(72));
console.log(`  samples=${hb.length}  ok=${ok.length}  non-200=${bad.length}`);
const L = ok.map((h) => h.latency_ms);
console.log(`  min=${pct(L, 0)}ms  p50=${pct(L, 0.5)}ms  p90=${pct(L, 0.9)}ms  p99=${pct(L, 0.99)}ms  max=${Math.max(0, ...L)}ms`);

// Five-minute buckets: where does it inflate?
console.log('\n  minute   n   p50      p90      max     non-200');
const BUCKET = 5 * 60_000;
type HbRow = { ts: string; latency_ms: number; status: number; note: string | null };
const buckets = new Map<number, HbRow[]>();
for (const h of hb) {
  const b = Math.floor((Date.parse(h.ts) - t_start) / BUCKET);
  if (!buckets.has(b)) buckets.set(b, []);
  buckets.get(b)!.push(h);
}
const baseline = pct(ok.slice(0, Math.max(3, Math.floor(ok.length * 0.15))).map((h) => h.latency_ms), 0.5);
for (const [b, rows] of [...buckets].sort((a, b) => a[0] - b[0])) {
  const good = rows.filter((r) => r.status === 200).map((r) => r.latency_ms);
  const p50 = pct(good, 0.5);
  const flag = p50 > baseline * 1.5 ? `  <-- ${(p50 / Math.max(1, baseline)).toFixed(1)}x baseline` : '';
  console.log(`  ${String(b * 5).padStart(6)}  ${String(rows.length).padStart(3)}  ${String(p50).padStart(6)}  `
    + `${String(pct(good, 0.9)).padStart(6)}  ${String(Math.max(0, ...good)).padStart(6)}  `
    + `${String(rows.filter((r) => r.status !== 200).length).padStart(7)}${flag}`);
}
console.log(`\n  baseline p50 (first 15% of samples): ${baseline}ms`);

if (bad.length) {
  console.log('\n  non-200 responses:');
  for (const b of bad.slice(0, 12)) {
    console.log(`    +${Math.round((Date.parse(b.ts) - t_start) / 1000)}s  status=${b.status}  ${b.note ?? ''}`);
  }
}

// Run calls over the same window, for contrast.
const runs = await sql<{ ts: string; latency_ms: number; tokens_in: number; retries: number }[]>`
  select created_at::text as ts, latency_ms, tokens_in, retries from steps
  where kind = 'model_call' and latency_ms is not null
    and created_at >= ${hb[0]!.ts}::timestamptz
  order by created_at asc`;

if (runs.length) {
  console.log(`\n${'='.repeat(72)}`);
  console.log('RUN CALLS over the same window  (carry growing prompts)');
  console.log('='.repeat(72));
  const R = runs.map((r) => r.latency_ms);
  console.log(`  n=${runs.length}  p50=${pct(R, 0.5)}ms  p90=${pct(R, 0.9)}ms  max=${Math.max(...R)}ms  retries=${runs.reduce((n, r) => n + r.retries, 0)}`);
  const early = runs.slice(0, Math.max(3, Math.floor(runs.length / 4)));
  const late = runs.slice(-Math.max(3, Math.floor(runs.length / 4)));
  const e50 = pct(early.map((r) => r.latency_ms), 0.5), l50 = pct(late.map((r) => r.latency_ms), 0.5);
  const ein = Math.round(early.reduce((n, r) => n + r.tokens_in, 0) / early.length);
  const lin = Math.round(late.reduce((n, r) => n + r.tokens_in, 0) / late.length);
  console.log(`  early: p50=${e50}ms  mean_prompt=${ein} tokens`);
  console.log(`  late : p50=${l50}ms  mean_prompt=${lin} tokens`);
  console.log(`  run-call slowdown ${(l50 / Math.max(1, e50)).toFixed(2)}x while prompts grew ${(lin / Math.max(1, ein)).toFixed(2)}x`);
  console.log('\n  ATTRIBUTION: heartbeat has no prefill, so its drift is pure throttling.');
  console.log('  Any run-call slowdown beyond the heartbeat drift is our own prompt growth.');
}
await sql.end();
