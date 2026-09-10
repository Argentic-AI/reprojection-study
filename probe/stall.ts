/**
 * Stalls: consecutive turns whose only tool calls are reads or recalls.
 *
 * Measured, NOT guarded. min_children enforces a criterion the task spec
 * already states; nothing in any spec says "do not read repeatedly", so a
 * guard here would be a new treatment rather than enforcement. It might also
 * destroy the signal: if one arm read-loops more because it has lost track of
 * what it already read, that IS the finding.
 */
import { connect } from '../src/db.ts';
import { classify, is_result } from '../src/terminal.ts';

const PASSIVE = new Set(['read', 'recall']);
const sql = connect();

// This had NO where clause at all. Every run in the table entered the per-arm
// max/mean: four distinct model strings, five task sets, two corpus versions and
// ceilings from 3,500 to 256,000, all summed under one arm label. A stall figure
// pooled across those is not a statistic about an arm, it is a statistic about
// whatever happens to be in the database.
const TASK_SET = process.env.STUDY_TASK_SET ?? null;
const ONLY_MODEL = process.env.STUDY_MODEL ?? null;

const all_runs = await sql<
  { id: string; arm: string; task_set: string; model: string; corpus: string; ceiling: string }[]
>`
  select r.id, r.arm, r.task_set, r.model,
         coalesce(r.notes->>'corpus_version', 'unrecorded') corpus,
         coalesce(r.notes->>'ceiling_tokens', 'unrecorded') ceiling
  from runs r
  where (${TASK_SET}::text is null or r.task_set = ${TASK_SET})
    and (${ONLY_MODEL}::text is null or r.model = ${ONLY_MODEL})
  order by r.started_at`;

const states = new Map((await classify(sql)).map((c) => [c.run_id, c]));
const runs = all_runs.filter((r) => {
  const st = states.get(r.id);
  return !st || is_result(st.terminal);
});
const held = all_runs.length - runs.length;
if (held) console.log(`held out ${held} unfinished or failed cell(s)\n`);

const groups = new Set(runs.map((r) => `${r.task_set}/${r.model}/${r.corpus}/${r.ceiling}`));
if (groups.size > 1) {
  console.log('REFUSING TO POOL — the per-arm summary would span:');
  for (const g of [...groups].sort()) console.log(`  ${g}`);
  console.log('\nNarrow it with STUDY_TASK_SET and STUDY_MODEL.');
  await sql.end();
  process.exit(1);
}
console.log(`${[...groups][0] ?? '(none)'}  n=${runs.length} runs\n`);

console.log('run             set    arm  turns  longest stall  repeat-read turns');
const by_arm = new Map<string, { stalls: number[]; runs: number }>();

for (const r of runs) {
  const steps = await sql<{ turn: number; name: string; path: string | null }[]>`
    select turn, payload->>'name' as name, payload->'args'->>'path' as path
    from steps where run_id = ${r.id} and kind = 'tool_call' order by turn, seq`;
  if (!steps.length) continue;

  const turns = [...new Set(steps.map((s) => s.turn))].sort((a, b) => a - b);
  let longest = 0, cur = 0;
  const seen_paths = new Set<string>();
  let repeat_read_turns = 0;
  for (const t of turns) {
    const calls = steps.filter((s) => s.turn === t);
    const passive = calls.every((c) => PASSIVE.has(c.name));
    cur = passive ? cur + 1 : 0;
    if (cur > longest) longest = cur;
    // A read of a path already read in this run — the pointer-loop signature.
    for (const c of calls) {
      if (c.name !== 'read' || !c.path) continue;
      if (seen_paths.has(c.path)) { repeat_read_turns++; break; }
      seen_paths.add(c.path);
    }
  }
  const a = by_arm.get(r.arm) ?? by_arm.set(r.arm, { stalls: [], runs: 0 }).get(r.arm)!;
  a.stalls.push(longest); a.runs++;
  if (longest >= 3 || repeat_read_turns >= 3) {
    console.log(`  ${r.id.padEnd(15)} ${r.task_set.padEnd(6)} ${r.arm.padEnd(4)} ${String(turns.length).padStart(5)} ${String(longest).padStart(14)} ${String(repeat_read_turns).padStart(18)}`);
  }
}

console.log('\nlongest stall by arm (all runs):');
for (const [arm, v] of [...by_arm].sort()) {
  const max = Math.max(...v.stalls), mean = v.stalls.reduce((x, y) => x + y, 0) / v.stalls.length;
  console.log(`  ${arm.padEnd(4)} ${v.runs} runs   max ${max}   mean ${mean.toFixed(1)}`);
}
await sql.end();
