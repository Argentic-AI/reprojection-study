/**
 * Mid-flight assertions: halt a long cell that has already stopped measuring.
 *
 * A 240-turn orchestrate cell now runs ~11 hours. The failure mode at that
 * length is not a crash - it is a defect that surfaces at hour 5 of a clean run
 * and is only discovered at hour 11, when the whole cell has to be discarded.
 * Both studies stopped early this month were cheaper than the alternative.
 *
 * WHAT IT CHECKS, and each one has already failed once in this project:
 *
 *  1. DIRECTIVES ARE LANDING. A cell whose schedule silently stops delivering
 *     runs to completion and scores nothing. M_d1 delivered 4 of 6 and banked
 *     itself status='done'.
 *
 *  2. THE REVERSAL SCORER DISCRIMINATES. This is the one that matters. The
 *     predicate must be FALSE before the reversal is delivered - if it is true
 *     at turn 80, 120 turns early, it is measuring the run's own opening
 *     decision rather than the reversal. That exact degeneracy was found by
 *     running the predicate against a live cell at turn 81 and getting `true`,
 *     while 58 pins passed. An endpoint that reads true before the treatment
 *     fires cannot separate anything.
 *
 *  3. TURNS ARE ADVANCING, and stalls are being survived rather than
 *     accumulating without progress.
 *
 * It does NOT touch the treatment, does not write, and does not kill anything:
 * it reports. Auto-killing a cell on a heuristic risks discarding a good run,
 * which is the more expensive error now that a stall is survivable.
 *
 *   ./go.sh midflight
 */
import { connect } from '../src/db.ts';
import { score_revisions } from '../src/propagation.ts';
import { REVISIONS_BY_SET } from '../src/propagation.ts';

const sql = connect();
const SET = process.env.STUDY_TASK_SET ?? 'orchestrate';
const live = await sql<{ id: string; arm: string; started_at: Date }[]>`
  select id, arm, started_at from runs where task_set = ${SET} and status = 'running'`;

// A FINISHED CELL CAN STILL BE A FAILURE, AND NOTHING ELSE SAYS SO.
//
// A cell that exhausts MAX_MS records status='done' with the directives it
// never received simply absent. study_orchestrate.sh then reads
// `if [ "$st" = "done" ]` and skips it, so a truncated cell and a complete one
// are indistinguishable to the thing that decides whether to re-run it. M_d1
// ended this way at turn 169 of 300 with 4 of 6 directives.
//
// This watcher previously looked only at status='running' cells, so the moment
// a cell failed this way it dropped out of the log entirely — the failure was
// the thing that made it invisible.
const finished = await sql<{ id: string; arm: string; turns: number; dlv: number }[]>`
  select r.id, r.arm,
         (select coalesce(max(turn),0) from steps s where s.run_id = r.id)::int as turns,
         (select count(*) from directives d
           where d.run_id = r.id and d.delivered_at is not null)::int as dlv
  from runs r where r.task_set = ${SET} and r.status = 'done'`;
const scheduled_n = (REVISIONS_BY_SET[SET] ?? []).length;
for (const f of finished) {
  if (scheduled_n > 0 && f.dlv < scheduled_n) {
    console.log(`${f.id} (${f.arm}) FINISHED TRUNCATED at turn ${f.turns}: `
      + `${f.dlv} of ${scheduled_n} directives — SCHEDULE_INCOMPLETE, not a replicate`);
    console.log(`     resume it with: ./go.sh drive ${f.id}   (do NOT run while another cell is live)`);
  }
}

if (!live.length) { console.log(`no live ${SET} cell`); await sql.end(); process.exit(0); }

