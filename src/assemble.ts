/**
 * Arm B's context assembler.
 *
 *   assemble(sql, run_id, task_id) -> messages
 *
 * Pure with respect to process memory: every byte it emits is derived from the
 * arguments and from Postgres. Call it twice with the same DB state and you get
 * identical bytes. Nothing is cached in a module variable, nothing reads the
 * clock, nothing depends on what a previous call did.
 *
 * Layout, in three regions of decreasing stability:
 *
 *   [0] system  STABLE PREFIX   byte-identical for the entire run
 *   [1] user    DURABLE SLOTS   the pinned prologue: goal, constraints,
 *                               live decisions, current task spec
 *   [2..] tail  THIS TASK ONLY  append-only within the task, discarded at the boundary
 *
 * Region 0 is the same tokens on every call the run ever makes, so it is always
 * a cache hit after the first call. Region 2 only ever grows. So within a task
 * the cacheable prefix strictly grows, and at a boundary it collapses back to
 * region 0 — a sawtooth bounded above by a constant, rather than Arm A's
 * monotonic climb.
 *
 * Two different freezes operate in region 1, and the difference matters:
 *
 *   decisions   gated by `tasks.decision_watermark`. A decide() mid-task lands
 *               in the tail now and is promoted at the next boundary, so the
 *               rendered block cannot mutate underneath an in-flight task.
 *   constraints NOT gated. Pinned from the moment they are issued and never
 *               evictable within a run. A constraint is binding immediately;
 *               deferring it to the next boundary would mean a rule issued
 *               mid-task did not apply until the task ended.
 *   reads       gated by `tasks.read_watermark`, same reasoning as decisions.
 *               The ledger exists because a discarded tail takes the knowledge
 *               of what was read with it; Arm A keeps that in its transcript
 *               for free, and without an equivalent Arm B re-read 68.6% of the
 *               time.
 */

import type { Sql, DecisionRow, RunRow, TaskRow, StepRow } from './db.ts';
import { prefix_for } from './prompt.ts';
import { surface_for } from './tools.ts';
import { oracle_block } from './oracle.ts';
import { stable_json, fingerprint } from './canonical.ts';
import { extract_claims } from './artifacts.ts';
import { PATH_RE_G, lines_of } from './ground.ts';

/**
 * AI SDK `ModelMessage` shape, not OpenAI wire format. The SDK converts these
 * to the provider's wire format itself; handing it raw OpenAI-shaped messages
 * fails validation.
 */
export type TextPart = { type: 'text'; text: string };
export type ToolCallPart = { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown };
export type ToolResultPart = {
  type: 'tool-result'; toolCallId: string; toolName: string;
  output: { type: 'text'; value: string };
};

export type Msg =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | Array<TextPart | ToolCallPart> }
  | { role: 'tool'; content: ToolResultPart[] };

/** The durable region is a fixed list of typed slots in a fixed order. */
export type SlotKey = 'goal' | 'constraints' | 'decisions' | 'reads' | 'gold' | 'task';

/** Order is a module constant, never derived from data. Reordering is a bug. */
export const SLOT_ORDER: readonly SlotKey[] = ['goal', 'constraints', 'decisions', 'reads', 'task'] as const;

/**
 * Arm O replaces both accumulated slots with one oracle-selected block. It
 * keeps the goal, the constraints and the task spec, because those are the
 * problem statement rather than the context strategy — varying them would make
 * arm O an upper bound on a different task.
 */
export const ORACLE_SLOT_ORDER: readonly SlotKey[] = ['goal', 'constraints', 'gold', 'task'] as const;

export type Slot = { key: SlotKey; heading: string; body: string };

export type Assembled = {
  messages: Msg[];
  slots: Slot[];
  diagnostics: {
    prefix_fingerprint: string;
    durable_fingerprint: string;
    prefix_chars: number;
    durable_chars: number;
    tail_chars: number;
    tail_messages: number;
    live_decisions: number;
    live_constraints: number;
    ledger_entries: number;
    decision_watermark: string;
  };
};

// ------------------------------------------------------------------ reads

