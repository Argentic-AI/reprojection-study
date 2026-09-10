/**
 * Run-level health: does this cell look like a cell that worked?
 *
 * WHY THIS AND NOT MORE ASSERTIONS. Conformance checks assert things already
 * known to break. Every failure on the provider move was an unknown-unknown at
 * the time the previous gate was written, and the next one lands in whichever
 * layer was not enumerated — which has now happened twice. Input assertions
 * catch known modes and cannot catch novel ones by construction.
 *
 * What generalises is checking the OUTPUT. All three failures shared one
 * signature: a cell that died or degraded while every metric reported healthy.
 * Each is visible in the run's own observable distributions without anyone
 * having predicted it:
 *
 *   max_tokens too small   -> finish_reason "length" at a nonzero rate
 *   permissive tool choice -> turns with zero tool calls that are not completions
 *   arm/task incompatible  -> a cell that never starts
 *   provider degradation   -> retries per call, or turns that never land
 *
 * None of these needed to be anticipated. They are all answers to one question:
 * does this run's shape resemble a run that worked?
 *
 * The eighth failure showed the limit of measuring only PROCESS. A spawn
 * argument-shape mismatch created every subtask empty, so a cell spawned 39
 * subtasks, wrote zero of thirteen modules, and looked healthy on every process
 * metric: tool calls per turn were fine, finish reasons were fine, tasks closed.
 * What was impossible was the OUTPUT — a site cell that writes no modules
 * cannot have worked, whatever the process looked like.
 *
 * So health is checked against declared expectations per task set as well. This
 * needs no theory of the failure, only a statement of what a finished cell
 * contains, and it catches any cause that ends in the wrong artifacts.
 */

/** What a cell that did its job leaves behind. */
const EXPECTED: Record<string, { modules: number; label: string }> = {
  site: { modules: 13, label: '13 site modules' },
  build: { modules: 7, label: '7 library modules' },
  operate: { modules: 13, label: '13 Next.js files' },
};

import { connect } from '../src/db.ts';

const sql = connect();
const ONLY = process.env.STUDY_TASK_SET ?? null;

type Row = {
  run_id: string; task_set: string; arm: string; status: string;
  turns: number; lengths: number; toolless: number; completions: number;
  at_cap: number; cached_turns: number; retries: number; max_out: number;
  created: number; completed: number; wall_ms: number; budget_ms: number | null;
};

const rows = await sql<Row[]>`
  select r.id run_id, r.task_set, r.arm, r.status,
    count(*)::int turns,
    count(*) filter (where s.payload->>'finish_reason' = 'length')::int lengths,
    count(*) filter (where jsonb_array_length(coalesce(s.payload->'tool_calls','[]'::jsonb)) = 0)::int toolless,
    -- NOT a string match on the payload: JSONB renders "name": "complete" with
    -- a space, so like '%"name":"complete"%' silently matched nothing and this
    -- check reported "no task ever completed" for runs holding 8 closed tasks
    -- and 7 written files. An instrument with a false positive is worse than
    -- none, because it trains you to ignore it.
    0::int completions,
    count(*) filter (where s.tokens_out >= 16384)::int at_cap,
    count(*) filter (where s.cached_tokens > 0)::int cached_turns,
    coalesce(sum((s.payload->>'retries')::int), 0)::int retries,
    coalesce(max(s.tokens_out), 0)::int max_out,
    coalesce((r.notes->'summary'->>'tasks_created')::int, 0) created,
    coalesce((r.notes->'summary'->>'tasks_completed')::int, 0) completed,
    coalesce((r.notes->'summary'->>'wall_ms')::bigint, 0) wall_ms,
    (r.notes->>'max_ms')::bigint budget_ms
  from runs r join steps s on s.run_id = r.id and s.kind = 'model_call'
  where (${ONLY}::text is null or r.task_set = ${ONLY})
  group by r.id, r.task_set, r.arm, r.status, r.notes order by r.task_set, r.arm, r.id`;

if (rows.length === 0) {
  console.log('no cells with model calls yet');
  await sql.end(); process.exit(0);
}

console.log('run          set    arm  turns  length%  toolless%  cache%  retries  verdict');
let unhealthy = 0;

