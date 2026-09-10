/**
 * The ceiling ladder, read as a curve rather than a point.
 *
 * The question this answers is the one a single chosen ceiling could not: AT
 * WHAT CONTEXT PRESSURE DOES RE-PROJECTION START TO MATTER, and does the effect
 * scale with it? A point estimate at a ceiling picked after observing that the
 * treatment did not fire is a researcher degree of freedom. A monotone curve
 * across four rungs is not, and a non-monotone one says something a point would
 * have hidden.
 *
 * WHAT IS REPORTED PER RUNG, and why each:
 *   truncations  whether the treatment fired at all. A rung where AM never
 *                truncates is a rung where AM is arm AP and the row means
 *                nothing — printed, not silently dropped.
 *   directives   delivered vs due. A cell that received fewer than were due at
 *                its turn count is VOID: the directives are the treatment. One
 *                such cell has already been produced and looked perfectly
 *                healthy, so this column exists to make that visible.
 *   honoured     a decision that names the directive's id. Mechanical.
 *   REVERSAL     the sharp one. The turn-240 directive says "put the cap back to
 *                what it was before" and never names the number, so it can only
 *                be answered from context that still holds the original policy.
 *                Every other directive can be honoured by reading the newest
 *                message alone.
 *   spawn        the agent's OWN decomposition, separate from seeded milestones.
 *                Pre-spawning manufactures the task boundaries the treatment
 *                needs, so what it hides is counted rather than erased.
 *
 * Rungs are never pooled: ceiling_tokens is a pooling key.
 */
import { connect } from '../src/db.ts';
import { REVISIONS_BY_SET, type Revision } from '../src/propagation.ts';

const sql = connect();
const SET = process.env.STUDY_TASK_SET ?? 'relay';

/**
 * The schedule MUST come from the set being read.
 *
 * This file imported RELAY_REVISIONS and scored every run against it regardless
 * of SET, so an orchestrate cell was checked for relay's directive ids at
 * relay's turns. Every id would have missed, and the table would have reported
 * an honest-looking 0/n honoured for a run that had done the work.
 */
const REVISIONS: Revision[] = REVISIONS_BY_SET[SET] ?? [];
if (!REVISIONS.length) console.log(`!! no revision schedule for set "${SET}" — directive columns are meaningless\n`);

/**
 * WHICH DIRECTIVE IS THE REVERSAL, without hardcoding an id.
 *
 * 'cap_reversal' was hardcoded here, so on orchestrate — whose reversal is
 * 'settle_reversal' — the load-bearing column would have printed n/a for every
 * cell, reporting nothing exactly where the study's whole claim lives. The two
 * reversals share no id, no scoring field (relay pins 13 in `decided`,
 * orchestrate resolves `decided_param`), and no turn. What they do share is the
 * sentence that makes them reversals, which is also the only thing the agent
 * ever sees.
 */
const REVERSAL_RE = /reverses that instruction/i;
const reversal_of = (revs: Revision[]) => revs.find((r) => REVERSAL_RE.test(r.text ?? ''));

const runs = await sql<{
  id: string; arm: string; status: string; ceiling: string; model: string;
  turns: number; truncations: number; peak: number; decisions: number;
  reports: number; closed: number; created: number;
  directives: number; spawn_calls: string | null; spawn_ok: string | null; seeded: string | null;
}[]>`
  select r.id, r.arm, r.status, coalesce(r.notes->>'ceiling_tokens','?') ceiling, r.model,
    (select count(*)::int from steps where run_id = r.id and kind = 'model_call') turns,
    (select count(*)::int from steps where run_id = r.id and step_id like '%truncate%') truncations,
    coalesce((select max(tokens_in) from steps where run_id = r.id and kind = 'model_call'), 0)::int peak,
    (select count(*)::int from decisions where run_id = r.id) decisions,
    (select count(*)::int from agent_reports where run_id = r.id) reports,
    (select count(*)::int from tasks where run_id = r.id and status = 'done') closed,
    (select count(*)::int from tasks where run_id = r.id) created,
    (select count(*)::int from directives
      where run_id = r.id and delivered_at is not null) directives,
    r.notes->'summary'->>'spawn_calls' spawn_calls,
    r.notes->'summary'->>'spawn_accepted' spawn_ok,
    r.notes->'summary'->>'milestones_seeded' seeded
  from runs r
  where r.task_set = ${SET} and r.arm in ('M','AM')
  order by (coalesce(r.notes->>'ceiling_tokens','0'))::bigint, r.arm desc`;

if (!runs.length) { console.log(`no ${SET} runs on arms M/AM yet`); await sql.end(); process.exit(0); }

/** Which directives were DUE by the turn count this run reached. */
const due_at = (turns: number) => REVISIONS.filter((r) => turns >= (r.at_turn ?? Infinity));

