/**
 * The read side for supersession.
 *
 * WHY THIS EXISTS AT ALL. Every metric the rerun records had, until this file,
 * zero readers: `supersede_calls`, `reversal_delivered_at_task`,
 * `boundary_series`, `params_visible` and `outcome_tags` were all written and
 * none were reported. That is precisely the defect the rerun was built to fix —
 * `superseded_by` was read by four call sites and written by none, and
 * another system's forgetting module was fully tested with zero callers. Recording a
 * metric nothing reads is the same failure with the ends swapped, and it would
 * have been discovered only when someone went looking for a result.
 *
 * WHAT IT ANSWERS, in the spec's own order:
 *   supersede_calls        did the agent ever reach for the verb
 *   live_item_count        does supersession actually retire items
 *   decisions_slot_tokens  the slot-growth curve, and whether it flattens
 *   outcome tags           which runs are TOOL_UNUSED and must not be pooled
 *
 * WHAT IT DOES NOT DO. It does not grade the reversal. That is
 * `src/reversal.ts`, which sees only the artifact and C2', and keeping the two
 * apart is deliberate: a reporter that also grades is how four extractors ended
 * up measuring themselves.
 *
 *   ./go.sh supersession
 *   STUDY_TASK_SET=site ./go.sh supersession
 */
import { connect } from '../src/db.ts';

const SET = process.env.STUDY_TASK_SET ?? 'orchestrate';
/** How many directives each set defines. Kept here rather than imported so the
 *  probe reports on a run even if the set definition later changes. */
const SCHEDULED_BY_SET: Record<string, number> = { orchestrate: 6, operate: 5, site: 5, relay: 4 };
const sql = connect();

type Sample = {
  task_index: number; turn: number;
  live_decisions: number; live_constraints: number; live_items: number;
  decisions_slot_chars: number | null;
};

const runs = await sql<{
  id: string; arm: string; status: string; model: string;
  tags: string[] | null; calls: number | null; applied: number | null;
  delivered_at_task: number | null; superseded_id: string | null; new_id: string | null;
  series: Sample[] | null; turns: number;
}[]>`
  select r.id, r.arm, r.status, r.model,
         r.notes->'outcome_tags' as tags,
         (r.notes->'summary'->>'supersede_calls')::int as calls,
         (r.notes->'summary'->>'supersede_applied')::int as applied,
         (r.notes->'summary'->>'reversal_delivered_at_task')::int as delivered_at_task,
         r.notes->'summary'->>'reversal_superseded_id' as superseded_id,
         r.notes->'summary'->>'reversal_new_id' as new_id,
         r.notes->'summary'->'boundary_series' as series,
         (select count(*)::int from steps s where s.run_id = r.id and s.kind = 'model_call') as turns
  from runs r
  where r.task_set = ${SET}
  order by r.started_at`;

if (!runs.length) {
  console.log(`no ${SET} runs yet`);
  await sql.end();
  process.exit(0);
}

console.log(`SUPERSESSION — task set "${SET}", ${runs.length} run(s)\n`);
console.log('run        arm  status  turns  calls/applied  chain written  reversal@task  tags');
for (const r of runs) {
  // The chain is checked in the DATABASE, not from the counter. A counter says
  // the agent called the verb; only the rows say the write landed.
  const [chain] = await sql<{ n: number }[]>`
    select count(*)::int as n from decisions where run_id = ${r.id} and superseded_by is not null`;
  const [cchain] = await sql<{ n: number }[]>`
    select count(*)::int as n from constraints where run_id = ${r.id} and superseded_by is not null`;
  const written = (chain?.n ?? 0) + (cchain?.n ?? 0);
  console.log(
    `${r.id.padEnd(10)} ${r.arm.padEnd(4)} ${r.status.padEnd(7)} ${String(r.turns).padStart(5)}`
    + `  ${String(r.calls ?? 0).padStart(5)}/${String(r.applied ?? 0).padEnd(7)}`
    + ` ${String(written).padStart(13)}`
    + ` ${String(r.delivered_at_task ?? '-').padStart(13)}`
    + `  ${(r.tags ?? []).join(',') || '-'}`);
}

console.log('\nDOES SUPERSESSION RETIRE ITEMS? live count per task boundary');
console.log('A durable region that only grows means the verb is not being used, or');
console.log('is being used and the retired rows are still projected.\n');
for (const r of runs) {
  const s = (r.series ?? []) as Sample[];
  if (!s.length) { console.log(`${r.id}: no boundary samples`); continue; }
  const items = s.map((x) => x.live_items);
  const chars = s.map((x) => x.decisions_slot_chars).filter((c): c is number => c !== null);
  console.log(`${r.id} (${r.arm}) ${s.length} boundaries`);
  console.log(`  live_items          ${items.join(' -> ')}`);
  if (chars.length) {
    const first = chars[0]!, last = chars[chars.length - 1]!;
    const per = s.length > 1 ? (last - first) / (s.length - 1) : 0;
    console.log(`  decisions_slot_chars ${first} -> ${last}  (${per >= 0 ? '+' : ''}${per.toFixed(0)}/boundary)`);
    // A drop is the signal the rerun is looking for: supersession retiring rows
    // should make the projected block SHRINK, which nothing else in the harness
    // does. Reported explicitly because a monotone curve is the null result.
    const drops = chars.slice(1).map((c, i) => c - chars[i]!).filter((d) => d < 0);
    console.log(`  boundaries where the slot SHRANK: ${drops.length}`
      + (drops.length ? ` (largest ${Math.min(...drops)} chars)` : ' — monotone growth'));
  } else {
    // Not a gap. An accumulating arm renders no durable block, which is why it
    // gets nothing back from calling supersede.
    console.log('  decisions_slot_chars n/a — this arm renders no durable block');
  }
}

console.log('\nRUNS THAT MUST NOT BE POOLED');
// DERIVED FROM THE DATABASE, not read from the tag.
//
// A cell that exhausts MAX_MS records status='done', because `did_nothing` is
// false whenever the budget was spent - so the project's own pooling rule
// ("filter on status='done'") admits a cell that never received its treatment.
// run.ts now tags these SCHEDULE_INCOMPLETE, but a run already in flight when
// that landed cannot be tagged, and backfilling a flag is exactly the kind of
// thing that gets forgotten. Counting rows works for every run, past or future.
for (const r of runs) {
  const [d] = await sql<{ n: number }[]>`
    select count(*)::int as n from directives
    where run_id = ${r.id} and delivered_at is not null`;
  const scheduled = SCHEDULED_BY_SET[SET] ?? 0;
  if (scheduled && (d?.n ?? 0) < scheduled) {
    console.log(`  SCHEDULE_INCOMPLETE  ${r.id}: ${d?.n ?? 0} of ${scheduled} directives delivered`
      + ` (status=${r.status}${r.status === 'done' ? ' — would otherwise pool as a replicate' : ''})`);
  }
}
const unused = runs.filter((r) => (r.tags ?? []).includes('TOOL_UNUSED'));
const refused = runs.filter((r) => (r.tags ?? []).includes('TOOL_REFUSED'));
console.log(`  TOOL_UNUSED  ${unused.length}  (never reached for the verb — says nothing about architecture)`);
console.log(`  TOOL_REFUSED ${refused.length}  (called it, every call refused — a reachability bug)`);
if (unused.length) console.log(`    ${unused.map((r) => r.id).join(', ')}`);
if (refused.length) console.log(`    ${refused.map((r) => r.id).join(', ')}`);

await sql.end();