let problems = 0;
for (const r of live) {
  const [c] = await sql<{ t: number; stalls: number }[]>`
    select coalesce(max(turn),0)::int as t,
           count(*) filter (where kind = 'stall')::int as stalls
    from steps where run_id = ${r.id}`;
  const turn = c?.t ?? 0;
  console.log(`\n${r.id} (${r.arm}) at turn ${turn}, ${c?.stalls ?? 0} stall(s)`);

  // LIVENESS, because everything below it can pass on a frozen run.
  //
  // Found by running this watcher against M_r1 while it had recorded nothing
  // for 29 minutes: it printed "no problems" throughout. The directive and
  // predicate checks read accumulated rows, so they are equally happy whether
  // the run is working or stopped, which is the step_zero.ts failure in a
  // different costume.
  //
  // The threshold is not "a stall is bad" — a stall is a provider fact and the
  // run survives them by design. It is that a turn cannot outlive TURN_BUDGET_MS
  // without the stall path writing a `stall` row. Silence past 2x that budget
  // means either the process is gone or the stall path stopped firing, and both
  // are real failures rather than results.
  const budget_min = Number(process.env.TURN_BUDGET_MS ?? 1_800_000) / 60_000;
  // AGE OF PROGRESS, NOT AGE OF ROWS.
  //
  // The first version of this measured max(created_at) over all steps, which a
  // permanently stalling run defeats completely: the stall path writes a `stall`
  // row every ~31 minutes, so step recency stays fresh forever while the turn
  // counter never moves. M_r1 sat on turn 122 for four hours writing seven stall
  // rows, and this check reported "last step 0 min ago" throughout.
  //
  // Progress is a turn advancing. Rows arriving is not progress — it is the
  // failure handler doing its job, which is exactly when the run is stuck.
  const [age] = await sql<{ mins: number }[]>`
    select round(extract(epoch from (now() - max(created_at)))/60)::int as mins
    from steps where run_id = ${r.id} and turn = (select max(turn) from steps where run_id = ${r.id})
      and kind <> 'stall'`;
  const stale = age?.mins ?? 0;
  if (stale > budget_min * 2) {
    problems++;
    console.log(`  PROBLEM turn ${turn} has not advanced in ${stale} min, past 2x the ${budget_min} min turn budget`);
    console.log('       the cell is alive and retrying, and spending its MAX_MS budget to do it —');
    console.log('       every stall cycle costs ~31 min of the budget and buys no turns');
  } else if (stale > budget_min) {
    console.log(`  --   no step for ${stale} min — inside a stalled turn, expected to recover`);
  } else {
    console.log(`  ok   last step ${stale} min ago`);
  }

  const schedule = REVISIONS_BY_SET[SET] ?? [];
  const dlv = await sql<{ n: number }[]>`
    select count(*)::int as n from directives where run_id = ${r.id} and delivered_at is not null`;
  // Every directive whose turn has passed should have landed. A margin of one
  // covers the gap between the threshold turn and the task boundary that
  // actually delivers it.
  const due = schedule.filter((s: any) => typeof s.at_turn === 'number' && turn > s.at_turn + 3).length;
  const got = dlv[0]?.n ?? 0;
  const ok_d = got >= due;
  console.log(`  ${ok_d ? 'ok  ' : 'PROBLEM'} directives: ${got} delivered, ${due} due by turn ${turn}`);
  if (!ok_d) { problems++; console.log('       the schedule has stopped landing — this cell will score nothing'); }

  // THE DISCRIMINATION CHECK.
  const scored = await score_revisions(sql, r.id);
  for (const s of scored) {
    const rev: any = schedule.find((x: any) => x.id === s.revision);
    if (!rev?.decided_param) continue;
    if (!s.delivered && s.noticed) {
      problems++;
      console.log(`  PROBLEM ${s.revision}: reads NOTICED before it was delivered`);
      console.log('       the endpoint is measuring something other than the reversal');
    } else if (!s.delivered) {
      console.log(`  ok   ${s.revision}: not delivered, not noticed — predicate still discriminating`);
    } else {
      // NOT A CHECK, AND LABELLED SO.
      //
      // Once the reversal is delivered this watcher has nothing left to assert.
      // `noticed=false` is ambiguous from run data alone: it is either the arm
      // failing to take up the reversal — which is the RESULT this cell exists
      // to produce — or the predicate having stopped matching. Flagging it as a
      // PROBLEM would kill a run for finding the negative result, so it is
      // reported and not judged.
      //
      // The discrimination guarantee comes from src/propagation.test.ts §2,
      // which asserts a well-shaped wrong value (T+9 against SETTLE=T+6) does
      // NOT read as noticed. That is a pure predicate test with no run state in
      // it, so it is the thing to re-run if this line ever looks suspicious.
      console.log(`  --   ${s.revision}: delivered, noticed=${s.noticed} (reported, not checked — see propagation.test.ts §2)`);
    }
  }
}
console.log(problems ? `\n${problems} PROBLEM(S) — this cell is running without measuring. Stop it rather than finish it.`
                     : '\nno problems: the cell is still measuring what it exists to measure.');
await sql.end();
process.exit(problems ? 1 : 0);
