/**
 * Step zero for a new provider, through the real code path.
 *
 * Raw curl proves the endpoint works; it does not prove the harness works. The
 * agent acts ONLY by calling tools, so the question that decides whether this
 * provider is usable is whether call_model() returns tool_calls — via the AI
 * SDK, with our actual Zod schemas, against a reasoning model that spends part
 * of its output budget thinking before it answers.
 */
import { call_model } from '../src/model.ts';
import { STABLE_PREFIX } from '../src/prompt.ts';
import type { Msg } from '../src/assemble.ts';

const msgs: Msg[] = [
  { role: 'system', content: STABLE_PREFIX },
  { role: 'user', content: '## Run goal\n\nBuild a small library.' },
  // The REAL build root task. A simple task passes at 2048; this one is what
  // sent the model into unbounded reasoning, so it is the one worth probing.
  { role: 'user', content: '## Current task\n\n' + JSON.stringify({
    title: 'Plan The Site',
    detail: 'Decide the palette, the type scale, the pricing structure, the product positioning and the exact function each module will export. Record those with decide so later work can rely on them, then spawn one subtask per module in dependency order.',
    acceptance: 'One subtask exists per module, and the palette, pricing structure and exported function names have been recorded with decide.',
  }, null, 2) },
];

console.log(`provider: ${process.env.LLM_PROVIDER}  model: ${process.env.LLM_MODEL}`);
const r = await call_model(msgs, { max_tokens: Number(process.env.PROBE_MAX_TOKENS ?? 2048) });
console.log(`  latency        ${r.latency_ms} ms   retries ${r.retries}   finish ${r.finish_reason}`);
console.log(`  tokens         in ${r.usage.tokens_in}  out ${r.usage.tokens_out}  cached ${r.usage.cached_tokens}  reasoning ${r.usage.reasoning_tokens}`);
console.log(`  text           ${JSON.stringify(r.text).slice(0, 90)}`);
console.log(`  tool_calls     ${r.tool_calls.length}`);
for (const t of r.tool_calls) console.log(`    -> ${t.name} ${JSON.stringify(t.args).slice(0, 120)}`);
console.log(r.tool_calls.length > 0 ? '\nPASS — the agent loop can drive this provider.' : '\nFAIL — no tool call; the loop would nudge then abandon every task.');
process.exit(r.tool_calls.length > 0 ? 0 : 1);