async function read_run(sql: Sql, run_id: string): Promise<RunRow> {
  const [row] = await sql<RunRow[]>`
    select id, arm, model, seed::text, task_set, status, notes, scope from runs where id = ${run_id}
  `;
  if (!row) throw new Error(`assemble: no run ${run_id}`);
  return row;
}

async function read_task(sql: Sql, run_id: string, task_id: string): Promise<TaskRow> {
  const [row] = await sql<TaskRow[]>`
    select id, run_id, parent_id, status, spec, result, ord::text, decision_watermark::text, read_watermark::text
    from tasks where run_id = ${run_id} and id = ${task_id}
  `;
  if (!row) throw new Error(`assemble: no task ${task_id} in run ${run_id}`);
  return row;
}

/**
 * Live decisions as of this task's watermark.
 *
 * `superseded_by is null` is the liveness test. `seq <= watermark` is the
 * freeze. Ordering is by `seq`, an integer: ordering by created_at would tie
 * whenever two rows land in the same microsecond and the resulting order would
 * be whatever the planner felt like, which is not deterministic.
 */
async function read_live_decisions(sql: Sql, run_id: string, watermark: string): Promise<DecisionRow[]> {
  return sql<DecisionRow[]>`
    select id, run_id, task_id, text, superseded_by, created_at::text, seq::text
    from decisions
    where run_id = ${run_id}
      and superseded_by is null
      and seq <= ${watermark}::bigint
    order by seq asc
  `;
}

/**
 * Settled decisions from EARLIER runs that share this run's scope.
 *
 * Not watermark-gated, and deliberately: the watermark exists to stop the
 * prefix being rewritten underneath an in-flight task within a run. A finished
 * run's decisions are settled — there is no in-flight anything to protect.
 *
 * `superseded_by is null` still applies, and it matters more here than anywhere
 * else in the system. A decision retired in run 3 must not resurface in run 7
 * as though it were current. That path exists, is indexed, and has fired ZERO
 * times across 5,356 decisions because no tool has ever reached it — so this
 * widening is exactly where that gap stops being theoretical.
 *
 * Ordered by (created_at, seq) rather than seq alone: seq is a per-table
 * sequence, so it happens to order correctly across runs today, but nothing
 * guarantees that and a wrong order here is silent.
 */
async function read_scope_decisions(
  sql: Sql, run_id: string, scope: string | null,
): Promise<DecisionRow[]> {
  if (!scope) return [];
  return sql<DecisionRow[]>`
    select d.id, d.run_id, d.task_id, d.text, d.superseded_by, d.created_at::text, d.seq::text
    from decisions d join runs r on r.id = d.run_id
    where r.scope = ${scope}
      and d.run_id <> ${run_id}
      and d.superseded_by is null
    order by d.created_at asc, d.seq asc
  `;
}

/**
 * Live constraints. Deliberately NOT watermark-gated — see the header note.
 * Pinned from issue, rendered on every wake, never evictable within a run.
 */
async function read_constraints(sql: Sql, run_id: string): Promise<{ id: string; text: string; created_at: string }[]> {
  // superseded_by is null, not just retired_at: supersession is now the live
  // retirement path and retired_at has never had a production writer.
  return sql<{ id: string; text: string; created_at: string }[]>`
    select id, text, created_at::text
    from constraints
    where run_id = ${run_id} and retired_at is null and superseded_by is null
    order by seq asc
  `;
}

/**
 * Read ledger — what this run has already read, and what it found.
 *
 * Arm A gets this for free: every read it ever did is still in its transcript.
 * A re-projecting agent loses that at each task boundary and re-reads, which
 * measured 68.6% redundant reads before this existed.
 *
 * This is NOT retrieval. There is no query, no ranking, no similarity, no
 * embedding: it is the complete list of paths read, in read order, with the
 * summary already stored at read time. Deterministic in the database state.
 *
 * Watermark-gated like decisions, for the same reason — a read during a task
 * is already in that task's tail, and promoting it immediately would rewrite
 * the durable block underneath an in-flight task.
 */
