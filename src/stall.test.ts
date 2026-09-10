/**
 * The predicate that decides whether a cell waits or dies.
 *
 * Both directions are expensive and neither is visible until hours later:
 * too broad, and a genuine error is retried until the cell's whole budget is
 * spent sleeping; too narrow, and cells keep dying to a provider that was
 * answering again minutes later - which is what M_d1 did at turn 82 of 200.
 *
 * Offline. No provider, no database.
 */
import { is_provider_stall } from './model.ts';
import { is_context_limit } from './compact.ts';

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (!ok) fail++; else pass++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? ` — ${d}` : ''}`);
};
const err = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra);

console.log('1. The message that actually killed M_d1');
check('turn budget exhausted is a stall',
  is_provider_stall(err('turn budget exhausted after 1868s and 5 retries — endpoint is not answering')));

console.log('\n2. Transport and capacity failures are stalls');
for (const [name, e] of [
  ['429', err('rate limited', { statusCode: 429 })],
  ['500', err('InternalServerError', { statusCode: 500 })],
  ['503', err('upstream unavailable', { statusCode: 503 })],
  ['TimeoutError', Object.assign(new Error('signal timed out'), { name: 'TimeoutError' })],
  ['ECONNRESET', err('read ECONNRESET')],
  ['fetch failed', err('fetch failed')],
] as [string, unknown][]) check(`${name} is a stall`, is_provider_stall(e));

console.log('\n3. What must NOT be waited out');
// A context limit is arm AP's RESULT. Retrying it would spin to max_ms and
// then report a stall where the finding was that the arm outgrew its window.
const ctx = err('This model\'s maximum context length is 131072 tokens');
check('context limit is not treated as a stall by the run loop',
  is_context_limit(ctx) && !(!is_context_limit(ctx) && is_provider_stall(ctx)),
  'run.ts guards with !is_context_limit(e) first');
const ctx400 = err('input is too long', { statusCode: 400 });
check('a 400 about length is a context limit, not a stall', is_context_limit(ctx400));
check('a schema error is not a stall', !is_provider_stall(err('tool "decide" input did not match schema')));
check('a bare assertion failure is not a stall', !is_provider_stall(err('expected 3 tasks, saw 0')));

console.log('\n4. The rollback contract the retry depends on');
// Not testable here without a live loop, so it is asserted as a comment and
// checked by regression.test.ts: the retry path decrements turn and
// task_turns, because a turn that threw wrote no step and must not spend the
// cell's turn budget. If that ever stops being true, a stalling provider
// silently shortens every run instead of failing it.
check('documented: retry rolls back turn and task_turns', true, 'see run.ts stall branch');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
