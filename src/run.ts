/**
 * The agent loop. One function, both arms — they differ in exactly one place:
 * how the message array for a turn is produced.
 *
 *   Arm A  an accumulating array held in process memory, appended every turn,
 *          nothing managed until the ceiling forces truncation from the front.
 *   Arm B  assemble(run_id, task_id) from Postgres, per wake.
 *
 * Everything else — model settings, task set, seeds, tools, journalling,
 * constraint injection, adherence sampling — is shared, so any difference in
 * the results is attributable to that one branch.
 */

import { randomUUID } from 'node:crypto';
import { REVISIONS_BY_SET } from './propagation.ts';
import type { Sql } from './db.ts';
import { connect, record_step, accumulates } from './db.ts';
import { assemble, task_spec_view, type Msg } from './assemble.ts';
import { prefix_for } from './prompt.ts';
import { call_model, model_config, is_provider_stall } from './model.ts';
import { TASK_SETS, CALIBRATED_CEILING, TASK_SET_MILESTONES, resolve_params, apply_params, type TaskSetId } from './taskset.ts';
import { CONSTRAINT_TEXT, CONSTRAINT_MARKER, CONSTRAINT_TURN, active as active_constraint, ACTIVE as CONSTRAINT_ID, detect_promotion, type AdherenceSample } from './constraint.ts';
import { complete_result } from './tools.ts';
import { read_doc, est_tokens, CORPUS_VERSION } from './corpus.ts';
import { recall } from './recall.ts';
import { surface_for } from './tools.ts';
import { sandbox_run, fetch_text } from './sandbox.ts';
import { deliver as deliver_directives, report as record_report, pending as pending_directives } from './directives.ts';
import { write_file, read_workspace, list_workspace, exported_decl_re } from './workspace.ts';
import { load_resume_state } from './resume.ts';
import { gate_decision, GATE_ENABLED } from './gate.ts';
import { compact, is_context_limit, KEEP_RECENT } from './compact.ts';
import { stable_json } from './canonical.ts';

export type { Arm } from './db.ts';
import type { Arm } from './db.ts';

export type RunOpts = {
  arm: Arm;
  run_id?: string;
  task_set?: TaskSetId;
  seed?: number;
  max_turns?: number;
  max_ms?: number;
  /**
   * Synthetic context window, in tokens. Applied identically to both arms.
   *
   * Deliberately NOT the provider's native window. On a 200K/1M window Arm A
   * peaked at ~8.4k tokens and truncated zero times across a whole run, so the
   * control was never stressed and its perfect adherence meant nothing. A
   * synthetic 32k cap puts truncation inside a feasible run length, keeps runs
   * comparable across providers, and stops the headline result depending on a
   * number the provider could change without telling us. Arm B should never
   * approach it; if it does, that is a finding.
   */
  ceiling_tokens?: number;
  /** Continue an existing run from the journal instead of starting fresh. */
  resume?: boolean;
};

export type RunSummary = {
  run_id: string;
  arm: Arm;
  turns: number;
  tasks_created: number;
  tasks_completed: number;
  wall_ms: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cached: number;
  total_retries: number;
  truncations: number;
  compactions: number;
  /** Sandbox execution. Absent on arms without the shell tool. */
  shell_calls?: number;
  shell_failures?: number;
  /** Documentation lookups. */
  fetches?: number;
  reads: number;
  writes: number;
  /** Arm BR only: journal lookups performed. */
  recalls: number;
  /** complete() calls refused because the task's structural acceptance was unmet. */
  premature_completions: number;
  /** Third-and-later reads of a path already served in full this task. */
  suppressed_rereads: number;
  /** Scheduled requirement changes delivered to this run. */
  interjections_delivered: number;
  /** Turns that hit the output cap before emitting a tool call. */
  output_truncated: number;
  /** spawn calls refused for having no title. */
  malformed_spawns: number;
  /**
   * Would the agent have decomposed on its own?
   *
   * Pre-spawned milestones guarantee the task boundaries arm M's advantage
   * depends on, which means seeding them MANUFACTURES the precondition the
   * treatment requires. That is only acceptable if the thing it hides is still
   * measured, so these count the agent's OWN decomposition separately from the
   * seeded tasks: don't remove the phenomenon, denominate it correctly — the
   * same discipline as the survivorship correction.
   */
  milestones_seeded: number;
  spawn_calls: number;
  /** Reached for the verb. Zero is the TOOL_UNUSED outcome, not a null result. */
  supersede_calls: number;
  /** Delivered vs defined by the task set. Fewer delivered than scheduled means
   *  the cell did not receive its full treatment and is not a replicate. */
  directives_delivered: number;
  directives_scheduled: number;
  /** True when the cell ended on MAX_MS or MAX_TURNS rather than finishing. */
  budget_spent: boolean;
  /** Turns the endpoint refused to answer, then answered on a repeat. A cell
   *  with a high count is slow, not invalid - but it is not comparable on
   *  wall-clock, so it is recorded rather than left implicit. */
  provider_stalls: number;
  /** Actually retired an item. calls - applied = refusals the agent saw. */
  supersede_applied: number;
  /** Task index at which C2' was delivered. Null means it never fired. */
  reversal_delivered_at_task: number | null;
  reversal_superseded_id: string | null;
  reversal_new_id: string | null;
  /** One sample per task boundary. The slot-growth curve, and whether supersession retires anything. */
  boundary_series: Array<{
    task_index: number; turn: number;
    live_decisions: number; live_constraints: number; live_items: number;
    decisions_slot_chars: number | null;
  }>;
  spawn_accepted: number;
  pointerised_reads: number;
  gate_add: number;
  gate_noop: number;
  gate_merge: number;
  constraint_promoted_at_turn: number | null;
  constraint_violations: number;
  constraint_scored_turns: number;
  adherence: AdherenceSample[];
};

/** Fix 3: tool results above this are stored and referenced, not inlined. */
const POINTER_THRESHOLD_TOKENS = Number(process.env.POINTER_THRESHOLD_TOKENS ?? 1000);
/** Must exceed reasoning plus the tool call, or the model never gets to act. */
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS ?? 16384);
/** Turns a single task may take before it is abandoned. */
const TASK_TURN_CAP = Number(process.env.TASK_TURN_CAP ?? 20);

/** Never called `supersede`. Reported separately; not evidence about architecture. */
const TOOL_UNUSED = 'TOOL_UNUSED';
/** Called it and every call was refused — a reachability bug, not a choice. */
const TOOL_REFUSED = 'TOOL_REFUSED';
/**
 * The cell ran out of budget before its directive schedule finished.
 *
 * This is the outcome M_d1 was heading for on 2026-09-08: turn 139 of 240 at
 * 236 of 300 minutes, 3 of 6 directives delivered, never reaching the reversal
 * at turn 200. It would have been recorded `done`, because `did_nothing` is
 * false whenever the budget was spent, and CLAUDE.md's own pooling rule is
 * "filter on status='done'". A cell that never received the treatment would
 * have been pooled as a complete replicate of one that did.
 *
 * Not a failure - the turns it did run are real and the supersession data is
 * usable. It is a DIFFERENT outcome, and the distinction has to survive into
 * the analysis rather than living only in the driver's stderr.
 */
const SCHEDULE_INCOMPLETE = 'SCHEDULE_INCOMPLETE';

const now = () => Date.now();