async function read_ledger(sql: Sql, run_id: string, watermark: string): Promise<{ path: string; summary: string }[]> {
  return sql<{ path: string; summary: string }[]>`
    select distinct on (args->>'path')
           args->>'path' as path, summary
    from tool_results
    where run_id = ${run_id} and tool = 'read' and seq <= ${watermark}::bigint
    order by args->>'path' asc, seq asc
  `;
}

function render_reads(rows: { path: string; summary: string }[]): string {
  if (rows.length === 0) return '(none yet)';
  return rows.map((r) => `- ${r.path} — ${r.summary}`).join('\n');
}

/**
 * The tail: this task's turns only, reconstructed from the journal.
 *
 * Ordered by (turn, step_id) — step_id breaks ties deterministically when one
 * turn produced several rows, e.g. a model call plus its tool results.
 */
async function read_tail(sql: Sql, run_id: string, task_id: string): Promise<StepRow[]> {
  return sql<StepRow[]>`
    select run_id, step_id, arm, kind, payload, tokens_in, tokens_out,
           cached_tokens, latency_ms, task_id, turn, retries
    from steps
    where run_id = ${run_id} and task_id = ${task_id} and kind in ('model_call', 'tool_call')
    order by turn asc, step_id asc
  `;
}

/** Ancestry from root to parent, for the breadcrumb in the task slot. */
async function read_ancestry(sql: Sql, run_id: string, task_id: string): Promise<TaskRow[]> {
  return sql<TaskRow[]>`
    with recursive up as (
      select t.* from tasks t where t.run_id = ${run_id} and t.id = ${task_id}
      union all
      select p.* from tasks p join up on p.id = up.parent_id and p.run_id = up.run_id
    )
    select id, run_id, parent_id, status, spec, result, ord::text, decision_watermark::text, read_watermark::text
    from up where id <> ${task_id} order by ord asc
  `;
}

// ---------------------------------------------------------------- renders

function render_goal(run: RunRow): string {
  // `notes.goal` is written once when the run is created and never updated.
  const goal = (run.notes as any)?.goal;
  if (typeof goal !== 'string' || goal.length === 0) throw new Error(`assemble: run ${run.id} has no goal`);
  return goal;
}

function render_constraints(rows: { id: string; text: string; created_at: string }[]): string {
  if (rows.length === 0) return '(none)';
  // The id is rendered because `supersede` takes one. Without it the agent can
  // see an item is wrong and have no way to name it, which produces zero
  // supersede calls that look like a finding about architecture and are
  // actually a missing identifier.
  return rows.map((c, i) => `C${i + 1}. (${c.id}) [${c.created_at}] ${c.text}`).join('\n');
}

/**
 * Decisions block. Ordinals are positional within this rendering (D1, D2, ...),
 * so they stay dense as decisions are superseded. `created_at` comes from the
 * DB row, never from the clock — that is the only sanctioned source of time
 * above the tail, and being row-derived it is stable for the task's lifetime.
 */
/**
 * Budget for the rendered decisions block.
 *
 * Arm A has an eviction policy: it truncates at the ceiling. Arm B had none —
 * every live decision was re-rendered on every turn, forever. On a real task
 * the agent wrote 180 decisions (only 40 of them distinct), and the durable
 * region became exactly the unbounded growth re-projection is supposed to
 * prevent: Arm B peaked at 42,594 input tokens against Arm A's 24,538.
 *
 * ONE mechanism survives, and it is deterministic and refers to no metric:
 *
 *   dedup  identical decisions collapse to their first occurrence. Pure win —
 *          re-stating a decision verbatim carries no information.
 *
 * THE CAP IS GONE. This block used to describe a second mechanism, a
 * DECISION_CAP of 40 beyond which the oldest live decisions stopped being
 * rendered, and concluded "only what is projected is bounded". That was removed
 * as untested code (see the NO CAP note further down) and the prose was left
 * behind, so this header asserted a bound the code had stopped applying.
 *
 * The durable region is therefore UNBOUNDED, deliberately, and saying otherwise
 * here misdescribes the single most important limitation of the study that uses
 * it. Measured on orchestrate: arm M grows 209.6 tokens/turn, crosses the
 * 24,000 ceiling at turn ~116, and projects to ~41,594 tokens at turn 200 —
 * 173% of the cap the accumulating arm is held to. See research/STUDY_CAVEATS.md;
 * this is a limitation to report, not a bug to patch.
 */
