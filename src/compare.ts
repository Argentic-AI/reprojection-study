/**
 * The comparison runner and report.
 *
 * Two modes:
 *   run     execute both arms N times over the same task set
 *   report  analyse whatever is already in the journal
 *
 * The report derives EVERYTHING from the `steps` and `decisions` tables rather
 * than from the in-memory run summary. Two reasons: an interrupted run still
 * reports (which matters, given the free tier's throttling), and the adherence
 * classification can be re-run after the fact without re-running the experiment.
 */

import { connect, type Sql } from './db.ts';
import { run_one } from './run.ts';
import { resumable_runs } from './resume.ts';
import type { Arm } from './db.ts';
import { is_adherent, is_adherent_decision, detect_promotion, CONSTRAINT_TURN } from './constraint.ts';
import { stable_json } from './canonical.ts';
import { similar_pairs, embeddings_configured } from './similarity.ts';

type TurnPoint = {
  turn: number;
  tokens_in: number;
  tokens_out: number;
  cached: number;
  latency_ms: number;
  retries: number;
};

type RunReport = {
  run_id: string;
  arm: Arm;
  turns: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cached: number;
  /** Input tokens actually billed as uncached. The honest cost number. */
  total_uncached_in: number;
  cache_ratio: number;
  wall_ms: number;
  retries: number;
  truncations: number;
  tasks_created: number;
  tasks_completed: number;
  completion_rate: number;
  spawns: number;
  adherent_spawns: number;
  decides: number;
  adherent_decides: number;
  reads_total: number;
  redundant_reads: number;
  redundant_read_tokens: number;
  redundant_read_doc_tokens: number;
  per_read_context_tokens: number;
  tokens_per_completed_task: number | null;
  redundant_read_share: number;
  decisions_total: number;
  decisions_per_task: number;
  turns_per_decision: number | null;
  tasks_entered: number;
  rederivations: number;
  rederivation_tokens: number;
  similarity_backend: string;
  pre_constraint_spawns: number;
  injected_turn: number | null;
  turns_with_constraint: number;
  adherent_while_present: number;
  spawns_while_present: number;
  first_violation_turn: number | null;
  constraint_promoted_at_turn: number | null;
  curve: TurnPoint[];
};

