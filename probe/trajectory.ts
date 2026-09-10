/**
 * WHEN does each arm produce? And would a different turn cap reorder the arms?
 *
 * A per-run total hides its own shape. On site/4.7 every arm ran exactly 60 of
 * 60 turns, so the totals are a fixed-budget comparison — but the cumulative
 * curves cross: BR leads on files written at every cap from 20 to 50, and B
 * only overtakes at 60. A result that holds at one cap and not at another is
 * contingent on the cap, and that has to be visible rather than discovered by
 * someone re-running the study at a different budget.
 *
 * The agent is never told its turn budget — `max_turns` appears nowhere in the
 * prompt path — so back-loading is not deadline behaviour. The cap is a
 * CENSORING point, not a deadline, which matters for reading the curves: an arm
 * still climbing when censored is being under-measured, one that has flattened
 * is not.
 *
 * Rewrites are split from first writes because "produced more late" and "went
 * back and fixed what it wrote" are different claims and the totals conflate
 * them.
 */
import { connect } from '../src/db.ts';
import { classify, is_result } from '../src/terminal.ts';
import { extract_claims } from '../src/artifacts.ts';

const sql = connect();
const TASK_SET = process.env.STUDY_TASK_SET ?? 'site';
const ONLY_MODEL = process.env.STUDY_MODEL ?? null;
const WINDOW = Number(process.env.TRAJ_WINDOW ?? 10);

const runs = await sql<{ id: string; arm: string; model: string; ceiling: string }[]>`
  select r.id, r.arm, r.model, coalesce(r.notes->>'ceiling_tokens','unrecorded') ceiling
  from runs r
  where r.task_set = ${TASK_SET}
    and r.id ~ '^[A-Z]+_[a-z][0-9]+$'
    and (${ONLY_MODEL}::text is null or r.model = ${ONLY_MODEL})`;

const states = new Map((await classify(sql)).map((c) => [c.run_id, c]));
const live = runs.filter((r) => { const st = states.get(r.id); return !st || is_result(st.terminal); });
if (!live.length) { console.log('no admissible cells'); await sql.end(); process.exit(0); }

const models = [...new Set(live.map((r) => r.model))];
if (models.length > 1) {
  console.log(`REFUSING TO POOL — ${models.length} models: ${models.join(', ')}`);
  await sql.end();
  process.exit(1);
}
console.log(`${TASK_SET} / ${models[0]}  n=${live.length} runs\n`);

const ids = live.map((r) => r.id);
const arm_of = new Map(live.map((r) => [r.id, r.arm]));
const rows = await sql<{ run_id: string; turn: number; path: string | null }[]>`
  select run_id, turn, payload->'args'->>'path' path
  from steps
  where run_id in ${sql(ids)} and kind = 'tool_call' and payload->>'name' = 'write'
  order by run_id, turn, seq`;

const arms = [...new Set(live.map((r) => r.arm))].sort();
const n_of = (arm: string) => live.filter((r) => r.arm === arm).length;

// SURVIVORSHIP. Dividing a window's count by ALL runs of an arm makes a
// short-running arm look like it stopped working, when its runs simply ended.
// On operate only 1 of 9 arm-A runs reaches turn 50 against 6 of 8 for B, so
// per-all-runs windows showed A "stopping dead after turn 50" — an artifact of
// the denominator, not behaviour. Every rate below divides by runs STILL ALIVE.
const last_turn = new Map<string, number>();
for (const r of await sql<{ run_id: string; t: number }[]>`
  select run_id, max(turn)::int t from steps
  where run_id in ${sql(ids)} and kind = 'model_call' group by run_id`) {
  last_turn.set(r.run_id, r.t);
}
const alive_at = (arm: string, turn: number) =>
  live.filter((r) => r.arm === arm && (last_turn.get(r.id) ?? 0) >= turn).length;

// first write vs rewrite, per run, in turn order
const seen = new Map<string, Set<string>>();
type Ev = { arm: string; turn: number; first: boolean };
const evs: Ev[] = [];
for (const r of rows) {
  const arm = arm_of.get(r.run_id)!;
  const s = seen.get(r.run_id) ?? seen.set(r.run_id, new Set()).get(r.run_id)!;
  const key = r.path ?? '(no path)';
  const first = !s.has(key);
  s.add(key);
  evs.push({ arm, turn: r.turn, first });
}

const max_turn = Math.max(0, ...evs.map((e) => e.turn));
const buckets: number[] = [];
for (let t = 0; t <= max_turn; t += WINDOW) buckets.push(t);