/**
 * Honoured = a decision made AFTER the directive arrived takes it up.
 *
 * THE SCOPING IS THE WHOLE CHECK, and its absence made this column meaningless.
 * The blob used to be every decision of the run, so the reversal — scored as
 * "names the seed's original value AND says it is a reversal" — was satisfied by
 * the run's OWN FIRST DECISION. The goal states "settlement runs {SETTLE}" and
 * the rubric requires a settlement ruling, so decision #1 always contains the
 * value; some later decision always contains "original" or "restore". Measured
 * on M_d1 at turn 81, 119 turns before settle_reversal is even created, the old
 * predicate returned TRUE.
 *
 * It could not discriminate arms either: decisions are Postgres rows, so an
 * accumulating arm that front-truncated the value out of its CONTEXT still has
 * every decision row in the journal. The column would have read YES for all 18
 * cells on both arms — the repo's own named failure mode, an instrument whose
 * output does not depend on the thing it measures.
 *
 * A directive that was never delivered is never honoured: you cannot take up a
 * message you were not sent, and scoring it as a failure would blame the agent
 * for the harness (the void column reports that case separately).
 */
async function honoured(run_id: string, ids: string[]): Promise<Set<string>> {
  const rows = await sql<{ text: string; created_at: string }[]>`
    select text, created_at::text from decisions where run_id = ${run_id} order by seq`;
  // Delivery times come from the journal, not the schedule: what matters is when
  // the agent was actually handed the message, not when it was due.
  const dels = await sql<{ text: string; delivered_at: string | null }[]>`
    select text, delivered_at::text from directives
    where run_id = ${run_id} and delivered_at is not null`;
  const delivered_at_of = (id: string) =>
    dels.find((d) => d.text.includes(`[${id}]`))?.delivered_at ?? null;
  // Harness-assigned values differ per seed, so a directive scored by
  // decided_param is checked against what THIS run was given.
  const [pr] = await sql<{ params: Record<string, string> | null }[]>`
    select notes->'goal_params' as params from runs where id = ${run_id}`;
  const params = pr?.params ?? {};
  return new Set(ids.filter((id) => {
    const rev = REVISIONS.find((r) => r.id === id);
    const since = delivered_at_of(id);
    if (since === null) return false;
    const blob = rows.filter((r) => r.created_at >= since)
      .map((r) => r.text).join('\n').toLowerCase();
    if (!blob) return false;
    // `decided`, not `fresh`: fresh greps source artifacts and gave a false
    // negative on the reversal, which the agent recorded in its own words.
    if (rev?.decided_param) {
      const want = String(params[rev.decided_param] ?? '').toLowerCase();
      // Restoring means naming the original value in a decision that also says
      // it is a reversal — naming it alone could be a leftover mention.
      return Boolean(want) && blob.includes(want)
        && /(restor|revers|back to|pre-|original)/i.test(blob);
    }
    return blob.includes(id.toLowerCase()) || (rev?.decided?.test(blob) ?? false);
  }));
}

console.log(`CEILING LADDER — task set "${SET}", arms M (re-project) vs AM (accumulate)\n`);
console.log('ceiling    arm  status  turns  trunc    peak  dirs(due)  honoured  REVERSAL  dec  rep  closed/made  spawn');

const by_ceiling = new Map<string, typeof runs>();
for (const r of runs) {
  const k = r.ceiling;
  const bucket = by_ceiling.get(k);
  if (bucket) bucket.push(r); else by_ceiling.set(k, [r] as typeof runs);
}

const notes: string[] = [];
for (const [ceiling, cells] of [...by_ceiling.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  for (const r of cells) {
    const due = due_at(r.turns);
    const hit = await honoured(r.id, due.map((d) => d.id));
    const rev = reversal_of(due);
    const rev_cell = !rev ? '   n/a  ' : hit.has(rev.id) ? '   YES  ' : '   no   ';
    const void_cell = r.directives < due.length;
    if (void_cell && r.status === 'done') {
      notes.push(`${r.id}: VOID — ${r.directives} directives received, ${due.length} due at turn ${r.turns}`);
    }
    if (r.arm === 'AM' && r.truncations === 0 && r.status === 'done') {
      notes.push(`${r.id}: AM never truncated at ceiling ${ceiling} (peak ${r.peak}) — this rung tests nothing`);
    }
    console.log(
      `${ceiling.padStart(7)}  ${r.arm.padEnd(4)} ${r.status.padEnd(7)} ${String(r.turns).padStart(5)}`
      + ` ${String(r.truncations).padStart(5)} ${String(r.peak).padStart(7)}`
      + ` ${String(r.directives).padStart(5)}(${String(due.length).padStart(1)})`
      + ` ${String(hit.size).padStart(8)}/${due.length}`
      + ` ${rev_cell}`
      + ` ${String(r.decisions).padStart(4)} ${String(r.reports).padStart(4)}`
      + ` ${String(r.closed).padStart(6)}/${String(r.created).padStart(3)}`
      + `  ${r.spawn_ok ?? '-'}/${r.spawn_calls ?? '-'}`);
  }
}

if (notes.length) {
  console.log('\nCELLS THAT DO NOT COUNT:');
  for (const n of notes) console.log(`  ${n}`);
}

console.log('\nREVERSAL is the load-bearing column. Its directive never names the number,');
console.log('so it can only be answered from context that still holds the original policy.');
console.log('spawn is accepted/attempted by the AGENT, excluding seeded milestones: it says');
console.log('whether pre-spawning was equalisation or a substitute for behaviour under test.');
await sql.end();
