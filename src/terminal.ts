/**
 * How did this cell actually end?
 *
 * The loop asked one boolean — were there tool calls — and every failure this
 * week hid inside it. A truncated response producing no tool call was read as
 * the agent stalling. An empty completion was read as the agent finishing. In
 * both cases the cell died while every metric reported healthy, because the
 * metrics measured throughput and not semantics.
 *
 * The fix is a terminal state per cell, not a boolean per turn. Only agent_*
 * outcomes are results; infra_* outcomes are cells to re-run, and conflating
 * them means an endpoint problem is scored as agent behaviour. That conflation
 * is documented in published harnesses — inspect_ai degrading silently on
 * fail_on_error=False, ScienceAgentBench swallowing evaluation errors, OSWorld
 * scoring a missing file as zero — and nobody reports how often it happens
 * (arXiv 2605.12131). This is analysis over the journal, so it reclassifies
 * runs already recorded and touches nothing the agent sees.
 */

import type { Sql } from './db.ts';

export type Terminal =
  | 'agent_done'         // closed its work: completions recorded
  | 'agent_stalled'      // acted, but stopped making progress
  | 'infra_truncated'    // output cap hit before the model could act
  | 'infra_empty'        // stopped cleanly with no content and no tool call
  | 'infra_ratelimited'  // endpoint refused
  | 'infra_error'        // transport or provider error ended the run
  | 'harness_bug'        // an invariant this code guarantees was violated
  | 'abandoned'          // killed or never resumed: no terminal status, no error
  | 'running';

export type CellState = {
  run_id: string; task_set: string; arm: string; terminal: Terminal;
  turns: number; tasks: number; done_tasks: number; note: string;
};

const RATE = /1305|1302|429|rate.?limit|overload|too many requests/i;

export async function classify(sql: Sql, task_set?: string): Promise<CellState[]> {
  const runs = await sql<{ id: string; task_set: string; arm: string; status: string }[]>`
    select id, task_set, arm, status from runs
    where (${task_set ?? null}::text is null or task_set = ${task_set ?? null})
    order by task_set, arm, id`;

  const out: CellState[] = [];
  for (const r of runs) {
    const [m] = await sql<{ turns: number; lengths: number; empties: number; last_err: string | null }[]>`
      select count(*) filter (where kind = 'model_call')::int turns,
        count(*) filter (where kind = 'model_call' and payload->>'finish_reason' = 'length')::int lengths,
        count(*) filter (where kind = 'model_call'
          and jsonb_array_length(coalesce(payload->'tool_calls','[]'::jsonb)) = 0
          and coalesce(payload->>'text','') = '')::int empties,
        (array_agg(payload->>'message') filter (where kind = 'error'))[1] last_err
      from steps where run_id = ${r.id}`;
    const [t] = await sql<{ tasks: number; done: number }[]>`
      select count(*)::int tasks, count(*) filter (where status='done')::int done
      from tasks where run_id = ${r.id}`;

    const turns = m?.turns ?? 0, tasks = t?.tasks ?? 0, done = t?.done ?? 0;
    let terminal: Terminal = 'running';
    let note = '';

    if (r.status === 'running') { terminal = 'running'; note = `${turns} turns so far`; }
    // An error step is not a terminal state. A run that hit a transient failure,
    // retried and finished IS an agent outcome; classifying it infra_* excludes
    // a perfectly good cell from the results. That happened to four cells —
    // 58-59 turns each, up to 25 files written — and cost two arms their n=9,
    // which is the difference between a confidence interval that excludes zero
    // and one that misses by 0.011. Errors only decide the outcome when the run
    // did not reach a conclusion.
    else if (r.status !== 'done' && m?.last_err && RATE.test(m.last_err)) { terminal = 'infra_ratelimited'; note = m.last_err.slice(0, 60); }
    else if (r.status !== 'done' && m?.last_err) { terminal = 'infra_error'; note = m.last_err.slice(0, 60); }
    // A cell whose turns were mostly truncated never got to act; that is the
    // harness starving the model, not the model failing the task.
    else if (turns > 0 && (m!.lengths / turns) > 0.5) { terminal = 'infra_truncated'; note = `${m!.lengths}/${turns} turns hit the output cap`; }
    else if (turns > 0 && (m!.empties / turns) > 0.5) { terminal = 'infra_empty'; note = `${m!.empties}/${turns} turns returned nothing at all`; }
    // Ran without a single model call: the cell never started.
    else if (turns === 0) { terminal = 'harness_bug'; note = 'no model call was ever made'; }
    // A run that never reached a terminal STATUS did not finish, however much it
    // closed on the way. Without this, a cell killed mid-flight — no error step,
    // because nothing errored, it was stopped — falls through to agent_done on
    // the strength of one closed task and enters every analysis. That is exactly
    // what happened to B_q1: killed during a provider outage, status='failed',
    // 1 of 14 tasks closed, and classified a completed agent outcome.
    // 'terminated_by_context' is arm AP's legitimate result and is kept.
    else if (r.status !== 'done' && r.status !== 'terminated_by_context') {
      terminal = 'abandoned';
      note = `status=${r.status} after ${turns} turns, ${done}/${tasks} closed — killed or never resumed`;
    }
    else if (done > 0) { terminal = 'agent_done'; note = `${done}/${tasks} tasks closed`; }
    else { terminal = 'agent_stalled'; note = `${turns} turns, nothing closed`; }

    out.push({ run_id: r.id, task_set: r.task_set, arm: r.arm, terminal, turns, tasks, done_tasks: done, note });
  }
  return out;
}

/** Only agent_* outcomes are admissible as results. */
export const is_result = (t: Terminal) => t === 'agent_done' || t === 'agent_stalled';
