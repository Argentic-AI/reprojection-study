/**
 * Heartbeat prober.
 *
 * Fires the smallest possible request on a fixed interval and records its
 * latency. The prompt is a few tokens and the output is one token, so the
 * measurement is almost entirely QUEUE + round-trip — no meaningful prefill,
 * no meaningful generation.
 *
 * That separation is the point. When a quota starts biting, the run's own
 * calls get slower, but those calls carry thousands of prompt tokens, so it is
 * impossible to tell from them alone whether the provider is throttling the
 * queue or simply prefilling more slowly. The heartbeat has no prefill to
 * blame, so any inflation in it is throttling.
 *
 * Runs until stopped. Rows go to `heartbeats`, never to `steps` — a heartbeat
 * is not an agent turn and must not enter token accounting.
 */

import { connect } from '../src/db.ts';

const BASE = (process.env.LLM_BASE_URL ?? process.env.SC_BASE_URL ?? '').replace(/\/+$/, '');
const KEY = process.env.LLM_API_KEY ?? process.env.SC_API_KEY ?? '';
const MODEL = process.env.LLM_MODEL ?? process.env.SC_MODEL ?? 'standardcompute';
const PROVIDER = process.env.LLM_PROVIDER ?? 'sc';
const INTERVAL_MS = Number(process.env.HB_INTERVAL_MS ?? 15_000);
const MAX = Number(process.env.HB_MAX ?? 0); // 0 = until killed

if (!BASE || !KEY) { console.error('set LLM_BASE_URL and LLM_API_KEY'); process.exit(2); }

const sql = connect();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let n = 0, fails = 0;
let stop = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { stop = true; });

console.log(`heartbeat -> ${BASE}  model=${MODEL}  every ${INTERVAL_MS}ms`);
console.log('    #        latency  status  out  note');

while (!stop && (MAX === 0 || n < MAX)) {
  const t0 = performance.now();
  let status = 0, tokens_out: number | null = null, tokens_in: number | null = null;
  let cached: number | null = null, note = '';
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL, temperature: 0, max_tokens: 4,
        messages: [{ role: 'user', content: 'Reply with exactly: hello' }],
      }),
      signal: AbortSignal.timeout(300_000),
    });
    status = res.status;
    const text = await res.text();
    let j: any; try { j = JSON.parse(text); } catch { /* non-json */ }
    tokens_in = j?.usage?.prompt_tokens ?? null;
    tokens_out = j?.usage?.completion_tokens ?? null;
    cached = j?.usage?.prompt_tokens_details?.cached_tokens ?? null;
    if (!res.ok) {
      fails++;
      const ra = res.headers.get('retry-after');
      note = `${j?.error?.message ?? text}`.slice(0, 80) + (ra ? ` retry-after=${ra}` : '');
    }
  } catch (e: any) {
    fails++;
    note = String(e?.message).slice(0, 80);
  }
  const latency_ms = Math.round(performance.now() - t0);
  n++;

  await sql`insert into heartbeats (provider, model, latency_ms, status, tokens_in, tokens_out, cached, note)
            values (${PROVIDER}, ${MODEL}, ${latency_ms}, ${status}, ${tokens_in}, ${tokens_out}, ${cached}, ${note || null})`;
  console.log(`  ${String(n).padStart(3)} ${String(latency_ms).padStart(13)} ${String(status).padStart(7)} ${String(tokens_out ?? '-').padStart(4)}  ${note}`);

  if (stop) break;
  await sleep(INTERVAL_MS);
}

console.log(`\nheartbeats: ${n}, failures: ${fails}`);
await sql.end();
