/**
 * Determinism harness for assemble().
 *
 * Every property here is one the experiment's validity rests on. If any fails,
 * the cache numbers measure my serialiser rather than the context strategy.
 */
import { connect } from './db.ts';
import { assemble } from './assemble.ts';
import { stable_json } from './canonical.ts';
import type { Msg } from './assemble.ts';

/** Narrow away the assistant variant's nullable content. */
const body = (m: Msg | undefined): string => (m && typeof m.content === 'string' ? m.content : '');

const sql = connect();
const R = 'test_run_assemble';
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

await sql`delete from runs where id = ${R}`;
await sql`insert into runs (id, arm, model, seed, task_set, notes)
          values (${R}, 'B', 'test-model', 42, 'test',
                  ${sql.json({ goal: 'Produce a costing model for a rainwater tank retrofit.' })})`;
await sql`insert into tasks (id, run_id, parent_id, spec, decision_watermark)
          values ('t_root', ${R}, null, ${sql.json({ title: 'Root', detail: 'Everything', acceptance: 'All children done' })}, 0)`;
await sql`insert into tasks (id, run_id, parent_id, spec, decision_watermark)
          values ('t1', ${R}, 't_root', ${sql.json({ title: 'Size the tank', detail: 'Pick a capacity', acceptance: 'A number in litres' })}, 0)`;

console.log('\n1. Purity — same DB state must give the same bytes');
const a1 = await assemble(sql, R, 't1');
const a2 = await assemble(sql, R, 't1');
check('two calls are byte-identical', stable_json(a1.messages) === stable_json(a2.messages));
check('prefix fingerprint matches', a1.diagnostics.prefix_fingerprint === a2.diagnostics.prefix_fingerprint,
      a1.diagnostics.prefix_fingerprint);

console.log('\n2. Slot order is fixed, not data-derived');
check('slots in declared order', stable_json(a1.slots.map((s) => s.key)) === stable_json(['goal', 'constraints', 'decisions', 'reads', 'task']),
      a1.slots.map((s) => s.key).join(','));

console.log('\n3. The freeze — a decide() mid-task must NOT rewrite the durable region');
const before = a1.diagnostics.durable_fingerprint;
await sql`insert into decisions (id, run_id, task_id, text) values ('d1', ${R}, 't1', 'All identifiers use snake_case.')`;
const a3 = await assemble(sql, R, 't1');
check('durable block unchanged despite new decision', a3.diagnostics.durable_fingerprint === before,
      `${before} -> ${a3.diagnostics.durable_fingerprint}`);
check('decision is above the watermark', a3.diagnostics.live_decisions === 0);

console.log('\n4. Tail grows, regions above it do not');
await sql`insert into steps (run_id, step_id, arm, kind, task_id, turn, payload)
          values (${R}, 's1', 'B', 'model_call', 't1', 1,
                  ${sql.json({ messages: [{ role: 'assistant', content: 'thinking about capacity' }] })})`;
const a4 = await assemble(sql, R, 't1');
check('prefix fingerprint still unchanged', a4.diagnostics.prefix_fingerprint === a1.diagnostics.prefix_fingerprint);
check('durable fingerprint still unchanged', a4.diagnostics.durable_fingerprint === before);
check('tail grew by one message', a4.diagnostics.tail_messages === a1.diagnostics.tail_messages + 1);

console.log('\n5. Task boundary — the decision is promoted, the tail is discarded');
const [wmrow] = await sql<{ max: string }[]>`select coalesce(max(seq), 0)::text as max from decisions where run_id = ${R}`;
const wm = wmrow!.max;
await sql`insert into tasks (id, run_id, parent_id, spec, decision_watermark)
          values ('t2', ${R}, 't_root', ${sql.json({ title: 'Cost the tank', detail: 'Price it', acceptance: 'A number in dollars' })}, ${wm})`;
const b1 = await assemble(sql, R, 't2');
check('durable block changed at the boundary', b1.diagnostics.durable_fingerprint !== before);
check('decision now live in the block', b1.diagnostics.live_decisions === 1);
check('decision text rendered', body(b1.messages[1]).includes('snake_case'));
check('tail discarded', b1.diagnostics.tail_messages === 0);
check('prefix survived the boundary', b1.diagnostics.prefix_fingerprint === a1.diagnostics.prefix_fingerprint);

console.log('\n6. Supersession removes a decision from the live block');
await sql`insert into decisions (id, run_id, task_id, text) values ('d2', ${R}, 't2', 'All identifiers use kebab-case instead.')`;
await sql`update decisions set superseded_by = 'd2' where id = 'd1'`;
const [wmrow2] = await sql<{ max: string }[]>`select coalesce(max(seq), 0)::text as max from decisions where run_id = ${R}`;
const wm2 = wmrow2!.max;
await sql`insert into tasks (id, run_id, parent_id, spec, decision_watermark)
          values ('t3', ${R}, 't_root', ${sql.json({ title: 'Check', detail: 'Verify', acceptance: 'Done' })}, ${wm2})`;
const c1 = await assemble(sql, R, 't3');
check('superseded decision is gone', !body(c1.messages[1]).includes('snake_case'));
check('replacement is present', body(c1.messages[1]).includes('kebab-case'));
check('exactly one live decision', c1.diagnostics.live_decisions === 1);

console.log('\n7. No wall-clock leakage above the tail');
// Strict version: every timestamp-looking string above the tail must be
// traceable to an actual decisions.created_at value. Anything else is a clock leak.
const ISO = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?/g;
check('stable prefix contains no timestamp at all', body(c1.messages[0]).match(ISO) === null);
const db_times = (await sql<{ t: string }[]>`select created_at::text as t from decisions where run_id = ${R}`).map((r) => r.t);
const rendered = body(c1.messages[1]).match(ISO) ?? [];
const orphans = rendered.filter((t) => !db_times.some((d: string) => d.startsWith(t) || t.startsWith(d)));
check('every timestamp in the durable block came from a DB row', orphans.length === 0,
      `${rendered.length} rendered, ${orphans.length} unaccounted for`);
const r1 = await assemble(sql, R, 't3');
await new Promise((r) => setTimeout(r, 1100));
const r2 = await assemble(sql, R, 't3');
check('identical across a 1.1s gap (no clock dependence)', stable_json(r1.messages) === stable_json(r2.messages));

console.log(`\n${'='.repeat(60)}\n${pass} passed, ${fail} failed`);
await sql`delete from runs where id = ${R}`;
await sql.end();
process.exit(fail ? 1 : 0);
