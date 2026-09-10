/**
 * Sustained-load profiler.
 *
 * Answers two questions at once:
 *
 *  1. THROTTLE SHAPE — how latency degrades under sustained load, and what
 *     happens after a rate limit is hit. Reports latency over time in buckets,
 *     percentiles before vs after the first limit, and recovery behaviour.
 *
 *  2. CACHE DETERMINISM — every request sends a byte-identical prompt, so a
 *     well-behaved prefix cache should hit on every call after the first.
 *     Any miss on an identical request is cache non-determinism, which would
 *     silently corrupt the experiment's cost metric: `uncached input tokens`
 *     would measure a cache lottery rather than context strategy.
 *
 * Sequential by default, because the experiment itself is sequential and that
 * is the load pattern worth characterising. CONCURRENCY>1 profiles burst
 * behaviour instead.
 */

import { filler } from './prefix.ts';

const BASE = (process.env.LOAD_BASE_URL ?? process.env.SC_BASE_URL ?? '').replace(/\/+$/, '');
const KEY = process.env.LOAD_API_KEY ?? process.env.SC_API_KEY ?? '';
const MODEL = process.env.LOAD_MODEL ?? process.env.SC_MODEL ?? 'standardcompute';
const N = Number(process.env.LOAD_N ?? 40);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 1);
const PACE_MS = Number(process.env.LOAD_PACE_MS ?? 0);
const OUT_TOKENS = Number(process.env.LOAD_OUT_TOKENS ?? 16);

if (!BASE || !KEY) { console.error('set SC_BASE_URL and SC_API_KEY'); process.exit(2); }

/** Byte-identical on every request: any cache miss after the first is the provider's. */
const SYSTEM = `You are a measurement fixture. Answer with exactly one word.\n\n${filler(220, 0xf00d)}`;
const ASK = 'Reply with the single word: acknowledged';

type Sample = {
  i: number; t_offset_ms: number; latency_ms: number; status: number;
  prompt_tokens: number; cached: number; cache_write: number;
  limited: boolean; error?: string;
  retry_after?: string; rl_remaining?: string; rl_reset?: string;
};

const samples: Sample[] = [];
const t0 = performance.now();

async function one(i: number): Promise<Sample> {
  const started = performance.now();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL, temperature: 0, max_tokens: OUT_TOKENS,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: ASK }],
      }),
      signal: AbortSignal.timeout(300_000),
    });
    const text = await res.text();
    const latency_ms = Math.round(performance.now() - started);
    let j: any; try { j = JSON.parse(text); } catch { /* non-json */ }
    const d = j?.usage?.prompt_tokens_details;
    return {
      i, t_offset_ms: Math.round(started - t0), latency_ms, status: res.status,
      prompt_tokens: j?.usage?.prompt_tokens ?? 0,
      cached: d?.cached_tokens ?? 0,
      cache_write: d?.cache_write_tokens ?? 0,
      limited: res.status === 429,
      error: res.ok ? undefined : String(j?.error?.message ?? text).slice(0, 120),
      // Whatever the provider tells us about its own limits.
      retry_after: res.headers.get('retry-after') ?? undefined,
      rl_remaining: res.headers.get('x-ratelimit-remaining-requests')
        ?? res.headers.get('x-ratelimit-remaining') ?? undefined,
      rl_reset: res.headers.get('x-ratelimit-reset-requests')
        ?? res.headers.get('x-ratelimit-reset') ?? undefined,
    };
  } catch (e: any) {
    return {
      i, t_offset_ms: Math.round(started - t0),
      latency_ms: Math.round(performance.now() - started),
      status: 0, prompt_tokens: 0, cached: 0, cache_write: 0, limited: false,
      error: String(e?.message).slice(0, 120),
    };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log(`endpoint    : ${BASE}`);
console.log(`model       : ${MODEL}`);
console.log(`requests    : ${N}   concurrency=${CONCURRENCY}   pace=${PACE_MS}ms   prompt≈${Math.round(SYSTEM.length / 4)} tokens`);
console.log(`every request is byte-identical, so every miss after #1 is the provider's\n`);
console.log('  #   t+s   latency  status  in     cached  write  note');

let next = 0;
async function worker() {
  while (true) {
    const i = next++;
    if (i >= N) return;
    if (PACE_MS) await sleep(PACE_MS);
    const s = await one(i);
    samples.push(s);
    const note = s.limited ? `429${s.retry_after ? ` retry-after=${s.retry_after}` : ''}`
      : s.error ? s.error.slice(0, 40)
      : s.cached > 0 ? 'cache HIT' : 'cache miss';
    console.log(
      `  ${String(s.i + 1).padStart(3)} ${String(Math.round(s.t_offset_ms / 1000)).padStart(5)} `
      + `${String(s.latency_ms).padStart(8)} ${String(s.status).padStart(7)} `
      + `${String(s.prompt_tokens).padStart(6)} ${String(s.cached).padStart(7)} ${String(s.cache_write).padStart(6)}  ${note}`,
    );
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// ---------------------------------------------------------------- analysis

samples.sort((a, b) => a.i - b.i);
const ok = samples.filter((s) => s.status === 200);
const pct = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const v = xs.slice().sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(q * v.length))]!;
};
const lat = ok.map((s) => s.latency_ms);

