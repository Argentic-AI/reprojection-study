/**
 * Properties of the pinned constraints slot.
 *
 * A constraint must be binding from the moment it is issued and must survive
 * every task boundary for the life of the run. This is the fix for the defect
 * where the constraint lived only in the tail: it vanished at the first
 * boundary, so the experiment measured the harness's eviction policy rather
 * than the hypothesis.
 */
import { connect } from './db.ts';
import { assemble, type Msg } from './assemble.ts';

const sql = connect();
const R = 'test_constraints';
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  ${d}` : ''}`); ok ? pass++ : fail++; };
const durable = (m: Msg | undefined) => (m && typeof m.content === 'string' ? m.content : '');

await sql`delete from runs where id = ${R}`;
await sql`insert into runs (id, arm, model, seed, task_set, notes)
          values (${R}, 'B', 'test', 1, 'test', ${sql.json({ goal: 'Test goal.' })})`;
await sql`insert into tasks (id, run_id, spec, decision_watermark)
          values ('c_t1', ${R}, ${sql.json({ title: 'One', detail: 'x', acceptance: 'y' })}, 0)`;

console.log('\n1. Absent before issue');
const a0 = await assemble(sql, R, 'c_t1');
check('no constraints yet', a0.diagnostics.live_constraints === 0);
check('slot present but empty', durable(a0.messages[1]).includes('(none)'));
check('constraints slot sits in the prologue, before the tail',
      a0.slots.findIndex((s) => s.key === 'constraints') < a0.slots.findIndex((s) => s.key === 'task'));

console.log('\n2. Binding IMMEDIATELY on issue — not deferred to the next boundary');
await sql`insert into constraints (id, run_id, text, kind)
          values ('c1', ${R}, 'Every spawn title must be snake_case.', 'snake_case')`;
const a1 = await assemble(sql, R, 'c_t1');
check('visible in the same task it was issued in', durable(a1.messages[1]).includes('snake_case'));
check('live count is 1', a1.diagnostics.live_constraints === 1);
check('durable block changed', a1.diagnostics.durable_fingerprint !== a0.diagnostics.durable_fingerprint);
// Contrast: decisions ARE watermark-gated, and must not leak mid-task.
await sql`insert into decisions (id, run_id, task_id, text) values ('cd1', ${R}, 'c_t1', 'A mid-task decision.')`;
const a2 = await assemble(sql, R, 'c_t1');
check('decisions still deferred by the watermark (unchanged behaviour)',
      a2.diagnostics.live_decisions === 0, 'constraints are pinned; decisions are not');

console.log('\n3. Survives a task boundary');
await sql`insert into tasks (id, run_id, spec, decision_watermark)
          values ('c_t2', ${R}, ${sql.json({ title: 'Two', detail: 'x', acceptance: 'y' })}, 0)`;
const b1 = await assemble(sql, R, 'c_t2');
check('tail discarded', b1.diagnostics.tail_messages === 0);
check('constraint SURVIVES the boundary', durable(b1.messages[1]).includes('snake_case'));
check('stable prefix unchanged across the boundary',
      b1.diagnostics.prefix_fingerprint === a0.diagnostics.prefix_fingerprint);

console.log('\n4. Survives many boundaries — never evictable within a run');
for (let i = 3; i <= 8; i++) {
  await sql`insert into tasks (id, run_id, spec, decision_watermark)
            values (${`c_t${i}`}, ${R}, ${sql.json({ title: `T${i}`, detail: 'x', acceptance: 'y' })}, 0)`;
}
const b8 = await assemble(sql, R, 'c_t8');
check('still present after 7 boundaries', durable(b8.messages[1]).includes('snake_case'));

console.log('\n5. Retirement removes it');
await sql`update constraints set retired_at = now() where id = 'c1'`;
const c1 = await assemble(sql, R, 'c_t8');
check('retired constraint is gone', !durable(c1.messages[1]).includes('snake_case'));
check('live count back to 0', c1.diagnostics.live_constraints === 0);

console.log('\n6. Still deterministic with constraints in play');
await sql`update constraints set retired_at = null where id = 'c1'`;
await sql`insert into constraints (id, run_id, text, kind) values ('c2', ${R}, 'All prose in Australian English.', 'au_english')`;
const d1 = await assemble(sql, R, 'c_t8');
const d2 = await assemble(sql, R, 'c_t8');
check('two calls byte-identical', JSON.stringify(d1.messages) === JSON.stringify(d2.messages));
check('both constraints rendered, in seq order',
      durable(d1.messages[1]).indexOf('snake_case') < durable(d1.messages[1]).indexOf('Australian'));

console.log(`\n${'='.repeat(56)}\n${pass} passed, ${fail} failed`);
await sql`delete from runs where id = ${R}`;
await sql.end();
process.exit(fail ? 1 : 0);