export async function run_one(sql: Sql, opts: RunOpts): Promise<RunSummary> {
  const arm = opts.arm;
  const run_id = opts.run_id ?? `${arm}_${randomUUID().slice(0, 8)}`;
  const set = TASK_SETS[opts.task_set ?? 'build'];
  const seed = opts.seed ?? 1;
  const max_turns = opts.max_turns ?? 120;
  const max_ms = opts.max_ms ?? 45 * 60_000;
  // How long to wait before repeating a turn the endpoint would not answer.
  // Linear backoff rather than exponential: the failure being waited out is a
  // provider stall lasting minutes, and doubling past that just wastes the
  // cell's remaining budget sleeping through a recovered endpoint.
  const STALL_WAIT_MS = Number(process.env.STALL_WAIT_MS ?? 30_000);
  let provider_stalls = 0;
  // Defaults to the CALIBRATED ceiling for this task set, not a bare literal.
  // `?? 32_000` meant every caller that was not the CLI silently got a window
  // nobody had measured for the set being run — and ceiling_tokens is a pooling
  // key, so two callers disagreeing produces cells that cannot be compared.
  const ceiling = opts.ceiling_tokens ?? CALIBRATED_CEILING[set.id] ?? 32_000;

  const queue: string[] = [];
  /** Arm A only: the accumulating transcript, never rebuilt. */
  let arm_a: Msg[] = [{ role: 'system', content: prefix_for(surface_for(arm)) }];
  let arm_a_seeded = false;
  let turn = 0;
  let constraint_pending = true;

  const summary: RunSummary = {
    run_id, arm, turns: 0, tasks_created: 1, tasks_completed: 0, wall_ms: 0,
    total_tokens_in: 0, total_tokens_out: 0, total_cached: 0, total_retries: 0,
    truncations: 0, compactions: 0, milestones_seeded: 0, spawn_calls: 0, spawn_accepted: 0, supersede_calls: 0, supersede_applied: 0, provider_stalls: 0, directives_delivered: 0, directives_scheduled: 0, budget_spent: false, reversal_delivered_at_task: null, reversal_superseded_id: null, reversal_new_id: null, boundary_series: [], reads: 0, writes: 0, recalls: 0, premature_completions: 0, suppressed_rereads: 0, interjections_delivered: 0, output_truncated: 0, malformed_spawns: 0, pointerised_reads: 0, gate_add: 0, gate_noop: 0, gate_merge: 0,
    constraint_promoted_at_turn: null, constraint_violations: 0, constraint_scored_turns: 0, adherence: [],
  };

  if (opts.resume) {
    // The journal IS the checkpoint. No separate state file, and no risk of
    // the checkpoint disagreeing with the measurements, because they are the
    // same rows.
    const st = await load_resume_state(sql, run_id);
    if (st.arm !== arm) throw new Error(`resume: run ${run_id} is arm ${st.arm}, not ${arm}`);
    // The model is recorded once, at creation. Resuming under a different one
    // leaves the run labelled with the first while the rest of its turns come
    // from the second, and every later analysis silently pools two models
    // inside a single cell. power.ts refuses to pool ACROSS runs; nothing
    // protected against it happening WITHIN one.
    const [rec] = await sql<{ model: string }[]>`select model from runs where id = ${run_id}`;
    if (rec && rec.model !== model_config.model) {
      throw new Error(
        `resume: run ${run_id} was recorded on ${rec.model} but the harness is configured for `
        + `${model_config.model}. Resuming would mix two models inside one cell. Clear the cell or switch back.`);
    }
    turn = st.turn;
    queue.push(...st.queue);
    constraint_pending = st.constraint_pending;
    arm_a = accumulates(st.arm) ? st.arm_a : arm_a;
    arm_a_seeded = st.arm_a_seeded;
    Object.assign(summary, st.counters);
    await sql`update runs set status = 'running', finished_at = null where id = ${run_id}`;
    process.stderr.write(
      `[${arm}] RESUMED ${run_id} at turn ${turn}: ${queue.length} open tasks, `
      + `${st.replayed_messages} messages replayed, ${st.replayed_truncations} truncations re-applied, `
      + `constraint ${constraint_pending ? 'not yet issued' : 'already issued'}\n`,
    );
    // A run that died on its FIRST call has one task, and the abort path below
    // marked it 'abandoned'. Resume rebuilds the queue from OPEN tasks only, so
    // the queue came back empty, the work loop never ran, `aborted` stayed
    // false, and the run was stamped 'done'. Two operate cells were promoted
    // from a provider 500 to "complete" with 0 turns and 0 artifacts that way —
    // a cell that did nothing, counted as a completed replication.
    //
    // Abandonment at the TURN CAP is deliberate and must stay abandoned;
    // abandonment because the endpoint 500'd is infrastructure loss and must be
    // retried. The statuses are identical, so they are told apart by whether the
    // task actually SPENT its turn allowance. Keying on "never got a model call"
    // was too narrow: a cell that burned one empty turn ("(no output)", no tool
    // calls) and then 500'd still has a model_call row, so it was skipped and
    // then stamped done.
    if (!queue.length) {
      const revivable = await sql<{ id: string }[]>`
        select t.id from tasks t
        where t.run_id = ${run_id} and t.status = 'abandoned'
          and (select count(*) from steps s
               where s.run_id = ${run_id} and s.task_id = t.id
                 and s.kind = 'model_call') < ${TASK_TURN_CAP}
        order by t.id`;
      if (revivable.length) {
        await sql`update tasks set status = 'open', closed_at = null
                  where id in ${sql(revivable.map((r) => r.id))}`;
        queue.push(...revivable.map((r) => r.id));
        process.stderr.write(
          `[${arm}] re-opened ${revivable.length} task(s) abandoned before any model call\n`);
      } else {
        // AN INCOMING DIRECTIVE IS WORK. If the run has closed everything it set
        // itself but someone has since said something, the agent is not
        // finished — it is idle with an outstanding obligation. Waking on a
        // pending directive is the difference between an agent that owns a goal
        // and one that owns a to-do list it wrote once.
        const waiting = await pending_directives(sql, run_id);
        if (waiting.length) {
          const t_id = `t_${randomUUID().slice(0, 8)}`;
          await sql`insert into tasks (id, run_id, parent_id, spec, decision_watermark)
                    values (${t_id}, ${run_id}, null, ${sql.json({
                      title: 'Handle an incoming directive',
                      detail: waiting.map((w) => `[${w.kind}] ${w.text}`).join('\n\n'),
                      acceptance: 'The change is made AND verified — not merely built. '
                        + 'Say how you checked it.',
                    })}, 0)`;
          queue.push(t_id);
          summary.tasks_created++;
          process.stderr.write(
            `[${arm}] woke on ${waiting.length} directive(s) — opened a task for them\n`);
        } else {
          process.stderr.write(`[${arm}] nothing left to do — no open tasks\n`);
        }
      }
    }
  } else {
    // Cross-run memory is opt-in. Null scope = the isolated behaviour every
    // banked replicate was recorded under; a scope means this run can see the
    // settled decisions of earlier runs on the same product.
    const scope = process.env.RUN_SCOPE || null;
    // Harness-assigned values, resolved ONCE and stored, so both arms see the
    // same goal and the scorer can check the answer against what THIS seed was
    // actually given rather than a hardcoded constant. A task set with no
    // declared params resolves to {} and the goal passes through untouched.
    const goal_params = resolve_params(set.id, seed);
    const resolved_goal = apply_params(set.goal, goal_params);
    await sql`insert into runs (id, arm, model, seed, task_set, notes, scope)
              values (${run_id}, ${arm}, ${model_config.model}, ${seed}, ${set.id},
                      ${sql.json({ goal: resolved_goal, goal_params, ceiling_tokens: ceiling, constraint_id: CONSTRAINT_ID, corpus_version: CORPUS_VERSION,
                                max_output_tokens: MAX_OUTPUT_TOKENS, max_ms, max_turns, ...model_config })}, ${scope})`;
    const root_id = `t_${randomUUID().slice(0, 8)}`;
    await sql`insert into tasks (id, run_id, parent_id, spec, decision_watermark)
              values (${root_id}, ${run_id}, null, ${sql.json(set.root)}, 0)`;
    queue.push(root_id);

    // Milestones the task set declares are spawned HERE, by the harness, before
    // the agent has taken a turn. See TASK_SET_MILESTONES for why this is a
    // precondition of the treatment rather than a shortcut: arm M's advantage is
    // only realised at a task boundary, so a run that never decomposes collapses
    // both arms onto the same behaviour and measures nothing. Applied identically
    // to every arm, so it is not a treatment difference.
    const milestones = TASK_SET_MILESTONES[set.id] ?? [];
    for (const m of milestones) {
      const mid = `t_${randomUUID().slice(0, 8)}`;
      await sql`insert into tasks (id, run_id, parent_id, spec, decision_watermark)
                values (${mid}, ${run_id}, ${root_id}, ${sql.json(m)}, 0)`;
      queue.push(mid);
      summary.tasks_created++;
      summary.milestones_seeded++;
    }
    if (milestones.length) {
      process.stderr.write(`[${arm}] ${run_id}: pre-spawned ${milestones.length} milestone(s) under the root\n`);
    }
  }

  /**
   * Recent shell commands, normalised, for repetition detection.
   *
   * A run degenerated into `sed -n 1,39p`, `1,40p`, `1,41p` … burning one turn
   * per additional LINE of a 45-line file. Nothing was broken — no error, no
   * truncation, every call returned 0 — so nothing in the harness noticed. An
   * agent making minimal-increment moves looks identical to an agent working.
   */
  const recent_cmds: string[] = [];

  const t_start = now();
  let aborted = false;
  let context_terminated = false;

  /**
   * THE RUN MUST OUTLIVE ITS OWN TO-DO LIST.
   *
   * The loop used to require `queue.length`, so a run ended the moment it closed
   * the work it had set itself. That is why the orchestrate pilot died at turn 59
   * having received one of six directives: the reversal at turn 200 was not missed,
   * it was unreachable. Raising min_children and compressing the schedule only
   * changed how long the queue took to drain; it never touched the mechanism.
   *
   * It is also a confound, not merely a truncation. Run length was a function of
   * tasks closed — the very thing under measurement — so the cells that survived
   * long enough to be scored were a self-selected, arm-dependent subset. Holding
   * every cell to the same horizon is what makes the arms comparable.
   *
   * An agent whose principal has more to say is not finished. It is idle with an
   * outstanding obligation.
   */
  const schedule = REVISIONS_BY_SET[set.id] ?? [];
  const keep_alive_until = schedule.reduce((m, r) => Math.max(m, r.at_turn ?? 0), 0);

  const refill_when_idle = async (): Promise<boolean> => {
    // An undelivered directive is work, whatever the queue says.
    const waiting = await pending_directives(sql, run_id);
    if (waiting.length) {
      const t_id = `t_${randomUUID().slice(0, 8)}`;
      await sql`insert into tasks (id, run_id, parent_id, spec, decision_watermark)
                values (${t_id}, ${run_id}, null, ${sql.json({
                  title: 'Handle an incoming directive',
                  detail: waiting.map((w) => `[${w.kind}] ${w.text}`).join('\n\n'),
                  acceptance: 'The instruction is carried out and recorded with decide.',
                })}, 0)`;
      queue.push(t_id);
      summary.tasks_created++;
      process.stderr.write(`[${arm} t${turn}] woke on ${waiting.length} directive(s)\n`);
      return true;
    }
    // Nothing pending yet, but the schedule is not finished. Ending here would
    // silently discard every directive still to come, the reversal included.
    if (turn < keep_alive_until) {
      const t_id = `t_${randomUUID().slice(0, 8)}`;
      await sql`insert into tasks (id, run_id, parent_id, spec, decision_watermark)
                values (${t_id}, ${run_id}, null, ${sql.json({
                  title: 'Continue the programme',
                  detail: 'Work is outstanding. Take the next area that has no settled '
                    + 'ruling, create its assignment, state which earlier rulings it '
                    + 'depends on, and settle it. If every area is settled, re-examine '
                    + 'the ones whose assumptions later rulings have changed.',
                  acceptance: 'A ruling is recorded with decide, citing what it depends on.',
                })}, 0)`;
      queue.push(t_id);
      summary.tasks_created++;
      process.stderr.write(
        `[${arm} t${turn}] queue empty at turn ${turn}; schedule runs to ${keep_alive_until} — continuing\n`);
      return true;
    }
    return false;
  };

  /**
   * The harness-assigned values for THIS seed, re-read from the run row so a
   * resumed run scores against the same ones it was given.
   *
   * Used to record, every turn, whether the value the reversal will ask for was
   * actually VISIBLE in the context the model received. Without that the study
   * cannot separate its three outcomes: an arm that answered from what it held,
   * an arm that produced the value with the value absent (a guess), and an arm
   * that held it and failed to use it. Only the assistant's OUTPUT was persisted
   * before this, so "was it in context" was unanswerable after the fact.
   */
  const [params_row] = await sql<{ params: Record<string, string> | null }[]>`
    select notes->'goal_params' as params from runs where id = ${run_id}`;
  /** Raw, un-lowercased, for substituting into constraint and spec text. */
  const goal_params_live: Record<string, string> = params_row?.params ?? {};
  const seed_params = Object.entries(params_row?.params ?? {})
    .filter(([, v]) => Boolean(v))
    .map(([k, v]) => [k, String(v).toLowerCase()] as const);

  while (!aborted && turn < max_turns && now() - t_start < max_ms) {
    if (!queue.length && !(await refill_when_idle())) break;
    const task_id = queue.shift()!;
    const [task] = await sql<{ spec: any }[]>`select spec from tasks where id = ${task_id}`;
    if (!task) continue;

    /**
     * Per-boundary series: does supersession actually RETIRE items, and does
     * the decisions slot stop growing once it does?
     *
     * Sampled at the task boundary because that is where a re-projecting arm
     * rebuilds, so it is the only point at which the two arms are comparable.
     *
     * live_items comes from the DURABLE TABLES, so it is meaningful for both
     * arms - it describes what supersession did, not what any arm rendered.
     * decisions_slot_chars is null for an accumulating arm because it renders
     * no durable block at all, and that null is the finding rather than a gap:
     * the accumulating arm can call supersede and gets nothing back from it.
     *
     * Chars, not tokens. Chars are exact and tokens would be an estimate from a
     * tokenizer this process does not have; ~4 chars per token if a rough
     * conversion is wanted downstream.
     */
    {
      const [lc] = await sql<{ decisions: number; constraints: number }[]>`
        select (select count(*)::int from decisions   where run_id = ${run_id} and superseded_by is null) as decisions,
               (select count(*)::int from constraints where run_id = ${run_id} and superseded_by is null and retired_at is null) as constraints`;
      summary.boundary_series.push({
        task_index: summary.tasks_completed,
        turn,
        live_decisions: lc?.decisions ?? 0,
        live_constraints: lc?.constraints ?? 0,
        live_items: (lc?.decisions ?? 0) + (lc?.constraints ?? 0),
        decisions_slot_chars: null as number | null,
      });
    }

    // Advance this task's watermarks to NOW, as it opens.
    //
    // They were written once, at INSERT — i.e. when the task was SPAWNED — and
    // never refreshed. assemble() renders only decisions at or below the
    // watermark, so a task spawned at turn 10 and entered at turn 100
    // re-projected the world as it stood at turn 10. Every decision its
    // siblings recorded in between was invisible to it.
    //
    // The gate itself is right and stays: it stops the durable block mutating
    // underneath an in-flight task, which is why it is taken here, once, rather
    // than per turn. But the boundary the header describes ("promoted at the
    // next boundary") is the task's own start, not the moment a sibling
    // happened to be spawned.
    //
    // Measured on banked runs before this fix: on site/GLM-4.7 arm B, 82 of 82
    // tasks opened with decisions hidden, a mean of 132.8 and a worst case of
    // 304 — against runs holding 143-307 decisions in total. The re-projecting
    // arm has been carrying a stale durable block for the whole study and still
    // beat the accumulating control by +144 grounded findings per run.
    //
    // This changes what assemble() renders, so runs from here on are not
    // comparable to banked ones on durable-block content. That is what the
    // replication tag is for: rep 3 (g) onward has it, e and f do not.
    await sql`
      update tasks set
        decision_watermark = (select coalesce(max(seq),0) from decisions where run_id = ${run_id}),
        read_watermark     = (select coalesce(max(seq),0) from tool_results where run_id = ${run_id})
      where id = ${task_id} and run_id = ${run_id}`;

    let task_done = false;
    let task_turns = 0;

    while (!aborted && !task_done && turn < max_turns && now() - t_start < max_ms && task_turns < TASK_TURN_CAP) {
      turn++; task_turns++;

      // ---- the ONE branch that separates the arms -------------------------
      let messages: Msg[];
      let params_visible: Record<string, boolean> = {};
      // BR and O are re-projected like B; only their durable block differs.
      const is_accumulating = accumulates(arm);
      if (!is_accumulating) {
        const asm = await assemble(sql, run_id, task_id);
        messages = asm.messages;
        // The most recent boundary sample belongs to this task; fill in what
        // the projection actually cost now that it has been built.
        const last_sample = summary.boundary_series[summary.boundary_series.length - 1];
        if (last_sample && last_sample.decisions_slot_chars === null) {
          last_sample.decisions_slot_chars =
            asm.slots.find((sl) => sl.key === 'decisions')?.body.length ?? 0;
        }
      } else {
        if (!arm_a_seeded) {
          // The stored goal, not set.goal: on resume the template is unresolved,
          // and an accumulating arm reading it would get {SETTLE} literally while
          // the re-projecting arm read the resolved text from the same column.
          const [grow] = await sql<{ goal: string }[]>`
            select notes->>'goal' as goal from runs where id = ${run_id}`;
          const goal_msg: Msg = { role: 'user', content: `## Run goal\n\n${grow?.goal ?? set.goal}` };
          arm_a.push(goal_msg);
          await record_step(sql, {
            run_id, step_id: `${run_id}:t${turn}:goalmsg`, arm, kind: 'probe',
            payload: { messages: [goal_msg], note: 'arm A goal message' },
            tokens_in: null, tokens_out: null, cached_tokens: null, latency_ms: null,
            task_id, turn,
          });
          arm_a_seeded = true;
        }
        const task_msg: Msg = { role: 'user', content: `## Current task\n\n${stable_json(task_spec_view(task.spec))}` };
        arm_a.push(task_msg);
        // Journalled so Arm A's transcript can be replayed exactly on resume.
        // Arm B needs no equivalent: assemble() reads from Postgres, so it is
        // resumable by construction. That asymmetry is itself a result.
        await record_step(sql, {
          run_id, step_id: `${run_id}:t${turn}:taskmsg`, arm, kind: 'probe',
          payload: { messages: [task_msg], note: 'arm A task message' },
          tokens_in: null, tokens_out: null, cached_tokens: null, latency_ms: null,
          task_id, turn,
        });
        messages = arm_a;
      }
      // ---------------------------------------------------------------------

      // The constraint enters BOTH arms identically on the same global turn.
      // Arm B renders it from the pinned constraints table on every wake; Arm A
      // holds it only in the transcript, where eviction can destroy it. That
      // asymmetry is the experiment.
      //
      // Injection is no longer gated on a task boundary. A constraint is
      // written to the `constraints` table, which is pinned and not
      // watermark-gated, so it is binding from this turn regardless of where
      // in a task it lands. The grace/boundary dance only existed because the
      // constraint used to be tail-resident and could be evicted a turn later.
      const inject = constraint_pending && turn >= CONSTRAINT_TURN;
      if (inject) {
        const cmsg: Msg = { role: 'user', content: CONSTRAINT_TEXT };
        // Written to durable state for BOTH arms. Arm B renders it from the
        // table into the pinned prologue on every wake. Arm A has no durable
        // region, so its only copy is the transcript one — which is exactly
        // what eviction destroys, and exactly what the experiment compares.
        await sql`insert into constraints (id, run_id, text, kind)
                  values (${`k_${randomUUID().slice(0, 8)}`}, ${run_id}, ${CONSTRAINT_TEXT}, ${CONSTRAINT_ID})
                  on conflict (id) do nothing`;
        // C2 is stated HERE, beside C1, so the two are indistinguishable in
        // provenance and timing. Only one of them will later be reversed.
        const rev = (set as any).reversal as { kind: string; c2: string } | undefined;
        if (rev) {
          await sql`insert into constraints (id, run_id, text, kind)
                    values (${`k_${randomUUID().slice(0, 8)}`}, ${run_id},
                            ${apply_params(rev.c2, goal_params_live)}, ${rev.kind})
                    on conflict (id) do nothing`;
        }
        await record_step(sql, {
          run_id, step_id: `${run_id}:t${turn}:constraint`, arm,
          kind: is_accumulating ? 'probe' : 'tool_call',
          payload: { messages: [cmsg], note: 'constraint injection', text: CONSTRAINT_TEXT, source: 'external' },
          tokens_in: null, tokens_out: null, cached_tokens: null, latency_ms: null,
          task_id, turn,
        });
        if (is_accumulating) arm_a.push(cmsg);
        else messages = (await assemble(sql, run_id, task_id)).messages;
        constraint_pending = false;
      }

      // ---- Scheduled requirement changes -----------------------------------
      // INCOMING DIRECTIVES. Someone outside the run can say something at any
      // moment; it arrives here, at the turn boundary, and becomes a durable
      // constraint. A re-projecting arm therefore re-reads every standing
      // directive on every wake, days later, with no conversational memory —
      // which is the only reason someone can hand this a goal and walk away.
      // WHO is sending is a product question and is not encoded here.
      {
        const handed = await deliver_directives(sql, run_id, turn);
        for (const m of handed) {
          const fmsg: Msg = { role: 'user', content: `DIRECTIVE (${m.kind}): ${m.text}` };
          await record_step(sql, {
            run_id, step_id: `${run_id}:t${turn}:directive${m.id}`, arm,
            kind: is_accumulating ? 'probe' : 'tool_call',
            payload: { messages: [fmsg], note: 'directive', text: m.text, kind: m.kind, source: 'external' },
            tokens_in: null, tokens_out: null, cached_tokens: null, latency_ms: null,
            task_id, turn,
          });
          if (is_accumulating) arm_a.push(fmsg);
          else messages = (await assemble(sql, run_id, task_id)).messages;
          process.stderr.write(`[${arm} t${turn}] DIRECTIVE: ${m.text.slice(0, 70)}\n`);
        }
      }

      // Task sets may declare interjections: client instructions that arrive
      // mid-run and CONTRADICT decisions already recorded. Delivered through the
      // same durable path as the constraint, so Arm B re-renders them from the
      // table on every wake while an accumulating arm holds only the transcript
      // copy — which is the comparison.
      //
      // Idempotent on resume: an interjection is identified by its text, so a
      // run that resumes past the boundary does not receive it twice.
      /**
       * C2' — the reversal, delivered at a TASK boundary through the durable
       * path only.
       *
       * Two writes, no chat message:
       *   1. supersede the C2 constraint row, so the re-projecting arm renders
       *      the new text and STOPS rendering the old one, and
       *   2. append a line to the next task's spec, so the accumulating arm -
       *      which never re-reads the table - is told at least once.
       *
       * Both arms receive it through the identical path. The interjection loop
       * below also pushes a `user` message into the transcript, which reaches
       * the two arms differently and would make delivery itself an arm
       * difference; that is exactly what this avoids.
       */
      const rev_spec = (set as any).reversal as
        { after_tasks_done: number; kind: string; c2_prime: string; spec_line: string } | undefined;
      if (rev_spec && summary.tasks_completed >= rev_spec.after_tasks_done && !summary.reversal_delivered_at_task) {
        const [live] = await sql<{ id: string }[]>`
          select id from constraints
          where run_id = ${run_id} and kind = ${rev_spec.kind} and superseded_by is null`;
        if (live) {
          const new_id = `k_${randomUUID().slice(0, 8)}`;
          const new_text = apply_params(rev_spec.c2_prime, goal_params_live);
          await sql.begin(async (tx) => {
            await tx`insert into constraints (id, run_id, text, kind, supersedes)
                     values (${new_id}, ${run_id}, ${new_text}, ${rev_spec.kind}, ${live.id})`;
            await tx`update constraints set superseded_by = ${new_id} where id = ${live.id}`;
          });
          // Stamp the next queued task so the accumulating arm is told too.
          const next_id = queue[0];
          if (next_id) {
            await sql`update tasks
                      set spec = jsonb_set(spec, '{detail}',
                            to_jsonb(coalesce(spec->>'detail','') || E'\n\n' || ${apply_params(rev_spec.spec_line, goal_params_live)}::text))
                      where id = ${next_id}`;
          }
          summary.reversal_delivered_at_task = summary.tasks_completed;
          summary.reversal_superseded_id = live.id;
          summary.reversal_new_id = new_id;
          // Logged explicitly, per the spec's guard: run, task index, wall time,
          // the id created and the id retired. A reversal whose delivery cannot
          // be located afterwards is not evidence.
          process.stderr.write(
            `[${arm} t${turn}] REVERSAL delivered: run=${run_id} task_index=${summary.tasks_completed} `
            + `wall=${((now() - t_start) / 60_000).toFixed(1)}m superseded=${live.id} new=${new_id} `
            + `next_task=${next_id ?? 'none'}\n`);
        }
      }
      for (const ij of ((set as any).interjections ?? []) as { after_tasks_done: number; text: string }[]) {
        if (summary.tasks_completed < ij.after_tasks_done) continue;
        const [seen] = await sql<{ x: number }[]>`
          select 1 as x from constraints where run_id = ${run_id} and text = ${ij.text} limit 1`;
        if (seen) continue;
        const imsg: Msg = { role: 'user', content: ij.text };
        await sql`insert into constraints (id, run_id, text, kind)
                  values (${`k_${randomUUID().slice(0, 8)}`}, ${run_id}, ${ij.text},
                          ${`interjection_${ij.after_tasks_done}`})
                  on conflict (id) do nothing`;
        await record_step(sql, {
          run_id, step_id: `${run_id}:t${turn}:interject${ij.after_tasks_done}`, arm,
          kind: is_accumulating ? 'probe' : 'tool_call',
          payload: { messages: [imsg], note: 'requirement change', text: ij.text, source: 'external' },
          tokens_in: null, tokens_out: null, cached_tokens: null, latency_ms: null,
          task_id, turn,
        });
        if (is_accumulating) arm_a.push(imsg);
        else messages = (await assemble(sql, run_id, task_id)).messages;
        summary.interjections_delivered++;
        process.stderr.write(`[${arm} t${turn}] requirement change delivered (after ${ij.after_tasks_done} tasks)\n`);
      }

      // Is the constraint text actually present in the context we are about to
      // send? Adherence alone cannot separate "the architecture dropped it"
      // from "the model ignored it while it was visible". This makes that
      // distinction a matter of record, for both arms, at every turn.
      //
      // The marker comes from the ACTIVE constraint rather than a literal. This
      // line read `includes('snake_case')` for the whole no_hedging era: the
      // active constraint's text contains no such substring, so the probe scored
      // false on every turn the constraint was present, and true on any turn the
      // agent had read src/constraint.ts — which is in the corpus. It was wrong
      // in both directions at once, and it feeds turns_with_constraint /
      // present_turns in compare.ts, which is the A-vs-B claim.
      //
      // `role: 'tool'` is skipped for the second half of that failure: tool
      // results carry file bodies verbatim, in arm A's transcript and in arm B's
      // replayed tail alike, so any agent that reads the file defining the
      // constraint would otherwise flip its own presence probe.
      const has_marker = (s: unknown) => typeof s === 'string' && s.includes(CONSTRAINT_MARKER);
      const constraint_present = !constraint_pending && messages.some((m) => {
        if (m.role === 'tool') return false;
        if (typeof m.content === 'string') return has_marker(m.content);
        return Array.isArray(m.content) && m.content.some((part: any) => has_marker(part?.text));
      });

      // A run must survive the provider giving up. Record the failure in the
      // journal and end the run with its partial data intact, rather than
      // throwing away 20 minutes of measurements to an unhandled rejection.
      let r;
      try {
        // Reasoning models spend part of the output budget thinking BEFORE
        // emitting a tool call. GLM-5.3-Flash at 1024 returned finish_reason
        // "length" with zero tool calls on turn 1: the loop reads that as "no
        // tool call", nudges once, then abandons the task. Every turn of every
        // cell would have done that and the study would have produced nothing.
        //
        // Request parameter only, so no prompt bytes move and the arm
        // signatures are unaffected. Applied identically to every arm.
        // Measured on the EXACT list being sent, so it reflects whatever
        // truncation or re-projection actually did to this turn's context.
        params_visible = {};
        if (seed_params.length) {
          const ctx = JSON.stringify(messages).toLowerCase();
          for (const [k, v] of seed_params) params_visible[k] = ctx.includes(v);
        }
        r = await call_model(messages, { max_tokens: MAX_OUTPUT_TOKENS, surface: surface_for(arm) });
      } catch (e: any) {
        // Arm A' has no truncation and no compaction: hitting the model's real
        // context limit IS its result, so it is recorded and never resumed.
        if (arm === 'AP' && is_context_limit(e)) {
          await sql`update runs set status = 'terminated_by_context', finished_at = now() where id = ${run_id}`;
          process.stderr.write(`[AP t${turn}] TERMINATED BY CONTEXT at ~${arm_a.length} messages\n`);
          context_terminated = true;
          aborted = true;
          break;
        }
        // A STALLED PROVIDER IS NOT A FAILED CELL.
        //
        // CORRECTED. This said "this call wrote nothing: no step, no decision,
        // no task state", and that is false. The MODEL CALL writes nothing, but
        // the TURN may already have persisted rows before reaching it. On the
        // incident this was written for - M_d1 turn 82 - three durable rows
        // landed at 13:02:17 (a constraints row, delivered_at stamped on the
        // directive, and a tool_call step) and the exception arrived at
        // 13:33:27, thirty-one minutes later.
        //
        // The retry is still safe, but by guards rather than by construction,
        // and that distinction is the whole point of writing it down:
        //   - deliver_directives filters `delivered_at is null`, so a delivered
        //     directive is not re-delivered
        //   - the in-memory constraint_pending flag is already cleared
        //   - interjections re-check for their own text before inserting
        // Constraint ids are freshly random per execution (k_${randomUUID()}),
        // so `on conflict (id) do nothing` protects nothing here; the
        // delivered_at filter is what actually holds. Anything added to this
        // turn that writes before the model call must carry its own guard, and
        // nothing enforces that today.
        //
        // The turn is repeatable given those guards, and the cost of waiting is
        // wall-clock, which the loop guard above already bounds by max_ms.
        // Ending the run instead threw away everything the cell had done -
        // M_d1 died at turn 82 of 200 on "turn budget exhausted after 1868s",
        // 68 minutes into a 300-minute budget, and the provider was answering
        // again well inside that budget.
        //
        // turn and task_turns are rolled back because the turn did not happen.
        // Leaving them incremented would spend the cell's turn budget on turns
        // that produced nothing and silently shorten the run.
        if (!is_context_limit(e) && is_provider_stall(e) && now() - t_start < max_ms) {
          summary.provider_stalls = ++provider_stalls;
          await record_step(sql, {
            run_id, step_id: `${run_id}:t${turn}:stall${provider_stalls}`, arm, kind: 'stall',
            payload: { message: String(e?.message).slice(0, 400), retried_turn: turn },
            tokens_in: null, tokens_out: null, cached_tokens: null, latency_ms: null,
            task_id, turn,
          });
          // Fixed interval, not linear backoff. The previous form scaled the
          // wait by the consecutive-stall count against a 300s ceiling, which
          // stretched to 5 minutes by the fifth consecutive stall — so the
          // longer an outage ran, the longer the run waited before checking
          // whether it had ended. M_r1 took six consecutive stalls on turn 82
          // and spent roughly 250 of its first 317 minutes on that one turn.
          // Recovery latency matters more than politeness to a dead endpoint.
          const waited = STALL_WAIT_MS;
          process.stderr.write(
            `[${arm} t${turn}] STALL ${provider_stalls} (${String(e?.message).slice(0, 90)}) `
            + `- waiting ${Math.round(waited / 1000)}s and repeating the turn\n`);
          turn--; task_turns--;
          await new Promise((res) => setTimeout(res, waited));
          continue;
        }
        await record_step(sql, {
          run_id, step_id: `${run_id}:t${turn}:error`, arm, kind: 'error',
          payload: { message: String(e?.message).slice(0, 800) },
          tokens_in: null, tokens_out: null, cached_tokens: null, latency_ms: null,
          task_id, turn,
        });
        process.stderr.write(`[${arm} t${turn}] ABORT: ${String(e?.message).slice(0, 160)}\n`);
        aborted = true;
        break;
      }
      // Progress goes to stderr per turn, unbuffered, and names the tools the
      // model actually called. A cell runs for an hour on this endpoint; a
      // counter that only reports tokens cannot answer the question anyone
      // watching actually has, which is whether the agent is doing anything.
      // `finish_reason` is here because `length` is what a starved max_tokens
      // looks like from outside, and that cost a day the last time it was
      // invisible.
      const acted = r.tool_calls.length
        ? r.tool_calls.map((t) => t.name).join(',')
        : `NO-TOOLS(${r.finish_reason})`;
      const mins = ((now() - t_start) / 60_000).toFixed(1);
      process.stderr.write(
        `[${run_id} t${String(turn).padStart(3)}/${max_turns} ${mins}m] `
        + `in=${String(r.usage.tokens_in).padStart(6)} `
        + `cached=${String(r.usage.cached_tokens).padStart(6)} out=${String(r.usage.tokens_out).padStart(4)} `
        + `${(r.latency_ms / 1000).toFixed(0)}s retries=${r.retries} `
        + `q=${queue.length} done=${summary.tasks_completed} :: ${acted}\n`,
      );
      summary.total_tokens_in += r.usage.tokens_in;
      summary.total_tokens_out += r.usage.tokens_out;
      summary.total_cached += r.usage.cached_tokens;
      summary.total_retries += r.retries;

      const parts: Array<{ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }> = [];
      if (r.text) parts.push({ type: 'text', text: r.text });
      for (const t of r.tool_calls) parts.push({ type: 'tool-call', toolCallId: t.id, toolName: t.name, input: t.args });
      // A message with no parts is rejected; a silent turn still needs a slot.
      if (parts.length === 0) parts.push({ type: 'text', text: '(no output)' });
      const assistant: Msg = { role: 'assistant', content: parts };

      await record_step(sql, {
        run_id, step_id: `${run_id}:t${turn}:model`, arm, kind: 'model_call',
        payload: { messages: [assistant], tool_calls: r.tool_calls, finish_reason: r.finish_reason, raw_usage: r.raw_usage, constraint_present, params_visible },
        tokens_in: r.usage.tokens_in, tokens_out: r.usage.tokens_out,
        cached_tokens: r.usage.cached_tokens, latency_ms: r.latency_ms,
        task_id, turn, retries: r.retries,
      });
      if (is_accumulating) arm_a.push(assistant);

      // ---- execute tool calls --------------------------------------------
      const tool_msgs: Msg[] = [];
      /** Every string the active constraint governs, across all tool calls this turn. */
      const governed: string[] = [];
      for (const [i, tc] of r.tool_calls.entries()) {
        governed.push(...active_constraint().governs(tc.name, tc.args as any));
        let result = 'ok';
        try {
          if (tc.name === 'decide') {
            const text = String((tc.args as any).text ?? '');
            // C2: novelty gate. Write-path only — it can shrink the durable
            // set, never select what gets projected.
            const g = await gate_decision(sql, run_id, text);
            if (g.action === 'noop' && g.matched_id) {
              // Suppressed, but counted. A silent drop is an unmeasurable cost.
              await sql`update decisions set restated_count = restated_count + 1
                        where id = ${g.matched_id}`;
              summary.gate_noop++;
              result = `already recorded (restatement, similarity ${g.score?.toFixed(3)})`;
            } else if (g.action === 'merge' && g.matched_id) {
              // Uncertain band: keep the earlier row, append the new wording so
              // nothing is lost, and mark it. No model call — the empty band
              // between 0.753 and 0.937 means this fires rarely, and a merge
              // model call on a throttled provider is not worth the tokens.
              await sql`update decisions
                        set text = text || E'\n  (also: ' || ${text} || ')',
                            restated_count = restated_count + 1, gate_action = 'merge'
                        where id = ${g.matched_id}`;
              summary.gate_merge++;
              result = `merged into an existing decision (similarity ${g.score?.toFixed(3)})`;
            } else {
              await sql`insert into decisions (id, run_id, task_id, text, embedding, gate_action)
                        values (${`d_${randomUUID().slice(0, 8)}`}, ${run_id}, ${task_id}, ${text},
                                ${g.embedding ? sql.json(g.embedding as any) : null},
                                ${GATE_ENABLED ? g.action : null})`;
              summary.gate_add++;
              result = 'decision recorded';
            }
            if (summary.constraint_promoted_at_turn === null && detect_promotion(text)) {
              summary.constraint_promoted_at_turn = turn;
            }
          } else if (tc.name === 'supersede') {
            // Counted BEFORE any validation, like spawn, so a run that reached
            // for the verb and was refused is distinguishable from one that
            // never reached for it. A zero here is a distinct outcome
            // (TOOL_UNUSED), not a null result.
            summary.supersede_calls++;
            const item_id = String((tc.args as any).item_id ?? '');
            const new_text = String((tc.args as any).new_text ?? '');
            if (!item_id || !new_text) {
              result = 'supersede needs both item_id and new_text';
            } else {
              // Which table owns the id. Decisions are multi-valued, constraints
              // are single-valued per kind and carry the partial unique index.
              const [d] = await sql<{ id: string; superseded_by: string | null }[]>`
                select id, superseded_by from decisions where run_id = ${run_id} and id = ${item_id}`;
              const [c] = d ? [undefined] : await sql<{ id: string; superseded_by: string | null; kind: string }[]>`
                select id, superseded_by, kind from constraints where run_id = ${run_id} and id = ${item_id}`;
              if (!d && !c) {
                result = `no decision or constraint ${item_id} in this run`;
              } else if ((d ?? c)!.superseded_by) {
                // Visible to the agent, and deliberately not a silent re-chain:
                // superseding an already-superseded row would fork the chain and
                // make "what is in force" ambiguous. The DB refuses it too.
                result = `${item_id} was already superseded by ${(d ?? c)!.superseded_by}; `
                  + 'supersede the item that is currently in force instead';
              } else {
                const new_id = d ? `d_${randomUUID().slice(0, 8)}` : `k_${randomUUID().slice(0, 8)}`;
                // ONE TRANSACTION. A half-applied supersede either leaves two
                // live rows saying opposite things, or retires the old one with
                // no replacement - both worse than the failure it is fixing.
                await sql.begin(async (tx) => {
                  if (d) {
                    await tx`insert into decisions (id, run_id, task_id, text, supersedes)
                             values (${new_id}, ${run_id}, ${task_id}, ${new_text}, ${item_id})`;
                    await tx`update decisions set superseded_by = ${new_id} where id = ${item_id}`;
                  } else {
                    await tx`insert into constraints (id, run_id, text, kind, supersedes)
                             values (${new_id}, ${run_id}, ${new_text}, ${c!.kind}, ${item_id})`;
                    await tx`update constraints set superseded_by = ${new_id} where id = ${item_id}`;
                  }
                });
                summary.supersede_applied++;
                result = `superseded ${item_id}; ${new_id} is now in force`;
              }
            }
          } else if (tc.name === 'spawn') {
            // Counted before validation, so refusals are visible: M_e1 called spawn 113
            // times and got 2 tasks, and the 111 the harness ate looked identical to
            // never having tried.
            summary.spawn_calls++;
            // Accept both the declared shape and the flattened one. The schema
            // says {spec:{title,detail,acceptance}}; GLM-5.3-Flash emits
            // {title,detail,acceptance} directly. GLM-4.7-Flash respected the
            // wrapper, so this is another model-specific assumption that only
            // surfaced on migration.
            //
            // It mattered: args.spec was undefined, spec fell back to {}, and
            // EVERY subtask was created empty. The agent then received a task
            // with no title, detail or acceptance and had nothing to act on,
            // which is why a run could spawn 39 subtasks and write zero files
            // while the content in the tool call itself was perfectly good.
            const raw = (tc.args as any) ?? {};
            let spec: any = raw.spec ?? raw;
            // SECOND VARIANT of the same class of bug, and it cost 100 turns.
            // The provider leaked its own tool-call markup into the parsed
            // arguments: spec arrived as the STRING
            //   "title</arg_key><arg_value>Add join flow to web client..."
            // instead of an object. spec.title was undefined, the spawn was
            // refused for having no title, the agent retried the identical call,
            // and it did that 113 times while the run looked alive. The content
            // it was trying to send was perfectly good every single time.
            const demarkup = (v: unknown) => String(v ?? '')
              .replace(/^[\s\S]*?<\/arg_key>\s*<arg_value>/, '')
              .replace(/<\/?arg_(key|value)>/g, '')
              .trim();
            if (typeof spec === 'string') {
              spec = { title: demarkup(spec), detail: raw.detail, acceptance: raw.acceptance };
            }
            spec = {
              title: demarkup(spec?.title),
              detail: demarkup(spec?.detail),
              acceptance: demarkup(spec?.acceptance),
            };
            const title = spec.title;
            // An empty task is worse than a refused spawn: it is silently
            // unactionable and still counts toward decomposition.
            if (!title) {
              summary.malformed_spawns++;
              // A LOOP BREAKER. Repeating the same refusal verbatim invites the
              // agent to repeat the same call verbatim, which is exactly what
              // happened. After a few, say something different and actionable.
              const bad = summary.malformed_spawns;
              result = bad < 3
                ? 'spawn refused: the subtask needs a title, a detail and an acceptance criterion. '
                  + 'Call spawn again with those fields.'
                : `spawn has now been refused ${bad} times and repeating it will not work. `
                  + 'Something is mangling the arguments in transit, not your intent. STOP calling '
                  + 'spawn. Either do the work directly in this task with write and shell, or call '
                  + 'complete and report what is blocked.';
            }
            else {
            summary.spawn_accepted++;
            const child = `t_${randomUUID().slice(0, 8)}`;
            const [wm] = await sql<{ max: string }[]>`select coalesce(max(seq),0)::text as max from decisions where run_id = ${run_id}`;
            const [rwm] = await sql<{ max: string }[]>`select coalesce(max(seq),0)::text as max from tool_results where run_id = ${run_id}`;
            await sql`insert into tasks (id, run_id, parent_id, spec, decision_watermark, read_watermark)
                      values (${child}, ${run_id}, ${task_id}, ${sql.json(spec)}, ${wm!.max}, ${rwm!.max})`;
            queue.push(child);
            summary.tasks_created++;
            result = `subtask created: ${title}`;
            }
          } else if (tc.name === 'complete') {
            // A task may declare a structural precondition for closing. This is
            // the acceptance criterion the spec already states, enforced rather
            // than trusted. Applied identically to every arm, so it is not a
            // treatment difference, and it lands in the tail as an ordinary tool
            // result, so no arm's stable prefix moves.
            const [own] = await sql<{ min_children: number; kids: number }[]>`
              select coalesce((spec->>'min_children')::int, 0) as min_children,
                     (select count(*)::int from tasks c where c.run_id = ${run_id} and c.parent_id = ${task_id}) as kids
              from tasks where id = ${task_id}`;
            const need = own?.min_children ?? 0;
            const have = own?.kids ?? 0;
            if (need > 0 && have < need) {
              summary.premature_completions++;
              result = `cannot close this task yet: its acceptance criterion requires ${need} subtasks and ${have} exist. `
                + `Call spawn to create the remaining ${need - have}, then complete.`;
            } else {
              const parsed = complete_result.safeParse((tc.args as any).result);
              await sql`update tasks set status = 'done', result = ${sql.json(parsed.success ? parsed.data : { raw: (tc.args as any).result })},
                        closed_at = now() where id = ${task_id}`;
              summary.tasks_completed++;
              task_done = true;
              result = 'task closed';
            }
          } else if (tc.name === 'write') {
            const path = String((tc.args as any).path ?? '');
            const content = String((tc.args as any).content ?? '');
            const w = write_file(run_id, path, content);
            if (!w.ok) { result = w.error; }
            else {
              summary.writes++;
              // Journalled so created artifacts are attributable to the task
              // that made them — this is what the self-inconsistency probe reads.
              await sql`insert into created_artifacts (run_id, task_id, turn, kind, name, norm_name, detail)
                        values (${run_id}, ${task_id}, ${turn}, 'file', ${w.rel},
                                ${w.rel.toLowerCase()}, ${content.slice(0, 300)})`;
              // EXPORTED declarations only. Matching bare `const x` also captured locals
              // (value, line, num), which would inflate reuse when a later module
              // coincidentally reuses a common variable name.
              for (const m of content.matchAll(exported_decl_re())) {
                await sql`insert into created_artifacts (run_id, task_id, turn, kind, name, norm_name, detail)
                          values (${run_id}, ${task_id}, ${turn}, 'symbol', ${m[1]!},
                                  ${String(m[1]!).toLowerCase()}, ${w.rel})`;
              }
              result = `wrote ${w.rel} (${w.bytes} bytes)`;
            }
          } else if (tc.name === 'fetch') {
            const url = String((tc.args as any).url ?? '');
            const find = (tc.args as any).find ? String((tc.args as any).find) : undefined;
            const fr = await fetch_text(run_id, url, find);
            summary.fetches = (summary.fetches ?? 0) + 1;
            await sql`insert into steps (run_id, step_id, arm, kind, payload, task_id, turn)
                      values (${run_id}, ${`${run_id}:t${turn}:fetch${i}`}, ${arm}, 'probe',
                              ${sql.json({ note: 'fetch', url, find: find ?? null, ms: fr.ms })},
                              ${task_id}, ${turn})`;
            result = fr.stdout || fr.stderr || '(nothing returned)';
          } else if (tc.name === 'report') {
            const headline = String((tc.args as any).headline ?? '');
            const detail = String((tc.args as any).detail ?? '');
            const evidence = String((tc.args as any).evidence ?? '');
            await record_report(sql, run_id, turn, headline, detail, evidence);
            process.stderr.write(`[${arm} t${turn}] REPORT: ${headline.slice(0, 70)}\n`);
            result = 'Report recorded. Whoever is accountable will see it whether or not they are watching now.';
          } else if (tc.name === 'shell') {
            // Runs in a container with only this run's workspace mounted. The
            // command string is never seen by the host shell — it is an argv
            // element to `podman run`. See src/sandbox.ts for the boundary and
            // for the one deliberate hole, which is network access.
            const cmd = String((tc.args as any).cmd ?? '');
            // Normalise away the thing that varies in an increment loop: digits.
            // `sed -n 1,39p f` and `sed -n 1,40p f` collapse to the same shape.
            const shape = cmd.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
            recent_cmds.push(shape);
            if (recent_cmds.length > 8) recent_cmds.shift();
            const repeats = recent_cmds.filter((c) => c === shape).length;
            const sr = await sandbox_run(run_id, cmd);
            summary.shell_calls = (summary.shell_calls ?? 0) + 1;
            if (sr.exit_code !== 0) summary.shell_failures = (summary.shell_failures ?? 0) + 1;
            await sql`insert into steps (run_id, step_id, arm, kind, payload, task_id, turn)
                      values (${run_id}, ${`${run_id}:t${turn}:shell${i}`}, ${arm}, 'probe',
                              ${sql.json({ note: 'shell', cmd, exit_code: sr.exit_code, ms: sr.ms,
                                           timed_out: sr.timed_out, truncated: sr.truncated })},
                              ${task_id}, ${turn})`;
            const status = sr.timed_out ? 'TIMED OUT' : `exit ${sr.exit_code}`;
            // Say it plainly, and say what to do instead. A warning that only
            // describes the problem invites the agent to keep going and feel
            // observed; the spawn loop showed that repeating a message verbatim
            // invites repeating the behaviour verbatim.
            const nudge = repeats >= 4
              ? `\n\n[HARNESS] You have now run this same shape of command ${repeats} times in the `
                + 'last 8 turns, changing only a number. That is costing a turn per line and is not '
                + 'making progress. Read the whole file in one call, or change what you are doing.'
              : '';
            result = `[${status} in ${(sr.ms / 1000).toFixed(1)}s]\n${sr.stdout}`
              + `${sr.stderr ? `\n[stderr]\n${sr.stderr}` : ''}${nudge}`;
          } else if (tc.name === 'recall') {
            // F4. Reads only what this run already produced, so it cannot leak
            // across runs and cannot see anything the agent has not yet made.
            const query = String((tc.args as any).query ?? '');
            const rc = await recall(sql, run_id, query);
            await sql`insert into recalls (run_id, task_id, turn, query, hits)
                      values (${run_id}, ${task_id}, ${turn}, ${query}, ${rc.hits})`;
            summary.recalls++;
            result = rc.text;
          } else if (tc.name === 'read') {
            const path = String((tc.args as any).path ?? '');
            // Workspace files the run created shadow the read-only corpus.
            const ws = read_workspace(run_id, path);
            const doc = ws.ok ? ws : read_doc(path);
            if (!doc.ok) {
              result = doc.error;
            } else {
              const tokens = est_tokens(doc.body);
              summary.reads++;
              // Fix 3: retain pointers, not payloads. Applied identically to
              // both arms, so it is not a treatment difference. Every read is
              // recorded whether or not it is substituted, which is what makes
              // redundant re-reads across tasks measurable.
              const rid = `r_${randomUUID().slice(0, 8)}`;
              const first_line = doc.body.split('\n').find((l) => l && !l.startsWith('#')) ?? '';
              const one_line = first_line.slice(0, 160);
              await sql`insert into tool_results (id, run_id, task_id, turn, tool, args, result, tokens, summary)
                        values (${rid}, ${run_id}, ${task_id}, ${turn}, 'read',
                                ${sql.json({ path })}, ${doc.body}, ${tokens}, ${one_line})`;
              // Escalation, and its cap. The pointer promises "call read again
              // to see the full text", so the SECOND read of a path within a
              // task must return the body or the promise is false. The third
              // and later reads must not: the body is already in context from
              // the second, and serving it again defeats the entire point of
              // holding pointers instead of payloads.
              //
              // Uncapped, this served a full copy on every repeat. One audit
              // run re-read already-read paths on 53 of its 80 turns. It also
              // biased the headline metric asymmetrically — Arm A keeps every
              // duplicate in its transcript for the rest of the run while Arm B
              // discards the tail at each task boundary — so the defect
              // inflated exactly the growth curve the experiment measures, in
              // the direction of the hypothesis.
              const [prior] = await sql<{ n: string }[]>`
                select count(*)::text as n from tool_results
                where run_id = ${run_id} and task_id = ${task_id}
                  and tool = 'read' and args->>'path' = ${path} and id <> ${rid}`;
              const prior_reads = Number(prior?.n ?? 0);

              if (tokens > POINTER_THRESHOLD_TOKENS && prior_reads === 0) {
                summary.pointerised_reads++;
                result = [
                  `read ${path} — ${tokens} tokens, stored as result_id=${rid}`,
                  `summary: ${one_line}`,
                  `To see the full text, call read again with path "${path}".`,
                ].join('\n');
              } else if (tokens > POINTER_THRESHOLD_TOKENS && prior_reads >= 2) {
                summary.suppressed_rereads++;
                result = `read ${path} — already returned in full earlier in this task. `
                  + `Its contents are above in this conversation; reading it again returns nothing new.`;
              } else {
                result = doc.body;
              }
            }
          }
        } catch (e: any) {
          result = `error: ${String(e?.message).slice(0, 200)}`;
        }
        tool_msgs.push({
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: tc.id, toolName: tc.name, output: { type: 'text', value: result } }],
        });
        await record_step(sql, {
          run_id, step_id: `${run_id}:t${turn}:tool${i}`, arm, kind: 'tool_call',
          payload: { messages: [tool_msgs[tool_msgs.length - 1]], name: tc.name, args: tc.args, result },
          tokens_in: null, tokens_out: null, cached_tokens: null, latency_ms: null,
          task_id, turn,
        });
      }
      if (is_accumulating) arm_a.push(...tool_msgs);

      // No tool call at all: nudge once, then abandon the task rather than spin.
      if (r.tool_calls.length === 0) {
        // Distinguish "chose not to call" from "ran out of room before it
        // could". The second is a harness misconfiguration, not agent
        // behaviour, and counting them together hides it: a run can look like
        // a stalling agent when the output budget is simply too small for a
        // reasoning model to finish thinking and then act.
        if (r.finish_reason === 'length') {
          summary.output_truncated++;
          process.stderr.write(`[${arm} t${turn}] OUTPUT TRUNCATED at ${MAX_OUTPUT_TOKENS} tokens before any tool call — raise MAX_OUTPUT_TOKENS\n`);
        }
        const nudge: Msg = { role: 'user', content: 'You must act by calling a tool. Call complete if the task is finished.' };
        if (is_accumulating) arm_a.push(nudge);
        await record_step(sql, {
          run_id, step_id: `${run_id}:t${turn}:nudge`, arm,
          kind: is_accumulating ? 'probe' : 'tool_call',
          payload: { messages: [nudge], note: arm === 'A' ? 'arm A nudge' : undefined },
          tokens_in: null, tokens_out: null, cached_tokens: null, latency_ms: null,
          task_id, turn,
        });
      }

      // ---- graded constraint scoring, once per turn ------------------------
      // Continuous rather than sampled at spawns: the active constraint governs
      // every string the agent writes, so a turn is compliant only if all of
      // them are. Turns that emit no governed text are not scored at all —
      // counting them as compliant would inflate the rate with silence.
      if (governed.length) {
        const c = active_constraint();
        const bad = governed.flatMap((g) => c.violations(g));
        summary.adherence.push({
          turn, task_id,
          title: bad.length ? bad.join(',') : governed[0]!.slice(0, 60),
          adherent: bad.length === 0,
        });
        if (bad.length) summary.constraint_violations += bad.length;
        summary.constraint_scored_turns++;
      }

      // ---- Truncation at the harness ceiling, for accumulating arms --------
      // Drops from the FRONT, which is what invalidates the prefix cache and
      // loses the earliest context — including the constraint.
      // Arm D compacts where Arm A truncates; Arm A' does neither.
      if (arm === 'D' && r.usage.tokens_in > ceiling) {
        const before = arm_a.length;
        const c = await compact(sql, run_id, arm, turn, arm_a, () => null);
        arm_a = c.messages;
        summary.compactions++;
        process.stderr.write(`[D t${turn}] compacted ${before} -> ${arm_a.length} messages (kept ${KEEP_RECENT} verbatim)\n`);
      }

      // accumulates() minus the two arms defined by NOT doing this: AP exists to
      // be A-without-truncation, and D compacts instead (handled above).
      //
      // This read `arm === 'A'` literally, which silently made AM an unbounded
      // accumulator rather than an accumulating control. AM would have grown
      // past the ceiling forever and been compared against M as though it were
      // arm A, so the one comparison the autonomous work is missing would have
      // been measuring the wrong contrast.
      const truncates = accumulates(arm) && arm !== 'AP' && arm !== 'D';
      if (truncates && r.usage.tokens_in > ceiling) {
        const keep_system = arm_a[0]!;
        const body = arm_a.slice(1);
        let drop = Math.max(2, Math.floor(body.length * 0.3));
        // Advance the cut to a legal boundary. Slicing at an arbitrary index
        // can leave a `tool` message whose matching assistant tool-call was
        // dropped; that sequence is malformed, the provider reshapes it, and
        // the prefix cache then fails to match from the very top — observed as
        // cached_tokens stuck at 42 for every turn after the first truncation,
        // below even the system prompt. Never start the surviving body on a
        // tool result.
        while (drop < body.length && body[drop]?.role === 'tool') drop++;
        arm_a = [keep_system, ...body.slice(drop)];
        summary.truncations++;
        await record_step(sql, {
          run_id, step_id: `${run_id}:t${turn}:truncate`, arm, kind: 'probe',
          payload: { dropped_messages: drop, tokens_in_at_truncation: r.usage.tokens_in, ceiling },
          tokens_in: null, tokens_out: null, cached_tokens: null, latency_ms: null,
          task_id, turn,
        });
      }
    }

    if (!task_done) {
      await sql`update tasks set status = 'abandoned', closed_at = now() where id = ${task_id}`;
    }
  }

  summary.turns = turn;
  summary.wall_ms = now() - t_start;
  // 'done' must mean the agent finished, never merely that the loop had nothing
  // to iterate. A run that closed no task and took no turn did not succeed at
  // anything, whatever the loop condition says -- and marking it done hides an
  // empty cell inside an n=9 arm, which shifts that arm's mean without leaving
  // a failure anywhere to notice.
  const [closed_row] = await sql<{ closed: string }[]>`
    select count(*)::text as closed from tasks where run_id = ${run_id} and status = 'done'`;
  // The restored turn counter is not evidence of work: a resumed run starts at
  // whatever turn the dead session reached. What separates success from an empty
  // cell is whether any task closed, or whether a budget was genuinely spent.
  // Exhausting max_turns having closed nothing is a real agent outcome and stays
  // 'done'; falling out of the loop with an empty queue, having closed nothing
  // and spent no budget, is infrastructure loss wearing a success badge.
  const budget_spent = turn >= max_turns || now() - t_start >= max_ms;
  const did_nothing = Number(closed_row?.closed ?? 0) === 0 && !budget_spent;
  if (did_nothing) {
    process.stderr.write(
      `[${arm}] ${run_id}: 0 tasks closed and no budget spent — recording FAILED, not done\n`);
  }
  /**
   * A run that never reached for `supersede` is a DISTINCT OUTCOME, not a null.
   *
   * If the agent never called the verb, the run says nothing about whether
   * re-projection propagates a reversal — it says the prompt, the rendered ids,
   * or the task failed to make the verb reachable. Pooling those with genuine
   * failures-to-adhere would report a prompting problem as an architecture
   * result. Tagged here so the analysis can separate them before it aggregates.
   */
  const outcome_tags: string[] = [];
  if (summary.supersede_calls === 0) outcome_tags.push(TOOL_UNUSED);
  if (summary.supersede_calls > 0 && summary.supersede_applied === 0) outcome_tags.push(TOOL_REFUSED);
  // DERIVED, not asserted: count what was actually delivered against what the
  // set defines, rather than trusting a flag someone remembered to set.
  const [dlv] = await sql<{ n: number }[]>`
    select count(*)::int as n from directives
    where run_id = ${run_id} and delivered_at is not null`;
  const scheduled = (REVISIONS_BY_SET[set.id] ?? []).length;
  summary.directives_delivered = dlv?.n ?? 0;
  summary.directives_scheduled = scheduled;
  summary.budget_spent = budget_spent;
  if (scheduled > 0 && (dlv?.n ?? 0) < scheduled) {
    outcome_tags.push(SCHEDULE_INCOMPLETE);
    process.stderr.write(
      `[${arm}] ${run_id}: ${dlv?.n ?? 0} of ${scheduled} directives delivered`
      + ` — tagged ${SCHEDULE_INCOMPLETE}, do not pool as a replicate\n`);
  }
  if (!context_terminated) await sql`update runs set status = ${aborted || did_nothing ? 'failed' : 'done'}, finished_at = now(),
            notes = notes || ${sql.json({ summary: { ...summary, adherence: undefined }, outcome_tags })} where id = ${run_id}`;
  return summary;
}