for (const r of rows) {
  const pct = (n: number) => (r.turns ? Math.round((100 * n) / r.turns) : 0);
  const reasons: string[] = [];

  // Truncated before acting. The harness starved the model, not the reverse.
  if (r.lengths > 0) reasons.push(`${pct(r.lengths)}% truncated (raise MAX_OUTPUT_TOKENS)`);
  // A turn with no tool call changes no state. A few are tolerable; a majority
  // means the model is not driving the loop at all.
  if (pct(r.toolless) > 25) reasons.push(`${pct(r.toolless)}% of turns did nothing`);
  // Prefix caching should engage after turn 1. Never engaging means the prefix
  // is moving between turns, which silently ends exact replay.
  if (r.turns > 2 && r.cached_turns === 0) reasons.push('cache never engaged — is the prefix stable?');
  // Retries are transient failures; a high rate means the endpoint is degrading
  // and wall-clock estimates are meaningless.
  if (r.retries > r.turns) reasons.push(`${r.retries} retries over ${r.turns} turns`);
  // OUTPUT, not process. A cell that closes tasks while producing none of the
  // artifacts the task set is defined by has not done the work, regardless of
  // how healthy every process metric looks.
  const exp = EXPECTED[r.task_set];
  const [a] = await sql<{ files: number; empty_tasks: number; done: number }[]>`
    select (select count(*) from created_artifacts x where x.run_id = ${r.run_id} and x.kind = 'file')::int files,
           (select count(*) from tasks t where t.run_id = ${r.run_id} and coalesce(t.spec->>'title','') = '')::int empty_tasks,
           (select count(*) from tasks t where t.run_id = ${r.run_id} and t.status = 'done')::int done`;
  const done = a?.done ?? 0;
  if (r.turns >= 10 && done === 0) reasons.push('no task ever completed');
  if (exp) {
    // OUTPUT, not process. A cell that closes tasks while producing none of the
    // artifacts the task set is defined by has not done the work, however
    // healthy every process metric looks.
    if (done > 0 && (a?.files ?? 0) === 0) reasons.push(`closed ${done} task(s) but wrote 0 of ${exp.label}`);
    if ((a?.empty_tasks ?? 0) > 0) reasons.push(`${a!.empty_tasks} subtask(s) with no title — unactionable`);
  }

  // BUDGET TRUNCATION — a cell that spent its whole wall-clock allowance without
  // finishing its work is 'done' in the runs table and is NOT comparable to a
  // cell that ran to completion. This has now bitten three times in different
  // clothes: a cell cut off at exactly MAX_MS under queue contention, a cell
  // whose MAX_MS elapsed while the machine was suspended, and four site cells
  // that burned 45-60 minutes managing 6-12 turns during a provider slowdown
  // and were recorded 'done' having completed 2 of 14 tasks. Every process
  // metric on those reads healthy.
  const created = r.created, completed = r.completed;
  const wall_min = r.wall_ms / 60_000;
  // The RUN's own recorded budget, never the checker's environment. Reading it
  // from process.env flagged a cell launched with MAX_MS=90m as truncated at
  // "48m of a 45m allowance" — it had hit the TURN cap. A false positive in a
  // health check is worse than no check, because it trains you to skim.
  const budget_min = (r.budget_ms ?? Number(process.env.MAX_MS ?? 45 * 60_000)) / 60_000;
  const budget_known = r.budget_ms != null;
  if (created > 0 && completed < created && wall_min >= budget_min * 0.95) {
    reasons.push(`budget-truncated: ${completed}/${created} tasks in ${wall_min.toFixed(0)}m `
      + `of a ${budget_min.toFixed(0)}m allowance${budget_known ? '' : ' (assumed — run did not record one)'}`
      + ` — re-run, do not pool`);
  }

  if (reasons.length) unhealthy++;
  console.log(
    `${r.run_id.padEnd(12)} ${r.task_set.padEnd(6)} ${r.arm.padEnd(4)} ${String(r.turns).padStart(5)} `
    + `${String(pct(r.lengths)).padStart(7)} ${String(pct(r.toolless)).padStart(10)} `
    + `${String(pct(r.cached_turns)).padStart(6)} ${String(r.retries).padStart(8)}  `
    + (reasons.length ? `SUSPECT: ${reasons.join('; ')}` : 'ok'));
}

/**
 * TURN-SEQUENCE INTEGRITY, which the stall retry depends on and nothing pinned.
 *
 * When the endpoint does not answer, run.ts records a `stall`, rolls back both
 * `turn` and `task_turns`, and repeats the same turn. The rollback is the part
 * that can go wrong silently: leave the counters incremented and a stalling
 * provider quietly shortens every run instead of failing it, spending the turn
 * budget on turns that produced nothing. Nothing would report that - the run
 * would simply end earlier, and look like a run that finished.
 *
 * The invariant is checkable from the rows: model_call turn numbers must be
 * contiguous from 1 with no gaps and no duplicates, however many stalls
 * occurred. Verified on M_d1, which stalled once at turn 82 and retried it:
 * turns 1..161, no gaps, no duplicates, exactly one model_call row at turn 82.
 */
console.log('\nTURN-SEQUENCE INTEGRITY (the stall retry must not consume turn numbers)');
const seq = await sql<{ run_id: string; turns: number[]; stalls: number }[]>`
  select s.run_id,
         array_agg(distinct s.turn order by s.turn) filter (where s.kind = 'model_call') as turns,
         count(*) filter (where s.kind = 'stall')::int as stalls
  from steps s join runs r on r.id = s.run_id
  where r.id not like 'test\_%' escape '\\'
  group by s.run_id having count(*) filter (where s.kind = 'stall') > 0`;
if (!seq.length) {
  console.log('  no run has stalled yet — the rollback is unexercised, not verified');
} else {
  for (const r of seq) {
    const t = r.turns ?? [];
    const gaps: string[] = [];
    for (let i = 1; i < t.length; i++) if (t[i] !== t[i - 1]! + 1) gaps.push(`${t[i - 1]}->${t[i]}`);
    const [dup] = await sql<{ n: number }[]>`
      select count(*)::int as n from (
        select turn from steps where run_id = ${r.run_id} and kind = 'model_call'
        group by turn having count(*) > 1) x`;
    const ok = gaps.length === 0 && (dup?.n ?? 0) === 0;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${r.run_id}: ${t.length} turns, ${r.stalls} stall(s), `
      + `${gaps.length} gap(s)${gaps.length ? ' ' + gaps.join(',') : ''}, ${dup?.n ?? 0} duplicate turn number(s)`);
    if (!ok) console.log('       a stall consumed a turn number — the run was silently shortened');
  }
}

console.log(`\n${rows.length - unhealthy}/${rows.length} cells look like runs that worked.`);
if (unhealthy) {
  console.log('A suspect cell is not necessarily a bad agent — it is more often a bad harness,');
  console.log('and every harness fault found so far reported healthy on every other metric.');
}
await sql.end();
process.exit(0);
