/**
 * Can the model call `write`? The site task set is worthless without it.
 *
 * toolChoice "required" constrains generation to the DECLARED tools, so a tool
 * present only in the prefix text is unreachable. That silently produced 65
 * spawns, 59 decides and zero writes.
 */
import { call_model } from '../src/model.ts';
import { prefix_for } from '../src/prompt.ts';
import { surface_for } from '../src/tools.ts';
import type { Msg } from '../src/assemble.ts';

const surface = surface_for('A');
console.log(`provider ${process.env.LLM_PROVIDER}  model ${process.env.LLM_MODEL}`);
console.log(`bound surface: ${surface.join(', ')}\n`);
const r = await call_model([
  { role: 'system', content: prefix_for(surface) },
  { role: 'user', content: '## Current task\n\n{\n  "title": "Write tokens.ts",\n  "detail": "Write tokens.ts, exporting a tokens object with colour and spacing values. Use the write tool now.",\n  "acceptance": "tokens.ts exists in the workspace."\n}' },
] as Msg[], { max_tokens: 16384, surface });
console.log(`finish=${r.finish_reason}  out=${r.usage.tokens_out}  calls=${r.tool_calls.length}`);
for (const t of r.tool_calls) console.log(`  -> ${t.name} ${JSON.stringify(t.args).slice(0, 90)}`);
const ok = r.tool_calls.some((t) => t.name === 'write');
console.log(ok ? '\nPASS — write is reachable' : '\nFAIL — write is still unreachable; the site study cannot produce artifacts');
process.exit(ok ? 0 : 1);