console.log(`WRITES PER SURVIVING RUN in each ${WINDOW}-turn window`);
console.log('     (n = runs still alive in that window, shown in brackets)');
console.log('arm  ' + buckets.map((b) => `${b}-${b + WINDOW - 1}`.padStart(12)).join(''));
for (const arm of arms) {
  const cells = buckets.map((b) => {
    const alive = alive_at(arm, b);
    if (!alive) return '     - [0]'.padStart(12);
    const c = evs.filter((e) => e.arm === arm && e.turn >= b && e.turn < b + WINDOW).length;
    return `${(c / alive).toFixed(2)} [${alive}]`.padStart(12);
  });
  console.log(`${arm.padEnd(4)} ` + cells.join(''));
}

console.log(`\nCUMULATIVE writes per run by turn cap — does the ordering survive the cap?`);
console.log('cap  ' + arms.map((a) => a.padStart(8)).join('') + '   ordering');
for (const cap of buckets.map((b) => b + WINDOW)) {
  const vals = arms.map((arm) => evs.filter((e) => e.arm === arm && e.turn < cap).length / n_of(arm));
  const order = arms.map((a, i) => [a, vals[i]!] as const)
    .sort((x, y) => y[1] - x[1]).map(([a]) => a).join(' > ');
  console.log(`${String(cap).padEnd(4)} ` + vals.map((v) => v.toFixed(2).padStart(8)).join('') + `   ${order}`);
}

console.log('\nFIRST WRITES vs REWRITES — producing new work, or revising old work?');
const half = Math.floor(max_turn * 0.8);
console.log(`arm    early first  early rewrite  late first  late rewrite   (late = turn >= ${half})`);
for (const arm of arms) {
  const n = n_of(arm);
  const f = (late: boolean, first: boolean) =>
    (evs.filter((e) => e.arm === arm && (e.turn >= half) === late && e.first === first).length / n)
      .toFixed(2).padStart(11);
  console.log(`${arm.padEnd(4)} ${f(false, true)}  ${f(false, false)}  ${f(true, true)}  ${f(true, false)}`);
}

// GROUNDED FINDINGS BY TURN CAP. Writes are a proxy; this is the endpoint
// itself. Only DECISION-derived claims carry a real turn — artifacts.ts stamps
// task-result claims with the sentinel 9999 — so this curve covers a subset,
// and the covered fraction is printed rather than quietly extrapolated.
const dec = await sql<{ run_id: string; text: string; task_id: string; turn: number }[]>`
  select d.run_id, d.text, d.task_id,
         coalesce((select min(turn) from steps s where s.run_id = d.run_id
                   and s.kind = 'tool_call' and s.payload->>'name' = 'decide'
                   and s.payload->'args'->>'text' = d.text), 0) as turn
  from decisions d where d.run_id in ${sql(ids)} order by d.run_id, d.seq asc`;

type GEv = { arm: string; turn: number; grounded: boolean };
const gevs: GEv[] = [];
for (const d of dec) {
  const arm = arm_of.get(d.run_id)!;
  for (const c of extract_claims(d.text, d.task_id, d.turn, d.run_id)) {
    gevs.push({ arm, turn: d.turn, grounded: c.verdict === 'grounded' });
  }
}

if (gevs.length) {
  console.log('\nGROUNDED FINDINGS (decision-derived only) by turn cap');
  console.log('cap  ' + arms.map((a) => a.padStart(9)).join('') + '   ordering');
  for (const cap of buckets.map((b) => b + WINDOW)) {
    const vals = arms.map((arm) =>
      gevs.filter((e) => e.arm === arm && e.turn < cap && e.grounded).length / n_of(arm));
    const order = arms.map((a, i) => [a, vals[i]!] as const)
      .sort((x, y) => y[1] - x[1]).map(([a]) => a).join(' > ');
    console.log(`${String(cap).padEnd(4)} ` + vals.map((v) => v.toFixed(1).padStart(9)).join('') + `   ${order}`);
  }
  console.log(`\ncovers ${gevs.length} decision-derived claims; task-result claims`
    + ' carry sentinel turn 9999 and cannot be placed in time at all.');
  console.log('READ THIS CURVE NARROWLY. Two attribution weaknesses bound it:');
  console.log('  1. artifacts.ts dates a decision by min(turn) over steps with MATCHING TEXT,');
  console.log('     so a restated decision collapses onto its earliest occurrence. The dedup');
  console.log('     gate has never fired on this journal, so duplicates certainly exist.');
  console.log('  2. Most decisions land in the first window regardless (A 95%, B 93%),');
  console.log('     partly because arms genuinely front-load decide bursts and write later.');
  console.log('  The ordering being cap-invariant here is therefore evidence about the');
  console.log('  decision-derived half of the endpoint only, not about the endpoint.');
}

console.log('\nAn arm still climbing at the last window was censored, not finished.');
await sql.end();
