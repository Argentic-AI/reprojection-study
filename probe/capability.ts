/** Settle two unknowns the loop would otherwise be built on faith: thinking control, and tool calling. */
import { call_model, model_config } from '../src/model.ts';
import type { Msg } from '../src/assemble.ts';

console.log('config:', JSON.stringify(model_config));
const msgs: Msg[] = [
  { role: 'system', content: 'You are an agent. Act only by calling tools.' },
  { role: 'user', content: 'Create a subtask titled exactly "size_the_tank" to work out tank capacity, then stop.' },
];

for (const thinking of ['disabled', 'enabled']) {
  process.env.ZAI_THINKING = thinking;
  const m = await import(`../src/model.ts?t=${thinking}`);
  try {
    const r = await m.call_model(msgs, { max_tokens: 512 });
    console.log(`\nthinking=${thinking}`);
    console.log(`  finish_reason : ${r.finish_reason}`);
    console.log(`  tool_calls    : ${r.tool_calls.length} ${JSON.stringify(r.tool_calls.map((t: any) => ({ n: t.name, a: t.args })))}`);
    console.log(`  tokens out    : ${r.usage.tokens_out}  reasoning=${r.usage.reasoning_tokens}`);
    console.log(`  text          : ${JSON.stringify(r.text.slice(0, 80))}`);
    console.log(`  retries       : ${r.retries}`);
  } catch (e: any) {
    console.log(`\nthinking=${thinking}  ERROR ${String(e?.message).slice(0, 200)}`);
  }
}