async function report_run(sql: Sql, run_id: string): Promise<RunReport> {
  const [run] = await sql<{ arm: Arm; notes: any; started_at: string; finished_at: string | null }[]>`
    select arm, notes, started_at::text, finished_at::text from runs where id = ${run_id}`;
  if (!run) throw new Error(`no run ${run_id}`);

  const calls = await sql<TurnPoint[]>`
    select turn, tokens_in, tokens_out, cached_tokens as cached, latency_ms, retries
    from steps where run_id = ${run_id} and kind = 'model_call' and turn is not null
    order by turn asc`;

  const spawn_rows = await sql<{ turn: number; payload: any }[]>`
    select turn, payload from steps
    where run_id = ${run_id} and kind = 'tool_call' and payload->>'name' = 'spawn'
    order by turn asc`;

  const truncs = await sql<{ n: string }[]>`
    select count(*)::text as n from steps
    where run_id = ${run_id} and kind = 'probe' and payload ? 'dropped_messages'`;

  // The turn the constraint was ACTUALLY delivered, from the journal. Scoring
  // against the nominal CONSTRAINT_TURN reports a confident 0% for a run that
  // never received the constraint at all.
  // How many turns actually carried the constraint in-context, and did the
  // agent obey it on those turns? This separates architectural loss from
  // plain non-compliance — the two have completely different implications.
  const presence = await sql<{ turn: number; present: boolean }[]>`
    select turn, coalesce((payload->>'constraint_present')::boolean, false) as present
    from steps where run_id = ${run_id} and kind = 'model_call' and turn is not null
    order by turn asc`;
  const turns_with_constraint = presence.filter((p) => p.present).length;
  const present_turns = new Set(presence.filter((p) => p.present).map((p) => p.turn));

  const [inj] = await sql<{ turn: number }[]>`
    select turn from steps where run_id = ${run_id}
      and payload->>'note' = 'constraint injection' order by turn asc limit 1`;
  const injected_turn: number | null = inj?.turn ?? null;

  const decisions = await sql<{ text: string; task_id: string }[]>`
    select d.text, d.task_id from decisions d where d.run_id = ${run_id} order by d.seq asc`;

  const tasks = await sql<{ total: string; done: string }[]>`
    select count(*)::text as total, count(*) filter (where status = 'done')::text as done
    from tasks where run_id = ${run_id}`;

  // Promotion turn: find the model_call turn on which the promoting decide() fired.
  let promoted_at: number | null = null;
  for (const d of decisions) {
    if (!detect_promotion(d.text)) continue;
    const [row] = await sql<{ turn: number }[]>`
      select turn from steps where run_id = ${run_id} and kind = 'tool_call'
        and payload->>'name' = 'decide' and payload->'args'->>'text' = ${d.text}
      order by turn asc limit 1`;
    promoted_at = row?.turn ?? null;
    break;
  }

  // Only spawns from the ACTUAL injection turn onward can violate the
  // constraint. Counting earlier ones — or any at all when injection never
  // fired — scores the model against a rule it was never given.
  let spawns = 0, adherent = 0, first_violation: number | null = null;
  let pre_constraint_spawns = 0;
  let adherent_while_present = 0, spawns_while_present = 0;
  for (const s of spawn_rows) {
    const title = String(s.payload?.args?.spec?.title ?? '');
    if (!title) continue;
    if (injected_turn === null || s.turn < injected_turn) { pre_constraint_spawns++; continue; }
    spawns++;
    const ok = is_adherent(title);
    if (ok) adherent++;
    else if (first_violation === null) first_violation = s.turn;
    if (present_turns.has(s.turn)) { spawns_while_present++; if (ok) adherent_while_present++; }
  }

  // Rule 2: decide() tags. Same window rule as spawns.
  const decide_rows = await sql<{ turn: number; payload: any }[]>`
    select turn, payload from steps
    where run_id = ${run_id} and kind = 'tool_call' and payload->>'name' = 'decide'
    order by turn asc`;
  let decides = 0, adherent_decides = 0;
  for (const d of decide_rows) {
    const text = String(d.payload?.args?.text ?? '');
    if (!text) continue;
    if (injected_turn === null || d.turn < injected_turn) continue;
    decides++;
    const ok = is_adherent_decision(text);
    if (ok) adherent_decides++;
    else if (first_violation === null || d.turn < first_violation) first_violation = d.turn;
  }

  // ---- Metric 1: redundant reads ------------------------------------------
  // Same path read in more than one task within a run. Under re-projection the
  // tail is discarded at each boundary, so a later task cannot see what an
  // earlier one read — it must read again. That re-read is the hidden cost of
  // the token saving, and if it approaches the saving the cost result is
  // thinner than the headline suggests.
  const reads = await sql<{ path: string; task_id: string; turn: number; tokens: number }[]>`
    select args->>'path' as path, task_id, turn, tokens
    from tool_results where run_id = ${run_id} and tool = 'read'
    order by turn asc`;
  // What a read actually costs in CONTEXT is the pointer summary, not the
  // document. Counting the document (~2500 tokens) instead of the summary
  // (~73) overstates the overhead by ~25x and inverts the net conclusion.
  const [ctx_row] = await sql<{ avg_chars: number }[]>`
    select coalesce(avg(length(payload->>'result')), 0)::int as avg_chars
    from steps where run_id = ${run_id} and kind = 'tool_call' and payload->>'name' = 'read'`;
  const per_read_context_tokens = Math.round((ctx_row?.avg_chars ?? 0) / 4);

  const first_task_for_path = new Map<string, string>();
  let redundant_reads = 0, redundant_read_doc_tokens = 0;
  for (const r of reads) {
    const seen = first_task_for_path.get(r.path);
    if (seen === undefined) { first_task_for_path.set(r.path, r.task_id ?? ''); continue; }
    if (seen !== (r.task_id ?? '')) {
      redundant_reads++;
      redundant_read_doc_tokens += r.tokens;   // notional: the document
    }
  }
  const redundant_read_tokens = redundant_reads * per_read_context_tokens; // real: context

  // ---- Metric 3: decision-writing discipline -------------------------------
  // If the agent rarely writes decisions, re-projection is discarding work
  // rather than compressing it — and that shows up as re-derivation.
  const tasks_entered = new Set(calls.map((c) => c.turn)).size ? await sql<{ n: string }[]>`
    select count(distinct task_id)::text as n from steps
    where run_id = ${run_id} and kind = 'model_call' and task_id is not null` : [{ n: '0' }];
  const entered = Number(tasks_entered[0]?.n ?? 0);
  const all_decisions = await sql<{ id: string; task_id: string; text: string }[]>`
    select id, task_id, text from decisions where run_id = ${run_id} order by seq asc`;
  const decisions_per_task = entered ? all_decisions.length / entered : 0;
  const turns_per_decision = all_decisions.length ? calls.length / all_decisions.length : null;

  // ---- Metric 2: re-derivation ---------------------------------------------
  // The same conclusion reached in more than one task. Under re-projection a
  // later task cannot see an earlier task's reasoning, only its promoted
  // decisions — so a conclusion the agent failed to promote may be worked out
  // again from scratch. Pairs are flagged only when written in DIFFERENT
  // tasks; two similar decisions inside one task are elaboration, not rework.
  // Threshold defaults are calibrated per backend inside similarity.ts.
  const SIM_THRESHOLD = process.env.REDERIVATION_THRESHOLD ? Number(process.env.REDERIVATION_THRESHOLD) : undefined;
  const sim = await similar_pairs(all_decisions.map((d) => d.text), SIM_THRESHOLD);
  const rederivations: { a: string; b: string; score: number; tokens_before: number }[] = [];
  const rederivation_turns = new Set<number>();
  for (const pr of sim.pairs) {
    const A = all_decisions[pr.i]!, B = all_decisions[pr.j]!;
    if (A.task_id === B.task_id) continue;
    // Tokens spent in the turns preceding the duplicate: the cost of redoing
    // work whose answer already existed in the journal.
    const [row] = await sql<{ turn: number }[]>`
      select turn from steps where run_id = ${run_id} and kind = 'tool_call'
        and payload->>'name' = 'decide' and payload->'args'->>'text' = ${B.text}
      order by turn asc limit 1`;
    const dup_turn = row?.turn ?? null;
    let tokens_before = 0;
    if (dup_turn !== null) {
      const prior = calls.filter((c) => c.turn < dup_turn && c.turn >= dup_turn - 3);
      tokens_before = prior.reduce((n, c) => n + (c.tokens_in || 0), 0);
      for (const c of prior) rederivation_turns.add(c.turn);
    }
    rederivations.push({ a: A.text.slice(0, 70), b: B.text.slice(0, 70), score: pr.score, tokens_before });
  }
  // Sum each implicated turn ONCE. Summing per-pair double-counts: with 925
  // flagged pairs over 70 decisions the same handful of turns was counted
  // hundreds of times, producing 65.5M "re-derivation tokens" against a run
  // whose entire input was 1.57M. A cost that exceeds the total cost is not a
  // cost, it is an arithmetic error.
  const rederivation_tokens = calls
    .filter((c) => rederivation_turns.has(c.turn))
    .reduce((n, c) => n + (c.tokens_in || 0), 0);

  const sum = (f: (t: TurnPoint) => number) => calls.reduce((n, t) => n + (f(t) || 0), 0);
  const total_in = sum((t) => t.tokens_in);
  const total_cached = sum((t) => t.cached);
  const total_tasks = Number(tasks[0]?.total ?? 0);
  const done_tasks = Number(tasks[0]?.done ?? 0);
  const wall = run.finished_at
    ? Date.parse(run.finished_at) - Date.parse(run.started_at)
    : (calls.length ? sum((t) => t.latency_ms) : 0);

  return {
    run_id, arm: run.arm,
    turns: calls.length,
    total_tokens_in: total_in,
    total_tokens_out: sum((t) => t.tokens_out),
    total_cached,
    total_uncached_in: total_in - total_cached,
    cache_ratio: total_in ? total_cached / total_in : 0,
    wall_ms: wall,
    retries: sum((t) => t.retries),
    truncations: Number(truncs[0]?.n ?? 0),
    tasks_created: total_tasks,
    tasks_completed: done_tasks,
    completion_rate: total_tasks ? done_tasks / total_tasks : 0,
    spawns, adherent_spawns: adherent, decides, adherent_decides, pre_constraint_spawns, injected_turn,
    reads_total: reads.length,
    redundant_reads,
    redundant_read_tokens,
    redundant_read_doc_tokens,
    per_read_context_tokens,
    tokens_per_completed_task: done_tasks ? total_in / done_tasks : null,
    redundant_read_share: total_in ? redundant_read_tokens / total_in : 0,
    decisions_total: all_decisions.length,
    decisions_per_task,
    turns_per_decision,
    tasks_entered: entered,
    rederivations: rederivations.length,
    rederivation_tokens,
    similarity_backend: sim.backend,
    turns_with_constraint, adherent_while_present, spawns_while_present,
    first_violation_turn: first_violation,
    constraint_promoted_at_turn: promoted_at,
    curve: calls,
  };
}