/** Whitespace- and case-insensitive, so trivial restatements collapse too. */
function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Decisions carried in from earlier runs on the same product.
 *
 * Labelled, not merged. The agent must be able to tell "I settled this in an
 * earlier session on this product" from "I settled this an hour ago", because
 * the two justify different confidence and because a contradiction between them
 * is a thing it should notice rather than smooth over. Merging them silently
 * would be the memory equivalent of the self-referential CSS variable: it looks
 * fine and quietly means nothing.
 *
 * Empty string when there is no scope, so a run without one renders byte for
 * byte what it rendered before and every pinned arm signature still matches.
 */
function render_scoped(rows: DecisionRow[]): string {
  if (rows.length === 0) return '';
  const seen = new Set<string>();
  const unique: DecisionRow[] = [];
  for (const d of rows) {
    const key = normalise(d.text);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(d);
  }
  const lines = unique.map((d) => `- ${d.text}`).join('\n');
  return `FROM EARLIER SESSIONS ON THIS PRODUCT (${unique.length}) — still binding `
    + `unless you explicitly supersede them:\n${lines}\n\nTHIS RUN:\n`;
}

/**
 * ARM MV: mark a decision whose claims are not backed by the workspace.
 *
 * Measured 2026-09-09 on operate/GLM-5.3: of arm B's fabricated symbols, 16 of
 * 22 (73%) for the accumulating arm traced back to the run's own decision text,
 * and 44 of 44 (100%) for the re-projecting arm did. Fisher exact p=0.0008.
 * Re-projection does not invent things. It re-renders its own plans every turn
 * until they read as established fact, because the durable region has no way to
 * say "decided" as distinct from "exists".
 *
 * `verify_run_id` non-null turns that distinction on. It reuses extract_claims,
 * the same predicate the 44/44 figure was measured with, so the mechanism and
 * the metric cannot drift apart -- which is this repo's most common defect.
 *
 * Nothing is hidden or dropped. The decision is still rendered in full; it is
 * annotated. Removing it would discard a real intention, and eviction is a
 * separate question with its own evidence.
 */