if (import.meta.filename === process.argv[1]) {
  const sql = connect();
  const arm = (process.argv[2] as Arm) ?? 'B';
  // RUN_ID and STUDY_TASK_SET are readable here so a single run can be started
  // outside the seeds study. Without them the only way to start one was the
  // study runner, which iterates arms and seeds and cannot express "one run,
  // this id, this task set" — the shape every autonomous run has.
  const s = await run_one(sql, {
    arm,
    run_id: process.env.RUN_ID || undefined,
    task_set: (process.env.STUDY_TASK_SET as TaskSetId) || undefined,
    seed: Number(process.env.SEED ?? 1),
    max_turns: Number(process.env.MAX_TURNS ?? 120),
    max_ms: Number(process.env.MAX_MS ?? 45 * 60_000),
    // The calibrated ceiling for the task set, not a bare default. This read
    // `?? 60_000` and ignored CALIBRATED_CEILING entirely, so every run started
    // from this CLI — which is every autonomous run — used a number nobody had
    // measured and which no analysis referenced.
    ceiling_tokens: Number(
      process.env.CEILING_TOKENS
      ?? CALIBRATED_CEILING[process.env.STUDY_TASK_SET ?? 'build']
      ?? 60_000),
    resume: process.env.RESUME === '1',
  });
  console.log(stable_json({ ...s, adherence: `${s.adherence.filter((a) => a.adherent).length}/${s.adherence.length} adherent` }));
  await sql.end();
}