// ------------------------------------------------------------------ output

function sparkline(values: number[], width = 48): string {
  if (!values.length) return '';
  const blocks = '▁▂▃▄▅▆▇█';
  const step = Math.max(1, Math.ceil(values.length / width));
  const binned: number[] = [];
  for (let i = 0; i < values.length; i += step) {
    const slice = values.slice(i, i + step);
    binned.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  const max = Math.max(...binned), min = Math.min(...binned);
  const span = max - min || 1;
  return binned.map((v) => blocks[Math.min(7, Math.floor(((v - min) / span) * 7))]).join('');
}

function print_report(reports: RunReport[]) {
  const by_arm = (a: Arm) => reports.filter((r) => r.arm === a);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  console.log('\n' + '='.repeat(78));
  console.log('PER-RUN TOTALS');
  console.log('='.repeat(78));
  console.table(reports.map((r) => ({
    run: r.run_id, arm: r.arm, turns: r.turns,
    tokens_in: r.total_tokens_in,
    uncached_in: r.total_uncached_in,
    cache: `${(r.cache_ratio * 100).toFixed(1)}%`,
    tokens_out: r.total_tokens_out,
    tasks: `${r.tasks_completed}/${r.tasks_created}`,
    trunc: r.truncations,
    retries: r.retries,
    wall_s: Math.round(r.wall_ms / 1000),
  })));

  console.log('\n' + '='.repeat(78));
  console.log('CONSTRAINT ADHERENCE  (headline metric)');
  console.log('='.repeat(78));
  console.table(reports.map((r) => ({
    run: r.run_id, arm: r.arm,
    injected_turn: r.injected_turn ?? 'NEVER INJECTED',
    titles: r.injected_turn === null ? 'n/a' : `${r.adherent_spawns}/${r.spawns}`,
    decide_tags: r.injected_turn === null ? 'n/a' : `${r.adherent_decides}/${r.decides}`,
    pre_c: r.pre_constraint_spawns,
    rate: (() => {
      if (r.injected_turn === null) return 'n/a';
      const n = r.spawns + r.decides, k = r.adherent_spawns + r.adherent_decides;
      return n ? `${((k / n) * 100).toFixed(0)}%` : 'no surface';
    })(),
    'turns_w/constraint': r.turns_with_constraint,
    'adherent_when_present': r.spawns_while_present ? `${r.adherent_while_present}/${r.spawns_while_present}` : 'no spawns',
    first_violation_turn: r.first_violation_turn ?? 'never',
    promoted_at_turn: r.constraint_promoted_at_turn ?? 'NOT PROMOTED',
  })));

  console.log('\n' + '='.repeat(78));
  console.log('IS ARM B ACTUALLY AHEAD?  (the three costs the headline hides)');
  console.log('='.repeat(78));
  console.table(reports.map((r) => ({
    run: r.run_id, arm: r.arm,
    reads: r.reads_total,
    redundant: r.redundant_reads,
    'reread ctx tok': r.redundant_read_tokens,
    '(doc tok)': r.redundant_read_doc_tokens,
    'ctx % of input': `${(r.total_tokens_in ? (r.redundant_read_tokens / r.total_tokens_in) * 100 : 0).toFixed(1)}%`,
    'rederivations': r.rederivations,
    'rederiv tokens': r.rederivation_tokens,
    decisions: r.decisions_total,
    'dec/task': r.decisions_per_task.toFixed(2),
    'turns/dec': r.turns_per_decision === null ? 'never wrote' : r.turns_per_decision.toFixed(1),
  })));
  const backend = reports.find((r) => r.similarity_backend)?.similarity_backend ?? 'lexical';
  // Do not assert WHY it fell back — `embeddings_configured` being true while
  // the backend is lexical means the call failed, not that it was unset, and
  // the earlier wording asserted the wrong cause.
  const why = backend === 'lexical'
    ? (embeddings_configured
        ? '  (embeddings CONFIGURED but the call failed — see the [similarity] line above; lexical cannot see paraphrase)'
        : '  (no embeddings endpoint configured — TF-IDF cosine, deterministic)')
    : '';
  console.log(`similarity backend: ${backend}${why}`);

  // The decisive comparison: does re-read overhead eat the token saving?
  const armA = reports.filter((r) => r.arm === 'A');
  const armB = reports.filter((r) => r.arm === 'B');
  if (armA.length && armB.length) {
    const mA = armA.reduce((n, r) => n + (r.turns ? r.total_uncached_in / r.turns : 0), 0) / armA.length;
    const mB = armB.reduce((n, r) => n + (r.turns ? r.total_uncached_in / r.turns : 0), 0) / armB.length;
    const saving_per_turn = mA - mB;
    const bTurns = armB.reduce((n, r) => n + r.turns, 0) || 1;
    // Only the pointer summaries actually enter context, so only they count here.
    const overhead_per_turn = armB.reduce((n, r) => n + r.redundant_read_tokens, 0) / bTurns;
    console.log(`\nPER TURN`);
    console.log(`  uncached saving        : ${Math.round(saving_per_turn)} tokens/turn (A ${Math.round(mA)} - B ${Math.round(mB)})`);
    console.log(`  redundant-read overhead: ${Math.round(overhead_per_turn)} tokens/turn (pointer summaries only)`);
    const net = saving_per_turn - overhead_per_turn;
    console.log(`  NET                    : ${Math.round(net)} tokens/turn -> ${net > 0 ? 'Arm B ahead per turn' : 'saving eaten by re-work'}`);

    // Per-turn cost is not the question anyone actually cares about. The
    // question is cost per unit of work DELIVERED. An arm that is cheap per
    // turn but needs many more turns to finish anything is not cheaper.
    const perTask = (rs: typeof armA) => {
      const v = rs.map((r) => r.tokens_per_completed_task).filter((x): x is number => x !== null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const tA = perTask(armA), tB = perTask(armB);
    console.log(`\nPER COMPLETED TASK  (the number that decides it)`);
    console.log(`  Arm A: ${tA === null ? 'no tasks completed' : `${Math.round(tA)} tokens/task`}`);
    console.log(`  Arm B: ${tB === null ? 'no tasks completed' : `${Math.round(tB)} tokens/task`}`);
    if (tA !== null && tB !== null) {
      const r = tB / tA;
      console.log(`  ratio: ${r.toFixed(2)}x  -> ${r < 1 ? 'Arm B cheaper per unit of work' : 'Arm A cheaper per unit of work'}`);
    }
    const cA = armA.reduce((n, r) => n + r.tasks_completed, 0), cB = armB.reduce((n, r) => n + r.tasks_completed, 0);
    console.log(`  completed: A ${cA}/${armA.reduce((n, r) => n + r.tasks_created, 0)}  B ${cB}/${armB.reduce((n, r) => n + r.tasks_created, 0)}`);
  }

  console.log('\n' + '='.repeat(78));
  console.log('INPUT TOKENS PER TURN  (the real cost curve)');
  console.log('='.repeat(78));
  for (const r of reports) {
    const ins = r.curve.map((t) => t.tokens_in);
    const unc = r.curve.map((t) => t.tokens_in - (t.cached || 0));
    console.log(`\n${r.run_id} [${r.arm}]  n=${ins.length}  first=${ins[0] ?? 0}  last=${ins.at(-1) ?? 0}  max=${Math.max(0, ...ins)}`);
    console.log(`  total in  ${sparkline(ins)}`);
    console.log(`  uncached  ${sparkline(unc)}`);
    console.log(`  cache %   ${sparkline(r.curve.map((t) => (t.tokens_in ? (t.cached || 0) / t.tokens_in : 0)))}`);
  }

  console.log('\n' + '='.repeat(78));
  console.log('ARM COMPARISON');
  console.log('='.repeat(78));
  const rows: Record<string, Record<string, string | number>> = {};
  for (const a of ['A', 'AP', 'B', 'BP', 'C', 'D'] as Arm[]) {
    const rs = by_arm(a);
    if (!rs.length) continue;
    const firsts = rs.map((r) => r.curve[0]?.tokens_in ?? 0);
    const lasts = rs.map((r) => r.curve.at(-1)?.tokens_in ?? 0);
    rows[`Arm ${a}`] = {
      runs: rs.length,
      mean_turns: Math.round(mean(rs.map((r) => r.turns))),
      // Per-TURN, not per-run: a throttled arm reaches fewer turns, so run
      // totals would compare a short run against a long one.
      in_per_turn: Math.round(mean(rs.map((r) => (r.turns ? r.total_tokens_in / r.turns : 0)))),
      uncached_per_turn: Math.round(mean(rs.map((r) => (r.turns ? r.total_uncached_in / r.turns : 0)))),
      mean_cache_ratio: `${(mean(rs.map((r) => r.cache_ratio)) * 100).toFixed(1)}%`,
      'input_turn1->last': `${Math.round(mean(firsts))} -> ${Math.round(mean(lasts))}`,
      growth: `${(mean(lasts) / Math.max(1, mean(firsts))).toFixed(2)}x`,
      mean_completion: `${(mean(rs.map((r) => r.completion_rate)) * 100).toFixed(0)}%`,
      mean_adherence: (() => {
        const scored = rs.filter((r) => r.injected_turn !== null && (r.spawns + r.decides) > 0);
        return scored.length
          ? `${(mean(scored.map((r) => (r.adherent_spawns + r.adherent_decides) / (r.spawns + r.decides))) * 100).toFixed(0)}%`
          : 'n/a';
      })(),
      first_violation: rs.map((r) => r.first_violation_turn ?? '-').join(','),
      promoted: rs.map((r) => r.constraint_promoted_at_turn ?? '-').join(','),
    };
  }
  console.table(rows);
}

// -------------------------------------------------------------------- main

const sql = connect();
const mode = process.argv[2] ?? 'report';

if (mode === 'resumable') {
  const rows = await resumable_runs(sql);
  if (!rows.length) console.log('No resumable runs.');
  else console.table(rows);
  await sql.end();
  process.exit(0);
}

if (mode === 'resume') {
  const target = process.argv[3];
  if (!target) { console.error('usage: compare.ts resume <run_id>'); process.exit(2); }
  // TASK SET COMES FROM THE JOURNAL, NOT THE ENVIRONMENT.
  //
  // This read `select arm` only, so `opts.task_set` was undefined and run.ts
  // fell back to `TASK_SETS[... ?? 'build']`. A resumed orchestrate cell
  // therefore ran as `build`, and three things died at once, silently:
  //
  //   1. `schedule` came from REVISIONS_BY_SET['build'], which is empty, so
  //      `keep_alive_until` was 0 and the "Continue the programme" refill could
  //      never fire. M_r1 ended the moment its queue emptied at turn 188 — it
  //      did not run out of work, it ran out of permission to make more.
  //   2. No directive could be delivered, so settle_reversal at turn 200 was
  //      unreachable even had the run continued.
  //   3. `directives_scheduled` was 0, so SCHEDULE_INCOMPLETE could not fire and
  //      a cell missing half its schedule recorded as a clean `done`.
  //
  // Reading it from the row removes the failure rather than asking every caller
  // to remember an environment variable. The run already knows what it is.
  const [row] = await sql`select arm, task_set from runs where id = ${target}`;
  if (!row) { console.error(`no run ${target}`); process.exit(2); }
  const resumed_set = (row as any).task_set as string | null;
  console.error(`\n### resuming ${target} (arm ${(row as any).arm}, task set ${resumed_set ?? 'UNRECORDED'})`);
  if (!resumed_set) {
    console.error(`resume: run ${target} has no task_set recorded; refusing rather than defaulting to 'build'.`);
    process.exit(2);
  }
  const s = await run_one(sql, {
    arm: (row as any).arm, run_id: target, resume: true,
    task_set: resumed_set as any,
    max_turns: Number(process.env.MAX_TURNS ?? 120),
    max_ms: Number(process.env.MAX_MS ?? 45 * 60_000),
  });
  print_report([await report_run(sql, s.run_id)]);
  await write_json([await report_run(sql, s.run_id)]);
  await sql.end();
  process.exit(0);
}


if (mode === 'run') {
  const n = Number(process.argv[3] ?? 1);
  const max_turns = Number(process.env.MAX_TURNS ?? 120);
  const max_ms = Number(process.env.MAX_MS ?? 45 * 60_000);
  const ceiling = Number(process.env.CEILING_TOKENS ?? 60_000);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    // Arms run sequentially, not concurrently: the free tier throttles on
    // account-wide concurrency, so parallel arms would contaminate each
    // other's latency and retry counts.
    const arms = (process.env.ARMS ?? 'A,AP,B,D').split(',') as Arm[];
    for (const arm of arms) {
      const run_id = `${arm}${i + 1}_${Date.now().toString(36)}`;
      console.error(`\n### ${run_id} (rep ${i + 1}/${n}, arm ${arm})`);
      try {
        const s = await run_one(sql, { arm, run_id, seed: i + 1, max_turns, max_ms, ceiling_tokens: ceiling });
        ids.push(s.run_id);
      } catch (e: any) {
        console.error(`  run failed: ${String(e?.message).slice(0, 300)}`);
        await sql`update runs set status = 'failed' where id = ${run_id}`;
        ids.push(run_id);
      }
    }
  }
  const reports = [];
  for (const id of ids) reports.push(await report_run(sql, id));
  print_report(reports);
  await write_json(reports);
} else {
  const filter = process.argv[3];
  const rows = filter
    ? await sql<{ id: string }[]>`select id from runs where id like ${`%${filter}%`} order by started_at`
    : await sql<{ id: string }[]>`select id from runs where id not like 'test_%' order by started_at`;
  const reports = [];
  for (const r of rows) {
    try { reports.push(await report_run(sql, r.id)); } catch { /* skip unreadable run */ }
  }
  if (!reports.length) console.log('No runs in the journal yet.');
  else { print_report(reports); await write_json(reports); }
}

async function write_json(reports: RunReport[]) {
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir('out', { recursive: true });
  await writeFile('out/comparison.json', stable_json(reports));
  console.log('\nFull data (including per-turn curves): out/comparison.json');
}

await sql.end();
