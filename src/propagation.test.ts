/**
 * The reversal scorer, pinned — because it was wrong in three ways at once and
 * nothing would have said so.
 *
 * All three defects lived in `settle_reversal`, the single revision the
 * orchestrate set exists to test, and each produced a plausible-looking verdict
 * rather than an error. They were found by an audit of a live cell, not by this
 * suite, which is the reason this file exists.
 *
 * Runs against a fixture run id, so it never touches a real cell. No provider.
 */
import { connect } from './db.ts';
import { score_revisions } from './propagation.ts';

const sql = connect();
const R = 'test_run_prop';
const TS = '2020-01-01 00:00:00+00';
const TASK = 'prop_t1';
const BEFORE = '2020-01-01 00:00:00+00';
const AFTER = '2020-01-03 00:00:00+00';
const DELIVERED = '2020-01-02 00:00:00+00';

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (!ok) fail++; else pass++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? ` — ${d}` : ''}`);
};

async function reset() {
  for (const t of ['steps', 'tool_results', 'decisions', 'constraints', 'created_artifacts', 'tasks', 'directives']) {
    await sql`delete from ${sql(t)} where run_id = ${R}`;
  }
  await sql`delete from runs where id = ${R}`;
  // SETTLE is the non-inferrable value: the reversal must restore T+6
  // specifically, not merely "some T+N".
  await sql`insert into runs (id, arm, model, seed, task_set, notes, started_at, status)
            values (${R}, 'M', 'fixture', 1, 'orchestrate',
                    ${sql.json({ goal_params: { MARKET: 'Uruguay', SETTLE: 'T+6', REFUND_DAYS: '47' } })},
                    ${TS}, 'done')`;
  // decisions.task_id is NOT NULL, so the fixture needs a task to hang them on.
  await sql`insert into tasks (id, run_id, parent_id, spec, decision_watermark, read_watermark, opened_at)
            values (${TASK}, ${R}, null,
                    ${sql.json({ title: 'Settlement', detail: 'Rule on settlement.', acceptance: 'A ruling exists.' })},
                    0, 0, ${TS})`;
}

const decide = (id: string, text: string, at: string) =>
  sql`insert into decisions (id, run_id, task_id, text, created_at, seq)
      values (${id}, ${R}, ${TASK}, ${text}, ${at}, ${Math.floor(Math.random() * 1e9)})`;

// directives.id is a serial; let the database assign it.
const deliver = (id: string, text: string, at: string | null) =>
  sql`insert into directives (run_id, text, kind, created_at, delivered_at, delivered_turn)
      values (${R}, ${`[${id}] ${text}`}, 'directive', ${TS}, ${at}, ${at ? 200 : null})`;

const verdict_of = async (id: string) =>
  (await score_revisions(sql, R)).find((r) => r.revision === id)!;

console.log('0. Every delivered interjection has something that scores it');
// An interjection the task set delivers but no revision defines is invisible:
// the agent receives it, acts or fails to act, and no verdict is ever produced.
// operate declares six (tasks 2,4,6,8,10,12) and OPERATE_REVISIONS defines four
// - tasks 6 and 10 have never been scored on any run.
//
// The two known gaps are pinned rather than fixed, because writing the missing
// fresh/stale patterns is metric design and a wrong pattern is worse than a
// missing one. Pinned means a NEW gap fails here instead of going unnoticed for
// as long as these two did.
// ship declares three and scores NONE - REVISIONS_BY_SET has no ship entry at
// all, so score_revisions falls through to `?? SITE_REVISIONS` and grades a ship
// run against the site script. That was found by this check on its first run,
// not by the audit that prompted it.
const KNOWN_UNSCORED: Record<string, number[]> = { operate: [6, 10], ship: [3, 6, 9] };
{
  const { TASK_SETS } = await import('./taskset.ts');
  const { REVISIONS_BY_SET } = await import('./propagation.ts');
  for (const [set_id, set] of Object.entries(TASK_SETS as Record<string, any>)) {
    const declared: number[] = (set.interjections ?? []).map((i: any) => i.after_tasks_done);
    if (!declared.length) continue;
    const scored = new Set(((REVISIONS_BY_SET as any)[set_id] ?? []).map((r: any) => r.after_tasks_done));
    const gaps = declared.filter((d) => !scored.has(d)).sort((a, b) => a - b);
    const known = (KNOWN_UNSCORED[set_id] ?? []).slice().sort((a, b) => a - b);
    const unexpected = gaps.filter((g) => !known.includes(g));
    check(`${set_id}: no NEW unscored interjection`, unexpected.length === 0,
      gaps.length ? `${declared.length} declared, ${gaps.length} unscored (${gaps.join(',')})`
                  : `${declared.length} declared, all scored`);
  }
}

console.log('\n1. Delivery is an identity, not a pattern');
await reset();
// The reversal's real text names no value at all. The old check ran `fresh`
// over it and so scored not_delivered even when it had been delivered.
await deliver('settle_reversal',
  'Put settlement back to what it was before the change I asked for earlier. This reverses that instruction.',
  DELIVERED);
let v = await verdict_of('settle_reversal');
check('a directive whose text contains no value still reads delivered', v.delivered,
  'matched on the [id] marker');

console.log('\n2. The seed value, not the shape');
await reset();
await deliver('settle_reversal', 'Put settlement back to what it was before.', DELIVERED);
// "T+9" satisfies the old fresh (/T\+?[0-9]/i) and fails the old stale
// (/T\+?1/i), so it scored as propagated. It is a guess, not the answer.
await decide('d_wrong', 'Settlement is restored to T+9, reversing the earlier change.', AFTER);
v = await verdict_of('settle_reversal');
check('a wrong-but-well-shaped value is NOT noticed', !v.noticed, 'T+9 when SETTLE is T+6');

await reset();
await deliver('settle_reversal', 'Put settlement back to what it was before.', DELIVERED);
await decide('d_right', 'Reversing the earlier instruction: settlement is restored to T+6.', AFTER);
v = await verdict_of('settle_reversal');
check('the seed value with reversal language IS noticed', v.noticed, 'T+6 + "restored"');

console.log('\n3. A reversal cannot be graded by mention, because it was already true');
await reset();
await deliver('settle_reversal', 'Put settlement back to what it was before.', DELIVERED);
// The original ruling names T+6 long before any reversal exists. On the live
// cell this scored `noticed` at turn 77, 123 turns before the directive was due.
await decide('d_original', 'R1: settlement runs on a T+6 schedule across the product.', BEFORE);
v = await verdict_of('settle_reversal');
check('the ORIGINAL ruling does not count as noticing the reversal', !v.noticed,
  'written before delivery');

await reset();
await deliver('settle_reversal', 'Put settlement back to what it was before.', DELIVERED);
await decide('d_mention', 'Settlement remains T+6 for treasury reporting purposes.', AFTER);
v = await verdict_of('settle_reversal');
check('naming the value without saying it is a reversal is not enough', !v.noticed);

console.log('\n4. An undelivered reversal is never noticed');
await reset();
await deliver('settle_reversal', 'Put settlement back to what it was before.', null);
await decide('d_early', 'Settlement restored to T+6, reversing the change.', AFTER);
v = await verdict_of('settle_reversal');
check('not delivered means not noticed', !v.delivered && !v.noticed,
  'guards against crediting an answer the agent was never asked for');

console.log('\n5. Both delivery channels, because the task sets disagree');
// orchestrate/relay write to `directives` with an [id]; site/operate inject
// straight into `constraints` with no marker. Reading only `directives` scored
// 0 delivered across 82 of 140 runs, and probe/revision.ts drops undelivered
// events, so it reported n=0 for every arm rather than reporting nothing.
await reset();
await sql`insert into constraints (id, run_id, text, created_at, seq)
          values ('c_interject', ${R}, 'Move settlement to T+1 across the product.', ${DELIVERED}, 1)`;
await decide('d_c', 'Settlement moves to T+1.', AFTER);
v = await verdict_of('settle_t1');
check('a constraint-channel interjection reads delivered', v.delivered,
  'no [id] marker, matched on the revision pattern');

// ...but a run that HAS a directives channel must not fall through to it. M_d1
// delivered 4 of 6; per-revision fallback made the missing two match unrelated
// constraint text and all six read delivered, including the reversal the cell
// never reached.
await reset();
await deliver('settle_t1', 'Move settlement to T+1 across the product.', DELIVERED);
await sql`insert into constraints (id, run_id, text, created_at, seq)
          values ('c_noise', ${R}, 'Settlement currently runs T+6 per the original ruling.', ${DELIVERED}, 2)`;
v = await verdict_of('settle_reversal');
check('an undelivered revision does NOT fall back when the run uses directives',
  !v.delivered, 'absence in the directives table is real evidence of non-delivery');

console.log('\n6. Revisions WITHOUT decided_param keep the old behaviour');
await reset();
await deliver('settle_t1', 'Move settlement to T+1 across the product.', DELIVERED);
await decide('d_t1', 'Settlement moves to T+1.', AFTER);
v = await verdict_of('settle_t1');
check('settle_t1 still scores on its own fresh pattern', v.delivered && v.noticed);

for (const t of ['decisions', 'directives', 'constraints', 'tasks']) await sql`delete from ${sql(t)} where run_id = ${R}`;
await sql`delete from runs where id = ${R}`;
console.log(`\n${pass} passed, ${fail} failed`);
await sql.end();
process.exit(fail ? 1 : 0);
