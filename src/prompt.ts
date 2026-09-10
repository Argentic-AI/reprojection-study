/**
 * The stable prefix: system prompt + tool definitions.
 *
 * This is byte-identical on EVERY call of EVERY task in EVERY run of a given
 * arm. It is the region the provider's prefix cache is guaranteed to hit, and
 * the runner asserts its fingerprint never moves.
 *
 * Nothing run-specific, task-specific, or time-dependent may appear here.
 */

import { z } from 'zod';
import { TOOLS, BASE_TOOLS, tool_view, type ToolName } from './tools.ts';

/** Render a zod shape as stable descriptive text. Same schema -> same bytes. */
function render_schema(schema: z.ZodTypeAny, indent = 4): string {
  const pad = ' '.repeat(indent);
  const def: any = (schema as any)._def;
  const described = def?.description as string | undefined;

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const lines = Object.keys(shape) // sorted: key order must not depend on declaration order
      .sort()
      .map((k) => {
        const child = shape[k]!;
        const cdef: any = (child as any)._def;
        const optional = child.isOptional();
        const desc = cdef?.description ? ` — ${cdef.description}` : '';
        const inner = render_schema(child, indent + 2);
        return `${pad}${k}${optional ? '?' : ''}: ${inner}${desc}`;
      });
    return `{\n${lines.join('\n')}\n${' '.repeat(indent - 2)}}`;
  }
  if (schema instanceof z.ZodArray) return `${render_schema(schema.element, indent)}[]`;
  if (schema instanceof z.ZodOptional) return render_schema(schema.unwrap(), indent);
  if (schema instanceof z.ZodString) return 'string';
  if (schema instanceof z.ZodNumber) return 'number';
  if (schema instanceof z.ZodBoolean) return 'boolean';
  return described ?? 'unknown';
}

function render_tools(names: readonly ToolName[]): string {
  return names.map((name) => {
    // tool_view, not TOOLS[name]: a tool may describe itself differently to a
    // surface that can do different things with it. Still a pure function of the
    // tool set, so the prefix stays memoisable and pinnable.
    const t = tool_view(name, names);
    return `### ${name}\n${t.description}\n\nParameters:\n  ${render_schema(t.schema)}`;
  }).join('\n\n');
}

const SYSTEM_INSTRUCTIONS = `You are an agent working through a decomposed task tree.

You act only by calling tools. Do not write prose outside a tool call; any prose
you emit is discarded and the turn is wasted.

Operating rules:

1. You are always working on exactly one task, given below as the current task
   spec. Work on that task and nothing else.
2. Decompose with spawn when a task is too large to finish in a few turns.
   Children are queued and entered later, not immediately.
3. When you settle something that later work must respect, record it with
   decide. Anything not recorded with decide may not be visible to you later.
4. End every task with exactly one call to complete.
5. Live decisions and constraints are replayed to you in full on every turn,
   each with its id in parentheses. Treat them as binding.
6. When you learn that a recorded constraint or decision is no longer correct,
   call supersede with that item's id and the corrected text. Do not record a
   contradicting item with decide — the old one stays in force alongside it and
   both will be replayed to you.`;

/**
 * The prefix for a given action surface.
 *
 * Parameterised by TOOL SET only — never by run, task, or time. An arm that
 * offers a different set of tools is a different treatment and must say so in
 * its prefix; everything else that could vary still cannot. Results are
 * memoised so a given set always yields the identical string instance.
 */
const cache = new Map<string, string>();
export function prefix_for(names: readonly ToolName[]): string {
  const key = names.join(',');
  let p = cache.get(key);
  if (p === undefined) {
    p = [SYSTEM_INSTRUCTIONS, '', '## Tools', '', render_tools(names)].join('\n');
    cache.set(key, p);
  }
  return p;
}

/**
 * The default surface. Byte-identical to what every run before F4 sent — the
 * fingerprint is asserted against the recorded value in prompt.test.ts, because
 * a silent change here would invalidate every earlier run at once.
 */
export const STABLE_PREFIX: string = prefix_for(BASE_TOOLS);

Object.freeze(STABLE_PREFIX);
