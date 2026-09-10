/**
 * Why did the raw path cache but the SDK path not?
 *
 * The raw probe sends the system prompt as messages[0]; the SDK path hands it
 * to generateText's `system` option. On an Anthropic-backed provider, prompt
 * caching needs cache_control breakpoints, and a gateway may inject them for
 * one shape and not the other. If the SDK shape cannot cache, the experiment
 * cannot use the SDK here — so this is worth settling before any run.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { filler } from './prefix.ts';

const BASE = process.env.SC_BASE_URL!;
const KEY = process.env.SC_API_KEY!;
const MODEL = process.env.SC_MODEL ?? 'standardcompute';
const p = createOpenAICompatible({ name: 'sc', baseURL: BASE, apiKey: KEY, includeUsage: true });

const BIG = `You are a measurement fixture. Answer with one word.\n\n${filler(220, 0xbeef)}`;
const ASK = 'Reply with the single word: acknowledged';

const cached_of = (u: any) =>
  u?.cachedInputTokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0;

async function sdk(mode: 'system-option' | 'system-in-messages', label: string) {
  const args: any = {
    model: p.chatModel(MODEL), temperature: 0, maxOutputTokens: 8, maxRetries: 0,
  };
  if (mode === 'system-option') { args.system = BIG; args.messages = [{ role: 'user', content: ASK }]; }
  else { args.messages = [{ role: 'system', content: BIG }, { role: 'user', content: ASK }]; }
  const r = await generateText(args);
  const raw = (r.response as any)?.body?.usage;
  console.log(`  ${label.padEnd(26)} in=${String(raw?.prompt_tokens ?? '?').padStart(5)} `
    + `cached=${String(cached_of(raw)).padStart(5)} sdk.usage.cachedInputTokens=${r.usage?.cachedInputTokens ?? '-'} `
    + `cache_write=${raw?.prompt_tokens_details?.cache_write_tokens ?? '-'}`);
}

async function raw(label: string) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: 8,
      messages: [{ role: 'system', content: BIG }, { role: 'user', content: ASK }] }),
  });
  const j: any = await res.json();
  const u = j?.usage;
  console.log(`  ${label.padEnd(26)} in=${String(u?.prompt_tokens ?? '?').padStart(5)} `
    + `cached=${String(u?.prompt_tokens_details?.cached_tokens ?? 0).padStart(5)} `
    + `cache_write=${u?.prompt_tokens_details?.cache_write_tokens ?? '-'}`);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log('\nRAW fetch, system as messages[0] — the shape that cached earlier');
await raw('raw #1 (cold)'); await wait(4000); await raw('raw #2 (repeat)');

console.log('\nSDK, system passed via the `system` option (what model.ts does now)');
await sdk('system-option', 'sdk-system-opt #1'); await wait(4000); await sdk('system-option', 'sdk-system-opt #2');

console.log('\nSDK, system left inside the messages array');
await sdk('system-in-messages', 'sdk-in-messages #1'); await wait(4000); await sdk('system-in-messages', 'sdk-in-messages #2');