function render_decisions(rows: DecisionRow[], verify_run_id: string | null = null): string {
  if (rows.length === 0) {
    return '(none yet — nothing has been recorded as binding)';
  }

  // Deterministic: iterate in seq order, keep the first occurrence of each.
  const seen = new Set<string>();
  const unique: DecisionRow[] = [];
  for (const d of rows) {
    const key = normalise(d.text);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(d);
  }

  // NO CAP. There was one, a hand-chosen 40, and it was removed rather than
  // tuned.
  //
  // CORRECTED 2026-09-09: it DID bind, on the sets added after this was written.
  // Across every run ever recorded, the most live decisions any task has
  // held is 121 on orchestrate and 42 on site (measured 2026-09-09). The "26"
  // this comment carried was rainwater's max and was correct when written, then
  // never revisited as decision-heavy sets were added. DECISION_CAP=40 WOULD
  // have bound - on two task sets, one of them by 3x - so "it never bound,
  // therefore untested code" is no longer the justification for removing it.
  // Not re-introducing it here: that changes what the agent sees and would
  // unpool the cell in flight. Recorded so the decision gets re-made on the
  // real number rather than inherited from a stale one.
  // that would have fired for the first time on the site set — the first task
  // set built to accumulate decisions — and fired arbitrarily.
  //
  // Its eviction rule was also backwards for this workload. Dropping the OLDEST
  // decisions discards the foundational ones: the palette, the pricing
  // structure, the exported names that every later module depends on. Recency
  // is the wrong ordering when the early decisions are the binding ones.
  //
  // The honest consequence is that Arm B's durable region is unbounded again,
  // which is the run-3 condition. That is deliberate. If it grows without limit
  // on the site set, that is a measured result that justifies designing an
  // eviction policy against evidence, instead of guessing a constant and
  // discovering years later that it never ran.
  //
  // Dedup stays: a verbatim restatement carries no information at any size.
  const dupes = rows.length - unique.length;
  const body = unique.map((d, i) => {
    const line = `D${i + 1}. (${d.id}) [${d.created_at}] ${d.text}`;
    if (!verify_run_id) return line;
    // TWO SIGNALS, because the symbol one alone is not reliable.
    //
    // extract_claims only flags a symbol written as a CALL and exported by
    // nothing. Measured on the armsig fixture: `reconcileLedger()` is caught,
    // `tokenize(text)` is not — symbols_in takes the argument, so the function
    // never reaches unknown_calls. A check that fires on one phrasing and not
    // the other would mark decisions arbitrarily.
    //
    // A named FILE that is not in the workspace is unambiguous and is the thing
    // the agent can act on: it either wrote lib/ledger.ts or it did not. No path
    // list is hardcoded — lines_of reads whatever this run actually produced.
    const missing_files = [...new Set(
      (d.text.match(PATH_RE_G) ?? []).filter((f) => lines_of(f, verify_run_id) === null),
    )];
    const absent = [...new Set([
      ...missing_files,
      ...extract_claims(d.text, d.task_id, 0, verify_run_id)
        .filter((c) => c.verdict === 'hallucinated')
        .map((c) => c.symbol),
    ])];
    if (absent.length === 0) return line;
    return `${line}\n    NOT YET BUILT - this names ${absent.join(', ')}, which ${absent.length === 1 ? 'is' : 'are'} not in the workspace. Treat it as an intention you have not carried out, not as something that exists.`;
  }).join('\n');
  return dupes > 0
    ? `${body}\n(${dupes} duplicate${dupes === 1 ? '' : 's'} collapsed.)`
    : body;
}

/**
 * The fields of a task spec the agent is shown — and ONLY these.
 *
 * Shared with the run loop because the two arms must present the task
 * identically; the treatment is context management, not task presentation.
 * Arm A rendered the whole spec object while arm B named three fields, which
 * was harmless only for as long as the spec had exactly three fields. Adding
 * `min_children` would have put the required subtask count in arm A's prompt
 * as a hint and left it out of arm B's — an arm difference that has nothing to
 * do with the hypothesis.
 */
export function task_spec_view(spec: any) {
  return { title: spec?.title, detail: spec?.detail, acceptance: spec?.acceptance };
}

function render_task(task: TaskRow, ancestry: TaskRow[]): string {
  const trail = ancestry.length
    ? ancestry.map((a) => a.spec.title).join(' > ') + ' > ' + task.spec.title
    : task.spec.title;
  return [
    `Path: ${trail}`,
    '',
    stable_json(task_spec_view(task.spec)),
  ].join('\n');
}

const SLOT_HEADINGS: Record<SlotKey, string> = {
  gold: 'Gold context (exactly what this task depends on)',
  goal: 'Run goal',
  constraints: 'Standing constraints (binding, apply for the whole run)',
  decisions: 'Live decisions (binding)',
  reads: 'Documents already read this run (do not re-read)',
  task: 'Current task',
};

/**
 * The tail, rebuilt from journal payloads.
 *
 * Each journalled step carries the exact messages it appended, so replaying is
 * concatenation rather than reinterpretation. That keeps the reconstructed tail
 * byte-identical to what was actually sent, which matters: if replay differed
 * even in whitespace, every post-retry call would miss the cache and the cost
 * curve would be measuring my serialiser instead of the context strategy.
 */
