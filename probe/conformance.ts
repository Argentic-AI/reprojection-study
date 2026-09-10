/**
 * Provider conformance: one check, run once, before a study.
 *
 * This replaces a scattering of separate gates. Every failure on the move from
 * Z.ai to Synthetic happened in a layer nothing was watching:
 *
 *   max_tokens 1024   a reasoning model spent the whole budget thinking and
 *                     returned finish_reason "length" with no tool call. The
 *                     loop reads a tool-less turn as stalled, nudges, then
 *                     abandons — so every cell dies on turn one while the run
 *                     looks healthy.
 *   toolChoice auto   the model stopped cleanly with EMPTY text and still
 *                     called nothing.
 *   cache reporting   varies per backend and silently removes a metric.
 *   determinism       exact replay on resume depends on it, and a rate-limited
 *                     endpoint means resume is the norm, not the exception.
 *
 * The arm signatures could not catch any of these: they hash rendered prompt
 * bytes, and all four live in the request or the response. An instrument was
 * built for one layer and the failures moved to the one underneath.
 *
 * These four assertions are what actually varies between providers. Each is a
 * property whose absence silently produces a plausible-looking but empty study,
 * which is the failure mode this whole project keeps rediscovering.
 */

import { call_model } from '../src/model.ts';
import { STABLE_PREFIX } from '../src/prompt.ts';
import { TASK_SETS } from '../src/taskset.ts';
import { stable_json } from '../src/canonical.ts';
import type { Msg } from '../src/assemble.ts';

const SET = (process.env.CONFORM_TASK_SET ?? 'site') as keyof typeof TASK_SETS;
const MAX = Number(process.env.MAX_OUTPUT_TOKENS ?? 16384);

let failed = 0;
const check = (name: string, ok: boolean, note = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${note ? ` — ${note}` : ''}`);
};
/** Not run, and not a failure. Printed so a skip is never silent. */
const skip = (name: string, why: string) => console.log(`  skip ${name} — ${why}`);

/**
 * Per-phase timing, printed AS EACH PHASE ENDS rather than in a summary.
 *
 * conform is run under `timeout 900`. A table assembled at the end is lost
 * exactly when the run is interesting, so each line is emitted immediately and
 * the summary is a convenience.
 *
 * wall vs latency separates the two failure modes the numbers have to tell
 * apart: `latency` is the provider's time for the attempt that succeeded, and
 * `wall` includes every retry call_model made underneath. A phase where wall
 * greatly exceeds latency got MORE CALLS; one where both grew together got
 * SLOWER CALLS.
 */
type Phase = { name: string; wall_ms: number; latency_ms: number; retries: number; out: number };
const phases: Phase[] = [];
const t_run = performance.now();
async function phase<T extends { latency_ms: number; retries: number; usage: { tokens_out: number } }>(
  name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const r = await fn();
  const wall = performance.now() - t0;
  phases.push({ name, wall_ms: wall, latency_ms: r.latency_ms, retries: r.retries, out: r.usage.tokens_out });
  const tps = r.latency_ms > 0 ? (r.usage.tokens_out / (r.latency_ms / 1000)).toFixed(1) : 'n/a';
  console.log(`   [timing] ${name}: wall=${(wall / 1000).toFixed(1)}s latency=${(r.latency_ms / 1000).toFixed(1)}s `
    + `retries=${r.retries} out=${r.usage.tokens_out} throughput=${tps} tok/s`);
  return r;
}

/**
 * The REAL prefix and the REAL hardest task in the set. A toy prompt passes
 * when the study would not: the build root needed 284 output tokens and the
 * site root needed 7,982, and only the second exposed the budget problem.
 */
const set = TASK_SETS[SET];
const msgs: Msg[] = [
  { role: 'system', content: STABLE_PREFIX },
  { role: 'user', content: `## Run goal\n\n${set.goal}` },
  { role: 'user', content: `## Current task\n\n${stable_json({ title: set.root.title, detail: set.root.detail, acceptance: set.root.acceptance })}` },
];

console.log(`provider ${process.env.LLM_PROVIDER}  model ${process.env.LLM_MODEL}`);
console.log(`task set "${SET}", max_output ${MAX}\n`);

console.log('1. The agent can act — the loop cannot run without this');
const a = await phase('1_agent_can_act', () => call_model(msgs, { max_tokens: MAX }));
console.log(`   finish=${a.finish_reason} out=${a.usage.tokens_out} calls=${a.tool_calls.length} latency=${(a.latency_ms / 1000).toFixed(0)}s`);
check('returns at least one tool call', a.tool_calls.length > 0,
  a.tool_calls.length === 0 ? 'every task would be nudged then abandoned' : '');
