/**
 * STEP ZERO — prove the endpoint reports prompt-cache hits before anything is built.
 *
 *   call 1  cold prefix                  -> baseline cached_tokens
 *   call 2  byte-identical to call 1     -> cached_tokens must RISE
 *   call 3  one char changed near start  -> cached_tokens must DROP to 0
 *
 * Every call is made twice over: once as a raw fetch (ground truth, complete
 * JSON body printed verbatim) and once through the Vercel AI SDK
 * (`@ai-sdk/openai-compatible`) so we can see exactly what the SDK's
 * normalised `usage` drops on the floor and what survives in
 * `providerMetadata`. Arm A/B accounting depends on that answer.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { filler } from './prefix.ts';

const API_KEY = process.env.ZAI_API_KEY;
const BASE_URL = (process.env.ZAI_BASE_URL ?? 'https://api.z.ai/api/paas/v4').replace(/\/+$/, '');
const MODEL = process.argv[2] ?? process.env.ZAI_MODEL ?? 'glm-4.7-flash';
const SETTLE_MS = Number(process.env.PROBE_SETTLE_MS ?? 3000);
const RETRIES = Number(process.env.PROBE_CACHE_RETRIES ?? 3);

if (!API_KEY) {
  console.error('ZAI_API_KEY is not set. Put it in .env (see .env.example) and re-run.');
  process.exit(2);
}

/** ~4k tokens of stable prose. Well above any plausible min-cacheable-prefix. */
const SYSTEM_SDK_BASE = [
  'You are a measurement fixture. Answer with a single word and nothing else.',
  '',
  'Reference material (ignore it, it exists only to make this prompt long):',
  filler(220, 0xa11ce),
].join('\n');

const SYSTEM_BASE = [
  'You are a measurement fixture. Answer with a single word and nothing else.',
  '',
  'Reference material (ignore it, it exists only to make this prompt long):',
  filler(220),
].join('\n');

/** Flip one character near the very start, so no cacheable prefix survives. */
function perturb(s: string): string {
  return `${s.slice(0, 4)}${s[4] === 'X' ? 'Y' : 'X'}${s.slice(5)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Msg = { role: 'system' | 'user'; content: string };
const body_for = (system: string): { messages: Msg[] } => ({
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: 'Reply with the single word: acknowledged' },
  ],
});


/** Pull cached-prompt-token count out of whatever shape the provider used. */
function cached_of(usage: unknown): number | undefined {
  const u = usage as Record<string, any> | undefined;
  if (!u) return undefined;
  const candidates = [
    u.prompt_tokens_details?.cached_tokens,
    u.prompt_tokens_details?.cached_prompt_tokens,
    u.cached_tokens,
    u.prompt_cache_hit_tokens,
    u.input_tokens_details?.cached_tokens,
    u.cachedInputTokens,          // AI SDK v5 normalised name
    u.cached_input_tokens,
  ];
  return candidates.find((v) => typeof v === 'number');
}

// ---------------------------------------------------------------- raw fetch

/** Free-tier throttling (1302/1305) is routine; only 1113 (no balance) is fatal. */
async function post_with_retry(payload: unknown, label: string, max_attempts = 7) {
  for (let attempt = 1; attempt <= max_attempts; attempt++) {
    const t0 = performance.now();
    let res: Response, text: string;
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120_000),
      });
      text = await res.text();
    } catch (e: any) {
      // Connect timeouts and socket resets are routine against this host.
      if (attempt === max_attempts) throw e;
      const wait = Math.min(45_000, 3_000 * 2 ** (attempt - 1));
      console.log(`  [${label}] network error ${e?.cause?.code ?? e?.name ?? ''} — backoff ${wait}ms (attempt ${attempt}/${max_attempts})`);
      await sleep(wait);
      continue;
    }
    const latency_ms = Math.round(performance.now() - t0);
    if (res.status !== 429) return { res, text, latency_ms };

    let code: string | undefined;
    try { code = JSON.parse(text)?.error?.code; } catch { /* non-json 429 */ }
    if (code === '1113') throw new Error(`${label}: no balance for this model (1113). ${text}`);
    if (attempt === max_attempts) return { res, text, latency_ms };
    const wait = Math.min(45_000, 3_000 * 2 ** (attempt - 1));
    console.log(`  [${label}] 429 code=${code ?? '?'} — backoff ${wait}ms (attempt ${attempt}/${max_attempts})`);
    await sleep(wait);
  }
  throw new Error('unreachable');
}

async function raw_call(label: string, system: string) {
  const payload = {
    model: MODEL,
    ...body_for(system),
    temperature: 0,
    max_tokens: 16,
    stream: false,
  };
  const { res, text, latency_ms } = await post_with_retry(payload, label);

  console.log(`\n${'='.repeat(78)}\nRAW ${label}  —  HTTP ${res.status} ${res.statusText}  (${latency_ms} ms)\n${'='.repeat(78)}`);
  console.log('-- response headers --');
  console.log(JSON.stringify(Object.fromEntries(res.headers), null, 2));

  let json: any;
  try { json = JSON.parse(text); } catch { json = undefined; }

  console.log('-- complete raw response body --');
  console.log(json ? JSON.stringify(json, null, 2) : text);

  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} — ${text.slice(0, 400)}`);

  const cached = cached_of(json?.usage);
  console.log(`-- extracted: prompt_tokens=${json?.usage?.prompt_tokens} completion_tokens=${json?.usage?.completion_tokens} cached_tokens=${cached ?? '(absent)'}`);
  return { json, cached, latency_ms };
}

