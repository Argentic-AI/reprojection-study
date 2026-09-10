/**
 * Artifact reference integrity — the third failure mode.
 *
 * Redundant reads measure re-opening a file. Duplicate decisions measure
 * restating a conclusion. Neither sees this: the agent establishes something
 * while working — a symbol, a file it has characterised, a subtask it created —
 * and a LATER task has no idea it exists. It does not re-read the wrong thing;
 * it invents a second name for the same concept, or cites something that was
 * never there.
 *
 * Measured BEFORE choosing a mechanism, because whether this deserves its own
 * arm depends on whether both arms actually score badly.
 *
 * WHAT COUNTS AS AN ARTIFACT: subtask titles (via spawn), and symbol claims —
 * a code identifier attributed to a file, inside a decision or a task result.
 * On the `build` task set the symbols are ones the agent WROTE, resolved
 * through ground.ts against workspace/<run_id>/.
 *
 * Recognition is an allowlist (what the sources actually export), not a
 * denylist of prose words, and it no longer requires the agent to have written
 * literal `foo()`. The old pattern saw 42 of 85 symbol mentions and scored
 * cross-task reuse at 1 where it was really 3.
 */

import type { Sql } from './db.ts';
import { paths_in, symbols_in, unknown_calls, lines_of, defined_in } from './ground.ts';

export type SymbolClaim = {
  task_id: string;
  turn: number;
  symbol: string;
  file: string | null;
  /** grounded: the symbol exists, and sits where it was said to sit (or no
   *    location was claimed, so there is nothing to be wrong about).
   *  misattributed: it exists, but not in the file it was attributed to.
   *  hallucinated: called as `foo()` and exported by nothing in this run. */
  verdict: 'grounded' | 'misattributed' | 'hallucinated';
};

export function extract_claims(text: string, task_id: string, turn: number, run_id?: string | null): SymbolClaim[] {
  const file = paths_in(text)[0] ?? null;
  const body = file ? lines_of(file, run_id)?.join('\n') ?? null : null;
  const out: SymbolClaim[] = [];

  for (const symbol of symbols_in(text, run_id)) {
    const verdict: SymbolClaim['verdict'] =
      body === null ? 'grounded' : body.includes(symbol) ? 'grounded' : 'misattributed';
    out.push({ task_id, turn, symbol, file, verdict });
  }
  for (const symbol of unknown_calls(text, run_id)) {
    out.push({ task_id, turn, symbol, file, verdict: 'hallucinated' });
  }
  return out;
}

export type ArtifactReport = {
  claims: number;
  grounded: number;
  misattributed: number;
  hallucinated: number;
  /** Symbols first claimed in one task and claimed again in a LATER task. */
  carried_forward: number;
  /** Of those, how many were still grounded the second time. */
  carried_and_grounded: number;
  /** Subtask titles that near-duplicate an earlier subtask under a different parent. */
  duplicate_subtasks: number;
  subtasks: number;
};

/** Loose match so `audit_metric_correctness` and `audit_metric_claim` collide. */
const title_key = (t: string) =>
  t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w.length > 3).sort().join(' ');

export async function artifact_report(sql: Sql, run_id: string): Promise<ArtifactReport> {
  const decisions = await sql<{ text: string; task_id: string; turn: number }[]>`
    select d.text, d.task_id,
           coalesce((select min(turn) from steps s where s.run_id = d.run_id
                     and s.kind = 'tool_call' and s.payload->>'name' = 'decide'
                     and s.payload->'args'->>'text' = d.text), 0) as turn
    from decisions d where d.run_id = ${run_id} order by d.seq asc`;

  const results = await sql<{ result: any; id: string }[]>`
    select result, id from tasks where run_id = ${run_id} and result is not null`;

  const claims: SymbolClaim[] = [];
  for (const d of decisions) claims.push(...extract_claims(d.text, d.task_id, d.turn, run_id));
  for (const r of results) claims.push(...extract_claims(JSON.stringify(r.result), r.id, 9999, run_id));

  // Cross-task carry: a symbol claimed in one task and claimed again in another.
  const first_task = new Map<string, string>();
  let carried = 0, carried_grounded = 0;
  for (const c of claims) {
    const seen = first_task.get(c.symbol);
    if (seen === undefined) { first_task.set(c.symbol, c.task_id); continue; }
    if (seen !== c.task_id) {
      carried++;
      if (c.verdict === 'grounded') carried_grounded++;
    }
  }

  const spawns = await sql<{ payload: any }[]>`
    select payload from steps where run_id = ${run_id}
      and kind = 'tool_call' and payload->>'name' = 'spawn' order by turn asc`;
  const keys = new Set<string>();
  let dup_subtasks = 0;
  for (const s of spawns) {
    const title = String(s.payload?.args?.spec?.title ?? '');
    if (!title) continue;
    const k = title_key(title);
    if (keys.has(k)) dup_subtasks++;
    else keys.add(k);
  }

  return {
    claims: claims.length,
    grounded: claims.filter((c) => c.verdict === 'grounded').length,
    misattributed: claims.filter((c) => c.verdict === 'misattributed').length,
    hallucinated: claims.filter((c) => c.verdict === 'hallucinated').length,
    carried_forward: carried,
    carried_and_grounded: carried_grounded,
    duplicate_subtasks: dup_subtasks,
    subtasks: spawns.length,
  };
}