check('output budget is sufficient', a.finish_reason !== 'length',
  a.finish_reason === 'length' ? `truncated at ${MAX}; raise MAX_OUTPUT_TOKENS` : `used ${a.usage.tokens_out} of ${MAX}`);

/**
 * THE REPEAT. Cheap by default, because the expensive version bought nothing.
 *
 * This used to be a second FULL-BUDGET call, which is what put conform over its
 * 900s limit. Measured: three provider calls, zero retries, throughput flat at
 * 70-75 tok/s in every configuration, so wall time is just
 * `2 x max_tokens / throughput`. At 16384 that is ~440s and fits; at 32768 it
 * is ~886s and does not. Nothing got slower — the same two calls were allowed
 * to generate twice as many tokens.
 *
 * Phase 3 needs a REPEAT of the prefix to observe a cache hit, not a LARGE one,
 * so the repeat runs small and the determinism comparison becomes opt-in.
 *
 * Determinism gates exact replay on resume. No driver sets RESUME, and a cell
 * lost to a provider fault is re-run from scratch, so the study never exercises
 * it. Set CONFORM_DETERMINISM=1 to pay for it deliberately.
 */
const WANT_DETERMINISM = process.env.CONFORM_DETERMINISM === '1';
const REPEAT_MAX = WANT_DETERMINISM ? MAX : 512;
console.log(`\n2. Repeat request (max_tokens ${REPEAT_MAX})${WANT_DETERMINISM ? ' — determinism checked' : ''}`);
const b = await phase('2_repeat', () => call_model(msgs, { max_tokens: REPEAT_MAX }));
const names = (r: typeof a) => r.tool_calls.map((t) => t.name).join(',');
if (!WANT_DETERMINISM) {
  skip('same prompt gives the same tool sequence',
    'guards replay-on-resume, which no driver uses; set CONFORM_DETERMINISM=1 to check');
} else if (a.finish_reason === 'length' || b.finish_reason === 'length') {
  // Comparing two truncated responses compares two empty tool lists and calls
  // it agreement, or one empty against one partial and calls it disagreement.
  // Both readings are noise. Observed as "vs read" and " vs " in real runs.
  skip('same prompt gives the same tool sequence',
    `a response hit the ${MAX} ceiling; a comparison of truncated outputs is meaningless`);
} else {
  check('same prompt gives the same tool sequence', names(a) === names(b), `${names(a)} vs ${names(b)}`);
}

console.log('\n3. Prompt caching — reported, and moves with the prefix');
check('cache reported on the repeat', b.usage.cached_tokens > 0,
  b.usage.cached_tokens > 0 ? `${b.usage.cached_tokens}/${b.usage.tokens_in}` : 'absent: the cache column will read 0 all study');
const altered: Msg[] = [{ role: 'system', content: `X${STABLE_PREFIX}` }, ...msgs.slice(1)];
const c = await phase('3_caching', () => call_model(altered, { max_tokens: 64 }));
check('cache drops when the prefix changes', c.usage.cached_tokens < b.usage.cached_tokens,
  `${c.usage.cached_tokens} after a one-character change`);

const total = performance.now() - t_run;
console.log('\nPHASE                WALL      %TOTAL   LATENCY  RETRIES   OUT   TOK/S');
for (const ph of phases) {
  const pct = (ph.wall_ms / total) * 100;
  const tps = ph.latency_ms > 0 ? (ph.out / (ph.latency_ms / 1000)).toFixed(1) : 'n/a';
  console.log(
    `${ph.name.padEnd(20)} ${(ph.wall_ms / 1000).toFixed(1).padStart(7)}s ${pct.toFixed(1).padStart(7)}% `
    + `${(ph.latency_ms / 1000).toFixed(1).padStart(8)}s ${String(ph.retries).padStart(8)} `
    + `${String(ph.out).padStart(6)} ${tps.padStart(6)}`);
}
const measured = phases.reduce((n, ph) => n + ph.wall_ms, 0);
console.log(`${'TOTAL'.padEnd(20)} ${(total / 1000).toFixed(1).padStart(7)}s  (phases ${(measured / 1000).toFixed(1)}s, `
  + `overhead ${((total - measured) / 1000).toFixed(1)}s)`);
console.log(`PROVIDER CALLS: ${phases.length} + ${phases.reduce((n, ph) => n + ph.retries, 0)} retries`);

console.log(failed === 0
  ? '\nPASS — this provider can run a study.'
  : `\nFAIL: ${failed}. Fix before spending cells; each of these produces a study that looks fine and measures nothing.`);
process.exit(failed === 0 ? 0 : 1);