// ------------------------------------------------------------------ AI SDK

const zai = createOpenAICompatible({
  name: 'zai',
  baseURL: BASE_URL,
  apiKey: API_KEY,
  includeUsage: true,
});

async function sdk_call(label: string, system: string) {
  const { messages } = body_for(system);
  const t0 = performance.now();
  const r = await generateText({
    model: zai.chatModel(MODEL),
    system: messages[0]!.content,
    prompt: messages[1]!.content,
    temperature: 0,
    maxOutputTokens: 16,
    maxRetries: 6,
  });
  const latency_ms = Math.round(performance.now() - t0);

  console.log(`\n${'-'.repeat(78)}\nSDK ${label}  (${latency_ms} ms)\n${'-'.repeat(78)}`);
  console.log('-- sdk normalised usage --');
  console.log(JSON.stringify(r.usage, null, 2));
  console.log('-- providerMetadata --');
  console.log(JSON.stringify(r.providerMetadata ?? null, null, 2));
  console.log('-- response.body (raw, as the sdk received it) --');
  console.log(JSON.stringify((r.response as any)?.body ?? null, null, 2));

  const from_sdk_usage = cached_of(r.usage);
  const pm: any = r.providerMetadata ?? {};
  const from_pm = cached_of(pm.zai?.usage ?? pm.zai ?? pm.openaiCompatible?.usage ?? pm.openaiCompatible);
  const from_body = cached_of((r.response as any)?.body?.usage);
  const cached = from_sdk_usage ?? from_pm ?? from_body;
  console.log(`-- extracted: cached_tokens=${cached ?? '(absent)'}  [usage=${from_sdk_usage ?? '-'} providerMetadata=${from_pm ?? '-'} response.body=${from_body ?? '-'}]`);
  return { cached, latency_ms, text: r.text };
}

// -------------------------------------------------------------------- main

const results: Record<string, { raw?: number; sdk?: number }> = {};

console.log(`endpoint : ${BASE_URL}/chat/completions`);
console.log(`model    : ${MODEL}`);
console.log(`system prompt: ${SYSTEM_BASE.length} chars`);

// 1 — cold
const r1 = await raw_call('CALL 1 (cold)', SYSTEM_BASE);
const s1 = await sdk_call('CALL 1 (cold)', SYSTEM_SDK_BASE);
results.call1 = { raw: r1.cached, sdk: s1.cached };

// 2 — byte-identical repeat; retry a few times, caches can settle asynchronously
let r2 = { cached: undefined as number | undefined };
for (let attempt = 1; attempt <= RETRIES; attempt++) {
  await sleep(SETTLE_MS);
  r2 = await raw_call(`CALL 2 (identical, attempt ${attempt}/${RETRIES})`, SYSTEM_BASE);
  if ((r2.cached ?? 0) > (r1.cached ?? 0)) break;
  console.log(`   cached_tokens has not risen yet (${r2.cached ?? '(absent)'}); retrying.`);
}
await sleep(SETTLE_MS);
const s2 = await sdk_call('CALL 2 (identical)', SYSTEM_SDK_BASE);
results.call2 = { raw: r2.cached, sdk: s2.cached };

// 3 — one character changed near the start
const PERTURBED = perturb(SYSTEM_BASE);
console.log(`\nperturbation: byte 4 of the system prompt, ${JSON.stringify(SYSTEM_BASE.slice(0, 12))} -> ${JSON.stringify(PERTURBED.slice(0, 12))}`);
const r3 = await raw_call('CALL 3 (one char changed near start)', PERTURBED);
const s3 = await sdk_call('CALL 3 (one char changed near start)', perturb(SYSTEM_SDK_BASE));
results.call3 = { raw: r3.cached, sdk: s3.cached };

// ------------------------------------------------------------------ verdict

console.log(`\n${'#'.repeat(78)}\nSTEP ZERO SUMMARY\n${'#'.repeat(78)}`);
console.table({
  'call 1 — cold': { raw_cached_tokens: results.call1.raw ?? 'absent', sdk_cached_tokens: results.call1.sdk ?? 'absent' },
  'call 2 — identical': { raw_cached_tokens: results.call2.raw ?? 'absent', sdk_cached_tokens: results.call2.sdk ?? 'absent' },
  'call 3 — 1 char changed': { raw_cached_tokens: results.call3.raw ?? 'absent', sdk_cached_tokens: results.call3.sdk ?? 'absent' },
});

const appeared = [results.call1, results.call2, results.call3].some((r) => typeof r.raw === 'number');
const rose = (results.call2.raw ?? 0) > (results.call1.raw ?? 0);
const c2 = results.call2.raw ?? 0;
const dropped = (results.call3.raw ?? 0) <= Math.max(16, c2 * 0.02);

console.log(`cached_tokens field present     : ${appeared}`);
console.log(`rose on identical repeat        : ${rose}`);
console.log(`collapsed after 1-char edit  : ${dropped}  (${results.call3.raw ?? "absent"} vs ${c2}; residual = tokens before the edit point, so ~0 not exactly 0)`);

if (!appeared || !rose) {
  console.log('\nVERDICT: FAIL — the endpoint does not report a moving prompt cache. Stop here.');
  process.exit(1);
}
console.log(`\nVERDICT: ${dropped ? 'PASS' : 'PARTIAL'} — cache is ${dropped ? 'observable and prefix-sensitive' : 'observable but did not fully invalidate; inspect above'}.`);