/**
 * The tail, with the tool-pairing invariant enforced.
 *
 * Every `tool` message must follow an assistant message carrying the matching
 * tool_call; the API rejects the request otherwise. Concatenating journalled
 * steps blindly does not guarantee that — an assistant step missing from the
 * journal, or a tool result written when its model_call never landed, leaves
 * orphaned tool messages behind.
 *
 * DEFENSIVE, NOT A FIX FOR ANYTHING OBSERVED. Four cells died with "Bad
 * Request", all on B and BR, and orphaned pairing was the first hypothesis. It
 * was wrong: across 83 task contexts and 769 tool messages this filter drops
 * ZERO. Measuring what the change removed, rather than trusting that it
 * removed something, is the only reason that is known.
 *
 * The leading hypothesis is now size. B_w1 assembles 340 messages for a single
 * task, because the tail is discarded at task BOUNDARIES and a task that runs
 * 60 turns accumulates the lot — the same unbounded-growth shape that broke
 * arm B in run 3, just inside a task instead of across them.
 *
 * The invariant is still worth enforcing: it is cheap, and a tool result whose
 * call is absent cannot be interpreted anyway.
 */
function render_tail(steps: StepRow[]): Msg[] {
  const raw: Msg[] = [];
  for (const s of steps) {
    const msgs = s.payload?.messages;
    if (Array.isArray(msgs)) raw.push(...(msgs as Msg[]));
  }

  const out: Msg[] = [];
  let offered = new Set<string>();
  for (const m of raw) {
    const role = (m as any).role;
    const content: any = (m as any).content;
    if (role === 'assistant') {
      offered = new Set(
        Array.isArray(content)
          ? content.filter((p: any) => p?.type === 'tool-call' && p.toolCallId).map((p: any) => String(p.toolCallId))
          : [],
      );
      out.push(m);
    } else if (role === 'tool') {
      const ids = Array.isArray(content)
        ? content.filter((p: any) => p?.toolCallId).map((p: any) => String(p.toolCallId))
        : [];
      // Keep only results whose call was actually offered by the assistant
      // message immediately preceding them.
      if (ids.length > 0 && ids.every((id: string) => offered.has(id))) out.push(m);
    } else {
      out.push(m);
    }
  }
  return out;
}

// ------------------------------------------------------------------ main

export async function assemble(sql: Sql, run_id: string, task_id: string): Promise<Assembled> {
  const run = await read_run(sql, run_id);
  const task = await read_task(sql, run_id, task_id);

  const [decisions, tail_steps, ancestry, constraints, ledger, prior] = await Promise.all([
    read_live_decisions(sql, run_id, task.decision_watermark),
    read_tail(sql, run_id, task_id),
    read_ancestry(sql, run_id, task_id),
    read_constraints(sql, run_id),
    read_ledger(sql, run_id, task.read_watermark),
    read_scope_decisions(sql, run_id, (run as any).scope ?? null),
  ]);

  const bodies: Record<SlotKey, string> = {
    goal: render_goal(run),
    constraints: render_constraints(constraints),
    decisions: render_scoped(prior) + render_decisions(decisions, run.arm === 'MV' ? run_id : null),
    reads: render_reads(ledger),
    task: render_task(task, ancestry),
    gold: run.arm === 'O' ? oracle_block(run_id, task.spec, run.task_set) : '',
  };

  // Fixed order from the module constant. Never sorted by data, never reordered.
  const order = run.arm === 'O' ? ORACLE_SLOT_ORDER : SLOT_ORDER;
  const slots: Slot[] = order.map((key) => ({ key, heading: SLOT_HEADINGS[key], body: bodies[key] }));

  const durable = slots.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n');
  const tail = render_tail(tail_steps);

  const prefix = prefix_for(surface_for(run.arm));
  const messages: Msg[] = [
    { role: 'system', content: prefix },
    { role: 'user', content: durable },
    ...tail,
  ];

  const tail_chars = tail.reduce((n, m) => n + JSON.stringify(m).length, 0);

  return {
    messages,
    slots,
    diagnostics: {
      prefix_fingerprint: await fingerprint(prefix),
      durable_fingerprint: await fingerprint(durable),
      prefix_chars: prefix.length,
      durable_chars: durable.length,
      tail_chars,
      tail_messages: tail.length,
      live_decisions: decisions.length,
      live_constraints: constraints.length,
      ledger_entries: ledger.length,
      decision_watermark: task.decision_watermark,
    },
  };
}