console.log(`\n${'='.repeat(74)}\nLATENCY\n${'='.repeat(74)}`);
console.log(`  ok=${ok.length}/${N}  429s=${samples.filter((s) => s.limited).length}  errors=${samples.filter((s) => s.status === 0).length}`);
if (lat.length) {
  console.log(`  min=${pct(lat, 0)}ms  p50=${pct(lat, 0.5)}ms  p90=${pct(lat, 0.9)}ms  p99=${pct(lat, 0.99)}ms  max=${Math.max(...lat)}ms`);
}

// Degradation: compare the first quarter of successful calls against the last.
if (ok.length >= 8) {
  const q = Math.max(2, Math.floor(ok.length / 4));
  const early = ok.slice(0, q).map((s) => s.latency_ms);
  const late = ok.slice(-q).map((s) => s.latency_ms);
  const e = pct(early, 0.5), l = pct(late, 0.5);
  console.log(`\n  first ${q} calls  p50=${e}ms`);
  console.log(`  last  ${q} calls  p50=${l}ms`);
  console.log(`  drift          ${(l / Math.max(1, e)).toFixed(2)}x  ${l > e * 1.3 ? '<-- DEGRADING under sustained load' : '(stable)'}`);
}

// Before vs after the first rate limit.
const firstLimit = samples.findIndex((s) => s.limited);
if (firstLimit >= 0) {
  const before = samples.slice(0, firstLimit).filter((s) => s.status === 200).map((s) => s.latency_ms);
  const after = samples.slice(firstLimit).filter((s) => s.status === 200).map((s) => s.latency_ms);
  console.log(`\n${'='.repeat(74)}\nAFTER THE FIRST RATE LIMIT (request #${firstLimit + 1}, t+${Math.round(samples[firstLimit]!.t_offset_ms / 1000)}s)\n${'='.repeat(74)}`);
  console.log(`  before: n=${before.length} p50=${pct(before, 0.5)}ms p90=${pct(before, 0.9)}ms`);
  console.log(`  after : n=${after.length} p50=${pct(after, 0.5)}ms p90=${pct(after, 0.9)}ms`);
  if (before.length && after.length) {
    console.log(`  post-limit slowdown: ${(pct(after, 0.5) / Math.max(1, pct(before, 0.5))).toFixed(2)}x`);
  }
} else {
  console.log(`\n  no rate limit hit in ${N} requests — raise LOAD_N or LOAD_CONCURRENCY to find the ceiling`);
}

console.log(`\n${'='.repeat(74)}\nCACHE DETERMINISM  (every request was byte-identical)\n${'='.repeat(74)}`);
const after_first = ok.slice(1);
const hits = after_first.filter((s) => s.cached > 0).length;
console.log(`  calls after the first : ${after_first.length}`);
console.log(`  cache HITS            : ${hits}`);
console.log(`  cache MISSES          : ${after_first.length - hits}`);
console.log(`  hit rate              : ${after_first.length ? ((hits / after_first.length) * 100).toFixed(0) : 0}%`);
console.log(`  cache_write reported  : ${samples.filter((s) => s.cache_write > 0).length} of ${samples.length} calls`);
const seq = ok.map((s) => (s.cached > 0 ? 'H' : '.')).join('');
console.log(`  sequence (H=hit .=miss): ${seq}`);
if (after_first.length && hits < after_first.length) {
  console.log('\n  NON-DETERMINISTIC: identical requests returned different cache outcomes.');
  console.log('  Uncached-token cost would partly measure this lottery, not context strategy.');
}

const { writeFile, mkdir } = await import('node:fs/promises');
await mkdir('out', { recursive: true });
await writeFile('out/load_profile.json', JSON.stringify({ base: BASE, model: MODEL, n: N, concurrency: CONCURRENCY, pace_ms: PACE_MS, samples }, null, 2));
console.log('\nraw samples: out/load_profile.json');
