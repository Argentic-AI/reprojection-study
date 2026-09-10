/**
 * Checkpoint and resume.
 *
 * The journal is the checkpoint — there is no separate state file. `steps` is
 * already idempotent on `(run_id, step_id)`, so a resumed run that replays a
 * step collides and discards rather than double-counting.
 *
 * The two arms are very differently placed here, and the asymmetry is a result
 * rather than an implementation detail:
 *
 *   Arm B  resumable by construction. assemble() reads only from Postgres, so
 *          restoring it means restoring a turn counter and a task queue.
 *          Nothing about its context lives in the process.
 *   Arm A  its context IS process memory. Resuming means replaying every
 *          message it ever appended, in exact order, and re-applying each
 *          truncation at the turn it happened — otherwise the resumed
 *          transcript differs from the original and every subsequent
 *          measurement is of a different agent.
 *
 * A durable-state agent survives a crash for free. An accumulating one needs
 * replay machinery, and that machinery has to be exactly right.
 */

import { accumulates, type Sql, type Arm } from './db.ts';
import type { Msg } from './assemble.ts';
import { prefix_for } from './prompt.ts';
import { surface_for } from './tools.ts';

export type ResumeState = {
  run_id: string;
  arm: string;
  ceiling_tokens: number;
  /** Last turn number actually recorded. The resumed run continues from turn+1. */
  turn: number;
  /** Open tasks, in creation order — the queue as it stood. */
  queue: string[];
  /** True only if no constraint row exists yet for this run. */
  constraint_pending: boolean;
  /** Arm A's transcript, replayed exactly. Empty for re-projecting arms. */
  arm_a: Msg[];
  arm_a_seeded: boolean;
  /** Counters restored from the journal so totals stay continuous. */
  counters: {
    tasks_created: number; tasks_completed: number;
    total_tokens_in: number; total_tokens_out: number; total_cached: number;
    total_retries: number; truncations: number; reads: number; pointerised_reads: number;
  };
  replayed_messages: number;
  replayed_truncations: number;
};

export async function load_resume_state(sql: Sql, run_id: string): Promise<ResumeState> {
  const [run] = await sql<{ arm: string; notes: any; status: string }[]>`
    select arm, notes, status from runs where id = ${run_id}`;
  if (!run) throw new Error(`resume: no run ${run_id}`);

  const [turn_row] = await sql<{ turn: number }[]>`
    select coalesce(max(turn), 0)::int as turn from steps where run_id = ${run_id}`;
  const turn = turn_row?.turn ?? 0;

  const open = await sql<{ id: string }[]>`
    select id from tasks where run_id = ${run_id} and status = 'open' order by ord asc`;

  const [con_row] = await sql<{ n: string }[]>`
    select count(*)::text as n from constraints where run_id = ${run_id}`;
  const constraint_rows = con_row?.n ?? '0';

  const counters = await restore_counters(sql, run_id);

  let arm_a: Msg[] = [];
  let arm_a_seeded = false;
  let replayed_truncations = 0;

  if (accumulates(run.arm as Arm)) {
    const replay = await replay_arm_a(sql, run_id, run.arm as Arm);
    arm_a = replay.messages;
    arm_a_seeded = replay.seeded;
    replayed_truncations = replay.truncations;
  }

  return {
    run_id,
    arm: run.arm,
    ceiling_tokens: Number(run.notes?.ceiling_tokens ?? 32_000),
    turn,
    queue: open.map((t) => t.id),
    constraint_pending: Number(constraint_rows) === 0,
    arm_a,
    arm_a_seeded,
    counters,
    replayed_messages: arm_a.length,
    replayed_truncations,
  };
}

/**
 * Rebuild Arm A's transcript from the journal.
 *
 * Ordered by `seq`, not `step_id` — step_id sorts lexically, which puts
 * "constraint" before "model" and "taskmsg" after "tool0", neither of which is
 * append order. Getting this wrong would produce a transcript that is plausible
 * but not the one the agent actually saw.
 *
 * Truncations are re-applied where they occurred, using the same
 * legal-boundary rule as the live loop, so the resumed array matches the
 * original byte for byte.
 */
async function replay_arm_a(sql: Sql, run_id: string, arm: Arm): Promise<{ messages: Msg[]; seeded: boolean; truncations: number }> {
  const rows = await sql<{ kind: string; payload: any; seq: string }[]>`
    select kind, payload, seq::text from steps
    where run_id = ${run_id} order by seq asc`;

  // The arm's OWN prefix, not the default surface: arm BR's includes the
  // recall tool, and replaying it with the base prefix would rebuild a
  // transcript the agent never saw.
  let msgs: Msg[] = [{ role: 'system', content: prefix_for(surface_for(arm)) }];
  let seeded = false;
  let truncations = 0;

  for (const r of rows) {
    if (r.payload?.dropped_messages !== undefined) {
      // Re-apply the truncation exactly as the live loop did.
      const body = msgs.slice(1);
      let drop = Number(r.payload.dropped_messages);
      while (drop < body.length && body[drop]?.role === 'tool') drop++;
      msgs = [msgs[0]!, ...body.slice(drop)];
      truncations++;
      continue;
    }
    const m = r.payload?.messages;
    if (Array.isArray(m) && m.length) {
      msgs.push(...(m as Msg[]));
      if (r.payload?.note === 'arm A goal message') seeded = true;
    }
  }
  return { messages: msgs, seeded, truncations };
}

async function restore_counters(sql: Sql, run_id: string) {
  const [tok] = await sql<{ tin: string; tout: string; cached: string; retries: string; turns: string }[]>`
    select coalesce(sum(tokens_in),0)::text as tin, coalesce(sum(tokens_out),0)::text as tout,
           coalesce(sum(cached_tokens),0)::text as cached, coalesce(sum(retries),0)::text as retries,
           count(*)::text as turns
    from steps where run_id = ${run_id} and kind = 'model_call'`;
  const [tk] = await sql<{ total: string; done: string }[]>`
    select count(*)::text as total, count(*) filter (where status='done')::text as done
    from tasks where run_id = ${run_id}`;
  const [tr] = await sql<{ n: string }[]>`
    select count(*)::text as n from steps
    where run_id = ${run_id} and kind = 'probe' and payload ? 'dropped_messages'`;
  const [rd] = await sql<{ n: string; p: string }[]>`
    select count(*)::text as n,
           count(*) filter (where tokens > ${Number(process.env.POINTER_THRESHOLD_TOKENS ?? 1000)})::text as p
    from tool_results where run_id = ${run_id} and tool = 'read'`;

  return {
    tasks_created: Number(tk?.total ?? 0),
    tasks_completed: Number(tk?.done ?? 0),
    total_tokens_in: Number(tok?.tin ?? 0),
    total_tokens_out: Number(tok?.tout ?? 0),
    total_cached: Number(tok?.cached ?? 0),
    total_retries: Number(tok?.retries ?? 0),
    truncations: Number(tr?.n ?? 0),
    reads: Number(rd?.n ?? 0),
    pointerised_reads: Number(rd?.p ?? 0),
  };
}

/** Runs that stopped before finishing and can be continued. */
export async function resumable_runs(sql: Sql): Promise<{ id: string; arm: string; status: string; turns: number }[]> {
  return sql<{ id: string; arm: string; status: string; turns: number }[]>`
    select r.id, r.arm, r.status,
           coalesce((select max(turn) from steps s where s.run_id = r.id), 0)::int as turns
    from runs r
    where r.status in ('failed', 'running')
      and r.id not like 'test_%'
      and exists (select 1 from tasks t where t.run_id = r.id and t.status = 'open')
    order by r.started_at desc`;
}
